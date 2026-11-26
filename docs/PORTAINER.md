# Portainer + OpenBao deployment (ASUSTOR NAS)

This guide covers deploying FocusWiki via Portainer using [compose.portainer.yaml](../compose.portainer.yaml), storing the GitHub App private key in an existing OpenBao instance (via AppRole over Tailscale), and exposing the app exclusively over a dedicated Tailscale Serve sidecar.

For host-managed Linux rootless Docker deployments without Portainer, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Architecture and trust boundaries

The stack runs four services with **no published LAN ports**:

| Service | Network | User | Purpose |
| --- | --- | --- | --- |
| `init` | `none` | `0:0` (`CHOWN`, `FOWNER`) | One-shot container (`restart: "no"`) that initializes ownership and permissions on the six named volumes and writes `serve.json` for Tailscale Serve. |
| `git-worker` | Bridge (outbound only) | `0:0` (`cap_drop: ALL`) | Authenticates to OpenBao via AppRole at startup, writes the validated RSA key to a worker-only in-memory `tmpfs` (`/run/secrets/focuswiki-github-app.pem`, mode `0600`), revokes its OpenBao token, scrubs `FOCUSWIKI_OPENBAO_*` env vars, and starts `gitRunner.js`. Owns private Git state and GitHub API/Git traffic. |
| `web` | `none` | `10002:0` (`cap_drop: ALL`) | Serves the UI and APIs strictly over `/run/focuswiki-serve/http.sock`. Verifies Tailscale Serve identity headers, browser `Origin`, and `FOCUSWIKI_PUBLISHERS`. Never receives OpenBao credentials, the GitHub App key, or private Git metadata. |
| `tailscale` | Bridge (Tailscale userspace) | `0:0` (`cap_drop: ALL`) | Dedicated `tailscale/tailscale` sidecar (`TS_USERSPACE=true`, no `NET_ADMIN` or `/dev/net/tun` required) that terminates HTTPS for `https://<hostname>.<tailnet>.ts.net` and forwards to `web` over the shared `serve-socket` volume (`0750` owned by `10002:0`, socket `0660`). Leaves the NAS's own Tailscale installation untouched. |

## 1. Configure OpenBao (one-time)

Store your GitHub App private key in a dedicated KV v2 path and grant FocusWiki read-only access to **only** that path:

1. Write the PEM into OpenBao (for example at `secret/focuswiki/github-app` under field `private_key`):

   ```bash
   bao kv put secret/focuswiki/github-app private_key=@/path/to/github-app.pem
   ```

2. Create a least-privilege policy (`focuswiki-git-worker`):

   ```hcl
   path "secret/data/focuswiki/github-app" {
     capabilities = ["read"]
   }
   ```

3. Create a dedicated AppRole bound to that policy (assuming `approle` is already enabled):

   ```bash
   bao write auth/approle/role/focuswiki-git-worker \
     token_policies="focuswiki-git-worker" \
     token_ttl="5m" \
     token_max_ttl="10m"

   bao read auth/approle/role/focuswiki-git-worker/role-id
   bao write -f auth/approle/role/focuswiki-git-worker/secret-id
   ```

   Record the `role_id` and `secret_id` for the Portainer stack environment variables.

## 2. Configure GHCR pull credentials in Portainer

FocusWiki CI builds and publishes images to `ghcr.io/bakkerme/focuswiki:<COMMIT_SHA>` (see [DOCKER-CICD.md](DOCKER-CICD.md)).

- If the GHCR package is **private**, add a Custom registry in Portainer (**Registries**) with registry URL `ghcr.io`, your GitHub username, and a read-only GitHub Personal Access Token (`read:packages`) as the password. If the package is **public**, no registry credentials are required.
- Pin `FOCUSWIKI_IMAGE` to the published digest from the GitHub Actions **Docker CI/CD** summary (for example `ghcr.io/bakkerme/focuswiki@sha256:...`).

## 3. Prepare a disposable test repository and `enrollment.json`

Before enrolling real repositories, verify the deployment end-to-end against one disposable GitHub repository:

