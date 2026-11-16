import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import type { PhrasingContent, RootContent } from 'mdast';
import type {
  CommentSidecarFile,
  CommentThread,
  EmbedDescriptor,
  GitRepoStatus
} from './types.js';
import {
  extractDocumentTitle,
  markdownToProseMirror,
  parseEmbedBlockText,
  proseMirrorToMarkdown
} from './markdownCodec.js';

export type ChangeFileCategory = 'markdown' | 'comments' | 'code' | 'binary';

export interface DiffToken {
  op: 'equal' | 'add' | 'del';
  text: string;
}

export type InertReviewBlock =
  | {
      kind: 'heading';
      level: number;
      text: string;
      raw: string;
      semanticKey: string;
    }
  | {
      kind: 'paragraph';
      text: string;
      raw: string;
      semanticKey: string;
    }
  | {
      kind: 'blockquote';
      text: string;
      raw: string;
      semanticKey: string;
    }
  | {
      kind: 'list';
      ordered: boolean;
      items: Array<{ checked: boolean | null; text: string }>;
      raw: string;
      semanticKey: string;
    }
  | {
      kind: 'table';
      align: Array<'left' | 'center' | 'right' | null>;
      headers: string[];
      rows: string[][];
      raw: string;
      semanticKey: string;
    }
  | {
      kind: 'embed';
      descriptor: EmbedDescriptor;
      raw: string;
      semanticKey: string;
    }
  | {
      kind: 'code';
      language: string | null;
      code: string;
      raw: string;
      semanticKey: string;
    }
  | {
      kind: 'hr';
      raw: string;
      semanticKey: string;
    }
  | {
      kind: 'raw';
      rawKind: string;
      value: string;
      raw: string;
      semanticKey: string;
    };

export interface TableCellComparison {
  before: string;
  after: string;
  changed: boolean;
  tokens?: DiffToken[];
}

export interface TableRowComparison {
  status: 'unchanged' | 'modified' | 'added' | 'removed';
  cells: TableCellComparison[];
}

export interface SubstantiveTableComparison {
  colCount: number;
  headers: Array<{
    before: string;
    after: string;
    changed: boolean;
    alignBefore: string | null;
    alignAfter: string | null;
    tokens?: DiffToken[];
  }>;
  alignmentChangedOnly: boolean;
  rows: TableRowComparison[];
}

export type MarkdownReviewEntry =
  | {
      type: 'unchanged-group';
      count: number;
      headings: string[];
    }
  | {
      type: 'context-heading';
      level: number;
      text: string;
    }
  | {
      type: 'formatting-only';
      block: InertReviewBlock;
      note: string;
    }
  | {
      type: 'added';
      block: InertReviewBlock;
    }
  | {
      type: 'removed';
      block: InertReviewBlock;
    }
  | {
      type: 'modified';
      before: InertReviewBlock;
      after: InertReviewBlock;
      wordDiff?: DiffToken[];
      listItemDiffs?: Array<{
        status: 'unchanged' | 'modified' | 'added' | 'removed';
        checkedBefore?: boolean | null;
        checkedAfter?: boolean | null;
        textBefore?: string;
        textAfter?: string;
        tokens?: DiffToken[];
      }>;
      tableDiff?: SubstantiveTableComparison;
      codeHunks?: CodeDiffHunk[];
    };

export interface MarkdownFileReview {
  substantiveCount: number;
  formattingOnlyCount: number;
  formattingOnlyTables: number;
  entries: MarkdownReviewEntry[];
}

export interface CommentThreadChangeItem {
  threadId: string;
  changeKind: 'added' | 'removed' | 'updated';
  quote: string;
  statusBefore: 'open' | 'resolved' | null;
  statusAfter: 'open' | 'resolved' | null;
  addedMessages: Array<{ author: string; role: 'human' | 'bot'; body: string }>;
  totalMessagesAfter: number;
  summary: string;
}

