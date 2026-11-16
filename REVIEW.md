# Review Handoff & Five-Minute Walkthrough

## Service & Access Summary

- **Private Tailscale Review URL:** `http://100.117.116.91:8088/`
- **Localhost Review URL:** `http://127.0.0.1:8088/`
- **Health Endpoint:** `http://100.117.116.91:8088/healthz` (`{"status":"ok","service":"cairn-wiki-hub","projectCount":2,...}`)
- **Network Exposure:** Bound exclusively to `127.0.0.1:8088` and `100.117.116.91:8088` (not bound to `0.0.0.0` or LAN `192.168.88.227`; no public tunnels).
- **Service Lifetime:** Running as a detached `openbot` production Node.js process managed by `/workspace/wiki-prototype/scripts/server-ctl.sh` (survives shell exits; restart after host reboot via `./scripts/server-ctl.sh start` or switch to `ubuntu`'s lingering rootless Docker daemon below).

### Start / Stop / Status Commands

```bash
cd /workspace/wiki-prototype
./scripts/server-ctl.sh status
./scripts/server-ctl.sh restart
./scripts/server-ctl.sh stop
./scripts/server-ctl.sh start
```

---

## Rootless Docker Status & Account Boundary

- **Verified Daemon State on Host (`aio`):** Rootless Docker **is running** under account **`ubuntu` (uid `1000`)**:
  - Verified live processes via `ps -ef`: `rootlesskit --state-dir=/run/user/1000/dockerd-rootless --net=slirp4netns ... /home/ubuntu/bin/dockerd-rootless.sh` (PID `20359`), `slirp4netns` (PID `20393`), and `dockerd` (PID `20402`).
  - Verified `/etc/subuid` and `/etc/subgid` contain `ubuntu:100000:65536` (and no entry for `openbot`).
- **Precise Privilege Boundary:** This builder runs as **`openbot` (uid `999`)**, which has no `sudo` rights, no subordinate UID/GID allocation, and no permission to traverse `/run/user/1000` (`0700` owned by `ubuntu`) or read `/home/ubuntu/bin/docker`. Consequently, `openbot` cannot directly invoke `ubuntu`'s `docker info` or `docker compose up` without crossing OS account permissions.
- **Ready-to-Run Handoff for `ubuntu` (uid `1000`):** All files in `/workspace/wiki-prototype` preserve group/POSIX ACL `rwX` permissions (`0770`/`0660`) granting `ubuntu` full access, and `Dockerfile` + `compose.yaml` are configured for rootless UID mapping (container UID `0` maps to unprivileged host `ubuntu` UID `1000`). To switch port `8088` from the `openbot` Node server to the rootless Docker container:
  ```bash
  # 1. Stop the openbot host Node listener freeing port 8088 (as openbot or via server-ctl.sh):
  /workspace/wiki-prototype/scripts/server-ctl.sh stop

  # 2. As ubuntu (uid 1000), verify rootless mode and launch Compose:
  export XDG_RUNTIME_DIR=/run/user/1000
  export DOCKER_HOST=unix:///run/user/1000/docker.sock
  cd /workspace/wiki-prototype
  /home/ubuntu/bin/docker info --format '{{json .SecurityOptions}}'
  /home/ubuntu/bin/docker compose up -d --build
  ```

---

## Five-Minute Reviewer Walkthrough

1. **Minute 1 — Read-First RPG Doc & Content-Sized Interactive Embeds (`Scenario 1`):**
   - Open `http://100.117.116.91:8088/`. It loads **Cindervault RPG** (`docs/vault-breach-action.md`) in **Read** mode by default—no formatting toolbar or embed arrangement chrome competes with reading. Click the `main · 1 uncommitted` badge in the top bar at any time to inspect the full checkout path and `git diff HEAD`.
   - Scroll down and operate all three sandboxed widgets in Read mode (each sizes dynamically to its actual rendered content via instance-validated `cairn:embed:ready`/`cairn:embed:resize` messages while preserving `sandbox="allow-scripts"` + strict CSP):
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
   - Trigger a simultaneous edit conflict: Cairn refuses to overwrite disk, backs up the editor buffer under `.cairn/conflicts/`, and opens the side-by-side **Conflict resolution** modal.
   - Click the `main · ... uncommitted` badge in the top bar to inspect the checkout path and unified `git diff HEAD`, enter a commit message, and click **Commit changes** (commits locally on `main` with the OpenBot trailer; never pushes).

5. **Minute 5 — Cross-Project Search, Lab Runbook & Responsive Portrait/Landscape Drawers:**
   - Switch **Repository** to **Helios Bench Runbook (`main`)**, toggle rails in *Helios Rack Power & Boot Sequencer* (`embeds/power-sequencer/index.html`), and search `Ward-Seal` or `198.51.100.41` across repositories.
   - Collapse either **Docs** or **Review** even on wide desktop using each panel's `×` close button, and reopen via the header **Docs** / **Review** buttons.
   - Resize or view on phone portrait (`390x844`), tablet (`768x960`), or short landscape (`844x390` / `956x440`): **Edit** and **Review** stay side-by-side without wrapping, prose scrolls natively via the root document (`window.scrollY`), wide tables (`docs/bench-inventory.md`) scroll strictly inside `.tableWrapper` without clipping prose left edges, and **Docs** / **Review** open as modal overlays (`role="dialog"`, `<main inert>`, focus-trapped, draft-preserving across dismiss and rotation).

---

## Validation Commands Run & Outcomes

| Command | Outcome |
| :--- | :--- |
| `npm run typecheck` | Passed (`tsc --noEmit`, 0 errors) |
| `npm run build` | Passed (`dist/client` Vite bundle + self-hosted WOFF2 fonts; `dist/server` compiled Node ESM) |
| `npm test` | Passed (`5` test files, `23/23` Vitest + Supertest + Playwright Chromium E2E tests covering Scenarios 1–9, capture pipeline validation, Read-mode IA + prose commenting, dynamic & fallback embed sizing, Visual/Source authoring + 409 conflict recovery, portrait/landscape/above-880/desktop action-pair geometry & collapsible panels, native root scroll + modal drawer scroll lock/inert/focus-trap/draft preservation across rotation, and `helios-lab` wide-table non-clipping) |
| `./scripts/server-ctl.sh restart && curl -fsS http://100.117.116.91:8088/healthz` | Passed (`{"status":"ok","service":"cairn-wiki-hub","projectCount":2,...}`; verified sockets exclusively on `127.0.0.1:8088` and `100.117.116.91:8088` via `ss -lntp`) |
| `npm run capture -- run --packet responsive-ia-pass-03 --all --base-url http://100.117.116.91:8088` | Passed (`16/16` screenshots captured & validated in `captures/packets/responsive-ia-pass-03`, `valid: true`, `0` issues) |

---

## Dependencies & Licenses

- Runtime: `express` (MIT), `chokidar` (MIT), `react` / `react-dom` (MIT), `@tiptap/*` & `prosemirror-*` (MIT), `unified` / `remark-*` (MIT), `lucide-react` (ISC), `@fontsource/literata` / `@fontsource/plus-jakarta-sans` / `@fontsource/jetbrains-mono` (SIL OFL 1.1).
- Build & Test: `typescript` (Apache-2.0), `vite` / `@vitejs/plugin-react` (MIT), `vitest` (MIT), `supertest` (MIT), `playwright` (Apache-2.0), `tsx` (MIT).

## Known Limitations

1. **Container startup step:** `Dockerfile` and `compose.yaml` are complete, hardened, and ACL-ready, but starting the container on `/run/user/1000/docker.sock` requires running `docker compose up -d --build` as `ubuntu` (uid `1000`) after stopping `./scripts/server-ctl.sh stop`.
2. **Prose-only comments & block-level embeds:** As scoped in `SPEC.md`, inline comments anchor to document prose (not inside iframe widget internals or code blocks), and simultaneous edits use optimistic revision conflict recovery rather than CRDT realtime co-editing.
3. **Table cell complexity:** Visual table cells edit single-paragraph inline formatting cleanly; multi-block content inside table cells is better authored in Markdown source mode or collapsible raw HTML blocks.
4. **Capture pipeline scope & Safari/WebKit browser chrome:** `npm run capture` restricts automated Playwright runs to local/private Cairn URLs (`127.0.0.1`, `localhost`, `100.117.116.91`) using local Playwright Chromium (`159.0.8154.6`; Playwright WebKit is not installed on this Linux host). Switching Read/Visual modes to native root document scrolling enables standard mobile browser scroll mechanics, whereas Safari's own address/tab bar collapsing behavior remains controlled by iOS Safari on physical hardware rather than web-page CSS/JS.
