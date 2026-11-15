import { describe, expect, it } from 'vitest';
import { markdownToProseMirror } from '../shared/markdownCodec.js';
import {
  buildAnchorFromBlockSelection,
  extractProseBlocks,
  resolveAnchorInBlocks
} from '../shared/anchorResolver.js';

describe('anchorResolver resilient reattachment (Scenario 5)', () => {
  const sampleMd = `# Breach Procedure

## Step One

When the delve team fails a Breach check by 4 or more, the Ward-Seal fractures into unstable resonance before the iron doors unlatch.

## Step Two

The party may retreat to the antechamber and reset their rigging tools.
`;

  it('attaches cleanly at original location and reattaches when passage moves unambiguously', () => {
    const blocks = extractProseBlocks(markdownToProseMirror(sampleMd));
    const targetBlock = blocks.find((b) => b.text.includes('Ward-Seal fractures'))!;
    const phrase = 'the Ward-Seal fractures into unstable resonance';
    const start = targetBlock.text.indexOf(phrase);
    const anchor = buildAnchorFromBlockSelection(targetBlock, start, start + phrase.length);

    const initial = resolveAnchorInBlocks(anchor, blocks);
    expect(initial.anchorStatus).toBe('attached');
    expect(initial.blockIndex).toBe(targetBlock.blockIndex);

    // Move the passage to a completely different section and rewrite surrounding words
    const movedMd = `# Breach Procedure

## Step One

The party checks doorway runes carefully.

## Reordered Consequence Section

Even under controlled conditions, ${phrase} if nobody vents thecapacitor.
`;
    const movedBlocks = extractProseBlocks(markdownToProseMirror(movedMd));
    const afterMove = resolveAnchorInBlocks(anchor, movedBlocks);
    expect(afterMove.anchorStatus).toBe('attached');
    expect(movedBlocks[afterMove.blockIndex!].text).toContain(phrase);
  });

  it('flags orphaned status when the anchored passage is deleted', () => {
    const blocks = extractProseBlocks(markdownToProseMirror(sampleMd));
    const targetBlock = blocks.find((b) => b.text.includes('Ward-Seal fractures'))!;
    const phrase = 'the Ward-Seal fractures into unstable resonance';
    const start = targetBlock.text.indexOf(phrase);
    const anchor = buildAnchorFromBlockSelection(targetBlock, start, start + phrase.length);

    const deletedMd = `# Breach Procedure\n\n## Step One\n\nWhen the delve team fails, the doors remain locked.\n`;
    const deletedBlocks = extractProseBlocks(markdownToProseMirror(deletedMd));
    const afterDelete = resolveAnchorInBlocks(anchor, deletedBlocks);
    expect(afterDelete.anchorStatus).toBe('orphaned');
  });

  it('flags ambiguous status instead of guessing when passage is duplicated with matching or missing context', () => {
    const blocks = extractProseBlocks(markdownToProseMirror(sampleMd));
    const targetBlock = blocks.find((b) => b.text.includes('Ward-Seal fractures'))!;
    const phrase = 'the Ward-Seal fractures into unstable resonance';
    const start = targetBlock.text.indexOf(phrase);
    const anchor = buildAnchorFromBlockSelection(targetBlock, start, start + phrase.length);

    // Case 1: Entire paragraph is duplicated
    const duplicatedParagraphMd = `${sampleMd}\n## Duplicate Section\n\nWhen the delve team fails a Breach check by 4 or more, the Ward-Seal fractures into unstable resonance before the iron doors unlatch.\n`;
    const dupBlocks1 = extractProseBlocks(markdownToProseMirror(duplicatedParagraphMd));
    expect(resolveAnchorInBlocks(anchor, dupBlocks1).anchorStatus).toBe('ambiguous');

    // Case 2: Passage is moved AND duplicated in two new places
    const movedAndDuplicatedMd = `# Breach\n\nFirst variant: ${phrase} during overload.\n\nSecond variant: ${phrase} during collapse.\n`;
    const dupBlocks2 = extractProseBlocks(markdownToProseMirror(movedAndDuplicatedMd));
    expect(resolveAnchorInBlocks(anchor, dupBlocks2).anchorStatus).toBe('ambiguous');
  });
});
