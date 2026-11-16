# Cairn — Self-Hosted Repository Documentation Hub

Cairn is a private, local-first documentation workspace over Git-backed Markdown repositories. Humans write and review visually with live interactive embeds and anchored marginalia; bots and scripts edit authoritative `.md`, `embeds/`, and `.comments.json` files directly on disk or via a compact HTTP JSON API.

> **Sample Content Notice:** Both seeded repositories (`cindervault-rpg` and `helios-lab`) contain strictly fictional, synthetic prototype data.

## Quick Start (Local Node Service)

```bash
cd /workspace/wiki-prototype
umask 0007
npm install
npm run seed          # Initializes sample-repos/cindervault-rpg and sample-repos/helios-lab
npm run build         # Builds Vite client (dist/client) and TypeScript server (dist/server)
npm test              # Runs Vitest unit + API integration suite

# Manage background private server (binds 127.0.0.1:8088 and 100.117.116.91:8088)
./scripts/server-ctl.sh start
./scripts/server-ctl.sh status
./scripts/server-ctl.sh stop
```

## Rootless Docker Packaging & Deployment (`ubuntu` uid 1000)

`Dockerfile` and `compose.yaml` package the production build with persistent bind mounts for `./sample-repos` and `./config` (read-only), dropped Linux capabilities (`cap_drop: [ALL]`), `no-new-privileges`, a `/healthz` healthcheck, and `restart: unless-stopped`.

Docker URLs are **http://100.117.116.91:8088/** (private Tailscale) and **http://127.0.0.1:8089/** (loopback). This host's rootless Docker fails when publishing both addresses with the same host port; distinct host ports avoid that conflict. The container still listens on port `8088`. Nothing is published on the LAN address or a wildcard host address.

The image includes the compiled seed script for first startup. Existing repositories are retained. Git trusts only `/app/sample-repos/cindervault-rpg` and `/app/sample-repos/helios-lab` in the container so the existing repositories owned by another host account work through the rootless UID mapping and project ACLs. Additional mounts with a different owner need their own explicit Git trust configuration; no wildcard trust is enabled.

When deploying under the `ubuntu` account that owns the rootless Docker daemon (`/run/user/1000/docker.sock`), stop the standalone host Node listener on port `8088` first, then start Compose:

```bash
# As ubuntu (uid 1000):
export XDG_RUNTIME_DIR=/run/user/1000
export DOCKER_HOST=unix:///run/user/1000/docker.sock
cd /workspace/wiki-prototype

# Verify rootless mode
docker info --format '{{json .SecurityOptions}}'

# Build and start container
docker compose up -d --build --wait --wait-timeout 60
docker compose ps
curl -fsS http://127.0.0.1:8089/healthz
curl -fsS http://127.0.0.1:8089/api/projects

# Test the built image using disposable repositories, without publishing ports.
# Verifies first-run seeding, client assets, API writes, restart and recreation.
node scripts/docker-smoke.mjs

# Restart / stop
docker compose restart
docker compose down
```

The smoke test requires the rootless daemon and removes only its own temporary container and named volume. It does not modify `sample-repos`. `docker compose down` retains the bind-mounted project files. The Compose service runs detached and restarts with the existing daemon; no separate host Node server is needed. See `REVIEW.md` for the latest Docker verification and browser-test limits.

## Embedding Project-Authored Components

Place any self-contained HTML/JS/CSS/SVG component inside `<repo>/embeds/<widget-name>/index.html` and reference it in any `.md` file using a fenced `embed` block:

````markdown
```embed
src: embeds/loot-curve/index.html
title: Relic Drop Curve Explorer
height: 300
props: {"depth":3,"luckBonus":1}
```
````

### Adding a Fourth Component (Bot or CLI Workflow — Zero Hub Code Changes)

Option A — Direct filesystem edit in working tree:
1. Write `<repo>/embeds/loot-curve/index.html`.
2. Append the ` ```embed ` block above to any `<repo>/docs/*.md` file.
3. Open or view the doc: the file watcher reloads the page/iframe automatically before any Git commit.

Option B — HTTP API:
```bash
curl -X POST http://127.0.0.1:8088/api/projects/cindervault-rpg/embeds \
  -H 'Content-Type: application/json' \
  -d '{"src":"embeds/loot-curve/index.html","source":"<!doctype html><html><body>Interactive widget</body></html>"}'
```

### Optional `postMessage` Bridge Inside Embeds

- Listen for `window.addEventListener('message', (e) => { if (e.data?.type === 'cairn:embed:init') { /* e.data.props */ } })`.
- Post `{ type: 'cairn:embed:resize', height: document.documentElement.scrollHeight }` to auto-fit iframe height.
- Post `{ type: 'cairn:embed:telemetry', summary: 'Current state summary' }` to update the frame footer status line.

## Bot & Script Operations for Inline Comments

Comments are stored in `<doc-without-.md>.comments.json` alongside each `.md` file. Bots may edit that JSON file directly or call the REST endpoints:

1. **Create thread on prose quote:**
   ```bash
   curl -X POST http://127.0.0.1:8088/api/projects/cindervault-rpg/comments \
     -H 'Content-Type: application/json' \
     -d '{
       "path": "docs/vault-breach-action.md",
       "quote": "each breach attempt caps committed Lantern Oil at two charges per action",
       "author": "Audit Bot",
       "role": "bot",
       "body": "Confirmed cap matches engine constant MAX_BREACH_OIL = 2."
     }'
   ```
2. **Reply to thread:**
   `POST /api/projects/:projectId/comments/:threadId/replies` with `{"path":"...","author":"Audit Bot","role":"bot","body":"..."}`.
3. **Resolve or reopen thread:**
   `POST /api/projects/:projectId/comments/:threadId/status` with `{"path":"...","status":"resolved","actor":"Audit Bot","role":"bot","note":"Verified"}`.

## Dependencies & Licenses

| Package | Purpose | License |
| :--- | :--- | :--- |
| `react`, `react-dom` | Workspace UI rendering | MIT |
| `@tiptap/*`, `prosemirror-*` | Rich visual Markdown editor, tables, task lists, decorations | MIT |
| `unified`, `remark-parse`, `remark-gfm`, `remark-frontmatter`, `remark-stringify` | Lossless Markdown AST parsing and serialization | MIT |
| `express`, `chokidar` | Local HTTP API, sandboxed asset serving, and live file watching | MIT |
| `lucide-react` | Minimal UI iconography | ISC |
| `@fontsource/jetbrains-mono` | Self-hosted WOFF2 monospace code & source font | OFL-1.1 |
| `typescript`, `vite`, `vitest`, `supertest`, `tsx` | Build, typecheck, and automated test toolchain | Apache-2.0 / MIT |
| `playwright` | Local headless Chromium runner for repeatable review packet screenshots | Apache-2.0 |

## Screenshot Capture & Visual Review Packets

See [`docs/SCREENSHOTS.md`](docs/SCREENSHOTS.md) for the unattended local Playwright screenshot runner (`npm run capture -- run ...`), optional `openbot_browser` interactive inspection (`plan` + `record`), named UI states (`config/capture-manifest.json`), packet validation, and competitor PNG import:

```bash
npm run capture -- list
npm run capture -- run --packet playwright-2026-11-15 --all --base-url http://100.117.116.91:8088
npm run capture -- validate --packet playwright-2026-11-15
```
