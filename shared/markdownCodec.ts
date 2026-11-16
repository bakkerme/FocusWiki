import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkStringify from 'remark-stringify';
import type {
  Root,
  RootContent,
  PhrasingContent,
  TableRow as MdastTableRow,
  TableCell as MdastTableCell,
  ListItem as MdastListItem,
  AlignType
} from 'mdast';
import type { EmbedDescriptor, ProseMirrorMark, ProseMirrorNode } from './types.js';

export function parseEmbedBlockText(rawValue: string): EmbedDescriptor | null {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;

  // Support pure JSON body if authored by a bot as JSON
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.src === 'string' && parsed.src.trim()) {
        return {
          src: parsed.src.trim(),
          title: typeof parsed.title === 'string' ? parsed.title : parsed.src.trim(),
          height: typeof parsed.height === 'number' && parsed.height >= 120 ? parsed.height : 420,
          props:
            parsed.props && typeof parsed.props === 'object' && !Array.isArray(parsed.props)
              ? (parsed.props as Record<string, unknown>)
              : {}
        };
      }
    } catch {
      return null;
    }
  }

  // Standard readable key: value lines
  const map: Record<string, string> = {};
  for (const line of trimmed.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || clean.startsWith('#')) continue;
    const colonIdx = clean.indexOf(':');
    if (colonIdx === -1) return null;
    const key = clean.slice(0, colonIdx).trim();
    const val = clean.slice(colonIdx + 1).trim();
    map[key] = val;
  }

  if (!map.src) return null;

  let props: Record<string, unknown> = {};
  if (map.props) {
    try {
      const parsedProps = JSON.parse(map.props);
      if (parsedProps && typeof parsedProps === 'object' && !Array.isArray(parsedProps)) {
        props = parsedProps as Record<string, unknown>;
      } else {
        return null;
      }
    } catch {
      return null;
    }
  }

  const parsedHeight = map.height ? Number(map.height) : 420;
  return {
    src: map.src,
    title: map.title || map.src,
    height: Number.isFinite(parsedHeight) && parsedHeight >= 120 ? Math.round(parsedHeight) : 420,
    props
  };
}

export function formatEmbedBlockText(desc: EmbedDescriptor): string {
  const lines = [
    `src: ${desc.src.trim()}`,
    `title: ${(desc.title || desc.src).trim()}`,
    `height: ${Math.max(120, Math.round(desc.height || 420))}`
  ];
  const propsKeys = Object.keys(desc.props ?? {});
  if (propsKeys.length > 0) {
    lines.push(`props: ${JSON.stringify(desc.props)}`);
  }
  return lines.join('\n');
}

export function extractDocumentTitle(markdown: string, fallbackPath: string): string {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .parse(markdown);

  for (const node of tree.children) {
    if (node.type === 'heading' && node.depth === 1) {
      const text = node.children
        .map((c) => ('value' in c ? String(c.value) : ''))
        .join('')
        .trim();
      if (text) return text;
    }
  }
  const base = fallbackPath.split('/').pop() ?? fallbackPath;
  return base.replace(/\.md$/i, '');
}

