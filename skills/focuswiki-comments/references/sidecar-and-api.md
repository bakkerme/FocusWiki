# FocusWiki `.comments.json` Schema & HTTP API Reference

## 1. Sidecar File Naming & JSON Schema (`version: 1`)

For any Markdown document `<dir>/<name>.md`, its sidecar path is `<dir>/<name>.comments.json` (`document` field always stores the repo-relative `.md` path with forward slashes):

```json
{
  "version": 1,
  "document": "docs/vault-breach-action.md",
  "threads": [
    {
      "id": "thr_9f3a1c2b8e04",
      "status": "open",
      "createdAt": "2026-11-16T10:00:00.000Z",
      "updatedAt": "2026-11-16T10:05:00.000Z",
      "anchor": {
        "quote": "each breach attempt caps committed Lantern Oil at two charges per action",
        "prefix": "To keep mid-delve tension predictable, ",
        "suffix": " regardless of pack capacity. Assisted",
        "headingContext": "Resource Caps and Assumptions"
      },
      "messages": [
        {
          "id": "msg_41d08a7c12ef",
          "author": "Audit Bot",
          "role": "bot",
          "createdAt": "2026-11-16T10:00:00.000Z",
          "body": "Confirmed cap matches engine constant MAX_BREACH_OIL = 2."
        }
      ],
      "history": [
        {
          "action": "created",
          "actor": "Audit Bot",
          "role": "bot",
          "at": "2026-11-16T10:00:00.000Z"
        }
      ]
    }
  ]
}
```

### Field Constraints
- `version`: Literal `1`.
- `document`: Repo-relative path to the `.md` file (e.g. `"docs/cold-start-runbook.md"` or `"README.md"`).
- `threads[].id`: Unique string ID per file (convention: `thr_<12-hex-chars>`).
- `threads[].status`: `"open"` or `"resolved"`.
- `threads[].anchor`:
  - `quote`: Required non-empty plain rendered prose substring within a block.
  - `prefix`: Up to `40` characters immediately preceding `quote` in the same block (`""` if at block start).
  - `suffix`: Up to `40` characters immediately following `quote` in the same block (`""` if at block end).
  - `headingContext` *(optional)*: Plain text of the nearest preceding Markdown heading.
- `threads[].messages[]`:
  - `id`: Unique string ID (convention: `msg_<12-hex-chars>`).
  - `author`: Non-empty display name.
  - `role`: `"human"` or `"bot"`.
  - `createdAt`: ISO-8601 UTC timestamp.
  - `body`: Non-empty comment text.
- `threads[].history[]`:
  - `action`: `"created"` | `"replied"` | `"resolved"` | `"reopened"`.
  - `actor`: Non-empty display name.
  - `role`: `"human"` or `"bot"`.
  - `at`: ISO-8601 UTC timestamp.
  - `note` *(optional)*: Short resolution/reopen reason string.

---

## 2. Resolving the Server URL & `:projectId`

1. **From a FocusWiki browser link:**
   `http://<host>:<port>/?project=<projectId>&doc=<docPath>`
   - `<origin>` = `http://<host>:<port>`
   - `<projectId>` = `project` query param
   - `path` = `doc` query param
2. **From `.focuswiki/config.json` (optional repo file) or env vars (`FOCUSWIKI_URL`, `FOCUSWIKI_PROJECT_ID`):**
   ```json
   {
     "url": "http://100.117.116.91:8088",
     "projectId": "cindervault-rpg"
   }
   ```
3. **Lookup `:projectId` via `/api/projects`:**
   ```bash
   curl -fsS "$FOCUSWIKI_URL/api/projects"
   ```
   Match the entry whose `rootPath` equals your checkout path or whose `git.remoteUrl` matches `git config --get remote.origin.url` (and check `git.branch` so you don't comment on a different checked-out branch).

---

## 3. HTTP REST Endpoints (`server/app.ts`)

### List Resolved Threads for a Document
```bash
curl -fsS "http://127.0.0.1:8088/api/projects/cindervault-rpg/comments?path=docs/vault-breach-action.md"
```
Returns `{ "document": "...", "threads": [ ... ] }` where each thread includes computed `anchorStatus` (`"attached"` | `"orphaned"` | `"ambiguous"`).

### Create a New Bot Comment Thread
When `quote` uniquely matches a single prose block, FocusWiki automatically populates `prefix`, `suffix`, and `headingContext`:

```bash
curl -fsS -X POST "http://127.0.0.1:8088/api/projects/cindervault-rpg/comments" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "docs/vault-breach-action.md",
    "quote": "each breach attempt caps committed Lantern Oil at two charges per action",
    "author": "Audit Bot",
    "role": "bot",
    "body": "Confirmed cap matches MAX_BREACH_OIL = 2 in the resolution engine."
  }'
```
*(If `quote` appears multiple times in the document, pass `"anchor": { "quote": "...", "prefix": "...", "suffix": "...", "headingContext": "..." }` explicitly.)*

### Reply to an Existing Thread
```bash
curl -fsS -X POST "http://127.0.0.1:8088/api/projects/cindervault-rpg/comments/thr_seed_open_01/replies" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "docs/vault-breach-action.md",
    "author": "Audit Bot",
    "role": "bot",
    "body": "Updated section 2.4 to clarify bolt-jam ordering before clock overflow."
  }'
```

### Resolve or Reopen a Thread
```bash
curl -fsS -X POST "http://127.0.0.1:8088/api/projects/cindervault-rpg/comments/thr_seed_open_01/status" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "docs/vault-breach-action.md",
    "status": "resolved",
    "actor": "Audit Bot",
    "role": "bot",
    "note": "Clarified ordering in Threshold Bands section."
  }'
```
