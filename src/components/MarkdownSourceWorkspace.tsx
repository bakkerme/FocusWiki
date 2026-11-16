import { Blocks, FileCode2, MessageSquare, WrapText } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { ResolvedCommentThread } from '../../shared/types';

interface Props {
  docPath: string;
  markdown: string;
  threads: ResolvedCommentThread[];
  onChangeMarkdown: (next: string) => void;
  onOpenInsertEmbedModal: () => void;
  onTriggerImmediateSave: () => void;
  onLocateThreadInRead: (threadId: string) => void;
}

export function MarkdownSourceWorkspace(props: Props) {
  const {
    docPath,
    markdown,
    threads,
    onChangeMarkdown,
    onOpenInsertEmbedModal,
    onTriggerImmediateSave,
    onLocateThreadInRead
  } = props;

  const [wrapLines, setWrapLines] = useState<boolean>(false);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const lines = useMemo(() => markdown.split('\n'), [markdown]);
  const openThreads = useMemo(
    () => threads.filter((t) => t.status === 'open'),
    [threads]
  );

  // Map 1-based line numbers to open comment thread IDs when a quote matches a source line
  const lineThreadMap = useMemo(() => {
    const map = new Map<number, ResolvedCommentThread>();
    if (openThreads.length === 0) return map;
    for (const thread of openThreads) {
      const needle = thread.anchor.quote.trim();
      if (!needle || needle.includes('\n')) continue;
      const snippet = needle.slice(0, 48);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(snippet)) {
          if (!map.has(i + 1)) {
            map.set(i + 1, thread);
          }
          break;
        }
      }
    }
    return map;
  }, [lines, openThreads]);

  return (
    <div className="source-workspace">
      <div className="source-toolbar">
        <div className="source-toolbar-left">
          <FileCode2 size={15} className="source-toolbar-icon" aria-hidden="true" />
          <span className="source-file-label">Authoritative file:</span>
          <span className="code-chip">{docPath}</span>
          <span className="source-meta-stat">{lines.length} lines</span>
          {openThreads.length > 0 && (
            <button
              type="button"
              className="source-thread-jump-btn"
              onClick={() => onLocateThreadInRead(openThreads[0].id)}
              title="Switch to Read view and focus anchored comment passage"
            >
              <MessageSquare size={12} aria-hidden="true" />
              <span>
                {openThreads.length} anchored {openThreads.length === 1 ? 'comment' : 'comments'} · View in Read
              </span>
            </button>
          )}
        </div>

        <div className="source-toolbar-right">
          <button
            type="button"
            className={`btn btn-compact ${wrapLines ? 'is-active-btn' : ''}`}
            aria-pressed={wrapLines}
            onClick={() => setWrapLines((v) => !v)}
            title={
              wrapLines
                ? 'Soft line wrapping enabled (click to keep wide Markdown tables on single lines)'
                : 'Horizontal scroll active so wide Markdown tables stay aligned (click to wrap lines)'
            }
          >
            <WrapText size={13} aria-hidden="true" />
            <span>Wrap lines</span>
          </button>
          <button
            type="button"
            className="btn btn-compact"
            onClick={onOpenInsertEmbedModal}
          >
            <Blocks size={13} aria-hidden="true" />
            <span>Insert embed syntax</span>
          </button>
        </div>
      </div>

      <div className="source-editor-body">
        {!wrapLines && (
          <div
            ref={gutterRef}
            className="source-line-gutter"
            aria-hidden="true"
          >
            {lines.map((_, idx) => {
              const lineNo = idx + 1;
              const hitThread = lineThreadMap.get(lineNo);
              return (
                <div
                  key={lineNo}
                  className={`gutter-line ${hitThread ? 'has-comment' : ''}`}
                  onClick={
                    hitThread
                      ? () => onLocateThreadInRead(hitThread.id)
                      : undefined
                  }
                  title={
                    hitThread
                      ? `Open comment by ${hitThread.messages[0]?.author ?? 'Reviewer'} — click to view in Read mode`
                      : undefined
                  }
                >
                  {hitThread && <span className="gutter-comment-dot" />}
                  <span>{lineNo}</span>
                </div>
              );
            })}
          </div>
        )}

        <textarea
          ref={textareaRef}
          className={`markdown-source-editor ${wrapLines ? 'is-wrapped' : 'is-unwrapped'}`}
          aria-label="Markdown source editor"
          spellCheck={false}
          wrap={wrapLines ? 'soft' : 'off'}
          value={markdown}
          onChange={(e) => onChangeMarkdown(e.target.value)}
          onScroll={(e) => {
            if (gutterRef.current) {
              gutterRef.current.scrollTop = e.currentTarget.scrollTop;
            }
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
              e.preventDefault();
              onTriggerImmediateSave();
            }
          }}
        />
      </div>
    </div>
  );
}