export function markdownToProseMirror(markdown: string): ProseMirrorNode {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .parse(normalized);

  function sliceRaw(node: { position?: { start?: { offset?: number }; end?: { offset?: number } } }): string {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (typeof start === 'number' && typeof end === 'number') {
      return normalized.slice(start, end);
    }
    return '';
  }

  function convertInline(nodes: PhrasingContent[], activeMarks: ProseMirrorMark[] = []): ProseMirrorNode[] {
    const out: ProseMirrorNode[] = [];

    for (const node of nodes) {
      switch (node.type) {
        case 'text': {
          if (node.value.length > 0) {
            const item: ProseMirrorNode = { type: 'text', text: node.value };
            if (activeMarks.length > 0) item.marks = [...activeMarks];
            out.push(item);
          }
          break;
        }
        case 'inlineCode': {
          if (node.value.length > 0) {
            out.push({
              type: 'text',
              text: node.value,
              marks: [...activeMarks, { type: 'code' }]
            });
          }
          break;
        }
        case 'strong': {
          out.push(...convertInline(node.children, [...activeMarks, { type: 'bold' }]));
          break;
        }
        case 'emphasis': {
          out.push(...convertInline(node.children, [...activeMarks, { type: 'italic' }]));
          break;
        }
        case 'delete': {
          out.push(...convertInline(node.children, [...activeMarks, { type: 'strike' }]));
          break;
        }
        case 'link': {
          const linkMark: ProseMirrorMark = {
            type: 'link',
            attrs: {
              href: node.url,
              title: node.title ?? null,
              target: node.url.startsWith('http') ? '_blank' : null
            }
          };
          out.push(...convertInline(node.children, [...activeMarks, linkMark]));
          break;
        }
        case 'break': {
          out.push({ type: 'hardBreak' });
          break;
        }
        default: {
          const raw = sliceRaw(node) || ('value' in node ? String(node.value) : '');
          if (raw) {
            out.push({
              type: 'rawMarkdownInline',
              attrs: {
                kind: node.type,
                raw
              }
            });
          }
          break;
        }
      }
    }

    return out;
  }

  function convertBlocks(nodes: RootContent[]): ProseMirrorNode[] {
    const out: ProseMirrorNode[] = [];

    for (const node of nodes) {
      switch (node.type) {
        case 'heading': {
          const content = convertInline(node.children);
          out.push({
            type: 'heading',
            attrs: { level: node.depth },
            ...(content.length > 0 ? { content } : {})
          });
          break;
        }
        case 'paragraph': {
          const content = convertInline(node.children);
          out.push({
            type: 'paragraph',
            ...(content.length > 0 ? { content } : {})
          });
          break;
        }
        case 'blockquote': {
          const inner = convertBlocks(node.children);
          out.push({
            type: 'blockquote',
            content: inner.length > 0 ? inner : [{ type: 'paragraph' }]
          });
          break;
        }
        case 'list': {
          const isTaskList =
            node.children.length > 0 &&
            node.children.every((item) => item.checked === true || item.checked === false);

          if (isTaskList) {
            out.push({
              type: 'taskList',
              content: node.children.map((item) => {
                const children = convertBlocks(item.children);
                return {
                  type: 'taskItem',
                  attrs: { checked: Boolean(item.checked) },
                  content: children.length > 0 ? children : [{ type: 'paragraph' }]
                };
              })
            });
          } else if (node.ordered) {
            out.push({
              type: 'orderedList',
              attrs: { start: node.start ?? 1 },
              content: node.children.map((item) => {
                const children = convertBlocks(item.children);
                return {
                  type: 'listItem',
                  content: children.length > 0 ? children : [{ type: 'paragraph' }]
                };
              })
            });
          } else {
            out.push({
              type: 'bulletList',
              content: node.children.map((item) => {
                const children = convertBlocks(item.children);
                return {
                  type: 'listItem',
                  content: children.length > 0 ? children : [{ type: 'paragraph' }]
                };
              })
            });
          }
          break;
        }
        case 'code': {
          if (node.lang === 'embed') {
            const parsed = parseEmbedBlockText(node.value);
            if (parsed) {
              out.push({
                type: 'embedBlock',
                attrs: {
                  src: parsed.src,
                  title: parsed.title,
                  height: parsed.height,
                  propsJson: JSON.stringify(parsed.props)
                }
              });
              break;
            }
            // Malformed embed block: preserve verbatim as rawMarkdownBlock so nothing is lost
            out.push({
              type: 'rawMarkdownBlock',
              attrs: {
                kind: 'embed-raw',
                raw: sliceRaw(node) || `\`\`\`embed\n${node.value}\n\`\`\``
              }
            });
            break;
          }
          out.push({
            type: 'codeBlock',
            attrs: { language: node.lang ?? null },
            ...(node.value.length > 0 ? { content: [{ type: 'text', text: node.value }] } : {})
          });
          break;
        }
        case 'thematicBreak': {
          out.push({ type: 'horizontalRule' });
          break;
        }
        case 'table': {
          const aligns = node.align ?? [];
          const rows: ProseMirrorNode[] = node.children.map((row, rowIndex) => {
            const cellType = rowIndex === 0 ? 'tableHeader' : 'tableCell';
            const cells: ProseMirrorNode[] = row.children.map((cell, colIndex) => {
              const inline = convertInline(cell.children);
              return {
                type: cellType,
                attrs: {
                  colspan: 1,
                  rowspan: 1,
                  colwidth: null,
                  align: aligns[colIndex] ?? null
                },
                content: [
                  {
                    type: 'paragraph',
                    ...(inline.length > 0 ? { content: inline } : {})
                  }
                ]
              };
            });
            return {
              type: 'tableRow',
              content: cells
            };
          });
          if (rows.length > 0) {
            out.push({
              type: 'table',
              content: rows
            });
          }
          break;
        }
        default: {
          const raw = sliceRaw(node) || ('value' in node ? String(node.value) : '');
          if (raw) {
            out.push({
              type: 'rawMarkdownBlock',
              attrs: {
                kind: node.type,
                raw
              }
            });
          }
          break;
        }
      }
    }

    return out;
  }

  const blocks = convertBlocks(tree.children);
  return {
    type: 'doc',
    content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }]
  };
}

