---
name: focuswiki-embeds
description: "Build self-contained interactive HTML/JS/CSS/SVG artefacts in `embeds/` for FocusWiki documents. Use when creating or modifying embedded widgets, calculators, diagrams, or playgrounds."
---

# FocusWiki HTML Artefacts (`embeds/`)

Each interactive artefact is a self-contained HTML page at `embeds/<widget-name>/index.html` (plus optional sibling `.js`, `.css`, `.svg`, or image files). No build step or FocusWiki configuration is needed—drop the file in `embeds/` and reference it from Markdown with an ` ```embed ` block (see `focuswiki-docs`).

Start by copying [assets/embed-starter.html](assets/embed-starter.html), which already wires up light/dark styling, `props`, auto-height, and status telemetry.

## Sandbox Rules (Must Follow)

FocusWiki renders artefacts inside `<iframe sandbox="allow-scripts">` (`Origin: null`) with `Content-Security-Policy: default-src 'none'; connect-src 'none'`:

1. **No storage or cookies:** Never touch `localStorage`, `sessionStorage`, `indexedDB`, or `document.cookie`—browsers throw a `SecurityError` in an opaque-origin iframe. Keep state in memory and read initial values from `props`.
2. **No network or CDNs:** External `<script>`/`<link>` URLs, Google Fonts, `fetch()`, and `WebSocket` are blocked by CSP. Inline your JS/CSS/SVG or load sibling files from `embeds/<widget-name>/` (allowed extensions: `.html`, `.js`, `.mjs`, `.css`, `.svg`, `.json`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.woff`, `.woff2`, `.txt`).
3. **Auto-fit height (`html { height: auto }`):** Avoid `100vh`/`100dvh` on `html` or `body` and use `<button type="button">` instead of `<form>` submit.
4. **Support light & dark mode:** Include `<meta name="color-scheme" content="light dark" />` and `@media (prefers-color-scheme: dark)` CSS variables (already set up in [assets/embed-starter.html](assets/embed-starter.html)).

## Optional `postMessage` Bridge

- **Read `props`:** Listen for `window.addEventListener('message', ...)` where `event.data?.type === 'focus:embed:init'` (or `'cairn:embed:init'`) to receive `{ instanceId, props }`.
- **Auto-resize:** Post `{ type: 'focus:embed:ready', instanceId, height }` on load and `{ type: 'focus:embed:resize', instanceId, height }` from a `ResizeObserver` on `document.body`.
- **Footer status:** Post `{ type: 'focus:embed:telemetry', instanceId, summary: 'Short status (<= 140 chars)' }` to update the frame footer.

See [references/sandbox-and-bridge.md](references/sandbox-and-bridge.md) for full CSP headers, payload details, and HTTP upload endpoints.
