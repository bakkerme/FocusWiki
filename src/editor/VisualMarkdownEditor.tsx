import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react';
import { EditorContent, useEditor, type JSONContent } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import Image from '@tiptap/extension-image';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import {
  Blocks,
  Bold,
  Code,
  ExternalLink,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  ImagePlus,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  MessageSquarePlus,
  Quote,
  SquareCode,
  Table as TableIcon
} from 'lucide-react';
import type {
  CommentAnchor,
  EmbedDescriptor,
  ProseMirrorNode,
  ResolvedCommentThread
} from '../../shared/types';
import { createHeadingSlugger, resolveMarkdownLink, resolveRepoRelativePath, markdownToProseMirror, proseMirrorToMarkdown } from '../../shared/markdownCodec';
import { EmbedBlockExtension } from './EmbedBlockExtension';
import {
  RawMarkdownBlockExtension,
  RawMarkdownInlineExtension
} from './RawMarkdownExtension';
import {
  CommentHighlightExtension,
  commentHighlightPluginKey,
  extractAnchorFromRange,
  extractAnchorFromSelection,
  extractLiveProseBlocks
} from './CommentHighlightExtension';
import { buildAnchorFromBlockSelection } from '../../shared/anchorResolver';

// Decorations add navigation targets without introducing presentation attributes into Markdown.
const HeadingAnchors = Extension.create({
  name: 'headingAnchors',
  addProseMirrorPlugins() {
    return [new Plugin({ props: {
      decorations(state) {
        const slug = createHeadingSlugger();
        const headings: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name === 'heading') headings.push(Decoration.node(pos, pos + node.nodeSize, { id: slug(node.textContent) }));
        });
        return DecorationSet.create(state.doc, headings);
      }
    } })];
  }
});

