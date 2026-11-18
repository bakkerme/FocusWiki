# Review Handoff & Five-Minute Walkthrough

## Internal LAN Readiness & Hardening Verification — 2026-11-17

Summary of integrated hardening, Git clone lifecycle, authoring, and test verification:

- **Git Cloning & Repository Security (`server/gitService.ts`, `server/credentialStore.ts`, `server/pathGuard.ts`, `server/projectRegistry.ts`):**
  - Hardened every `git` invocation with `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `submodule.recurse=false`, `core.symlinks=false`, `http.followRedirects=false`, `transfer.fsckObjects=true`, `protocol.allow=never` + explicit per-protocol allowlisting, URL-rewrite (`insteadOf`) blocking, minimal child environments (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`), and `0700` ephemeral credential helpers with stderr/stdout secret scrubbing.
  - Added DNS/IP SSRF classification blocking loopback, link-local, metadata, multicast, CGNAT, and RFC1918/ULA targets unless explicitly allowlisted via `FOCUSWIKI_ALLOWED_GIT_HOSTS`, plus strict `allowedImportRoots` enforcement on `file://` remotes.
  - Added atomic `.cloning-*` staging-directory clones with post-clone `.git/config` sanitization, `.git/info/exclude` rules for `.focuswiki/` and `.cairn/`, concurrency/per-repo locks, optional `--depth 1 --single-branch` shallow cloning, and selective per-file `paths` commit staging.
- **Zero-Auth LAN HTTP Hardening, Atomic Storage & Ops (`server/httpSecurity.ts`, `server/fileLock.ts`, `server/app.ts`, `server/watcher.ts`, `Dockerfile`, `.github/workflows/ci.yml`):**
  - Enforced `Host` header syntax/DNS-rebinding checks, `Origin` / `Sec-Fetch-Site` CSRF blocking on mutating `/api/*` endpoints, validated `/embed-sandbox/*` CSP headers, rate limiting on expensive endpoints, bounded `/api/events` SSE clients, per-file mutex + atomic writes for documents/comments (`404` on missing threads), and sandboxed `/api/projects/:projectId/assets/*` image serving.
- **Editor, Dependencies & UI Polish (`package.json`, `shared/markdownCodec.ts`, `src/editor/VisualMarkdownEditor.tsx`, `src/App.tsx`, modals):**
  - Upgraded `@tiptap/*` to `3.34.0` (`npm audit --omit=dev` -> **0 vulnerabilities**) and configured Vite vendor chunking (largest chunk ~256 kB).
  - Added lossless Markdown image (`![alt](src "title")`) round-tripping and rendering, nested relative `.md#fragment` link resolution and heading anchor scrolling, inline link/image authoring popovers, contextual table row/column controls, modal focus traps, visible comment mutation error banners, shallow-clone toggle, and selective commit checkboxes.
- **Automated Test Suite (`vitest.config.ts`, `tests/*`):**
  - Added automatic stale-bundle rebuilds (`tests/setupBuildClient.ts`), isolated test fixtures eliminating parallel browser flakiness, and expanded coverage to **17 test files / 226 tests** including Playwright coverage for `SettingsModal`, `ImportRepoModal`, and `GitDrawerModal`.

## Service & Access Summary

- **Private Tailscale Review URL:** `http://100.117.116.91:8088/`
- **Localhost Docker Review URL:** `http://127.0.0.1:8089/`
- **Health Endpoint:** `http://100.117.116.91:8088/healthz` (`{"status":"ok","service":"focuswiki","projectCount":2,...}`)
- **Network Exposure:** Bound exclusively to `127.0.0.1:8089` and `100.117.116.91:8088` (not bound to `0.0.0.0` or LAN `192.168.88.227`; no public tunnels). Distinct host ports avoid the verified rootless Docker conflict when publishing both addresses on the same port.
- **Service Lifetime:** Running as detached Compose container `focuswiki`, with `restart: unless-stopped`, using `ubuntu`'s existing rootless daemon. Container restart and recreation were verified; host reboot was not tested.

### Start / Stop / Status Commands

