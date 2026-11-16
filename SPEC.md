# Repository documentation hub prototype

## Goal and authorization

Build and run an end-to-end prototype for hands-on review. The user requests Docker packaging, rootless Docker setup on the Linux host, Anthropic's frontend-design skill, and populated sample documents. Updated execution decision (2026-11-15): the local OpenBot Builder agent, configured with Gemini 4 Carbon, owns implementation directly on aio; General owns requirements and independent review. T3 is no longer part of the build path. This is an implementation request: proceed through coding, meaningful tests, deployment, and a review handoff. Do not stop at a plan or static mockup.

The product is a private, self-hosted, free and open-source documentation hub over project-owned Markdown repositories. It combines comfortable visual writing, artifact-like executable embeds, and inline review. It must feel like a useful document workspace, not a landing page or a database-builder demo.

## Confirmed requirements

- One hub connects multiple projects. Each has its own document navigation, with search across projects.
- Each project has one explicitly selected local working copy. Display its checkout, current branch, and uncommitted status. No automatic merging of unrelated branches or worktrees.
- Markdown files remain authoritative and readable outside the app. Rich components have source and assets in the same project, referenced by a documented, stable embedding syntax.
- Humans edit prose visually and arrange/use components. Bots edit files or a documented API and insert/update components directly. No routine manual upload, copying, or separate URL management.
- Save both kinds of edits to the same working tree. Autosave drafts to files; Git commits happen only through explicit action. Do not automatically push. Show external file edits before commit or push.
- Preserve Markdown and embed references through visual editing. Preserve unknown/unsupported Markdown constructs verbatim or make their preservation explicit with an appropriate source block; never silently discard content.
- Protect concurrent editing with revision checks. Never silently overwrite an externally changed file. A recoverable conflict with both versions is acceptable; full realtime collaborative text editing is not required.
- Select prose to create an inline comment thread. Support replies, resolve, reopen, and retained history. Bots may perform all these operations, including resolution.
- Store comments and history in portable project-side files, not exclusively an app database. Use resilient anchors with selected text and surrounding context. If the passage moves, reattach only when unambiguous. Flag deleted/ambiguous anchors instead of attaching feedback to the wrong passage.
- Initial feedback targets prose only. Comments inside widgets and pixel annotations are not required.
- Custom interactive components are first-class reusable blocks. Support arbitrary project-authored browser components, not a hardcoded catalog of three demo widgets. Document how a bot adds a fourth component without changing hub application source.
- No shared relational database, visual behavior builder, monitoring collector, alerts, public publishing, or multi-person permission system is required for this prototype.

## Prototype scope and design

Reuse established open-source editor, Markdown parsing, and UI libraries. Choose a stack that can deliver reliable round trips and selection-based comments quickly. Briefly document alternatives and chosen tradeoffs in ARCHITECTURE.md; avoid lengthy architecture work before a functional slice.

Read .agents/skills/frontend-design/SKILL.md before implementing the UI. The official Anthropic skill is pinned at revision 1780c5e5a552fd4d1c9d6a7b0cab26b0c2bef064. Design a calm, document-focused workspace with a project/navigation sidebar, generous readable content area, and review margin/sidebar. Make the RPG content and interactive state flow the memorable part, with restrained chrome. Avoid fake marketing metrics, a dashboard of decorative cards, placeholder buttons, and controls that claim success without persisting anything. Include clear saving/saved/conflict states and useful errors. Keep essential keyboard controls, readable contrast, and a usable narrow-screen layout.

Use self-contained assets where practical. A component must not inherit arbitrary access to the hub's DOM or project filesystem. Use sandboxed execution and an explicit narrow messaging interface where needed. Serve only registered project directories; prevent path traversal and .git/private file exposure. This is a trusted-user prototype, but do not run arbitrary project code on the server merely to render a document. Restrict network exposure to loopback or the host's private Tailscale address; no public tunnel or router changes.

## Sample content

Seed two small Git repositories dedicated to this prototype, never modify the user's real RPG repo or lab records.

1. RPG design example: a substantial, readable design document explaining an example player action, model/engine/player responsibilities, state transitions, and consequences. Clearly label all rules and content as illustrative prototype data, not approved changes to the user's actual game.
2. Lab example: a small inventory/runbook document with fictional devices, relationships, and operational notes. No real credentials or private lab scan data.

The RPG document includes three distinct embedded components: a clickable state/transition explorer, a step-through scenario walkthrough, and an adjustable stat/difficulty outcome playground. They must respond to input. Make the mechanism generic and keep their source with the sample repository. Explain formulas and assumptions in the sample instead of pretending to simulate the real game engine. Seed at least one open comment and one resolved thread.

Provide project switching and real text search, visual prose editing with headings/lists/links, inline commenting, source/preview access, and external-file-update visibility. Demonstrate adding/reordering an embed while retaining its source reference. Include an explicit commit action or a clear documented Git workflow with no pretend commit button.

## Deployment

