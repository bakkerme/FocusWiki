# FocusWiki Embed Sandbox, CSP & Bridge Reference

## 1. Exact Runtime Isolation (`server/app.ts` + `EmbedBlockExtension.tsx`)

FocusWiki opens `/embed-sandbox/:projectId/<src>?rev=<token>&instance=<instanceId>` inside:

```html
<iframe sandbox="allow-scripts" src="/embed-sandbox/..."></iframe>
```

The HTML response redirects to a server-issued, project-scoped asset URL. Use relative paths for modules and other assets so they resolve from that URL. Only the scoped asset endpoint grants CORS to opaque origins, and its URLs change after a server restart.

### Enforced HTTP Response Headers
```http
Content-Security-Policy:
  sandbox allow-scripts;
  default-src 'none';
  script-src 'unsafe-inline' <scoped-embeds-prefix>;
  style-src 'unsafe-inline' <scoped-embeds-prefix>;
  img-src data: blob: <scoped-embeds-prefix>;
  font-src data: <scoped-embeds-prefix>;
  connect-src 'none';
  form-action 'none';
  base-uri 'none';
  frame-ancestors 'self'
```

### Practical Implications
- **Allowed:** Inline `<script>` and `<style>`, relative sibling files (`./logic.js`, `./logic.mjs`, `./styles.css`, `./chart.svg`, `../shared/icons.svg` when they stay inside `<repo>/embeds/` and use an allowed extension), `data:` / `blob:` images, `<canvas>`, inline `<svg>`, `ResizeObserver`, `requestAnimationFrame`.
- **Blocked by CSP (`connect-src 'none'`):** `fetch()`, `XMLHttpRequest`, `WebSocket`, `EventSource`, external scripts/fonts/stylesheets/images, and cross-project `/embed-sandbox/<other-project>/` assets. *(Note: if your widget needs static JSON data, import it via a sibling `.js`/`.mjs` module rather than calling `fetch('./data.json')`, because `connect-src 'none'` blocks `fetch()` even to same-directory URLs.)*
- **Blocked by the opaque origin:** `window.localStorage`, `window.sessionStorage`, `window.indexedDB`, `document.cookie`, `BroadcastChannel`, `navigator.serviceWorker`, and reading the host document from the iframe. The embed response applies the same opaque-origin restriction to direct navigation.

## 2. `postMessage` Protocol Payloads

FocusWiki verifies `event.source === iframe.contentWindow` and matches `instanceId` when provided. Both `focus:embed:*` (current) and `cairn:embed:*` (legacy alias) are accepted.

### Parent -> Embed (`focus:embed:init`)
Sent once on iframe `load` and again whenever the embed posts `focus:embed:ready`:

```json
{
  "type": "focus:embed:init",
  "instanceId": "emb-k8x29p1q",
  "props": { "defaultLoad": 75, "baseLatencyMs": 40 }
}
```

### Embed -> Parent
| `type` | Fields | Behavior in FocusWiki |
| :--- | :--- | :--- |
| `focus:embed:ready` | `instanceId?: string`, `height?: number` | Switches frame sizing to `auto`, clamps `height + 2` to `[110, 1100]` px (when `height >= 60`), and triggers a fresh `focus:embed:init` with parsed `props`. |
| `focus:embed:resize` | `instanceId?: string`, `height: number` | Updates iframe height dynamically (`clamp(ceil(height + 2), 110, 1100)` px). |
| `focus:embed:telemetry` | `instanceId?: string`, `summary: string` | Displays `summary.slice(0, 140)` in the embed card's footer status bar. |

### Fallback Sizing (When No `ready`/`resize` Arrives)
If an embed does not post a valid numeric `height >= 60` within `260ms` of `onload`, FocusWiki enters `fallback` sizing mode using the `height` attribute from the Markdown ` ```embed ` fence (clamped to `160..560` px, with an expand toggle in the frame header).

## 3. Creating or Inspecting Embeds via HTTP API

When editing over HTTP instead of direct disk access:

- **Create or overwrite an embed file:**
  `POST /api/projects/:projectId/embeds`
  ```json
  {
    "src": "embeds/loot-curve/index.html",
    "source": "<!DOCTYPE html>..."
  }
  ```
  *(`src` must resolve below the project's `embeds/` directory to a regular file with an allowlisted extension. Symlinked files and directories are rejected.)*

- **Read existing embed source:**
  `GET /api/projects/:projectId/embed-source?src=embeds/loot-curve/index.html`
