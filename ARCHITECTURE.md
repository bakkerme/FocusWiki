# Architecture & Tradeoffs

## 1. Stack Selection & Alternatives Considered

| Layer | Chosen Stack | Alternatives Considered | Why Chosen |
| :--- | :--- | :--- | :--- |
| Visual Editor | TipTap 2 (ProseMirror) + React 18 | Plain `<textarea>`, MDXEditor (Lexical), Milkdown | ProseMirror provides deterministic document positions for inline comment decorations, atomic custom NodeViews for live iframes, and full control over AST serialization. |
| Markdown Round-Trip | `unified` (`remark-parse`, `remark-gfm`, `remark-frontmatter`, `remark-stringify`) | `markdown-it` + `turndown` (HTML-intermediated) | HTML-intermediated pipelines lose GFM table alignment, frontmatter, footnotes, and custom fences. Direct `mdast <-> ProseMirror JSON` conversion preserves structure and slices unsupported syntax verbatim from byte offsets. |
| Backend & Watcher | Node.js 22 + Express 4 + `chokidar` + SSE (`/api/events`) | Next.js RSC / SQLite-backed wiki | Zero database dependency: Markdown and `.comments.json` sidecar files on disk remain authoritative, diffable in Git, and immediately responsive to external bot/CLI edits. |
| Typography & UI | System sans-serif (`ui-sans-serif` / `-apple-system`) + self-hosted `@fontsource/jetbrains-mono` + custom CSS tokens | Tailwind SaaS defaults / CDN Google Fonts / bundled editorial serif webfonts | Crisp neutral white/cobalt surfaces (`#ffffff` / `#fafafa` / `#1d4ed8`), no external font requests, and browser-local Reading settings (`focus:reading-preferences:v1`: `Small`/`Standard`/`Large` text size + `Narrow`/`Standard`/`Wide` page width clamped to stage width without mutating repo files). |

## 2. Authoritative Markdown & Lossless Preservation

Every document open/save cycle runs through `shared/markdownCodec.ts`:

