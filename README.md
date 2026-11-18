# FocusWiki — Self-Hosted Repository Documentation Hub

FocusWiki (shown as **Focus** in the UI) is a private, local-first documentation workspace over Git-backed Markdown repositories. Humans write and review visually with live interactive embeds and anchored marginalia; bots and scripts edit authoritative `.md`, `embeds/`, and `.comments.json` files directly on disk or via a compact HTTP JSON API.

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

## Managed Git and Pull Requests

Use **Enrollment** in the sidebar to see how to request repository access. The workspace operator configures the working copy, upstream, and Git credentials on the server. The sidebar lists the repositories available to you.

1. Edit a document as usual. **Saved locally** means FocusWiki wrote your draft to the local working copy. Inline comments and component changes also live in project files. Saving and opening a review have no upstream effect.
2. Open **Review working changes** from the topbar Git status. Inspect the rich or raw diff, select the files to include, and enter a proposal message. Each new review starts with no files selected.
3. Choose **Propose changes** to publish the selected snapshot as a pull request. Open the returned link to check the pull request and its merge status on the Git host.
4. If the review becomes stale, choose **New review**, inspect the updated diff, and select the files again. If publishing is interrupted, **Retry proposal** resubmits the same review, file selection, and message. Your local draft stays on disk.

**Backend dependency.** Publishing requires the managed enrollment, Git service, and proposal backend. The browser reads `GET /api/projects/:projectId/git/diff` for the existing rich review payload plus an opaque `reviewId`. It sends `POST /api/projects/:projectId/git/propose` with JSON `{reviewId, message, paths}` and `X-FocusWiki-Intent: propose` on the same origin. The server validates the review and selected paths, and returns `{url, sha}` on success. A diff without a review ID is available for inspection only.

## Images, Links, and Visual Editing

In **Edit → Visual**, use **Image** for a repository path or HTTP(S) URL, alternative text, and an optional title. Inline and standalone Markdown images remain editable and retain their original `src`, `alt`, and `title` when saved. Repository image URLs resolve against the current document directory and render through `/api/projects/:projectId/assets/:path`; they are never rewritten into API URLs in Markdown. Remote images load directly from their host with no referrer.

The link button opens a keyboard-accessible form (**Apply**, **Remove Link**, **Cancel**, or Escape). Document links such as `../overview.md#authentication` resolve relative to the current document; `#heading` links scroll within it. Headings have deterministic GitHub-style anchors, including duplicate suffixes. Selecting a table cell reveals row, column, and table deletion controls. These controls appear only in Edit mode.

### TipTap dependency limitation

All TipTap packages are pinned together to `2.27.3`, the latest published v2 release verified on 2026-11-17. There is **no published patched v2** for [GHSA-cp6q-959q-f8rh](https://github.com/advisories/GHSA-cp6q-959q-f8rh): npm identifies every release below `3.30.4` as affected. `npm audit --omit=dev` therefore reports **33 moderate vulnerabilities** (one core advisory and dependent packages), rather than zero. A coordinated migration to patched v3 or an upstream v2 backport is required; audit reporting has not been suppressed.

## Rootless Docker Packaging & Deployment (`ubuntu` uid 1000)

`Dockerfile` and `compose.yaml` package the production build with persistent bind mounts for `./sample-repos`, `./repos` (`FOCUSWIKI_REPOS_DIR=/app/repos`), and `./config` for server-side configuration, dropped Linux capabilities (`cap_drop: [ALL]`), `no-new-privileges`, a `/healthz` healthcheck, and `restart: unless-stopped`.

Docker URLs are **http://100.117.116.91:8088/** (private Tailscale) and **http://127.0.0.1:8089/** (loopback). This host's rootless Docker fails when publishing both addresses with the same host port; distinct host ports avoid that conflict. The container still listens on port `8088`. Nothing is published on the LAN address or a wildcard host address.

The image includes the compiled seed script for first startup. Existing repositories are retained. Git trusts mounted sample checkouts explicitly and applies per-repo `-c safe.directory=<path>` for registered repositories without enabling wildcard trust.

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

## Docker CI/CD

GitHub Actions tests and builds the Docker image and publishes successful `main` builds to Google Artifact Registry at `gcr.io`. See [Docker CI/CD setup](docs/DOCKER-CICD.md) for the registry and GitHub configuration.

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

- Listen for `window.addEventListener('message', (e) => { if (e.data?.type === 'focus:embed:init') { /* e.data.props */ } })`.
- Post `{ type: 'focus:embed:resize', height: document.documentElement.scrollHeight }` to auto-fit iframe height.
- Post `{ type: 'focus:embed:telemetry', summary: 'Current state summary' }` to update the frame footer status line.

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

## Agent Skills for Documentation Repositories (`skills/`)

FocusWiki pages are standard GitHub-Flavored Markdown with attachable self-contained HTML artefacts (`embeds/<name>/index.html`) and sibling `.comments.json` review sidecars. Three minimal [`agentskills.io`](https://agentskills.io)-compatible skills live under [`skills/`](skills/) so coding agents (Claude Code, Codex, Cursor, Gemini CLI, Antigravity, GitHub Copilot, etc.) can work with any FocusWiki-backed repository:

- **[`focuswiki-docs`](skills/focuswiki-docs/SKILL.md)** — Standard GFM pages plus attaching interactive HTML artefacts via ` ```embed ` fences (`src`, `title`, `height`, single-line JSON `props`) and running the zero-dependency offline validator (`scripts/validate-wiki.mjs`).
- **[`focuswiki-embeds`](skills/focuswiki-embeds/SKILL.md)** — Authoring self-contained `embeds/<name>/index.html` artefacts inside FocusWiki's `<iframe sandbox="allow-scripts">` + strict CSP (no storage/cookies or external CDNs, light/dark CSS tokens, and optional `focus:embed:*` auto-sizing), starting from `assets/embed-starter.html`.
- **[`focuswiki-comments`](skills/focuswiki-comments/SKILL.md)** — Managing inline review threads with `"role": "bot"`:
  - **Inside a local checkout / branch / worktree (default):** Edit `<doc-without-.md>.comments.json` directly on disk—no server URL required, and changes stay on the active Git branch.
  - **Against a live FocusWiki server over HTTP:** Resolve `<origin>` and `:projectId` from a pasted FocusWiki browser URL (`http://<host>:<port>/?project=<projectId>&doc=<docPath>`), from `FOCUSWIKI_URL` / `.focuswiki/config.json`, or by matching `rootPath` / `git.remoteUrl` in `GET <origin>/api/projects`.

### Installing into a Documentation Repository

Run from the root of any documentation repository and commit the installed `.agents/skills/` files (plus `.claude/skills/` symlinks and `skills-lock.json`):

```bash
# Install from GitHub or a local FocusWiki checkout:
npx skills add bakkerme/FocusWiki
# or:
npx skills add /workspace/wiki-prototype

# Optional offline check for embed fences, sandbox rules, and comment anchors:
node .agents/skills/focuswiki-docs/scripts/validate-wiki.mjs .
```

*(Workspace-internal UI design skills in `.agents/skills/` carry `metadata.internal: true` so external repos only install the three authoring skills above. FocusWiki's document scanner and file watcher automatically ignore dot-directories like `.agents/` and `.claude/` as well as `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`.)*

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