export interface CommentSidecarReview {
  documentPath: string | null;
  parseError: boolean;
  changes: CommentThreadChangeItem[];
}

export interface CodeDiffLine {
  kind: 'context' | 'add' | 'del';
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface CodeDiffHunk {
  header: string;
  lines: CodeDiffLine[];
}

export interface CodeFileReview {
  languageHint: string;
  addedLines: number;
  removedLines: number;
  hunks: CodeDiffHunk[];
  hunksTruncated: boolean;
}

export interface ChangeFileSummary {
  path: string;
  oldPath?: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  category: ChangeFileCategory;
  humanTitle: string;
  formattingOnly: boolean;
  summaryLabel: string;
  isBinary: boolean;
  truncated: boolean;
  beforeBytes: number;
  afterBytes: number;
  rawPatch: string;
  markdownReview?: MarkdownFileReview;
  commentReview?: CommentSidecarReview;
  codeReview?: CodeFileReview;
}

export interface GitChangeReviewPayload {
  status: GitRepoStatus;
  diff: string;
  snapshotDigest: string;
  commitScopeNote: string;
  files: ChangeFileSummary[];
}

export function computeWordDiff(beforeText: string, afterText: string): DiffToken[] {
  if (beforeText === afterText) {
    return beforeText ? [{ op: 'equal', text: beforeText }] : [];
  }
  const aTokens = beforeText.match(/\S+|\s+/g) ?? [];
  const bTokens = afterText.match(/\S+|\s+/g) ?? [];

  const m = aTokens.length;
  const n = bTokens.length;
  if (m === 0) return afterText ? [{ op: 'add', text: afterText }] : [];
  if (n === 0) return beforeText ? [{ op: 'del', text: beforeText }] : [];

  if (m * n > 200_000) {
    return [
      { op: 'del', text: beforeText },
      { op: 'add', text: afterText }
    ];
  }

  const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (aTokens[i] === bTokens[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
  }

  const raw: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (aTokens[i] === bTokens[j]) {
      raw.push({ op: 'equal', text: aTokens[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ op: 'del', text: aTokens[i] });
      i++;
    } else {
      raw.push({ op: 'add', text: bTokens[j] });
      j++;
    }
  }
  while (i < m) {
    raw.push({ op: 'del', text: aTokens[i++] });
  }
  while (j < n) {
    raw.push({ op: 'add', text: bTokens[j++] });
  }

  const merged: DiffToken[] = [];
  for (const tok of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.op === tok.op) {
      prev.text += tok.text;
    } else {
      merged.push({ ...tok });
    }
  }
  return merged;
}

function inlinePlainText(nodes: PhrasingContent[]): string {
  const parts: string[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        parts.push(n.value);
        break;
      case 'inlineCode':
        parts.push(`\`${n.value}\``);
        break;
      case 'strong':
      case 'emphasis':
      case 'delete':
        parts.push(inlinePlainText(n.children));
        break;
      case 'link': {
        const label = inlinePlainText(n.children);
        parts.push(label ? `${label} (${n.url})` : n.url);
        break;
      }
      case 'break':
        parts.push('\n');
        break;
      default:
        if ('value' in n && typeof n.value === 'string') {
          parts.push(n.value);
        }
        break;
    }
  }
  return parts.join('');
}

