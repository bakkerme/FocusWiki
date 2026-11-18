# Managed Git

The web process reads and edits working files, serves documents and forwards a limited set of requests through a private Unix socket. The Git worker owns remotes, configuration, refs, indexes and proposal state. Operators enroll projects through a read-only JSON file shared by both processes.

```json
{
  "projects": [
    {
      "id": "amber-observatory",
      "name": "Amber Observatory",
      "remote": "https://github.com/fictional-observatory/amber-wiki.git",
      "branch": "main",
      "defaultDoc": "README.md"
    }
  ]
}
```

The example is fictional. A project ID selects a directory under `FOCUSWIKI_REPOS_DIR`. Each enrollment has one HTTPS repository on `github.com` and one base branch. Restart both processes after changing enrollment. Use a fresh project ID when moving to another repository or branch.

## Process setup

| Setting | Web | Worker |
| --- | --- | --- |
| `FOCUSWIKI_ENROLLMENT_FILE` | Read-only JSON | Same read-only JSON |
| `FOCUSWIKI_REPOS_DIR` | Shared working files, writable within each project | Writable root with a private staging directory |
| `FOCUSWIKI_GIT_SOCKET` | `/run/focuswiki/git.sock` by default | Same socket path, mode `0660` |
| `FOCUSWIKI_GIT_STATE_DIR` | | Persistent worker-owned directory, mode `0700` |

Compose runs the production web and Git worker entrypoints as separate services. See the [deployment runbook](DEPLOYMENT.md) for socket permissions, mount ownership, GitHub App setup, and verification.

Run the services under distinct accounts. Share a group for working files and the socket. Create the working-files root and socket directory owned by the worker and traversable by the shared group, for example mode `0750`. Give the web account write access inside provisioned project directories. Mount the socket directory read-only in the web container. Keep the enrollment file outside the three directories, the Git state exclusively in the worker, and GitHub App credentials in a separate worker-only read-only mount. Run a single worker per state and working-files root. After an unclean shutdown, remove a stale socket only after confirming that its worker is stopped.

The companion `server/proposalService.ts` supplies `getRepoToken(ctx, 'read')` for fetch plus `reviewProposal(ctx)` and `publishProposal(ctx, input)`. The worker gives the token provider an existing private stage during initial fetch. For review and publication, `ctx.branch` is the reserved `focuswiki/…` proposal branch. The worker derives it from a fresh review nonce and the verified actor so retries use the same branch. The managed base branch is the worker-owned local `HEAD` symbolic ref. Before publishing, the proposal companion must verify GitHub's PR base branch against that ref and verify the base commit. The worker enables publication when the companion exports `enforcesManagedBase = true` after implementing both checks. Use the companion's GitHub App instructions to scope the installation to enrolled repositories.

The web auth companion must authenticate both routes and enforce publication permission for `POST`. Pass its Express middleware as `proposalAuth` to `createHubApp`, or export it as `proposalAuth` from `server/proposalAuth.ts`. Set `res.locals.proposalActor` to the verified stable actor ID. A header from an unverified connection or a field in the request body is insufficient. Without authorization wiring both routes stay closed. With the Git companion missing, the worker provides unavailable status and leaves the working files accessible.

## Working with drafts

Initial provisioning writes checkout files to a private staging directory, then publishes the directory at its enrolled ID. It leaves any existing directory, symlink or legacy checkout at that path untouched. Subsequent fetches request the single enrolled ref using a repository-scoped read token. They update Git objects and the remote-tracking ref. The local base and working files stay in place even when the checkout is clean. A behind count reflects the last fetched ref. Look at fetch status and timestamp for freshness.

Use `GET /api/projects/:id/git/diff` to obtain a review ID and the rich Git review. Submit `POST /api/projects/:id/git/propose` with `{ "reviewId": "...", "message": "...", "paths": ["README.md"] }`. A successful response contains the GitHub PR URL and commit SHA. A submission uses the same project and actor as the review. Retry an interrupted publication with the same review ID, message and selected paths. A disconnected request can be removed from the queue. A push or PR creation already accepted by GitHub can still complete. Only the companion's isolated proposal branch is eligible for publication.

Legacy import, local attachment, credential, ref switching, pull, commit and push APIs return `410`. Operator-configured static filesystem mode still supports document editing and browsing with Git disabled.

## Migrate an existing checkout

1. Stop old application writes and coordinate with external editors before copying. Back up the entire checkout outside the managed root, including `.git`, hidden files, staged and unstaged work, untracked and ignored files, comments, embeds and any saved conflict copies. Preserve legacy project configuration separately. Record the checkout's HEAD, branch and status so each change can be reconciled.
2. Keep the original checkout and verify the backup. If there is no GitHub repository to enroll, continue using a read-only operator-owned `PROJECTS_CONFIG` registry for filesystem document access. Store its JSON separately from any legacy credentials.
3. For GitHub enrollment, use a fresh ID with no existing working directory or worker state. Let the worker provision that base. Compare the old checkout with the new one. From the backup, apply only the reviewed draft patches and files you intend to carry over, including deliberate deletions. Resolve overlaps with upstream changes explicitly. Keep local-only commits in the archived checkout or migrate them through your normal Git workflow.
4. Verify document and comment contents, conflict copies and the new Git review before requesting a proposal. Keep the backup through the migration. A new base after upstream advances also requires coordinated draft reconciliation or a new managed checkout.

Importing a legacy `.git` directory would put unrelated refs, index, configuration and draft history into the worker. Keep that metadata in the archive and keep any old token store outside web and worker mounts.
