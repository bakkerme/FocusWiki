import { describe, expect, it } from 'vitest';
import { markdownToProseMirror, proseMirrorToMarkdown } from '../shared/markdownCodec.js';

describe('markdownCodec round-trip and preservation (Scenario 7)', () => {
  it('round-trips headings, formatted prose, lists, task lists, code blocks, tables, and embeds cleanly', () => {
    const original = `---
title: Vault Breach Spec
status: draft
---

# Vault Breach Resolution

Read the [Consequence Ledger](docs/consequence-ledger.md "Ledger") before adjusting **ward tiers** or *lantern stakes*, and never bypass \`resolveCheck()\`.

- Declare intent with **rigging kit**
- Lock spent charges
  - 0 charges: baseline check
  - 2 charges: reinforced leverage

1. Validate doorway state
2. Compute modifier sum
3. Apply consequence clock

- [x] Draft state machine transitions
- [ ] Calibrate Tier IV backlash

\`\`\`embed
src: embeds/state-explorer/index.html
title: Ward-Breach State Explorer
height: 440
props: {"initialState":"declare_intent","tier":2}
\`\`\`

| Actor | Phase | Responsibility |
| :--- | :---: | ---: |
| Player | Intent | Choose approach and charges |
| Engine | Check | Sum \`2d6\` and modifiers |
| GM Model | Consequence | Advance resonance clock |

\`\`\`ts
export function computeBreachTotal(dice: [number, number], stat: number): number {
  return dice[0] + dice[1] + stat;
}
\`\`\`

<details>
<summary>Archived Tabletop Designer Note</summary>
Early playtests tried d20 flat rolls; 2d6 bell curves kept mid-tier partial breaches memorable.
</details>

Press <kbd>Alt+C</kbd> to comment on a selected clause[^design-note].

[^design-note]: Preserved footnote definition for external Markdown readers.
`;

    const pmDoc = markdownToProseMirror(original);
    const embedNodes = (pmDoc.content ?? []).filter((n) => n.type === 'embedBlock');
    expect(embedNodes).toHaveLength(1);
    expect(embedNodes[0].attrs).toMatchObject({
      src: 'embeds/state-explorer/index.html',
      title: 'Ward-Breach State Explorer',
      height: 440,
      propsJson: '{"initialState":"declare_intent","tier":2}'
    });

    // Frontmatter, <details> block, and footnote definition should be preserved explicitly as rawMarkdownBlock
    const rawBlocks = (pmDoc.content ?? []).filter((n) => n.type === 'rawMarkdownBlock');
    expect(rawBlocks.length).toBeGreaterThanOrEqual(3);

    const roundTripped = proseMirrorToMarkdown(pmDoc);

    expect(roundTripped).toContain('title: Vault Breach Spec');
    expect(roundTripped).toContain('# Vault Breach Resolution');
    expect(roundTripped).toContain('[Consequence Ledger](docs/consequence-ledger.md "Ledger")');
    expect(roundTripped).toContain('- [x] Draft state machine transitions');
    expect(roundTripped).toContain('- [ ] Calibrate Tier IV backlash');
    expect(roundTripped).toContain('src: embeds/state-explorer/index.html');
    expect(roundTripped).toContain('props: {"initialState":"declare_intent","tier":2}');
    expect(roundTripped).toMatch(/\|\s*Player\s*\|\s*Intent\s*\|\s*Choose approach and charges\s*\|/);
    expect(roundTripped).toContain('<details>');
    expect(roundTripped).toContain('<kbd>Alt+C</kbd>');
    expect(roundTripped).toContain('[^design-note]');
    expect(roundTripped).toContain('[^design-note]: Preserved footnote definition');

    // Second pass idempotency check
    const secondPass = proseMirrorToMarkdown(markdownToProseMirror(roundTripped));
    expect(secondPass).toBe(roundTripped);
  });

  it('never silently drops malformed embed blocks', () => {
    const malformed = `# Broken Embed Example\n\n\`\`\`embed\nnot valid key value syntax\n\`\`\`\n`;
    const pm = markdownToProseMirror(malformed);
    const out = proseMirrorToMarkdown(pm);
    expect(out).toContain('not valid key value syntax');
  });

  it('preserves untouched compact GFM tables and blocks verbatim when editing prose with baseMarkdown', () => {
    const compactTable = [
      '| Beat | Authoritative Owner | Input Consumed | Guaranteed Output |',
      '| :--- | :--- | :--- | :--- |',
      '| 1. Inspect & Declare | Player | Target doorway ID, Rigging toolset | Previewed modifier without resource spend |',
      '| 2. Lock Stakes | Rules Engine | Committed Lantern Oil (`0` to `2` charges) | Atomic oil deduction; rollback disabled |'
    ].join('\n');

    const baseDoc = `# Action Resolution\n\n> Initial specification note.\n\nIntroductory paragraph.\n\n${compactTable}\n`;
    const pm = markdownToProseMirror(baseDoc);

    // 1. Edit only the blockquote (simulating appending "But maybe one day.")
    const bq = pm.content![1];
    const bqPara = bq.content![0];
    bqPara.content![0].text = 'Initial specification note. But maybe one day.';

    const serializedAfterProseEdit = proseMirrorToMarkdown(pm, baseDoc);
    expect(serializedAfterProseEdit).toContain('> Initial specification note. But maybe one day.');
    // Untouched compact table must remain byte-for-byte identical (no pipe padding churn)
    expect(serializedAfterProseEdit).toContain(compactTable);

    // 2. Insert a brand-new paragraph above the table; untouched table still stays verbatim
    pm.content!.splice(3, 0, {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Newly inserted paragraph above the matrix.' }]
    });
    const serializedAfterInsert = proseMirrorToMarkdown(pm, baseDoc);
    expect(serializedAfterInsert).toContain('Newly inserted paragraph above the matrix.');
    expect(serializedAfterInsert).toContain(compactTable);

    // 3. Edit an actual cell inside the table -> table updates cleanly with new cell content
    const tableNode = pm.content!.find((n) => n.type === 'table')!;
    tableNode.content![1].content![1].content![0].content = [
      { type: 'text', text: 'Updated Owner' }
    ];
    const serializedAfterTableEdit = proseMirrorToMarkdown(pm, baseDoc);
    expect(serializedAfterTableEdit).toContain('Updated Owner');
  });
});
