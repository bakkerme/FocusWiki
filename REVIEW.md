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

1. **Minute 1 — Visual RPG Doc & Interactive Embeds (`Scenario 1`):**
   - Open `http://100.117.116.91:8088/`. It loads **Cindervault RPG** (`docs/vault-breach-action.md`), clearly marked as fictional prototype data, with checkout path, `branch: main`, and working-tree status in the top bar.
   - Scroll down and operate all three sandboxed widgets:
     1. *Ward-Breach State & Transition Explorer*: click **Commit Lantern Oil** -> **Roll 2d6 Check** -> **Total 7–9 (Strained)** and inspect the live engine state JSON.
     2. *Sunken Reliquary Step-Through Walkthrough*: step through Beats 1–5 and toggle the Beat 5 `7–9` consequence cost.
     3. *Stat & Ward Difficulty Outcome Playground*: adjust Rigging/Oil sliders, toggle **Assisted Pry-Bar**, and click **Roll sample check**.
   - Edit any prose sentence visually, wait ~1s for **Saved to disk** + **1 uncommitted file**, and reload the browser tab: the Markdown file on disk retains your edit and all widgets remain interactive.

2. **Minute 2 — Reordering / Adding Generic Project Embeds (`Scenario 3`):**
   - On any embed card header, click **Move up** or **Move down**, then toggle **Markdown source** in the top bar to see the fenced ` ```embed ` block reordered cleanly with its `src` and `props` intact.
   - Switch back to **Visual**, click **Insert embed** -> **Create new component in embeds/**, write a new component (e.g. `custom-tracker`), and click **Write component & insert embed**. A fourth project-owned HTML/JS widget is written to `sample-repos/cindervault-rpg/embeds/custom-tracker/index.html` and rendered immediately in an isolated `null`-origin sandbox without changing hub code.

3. **Minute 3 — Inline Prose Comments & Anchor Resilience (`Scenarios 4 & 5`):**
   - Highlight any prose phrase and click **Comment on selection** (or press `Alt+C`). Post a comment, add a **Reply**, click **Resolve**, check **Show resolved**, click **Reopen**, and reload the browser—history persists in `docs/vault-breach-action.comments.json`.
   - Cut and paste the highlighted sentence into another section: the anchor stays **Anchored** at the new location. Duplicate that sentence so two identical copies exist: the thread moves to **Unattached anchors** as **Ambiguous anchor**. Delete both copies: it flags **Orphaned anchor**.

4. **Minute 4 — External Edits, Conflict Protection & Local Git Commit (`Scenarios 2, 6, 8`):**
   - Edit `sample-repos/cindervault-rpg/docs/vault-breach-action.md` externally on disk while the editor is clean (`Saved to disk`): the browser automatically reloads the external edit via SSE before any commit.
   - To trigger a recoverable conflict, edit a line in the browser and simultaneously modify the file on disk before saving (or via API with a stale `baseRevision`): Cairn refuses to overwrite disk, backs up the editor buffer under `.cairn/conflicts/`, and opens the side-by-side **Conflict resolution** modal with both versions.
   - Click the **uncommitted files** button in the top bar to inspect the unified `git diff HEAD`, enter a commit message, and click **Commit changes** (commits locally on `main` with the OpenBot trailer; never pushes).

5. **Minute 5 — Cross-Project Search & Lab Runbook:**
   - Use **Active repository** to switch to **Helios Bench Runbook (`main`)**, toggle rails in the *Helios Rack Power & Boot Sequencer* embed (`embeds/power-sequencer/index.html`), and type `Ward-Seal` or `198.51.100.41` in **Search across projects** to jump across repositories.

---

## Validation Commands Run & Outcomes

| Command | Outcome |
| :--- | :--- |
| `npm run typecheck` | Passed (`tsc --noEmit`, 0 errors) |
| `npm run build` | Passed (`dist/client` Vite bundle + self-hosted WOFF2 fonts; `dist/server` compiled Node ESM) |
| `npm test` | Passed (`3` test files, `12/12` Vitest unit & Supertest integration tests covering Scenarios 1–9: AST round-trip + raw preservation, anchor move/orphan/ambiguous resolution, autosave, external edits, 409 conflict backup, 4th component creation, comment lifecycle, Git diff/commit with trailer, path traversal & `.git` rejection, and embed CSP headers) |
| `./scripts/server-ctl.sh restart && curl -fsS http://100.117.116.91:8088/healthz` | Passed (`{"status":"ok","service":"cairn-wiki-hub","projectCount":2,...}`; verified sockets on `127.0.0.1:8088` and `100.117.116.91:8088` via `ss -tln`) |
| Live Browser Flow (`openbot_browser`) | Passed against `http://127.0.0.1:8088/`: verified all 3 RPG widgets via CDP input + `postMessage` telemetry, visual prose edit + reload persistence, prose selection -> inline comment creation + reload persistence, and switching to `helios-lab`. |

---

## Dependencies & Licenses

- Runtime: `express` (MIT), `chokidar` (MIT), `react` / `react-dom` (MIT), `@tiptap/*` & `prosemirror-*` (MIT), `unified` / `remark-*` (MIT), `lucide-react` (ISC), `@fontsource/literata` / `@fontsource/plus-jakarta-sans` / `@fontsource/jetbrains-mono` (SIL OFL 1.1).
- Build & Test: `typescript` (Apache-2.0), `vite` / `@vitejs/plugin-react` (MIT), `vitest` (MIT), `supertest` (MIT), `tsx` (MIT).

## Known Limitations

1. **Container startup step:** `Dockerfile` and `compose.yaml` are complete, hardened, and ACL-ready, but starting the container on `/run/user/1000/docker.sock` requires running `docker compose up -d --build` as `ubuntu` (uid `1000`) after stopping `./scripts/server-ctl.sh stop`.
2. **Prose-only comments & block-level embeds:** As scoped in `SPEC.md`, inline comments anchor to document prose (not inside iframe widget internals or code blocks), and simultaneous edits use optimistic revision conflict recovery rather than CRDT realtime co-editing.
3. **Table cell complexity:** Visual table cells edit single-paragraph inline formatting cleanly; multi-block content inside table cells is better authored in Markdown source mode or collapsible raw HTML blocks.