1. Install your GitHub App on the disposable repository only (permissions: Metadata read, Contents read/write, Pull Requests read/write).
2. Protect `main` on that repository: require pull requests, disallow direct pushes / force pushes / deletion, and do **not** add the GitHub App to any ruleset bypass list.
3. Confirm no expensive AI or deployment workflows trigger on `focuswiki/**` branches.
4. Create `enrollment.json` on a NAS shared folder (for example `/volume1/docker/focuswiki/enrollment.json`) containing only non-secret repository metadata, readable by UID `10002` (`chmod 0644`):

   ```json
   {
     "projects": [
       {
         "id": "amber-sandbox",
         "name": "Amber Sandbox",
         "remote": "https://github.com/example/amber-sandbox.git",
         "branch": "main",
         "defaultDoc": "README.md"
       }
     ]
   }
   ```

   > **Note:** After editing `enrollment.json`, redeploy/recreate the `git-worker` and `web` containers in Portainer so both pick up the updated file (replacing a file via atomic editor save changes its inode, which a running single-file bind mount will not see until recreated).

   **Optional local (non-GitHub) NAS folders:** To expose internal docs stored on your NAS without putting them on GitHub, set `FOCUSWIKI_LOCAL_REPOS_HOST_PATH` (for example `/volume1/docker/focuswiki/local-repos`), create a subfolder matching the project `id` (for example `.../local-repos/lan-docs`, writable by UID `10002` / GID `0`), and add a `"local": true` entry in `enrollment.json`:

   ```json
   {
     "id": "lan-docs",
     "name": "LAN Docs",
     "local": true,
     "defaultDoc": "README.md"
   }
   ```

   Local projects are mounted into `web` only (`git-worker` skips them). Reading, searching, rich Markdown editing, and anchored comments work directly on disk; managed Git change review and PR proposals are disabled for local entries.

   **Optional self-hosted Forgejo repositories:** To manage private internal repositories on a self-hosted Forgejo instance (such as `https://git.tailnet.ts.net`) with full auto fast-forward, Pull latest, diff review, and PR proposals:

   1. Create a dedicated non-admin Forgejo bot user (for example `focuswiki-bot`), add it as a **Write** collaborator on only the repositories FocusWiki should manage, protect the base branch (`main`/`master`) to require PRs, and generate an access token with `write:repository` and `write:issue` scopes.
   2. Store that token in OpenBao (for example `bao kv put secret/apps/focuswiki/forgejo token=<token>`) and grant `read` on `secret/data/apps/focuswiki/forgejo` to your `focuswiki-git-worker` OpenBao policy.
   3. If Forgejo runs behind a Tailscale Serve sidecar (`tag:git`), grant `tag:focuswiki` → `tag:git` on `tcp:443` in your Tailscale ACL.
   4. Set `FOCUSWIKI_FORGEJO_ORIGIN=https://git.tailnet.ts.net`, `FOCUSWIKI_OPENBAO_FORGEJO_SECRET_PATH=secret/data/apps/focuswiki/forgejo`, and (when routing Tailscale traffic through the sidecar) `FOCUSWIKI_FORGEJO_PROXY=http://tailscale:1055` in Portainer.
   5. Add a `"provider": "forgejo"` entry in `enrollment.json`:

      ```json
      {
        "id": "lan-docs",
        "name": "LAN Docs",
        "provider": "forgejo",
        "remote": "https://git.tailnet.ts.net/brandon/lan-docs.git",
        "branch": "main",
        "defaultDoc": "README.md"
      }
      ```

      `git-worker` enforces that every `"provider": "forgejo"` remote matches `FOCUSWIKI_FORGEJO_ORIGIN` exactly; `web` still runs with `network_mode: none` and never receives Forgejo or OpenBao credentials.

## 4. Deploy the stack in Portainer

In Portainer, create a new stack using [compose.portainer.yaml](../compose.portainer.yaml) (via Git repository or Web editor) and configure the stack environment variables:

