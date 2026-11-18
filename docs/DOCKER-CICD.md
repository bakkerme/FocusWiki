# Docker CI/CD for `gcr.io`

The [GitHub Actions workflow](../.github/workflows/docker.yml) runs type checks, the production build, the Vitest suite with Chromium, and the Docker smoke test on pull requests and pushes to `main`. The smoke test uses disposable files, an isolated network configuration and a dummy App key. It exercises the web-only phase even before the worker lands. Publication requires the two-service phase and a worker image with the managed proposal service. Once the `registry-publish` environment rules pass, the job publishes the same tested Linux amd64 image as `gcr.io/PROJECT_ID/focuswiki:COMMIT_SHA`.

Google retired Container Registry in 2025. The `gcr.io` hostname maps to the `gcr.io` repository in the `us` multi-region of Artifact Registry. [Google's `gcr.io` documentation](https://docs.cloud.google.com/artifact-registry/docs/transition/gcr-repositories)

## One-time Google Cloud setup

Use a billing-enabled Google Cloud project and a Google Cloud account that can enable APIs, manage the registry and service account IAM, and create a Workload Identity pool and provider. Run these commands in Google Cloud Shell or a Bash shell with authenticated `gcloud` and `gh` CLIs.

```bash
project_id=YOUR_GOOGLE_CLOUD_PROJECT_ID
github_repo=bakkerme/FocusWiki
repo_id=$(gh api "repos/$github_repo" --jq '.id')
pool=focuswiki-github
provider=github
service_account="focuswiki-publisher@${project_id}.iam.gserviceaccount.com"

gcloud services enable artifactregistry.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com cloudresourcemanager.googleapis.com \
  --project="$project_id"

gcloud artifacts repositories describe gcr.io --location=us --project="$project_id"
```

If the repository is absent, an administrator can initialize it with a first push using Artifact Registry Create-on-push Writer access. For projects with legacy Container Registry images, follow Google's migration guidance. Give the workflow repository-level Writer access after the repository exists. [Artifact Registry roles](https://docs.cloud.google.com/artifact-registry/docs/access-control#roles) · [Migration guidance](https://docs.cloud.google.com/artifact-registry/docs/transition/transition-from-gcr)

```bash
project_number=$(gcloud projects describe "$project_id" --format='value(projectNumber)')
pool_path="projects/${project_number}/locations/global/workloadIdentityPools/${pool}"

gcloud iam service-accounts create focuswiki-publisher --project="$project_id"

gcloud iam workload-identity-pools create "$pool" --location=global \
  --display-name='FocusWiki GitHub Actions' --project="$project_id"

gcloud iam workload-identity-pools providers create-oidc "$provider" \
  --location=global --workload-identity-pool="$pool" --project="$project_id" \
  --display-name='FocusWiki GitHub OIDC' \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping='google.subject=assertion.sub,attribute.repository_id=assertion.repository_id' \
  --attribute-condition="assertion.repository_id == '${repo_id}' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == '${github_repo}/.github/workflows/docker.yml@refs/heads/main' && assertion.environment == 'registry-publish' && assertion.event_name in ['push', 'workflow_dispatch']"

gcloud iam service-accounts add-iam-policy-binding "$service_account" \
  --project="$project_id" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/${pool_path}/attribute.repository_id/${repo_id}"

gcloud artifacts repositories add-iam-policy-binding gcr.io \
  --location=us --project="$project_id" --role=roles/artifactregistry.writer \
  --member="serviceAccount:${service_account}"
```

## Enable publishing in GitHub

With repository settings access, create the `registry-publish` environment and restrict its deployment branch policy to `main`. Require a reviewer if the release policy calls for approval. Protect `main` with pull requests and the build status check. Update any existing Workload Identity Federation provider to match the condition above, then set the three Actions variables. The publish job uses Workload Identity Federation to obtain a short-lived access token.

```bash
gh variable set GCP_PROJECT_ID --repo "$github_repo" --body "$project_id"
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo "$github_repo" \
  --body "${pool_path}/providers/${provider}"
gh variable set GCP_SERVICE_ACCOUNT --repo "$github_repo" --body "$service_account"
```

Once the workflow is on `main`, run **Docker CI/CD** from the Actions tab on that branch or let the next push trigger it. The publish job shows the image tag in the run summary and the registry digest in the push log. Verify the tag in Artifact Registry with an authenticated account that has at least Artifact Registry Reader access.

```bash
gcloud artifacts docker images describe "gcr.io/${project_id}/focuswiki:COMMIT_SHA"
```

## Deploy a published image on the private host

Use the rootless Docker account with Artifact Registry Reader access. Pin the pull to the digest printed in the publish log and follow the [deployment runbook](DEPLOYMENT.md) to configure enrollment, Tailscale Serve, host controls and the Git worker.

```bash
gcloud auth configure-docker gcr.io
export FOCUSWIKI_IMAGE="gcr.io/${project_id}/focuswiki@sha256:RELEASE_DIGEST"
docker pull "$FOCUSWIKI_IMAGE"
```
