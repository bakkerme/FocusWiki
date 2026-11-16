# Cairn Screenshot Capture & Visual Review Packets

Repeatable, manifest-driven screenshot workflow for generating visual review packets of Cairn (`http://127.0.0.1:8088` or `http://100.117.116.91:8088`) and importing user-provided competitor reference screenshots.

## Design & Safety Invariants

- **Read-only UI staging:** Named states navigate via URL query params (`?project=...&doc=...`), switch view modes, open/collapse panels, toggle review history, and scroll containers/window without saving prose edits or writing to `.comments.json`. Every target asserts saved state (`.workbench[data-save-state="saved"]` in clean Read mode or `.save-badge.saved` in authoring modes).
- **Preserves user working trees:** Never resets or re-seeds `/workspace/wiki-prototype/sample-repos/*`. When a clean seeded baseline is explicitly needed, `npm run capture -- isolated-fixture --port 8089` serves fresh temporary copies in `/tmp` bound only to `127.0.0.1`.
- **Honest state labels:** App states are labeled as they actually behave (`read-default` for the default Read entry state, `visual-edit-explicit` for explicit Visual editor entry, `markdown-source-workspace` for full-workspace source editing), carrying `replacesTargetId` metadata when a redesigned state supersedes an earlier baseline ID.
- **Local/private Playwright scope & sandboxing:** Unattended shell captures (`npm run capture -- run ...`) use a project-local headless Playwright Chromium binary (`.runtime/ms-playwright`, installed via `PLAYWRIGHT_BROWSERS_PATH=/workspace/wiki-prototype/.runtime/ms-playwright npx playwright install chromium`) with full browser sandboxing intact and an explicit host guard restricting `--base-url` to loopback/private/Tailscale Cairn listeners (`127.0.0.1`, `localhost`, RFC 1918, `100.64.0.0/10`). Interactive manual inspection remains optionally available through OpenBot's embedded browser (`openbot_browser`) using `plan` + `record`.

## Named States (`config/capture-manifest.json`)

List selectable targets:

```bash
npm run capture -- list
```

