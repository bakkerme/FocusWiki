import { useEffect, useImperativeHandle, forwardRef, useRef } from 'react';
import { EditorContent, useEditor, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import type {
  CommentAnchor,
  EmbedDescriptor,
  ProseMirrorNode,
  ResolvedCommentThread
} from '../../shared/types';
import { markdownToProseMirror, proseMirrorToMarkdown } from '../../shared/markdownCodec';
import { EmbedBlockExtension } from './EmbedBlockExtension';
import {
  RawMarkdownBlockExtension,
  RawMarkdownInlineExtension
} from './RawMarkdownExtension';
import {
  CommentHighlightExtension,
  commentHighlightPluginKey,
  extractAnchorFromSelection,
  extractLiveProseBlocks
} from './CommentHighlightExtension';
import { buildAnchorFromBlockSelection } from '../../shared/anchorResolver';

const AlignedTableHeader = TableHeader.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      align: { default: null }
    };
  }
});

const AlignedTableCell = TableCell.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      align: { default: null }
    };
  }
});

export interface VisualEditorHandle {
  insertEmbedBlock: (desc: EmbedDescriptor) => void;
  replaceMarkdownFromExternal: (markdown: string) => void;
}

interface Props {
  docKey: string;
  initialMarkdown: string;
  threads: ResolvedCommentThread[];
  activeThreadId: string | null;
  showResolvedComments: boolean;
  onMarkdownEdited: (nextMarkdown: string) => void;
  onSelectionAnchorChange: (anchor: CommentAnchor | null) => void;
  onStartCommentWithAnchor: (anchor: CommentAnchor | null) => void;
  onSelectThread: (threadId: string) => void;
  onOpenInsertEmbedModal: () => void;
  onNavigateDoc: (docPath: string) => void;
  onTriggerImmediateSave: () => void;
}

