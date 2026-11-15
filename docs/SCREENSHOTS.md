# Cairn Screenshot Capture & Visual Review Packets

Repeatable, manifest-driven screenshot workflow for generating visual review packets of Cairn (`http://127.0.0.1:8088` or `http://100.117.116.91:8088`) and importing user-provided competitor reference screenshots.

## Design & Safety Invariants

- **Read-only UI staging:** Named states navigate via URL query params (`?project=...&doc=...`), switch view modes, toggle review history, and scroll containers without editing prose or writing to `.comments.json`. Every target asserts `.save-badge.saved`.
- **Preserves user working trees:** Never resets or re-seeds `/workspace/wiki-prototype/sample-repos/*`. When a clean seeded baseline is explicitly needed, `npm run capture -- isolated-fixture --port 8089` serves fresh temporary copies in `/tmp` bound only to `127.0.0.1`.
- **Honest state labels:** Current app states are labeled as they actually behave today (for example `visual-edit-default` because Cairn currently opens directly in TipTap edit mode rather than a viewer-first mode).
- **OpenBot embedded browser boundary:** Browser automation runs through OpenBot's MCP embedded browser (`openbot_browser`) rather than installing or invoking an unauthorized Playwright/Puppeteer/Chromium binary.

## Named States (`config/capture-manifest.json`)

List selectable targets:

```bash
npm run capture -- list
```

| Target ID | Default | Viewport | Actual App State | What It Captures |
| :--- | :--- | :--- | :--- | :--- |
| `doc-initial-edit` | Yes | `1440x900` | `visual-edit-default` | Initial load in current TipTap visual edit mode with text-label toolbar, repo sidebar, prose/table, and open review margin |
| `source-editing` | Yes | `1440x900` | `markdown-source-textarea` | Header `Markdown source` toggle showing the current centered `78ch` `<textarea>` inside `.sheet-scroll` |
| `review-thread-open` | Yes | `1440x900` | `visual-edit-review-thread-open` | Active inline comment thread, expanded thread history log, resolved thread comparison, and ochre prose anchor highlights |
| `embed-visible` | Yes | `1440x900` | `visual-edit-embed-visible` | Scrolled to the sandboxed `state-explorer` iframe (`sandbox="allow-scripts"`) showing embed header chrome and iframe height framing |
| `narrow-viewport` | Yes | `768x960` | `narrow-single-column-visual-edit` | Single-column `<=880px` layout showing stacked sidebar transition, wrapping toolbar buttons, and narrow prose legibility |
| `helios-lab-embed` | Optional (`--all`) | `1440x900` | `visual-edit-second-project-embed` | `helios-lab` inventory doc with synthetic RFC 5737 table, `power-sequencer` embed, and open review thread |

## End-to-End Capture Workflow

### 1. Plan a Packet (Preflight + Per-Target Browser Scripts)

```bash
# Default 5 representative targets
npm run capture -- plan --packet review-run-01

# Specific subset or all targets (optionally against private Tailscale URL)
npm run capture -- plan --packet review-run-01 --targets doc-initial-edit,review-thread-open,narrow-viewport
npm run capture -- plan --packet review-run-01 --all --base-url http://100.117.116.91:8088
```

`plan` verifies `/healthz`, snapshots both the Cairn app Git revision and each content repository's Git `headSha`/dirty status, and writes ready-to-run `openbot_browser.run_script` files under `captures/packets/<packet-id>/scripts/`.

### 2. Drive OpenBot Embedded Browser & Save Viewport PNGs

For each planned target in `captures/packets/<packet-id>/packet.json`, an OpenBot agent executes:

1. `openbot_browser.open` (`url`: `http://127.0.0.1:8088/`) -> obtain `tabId`.
2. `openbot_browser.set_environment` (`tabId`, `preset: "custom"`, `width`, `height`, `deviceScaleFactor`, `colorScheme: "light"`, `reducedMotion: true`).
3. `openbot_browser.run_script` (`tabId`, `finalSnapshot: false`, `script`: contents of `captures/packets/<packet-id>/scripts/<nn>-<target-id>.run-script.js`).
   - Waits for app boot, applies read-only UI steps, awaits `document.fonts.ready`, checks required visible selectors and visible embed bounds with bounded timeouts (no unbounded sleeps), and returns structured JSON telemetry (`status: "ready" | "failed"`).
4. If `status === "ready"`, call `openbot_browser.screenshot` (`tabId`, `save: true`) to write the viewport PNG, then close temporary tabs with `openbot_browser.close_tab`.

### 3. Record Captures (or Failures) & Validate Packet

```bash
# Record a verified screenshot + browser readiness telemetry
npm run capture -- record \
  --packet review-run-01 \
  --target doc-initial-edit \
  --image /path/to/saved-screenshot.png \
  --telemetry '{"status":"ready","targetId":"doc-initial-edit","url":"http://127.0.0.1:8088/?project=cindervault-rpg&doc=docs%2Fvault-breach-action.md","elapsedMs":2400}'

# Record a structured failure if a target fails readiness assertions
npm run capture -- record-failure \
  --packet review-run-01 \
  --target embed-visible \
  --reason "Missing visible iframe.embed-sandbox-iframe"

# Validate PNG headers, pixel dimensions, SHA-256 hashes, sidecar metadata, and zero failures
npm run capture -- validate --packet review-run-01
```

## Importing External Competitor PNG References

Import user-supplied local PNG screenshots into `captures/competitors/` (and optionally attach them to a review packet's `references/` directory and `packet.json`) without fetching remote URLs or bypassing sign-ins:

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

- **Single-command shell browser execution:** Because OpenBot browser rules prohibit introducing Playwright, Puppeteer, or headless Chromium without explicit user authorization, `npm run capture -- run` generates the packet plan and exits with code `2` instructing the caller to run the generated scripts via `openbot_browser` MCP tools. If the user later authorizes a standalone Playwright driver, `scripts/capture.ts` `run` can execute those same `scripts/*.run-script.js` steps directly from bash.
- **Viewport vs full-page:** `openbot_browser.screenshot` captures the visible viewport (or a specific element ref), which is preferred for judging real reading/toolbar legibility at `1440x900` and `768x960`; stitched full-page scroll captures are not enabled.
