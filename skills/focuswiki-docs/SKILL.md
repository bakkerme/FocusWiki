---
name: focuswiki-docs
description: "Write and edit Markdown pages in a FocusWiki repository, including attaching interactive HTML artefacts via `embed` fences. Use when creating or updating documentation `.md` files."
---

# FocusWiki Pages

FocusWiki documents are **standard GitHub-Flavored Markdown** files (`README.md`, `docs/**/*.md`) with one extension: you can attach self-contained interactive HTML artefacts stored in `embeds/`.

## Writing Markdown

- Write normal Markdown: headings (start pages with `# Title`), paragraphs, lists, task lists, blockquotes, fenced code blocks, links, and GFM tables.
- Link between pages with repo-relative paths, e.g. `[Cold-Start Runbook](docs/cold-start-runbook.md)`.
- Keep task lists uniform: put `[ ]` or `[x]` on every item in a task list rather than mixing checkboxes and plain bullets in the same list.
- Frontmatter and raw HTML blocks (such as `<details>...</details>`) are preserved as-is—leave existing ones intact when editing nearby prose.
- Do not place documentation `.md` files inside `embeds/` or hidden dot-directories (`.agents/`, `.claude/`, `.focuswiki/`), which FocusWiki ignores.

## Attaching an HTML Artefact (`embed` Fence)

Place any self-contained HTML artefact at `embeds/<name>/index.html` (use the `focuswiki-embeds` skill when building one) and attach it in Markdown with an `embed` code fence:

````markdown
```embed
src: embeds/power-sequencer/index.html
title: Rack Power & Boot Sequencer
height: 300
props: {"bay":"C-04","maxWatts":900}
```
````

- `src` *(required)*: Repo-relative path inside `embeds/`.
- `title` *(optional)*: Header label shown above the embedded frame.
- `height` *(optional)*: Fallback height in pixels (`>= 120`, default `420`) before the widget auto-sizes.
- `props` *(optional)*: **Single-line JSON object** passed to the widget on load (do not use multi-line YAML or multi-line JSON).

## Quick Check

After adding or editing `embed` blocks, widgets, or `.comments.json` files, you can verify everything offline from the repo root:

```bash
node <path-to-this-skill>/scripts/validate-wiki.mjs .
```