```bash
cd /workspace/wiki-prototype
export XDG_RUNTIME_DIR=/run/user/1000
export DOCKER_HOST=unix:///run/user/1000/docker.sock
docker compose ps
docker compose restart
docker compose down
docker compose up -d --build --wait --wait-timeout 60
```

---

## Docker Verification — 2026-11-16

The Docker audit ran as `ubuntu` (uid `1000`) against the existing daemon on `aio`, through `unix:///run/user/1000/docker.sock`. `docker info --format '{{json .SecurityOptions}}'` returned `["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]`. Docker Engine is `29.9.3`; Compose is `v2.35.1`. No administrator changes were required.

Three deployment failures were reproduced and fixed:

- First startup failed with `Cannot find module '/app/dist/server/scripts/seed-repos.js'`. The Dockerfile now copies and compiles the seed script.
- Publishing both private addresses on host port `8088` failed with `address already in use`, even with no pre-existing listener. Each address worked alone; loopback `8089` plus Tailscale `8088` worked together and was verified with HTTP requests and `ss -ltnp`.
- Existing sample repositories appeared as `nobody` inside the rootless container, and Git's ownership check caused `/api/projects` to return `500`. The image now trusts exactly the two sample checkout paths in its system Git configuration. Host ownership and ACLs were retained.

Commands and results:

| Check | Current outcome |
| --- | --- |
| `docker compose config --quiet` | Passed |
| `docker compose build --quiet` | Production image built successfully |
| `docker compose up -d --wait --wait-timeout 60` | Healthy, detached service |
| `node scripts/docker-smoke.mjs` | Fresh seeding, production client assets, Git status, document/comment/component writes, restart and container recreation passed using a disposable named volume; test resources removed |
| HTTP checks on both private host URLs | Populated client, compiled JavaScript, health, projects, default documents and comments returned `200`; search and sandbox CSP verified |
| Existing bind mounts and `docker compose restart` | Both sample mounts writable; all existing file hashes and Git status identical before and after restart |
| Container inspection | `unless-stopped`, all capabilities dropped, `no-new-privileges`, read-only config, persistent sample mount, exact private ports and no Docker socket mount verified |
| `npm run typecheck` and `npm run build` | Passed; Vite reports its existing large-bundle advisory |
| `npx vitest run tests/anchorResolver.test.ts tests/changeReview.test.ts tests/markdownCodec.test.ts tests/readingPreferences.test.ts tests/apiIntegration.test.ts` | 5 files, 18 tests passed |
| `npm test` | 22 tests passed, 1 capture test failed, 10 UI tests skipped due to their suite setup failure. Both browser failures report Chromium `No usable sandbox!`; AppArmor and browser sandbox protections were retained. Browser flows were not verified during this Docker audit. |

The image build also reports that Git provenance could not be captured from the shared checkout's ownership; this does not prevent the build or application Git operations inside the container. No source commits or pushes were created. Existing sample document contents and history were preserved.

---

## Five-Minute Reviewer Walkthrough

1. **Minute 1 — Read-First RPG Doc & Content-Sized Interactive Embeds (`Scenario 1`):**
   - Open `http://100.117.116.91:8088/`. It loads **Cindervault RPG** (`docs/vault-breach-action.md`) in **Read** mode by default—no formatting toolbar or embed arrangement chrome competes with reading. Click the `main · 1 uncommitted` badge in the top bar at any time to inspect the full checkout path and `git diff HEAD`.
   - Scroll down and operate all three sandboxed widgets in Read mode (each sizes dynamically to its actual rendered content via instance-validated `focus:embed:ready`/`focus:embed:resize` (with legacy `cairn:embed:*` support) messages while preserving `sandbox="allow-scripts"` + strict CSP):
     1. *Ward-Breach State & Transition Explorer*: click **Commit Lantern Oil** -> **Roll 2d6 Check** -> **Total 7–9 (Strained)** and inspect the live engine state JSON.
     2. *Sunken Reliquary Step-Through Walkthrough*: step through Beats 1–5 and toggle the Beat 5 `7–9` consequence cost.
     3. *Stat & Ward Difficulty Outcome Playground*: adjust Rigging/Oil sliders, toggle **Assisted Pry-Bar**, and click **Roll sample check**.
   - Click **Edit** in the top bar to enter **Visual editor**, edit any prose sentence, wait ~1s for **Saved locally**, click **Done** to return to **Read**, and reload the browser tab: the Markdown file on disk retains your edit and all widgets remain interactive.