function markKey(mark: ProseMirrorMark): string {
  if (mark.type === 'link') {
    return `link:${String(mark.attrs?.href ?? '')}:${String(mark.attrs?.title ?? '')}`;
  }
  return mark.type;
}

function wrapWithMark(mark: ProseMirrorMark, children: PhrasingContent[]): PhrasingContent {
  switch (mark.type) {
    case 'bold':
      return { type: 'strong', children };
    case 'italic':
      return { type: 'emphasis', children };
    case 'strike':
      return { type: 'delete', children };
    case 'link':
      return {
        type: 'link',
        url: String(mark.attrs?.href ?? ''),
        title: mark.attrs?.title ? String(mark.attrs.title) : null,
        children
      };
    default:
      return children[0];
  }
}

interface MarkedInlineRun {
  leaf: PhrasingContent;
  wrapperMarks: ProseMirrorMark[];
}

function groupInlineRuns(runs: MarkedInlineRun[]): PhrasingContent[] {
  const result: PhrasingContent[] = [];
  let i = 0;

  while (i < runs.length) {
    const first = runs[i];
    if (first.wrapperMarks.length === 0) {
      result.push(first.leaf);
      i++;
      continue;
    }

    const outerMark = first.wrapperMarks[0];
    const outerKey = markKey(outerMark);
    const group: MarkedInlineRun[] = [];

    while (
      i < runs.length &&
      runs[i].wrapperMarks.length > 0 &&
      markKey(runs[i].wrapperMarks[0]) === outerKey
    ) {
      group.push({
        leaf: runs[i].leaf,
        wrapperMarks: runs[i].wrapperMarks.slice(1)
      });
      i++;
    }

    const innerChildren = groupInlineRuns(group);
    result.push(wrapWithMark(outerMark, innerChildren));
  }

  return result;
}

function convertPmInlineToMdast(nodes: ProseMirrorNode[] | undefined): PhrasingContent[] {
  if (!nodes || nodes.length === 0) return [];
  const runs: MarkedInlineRun[] = [];

  for (const node of nodes) {
    if (node.type === 'hardBreak') {
      runs.push({ leaf: { type: 'break' }, wrapperMarks: [] });
      continue;
    }
    if (node.type === 'rawMarkdownInline') {
      runs.push({
        leaf: { type: 'html', value: String(node.attrs?.raw ?? '') },
        wrapperMarks: []
      });
      continue;
    }
    if (node.type === 'text' && typeof node.text === 'string' && node.text.length > 0) {
      const marks = node.marks ?? [];
      const hasCode = marks.some((m) => m.type === 'code');
      const wrapperMarks = marks.filter((m) => m.type !== 'code');
      const leaf: PhrasingContent = hasCode
        ? { type: 'inlineCode', value: node.text }
        : { type: 'text', value: node.text };
      runs.push({ leaf, wrapperMarks });
    }
  }

  return groupInlineRuns(runs);
}