export const VisualMarkdownEditor = forwardRef<VisualEditorHandle, Props>(
  function VisualMarkdownEditor(props, ref) {
    const {
      docKey,
      initialMarkdown,
      threads,
      activeThreadId,
      showResolvedComments,
      onMarkdownEdited,
      onSelectionAnchorChange,
      onStartCommentWithAnchor,
      onSelectThread,
      onOpenInsertEmbedModal,
      onNavigateDoc,
      onTriggerImmediateSave
    } = props;

    const suppressUpdateRef = useRef<boolean>(false);
    const activeDocKeyRef = useRef<string>(docKey);

    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3, 4] }
        }),
        Link.configure({
          openOnClick: false,
          autolink: true
        }),
        Placeholder.configure({
          placeholder: 'Write documentation prose or insert a project embed…'
        }),
        Table.configure({ resizable: false }),
        TableRow,
        AlignedTableHeader,
        AlignedTableCell,
        TaskList,
        TaskItem.configure({ nested: true }),
        EmbedBlockExtension,
        RawMarkdownBlockExtension,
        RawMarkdownInlineExtension,
        CommentHighlightExtension.configure({
          onSelectThread
        })
      ],
      content: markdownToProseMirror(initialMarkdown) as JSONContent,
      onUpdate({ editor: ed }) {
        if (suppressUpdateRef.current) return;
        const json = ed.getJSON() as ProseMirrorNode;
        const nextMd = proseMirrorToMarkdown(json);
        onMarkdownEdited(nextMd);
      },
      onSelectionUpdate({ editor: ed }) {
        const anchor = extractAnchorFromSelection(ed.state);
        onSelectionAnchorChange(anchor);
      },
      editorProps: {
        handleKeyDown(_view, event) {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            onTriggerImmediateSave();
            return true;
          }
          if (event.altKey && event.key.toLowerCase() === 'c') {
            event.preventDefault();
            onStartCommentWithAnchor(
              editor ? extractAnchorFromSelection(editor.state) : null
            );
            return true;
          }
          return false;
        },
        handleClick(_view, _pos, event) {
          const target = event.target as HTMLElement | null;
          const anchorEl = target?.closest?.('a') as HTMLAnchorElement | null;
          const href = anchorEl?.getAttribute('href');
          if (href && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (href.startsWith('http://') || href.startsWith('https://')) {
              window.open(href, '_blank', 'noopener,noreferrer');
            } else if (href.endsWith('.md')) {
              onNavigateDoc(href);
            }
            return true;
          }
          return false;
        }
      }
    });

    // Reload content cleanly when switching documents
    useEffect(() => {
      if (!editor) return;
      if (activeDocKeyRef.current !== docKey) {
        activeDocKeyRef.current = docKey;
        suppressUpdateRef.current = true;
        editor.commands.setContent(markdownToProseMirror(initialMarkdown) as JSONContent, false);
        suppressUpdateRef.current = false;
        onSelectionAnchorChange(null);
      }
    }, [docKey, initialMarkdown, editor, onSelectionAnchorChange]);

    // Sync comment thread highlights into ProseMirror plugin state
    useEffect(() => {
      if (!editor) return;
      const tr = editor.state.tr.setMeta(commentHighlightPluginKey, {
        threads,
        activeThreadId,
        showResolved: showResolvedComments
      });
      editor.view.dispatch(tr);
    }, [editor, threads, activeThreadId, showResolvedComments]);

    useImperativeHandle(ref, () => ({
      insertEmbedBlock(desc: EmbedDescriptor) {
        if (!editor) return;
        editor
          .chain()
          .focus()
          .insertContent({
            type: 'embedBlock',
            attrs: {
              src: desc.src,
              title: desc.title,
              height: desc.height,
              propsJson: JSON.stringify(desc.props ?? {})
            }
          })
          .run();
      },
      replaceMarkdownFromExternal(markdown: string) {
        if (!editor) return;
        suppressUpdateRef.current = true;
        editor.commands.setContent(markdownToProseMirror(markdown) as JSONContent, false);
        suppressUpdateRef.current = false;
      }
    }));

    if (!editor) {
      return <div className="sheet-scroll">Loading editor…</div>;
    }

    const activeLinkHref = editor.isActive('link')
      ? String(editor.getAttributes('link').href ?? '')
      : '';

    function promptForLink() {
      if (!editor) return;
      const previousUrl = String(editor.getAttributes('link').href ?? '');
      const url = window.prompt('Link URL or relative document path (leave empty to remove):', previousUrl);
      if (url === null) return;
      if (url.trim() === '') {
        editor.chain().focus().extendMarkRange('link').unsetLink().run();
        return;
      }
      editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
    }

    function handleCommentButtonClick() {
      if (!editor) return;
      let anchor = extractAnchorFromSelection(editor.state);
      if (!anchor) {
        const domQuote = window.getSelection()?.toString().trim() ?? '';
        if (domQuote) {
          const blocks = extractLiveProseBlocks(editor.state.doc);
          const matching = blocks.filter((b) => b.text.includes(domQuote));
          if (matching.length === 1) {
            const idx = matching[0].text.indexOf(domQuote);
            anchor = buildAnchorFromBlockSelection(matching[0], idx, idx + domQuote.length);
          } else {
            anchor = { quote: domQuote, prefix: '', suffix: '' };
          }
        }
      }
      onSelectionAnchorChange(anchor);
      onStartCommentWithAnchor(anchor);
    }

    return (
      <>
        <div
          className="editor-toolbar"
          role="toolbar"
          aria-label="Document formatting controls"
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest('button')) {
              e.preventDefault();
            }
          }}
        >
          <button
            type="button"
            className={`tool-btn ${editor.isActive('heading', { level: 1 }) ? 'is-active' : ''}`}
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          >
            H1
          </button>
          <button
            type="button"
            className={`tool-btn ${editor.isActive('heading', { level: 2 }) ? 'is-active' : ''}`}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            H2
          </button>
          <button
            type="button"
            className={`tool-btn ${editor.isActive('heading', { level: 3 }) ? 'is-active' : ''}`}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          >
            H3
          </button>
          <div className="tool-divider" />
          <button
            type="button"
            className={`tool-btn ${editor.isActive('bold') ? 'is-active' : ''}`}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            Bold
          </button>
          <button
            type="button"
            className={`tool-btn ${editor.isActive('italic') ? 'is-active' : ''}`}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            Italic
          </button>
          <button
            type="button"
            className={`tool-btn ${editor.isActive('code') ? 'is-active' : ''}`}
            onClick={() => editor.chain().focus().toggleCode().run()}
          >
            Code
          </button>
          <button
            type="button"
            className={`tool-btn ${editor.isActive('link') ? 'is-active' : ''}`}
            onClick={promptForLink}
          >
            Link
          </button>
          {activeLinkHref && activeLinkHref.endsWith('.md') && (
            <button
              type="button"
              className="btn btn-compact"
              onClick={() => onNavigateDoc(activeLinkHref)}
            >
              Open {activeLinkHref}
            </button>
          )}
          <div className="tool-divider" />
          <button
            type="button"
            className={`tool-btn ${editor.isActive('bulletList') ? 'is-active' : ''}`}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            Bullets
          </button>
          <button
            type="button"
            className={`tool-btn ${editor.isActive('orderedList') ? 'is-active' : ''}`}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            Numbered
          </button>
          <button
            type="button"
            className={`tool-btn ${editor.isActive('taskList') ? 'is-active' : ''}`}
            onClick={() => editor.chain().focus().toggleTaskList().run()}
          >
            Checklist
          </button>
          <button
            type="button"
            className={`tool-btn ${editor.isActive('blockquote') ? 'is-active' : ''}`}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          >
            Quote
          </button>
          <button
            type="button"
            className={`tool-btn ${editor.isActive('codeBlock') ? 'is-active' : ''}`}
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          >
            Code block
          </button>
          <button
            type="button"
            className="tool-btn"
            onClick={() =>
              editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
            }
          >
            Table
          </button>
          <div className="tool-divider" />
          <button
            type="button"
            className="btn btn-compact"
            onClick={onOpenInsertEmbedModal}
          >
            Insert embed
          </button>
          <button
            type="button"
            className="btn btn-compact btn-primary"
            onClick={handleCommentButtonClick}
            title="Comment on selected prose (Alt+C)"
          >
            Comment on selection
          </button>
        </div>

        <div className="sheet-scroll">
          <div className="prose-container">
            <EditorContent editor={editor} />
          </div>
        </div>
      </>
    );
  }
);
