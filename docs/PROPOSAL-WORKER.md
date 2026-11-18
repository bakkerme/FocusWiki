# Proposal worker

The standalone worker API lives in [server/proposalService.ts](../server/proposalService.ts). The caller supplies a trusted enrollment `{ projectId, workTree, gitDir, remote, branch }`. Resolve that record on the worker from an authorized project ID. Keep enrollment records, Git metadata and their parent directories under worker control. Restrict draft writers to the working files. Give each proposal a fresh, reserved `focuswiki/…` branch and use the same enrollment for retries. Repository URLs must be canonical HTTPS GitHub URLs such as `https://github.com/ExampleOrg/FableDocs.git`. The module uses the supplied enrollment directly.

- `reviewProposal(ctx)` returns the rich change review payload and a `reviewId`. The status in this payload describes reviewable changes against the local committed base. Review is local. The response can contain private document text and should use the same access controls as the draft.
- `publishProposal(ctx, { reviewId, message, paths })` publishes an explicit, nonempty selection and returns the GitHub pull request URL and proposal commit SHA. The caller must authorize review and publication for the same project and actor and treat the returned review ID as approval state. The commit uses the trusted repository's configured Git author and committer identity, along with the supplied commit message. Set `user.name` and `user.email` during provisioning.
- `getRepoToken(ctx, 'read' | 'write')` returns a short-lived GitHub App installation token for worker-side use. Use `read` for any fetch or ref inspection. The module reads GitHub's refs through the API and uses a write token to push the approved commit and open its pull request. Keep tokens in the worker process and out of API responses, application logs and Git remotes.

## Checkout and deployment

Use a Linux worker with Node.js 22, Git, and a mounted `/proc` for descriptor-relative reads. Provision an initialized worktree with a regular index and a separate Git directory. Fetch the repository's default branch using read-only authorization and explicitly prepare the local checkout at the fetched commit before starting a review. Keep complete base objects locally. The worker rejects a changed local base or a stale GitHub default branch before pushing. The caller should preserve pending drafts when offering a new review against a newer base.

The worker stores immutable review fingerprints and publication receipts in `gitDir/focuswiki-proposals` and pins prepared commits under `refs/focuswiki/proposals/`. Use persistent worker-private storage for both and keep them together across restarts. Limit filesystem access to the worker identity. Keep Git configuration, the object database, authenticated transport and the App key outside the writable project tree. Run the worker under a dedicated identity with access only to its enrolled projects and secrets. The worker uses an alternate index, leaving the checkout's HEAD, files, and staged entries intact.

The worker needs outbound HTTPS access to `api.github.com` and `github.com`. Set these values in its deployment:

| Setting | Value |
| --- | --- |
| `FOCUSWIKI_GITHUB_APP_ID` | GitHub App ID |
| `FOCUSWIKI_GITHUB_INSTALLATION_ID` | Installation ID for the enrolled owner |
| `FOCUSWIKI_GITHUB_APP_KEY_FILE` | Absolute path to the RSA App private key mounted read-only, outside project and Git directories |

Grant the App **Contents: read and write** and **Pull requests: read and write** at installation. Choose **Only select repositories** and include only enrolled repositories. The worker checks installation membership and scopes each issued token to the named repository. Read requests ask for Contents read. Publish requests ask for Contents write and Pull requests write. GitHub includes read access to repository metadata. Keep the App key out of images, project storage, and source control. Git HTTPS authentication uses a short-lived token scoped to the push process environment and an askpass helper. Disable Git tracing and restrict process inspection to the worker identity.

## GitHub rules and recovery

Require reviews and status checks on the default branch. Exclude the App from the default branch's bypass grants and deny force pushes and deletions on protected branches. Reserve the `focuswiki/**` namespace for the worker and restrict creation and updates by other actors where supported by your GitHub rulesets. The worker needs permission to create these branches and open PRs. It creates a branch only for the approved commit, refuses to advance an occupied branch, and leaves merging to the repository's usual approval flow.

Treat proposal refs and PR content as untrusted inputs to CI. Keep the proposal App key and installation tokens out of GitHub Actions and CI credentials. Run proposal checks with least-privilege tokens, without deployment secrets or privileged caches and runners. Avoid `pull_request_target` and privileged follow-up workflows that check out or execute the proposed ref. Put deployment behind reviewed, protected-branch builds with distinct credentials. Repository-side path restrictions cannot control what a workflow or build script reads.

A retry must use the same review ID, selected path set and message. If GitHub received the push, retry locates the exact remote SHA and resumes PR creation or recovers the PR that already exists. This works after restart and with later draft edits. An already-pushed proposal keeps its original base branch if that branch advances before PR creation. A changed or removed proposal ref requires operator attention. Preserve receipts and pinned commits while retries may be needed. Purge obsolete state and private refs together during worker maintenance after the retry period chosen by the operator.

## Review scope and bounds

The worker enumerates base and index paths and Git-visible untracked paths. It uses path metadata to present a safe move as a deletion and addition, and both paths can be approved. When a protected base path is missing, replaced with an unexpected type or removed from the real index, review fails closed. The path filters exclude dot paths, credential-like names and key extensions. The reader rejects symlinks, hard links and special files before opening contents, then screens bounded UTF-8 text for recognizable credential patterns. Store credentials outside the checkout and review the proposed contents as usual. The screening covers common patterns only.

The worker limits a review to 2,500 paths, 64 KiB per file version, 16 MiB of file reads, 32 changed files, and 512 KiB of raw diff. Only fully reviewed regular text files are eligible for publication. The scanner omits protected or unsupported paths and reports when they are outside scope. A changed base file with protected or non-text content blocks the review. If a selected file or mode changes, or the base moves before submission, prepare a new review. Unselected changes remain in the working copy.

The dedicated test suite replaces GitHub HTTP and Git network transport with local mocks. The push tests exercise real commits, refs, and the pre-push guard against a disposable bare repository. Use the repository's security-audit sandbox runner for test and build commands.
