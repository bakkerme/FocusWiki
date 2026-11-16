import { describe, expect, it } from 'vitest';
import {
  buildCodeFileReview,
  buildCommentSidecarReview,
  buildMarkdownFileReview
} from '../shared/changeReview.js';

describe('Rich Change Review structured comparators', () => {
  it('separates substantive prose additions from formatting-only GFM table pipe padding', () => {
    const beforeMd = `# Action Resolution: Breaching a Ward-Sealed Threshold

> **Illustrative Prototype Specification:** Synthetic sample content for testing.

## Actor Responsibility Matrix

| Beat | Authoritative Owner |
| :--- | :--- |
| 1. Inspect | Player |
| 2. Lock Stakes | Rules Engine |
`;

    const afterMd = `# Action Resolution: Breaching a Ward-Sealed Threshold

> **Illustrative Prototype Specification:** Synthetic sample content for testing. But maybe one day.

## Actor Responsibility Matrix

| Beat           | Authoritative Owner |
| :------------- | :------------------ |
| 1. Inspect     | Player              |
| 2. Lock Stakes | Rules Engine        |
`;

    const review = buildMarkdownFileReview(beforeMd, afterMd);
    expect(review.substantiveCount).toBe(1);
    expect(review.formattingOnlyCount).toBe(1);
    expect(review.formattingOnlyTables).toBe(1);

    const modEntry = review.entries.find((e) => e.type === 'modified');
    expect(modEntry).toBeDefined();
    if (modEntry && modEntry.type === 'modified') {
      expect(modEntry.wordDiff?.some((t) => t.op === 'add' && t.text.includes('But maybe one day.'))).toBe(
        true
      );
    }

    const fmtEntry = review.entries.find((e) => e.type === 'formatting-only');
    expect(fmtEntry).toBeDefined();
    if (fmtEntry && fmtEntry.type === 'formatting-only') {
      expect(fmtEntry.block.kind).toBe('table');
      expect(fmtEntry.note).toContain('cell text and alignments are identical to HEAD');
    }
  });

  it('detects substantive table cell and row changes and keeps embeds/HTML inert', () => {
    const beforeMd = `# Spec

| Stat | Modifier |
| :--- | :--- |
| Rigging | +1 |

\`\`\`embed
src: embeds/state-explorer/index.html
title: Explorer
height: 320
\`\`\`

<script>window.__neverRan = true;</script>
`;

    const afterMd = `# Spec

| Stat | Modifier |
| :--- | :---: |
| Rigging | +2 |
| Lantern | +1 |

\`\`\`embed
src: embeds/state-explorer/index.html
title: Explorer v2
height: 380
\`\`\`

<script>window.__neverRan = true;</script>
`;

    const review = buildMarkdownFileReview(beforeMd, afterMd);
    expect(review.formattingOnlyCount).toBe(0);
    expect(review.substantiveCount).toBe(2);

    const tableMod = review.entries.find(
      (e) => e.type === 'modified' && e.after.kind === 'table'
    );
    expect(tableMod).toBeDefined();
    if (tableMod && tableMod.type === 'modified' && tableMod.tableDiff) {
      expect(tableMod.tableDiff.headers[1].alignAfter).toBe('center');
      expect(tableMod.tableDiff.rows.some((r) => r.status === 'modified')).toBe(true);
      expect(tableMod.tableDiff.rows.some((r) => r.status === 'added')).toBe(true);
    }

    const embedMod = review.entries.find(
      (e) => e.type === 'modified' && e.after.kind === 'embed'
    );
    expect(embedMod).toBeDefined();
  });

  it('summarizes .comments.json thread creation, replies, and status changes human-readably', () => {
    const beforeJson = JSON.stringify({
      version: 1,
      document: 'docs/spec.md',
      threads: [
        {
          id: 't-1',
          status: 'open',
          createdAt: '2026-11-15T00:00:00Z',
          updatedAt: '2026-11-15T00:00:00Z',
          anchor: { quote: 'ward-sealed doorway', prefix: '', suffix: '' },
          messages: [
            {
              id: 'm-1',
              author: 'Mira',
              role: 'human',
              createdAt: '2026-11-15T00:00:00Z',
              body: 'Check lock order.'
            }
          ],
          history: []
        }
      ]
    });

    const afterJson = JSON.stringify({
      version: 1,
      document: 'docs/spec.md',
      threads: [
        {
          id: 't-1',
          status: 'resolved',
          createdAt: '2026-11-15T00:00:00Z',
          updatedAt: '2026-11-16T00:00:00Z',
          anchor: { quote: 'ward-sealed doorway', prefix: '', suffix: '' },
          messages: [
            {
              id: 'm-1',
              author: 'Mira',
              role: 'human',
              createdAt: '2026-11-15T00:00:00Z',
              body: 'Check lock order.'
            },
            {
              id: 'm-2',
              author: 'Rules Bot',
              role: 'bot',
              createdAt: '2026-11-16T00:00:00Z',
              body: 'Verified in step 2.'
            }
          ],
          history: []
        }
      ]
    });

    const cr = buildCommentSidecarReview(beforeJson, afterJson);
    expect(cr.parseError).toBe(false);
    expect(cr.changes).toHaveLength(1);
    expect(cr.changes[0].summary).toContain('open → resolved');
    expect(cr.changes[0].addedMessages).toHaveLength(1);
    expect(cr.changes[0].addedMessages[0].body).toBe('Verified in step 2.');

    const codeRev = buildCodeFileReview('const a = 1;\n', 'const a = 2;\nconst b = 3;\n', 'javascript');
    expect(codeRev.addedLines).toBe(2);
    expect(codeRev.removedLines).toBe(1);
    expect(codeRev.hunks.length).toBeGreaterThan(0);
  });
});
