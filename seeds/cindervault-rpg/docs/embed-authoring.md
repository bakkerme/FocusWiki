# Authoring Project Embeds

Interactive components in this documentation hub live directly inside the repository under `embeds/<component-name>/index.html` alongside any sibling `.js`, `.css`, or `.svg` assets. No hub source changes, build steps, or registry edits are needed to add a new widget.

## Markdown Embedding Syntax

Reference any project-owned HTML entrypoint using a fenced `embed` block:

````markdown
```embed
src: embeds/loot-curve/index.html
title: Relic Drop Curve Explorer
height: 300
props: {"depth":3,"luckBonus":1}
```
````

## Adding a Fourth Component (Human or Bot Workflow)

1. Create `embeds/<your-widget>/index.html` inside the project's working tree (on disk or via `POST /api/projects/:projectId/embeds`).
2. Add a fenced `embed` block pointing to `src: embeds/<your-widget>/index.html` in any `.md` document.
3. Optional: listen for `window.addEventListener('message', ...)` with `event.data.type === 'cairn:embed:init'` to read `event.data.props`, and post `{ type: 'cairn:embed:resize', height }` to auto-fit height.

## Sandbox Guarantees

Every embed renders inside `<iframe sandbox="allow-scripts">` (opaque `null` origin, without `allow-same-origin`) and a strict `Content-Security-Policy` (`connect-src 'none'`). Components can execute client-side interactive logic freely while having zero access to the parent workspace DOM, browser storage, network endpoints, or host filesystem outside their own project asset path.
