---
name: focuswiki-comments
description: "Read, create, reply to, resolve, and reopen inline prose review comments in FocusWiki `.comments.json` sidecar files or via a FocusWiki server URL. Use when reviewing docs, answering inline review threads, or managing `.comments.json` files."
---

# FocusWiki Inline Review Comments

Comments for `<dir>/<name>.md` live in a sibling `<dir>/<name>.comments.json` file tracked in Git. Agents should set `"role": "bot"` and a clear author name (e.g. `"Spec Review Bot"`).

## 1. Local File vs. HTTP API (and How to Find the Server URL)

- **Default in a local checkout / branch / worktree — edit `<doc>.comments.json` on disk:**
  When you are working inside a cloned repository, read and edit `<doc>.comments.json` directly. No server URL is needed, your comments stay on the exact Git branch/worktree you are editing, and any FocusWiki instance watching that checkout picks up the file change automatically.

- **Using the HTTP API (when given a live FocusWiki server or running without a checkout):**
  Note that API calls write to *the server's* checked-out working tree. Resolve `<origin>` and `<projectId>` in this order:
  1. **From a pasted FocusWiki browser URL:** Browser links look like `http://100.117.116.91:8088/?project=cindervault-rpg&doc=docs/vault-breach-action.md` — take `<origin>` (`http://100.117.116.91:8088`), `project` (`cindervault-rpg`), and `doc` directly from the URL query string.
  2. **From repo or environment config:** Check `FOCUSWIKI_URL` (and optional `FOCUSWIKI_PROJECT_ID`) in the environment, or read `.focuswiki/config.json` (`{"url": "http://...", "projectId": "..."}`) if committed in the repo.
  3. **Auto-discovering `:projectId` from `<origin>`:** Once you have `<origin>` (or if checking a local server at `http://127.0.0.1:8088` / `8089` via `GET /healthz`), call `GET <origin>/api/projects` and match `rootPath` to `pwd` or `git.remoteUrl` to `git config --get remote.origin.url`.
  4. **If no URL is given or configured:** Do not guess ports or hosts—edit `<doc>.comments.json` on disk (or ask the user for their FocusWiki URL if you don't have the repo checked out).

## 2. Anchoring Rules (When Editing `.comments.json` Directly)

FocusWiki attaches each thread using `{ quote, prefix, suffix, headingContext }` against **rendered prose text** (headings, paragraphs, list items, blockquotes, table cells—not code blocks or `embed` blocks):

1. **Strip Markdown formatting from `quote`, `prefix`, and `suffix`:**
   Match the plain rendered text without `` `backticks` ``, `**bold**`, `*italic*`, or `[link](url)` syntax:
   - Markdown: ``fails a check on a `6` or lower, **Ward Resonance** advances``
   - Valid `quote`: `"fails a check on a 6 or lower, Ward Resonance advances"`
2. **Keep `quote` unambiguous:** Pick a distinctive 6–20 word phrase from a single paragraph. Record `prefix` and `suffix` (`~30–40` plain-text characters immediately before/after `quote` in the same paragraph) plus `headingContext` so FocusWiki can disambiguate repeated phrases instead of marking the thread `ambiguous`.
3. **Preserve history:** Never delete resolved threads or prior messages. Resolving sets `"status": "resolved"`, updates `"updatedAt"`, and appends `{"action": "resolved", "actor": "...", "role": "bot", "at": "..."}` to `history`.

See [references/sidecar-and-api.md](references/sidecar-and-api.md) for the `.comments.json` JSON schema and `curl` examples, and run `focuswiki-docs/scripts/validate-wiki.mjs .` to verify anchors match the document.
