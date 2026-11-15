import type {
  AnchorStatus,
  CommentAnchor,
  CommentThread,
  ProseMirrorNode,
  ResolvedCommentThread
} from './types.js';

export interface ExtractedTextBlock {
  blockIndex: number;
  type: string;
  headingContext: string;
  text: string;
}

export interface AnchorMatchLocation {
  anchorStatus: AnchorStatus;
  anchorReason?: string;
  blockIndex?: number;
  blockOffset?: number;
  matchLength?: number;
}

const CONTEXT_WINDOW = 40;

/**
 * Flatten a ProseMirror JSON tree into ordered readable prose blocks (paragraphs, headings, list items, table cells, blockquotes).
 * Excludes code blocks, embeds, and raw preserved blocks so prose comments strictly target prose.
 */
export function extractProseBlocks(doc: ProseMirrorNode): ExtractedTextBlock[] {
  const blocks: ExtractedTextBlock[] = [];
  let currentHeading = '';

  function collectInlineText(node: ProseMirrorNode): string {
    if (node.type === 'text') {
      return node.text ?? '';
    }
    if (node.type === 'hardBreak') {
      return '\n';
    }
    if (node.type === 'rawMarkdownInline') {
      return String(node.attrs?.raw ?? '');
    }
    if (!node.content) {
      return '';
    }
    return node.content.map(collectInlineText).join('');
  }

  function walk(node: ProseMirrorNode): void {
    if (node.type === 'heading') {
      const text = collectInlineText(node);
      currentHeading = text.trim();
      blocks.push({
        blockIndex: blocks.length,
        type: 'heading',
        headingContext: currentHeading,
        text
      });
      return;
    }

    if (node.type === 'paragraph') {
      const text = collectInlineText(node);
      blocks.push({
        blockIndex: blocks.length,
        type: 'paragraph',
        headingContext: currentHeading,
        text
      });
      return;
    }

    if (
      node.type === 'codeBlock' ||
      node.type === 'embedBlock' ||
      node.type === 'rawMarkdownBlock' ||
      node.type === 'horizontalRule'
    ) {
      return;
    }

    if (node.content) {
      for (const child of node.content) {
        walk(child);
      }
    }
  }

  walk(doc);
  return blocks;
}

/**
 * Create a resilient CommentAnchor from a prose block and character slice [start, end).
 * Captures within-block prefix and suffix so moving a block preserves uniqueness while duplicating
 * a block or passage is detected as ambiguous rather than guessed.
 */
export function buildAnchorFromBlockSelection(
  block: ExtractedTextBlock,
  startOffset: number,
  endOffset: number
): CommentAnchor {
  const quote = block.text.slice(startOffset, endOffset);
  const prefix = block.text.slice(Math.max(0, startOffset - CONTEXT_WINDOW), startOffset);
  const suffix = block.text.slice(endOffset, Math.min(block.text.length, endOffset + CONTEXT_WINDOW));
  return {
    quote,
    prefix,
    suffix,
    headingContext: block.headingContext || undefined
  };
}

interface RawCandidate {
  blockIndex: number;
  blockOffset: number;
  blockText: string;
  headingContext: string;
}

function findAllOccurrences(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const indices: number[] = [];
  let pos = 0;
  while (pos <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    indices.push(idx);
    pos = idx + 1;
  }
  return indices;
}

/**
 * Resolve a single CommentAnchor against extracted prose blocks:
 * - 0 quote matches -> 'orphaned'
 * - 1 quote match anywhere in document -> 'attached' (handles moved passages unambiguously)
 * - 2+ quote matches -> check exact within-block prefix + suffix:
 *     - if strictly 1 candidate matches full recorded prefix+suffix -> 'attached'
 *     - otherwise (0 match because moved+duplicated, or 2+ match because sentence/paragraph duplicated) -> 'ambiguous' (never guess!)
 */
