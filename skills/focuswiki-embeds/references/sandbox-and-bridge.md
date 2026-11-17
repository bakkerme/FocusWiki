# FocusWiki Embed Sandbox, CSP & Bridge Reference

## 1. Exact Runtime Isolation (`server/app.ts` + `EmbedBlockExtension.tsx`)

FocusWiki serves embed files from `/embed-sandbox/:projectId/<src>?rev=<token>&instance=<instanceId>` inside:

```html
<iframe sandbox="allow-scripts" src="/embed-sandbox/..."></iframe>
```

### Enforced HTTP Response Headers
```http
Content-Security-Policy:
  default-src 'none';
  script-src 'unsafe-inline' <origin>/embed-sandbox/<projectId>/;
  style-src 'unsafe-inline' <origin>/embed-sandbox/<projectId>/;
  img-src data: blob: <origin>/embed-sandbox/<projectId>/;
  font-src data: <origin>/embed-sandbox/<projectId>/;
  connect-src 'none';
  form-action 'none';
  base-uri 'none';
  frame-ancestors 'self'
```

### Practical Implications
- **Allowed:** Inline `<script>` and `<style>`, relative sibling files (`./logic.js`, `./styles.css`, `./chart.svg`, `../shared/icons.svg` as long as they stay inside `<repo>/` and use an allowed extension), `data:` / `blob:` images, `<canvas>`, inline `<svg>`, `ResizeObserver`, `requestAnimationFrame`.
- **Blocked by CSP (`connect-src 'none'`):** `fetch()`, `XMLHttpRequest`, `WebSocket`, `EventSource`, external scripts/fonts/stylesheets/images, and cross-project `/embed-sandbox/<other-project>/` assets. *(Note: if your widget needs static JSON data, import it via a sibling `.js`/`.mjs` module rather than calling `fetch('./data.json')`, because `connect-src 'none'` blocks `fetch()` even to same-directory URLs.)*
- **Blocked by `Origin: null` (`sandbox="allow-scripts"` without `allow-same-origin`):** `window.localStorage`, `window.sessionStorage`, `window.indexedDB`, `document.cookie`, `BroadcastChannel`, `navigator.serviceWorker`, and reading `window.parent.document`.

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
  *(`src` must start with `embeds/` and end with an allowlisted extension.)*

- **Read existing embed source:**
  `GET /api/projects/:projectId/embed-source?src=embeds/loot-curve/index.html`
