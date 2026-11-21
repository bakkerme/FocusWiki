# Docker CI/CD for GitHub Container Registry (`ghcr.io`)

The [GitHub Actions workflow](../.github/workflows/docker.yml) runs type checks, the production build, the Vitest suite with Chromium, and the Docker smoke test on pull requests and pushes to `main`. The smoke test uses disposable files, an isolated network configuration, and a dummy App key. Publication requires the two-service phase and a worker image with the managed proposal service. Once the `registry-publish` environment rules pass, the job publishes the same tested Linux amd64 image as `ghcr.io/bakkerme/focuswiki:COMMIT_SHA`.

## GitHub configuration

No external cloud account, secrets, or Actions variables are required. The `publish` job authenticates to `ghcr.io` using GitHub Actions' built-in `GITHUB_TOKEN` with `packages: write` permission, and tags the image with `org.opencontainers.image.source` so the package links automatically to this repository.

1. In repository **Settings → Environments**, ensure the `registry-publish` environment exists and restrict its deployment branch policy to `main`. Require a reviewer if your release policy calls for manual approval.
2. Protect `main` with pull requests and the `Test and build image` status check.
3. Under repository **Settings → Actions → General → Workflow permissions**, ensure workflows are permitted to request `packages: write` (GitHub's default allows job-level `permissions:` blocks to request it).
4. Once the workflow is on `main`, run **Docker CI/CD** from the Actions tab on that branch or let the next push trigger it. The publish job prints both the image tag and the immutable `ghcr.io/bakkerme/focuswiki@sha256:...` digest in the run summary.

### Package visibility and pull access

By default, newly published GHCR packages inherit the repository's visibility (or default to **private** depending on account settings). You can inspect or change visibility under the package's **Package settings** in GitHub:

- **Public package:** Hosts and Portainer can pull `ghcr.io/bakkerme/focuswiki@sha256:...` without credentials.
- **Private package:** Create a read-only GitHub Personal Access Token (classic PAT with `read:packages`, or a fine-grained PAT with Packages read access) and use it to log in to `ghcr.io` on the deployment host or in Portainer.

## Deploy a published image on a private host

Pin the pull to the digest printed in the **Docker CI/CD** run summary and follow the [deployment runbook](DEPLOYMENT.md) (or [Portainer guide](PORTAINER.md)) to configure enrollment, Tailscale Serve, host controls, and the Git worker.

```bash
# Only needed if the GHCR package is private:
printf '%s' "$GHCR_READ_TOKEN" | docker login ghcr.io --username bakkerme --password-stdin

export FOCUSWIKI_IMAGE="ghcr.io/bakkerme/focuswiki@sha256:RELEASE_DIGEST"
docker pull "$FOCUSWIKI_IMAGE"
```
