# Architecture & Tradeoffs

## 1. Stack Selection & Alternatives Considered

| Layer | Chosen Stack | Alternatives Considered | Why Chosen |
| :--- | :--- | :--- | :--- |
| Visual Editor | TipTap 2 (ProseMirror) + React 18 | Plain `<textarea>`, MDXEditor (Lexical), Milkdown | ProseMirror provides deterministic document positions for inline comment decorations, atomic custom NodeViews for live iframes, and full control over AST serialization. |
| Markdown Round-Trip | `unified` (`remark-parse`, `remark-gfm`, `remark-frontmatter`, `remark-stringify`) | `markdown-it` + `turndown` (HTML-intermediated) | HTML-intermediated pipelines lose GFM table alignment, frontmatter, footnotes, and custom fences. Direct `mdast <-> ProseMirror JSON` conversion preserves structure and slices unsupported syntax verbatim from byte offsets. |
| Backend & Watcher | Node.js 22 + Express 4 + nonrecursive filesystem watches + SSE (`/api/events`) | Next.js RSC / SQLite-backed wiki | Zero database dependency: Markdown and `.comments.json` sidecar files on disk remain authoritative, diffable in Git, and immediately responsive to external bot/CLI edits. |
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
- **Response sandbox and CSP:** Embed responses use `sandbox allow-scripts`, including on direct navigation. The CSP limits scripts, styles, images, and fonts to the current project's scoped `embeds/` URLs, plus the allowed inline and data sources. `connect-src 'none'` blocks Fetch, XHR, and WebSockets. Iframe self-navigation and network behavior depend on browser policy.
- **Scoped subresource URLs:** The stable HTML URL redirects to an unguessable project-specific path, which becomes the base URL for relative assets. Scoped assets can return `Access-Control-Allow-Origin: null` for opaque-origin modules and fonts. Stable URLs expose no CORS permission. The scoped path changes on server restart. Use the stable URL to reopen the embed.
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
- **Filesystem boundaries (`server/pathGuard.ts` & `server/projectRegistry.ts`):** File APIs reject unregistered projects, project-root escapes, symlinked components, and protected paths. Embed discovery and file APIs share the normalized `embeds/` boundary. Conflict listing skips redirected metadata directories and only lists regular drafts. Path checks assume local filesystem writers cannot swap path components concurrently with an API operation. Repository registration validates local imports against `FOCUSWIKI_ALLOWED_IMPORT_ROOTS`, prevents duplicate realpaths/slugs, atomically updates `config/projects.json`, and dynamically attaches/detaches file watchers.
- **Repository discovery and live updates.** Browse, local inspection, and search read current files through bounded asynchronous traversal. Linux directory descriptors anchor lookups under the registered root and prevent following symlink entries. The scanner and watcher require `/proc/self/fd`, available in the Linux container. Project listings return up to 24 summaries per page. Each project scan visits up to 4,000 entries and 400 Markdown files, with a 4 MiB read budget and 16 levels of descent. A listing page shares a 12,000-entry, 1,200-file, 12 MiB budget and a two-second scan deadline. Results are marked when discovery or metadata is incomplete. Live updates attach nonrecursive watches to at most 128 directories per project and 32 projects per hub. The sidebar reports limited watch coverage. Reloading starts a fresh scan.
- **Change review.** Rich Markdown review caps input and shares one matrix budget across block, table, word, and fenced code comparisons. When structural alignment reaches its limits, the drawer directs users to the raw diff. Word-only limits retain block review and show whole text replacements. The working-tree review accepts up to 48 changes, 8 MiB of file inputs, and 4 MiB of raw patches within an eight-second deadline. Larger working trees can be reviewed and committed with local Git.
- **Managed Git:** The web process talks to a separate, fixed-verb Unix-socket worker. The worker resolves paths and a GitHub HTTPS repository from operator enrollment and owns Git metadata and network authorization. Fetch updates the remote-tracking ref; the shared draft and its base stay in place. Review and publication require the proposal service and verified web authorization. See [managed Git](docs/MANAGED-GIT.md).

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