export function resolveAnchorInBlocks(
  anchor: CommentAnchor,
  blocks: ExtractedTextBlock[]
): AnchorMatchLocation {
  const quote = anchor.quote;
  if (!quote || quote.trim().length === 0) {
    return {
      anchorStatus: 'orphaned',
      anchorReason: 'Anchor quote is empty.'
    };
  }

  // First try single-block candidates (standard prose selection).
  const candidates: RawCandidate[] = [];
  for (const block of blocks) {
    const offsets = findAllOccurrences(block.text, quote);
    for (const offset of offsets) {
      candidates.push({
        blockIndex: block.blockIndex,
        blockOffset: offset,
        blockText: block.text,
        headingContext: block.headingContext
      });
    }
  }

  // Fallback for multi-paragraph selections separated by '\n' if someone selected across blocks.
  if (candidates.length === 0 && quote.includes('\n')) {
    const joined = blocks.map((b) => b.text).join('\n');
    const joinedMatches = findAllOccurrences(joined, quote);
    if (joinedMatches.length === 1) {
      let running = 0;
      for (const block of blocks) {
        const nextRunning = running + block.text.length + 1;
        if (joinedMatches[0] >= running && joinedMatches[0] < nextRunning) {
          return {
            anchorStatus: 'attached',
            blockIndex: block.blockIndex,
            blockOffset: joinedMatches[0] - running,
            matchLength: Math.min(quote.length, block.text.length - (joinedMatches[0] - running))
          };
        }
        running = nextRunning;
      }
    } else if (joinedMatches.length > 1) {
      return {
        anchorStatus: 'ambiguous',
        anchorReason: `Selected multi-block passage appears ${joinedMatches.length} times; refusing to guess.`
      };
    }
  }

  if (candidates.length === 0) {
    return {
      anchorStatus: 'orphaned',
      anchorReason: 'Anchored passage was deleted or rewritten.'
    };
  }

  if (candidates.length === 1) {
    return {
      anchorStatus: 'attached',
      blockIndex: candidates[0].blockIndex,
      blockOffset: candidates[0].blockOffset,
      matchLength: quote.length
    };
  }

  // Multiple occurrences exist. Disambiguate ONLY if recorded within-block prefix/suffix uniquely identifies one match.
  const hasRecordedContext = anchor.prefix.length > 0 || anchor.suffix.length > 0;
  if (!hasRecordedContext) {
    return {
      anchorStatus: 'ambiguous',
      anchorReason: `Anchored passage appears ${candidates.length} times with identical block boundaries; refusing to attach to a guess.`
    };
  }

  const contextMatches = candidates.filter((cand) => {
    const actualPrefix = cand.blockText.slice(
      Math.max(0, cand.blockOffset - anchor.prefix.length),
      cand.blockOffset
    );
    const end = cand.blockOffset + quote.length;
    const actualSuffix = cand.blockText.slice(end, end + anchor.suffix.length);
    return actualPrefix === anchor.prefix && actualSuffix === anchor.suffix;
  });

  if (contextMatches.length === 1) {
    // Also check if another candidate has identical quote with empty context because user duplicated ONLY the quote?
    // Wait: if user selected "unstable resonance" inside paragraph A, and later pasted a second copy of "unstable resonance"
    // into paragraph B, paragraph A still uniquely matches prefix+suffix ONLY if paragraph B wasn't a duplicate of the clause.
    // Wait: what if someone duplicates the phrase itself to test duplicate ambiguity? Let's check headingContext too if needed,
    // wait: if someone copies "the Ward-Seal fractures" and pastes "the Ward-Seal fractures" right next to it or in a new paragraph,
    // wait—why would someone duplicate a selected passage in Scenario 5 ("Duplicate it and do not guess at an ambiguous anchor")?
    // Let's handle BOTH:
    // - If contextMatches.length > 1 (duplicated sentence/paragraph/clause) -> ambiguous!
    // - If contextMatches.length === 0 (moved and duplicated) -> ambiguous!
    // - If contextMatches.length === 1 -> attached to the unique context match!
    return {
      anchorStatus: 'attached',
      blockIndex: contextMatches[0].blockIndex,
      blockOffset: contextMatches[0].blockOffset,
      matchLength: quote.length
    };
  }

  return {
    anchorStatus: 'ambiguous',
    anchorReason:
      contextMatches.length === 0
        ? `Passage moved and now appears ${candidates.length} times without original context.`
        : `Passage and its surrounding context appear ${contextMatches.length} times.`
  };
}

export function resolveThreadsAgainstDoc(
  threads: CommentThread[],
  doc: ProseMirrorNode
): ResolvedCommentThread[] {
  const blocks = extractProseBlocks(doc);
  return threads.map((thread) => {
    const loc = resolveAnchorInBlocks(thread.anchor, blocks);
    return {
      ...thread,
      anchorStatus: loc.anchorStatus,
      anchorReason: loc.anchorReason,
      blockIndex: loc.blockIndex,
      blockOffset: loc.blockOffset
    };
  });
}