function imageDisplaySource(src: string, projectSlug: string, docPath: string): string | null {
  if (/^https?:\/\//i.test(src)) return src;
  const path = resolveRepoRelativePath(docPath, src);
  return path && projectSlug ? `/api/projects/${encodeURIComponent(projectSlug)}/assets/${path.split('/').map(encodeURIComponent).join('/')}` : null;
}

function scrollToHeading(root: HTMLElement | null, fragment: string) {
  const heading = Array.from(root?.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]') ?? []).find((el) => el.id === fragment);
  heading?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

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
  scrollToThreadAnchor: (threadId: string) => void;
}

interface Props {
  docKey: string;
  projectName?: string;
  projectSlug: string;
  navigationFragment?: string | null;
  docPath?: string;
  editable: boolean;
  initialMarkdown: string;
  threads: ResolvedCommentThread[];
  activeThreadId: string | null;
  showResolvedComments: boolean;
  onMarkdownEdited: (nextMarkdown: string) => void;
  onSelectionAnchorChange: (anchor: CommentAnchor | null) => void;
  onStartCommentWithAnchor: (anchor: CommentAnchor | null) => void;
  onSelectThread: (threadId: string) => void;
  onOpenInsertEmbedModal: () => void;
  onOpenRepoDetails?: () => void;
  onNavigateDoc: (docPath: string, fragment?: string | null) => void;
  onTriggerImmediateSave: () => void;
}

interface FloatingSelectionState {
  anchor: CommentAnchor;
  top: number;
  left: number;
}

export const VisualMarkdownEditor = forwardRef<VisualEditorHandle, Props>(
  function VisualMarkdownEditor(props, ref) {
    const {
      docKey,
      projectName,
      projectSlug,
      navigationFragment,
      docPath,
      editable,
      initialMarkdown,
      threads,
      activeThreadId,
      showResolvedComments,
      onMarkdownEdited,
      onSelectionAnchorChange,
      onStartCommentWithAnchor,
      onSelectThread,
      onOpenInsertEmbedModal,
      onOpenRepoDetails,
      onNavigateDoc,
      onTriggerImmediateSave
    } = props;

    const suppressUpdateRef = useRef<boolean>(false);
    const editableRef = useRef<boolean>(editable);
    const activeDocKeyRef = useRef<string>(docKey);
    const baseMarkdownRef = useRef<string>(initialMarkdown);
    const sheetScrollRef = useRef<HTMLDivElement | null>(null);
    const proseContainerRef = useRef<HTMLDivElement | null>(null);

    const imageContextRef = useRef({ projectSlug, docPath: docPath ?? '' });
    imageContextRef.current = { projectSlug, docPath: docPath ?? '' };
    const navigationRef = useRef({ docPath: docPath ?? '', onNavigateDoc });
    navigationRef.current = { docPath: docPath ?? '', onNavigateDoc };
    const [authoringPopover, setAuthoringPopover] = useState<'link' | 'image' | null>(null);
    const [urlInput, setUrlInput] = useState('');
    const [imageAlt, setImageAlt] = useState('');
    const [imageTitle, setImageTitle] = useState('');
    const [popoverError, setPopoverError] = useState<string | null>(null);
    const savedSelectionRef = useRef<{ from: number; to: number } | null>(null);
    const [selectionPopover, setSelectionPopover] = useState<FloatingSelectionState | null>(null);
    const [, forceToolbarTick] = useState<number>(0);

    editableRef.current = editable;

    const editor = useEditor({
      editable,
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3, 4, 5, 6] },
          link: false,
          underline: false,
          trailingNode: false
        }),
        HeadingAnchors,
        Image.extend({
          addNodeView() {
            return ({ node }) => {
              const dom = document.createElement('img');
              const updateImage = (attrs: Record<string, unknown>) => {
                const context = imageContextRef.current;
                const src = imageDisplaySource(String(attrs.src ?? ''), context.projectSlug, context.docPath);
                if (src) dom.setAttribute('src', src);
                else dom.removeAttribute('src');
                dom.alt = String(attrs.alt ?? '');
                if (attrs.title != null) dom.title = String(attrs.title);
                else dom.removeAttribute('title');
                dom.loading = 'lazy';
                dom.referrerPolicy = 'no-referrer';
              };
              updateImage(node.attrs);
              return { dom, update(next) {
                if (next.type !== node.type) return false;
                updateImage(next.attrs);
                return true;
              } };
            };
          }
        }).configure({ inline: true, allowBase64: false }),
        Link.configure({
          openOnClick: false,
          autolink: true
        }),
        Placeholder.configure({
          placeholder: 'Write documentation prose or insert a project embed…'
        }),
        Table.configure({ resizable: false, renderWrapper: true }),
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
        if (suppressUpdateRef.current || !ed.isEditable) return;
        const json = ed.getJSON() as ProseMirrorNode;
        const nextMd = proseMirrorToMarkdown(json, baseMarkdownRef.current);
        onMarkdownEdited(nextMd);
      },
      onSelectionUpdate() {
        forceToolbarTick((n) => n + 1);
      },
      onTransaction() {
        forceToolbarTick((n) => n + 1);
      },
      onFocus() {
        forceToolbarTick((n) => n + 1);
      },
      onBlur() {
        forceToolbarTick((n) => n + 1);
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
        handleDOMEvents: {
          // Cancel the native click as well as navigating; ProseMirror handleClick
          // receives mouseup, whose preventDefault does not stop an anchor navigation.
          click(_view, event) {
            const target = event.target as HTMLElement | null;
            if (!editableRef.current && target?.closest?.('input[type="checkbox"]')) {
              event.preventDefault();
              return true;
            }
            const anchorEl = target?.closest?.('a') as HTMLAnchorElement | null;
            const href = anchorEl?.getAttribute('href');
            if (href) {
              event.preventDefault();
              if (editableRef.current && !event.metaKey && !event.ctrlKey) return true;
              if (href.startsWith('http://') || href.startsWith('https://')) {
                window.open(href, '_blank', 'noopener,noreferrer');
              } else {
                const context = navigationRef.current;
                const resolved = resolveMarkdownLink(context.docPath, href);
                if (resolved?.path === context.docPath && resolved.fragment !== null) {
                  scrollToHeading(proseContainerRef.current, resolved.fragment);
                } else if (resolved) {
                  context.onNavigateDoc(resolved.path, resolved.fragment);
                } else if (/^(mailto:|tel:)/i.test(href)) {
                  window.location.href = href;
                }
              }
              return true;
            }
            return false;
          }
        }
      }
    });

    useEffect(() => {
      if (!editor || !navigationFragment) return;
      const frame = window.requestAnimationFrame(() => scrollToHeading(proseContainerRef.current, navigationFragment));
      return () => window.cancelAnimationFrame(frame);
    }, [editor, navigationFragment, docKey]);

    useEffect(() => { setAuthoringPopover(null); }, [editable, docKey]);

    // Keep editable state synced cleanly without emitting synthetic document updates
    useEffect(() => {
      if (!editor) return;
      if (editor.isEditable !== editable) {
        suppressUpdateRef.current = true;
        editor.setEditable(editable, false);
        suppressUpdateRef.current = false;
      }
    }, [editor, editable]);

    // Reload content cleanly when switching documents
    useEffect(() => {
      if (!editor) return;
      if (activeDocKeyRef.current !== docKey) {
        activeDocKeyRef.current = docKey;
        baseMarkdownRef.current = initialMarkdown;
        suppressUpdateRef.current = true;
        editor.commands.setContent(markdownToProseMirror(initialMarkdown) as JSONContent, { emitUpdate: false });
        suppressUpdateRef.current = false;
        setSelectionPopover(null);
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

    const readCurrentDomOrEditorAnchor = useCallback((): {
      anchor: CommentAnchor | null;
      rect: DOMRect | null;
    } => {
      if (!editor || !proseContainerRef.current) {
        return { anchor: null, rect: null };
      }

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        return { anchor: null, rect: null };
      }

      const range = sel.getRangeAt(0);
      const container = proseContainerRef.current;
      if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
        return { anchor: null, rect: null };
      }

      const startElem =
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? (range.startContainer as HTMLElement)
          : range.startContainer.parentElement;
      if (
        startElem?.closest(
          '.embed-frame-wrapper, .preserved-raw-block, .selection-comment-popover, .focus-anchor-marker'
        )
      ) {
        return { anchor: null, rect: null };
      }

      const rawText = sel.toString().trim();
      if (!rawText) {
        return { anchor: null, rect: null };
      }

      let anchor: CommentAnchor | null = null;
      if (editor.isEditable) {
        anchor = extractAnchorFromSelection(editor.state);
      }

      if (!anchor) {
        try {
          const p1 = editor.view.posAtDOM(range.startContainer, range.startOffset);
          const p2 = editor.view.posAtDOM(range.endContainer, range.endOffset);
          const from = Math.min(p1, p2);
          const to = Math.max(p1, p2);
          if (to > from) {
            anchor = extractAnchorFromRange(editor.state.doc, from, to);
          }
        } catch {
          anchor = null;
        }
      }

      if (!anchor) {
        const blocks = extractLiveProseBlocks(editor.state.doc);
        const matching = blocks.filter((b) => b.text.includes(rawText));
        if (matching.length === 1) {
          const idx = matching[0].text.indexOf(rawText);
          anchor = buildAnchorFromBlockSelection(matching[0], idx, idx + rawText.length);
        } else {
          anchor = { quote: rawText, prefix: '', suffix: '' };
        }
      }

      const clientRects = range.getClientRects();
      const firstRect = clientRects.length > 0 ? clientRects[0] : range.getBoundingClientRect();
      return { anchor, rect: firstRect.width > 0 || firstRect.height > 0 ? firstRect : null };
    }, [editor]);

    // Track prose text selection in both Read mode and Visual Editor mode
    useEffect(() => {
      if (!editor) return;
      let rafId = 0;

      const syncSelection = () => {
        window.cancelAnimationFrame(rafId);
        rafId = window.requestAnimationFrame(() => {
          const sheetEl = sheetScrollRef.current;
          const { anchor, rect } = readCurrentDomOrEditorAnchor();
          onSelectionAnchorChange(anchor);
          if (!anchor || !rect || !sheetEl) {
            setSelectionPopover(null);
            return;
          }
          const sheetRect = sheetEl.getBoundingClientRect();
          const sheetStyle = window.getComputedStyle(sheetEl);
          const isSheetScrollable =
            (sheetStyle.overflowY === 'auto' || sheetStyle.overflowY === 'scroll') &&
            sheetEl.scrollHeight > sheetEl.clientHeight + 2;
          const scrollOffset = isSheetScrollable ? sheetEl.scrollTop : 0;
          const stickyBottom = Math.max(
            document.querySelector('.repo-topbar')?.getBoundingClientRect().bottom ?? 0,
            document.querySelector('.editor-toolbar')?.getBoundingClientRect().bottom ?? 0
          );
          const minTopInSheet = scrollOffset + (stickyBottom - sheetRect.top) + 8;
          const placeBelow = rect.top < stickyBottom + 48;
          const rawTop = placeBelow
            ? scrollOffset + (rect.bottom - sheetRect.top) + 8
            : scrollOffset + (rect.top - sheetRect.top) - 40;
          const top = Math.max(8, minTopInSheet, rawTop);
          const centeredLeft =
            rect.left - sheetRect.left + Math.min(rect.width, 240) / 2 - 54;
          const left = Math.min(
            Math.max(12, centeredLeft),
            Math.max(12, sheetEl.clientWidth - 124)
          );
          setSelectionPopover({ anchor, top, left });
        });
      };

      document.addEventListener('selectionchange', syncSelection);
      return () => {
        window.cancelAnimationFrame(rafId);
        document.removeEventListener('selectionchange', syncSelection);
      };
    }, [editor, onSelectionAnchorChange, readCurrentDomOrEditorAnchor]);

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
        baseMarkdownRef.current = markdown;
        suppressUpdateRef.current = true;
        editor.commands.setContent(markdownToProseMirror(markdown) as JSONContent, { emitUpdate: false });
        suppressUpdateRef.current = false;
      },
      scrollToThreadAnchor(threadId: string) {
        const sheetEl = sheetScrollRef.current;
        if (!sheetEl) return;
        const target = sheetEl.querySelector(
          `.focus-comment-highlight[data-thread-id="${CSS.escape(threadId)}"]`
        ) as HTMLElement | null;
        if (!target) return;
        const targetRect = target.getBoundingClientRect();
        const sheetStyle = window.getComputedStyle(sheetEl);
        const isSheetScrollable =
          (sheetStyle.overflowY === 'auto' || sheetStyle.overflowY === 'scroll') &&
          sheetEl.scrollHeight > sheetEl.clientHeight + 2;
        if (isSheetScrollable) {
          const sheetRect = sheetEl.getBoundingClientRect();
          const nextTop = Math.max(0, sheetEl.scrollTop + (targetRect.top - sheetRect.top) - 120);
          sheetEl.scrollTo({ top: nextTop, behavior: 'smooth' });
        } else {
          const nextWindowTop = Math.max(0, window.scrollY + targetRect.top - 110);
          window.scrollTo({ top: nextWindowTop, behavior: 'smooth' });
        }
      }
    }));

    if (!editor) {
      return <div className="sheet-scroll">Loading document…</div>;
    }

    const isFocused = editor.isFocused;
    const activeOnFocus = (name: string, attrs?: Record<string, unknown>) =>
      isFocused && editor.isActive(name, attrs);

    const activeLinkHref =
      isFocused && editor.isActive('link')
        ? String(editor.getAttributes('link').href ?? '')
        : '';

    function openAuthoringPopover(kind: 'link' | 'image') {
      if (!editor) return;
      savedSelectionRef.current = { from: editor.state.selection.from, to: editor.state.selection.to };
      setUrlInput(kind === 'link' ? String(editor.getAttributes('link').href ?? '') : '');
      setImageAlt('');
      setImageTitle('');
      setPopoverError(null);
      setAuthoringPopover(kind);
    }

    function restoreSelection() {
      if (!editor) return;
      const chain = editor.chain().focus();
      return savedSelectionRef.current ? chain.setTextSelection(savedSelectionRef.current) : chain;
    }

    function closeAuthoringPopover() {
      setAuthoringPopover(null);
      restoreSelection()?.run();
    }

    function triggerCommentFromCurrentSelection() {
      const { anchor } = readCurrentDomOrEditorAnchor();
      const chosen = anchor ?? selectionPopover?.anchor ?? null;
      onSelectionAnchorChange(chosen);
      onStartCommentWithAnchor(chosen);
      if (chosen) {
        setSelectionPopover(null);
      }
    }

    return (
      <>
        {editable && (
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
            <div className="toolbar-group" role="group" aria-label="Headings">
              <button
                type="button"
                className={`tool-btn ${activeOnFocus('heading', { level: 1 }) ? 'is-active' : ''}`}
                aria-label="Heading 1"
                aria-pressed={activeOnFocus('heading', { level: 1 })}
                title="Heading 1"
                onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
              >
                <Heading1 size={15} />
              </button>
              <button
                type="button"
                className={`tool-btn ${activeOnFocus('heading', { level: 2 }) ? 'is-active' : ''}`}
                aria-label="Heading 2"
                aria-pressed={activeOnFocus('heading', { level: 2 })}
                title="Heading 2"
                onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
              >
                <Heading2 size={15} />
              </button>
              <button
                type="button"
                className={`tool-btn ${activeOnFocus('heading', { level: 3 }) ? 'is-active' : ''}`}
                aria-label="Heading 3"
                aria-pressed={activeOnFocus('heading', { level: 3 })}
                title="Heading 3"
                onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
              >
                <Heading3 size={15} />
              </button>
            </div>

            <div className="tool-divider" />

            <div className="toolbar-group" role="group" aria-label="Inline formatting">
              <button
                type="button"
                className={`tool-btn ${activeOnFocus('bold') ? 'is-active' : ''}`}
                aria-label="Bold"
                aria-pressed={activeOnFocus('bold')}
                title="Bold (Ctrl+B)"
                onClick={() => editor.chain().focus().toggleBold().run()}
              >
                <Bold size={15} />
              </button>
              <button
                type="button"
                className={`tool-btn ${activeOnFocus('italic') ? 'is-active' : ''}`}
                aria-label="Italic"
                aria-pressed={activeOnFocus('italic')}
                title="Italic (Ctrl+I)"
                onClick={() => editor.chain().focus().toggleItalic().run()}
              >
                <Italic size={15} />
              </button>
              <button
                type="button"
                className={`tool-btn ${activeOnFocus('code') ? 'is-active' : ''}`}
                aria-label="Inline code"
                aria-pressed={activeOnFocus('code')}
                title="Inline code (Ctrl+E)"
                onClick={() => editor.chain().focus().toggleCode().run()}
              >
                <Code size={15} />
              </button>
              <button
                type="button"
                className={`tool-btn ${activeOnFocus('link') ? 'is-active' : ''}`}
                aria-label="Insert or edit link"
                aria-pressed={activeOnFocus('link')}
                title="Insert or edit link"
                onClick={() => openAuthoringPopover('link')}
              >
                <Link2 size={15} />
              </button>
              {activeLinkHref && resolveMarkdownLink(docPath ?? '', activeLinkHref) && (
                <button
                  type="button"
                  className="btn btn-compact"
                  onClick={() => {
                    const resolved = resolveMarkdownLink(docPath ?? '', activeLinkHref);
                    if (resolved && resolved.path === docPath && resolved.fragment !== null) scrollToHeading(proseContainerRef.current, resolved.fragment);
                    else if (resolved) onNavigateDoc(resolved.path, resolved.fragment);
                  }}
                  title={`Open linked document ${activeLinkHref}`}
                >
                  <ExternalLink size={12} />
                  <span>Open {activeLinkHref}</span>
                </button>
              )}
            </div>

            <div className="tool-divider" />

            <div className="toolbar-group" role="group" aria-label="Lists and blocks">
              <button
                type="button"
                className={`tool-btn ${activeOnFocus('bulletList') ? 'is-active' : ''}`}
                aria-label="Bullet list"
                aria-pressed={activeOnFocus('bulletList')}
                title="Bullet list"
                onClick={() => editor.chain().focus().toggleBulletList().run()}
              >
                <List size={15} />
              </button>
              <button
                type="button"
                className={`tool-btn ${activeOnFocus('orderedList') ? 'is-active' : ''}`}
                aria-label="Numbered list"
                aria-pressed={activeOnFocus('orderedList')}
                title="Numbered list"
                onClick={() => editor.chain().focus().toggleOrderedList().run()}
              >
                <ListOrdered size={15} />
              </button>
              <button
                type="button"
                className={`tool-btn ${activeOnFocus('taskList') ? 'is-active' : ''}`}
                aria-label="Task checklist"
                aria-pressed={activeOnFocus('taskList')}
                title="Task checklist"
                onClick={() => editor.chain().focus().toggleTaskList().run()}
              >
                <ListTodo size={15} />
              </button>
              <button
                type="button"
                className={`tool-btn ${activeOnFocus('blockquote') ? 'is-active' : ''}`}
                aria-label="Blockquote"
                aria-pressed={activeOnFocus('blockquote')}
                title="Blockquote"
                onClick={() => editor.chain().focus().toggleBlockquote().run()}
              >
                <Quote size={15} />
              </button>
              <button
                type="button"
                className={`tool-btn ${activeOnFocus('codeBlock') ? 'is-active' : ''}`}
                aria-label="Code block"
                aria-pressed={activeOnFocus('codeBlock')}
                title="Fenced code block"
                onClick={() => editor.chain().focus().toggleCodeBlock().run()}
              >
                <SquareCode size={15} />
              </button>
              <button
                type="button"
                className="tool-btn"
                aria-label="Insert 3 by 3 Markdown table"
                title="Insert Markdown table"
                onClick={() =>
                  editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
                }
              >
                <TableIcon size={15} />
              </button>
            </div>

            <div className="tool-divider" />

            <div className="toolbar-actions-right">
              <button type="button" className="btn btn-compact" onClick={() => openAuthoringPopover('image')} title="Insert image">
                <ImagePlus size={13} aria-hidden="true" /><span>Image</span>
              </button>
              <button
                type="button"
                className="btn btn-compact"
                onClick={onOpenInsertEmbedModal}
              >
                <Blocks size={13} />
                <span>Insert embed</span>
              </button>
              <button
                type="button"
                className="btn btn-compact"
                onClick={triggerCommentFromCurrentSelection}
                title="Anchor a review comment on selected prose (Alt+C)"
              >
                <MessageSquarePlus size={13} />
                <span>Comment</span>
              </button>
            </div>
          </div>
        )}

        {editable && authoringPopover && (
          <form className="editor-authoring-bar" aria-label={authoringPopover === 'link' ? 'Edit link' : 'Insert image'} onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAuthoringPopover(); }
          }} onSubmit={(e) => {
            e.preventDefault();
            const href = urlInput.trim();
            if (!href) { setPopoverError('Enter a URL or repository path.'); return; }
            if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^(https?:|mailto:|tel:)/i.test(href) || /^\/\//.test(href) || /[\u0000-\u001f\u007f]/.test(href)) {
              setPopoverError('Use an HTTP(S) URL, email, telephone, or repository path.'); return;
            }
            if (authoringPopover === 'image') {
              if (!imageDisplaySource(href, projectSlug, docPath ?? '')) { setPopoverError('Use an HTTP(S) URL or an image path inside this repository.'); return; }
              restoreSelection()?.setImage({ src: href, alt: imageAlt, title: imageTitle || undefined }).run();
            } else {
              const chain = restoreSelection()?.extendMarkRange('link');
              if (editor.state.selection.empty && !editor.isActive('link')) {
                chain?.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
              } else {
                const applied = chain?.setLink({ href }).run();
                if (!applied) { setPopoverError('Use a valid link URL or repository path.'); return; }
              }
            }
            setAuthoringPopover(null);
          }}>
            <label>{authoringPopover === 'link' ? 'Link URL or document path' : 'Image URL or repository path'}
              <input autoFocus className="field-input" value={urlInput} onChange={(e) => setUrlInput(e.target.value)} placeholder={authoringPopover === 'link' ? './guide.md#overview' : './images/diagram.png'} />
            </label>
            {authoringPopover === 'image' && <>
              <label>Alternative text<input className="field-input" value={imageAlt} onChange={(e) => setImageAlt(e.target.value)} /></label>
              <label>Title (optional)<input className="field-input" value={imageTitle} onChange={(e) => setImageTitle(e.target.value)} /></label>
            </>}
            <button className="btn btn-primary btn-compact" type="submit">{authoringPopover === 'link' ? 'Apply' : 'Insert image'}</button>
            {authoringPopover === 'link' && <button className="btn btn-compact" type="button" onClick={() => {
              restoreSelection()?.extendMarkRange('link').unsetLink().run(); setAuthoringPopover(null);
            }}>Remove Link</button>}
            <button className="btn btn-compact" type="button" onClick={closeAuthoringPopover}>Cancel</button>
            {popoverError && <span role="alert">{popoverError}</span>}
          </form>
        )}
        {editable && editor.isActive('table') && (
          <div className="editor-table-controls" role="group" aria-label="Table controls" onMouseDown={(e) => { if ((e.target as HTMLElement).closest('button')) e.preventDefault(); }}>
            <span>Table</span>
            <button className="btn btn-compact" onClick={() => editor.chain().focus().addRowBefore().run()}>Row above</button>
            <button className="btn btn-compact" onClick={() => editor.chain().focus().addRowAfter().run()}>Row below</button>
            <button className="btn btn-compact" onClick={() => editor.chain().focus().deleteRow().run()}>Delete row</button>
            <button className="btn btn-compact" onClick={() => editor.chain().focus().addColumnBefore().run()}>Column before</button>
            <button className="btn btn-compact" onClick={() => editor.chain().focus().addColumnAfter().run()}>Column after</button>
            <button className="btn btn-compact" onClick={() => editor.chain().focus().deleteColumn().run()}>Delete column</button>
            <button className="btn btn-compact" onClick={() => editor.chain().focus().deleteTable().run()}>Delete table</button>
          </div>
        )}

        <div
          ref={sheetScrollRef}
          className={`sheet-scroll ${editable ? 'is-editing' : 'is-reading'}`}
          onKeyDown={(e) => {
            if (e.altKey && e.key.toLowerCase() === 'c') {
              e.preventDefault();
              triggerCommentFromCurrentSelection();
            }
          }}
        >
          {selectionPopover && (
            <button
              type="button"
              className="selection-comment-popover"
              style={{
                top: `${selectionPopover.top}px`,
                left: `${selectionPopover.left}px`
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                triggerCommentFromCurrentSelection();
              }}
              aria-label="Add inline comment on selected text"
            >
              <MessageSquarePlus size={14} aria-hidden="true" />
              <span>Comment</span>
            </button>
          )}

          <div
            ref={proseContainerRef}
            className={`prose-container ${editable ? 'is-editable' : 'is-readonly'}`}
          >
            {projectName && docPath && (
              <div className="doc-page-eyebrow">
                <button
                  type="button"
                  className="doc-eyebrow-btn"
                  onClick={onOpenRepoDetails}
                  title="Inspect repository path, branch, and working-tree diff"
                >
                  <span className="eyebrow-project">{projectName}</span>
                  <span className="eyebrow-sep" aria-hidden="true">/</span>
                  <span className="eyebrow-path">{docPath}</span>
                </button>
              </div>
            )}
            <EditorContent editor={editor} />
          </div>
        </div>
      </>
    );
  }
);
