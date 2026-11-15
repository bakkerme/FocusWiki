import { Node, mergeAttributes } from '@tiptap/core';
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps
} from '@tiptap/react';
import { useState } from 'react';

function RawBlockView({ node, updateAttributes }: NodeViewProps) {
  const kind = String(node.attrs.kind ?? 'markdown');
  const raw = String(node.attrs.raw ?? '');
  const [expanded, setExpanded] = useState<boolean>(false);

  return (
    <NodeViewWrapper className="preserved-raw-block" contentEditable={false}>
      <div className="preserved-raw-header">
        <span>Preserved Markdown construct ({kind})</span>
        <button
          type="button"
          className="btn btn-compact"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Collapse raw source' : 'Inspect / edit raw'}
        </button>
      </div>
      {expanded ? (
        <textarea
          className="preserved-raw-textarea"
          rows={Math.min(10, Math.max(3, raw.split('\n').length + 1))}
          value={raw}
          onChange={(e) => updateAttributes({ raw: e.target.value })}
        />
      ) : (
        <div
          style={{
            fontFamily: 'var(--font-code)',
            fontSize: 12,
            color: 'var(--ink-secondary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {raw.replace(/\s+/g, ' ').slice(0, 120)}
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const RawMarkdownBlockExtension = Node.create({
  name: 'rawMarkdownBlock',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      kind: { default: 'raw' },
      raw: { default: '' }
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-raw-md-block]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-raw-md-block': 'true' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(RawBlockView);
  }
});

function RawInlineView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper as="span" className="preserved-raw-inline" contentEditable={false}>
      {String(node.attrs.raw ?? '')}
    </NodeViewWrapper>
  );
}

export const RawMarkdownInlineExtension = Node.create({
  name: 'rawMarkdownInline',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      kind: { default: 'inline' },
      raw: { default: '' }
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-raw-md-inline]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-raw-md-inline': 'true' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(RawInlineView);
  }
});