Target Linux host aio, reachable locally as 192.168.88.227 and on Tailscale as 100.117.116.91. Desired source directory is /workspace/wiki-prototype. The OpenBot process runs as openbot (uid 999); T3 on this host runs as ubuntu (uid 1000). /workspace/wiki-prototype has named access and default ACLs granting ubuntu read/write access; do not make it world writable. Respect ownership for persistent files and mounted sample repositories.

Work directly on this host. Do not resume the stopped T3 build or create an SSH orchestration loop. The project currently contains the specification, instructions, and design skill; inspect it for any additional work before starting.

Rootless Docker was reportedly installed and started under ubuntu by the previous build, after the user installed uidmap, rootlesskit, and slirp4netns. This is historical information, not current verification: inspect the existing installation and confirm Docker reports rootless security mode before claiming it works. Ubuntu has subordinate UID/GID ranges 100000:65536, linger enabled, and /run/user/1000. OpenBot runs as openbot (uid 999), without sudo rights or its own subordinate IDs/runtime. Respect account and daemon permissions; do not bypass them. Do not weaken AppArmor, read secrets, or substitute a rootful daemon. If account access prevents deployment, finish application implementation and tests first, and report the exact remaining privilege step. Do not stop the entire build merely because Docker account access is blocked.

Provide Dockerfile, compose.yaml, persistent project mounts, a health endpoint, sensible restart behavior, and reproducible build/start/stop commands. Bind the review server to a private interface on a free unprivileged port, suggested 8088 after checking availability. Do not expose or mount the Docker socket into the application. Leave the requested prototype running after verification when possible.

## Required validation

Run a production build and meaningful automated tests for the hard requirements. Verify a real browser user flow if browser tools are available; do not report screenshots or browser verification you did not actually perform.

Acceptance scenarios:
1. Open the sample RPG doc, operate all three widgets, visually change prose, and reload. Markdown files reflect the edit and components still function.
2. Edit the document and component source externally as a bot would. The app reflects saved changes before a commit or push.
3. Add a new component using only project files and documented syntax, without adding a new hub-specific widget type.
4. Select prose, comment, reply, resolve, reopen, and reload. Sidecar files retain thread history and status. Document equivalent bot operations.
5. Move the selected passage and retain its comment when unambiguous. Delete it and surface an orphan. Duplicate it and do not guess at an ambiguous anchor.
6. Change a file externally while a stale editor is open. Saving must preserve both versions and surface a conflict.
7. Round-trip representative headings, lists, links, code blocks, tables, and rich embed references without losing information. Test unsupported syntax preservation.
8. Restart the container and confirm docs, components, and comments persist. Demonstrate Git diff and a deliberate local commit; no push or external repository creation.
9. Verify registered-directory boundaries and rejection of path traversal. Review that widget execution is isolated.
10. Confirm rootless Docker mode if installed and the private review URL returns the actual populated app.

## Deliverables and handoff

Source, SPEC.md, ARCHITECTURE.md, README.md, Dockerfile, compose.yaml, example repositories and component source, meaningful tests, and REVIEW.md with a five-minute reviewer walkthrough. Include exact commands run, test outcomes, dependencies/licenses, known limitations, rootless Docker status, account owning the daemon, review URL, service lifetime, and stop/start instructions. Assistant-authored repository git commits during development must end with: Co-authored-by: OpenBot <335604065+openbotgit[bot]@users.noreply.github.com> (do not force assistant attribution onto user-authored commits inside the product).

Do not silently replace visual editing with a plain Markdown textarea, replace inline feedback with page-level notes, fake saving in localStorage, or finish with only a static frontend. If a hard requirement is infeasible in the chosen editor, document it and make the best working end-to-end slice, then report the gap explicitly for review.

## Post-prototype review direction (2026-11-15)

User feedback after hands-on review:
- Default to a polished viewer. Reading and inline feedback are the primary workflow; entering edit mode must be explicit. Review comments remain available without document editing.
- Embeds should size to their content, including after interactions and viewport changes, rather than leaving excessive fixed-height space. Preserve sandbox isolation.
- Markdown source needs a usable full document workspace, not a small textarea.
- Replace excessive text-label toolbars with appropriate consistent icons. Lucide React is already installed. Icon controls still need accessible names, visible focus, and discoverable tooltips; retain text where meaning would be unclear.
- Follow-up refinements (2026-11-16): center the constrained reading column horizontally in the available document stage when Review is closed; preserve untouched Markdown blocks (such as unedited GFM tables) verbatim during Visual editing; provide primary `Done` plus text-label `Revert` scoped to the edit-entry snapshot (preserving pre-existing uncommitted changes and checking disk revisions); replace raw-diff-only commit modals with a safe, document-centric Rich Change Review (keeping raw diff as a secondary view); and preserve user-authored commit messages/identities without forced OpenBot attribution.

Hold UI implementation until the design/review skill and automated review setup are selected. Current research recommendation (not yet adopted or installed): Impeccable for design direction and critique, Vercel Web Design Guidelines for code review, and repeatable browser workflow/layout/screenshot and axe accessibility checks. Research is not evidence that any candidate has been executed successfully in this project.