1. **Supported visual constructs** (`#`–`######` headings, paragraphs, bold, italic, strikethrough, inline code, links, images with original source/alt/title, bullet/ordered/task lists, blockquotes, horizontal rules, fenced code blocks, and GFM tables with column alignment) map 1:1 between `mdast` and TipTap nodes.
2. **First-class embeds:** Any fenced code block with language `embed` (` ```embed `) parses into a draggable/reorderable `embedBlock` NodeView (`src`, `title`, `height`, `propsJson`) and serializes back to the identical fenced block. Malformed `embed` blocks fall back to `rawMarkdownBlock` rather than being dropped.
3. **Unsupported constructs (`rawMarkdownBlock` & `rawMarkdownInline`):** YAML/TOML frontmatter, raw HTML blocks (`<details>...</details>`), inline HTML (`<kbd>`), footnotes (`[^1]`), and unknown AST nodes are sliced directly from the source Markdown using `node.position.start.offset .. end.offset`. In visual mode they render as explicit *"Preserved Markdown construct"* blocks/pills and emit verbatim during serialization.

## 3. Generic Project-Authored Embed Sandbox

Components live inside each project repository under `embeds/<component-name>/index.html` alongside any sibling `.js`, `.css`, or `.svg` assets. Adding a fourth (or tenth) component requires zero changes to hub application source.

Isolation layers (`server/app.ts` + `src/editor/EmbedBlockExtension.tsx`):
- **Opaque origin iframe:** Rendered with `<iframe sandbox="allow-scripts">` (deliberately omitting `allow-same-origin`, `allow-top-navigation`, `allow-forms`, and `allow-popups`). Browser security policy assigns `Origin: null`, blocking access to `window.parent.document`, `localStorage`, cookies, and parent history.
- **Per-project CSP:** `/embed-sandbox/:projectId/*` serves static assets with `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline' <this-project-prefix>; style-src 'unsafe-inline' <this-project-prefix>; img-src data: blob: <this-project-prefix>; connect-src 'none'; frame-ancestors 'self'`. Widgets cannot `fetch()` `/api/*`, read other projects' assets, or make outbound network requests.
- **Narrow `postMessage` bridge:** Parent verifies `event.source === iframe.contentWindow` and accepts only bounded `focus:embed:ready`, `focus:embed:resize` (`120..1400px`), and `focus:embed:telemetry` status strings (plus legacy `cairn:embed:*` events), while passing initial JSON `props` via `focus:embed:init`.
- **No server code execution:** The hub never `import()`s or executes project code on Node.js.

## 4. Portable Anchored Comments & Resilient Reattachment

Comments for `<dir>/<name>.md` live in `<dir>/<name>.comments.json` inside the same repository working tree. Each thread records `status` (`open` | `resolved`), `messages`, full `history` (`created`, `replied`, `resolved`, `reopened`), and a text-quote anchor:

```json
{
  "quote": "the Ward-Seal fractures into unstable resonance",
  "prefix": "fails a Breach check on a 6 or lower, ",
  "suffix": ", adding +2 segments to the room clock",
  "headingContext": "Threshold Bands and Clock Rules"
}
```

Resolution rules (`shared/anchorResolver.ts`):
- **0 matches for `quote`:** Flagged `orphaned` and surfaced in the Review sidebar under *Unattached anchors* without guessing.
- **1 match for `quote` anywhere in prose:** Attached cleanly (`attached`), even if the sentence or section moved to another part of the document.
- **2+ matches for `quote`:** Disambiguated **only** when recorded within-block `prefix` + `suffix` is non-empty and matches strictly 1 candidate. If a paragraph/sentence was duplicated (`2+` context matches) or moved and duplicated (`0` context matches), the thread is flagged `ambiguous` rather than attached to an arbitrary occurrence.

## 5. Concurrency, Path Boundaries, and Git Safety

- **Optimistic revision checks:** `GET /doc` returns a 16-char SHA-256 `revision`. `PUT /doc` compares `baseRevision` against current disk content. On mismatch, the server refuses to overwrite disk, writes the stale editor buffer to `.focuswiki/conflicts/<doc>.<timestamp>.md`, and returns `409 Conflict` with both versions for side-by-side resolution.
- **Filesystem boundaries (`server/pathGuard.ts` & `server/projectRegistry.ts`):** Rejects unregistered project IDs, `..` traversal, symlink escapes (verified via `fs.realpathSync`), `.git` segments, `node_modules`, `.env*`, and key files. Repository enrollment and Git credentials are controlled by the operator on the server.
- **Managed Git and Rich Change Review.** Autosave writes to the local working copy with the existing document revision checks. `GitDrawerModal` renders Markdown, comment, embed, and code diffs as inert data, with a raw diff option. The managed backend attaches an opaque `reviewId` to `GET /api/projects/:projectId/git/diff`. Publishing sends that ID, the message, and an explicit nonempty list of reviewed paths to same-origin `POST /api/projects/:projectId/git/propose` with `X-FocusWiki-Intent: propose`. The backend validates the origin, review freshness, and file scope, and returns a pull request URL and commit SHA. A stale response invalidates the review in the browser. A transient failure retains the reviewed selection and message for retry. Upstream merge status is checked on the Git host.

## 6. Information Architecture, Responsive Tiers & Native Root Scrolling

1. **Four-Zone Information Architecture (Zero Duplicated Metadata):**
   - **Navigation (`SidebarNav`):** Owns repository switching, the operator enrollment explanation, cross-repository search, and page titles with open-comment counts. Stacked raw file paths and repetitive repository marketing paragraphs are omitted from nav rows (relative paths remain accessible via hover tooltips and search results).
   - **Document Eyebrow (`.doc-page-eyebrow`):** Renders `Project / docs/file.md` once right above `<h1>` inside the reading sheet, scrolling naturally away with prose instead of crowding the sticky top bar.
   - **Compact Sticky Header (`.repo-topbar`, `48px`):** Owns panel toggles (`Docs` when collapsed), compact Git status trigger showing local working-copy status and reported upstream divergence, and a non-wrapping `.primary-action-pair` (`Edit` + `Review` in Read mode; authoring `Saved locally`/`Saving…` badge + `Visual` / `Source` switch + `Done` in authoring modes). Routine `"Saved locally"` text is suppressed in clean `Read` mode while pending saves, errors, and `409` conflicts always remain visible.
   - **Review working changes (`GitDrawerModal`):** Shows checkout provenance, reported managed Git status, the reviewed file list, the explicit proposal action, and the resulting pull request link.
2. **Multi-Dimensional Responsive Panel Tiers (`src/App.tsx` + `src/styles/workspace.css`):**
   - **Overlay Drawer Tier (`(max-width: 1024px), (max-height: 540px)`):** Covers phones, portrait tablets, widths just above the former `880px` breakpoint, and short landscape viewports (`844x390`, `956x440`). Both `Docs` and `Review` collapse by default into mutually exclusive modal overlays (`role="dialog"`, `aria-modal="true"`, `<main inert>`, body scroll lock restoring exact `window.scrollY`, `Tab` focus trap, `Escape`/backdrop/close dismissal, `visualViewport` `--vvh` height, and `env(safe-area-inset-*)` padding).
   - **Medium Desktop Tier (`1025px..1319px`, height `>540px`):** Allows docked panels with `×` close controls, auto-yielding so at most one persistent sidebar stays docked beside prose at a time.
   - **Wide Desktop Tier (`>=1320px`, height `>540px`):** Docks `Docs` and `Review` with explicit `×` close buttons and header reopen buttons (`Docs` / `Review`) so desktop readers can also collapse either or both panels.
3. **Native Root Document Scrolling & Scoped Horizontal Overflow:**
   - **Read & Visual Editor modes** use native root `window` scrolling (`window.scrollY` advances; sticky header and sticky desktop sidebars anchor via CSS `position: sticky`) rather than a `100vh`/`100dvh` overflow-locked shell. Only full-workspace `Markdown source` mode and open modal overlay drawers bind viewport height internally.
   - **Scoped Horizontal Scroll:** TipTap tables render inside `.tableWrapper { overflow-x: auto }` (`Table.configure({ renderWrapper: true })`) alongside `<pre>` code blocks, while `.document-stage` enforces `overflow-x: clip` and `overflow-wrap: break-word` so wide tables (such as `helios-lab` `docs/bench-inventory.md`) scroll inside their own wrapper and never pan or clip main prose off the left viewport edge.

## 7. Image Nodes, Navigation, and Client Bundles

Images use TipTap's inline Image extension, allowing both image-only paragraphs and prose/table cells containing images. The codec also serializes block-shaped image JSON for interoperability. An image NodeView resolves repository paths only for its DOM `src`; editor JSON retains the Markdown source path. A shared resolver normalizes `.`/`..`, decodes escaped paths, and rejects attempts above the repository root, schemes, backslashes, and `.git` paths. Server filesystem and MIME guards remain authoritative and belong to the sibling backend implementation.

Heading IDs come from ProseMirror decorations rather than persisted attributes, so navigating a document never changes repository content. A per-document slugger tracks duplicates and suffix collisions. Relative `.md` links are resolved before navigation; fragments are applied after the target editor mounts. Same-document fragments use reduced-motion-aware `scrollIntoView`.

React, TipTap, ProseMirror, and the Markdown parser have explicit Rollup vendor chunks. TipTap stays on the latest published v2 (`2.27.3`) for extension compatibility, but that release remains covered by GHSA-cp6q-959q-f8rh. The requested zero-advisory audit is blocked by the absence of an upstream patched v2 release; do not interpret the version update as a security fix.