function convertPmBlocksToMdast(nodes: ProseMirrorNode[] | undefined): RootContent[] {
  if (!nodes || nodes.length === 0) return [];
  const out: RootContent[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case 'heading': {
        const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1))) as 1 | 2 | 3 | 4 | 5 | 6;
        out.push({
          type: 'heading',
          depth: level,
          children: convertPmInlineToMdast(node.content)
        });
        break;
      }
      case 'paragraph': {
        const children = convertPmInlineToMdast(node.content);
        if (children.length > 0) {
          out.push({
            type: 'paragraph',
            children
          });
        }
        break;
      }
      case 'blockquote': {
        const inner = convertPmBlocksToMdast(node.content);
        out.push({
          type: 'blockquote',
          children: inner.length > 0 ? (inner as never[]) : [{ type: 'paragraph', children: [] }]
        });
        break;
      }
      case 'bulletList': {
        const items: MdastListItem[] = (node.content ?? []).map((item) => ({
          type: 'listItem',
          spread: false,
          children: convertPmBlocksToMdast(item.content) as never[]
        }));
        out.push({
          type: 'list',
          ordered: false,
          spread: false,
          children: items
        });
        break;
      }
      case 'orderedList': {
        const start = Number(node.attrs?.start ?? 1);
        const items: MdastListItem[] = (node.content ?? []).map((item) => ({
          type: 'listItem',
          spread: false,
          children: convertPmBlocksToMdast(item.content) as never[]
        }));
        out.push({
          type: 'list',
          ordered: true,
          start: Number.isFinite(start) ? start : 1,
          spread: false,
          children: items
        });
        break;
      }
      case 'taskList': {
        const items: MdastListItem[] = (node.content ?? []).map((item) => ({
          type: 'listItem',
          checked: Boolean(item.attrs?.checked),
          spread: false,
          children: convertPmBlocksToMdast(item.content) as never[]
        }));
        out.push({
          type: 'list',
          ordered: false,
          spread: false,
          children: items
        });
        break;
      }
      case 'codeBlock': {
        const value = (node.content ?? []).map((c) => c.text ?? '').join('');
        out.push({
          type: 'code',
          lang: node.attrs?.language ? String(node.attrs.language) : null,
          value
        });
        break;
      }
      case 'embedBlock': {
        let props: Record<string, unknown> = {};
        if (typeof node.attrs?.propsJson === 'string' && node.attrs.propsJson.trim()) {
          try {
            props = JSON.parse(node.attrs.propsJson) as Record<string, unknown>;
          } catch {
            props = {};
          }
        }
        const desc: EmbedDescriptor = {
          src: String(node.attrs?.src ?? ''),
          title: String(node.attrs?.title ?? node.attrs?.src ?? ''),
          height: Number(node.attrs?.height ?? 420),
          props
        };
        out.push({
          type: 'code',
          lang: 'embed',
          value: formatEmbedBlockText(desc)
        });
        break;
      }
      case 'horizontalRule': {
        out.push({ type: 'thematicBreak' });
        break;
      }
      case 'table': {
        const pmRows = node.content ?? [];
        const firstRowCells = pmRows[0]?.content ?? [];
        const align: AlignType[] = firstRowCells.map((cell) => {
          const a = cell.attrs?.align;
          if (a === 'left' || a === 'center' || a === 'right') return a;
          return null;
        });

        const mdRows: MdastTableRow[] = pmRows.map((row) => {
          const mdCells: MdastTableCell[] = (row.content ?? []).map((cell) => {
            const inlineParts: PhrasingContent[] = [];
            for (const block of cell.content ?? []) {
              if (block.type === 'paragraph') {
                if (inlineParts.length > 0) inlineParts.push({ type: 'text', value: ' ' });
                inlineParts.push(...convertPmInlineToMdast(block.content));
              }
            }
            return {
              type: 'tableCell',
              children: inlineParts
            };
          });
          return {
            type: 'tableRow',
            children: mdCells
          };
        });

        out.push({
          type: 'table',
          align,
          children: mdRows
        });
        break;
      }
      case 'rawMarkdownBlock': {
        const raw = String(node.attrs?.raw ?? '').trimEnd();
        if (raw) {
          out.push({
            type: 'html',
            value: raw
          });
        }
        break;
      }
      default:
        break;
    }
  }

  return out;
}