| Target ID | Default | Viewport | Actual App State | What It Captures |
| :--- | :--- | :--- | :--- | :--- |
| `doc-initial-read` | Yes | `1440x900` | `read-default` | Default Read mode entry (replaces `doc-initial-edit`): clean sidebar IA, page eyebrow above `<h1>`, compact sticky header with adjacent `Edit` + `Review`, no noisy `Saved locally` badge |
| `doc-visual-edit` | Yes | `1440x900` | `visual-edit-explicit` | Explicit `Visual editor` mode with sticky icon formatting toolbar, authoring `Saved` badge, `Visual` / `Source` switcher, `Done` button, and embed inventory |
| `source-editing` | Yes | `1440x900` | `markdown-source-workspace` | Full-workspace `Markdown source` editor with synchronized line gutter, comment-line indicator, unwrapped GFM table scroll (`Wrap lines` toggle), and auto-collapsed Review rail |
| `review-thread-open` | Yes | `1440x900` | `read-review-thread-focused` | Focused review thread (expanded messages, audit history, reply input) alongside compact resolved summary and distinct open/selected/resolved prose highlights |
| `embed-visible` | Yes | `1440x900` | `read-embed-visible` | Read mode scrolled via native root scroll to `state-explorer` (`sandbox="allow-scripts"`) showing quiet reader chrome and content-fitted height |
| `narrow-viewport` | Yes | `768x960` | `tablet-read-closed-drawers` | Tablet `768x960` closed reading with `Docs`, `Git`, and non-wrapping `Edit` + `Review` controls |
| `desktop-panels-collapsed` | Optional (`--all`) | `1440x900` | `desktop-both-panels-collapsed` | Desktop `1440x900` distraction-free reading with both `Docs` and `Review` panels collapsed and header reopen buttons visible |
| `narrow-phone` | Optional (`--all`) | `390x844` | `phone-read-closed-drawers` | Phone portrait `390x844` closed reading with compact header and adjacent `Edit` + `Review` pair |
| `phone-nav-open` | Optional (`--all`) | `390x844` | `phone-modal-nav-open` | Phone portrait `390x844` modal `Docs` drawer open (`role="dialog"`, `<main inert>`) |
| `phone-review-open` | Optional (`--all`) | `390x844` | `phone-modal-review-selection-draft` | Phone portrait `390x844` modal `Review` drawer open from active prose selection with draft note |
| `landscape-short-844x390` | Optional (`--all`) | `844x390` | `landscape-short-844x390-read` | Representative short landscape `844x390` closed reading (overlay tier; zero dual-sidebar squeeze) |
| `landscape-above880-956x440` | Optional (`--all`) | `956x440` | `landscape-above880-956x440-read` | Short landscape `956x440` above former `880px` threshold using overlay drawer tier |
| `landscape-review-open-956x440` | Optional (`--all`) | `956x440` | `landscape-956x440-review-open` | Short landscape `956x440` with modal `Review` drawer open over `inert` main stage |
| `portrait-to-landscape-844x390` | Optional (`--all`) | `844x390` | `portrait-to-landscape-transition` | Booted at `390x844`, scrolled `220px`, and rotated live to `844x390` preserving scroll & left prose margin |
| `phone-helios-inventory` | Optional (`--all`) | `390x844` | `phone-helios-table-contained` | `helios-lab` `docs/bench-inventory.md` at `390x844` showing scoped `.tableWrapper` horizontal scroll and unclipped prose |
| `helios-lab-embed` | Optional (`--all`) | `1440x900` | `read-second-project-embed` | `helios-lab` inventory doc at `1440x900` with synthetic RFC 5737 table, content-fitted `power-sequencer` embed, and compact review thread |
| `desktop-centered-review-closed` | Optional (`--all`) | `1440x900` | `desktop-nav-open-review-closed-centered` | Desktop `1440x900` Read mode with `Docs` open and `Review` closed, showing the constrained `67ch` prose column centered symmetrically inside `main.document-stage` |
| `phone-visual-edit-revert` | Optional (`--all`) | `390x844` | `phone-visual-edit-revert-done` | Phone `390x844` Visual editor header showing compact `Visual editor` / `Markdown source` switcher alongside text-label `Revert` and primary `Done` |
| `desktop-rich-change-review` | Optional (`--all`) | `1440x900` | `desktop-rich-change-review-modal` | Desktop `1440x900` Rich Change Review modal separating inline prose word additions (`'But maybe one day.'`) from `Formatting only` table pipe alignment |
| `phone-rich-change-review` | Optional (`--all`) | `390x844` | `phone-rich-change-review-modal` | Phone `390x844` stacked Rich Change Review sheet with file list, inline prose diff, formatting-only table card, and commit footer |

## End-to-End Capture Workflow

### 1. Primary Unattended Playwright Capture (`run`)

Run a complete review packet in a single command (no agent-in-the-loop step execution):

```bash
# Default 6 representative targets against http://127.0.0.1:8088
npm run capture -- run --packet review-run-01

# All 8 targets against the private Tailscale listener
npm run capture -- run --packet review-run-01 --all --base-url http://100.117.116.91:8088

# Specific subset of named states
npm run capture -- run --packet review-subset-01 --targets doc-initial-read,narrow-viewport
```

`run` performs the full pipeline and exits `0` **only** when every selected target passes readiness and `validateCapturePacket` succeeds:

1. Verifies `/healthz` and snapshots both the Cairn app Git revision and each content repository's Git `headSha`/dirty state (exiting `1` and recording a `live-server-probe` failure if unreachable).
2. Launches local headless Chromium with Chromium sandboxing explicitly enabled (`chromiumSandbox: true`) and creates an isolated `BrowserContext` per target (`width`, `height`, `deviceScaleFactor`, `colorScheme`, `reducedMotion`).
3. Navigates to each route, waits for app boot, executes the shared read-only UI steps (`CAIRN_APP_BOOT_CHECK_EXPRESSION` + `buildInPageStepAndReadinessExpression` in `scripts/captureLib.ts`), awaits `document.fonts.ready`, verifies visible `iframe.embed-sandbox-iframe` child frames (`contentFrame().waitForLoadState('load')`), and asserts `.save-badge.saved`.
4. Saves full-resolution PNGs (`animations: 'disabled'`), writes per-screen `.meta.json`, `packet.json`, and `SUMMARY.md`, and runs `validateCapturePacket`. Any missing state, failing selector, or partial packet exits `1`.

If Playwright's Chromium binary is not yet present in `.runtime/ms-playwright`:

```bash
PLAYWRIGHT_BROWSERS_PATH=/workspace/wiki-prototype/.runtime/ms-playwright npx playwright install chromium
```

### 2. Optional Interactive Embedded-Browser Inspection (`plan` + `openbot_browser` + `record`)

When an OpenBot agent wants to interactively inspect a live tab while reusing the exact same manifest steps:

```bash
npm run capture -- plan --packet inspect-01 --targets doc-initial-edit,review-thread-open
```

1. `openbot_browser.open` (`url`: `http://127.0.0.1:8088/`) -> obtain `tabId`.
2. `openbot_browser.set_environment` (`tabId`, `preset: "custom"`, `width`, `height`, `deviceScaleFactor`, `colorScheme: "light"`, `reducedMotion: true`).
3. `openbot_browser.run_script` (`tabId`, `finalSnapshot: false`, `script`: contents of `captures/packets/<packet-id>/scripts/<nn>-<target-id>.run-script.js`).
4. If `status === "ready"`, call `openbot_browser.screenshot` (`tabId`, `save: true`), close temporary tabs with `openbot_browser.close_tab`, then record and validate:

```bash
# Record a verified screenshot + browser readiness telemetry
npm run capture -- record \
  --packet inspect-01 \
  --target doc-initial-edit \
  --image /path/to/saved-screenshot.png \
  --telemetry '{"status":"ready","targetId":"doc-initial-edit","url":"http://127.0.0.1:8088/?project=cindervault-rpg&doc=docs%2Fvault-breach-action.md","elapsedMs":2400}'

# Record a structured failure if a target fails readiness assertions
npm run capture -- record-failure \
  --packet inspect-01 \
  --target embed-visible \
  --reason "Missing visible iframe.embed-sandbox-iframe"

# Validate PNG headers, pixel dimensions, SHA-256 hashes, sidecar metadata, and zero failures
npm run capture -- validate --packet inspect-01
```

## Importing External Competitor PNG References

Import user-supplied local PNG screenshots into `captures/competitors/` (and optionally attach them to a review packet's `references/` directory and `packet.json`) without fetching remote URLs or bypassing sign-ins:

Omit `--viewport` and `--date` when the original capture details are unknown. Both remain `null`; PNG pixel dimensions and the import timestamp are recorded separately. Do not infer a CSS viewport from image dimensions. This importer currently accepts PNG only; keep WebP/GIF originals separately until they are supported, and review animation as a sequence rather than a single still.

```bash
npm run capture -- import-reference \
  --image /path/to/competitor-screen.png \
  --product "GitBook" \
  --screen "doc-reader-comments" \
  --task "reading-and-inline-feedback" \
  --viewport "1440x900" \
  --source "User local capture (public docs)" \
  --date 2026-11-15 \
  --notes "Clean viewer default with right-rail comment popover" \
  --packet baseline-2026-11-15
```

## Packet Output Structure

Each packet in `captures/packets/<packet-id>/` is self-contained for independent ACP visual review:

- `packet.json` — Machine-readable packet manifest (capture timestamps, base URL, Cairn & content repo Git revisions, planned targets, per-screen readiness/viewport/hash records, failures, and imported competitor references).
- `SUMMARY.md` — Concise human/reviewer index table with honest current-state notes.
- `screens/<nn>-<target-id>.png` — Full-resolution viewport PNGs validated against `IHDR` dimensions.
- `screens/<nn>-<target-id>.meta.json` — Per-screenshot metadata sidecars.
- `references/<date>-<product>-<screen>.png` — Optional imported competitor reference PNGs.
- `scripts/<nn>-<target-id>.run-script.js` — Exact `openbot_browser.run_script` payloads used.

## Known Limitations

- **Local/private host scope only:** `npm run capture -- run` intentionally rejects public/external domains (`assertLocalCairnBaseUrl`) because Playwright is authorized strictly for local/private Cairn capture automation, not general browsing or authenticated third-party sites.
- **PNG-only reference importer:** `import-reference` validates and imports PNG files (`IHDR` + SHA-256); external WebP or animated GIF reference assets remain separate original files.
- **Viewport-focused targets:** All 6 manifest targets use `captureScope: "viewport"` (`1440x900` desktop and `768x960` narrow) with explicit container/window scroll offsets rather than stitched full-document captures, matching real reader/toolbar viewport proportions (`.sheet-scroll` scrolls internally in desktop mode).
