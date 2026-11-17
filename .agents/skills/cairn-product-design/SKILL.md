---
name: cairn-product-design
description: Design and review Cairn's documentation workspace, reading preferences, editing and feedback flows. Use for Cairn UI changes, not unrelated sites or branding work.
metadata:
  internal: true
---

# Cairn product design

Design a calm documentation tool whose identity comes from readable content and predictable controls. The user rejected the prototype's editorial serif typography and slate-tinted sidebar as dated. Prefer a contemporary system sans-serif stack for prose, headings and UI; reserve monospace for source and code. Use white or neutral surfaces without a tinted rail. Keep accent colour restrained and functional. Do not turn fictional document subject matter into application branding.

Use the project's supplied GitBook and Confluence examples to study hierarchy, navigation, reading and review tasks, rather than copy their styling. Keep page identity, navigation, authoring and feedback distinct. Avoid repeating file paths, project descriptions and status across those zones. Technical provenance belongs in details; save failures remain visible.

Reading is the default. Keep Edit and Review discoverable and adjacent; reveal formatting and embed arrangement only in authoring. Centre the constrained reading column in its available stage. Reading preferences offer a few explicit size and width presets, with immediate preview and a reset; they change presentation, never repository content. Keep fonts scalable and widths bounded by available space.

Preserve native document scrolling, scoped table/code overflow, modal drawer focus/scroll behaviour, session-aware Done/Revert and portable comments. Layout must remain usable in short landscape as well as narrow portrait. Do not solve density by shrinking touch targets or hiding errors. Keep comparison views inert: no executing embedded content while reviewing changes.

For a design pass, state the intended hierarchy and a small set of type/spacing/surface tokens, then implement using existing components where practical. Inspect live screenshots of reading, authoring, active feedback and the changed flow at desktop, phone portrait and short landscape. Check actual interaction and keyboard behaviour in addition to screenshots. Report evidence and remaining limits without inventing a visual score or claiming physical Safari validation from headless tests.