2. **Minute 2 — Full-Workspace Markdown Source & Generic Project Embeds (`Scenario 3`):**
   - Click **Edit** to enter **Visual editor**. Notice authoring controls (`Move up`, `Move down`, `Source & props`, `Remove`) now appear on embed cards, and `Project embeds` expands in the left sidebar.
   - Switch to **Markdown source**: the workspace expands to a full-height, full-width monospaced source editor with a synchronized line-number gutter, amber comment dots on anchored lines (`View in Read`), a **Wrap lines** toggle (unwrapped by default so wide Markdown pipe tables stay aligned), and **Insert embed syntax** (right Review rail auto-collapses to maximize horizontal editing room).
   - Switch back to **Visual editor**, click **Insert embed** -> **Create new component in embeds/**, write a new component (e.g. `custom-tracker`), and click **Write component & insert embed**. A fourth project-owned HTML/JS widget is written to `sample-repos/cindervault-rpg/embeds/custom-tracker/index.html` and rendered immediately in an isolated `null`-origin sandbox; components that omit `postMessage` resize still render with a bounded fallback height and an **Expand frame height** toggle.

3. **Minute 3 — Read-Mode Inline Prose Comments & Anchor States (`Scenarios 4 & 5`):**
   - In **Read** mode (without entering Edit), highlight any prose phrase and click the floating **Comment** chip (or **Comment on selection** in the Review rail). Post a comment, add a **Reply**, click **Resolve**, check **Resolved**, click **Reopen**, and reload—history persists in `docs/vault-breach-action.comments.json`.
   - Compare prose anchor treatments: unselected open threads use a warm wash + subtle underline, the selected thread adds a richer gold wash + focus halo and expands its card in the Review rail, and resolved threads collapse into compact summary cards with a muted dashed prose underline + `✓` badge.
   - Cut and paste an anchored sentence in **Edit** mode: the anchor stays attached at the new location; duplicating creates an **Ambiguous** unattached thread; deleting flags **Orphaned**.

4. **Minute 4 — External Edits, Conflict Protection & Local Git Commit (`Scenarios 2, 6, 8`):**
   - Edit `sample-repos/cindervault-rpg/docs/vault-breach-action.md` externally on disk while clean (`Saved locally`): the browser reloads the external edit via SSE before any commit.
   - Trigger a simultaneous edit conflict: FocusWiki refuses to overwrite disk, backs up the editor buffer under `.focuswiki/conflicts/`, and opens the side-by-side **Conflict resolution** modal.
   - Click the `main · ... uncommitted` badge in the top bar to open **Review working changes**: inspect structured Markdown diffs (which highlight inline prose additions while separating formatting-only table pipe alignment from real cell changes), human-readable `.comments.json` updates, code diffs, or secondary **Raw diff**, enter a commit message, and click **Commit N files** (commits locally on `main` preserving your exact message and author identity; never pushes).

5. **Minute 5 — Cross-Project Search, Lab Runbook & Responsive Portrait/Landscape Drawers:**
   - Switch **Repository** to **Helios Bench Runbook (`main`)**, toggle rails in *Helios Rack Power & Boot Sequencer* (`embeds/power-sequencer/index.html`), and search `Ward-Seal` or `198.51.100.41` across repositories.
   - Collapse either **Docs** or **Review** even on wide desktop using each panel's `×` close button, and reopen via the header **Docs** / **Review** buttons.
   - Resize or view on phone portrait (`390x844`), tablet (`768x960`), or short landscape (`844x390` / `956x440`): **Edit** and **Review** stay side-by-side without wrapping, prose scrolls natively via the root document (`window.scrollY`), wide tables (`docs/bench-inventory.md`) scroll strictly inside `.tableWrapper` without clipping prose left edges, and **Docs** / **Review** open as modal overlays (`role="dialog"`, `<main inert>`, focus-trapped, draft-preserving across dismiss and rotation).

---

## Prior Application Validation (Before the Docker Audit)

The following results were recorded by earlier application work. Current deployment results and the browser sandbox blocker are documented in the Docker verification section above.

| Command | Outcome |
| :--- | :--- |
| `npm run typecheck` | Passed (`tsc --noEmit`, 0 errors) |
| `npm run build` | Passed (`dist/client` Vite bundle + self-hosted WOFF2 fonts; `dist/server` compiled Node ESM) |
| `npm test` | Passed (`7` test files, `33/33` Vitest + Supertest + Playwright Chromium E2E tests covering Scenarios 1–9, block-preserving Markdown table/prose serialization, Rich Change Review comparators, capture pipeline validation, Read-mode IA + centered reading column with Review closed, edit-session `Done` + `Revert` across Visual/Source + autosave race/save-error/409 conflict, Rich Change Review UI + clean human commits without forced OpenBot trailers, and responsive drawers/tables) |
| `./scripts/server-ctl.sh restart && curl -fsS http://100.117.116.91:8088/healthz` | Passed (`{"status":"ok","service":"focuswiki","projectCount":2,...}`; verified sockets exclusively on `127.0.0.1:8088` and `100.117.116.91:8088` via `ss -lntp`) |
| `npm run capture -- run --packet review-pass-04 --all --base-url http://100.117.116.91:8088` | Passed (`20/20` screenshots captured & validated in `captures/packets/review-pass-04`, `valid: true`, `0` issues) |

---

## Dependencies & Licenses

- Runtime: `express` (MIT), `react` / `react-dom` (MIT), `@tiptap/*` & `prosemirror-*` (MIT), `unified` / `remark-*` (MIT), `lucide-react` (ISC), `@fontsource/jetbrains-mono` (SIL OFL 1.1).
- Build & Test: `typescript` (Apache-2.0), `vite` / `@vitejs/plugin-react` (MIT), `vitest` (MIT), `supertest` (MIT), `playwright` (Apache-2.0), `tsx` (MIT).

## Known Limitations

1. **Current browser-test blocker:** Chromium launched by Playwright reports `No usable sandbox!` on this host. The Docker audit did not disable AppArmor or Chromium's sandbox. The non-browser tests and live HTTP/container checks passed, but UI browser flows need re-verification with an approved sandboxed browser installation.
2. **Prose-only comments & block-level embeds:** As scoped in `SPEC.md`, inline comments anchor to document prose (not inside iframe widget internals or code blocks), and simultaneous edits use optimistic revision conflict recovery rather than CRDT realtime co-editing.
3. **Table cell complexity:** Visual table cells edit single-paragraph inline formatting cleanly; multi-block content inside table cells is better authored in Markdown source mode or collapsible raw HTML blocks.
4. **Capture pipeline scope & Safari/WebKit browser chrome:** `npm run capture` restricts automated Playwright runs to local/private FocusWiki URLs (`127.0.0.1`, `localhost`, `100.117.116.91`) using local Playwright Chromium (`159.0.8154.6`; Playwright WebKit is not installed on this Linux host). Switching Read/Visual modes to native root document scrolling enables standard mobile browser scroll mechanics, whereas Safari's own address/tab bar collapsing behavior remains controlled by iOS Safari on physical hardware rather than web-page CSS/JS.

## Prior Reading Settings Refresh

- Neutral white navigation and system sans-serif typography replace the editorial serif and tinted rails.
- Reading settings provides 16/18/20px text and 640/760/960px maximum widths, clamped to the available stage. Preferences persist in this browser without repository writes.
- Verified typecheck, production build, and 33 tests, including preset keyboard navigation, rapid preference changes, storage recovery, draft preservation, and responsive modal focus restoration.
- Fresh screenshot packet: `captures/packets/review-pass-05-verified` (25 captures, validation passed). Physically testing Safari browser chrome remains outside these Chromium checks.