function blockPlainText(nodes: RootContent[]): string {
  return nodes
    .map((n) => {
      if (n.type === 'paragraph' || n.type === 'heading') {
        return inlinePlainText(n.children);
      }
      if (n.type === 'blockquote') {
        return blockPlainText(n.children);
      }
      if (n.type === 'code') {
        return n.value;
      }
      if ('value' in n && typeof n.value === 'string') {
        return n.value;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function parseMarkdownReviewBlocks(markdown: string): InertReviewBlock[] {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (!normalized.trim()) return [];

  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .parse(normalized);

  const pmDoc = markdownToProseMirror(normalized);
  const pmBlocks = pmDoc.content ?? [];
  const alignedCount = tree.children.length === pmBlocks.length;

  const out: InertReviewBlock[] = [];

  for (let idx = 0; idx < tree.children.length; idx++) {
    const node = tree.children[idx];
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    const raw =
      typeof start === 'number' && typeof end === 'number'
        ? normalized.slice(start, end)
        : '';

    const canonicalMd = alignedCount
      ? proseMirrorToMarkdown({ type: 'doc', content: [pmBlocks[idx]] })
      : proseMirrorToMarkdown(markdownToProseMirror(raw));

    const semanticKey = `${node.type}:${canonicalMd}`;

    switch (node.type) {
      case 'heading': {
        out.push({
          kind: 'heading',
          level: node.depth,
          text: inlinePlainText(node.children),
          raw,
          semanticKey
        });
        break;
      }
      case 'paragraph': {
        out.push({
          kind: 'paragraph',
          text: inlinePlainText(node.children),
          raw,
          semanticKey
        });
        break;
      }
      case 'blockquote': {
        out.push({
          kind: 'blockquote',
          text: blockPlainText(node.children),
          raw,
          semanticKey
        });
        break;
      }
      case 'list': {
        out.push({
          kind: 'list',
          ordered: Boolean(node.ordered),
          items: node.children.map((item) => ({
            checked: typeof item.checked === 'boolean' ? item.checked : null,
            text: blockPlainText(item.children)
          })),
          raw,
          semanticKey
        });
        break;
      }
      case 'table': {
        const align = (node.align ?? []).map((a) =>
          a === 'left' || a === 'center' || a === 'right' ? a : null
        );
        const headerRow = node.children[0];
        const headers = headerRow
          ? headerRow.children.map((cell) => inlinePlainText(cell.children))
          : [];
        const rows = node.children
          .slice(1)
          .map((row) => row.children.map((cell) => inlinePlainText(cell.children)));
        out.push({
          kind: 'table',
          align,
          headers,
          rows,
          raw,
          semanticKey
        });
        break;
      }
      case 'code': {
        if (node.lang === 'embed') {
          const parsed = parseEmbedBlockText(node.value);
          if (parsed) {
            out.push({
              kind: 'embed',
              descriptor: parsed,
              raw,
              semanticKey
            });
            break;
          }
        }
        out.push({
          kind: 'code',
          language: node.lang ?? null,
          code: node.value,
          raw,
          semanticKey
        });
        break;
      }
      case 'thematicBreak': {
        out.push({
          kind: 'hr',
          raw,
          semanticKey
        });
        break;
      }
      default: {
        out.push({
          kind: 'raw',
          rawKind: node.type,
          value: raw || ('value' in node ? String(node.value) : ''),
          raw,
          semanticKey
        });
        break;
      }
    }
  }

  return out;
}

function compareTables(
  before: Extract<InertReviewBlock, { kind: 'table' }>,
  after: Extract<InertReviewBlock, { kind: 'table' }>
): SubstantiveTableComparison {
  const colCount = Math.max(before.headers.length, after.headers.length);
  const headers: SubstantiveTableComparison['headers'] = [];
  let anyHeaderContentChanged = false;
  let anyAlignChanged = false;

  for (let c = 0; c < colCount; c++) {
    const bH = before.headers[c] ?? '';
    const aH = after.headers[c] ?? '';
    const alignBefore = before.align[c] ?? null;
    const alignAfter = after.align[c] ?? null;
    const changed = bH !== aH || alignBefore !== alignAfter;
    if (bH !== aH) anyHeaderContentChanged = true;
    if (alignBefore !== alignAfter) anyAlignChanged = true;
    headers.push({
      before: bH,
      after: aH,
      changed,
      alignBefore,
      alignAfter,
      ...(bH !== aH ? { tokens: computeWordDiff(bH, aH) } : {})
    });
  }

  const beforeRowKeys = before.rows.map((r) => JSON.stringify(r));
  const afterRowKeys = after.rows.map((r) => JSON.stringify(r));
  const m = before.rows.length;
  const n = after.rows.length;

  const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (beforeRowKeys[i] === afterRowKeys[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
  }

  const anchors: Array<{ bi: number; ai: number }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (beforeRowKeys[i] === afterRowKeys[j]) {
      anchors.push({ bi: i, ai: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  const rows: TableRowComparison[] = [];
  let anyRowChanged = false;
  let prevB = 0;
  let prevA = 0;
  const sentinelAnchors = [...anchors, { bi: m, ai: n }];

  for (const anc of sentinelAnchors) {
    const remCount = anc.bi - prevB;
    const addCount = anc.ai - prevA;
    const pairCount = Math.min(remCount, addCount);

    for (let k = 0; k < pairCount; k++) {
      anyRowChanged = true;
      const bRow = before.rows[prevB + k];
      const aRow = after.rows[prevA + k];
      const cells: TableCellComparison[] = [];
      for (let c = 0; c < colCount; c++) {
        const bVal = bRow[c] ?? '';
        const aVal = aRow[c] ?? '';
        const changed = bVal !== aVal;
        cells.push({
          before: bVal,
          after: aVal,
          changed,
          ...(changed ? { tokens: computeWordDiff(bVal, aVal) } : {})
        });
      }
      rows.push({ status: 'modified', cells });
    }

    for (let k = pairCount; k < remCount; k++) {
      anyRowChanged = true;
      const bRow = before.rows[prevB + k];
      rows.push({
        status: 'removed',
        cells: Array.from({ length: colCount }, (_, c) => ({
          before: bRow[c] ?? '',
          after: '',
          changed: true
        }))
      });
    }

    for (let k = pairCount; k < addCount; k++) {
      anyRowChanged = true;
      const aRow = after.rows[prevA + k];
      rows.push({
        status: 'added',
        cells: Array.from({ length: colCount }, (_, c) => ({
          before: '',
          after: aRow[c] ?? '',
          changed: true
        }))
      });
    }

    if (anc.bi < m && anc.ai < n) {
      const uRow = after.rows[anc.ai];
      rows.push({
        status: 'unchanged',
        cells: Array.from({ length: colCount }, (_, c) => ({
          before: uRow[c] ?? '',
          after: uRow[c] ?? '',
          changed: false
        }))
      });
      prevB = anc.bi + 1;
      prevA = anc.ai + 1;
    }
  }

  return {
    colCount,
    headers,
    alignmentChangedOnly: anyAlignChanged && !anyHeaderContentChanged && !anyRowChanged,
    rows
  };
}

function buildModifiedBlockEntry(
  before: InertReviewBlock,
  after: InertReviewBlock
): Extract<MarkdownReviewEntry, { type: 'modified' }> {
  if (
    (before.kind === 'paragraph' && after.kind === 'paragraph') ||
    (before.kind === 'blockquote' && after.kind === 'blockquote') ||
    (before.kind === 'heading' && after.kind === 'heading')
  ) {
    return {
      type: 'modified',
      before,
      after,
      wordDiff: computeWordDiff(before.text, after.text)
    };
  }

  if (before.kind === 'table' && after.kind === 'table') {
    return {
      type: 'modified',
      before,
      after,
      tableDiff: compareTables(before, after)
    };
  }

  if (before.kind === 'list' && after.kind === 'list') {
    const maxLen = Math.max(before.items.length, after.items.length);
    const listItemDiffs: NonNullable<
      Extract<MarkdownReviewEntry, { type: 'modified' }>['listItemDiffs']
    > = [];
    for (let idx = 0; idx < maxLen; idx++) {
      const bItem = before.items[idx];
      const aItem = after.items[idx];
      if (bItem && aItem) {
        const same = bItem.text === aItem.text && bItem.checked === aItem.checked;
        listItemDiffs.push({
          status: same ? 'unchanged' : 'modified',
          checkedBefore: bItem.checked,
          checkedAfter: aItem.checked,
          textBefore: bItem.text,
          textAfter: aItem.text,
          ...(!same && bItem.text !== aItem.text
            ? { tokens: computeWordDiff(bItem.text, aItem.text) }
            : {})
        });
      } else if (bItem) {
        listItemDiffs.push({
          status: 'removed',
          checkedBefore: bItem.checked,
          textBefore: bItem.text
        });
      } else if (aItem) {
        listItemDiffs.push({
          status: 'added',
          checkedAfter: aItem.checked,
          textAfter: aItem.text
        });
      }
    }
    return {
      type: 'modified',
      before,
      after,
      listItemDiffs
    };
  }

  if (before.kind === 'code' && after.kind === 'code') {
    return {
      type: 'modified',
      before,
      after,
      codeHunks: buildCodeFileReview(before.code, after.code, before.language ?? 'text').hunks
    };
  }

  return {
    type: 'modified',
    before,
    after
  };
}

export function buildMarkdownFileReview(
  beforeMd: string | null,
  afterMd: string | null
): MarkdownFileReview {
  const beforeBlocks = beforeMd ? parseMarkdownReviewBlocks(beforeMd) : [];
  const afterBlocks = afterMd ? parseMarkdownReviewBlocks(afterMd) : [];

  if (beforeMd === null) {
    return {
      substantiveCount: afterBlocks.length,
      formattingOnlyCount: 0,
      formattingOnlyTables: 0,
      entries: afterBlocks.map((block) => ({ type: 'added', block }))
    };
  }

  if (afterMd === null) {
    return {
      substantiveCount: beforeBlocks.length,
      formattingOnlyCount: 0,
      formattingOnlyTables: 0,
      entries: beforeBlocks.map((block) => ({ type: 'removed', block }))
    };
  }

  const m = beforeBlocks.length;
  const n = afterBlocks.length;
  const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (beforeBlocks[i].semanticKey === afterBlocks[j].semanticKey) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
  }

  const anchors: Array<{ bi: number; ai: number }> = [];
  let bi = 0;
  let ai = 0;
  while (bi < m && ai < n) {
    if (beforeBlocks[bi].semanticKey === afterBlocks[ai].semanticKey) {
      anchors.push({ bi, ai });
      bi++;
      ai++;
    } else if (dp[bi + 1][ai] >= dp[bi][ai + 1]) {
      bi++;
    } else {
      ai++;
    }
  }

  type RawStep =
    | { kind: 'unchanged'; block: InertReviewBlock }
    | { kind: 'change'; entry: Exclude<MarkdownReviewEntry, { type: 'unchanged-group' | 'context-heading' }> };

  const rawSteps: RawStep[] = [];
  let substantiveCount = 0;
  let formattingOnlyCount = 0;
  let formattingOnlyTables = 0;

  let prevB = 0;
  let prevA = 0;
  const allAnchors = [...anchors, { bi: m, ai: n }];

  for (const anc of allAnchors) {
    const removedSlice = beforeBlocks.slice(prevB, anc.bi);
    const addedSlice = afterBlocks.slice(prevA, anc.ai);

    // Pair compatible blocks in order within the unmatched gap
    let rIdx = 0;
    let aIdx = 0;
    while (rIdx < removedSlice.length || aIdx < addedSlice.length) {
      const rem = removedSlice[rIdx];
      const add = addedSlice[aIdx];
      if (rem && add && rem.kind === add.kind) {
        substantiveCount++;
        rawSteps.push({
          kind: 'change',
          entry: buildModifiedBlockEntry(rem, add)
        });
        rIdx++;
        aIdx++;
      } else if (rem && (!add || removedSlice.length - rIdx >= addedSlice.length - aIdx)) {
        substantiveCount++;
        rawSteps.push({
          kind: 'change',
          entry: { type: 'removed', block: rem }
        });
        rIdx++;
      } else if (add) {
        substantiveCount++;
        rawSteps.push({
          kind: 'change',
          entry: { type: 'added', block: add }
        });
        aIdx++;
      }
    }

    if (anc.bi < m && anc.ai < n) {
      const bBlk = beforeBlocks[anc.bi];
      const aBlk = afterBlocks[anc.ai];
      if (bBlk.raw !== aBlk.raw) {
        formattingOnlyCount++;
        if (aBlk.kind === 'table') {
          formattingOnlyTables++;
        }
        const note =
          aBlk.kind === 'table'
            ? `Table pipe spacing normalized (${aBlk.headers.length} columns × ${aBlk.rows.length} rows) — cell text and alignments are identical to HEAD.`
            : 'Markdown syntax whitespace normalized — rendered content is identical to HEAD.';
        rawSteps.push({
          kind: 'change',
          entry: {
            type: 'formatting-only',
            block: aBlk,
            note
          }
        });
      } else {
        rawSteps.push({ kind: 'unchanged', block: aBlk });
      }
      prevB = anc.bi + 1;
      prevA = anc.ai + 1;
    }
  }

  // Collapse runs of unchanged blocks while keeping nearest section heading before changes
  const entries: MarkdownReviewEntry[] = [];
  let unchangedBuffer: InertReviewBlock[] = [];
  let lastEmittedHeadingText: string | null = null;

  const flushUnchangedBeforeChange = () => {
    if (unchangedBuffer.length === 0) return;
    let latestHeadingIdx = -1;
    for (let k = unchangedBuffer.length - 1; k >= 0; k--) {
      if (unchangedBuffer[k].kind === 'heading') {
        latestHeadingIdx = k;
        break;
      }
    }

    if (latestHeadingIdx !== -1) {
      const hBlock = unchangedBuffer[latestHeadingIdx] as Extract<
        InertReviewBlock,
        { kind: 'heading' }
      >;
      const otherBlocks = unchangedBuffer.filter((_, idx) => idx !== latestHeadingIdx);
      if (otherBlocks.length > 0) {
        entries.push({
          type: 'unchanged-group',
          count: otherBlocks.length,
          headings: otherBlocks
            .filter((b): b is Extract<InertReviewBlock, { kind: 'heading' }> => b.kind === 'heading')
            .map((b) => b.text)
        });
      }
      if (hBlock.text !== lastEmittedHeadingText) {
        entries.push({
          type: 'context-heading',
          level: hBlock.level,
          text: hBlock.text
        });
        lastEmittedHeadingText = hBlock.text;
      }
    } else {
      entries.push({
        type: 'unchanged-group',
        count: unchangedBuffer.length,
        headings: []
      });
    }
    unchangedBuffer = [];
  };

  for (const step of rawSteps) {
    if (step.kind === 'unchanged') {
      unchangedBuffer.push(step.block);
    } else {
      flushUnchangedBeforeChange();
      if (
        (step.entry.type === 'added' || step.entry.type === 'formatting-only') &&
        step.entry.block.kind === 'heading'
      ) {
        lastEmittedHeadingText = step.entry.block.text;
      } else if (step.entry.type === 'modified' && step.entry.after.kind === 'heading') {
        lastEmittedHeadingText = step.entry.after.text;
      }
      entries.push(step.entry);
    }
  }

  if (unchangedBuffer.length > 0) {
    entries.push({
      type: 'unchanged-group',
      count: unchangedBuffer.length,
      headings: unchangedBuffer
        .filter((b): b is Extract<InertReviewBlock, { kind: 'heading' }> => b.kind === 'heading')
        .map((b) => b.text)
    });
  }

  return {
    substantiveCount,
    formattingOnlyCount,
    formattingOnlyTables,
    entries
  };
}

export function buildCommentSidecarReview(
  beforeRaw: string | null,
  afterRaw: string | null
): CommentSidecarReview {
  try {
    const beforeData: CommentSidecarFile = beforeRaw
      ? (JSON.parse(beforeRaw) as CommentSidecarFile)
      : { version: 1, document: '', threads: [] };
    const afterData: CommentSidecarFile = afterRaw
      ? (JSON.parse(afterRaw) as CommentSidecarFile)
      : { version: 1, document: '', threads: [] };

    if (!Array.isArray(beforeData.threads) || !Array.isArray(afterData.threads)) {
      return { documentPath: null, parseError: true, changes: [] };
    }

    const beforeById = new Map<string, CommentThread>(
      beforeData.threads.map((t) => [t.id, t])
    );
    const afterById = new Map<string, CommentThread>(
      afterData.threads.map((t) => [t.id, t])
    );

    const changes: CommentThreadChangeItem[] = [];

    for (const [id, afterThread] of afterById.entries()) {
      const beforeThread = beforeById.get(id);
      if (!beforeThread) {
        changes.push({
          threadId: id,
          changeKind: 'added',
          quote: afterThread.anchor?.quote ?? '',
          statusBefore: null,
          statusAfter: afterThread.status,
          addedMessages: (afterThread.messages ?? []).map((m) => ({
            author: m.author,
            role: m.role,
            body: m.body
          })),
          totalMessagesAfter: afterThread.messages?.length ?? 0,
          summary: `New ${afterThread.status} thread (${afterThread.messages?.length ?? 0} ${
            (afterThread.messages?.length ?? 0) === 1 ? 'note' : 'notes'
          })`
        });
        continue;
      }

      if (JSON.stringify(beforeThread) === JSON.stringify(afterThread)) {
        continue;
      }

      const beforeMsgIds = new Set((beforeThread.messages ?? []).map((m) => m.id));
      const addedMessages = (afterThread.messages ?? [])
        .filter((m) => !beforeMsgIds.has(m.id))
        .map((m) => ({
          author: m.author,
          role: m.role,
          body: m.body
        }));

      const parts: string[] = [];
      if (beforeThread.status !== afterThread.status) {
        parts.push(`${beforeThread.status} → ${afterThread.status}`);
      }
      if (addedMessages.length > 0) {
        parts.push(
          `+${addedMessages.length} ${addedMessages.length === 1 ? 'reply' : 'replies'}`
        );
      }
      if (parts.length === 0) {
        parts.push('Updated thread metadata');
      }

      changes.push({
        threadId: id,
        changeKind: 'updated',
        quote: afterThread.anchor?.quote ?? beforeThread.anchor?.quote ?? '',
        statusBefore: beforeThread.status,
        statusAfter: afterThread.status,
        addedMessages,
        totalMessagesAfter: afterThread.messages?.length ?? 0,
        summary: parts.join(' · ')
      });
    }

    for (const [id, beforeThread] of beforeById.entries()) {
      if (!afterById.has(id)) {
        changes.push({
          threadId: id,
          changeKind: 'removed',
          quote: beforeThread.anchor?.quote ?? '',
          statusBefore: beforeThread.status,
          statusAfter: null,
          addedMessages: [],
          totalMessagesAfter: 0,
          summary: 'Removed thread'
        });
      }
    }

    return {
      documentPath: afterData.document || beforeData.document || null,
      parseError: false,
      changes
    };
  } catch {
    return {
      documentPath: null,
      parseError: true,
      changes: []
    };
  }
}

export function buildCodeFileReview(
  beforeText: string | null,
  afterText: string | null,
  languageHint = 'text'
): CodeFileReview {
  const aLines = beforeText !== null ? beforeText.replace(/\r\n/g, '\n').split('\n') : [];
  const bLines = afterText !== null ? afterText.replace(/\r\n/g, '\n').split('\n') : [];

  if (aLines.length > 0 && aLines[aLines.length - 1] === '') aLines.pop();
  if (bLines.length > 0 && bLines[bLines.length - 1] === '') bLines.pop();

  const m = aLines.length;
  const n = bLines.length;

  let ops: CodeDiffLine[] = [];
  let hunksTruncated = false;

  if (m * n <= 450_000) {
    const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (aLines[i] === bLines[j]) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (aLines[i] === bLines[j]) {
        ops.push({ kind: 'context', oldLine: i + 1, newLine: j + 1, text: aLines[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ kind: 'del', oldLine: i + 1, newLine: null, text: aLines[i] });
        i++;
      } else {
        ops.push({ kind: 'add', oldLine: null, newLine: j + 1, text: bLines[j] });
        j++;
      }
    }
    while (i < m) {
      ops.push({ kind: 'del', oldLine: i + 1, newLine: null, text: aLines[i++] });
    }
    while (j < n) {
      ops.push({ kind: 'add', oldLine: null, newLine: j + 1, text: bLines[j++] });
    }
  } else {
    hunksTruncated = true;
    const capA = aLines.slice(0, 300);
    const capB = bLines.slice(0, 300);
    ops = [
      ...capA.map((text, idx) => ({
        kind: 'del' as const,
        oldLine: idx + 1,
        newLine: null,
        text
      })),
      ...capB.map((text, idx) => ({
        kind: 'add' as const,
        oldLine: null,
        newLine: idx + 1,
        text
      }))
    ];
  }

  const addedLines = ops.filter((o) => o.kind === 'add').length;
  const removedLines = ops.filter((o) => o.kind === 'del').length;

  const changedIndices = ops
    .map((op, idx) => (op.kind !== 'context' ? idx : -1))
    .filter((idx) => idx !== -1);

  if (changedIndices.length === 0) {
    return { languageHint, addedLines: 0, removedLines: 0, hunks: [], hunksTruncated };
  }

  const CONTEXT = 3;
  const ranges: Array<[number, number]> = [];
  for (const idx of changedIndices) {
    const start = Math.max(0, idx - CONTEXT);
    const end = Math.min(ops.length - 1, idx + CONTEXT);
    const prev = ranges[ranges.length - 1];
    if (prev && start <= prev[1] + 1) {
      prev[1] = Math.max(prev[1], end);
    } else {
      ranges.push([start, end]);
    }
  }

  const MAX_RENDER_LINES = 800;
  let emitted = 0;
  const hunks: CodeDiffHunk[] = [];

  for (const [start, end] of ranges) {
    if (emitted >= MAX_RENDER_LINES) {
      hunksTruncated = true;
      break;
    }
    const slice = ops.slice(start, Math.min(end + 1, start + (MAX_RENDER_LINES - emitted)));
    emitted += slice.length;
    if (start + slice.length - 1 < end) {
      hunksTruncated = true;
    }
    const firstOld = slice.find((l) => l.oldLine !== null)?.oldLine ?? 1;
    const firstNew = slice.find((l) => l.newLine !== null)?.newLine ?? 1;
    hunks.push({
      header: `Lines ${firstOld} → ${firstNew}`,
      lines: slice
    });
  }

  return {
    languageHint,
    addedLines,
    removedLines,
    hunks,
    hunksTruncated
  };
}

export function deriveHumanLabelForChangedPath(
  filePath: string,
  beforeText: string | null,
  afterText: string | null
): string {
  if (filePath.endsWith('.md')) {
    const source = afterText ?? beforeText ?? '';
    return extractDocumentTitle(source, filePath);
  }
  if (filePath.endsWith('.comments.json')) {
    const docRel = filePath.replace(/\.comments\.json$/, '.md');
    const base = docRel.split('/').pop()?.replace(/\.md$/i, '') ?? docRel;
    return `Review comments · ${base}`;
  }
  const embedMatch = /^embeds\/([^/]+)\/(.+)$/.exec(filePath);
  if (embedMatch) {
    return `Component · ${embedMatch[1]} (${embedMatch[2]})`;
  }
  return filePath.split('/').pop() ?? filePath;
}
