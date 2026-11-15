import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { CommentAnchor, ResolvedCommentThread } from '../../shared/types';
import {
  buildAnchorFromBlockSelection,
  resolveAnchorInBlocks,
  type ExtractedTextBlock
} from '../../shared/anchorResolver';

export interface LiveProseBlock extends ExtractedTextBlock {
  /** Maps each character index [0..text.length] to its exact ProseMirror document position */
  charToPos: number[];
}

export function extractLiveProseBlocks(doc: PmNode): LiveProseBlock[] {
  const blocks: LiveProseBlock[] = [];
  let currentHeading = '';

  function collectBlockTextAndPositions(blockNode: PmNode, blockContentStart: number): {
    text: string;
    charToPos: number[];
  } {
    let text = '';
    const charToPos: number[] = [];

    blockNode.descendants((child, relPos) => {
      const absPos = blockContentStart + relPos;
      if (child.isText && child.text) {
        for (let i = 0; i < child.text.length; i++) {
          charToPos.push(absPos + i);
        }
        text += child.text;
        return false;
      }
      if (child.type.name === 'hardBreak') {
        charToPos.push(absPos);
        text += '\n';
        return false;
      }
      if (child.type.name === 'rawMarkdownInline') {
        const raw = String(child.attrs.raw ?? '');
        for (let i = 0; i < raw.length; i++) {
          charToPos.push(absPos);
        }
        text += raw;
        return false;
      }
      return true;
    });

    charToPos.push(blockContentStart + blockNode.content.size);
    return { text, charToPos };
  }

  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const { text, charToPos } = collectBlockTextAndPositions(node, pos + 1);
      currentHeading = text.trim();
      blocks.push({
        blockIndex: blocks.length,
        type: 'heading',
        headingContext: currentHeading,
        text,
        charToPos
      });
      return false;
    }
    if (node.type.name === 'paragraph') {
      const { text, charToPos } = collectBlockTextAndPositions(node, pos + 1);
      blocks.push({
        blockIndex: blocks.length,
        type: 'paragraph',
        headingContext: currentHeading,
        text,
        charToPos
      });
      return false;
    }
    if (
      node.type.name === 'codeBlock' ||
      node.type.name === 'embedBlock' ||
      node.type.name === 'rawMarkdownBlock'
    ) {
      return false;
    }
    return true;
  });

  return blocks;
}

export function extractAnchorFromSelection(state: EditorState): CommentAnchor | null {
  const { from, to, empty } = state.selection;
  if (empty || to <= from) return null;

  const liveBlocks = extractLiveProseBlocks(state.doc);
  for (const blk of liveBlocks) {
    if (blk.charToPos.length < 2) continue;
    const blockStart = blk.charToPos[0];
    const blockEnd = blk.charToPos[blk.charToPos.length - 1];
    if (from >= blockStart && to <= blockEnd) {
      let startChar = -1;
      let endChar = -1;
      for (let idx = 0; idx < blk.charToPos.length - 1; idx++) {
        const p = blk.charToPos[idx];
        if (startChar === -1 && p >= from) startChar = idx;
        if (p < to) endChar = idx + 1;
      }
      if (startChar !== -1 && endChar > startChar) {
        const anchor = buildAnchorFromBlockSelection(blk, startChar, endChar);
        if (anchor.quote.trim().length > 0) {
          return anchor;
        }
      }
    }
  }

  // Fallback across blocks if user selected prose spanning two paragraphs
  const rawQuote = state.doc.textBetween(from, to, '\n').trim();
  if (!rawQuote) return null;
  return {
    quote: rawQuote,
    prefix: '',
    suffix: ''
  };
}

export const commentHighlightPluginKey = new PluginKey<{
  threads: ResolvedCommentThread[];
  activeThreadId: string | null;
  showResolved: boolean;
}>('cairnCommentHighlights');

export const CommentHighlightExtension = Extension.create<{
  onSelectThread: (threadId: string) => void;
}>({
  name: 'commentHighlights',

  addOptions() {
    return {
      onSelectThread: () => {}
    };
  },

  addProseMirrorPlugins() {
    const onSelectThread = this.options.onSelectThread;

    return [
      new Plugin({
        key: commentHighlightPluginKey,
        state: {
          init() {
            return {
              threads: [] as ResolvedCommentThread[],
              activeThreadId: null as string | null,
              showResolved: false
            };
          },
          apply(tr, prev) {
            const meta = tr.getMeta(commentHighlightPluginKey);
            if (meta) {
              return { ...prev, ...meta };
            }
            return prev;
          }
        },
        props: {
          decorations(state) {
            const pluginState = commentHighlightPluginKey.getState(state);
            if (!pluginState || pluginState.threads.length === 0) {
              return DecorationSet.empty;
            }

            const visibleThreads = pluginState.threads.filter(
              (t) => t.status === 'open' || pluginState.showResolved || t.id === pluginState.activeThreadId
            );
            if (visibleThreads.length === 0) return DecorationSet.empty;

            const liveBlocks = extractLiveProseBlocks(state.doc);
            const decos: Decoration[] = [];

            for (const thread of visibleThreads) {
              const resolved = resolveAnchorInBlocks(thread.anchor, liveBlocks);
              if (
                resolved.anchorStatus === 'attached' &&
                typeof resolved.blockIndex === 'number' &&
                typeof resolved.blockOffset === 'number' &&
                typeof resolved.matchLength === 'number'
              ) {
                const blk = liveBlocks[resolved.blockIndex];
                if (!blk) continue;
                const fromPos = blk.charToPos[resolved.blockOffset];
                const endCharIdx = resolved.blockOffset + resolved.matchLength;
                const toPos =
                  endCharIdx < blk.charToPos.length - 1
                    ? blk.charToPos[endCharIdx]
                    : blk.charToPos[blk.charToPos.length - 1];

                if (typeof fromPos === 'number' && typeof toPos === 'number' && toPos > fromPos) {
                  const isSelected = thread.id === pluginState.activeThreadId;
                  decos.push(
                    Decoration.inline(fromPos, toPos, {
                      class: isSelected
                        ? 'cairn-comment-highlight is-selected'
                        : 'cairn-comment-highlight',
                      'data-thread-id': thread.id,
                      title: `Comment by ${thread.messages[0]?.author ?? 'Reviewer'}`
                    })
                  );
                }
              }
            }

            return DecorationSet.create(state.doc, decos);
          },
          handleClick(_view, _pos, event) {
            const target = event.target as HTMLElement | null;
            const highlightEl = target?.closest?.('[data-thread-id]') as HTMLElement | null;
            const threadId = highlightEl?.getAttribute('data-thread-id');
            if (threadId) {
              onSelectThread(threadId);
            }
            return false;
          }
        }
      })
    ];
  }
});
