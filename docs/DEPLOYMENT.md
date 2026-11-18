# Private FocusWiki deployment

Deploy an integrated release containing this access layer, the managed Git worker and routes, and the managed proposal service. The access branch builds independently against `main`. Its image has no worker executable, so the worker exits and Compose withholds web startup. The GitHub Actions pipeline withholds registry publication until the offline two-service smoke test and proposal-service checks pass. [Managed worker and routes, PR #11](https://github.com/bakkerme/FocusWiki/pull/11) · [Proposal service, PR #8](https://github.com/bakkerme/FocusWiki/pull/8)

## Host and trust boundary

Use rootless Docker on Linux and an up-to-date Tailscale release with HTTPS Serve Unix socket support. The host administrator configures HTTPS Serve at `/` and restricts tailnet policy to the users who may access and edit FocusWiki. Use an unshared Serve node and exclude it from Funnel. Serve overwrites incoming identity and forwarding headers. The web service has `network_mode: none` and listens only on the designated Unix socket. Only host `tailscaled`, the web process, and trusted host administrators or the Docker owner can access the socket. Keep its parent directory on a local filesystem with Unix socket support and effective mode `0700`. Never mount it into other containers or forward host Unix sockets to untrusted users. Host root and the rootless Docker administrator are inside the deployment trust boundary. [Tailscale Serve identity headers and requirements](https://tailscale.com/docs/features/tailscale-serve#identity-headers)

Web runs as container UID `10002` and the worker runs as container UID `0`, which maps to the unprivileged Docker daemon account in rootless mode. Both use container GID `0` for editable files and Git socket access. The worker owns the shared root, Git socket directory and private `.staging` area. The web process can edit provisioned project files but cannot alter the shared root or read staging. The worker alone mounts private Git state, the App key and its own writable socket directory. Both mount enrollment read-only. Container roots are read-only, with all Linux capabilities dropped and `no-new-privileges`. The only networked service is the Git worker, which has no published ports.

Production HTTP checks the designated connection, one verified Tailscale user login, and the configured HTTPS forwarding authority. Missing identity, tagged devices and Funnel are rejected, including on health routes. Every mutation requires the exact browser `Origin`. Fetch Metadata must also say `same-origin` when the browser sends it. Publishing requires the exact, case-sensitive login in `FOCUSWIKI_PUBLISHERS`. An empty list disables publication while preserving the rest of the service. Use canonical ASCII Tailscale logins. A renamed login is a different actor, so update the allowlist and obtain a new review before publishing.

## Configure and start

1. Use the existing rootless Docker account and the intended Docker context. Verify `docker info --format '{{json .SecurityOptions}}'` includes `name=rootless`. Pin the integrated image by digest and pull it through the deployment account. Use the following values as examples and supply the actual host, enrollment and App IDs.

   ```bash
   export FOCUSWIKI_IMAGE='gcr.io/PROJECT_ID/focuswiki@sha256:RELEASE_DIGEST'
   export FOCUSWIKI_DEPLOY_DIR="$HOME/.local/share/focuswiki-production"
   export FOCUSWIKI_PUBLIC_ORIGIN='https://wiki.example.ts.net'
   export FOCUSWIKI_PUBLISHERS='publisher@example.test'
   export FOCUSWIKI_GITHUB_APP_ID='123456'
   export FOCUSWIKI_GITHUB_INSTALLATION_ID='12345678'
   docker pull "$FOCUSWIKI_IMAGE"
   ```

2. Create the data directories using the daemon account's primary group and keep them outside the source checkout and Docker build context. This one-time ownership command uses the pinned image and mounts only the empty Serve directory. Use a filesystem that supports Linux UID mapping and POSIX permissions. Keep the two socket directories free of other files.

   ```bash
   umask 077
   install -d -m 0700 "$FOCUSWIKI_DEPLOY_DIR" \
     "$FOCUSWIKI_DEPLOY_DIR/git-state" "$FOCUSWIKI_DEPLOY_DIR/serve-socket"
   install -d -m 0750 "$FOCUSWIKI_DEPLOY_DIR/repos" "$FOCUSWIKI_DEPLOY_DIR/git-socket"
   docker run --rm --network none --read-only --cap-drop ALL --cap-add CHOWN \
     --security-opt no-new-privileges:true --user 0:0 \
     --mount "type=bind,source=$FOCUSWIKI_DEPLOY_DIR/serve-socket,target=/serve" \
     --entrypoint /bin/chown "$FOCUSWIKI_IMAGE" 10002:0 /serve
   install -m 0600 /protected/path/github-app.pem "$FOCUSWIKI_DEPLOY_DIR/github-app.pem"
   ```

3. Write `$FOCUSWIKI_DEPLOY_DIR/enrollment.json` with mode `0640` and the Docker account's primary group. Each project chooses one HTTPS GitHub repository and one base branch. The worker provisions the editable directory under `repos/<id>` on first synchronization. Use a fresh ID to change a repository or base and preserve the old tree offline. The values below are fictional.

   ```json
   {
     "projects": [
       {
         "id": "amber-observatory",
         "name": "Amber Observatory",
         "remote": "https://github.com/example/amber-observatory.git",
         "branch": "main",
         "defaultDoc": "README.md"
       }
     ]
   }
   ```

4. Verify the controls below. From the application checkout, start one stack for these paths, then configure the host Serve endpoint as an administrator. Configure the exact HTTPS origin advertised by Serve, without a path or trailing slash. Use `docker compose up -d --force-recreate --no-build --pull never --wait` after replacing enrollment or the App key file, since a running bind mount can retain the old inode. Recreate web after changing publishers. A restart of the same container keeps its existing environment.

   ```bash
   docker compose up -d --no-build --pull never --wait --wait-timeout 60
   docker compose ps
   sudo tailscale serve --bg --https=443 "unix:$FOCUSWIKI_DEPLOY_DIR/serve-socket/http.sock"
   sudo tailscale serve status
   ```

## Verify before granting access

| Control | Expected operator evidence |
| --- | --- |
| No direct backend ingress | `docker compose ps` shows no published ports. Inspect both containers for no port bindings, no host networking, `ReadonlyRootfs`, only the declared mounts, and the declared users. Review host listeners and container port mappings for old `8088` and `8089` bindings. Tailnet clients use HTTPS Serve, and LAN-only clients have no FocusWiki route. |
| Filesystem separation | Web has writable editable files and its dedicated HTTP socket directory, read-only enrollment and a read-only Git socket directory. Worker has the App key and Git state, with no HTTP socket mount. Check `.staging` is inaccessible to web, and verify neither container has Docker, `tailscaled` or other admin sockets, backup locations, or host home mounts. Check file permissions and effective ACLs on the host, including default ACLs. |
| Proxy identity and routes | An allowed human can open the app, load assets and embeds, receive document updates, and see only `{ "ok": true }` at `/healthz`. A tagged node or request without Tailscale user identity cannot load the app, health, SSE, static files, embeds, or APIs. From a test editor outside the publisher list, supply a publisher identity header to Serve and confirm it is replaced by the editor identity. Confirm access from a LAN-only client fails. |
| Browser origin and publishing | On a disposable enrolled repository, obtain a Git review as a verified editor. A missing, `null`, HTTP or different HTTPS origin is rejected at proposal submission, including attempts by a publisher. A non-publisher with the correct origin is rejected. An allowlisted publisher using the same account and reviewed draft can open a PR targeting the enrolled base, with a head under `focuswiki/`. Verify proposals from different actors cannot reuse the same review. |
| Liveness and persistence | Both Compose probes check their Unix socket connection. HTTP health is authenticated and returns only the Boolean acknowledgement. Verify actual readiness in Serve by loading a document and observing worker status. Test restart and recreation with a disposable deployment and confirm working files and Git state persist. A stale worker socket after an unclean exit must be removed only after confirming its worker is stopped. |

Compose disables web egress. On the worker's bridge, use host or upstream egress controls to permit GitHub Git and API HTTPS (`github.com` and `api.github.com`, TCP 443) and the approved DNS resolver. Block connections to the host, LAN, tailnet and management services, including through IPv6, alternate routes or proxies. Check both allowed access and denied destinations from an isolated verification deployment. Docker bridge NAT and `cap_drop` do not enforce destination restrictions. The NAS firewall, Docker/rootless networking implementation, filesystem permissions, Tailscale settings, and GitHub policy require operator verification on the target host and accounts. Repository tests and Compose configuration cannot prove those controls.

## Migrate from the legacy listener

1. Stop legacy application and editor writes. Archive each old checkout outside the deployment mounts, including `.git`, untracked and ignored files, comments, embeds, conflict copies and unsaved drafts the editors can recover. Preserve configuration and credentials separately and record HEAD, branch, staged and unstaged changes. Verify the backup before starting migration.
2. Disable the legacy host server, old Compose deployment and any direct LAN or tailnet port forwarding. Retain the old files offline. Create fresh enrollment IDs and let the new worker provision them from the selected GitHub base. Copy only reviewed document changes, comments, embeds and intentional deletions into the new tree. Keep `.git`, token stores and backups outside both services. Reconcile local commits through the ordinary Git workflow.
3. Confirm the deployment checks and compare carried changes against the originals. Verify the first proposal on a disposable repository and verify its GitHub controls before enabling regular publishing. Retire old credential access after cutover.

## Roll back

Disable the FocusWiki Serve mapping with `sudo tailscale serve --https=443 off` when FocusWiki owns that port. On a node with other Serve mappings, remove only the allocated FocusWiki path and port. Stop both services with `docker compose down` and preserve the shared drafts and worker state. Record any already-published proposal URLs at GitHub, since stopping or rolling back the local stack cannot undo them. Restore a compatible, previously verified managed image and enrollment/state snapshot if available, review newer drafts against it, and recheck access before re-enabling Serve. Otherwise keep the service offline and recover files from the archive for local reconciliation. Keep the legacy LAN listener disabled throughout.

## GitHub controls

- Install the GitHub App only on the enrolled repositories. Use repository permissions for metadata read, contents read/write and pull requests read/write. Keep the PEM worker-only and rotate it if its boundary changes. The installation should have no ruleset bypass.
- Protect each enrolled base branch with required pull requests, human review and appropriate status checks. Disallow direct pushes by the App, force pushes and branch deletion. Permit the App to create proposal branches under `focuswiki/`, and verify that the resulting PR cannot merge without the same review gates. Apply the rule to administrators where supported and keep bypass lists limited.
- Restrict the application repository's `registry-publish` GitHub environment to `main`, with approvals as required by the owner. Keep release/deploy secrets and any production environment similarly gated. See the [registry setup](DOCKER-CICD.md) for workload identity restrictions.
- Review the enrolled repositories' GitHub Actions and external automation before enabling publication. Disable expensive AI work on pushes to `focuswiki/**` and on documentation-only pushes. If an AI job is needed, use an explicit approved trigger. FocusWiki's application repository has Docker CI and no AI workflow to change. Verify branch protection checks still report for documentation PRs after trigger changes.

## Request path

The production web listener accepts Unix-socket connections from Serve. The Serve gate verifies the connection, login, and browser origin before parsing mutations. Both processes read the same managed enrollment file. Review and publication pass the verified actor to the Git runner over its private socket; publication also requires an allowlisted publisher and a review bound to the enrolled base.
