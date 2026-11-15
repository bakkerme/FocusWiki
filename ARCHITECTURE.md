# Architecture & Tradeoffs

## 1. Stack Selection & Alternatives Considered

| Layer | Chosen Stack | Alternatives Considered | Why Chosen |
| :--- | :--- | :--- | :--- |
| Visual Editor | TipTap 2 (ProseMirror) + React 18 | Plain `<textarea>`, MDXEditor (Lexical), Milkdown | ProseMirror provides deterministic document positions for inline comment decorations, atomic custom NodeViews for live iframes, and full control over AST serialization. |
| Markdown Round-Trip | `unified` (`remark-parse`, `remark-gfm`, `remark-frontmatter`, `remark-stringify`) | `markdown-it` + `turndown` (HTML-intermediated) | HTML-intermediated pipelines lose GFM table alignment, frontmatter, footnotes, and custom fences. Direct `mdast <-> ProseMirror JSON` conversion preserves structure and slices unsupported syntax verbatim from byte offsets. |
| Backend & Watcher | Node.js 22 + Express 4 + `chokidar` + SSE (`/api/events`) | Next.js RSC / SQLite-backed wiki | Zero database dependency: Markdown and `.comments.json` sidecar files on disk remain authoritative, diffable in Git, and immediately responsive to external bot/CLI edits. |
| Typography & UI | Self-hosted `@fontsource` (`Literata`, `Plus Jakarta Sans`, `JetBrains Mono`) + custom CSS tokens | Tailwind SaaS defaults / CDN Google Fonts | Self-contained offline WOFF2 assets with zero external network calls; calm mineral-vellum (`#F2F4F3` / `#FAFBF9`) and verdigris (`#1B6B63`) palette tailored for long technical reading. |

## 2. Authoritative Markdown & Lossless Preservation

Every document open/save cycle runs through `shared/markdownCodec.ts`:

1. **Supported visual constructs** (`#`–`######` headings, paragraphs, bold, italic, strikethrough, inline code, links, bullet/ordered/task lists, blockquotes, horizontal rules, fenced code blocks, and GFM tables with column alignment) map 1:1 between `mdast` and TipTap nodes.
2. **First-class embeds:** Any fenced code block with language `embed` (` ```embed `) parses into a draggable/reorderable `embedBlock` NodeView (`src`, `title`, `height`, `propsJson`) and serializes back to the identical fenced block. Malformed `embed` blocks fall back to `rawMarkdownBlock` rather than being dropped.
3. **Unsupported constructs (`rawMarkdownBlock` & `rawMarkdownInline`):** YAML/TOML frontmatter, raw HTML blocks (`<details>...</details>`), inline HTML (`<kbd>`), footnotes (`[^1]`), and unknown AST nodes are sliced directly from the source Markdown using `node.position.start.offset .. end.offset`. In visual mode they render as explicit *"Preserved Markdown construct"* blocks/pills and emit verbatim during serialization.

## 3. Generic Project-Authored Embed Sandbox

Components live inside each project repository under `embeds/<component-name>/index.html` alongside any sibling `.js`, `.css`, or `.svg` assets. Adding a fourth (or tenth) component requires zero changes to hub application source.

Isolation layers (`server/app.ts` + `src/editor/EmbedBlockExtension.tsx`):
- **Opaque origin iframe:** Rendered with `<iframe sandbox="allow-scripts">` (deliberately omitting `allow-same-origin`, `allow-top-navigation`, `allow-forms`, and `allow-popups`). Browser security policy assigns `Origin: null`, blocking access to `window.parent.document`, `localStorage`, cookies, and parent history.
- **Per-project CSP:** `/embed-sandbox/:projectId/*` serves static assets with `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline' <this-project-prefix>; style-src 'unsafe-inline' <this-project-prefix>; img-src data: blob: <this-project-prefix>; connect-src 'none'; frame-ancestors 'self'`. Widgets cannot `fetch()` `/api/*`, read other projects' assets, or make outbound network requests.
- **Narrow `postMessage` bridge:** Parent verifies `event.source === iframe.contentWindow` and accepts only bounded `cairn:embed:ready`, `cairn:embed:resize` (`120..1400px`), and `cairn:embed:telemetry` status strings, while passing initial JSON `props` via `cairn:embed:init`.
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

- **Optimistic revision checks:** `GET /doc` returns a 16-char SHA-256 `revision`. `PUT /doc` compares `baseRevision` against current disk content. On mismatch, the server refuses to overwrite disk, writes the stale editor buffer to `.cairn/conflicts/<doc>.<timestamp>.md`, and returns `409 Conflict` with both versions for side-by-side resolution.
- **Filesystem boundaries (`server/pathGuard.ts`):** Rejects unregistered project IDs, `..` traversal, symlink escapes (verified via `fs.realpathSync`), `.git` segments, `node_modules`, `.env*`, and key files.
- **Explicit Git workflow (`server/gitService.ts`):** Autosaves mutate only the local working tree. Commits occur exclusively when triggered through `POST /api/projects/:id/git/commit` (using `execFile('git', ...)` without shell interpolation, appending the required OpenBot `Co-authored-by` trailer), and never run `git push`.