export function proseMirrorToMarkdown(doc: ProseMirrorNode, baseMarkdown?: string): string {
  const stringifyMdastNodes = (children: RootContent[]): string => {
    const root: Root = {
      type: 'root',
      children
    };
    return unified()
      .use(remarkGfm)
      .use(remarkFrontmatter, ['yaml', 'toml'])
      .use(remarkStringify, {
        bullet: '-',
        fences: true,
        listItemIndent: 'one',
        rule: '-'
      })
      .stringify(root);
  };

  if (typeof baseMarkdown === 'string' && baseMarkdown.length > 0) {
    const normalizedBase = baseMarkdown.replace(/\r\n/g, '\n');
    const baseTree = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkFrontmatter, ['yaml', 'toml'])
      .parse(normalizedBase);

    const basePmDoc = markdownToProseMirror(normalizedBase);
    const basePmBlocks = basePmDoc.content ?? [];

    if (
      baseTree.children.length > 0 &&
      baseTree.children.length === basePmBlocks.length &&
      baseTree.children.every(
        (n) =>
          typeof n.position?.start?.offset === 'number' &&
          typeof n.position?.end?.offset === 'number'
      )
    ) {
      const baseSlices = baseTree.children.map((mdNode, idx) => {
        const start = mdNode.position!.start!.offset!;
        const end = mdNode.position!.end!.offset!;
        const mdastCanonical = convertPmBlocksToMdast([basePmBlocks[idx]]);
        return {
          key: JSON.stringify(mdastCanonical),
          raw: normalizedBase.slice(start, end),
          start,
          end
        };
      });

      const rawDocBlocks = doc.content ?? [];
      const liveBlocks = rawDocBlocks.filter((b) => convertPmBlocksToMdast([b]).length > 0);

      if (liveBlocks.length > 0) {
        const liveMdastPerBlock = liveBlocks.map((b) => convertPmBlocksToMdast([b]));
        const liveKeys = liveMdastPerBlock.map((m) => JSON.stringify(m));

        const mLen = baseSlices.length;
        const nLen = liveKeys.length;
        const matchedBaseForLive = new Array<number>(nLen).fill(-1);

        if (mLen * nLen <= 250_000) {
          const dp: Uint16Array[] = Array.from(
            { length: mLen + 1 },
            () => new Uint16Array(nLen + 1)
          );
          for (let i = mLen - 1; i >= 0; i--) {
            for (let j = nLen - 1; j >= 0; j--) {
              if (baseSlices[i].key === liveKeys[j]) {
                dp[i][j] = dp[i + 1][j + 1] + 1;
              } else {
                dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
              }
            }
          }
          let i = 0;
          let j = 0;
          while (i < mLen && j < nLen) {
            if (baseSlices[i].key === liveKeys[j]) {
              matchedBaseForLive[j] = i;
              i++;
              j++;
            } else if (dp[i + 1][j] >= dp[i][j + 1]) {
              i++;
            } else {
              j++;
            }
          }
        } else {
          let searchFrom = 0;
          for (let j = 0; j < nLen; j++) {
            for (let i = searchFrom; i < mLen; i++) {
              if (baseSlices[i].key === liveKeys[j]) {
                matchedBaseForLive[j] = i;
                searchFrom = i + 1;
                break;
              }
            }
          }
        }

        if (
          mLen === nLen &&
          matchedBaseForLive.every((baseIdx, liveIdx) => baseIdx === liveIdx)
        ) {
          return normalizedBase.endsWith('\n') ? normalizedBase : `${normalizedBase}\n`;
        }

        const outParts: string[] = [];
        const firstMatch = matchedBaseForLive[0];
        if (firstMatch === 0 && baseSlices[0].start > 0) {
          const leading = normalizedBase.slice(0, baseSlices[0].start);
          if (/^\s+$/.test(leading)) {
            outParts.push(leading);
          }
        }

        for (let j = 0; j < nLen; j++) {
          if (j > 0) {
            const prevMatch = matchedBaseForLive[j - 1];
            const curMatch = matchedBaseForLive[j];
            if (prevMatch !== -1 && curMatch === prevMatch + 1) {
              const between = normalizedBase.slice(
                baseSlices[prevMatch].end,
                baseSlices[curMatch].start
              );
              outParts.push(between.includes('\n') ? between : '\n\n');
            } else {
              outParts.push('\n\n');
            }
          }

          const curMatch = matchedBaseForLive[j];
          if (curMatch !== -1) {
            outParts.push(baseSlices[curMatch].raw);
          } else {
            outParts.push(stringifyMdastNodes(liveMdastPerBlock[j]).trimEnd());
          }
        }

        const joined = outParts.join('');
        return joined.endsWith('\n') ? joined : `${joined}\n`;
      }
    }
  }

  const rendered = stringifyMdastNodes(convertPmBlocksToMdast(doc.content));
  return rendered.endsWith('\n') ? rendered : `${rendered}\n`;
}