| Variable | Required | Example / Default | Notes |
| --- | --- | --- | --- |
| `FOCUSWIKI_IMAGE` | Yes | `ghcr.io/bakkerme/focuswiki@sha256:...` | Pinned image from CI. |
| `FOCUSWIKI_ENROLLMENT_HOST_PATH` | Yes | `/volume1/docker/focuswiki/enrollment.json` | Absolute NAS path to `enrollment.json` (must already exist). |
| `FOCUSWIKI_LOCAL_REPOS_HOST_PATH` | No | *(named volume `local-repos`)* | Optional absolute NAS directory mounted into `web` at `/app/local-repos` for unmanaged `"local": true` projects (one subfolder per project `id`, writable by UID `10002` / GID `0`). Never mounted into `git-worker`. |
| `FOCUSWIKI_PUBLIC_ORIGIN` | Yes | `https://focuswiki.tailnet.ts.net` | Exact Tailscale Serve HTTPS origin (no trailing slash). Must match `FOCUSWIKI_TS_HOSTNAME` + your tailnet domain. |
| `FOCUSWIKI_PUBLISHERS` | Recommended | `alice@example.test` | Comma-separated canonical Tailscale logins allowed to open PRs. Leave empty to run read/edit-only without PR publication. |
| `FOCUSWIKI_GITHUB_APP_ID` | GitHub only | `123456` | Numeric GitHub App ID (required when enrolling GitHub repositories). |
| `FOCUSWIKI_GITHUB_INSTALLATION_ID` | GitHub only | `12345678` | Numeric GitHub App installation ID. |
| `FOCUSWIKI_FORGEJO_ORIGIN` | Forgejo only | `https://git.tailnet.ts.net` | Exact HTTPS origin of your self-hosted Forgejo server (no trailing slash). Required when enrolling `"provider": "forgejo"` repositories. |
| `FOCUSWIKI_FORGEJO_PROXY` | No | `http://tailscale:1055` | Set alongside `FOCUSWIKI_TS_OUTBOUND_HTTP_PROXY_LISTEN=:1055` to tunnel Forgejo HTTPS Git and API traffic through the stack's `tailscale` sidecar. |
| `FOCUSWIKI_OPENBAO_ADDR` | Yes | `https://openbao.tailnet.ts.net` | HTTPS OpenBao URL (TLS is strictly verified). |
| `FOCUSWIKI_OPENBAO_ROLE_ID` | Yes | `...` | AppRole Role ID from step 1. |
| `FOCUSWIKI_OPENBAO_SECRET_ID` | Yes | `...` | AppRole Secret ID from step 1. |
| `FOCUSWIKI_OPENBAO_SECRET_PATH` | GitHub only | `secret/data/focuswiki/github-app` | OpenBao API path relative to `/v1/` for the GitHub App RSA PEM. |
| `FOCUSWIKI_OPENBAO_SECRET_FIELD` | No | `private_key` | Field name inside the GitHub App secret containing the RSA PEM. |
| `FOCUSWIKI_OPENBAO_FORGEJO_SECRET_PATH` | Forgejo only | `secret/data/apps/focuswiki/forgejo` | OpenBao API path relative to `/v1/` for the Forgejo access token. |
| `FOCUSWIKI_OPENBAO_FORGEJO_SECRET_FIELD` | No | `token` | Field name inside the Forgejo secret containing the access token. |
| `FOCUSWIKI_OPENBAO_AUTH_MOUNT` | No | `approle` | AppRole mount path if customized. |
| `FOCUSWIKI_OPENBAO_NAMESPACE` | No | *(empty)* | Optional `X-Vault-Namespace` header. |
| `FOCUSWIKI_TS_HOSTNAME` | No | `focuswiki` | Tailscale node name for the Serve sidecar. |
| `TS_AUTHKEY` | First deploy | `tskey-auth-...` | Tailscale auth key for initial node registration. State persists in the `tailscale-state` volume; clear or remove a one-time key after first join. Make sure HTTPS certificates are enabled in your Tailscale admin DNS settings and Funnel is disabled for this node. |
| `FOCUSWIKI_TS_OUTBOUND_HTTP_PROXY_LISTEN` | No | *(empty)* | Set to `:1055` **only** if Docker bridge containers on your NAS cannot route directly to `FOCUSWIKI_OPENBAO_ADDR` over Tailscale. |
| `FOCUSWIKI_OPENBAO_PROXY` | No | *(empty)* | Set to `http://tailscale:1055` alongside `FOCUSWIKI_TS_OUTBOUND_HTTP_PROXY_LISTEN=:1055` to tunnel OpenBao HTTPS through the stack's `tailscale` sidecar. |
| `FOCUSWIKI_LOG_LEVEL` | No | `info` | Log verbosity for `git-worker` and `web` (`debug`, `info`, `warn`, `error`, `silent`). Secrets and tokens are redacted from log lines. |

### Reaching OpenBao over Tailscale from `git-worker`

- **If your NAS routes Tailscale traffic for Docker bridge containers:** leave `FOCUSWIKI_OPENBAO_PROXY` and `FOCUSWIKI_TS_OUTBOUND_HTTP_PROXY_LISTEN` empty. `git-worker` connects directly to `FOCUSWIKI_OPENBAO_ADDR` over verified TLS.
- **If `git-worker` logs show it cannot resolve or reach `*.ts.net`:** set `FOCUSWIKI_TS_OUTBOUND_HTTP_PROXY_LISTEN=:1055` and `FOCUSWIKI_OPENBAO_PROXY=http://tailscale:1055` in the stack env vars and redeploy. `git-worker` will establish an end-to-end TLS tunnel (`HTTP CONNECT`) to OpenBao via the stack's `tailscale` sidecar.

## 5. Verify before enrolling real repositories

Run these checks against the disposable repository before adding real repos:

1. **Zero LAN exposure:** Confirm in Portainer that no container in the stack has published host ports, and verify from a non-Tailscale LAN client that FocusWiki is unreachable.
2. **Container separation:** Inspect the running `web` container in Portainer and confirm `NetworkMode: none`, `ReadonlyRootfs: true`, and zero `FOCUSWIKI_OPENBAO_*` or `FOCUSWIKI_GITHUB_APP_*` environment variables.
3. **OpenBao bootstrap & secret hygiene:** Check `git-worker` logs for `[focuswiki-git] Loaded GitHub App key from OpenBao.` followed by `[focuswiki-git] Listening on the private socket.` Confirm no secret values appear in logs.
4. **Tailscale Serve identity & persistence:** Open `https://<FOCUSWIKI_TS_HOSTNAME>.<tailnet>.ts.net` from a tailnet browser, confirm the disposable repo loads, then redeploy/recreate the stack in Portainer and verify the node keeps its Tailscale identity, edits persist, and `git-worker` cleanly re-fetches the PEM from OpenBao.
5. **End-to-end proposal flow:** Make a small edit in the disposable repo, review the diff, and click **Propose changes**. Confirm a PR opens from a `focuswiki/*` branch targeting `main`, and verify `main` cannot be pushed to directly.
6. **Retire legacy credentials:** Revoke any old GitHub personal access tokens created during pre-App prototyping.
