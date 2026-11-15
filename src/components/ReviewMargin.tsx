import { useState } from 'react';
import type { CommentAnchor, ResolvedCommentThread } from '../../shared/types';

interface Props {
  threads: ResolvedCommentThread[];
  pendingAnchor: CommentAnchor | null;
  composerOpen: boolean;
  activeThreadId: string | null;
  showResolved: boolean;
  onToggleShowResolved: (next: boolean) => void;
  onSelectThread: (threadId: string | null) => void;
  onCancelComposer: () => void;
  onCreateComment: (author: string, body: string) => Promise<void>;
  onReplyComment: (threadId: string, author: string, body: string) => Promise<void>;
  onChangeThreadStatus: (
    threadId: string,
    status: 'open' | 'resolved',
    actor: string
  ) => Promise<void>;
}

export function ReviewMargin(props: Props) {
  const {
    threads,
    pendingAnchor,
    composerOpen,
    activeThreadId,
    showResolved,
    onToggleShowResolved,
    onSelectThread,
    onCancelComposer,
    onCreateComment,
    onReplyComment,
    onChangeThreadStatus
  } = props;

  const [authorName, setAuthorName] = useState<string>('Reviewer');
  const [newCommentBody, setNewCommentBody] = useState<string>('');
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [expandedHistory, setExpandedHistory] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState<boolean>(false);

  const openThreads = threads.filter((t) => t.status === 'open');
  const resolvedThreads = threads.filter((t) => t.status === 'resolved');
  const visibleThreads = showResolved ? threads : openThreads;

  const unattachedThreads = visibleThreads.filter((t) => t.anchorStatus !== 'attached');
  const attachedThreads = visibleThreads.filter((t) => t.anchorStatus === 'attached');

  async function submitNewThread(e: React.FormEvent) {
    e.preventDefault();
    if (!newCommentBody.trim() || !pendingAnchor) return;
    setSubmitting(true);
    try {
      await onCreateComment(authorName.trim() || 'Reviewer', newCommentBody.trim());
      setNewCommentBody('');
    } finally {
      setSubmitting(false);
    }
  }

  async function submitReply(threadId: string) {
    const body = (replyDrafts[threadId] ?? '').trim();
    if (!body) return;
    setSubmitting(true);
    try {
      await onReplyComment(threadId, authorName.trim() || 'Reviewer', body);
      setReplyDrafts((prev) => ({ ...prev, [threadId]: '' }));
    } finally {
      setSubmitting(false);
    }
  }

  function renderThreadCard(thread: ResolvedCommentThread) {
    const isActive = thread.id === activeThreadId;
    const isUnattached = thread.anchorStatus !== 'attached';
    const replyVal = replyDrafts[thread.id] ?? '';
    const historyShown = Boolean(expandedHistory[thread.id]);

    return (
      <div
        key={thread.id}
        className={`thread-card ${isActive ? 'active' : ''} ${isUnattached ? 'unattached' : ''}`}
        onClick={() => onSelectThread(thread.id)}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
          <span className={`anchor-badge ${thread.anchorStatus}`}>
            {thread.anchorStatus === 'attached'
              ? thread.status === 'resolved'
                ? 'Resolved'
                : 'Anchored'
              : thread.anchorStatus === 'orphaned'
                ? 'Orphaned anchor'
                : 'Ambiguous anchor'}
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              className="btn btn-compact"
              onClick={(e) => {
                e.stopPropagation();
                setExpandedHistory((prev) => ({ ...prev, [thread.id]: !prev[thread.id] }));
              }}
            >
              {historyShown ? 'Hide log' : `History (${thread.history.length})`}
            </button>
            {thread.status === 'open' ? (
              <button
                type="button"
                className="btn btn-compact"
                onClick={(e) => {
                  e.stopPropagation();
                  void onChangeThreadStatus(thread.id, 'resolved', authorName);
                }}
              >
                Resolve
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-compact"
                onClick={(e) => {
                  e.stopPropagation();
                  void onChangeThreadStatus(thread.id, 'open', authorName);
                }}
              >
                Reopen
              </button>
            )}
          </div>
        </div>

        <div className="quote-preview" style={{ marginBottom: 2 }}>
          “{thread.anchor.quote}”
        </div>

        {thread.anchorReason && (
          <div style={{ fontSize: 11.5, color: 'var(--conflict-garnet)', fontWeight: 600 }}>
            {thread.anchorReason}
          </div>
        )}

        <div>
          {thread.messages.map((m) => (
            <div key={m.id} className="msg-item">
              <div>
                <span className="msg-author">{m.author}</span>
                <span className="role-tag">{m.role}</span>
              </div>
              <div style={{ marginTop: 3 }}>{m.body}</div>
            </div>
          ))}
        </div>

        {historyShown && (
          <div
            style={{
              background: 'var(--surface-desk)',
              padding: 8,
              borderRadius: 4,
              fontSize: 11.5,
              color: 'var(--ink-secondary)'
            }}
          >
            {thread.history.map((h, idx) => (
              <div key={idx}>
                {h.action} by <strong>{h.actor}</strong> ({h.role})
                {h.note ? `: ${h.note}` : ''}
              </div>
            ))}
          </div>
        )}

        <div
          style={{ display: 'flex', gap: 6, marginTop: 2 }}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="text"
            placeholder="Write a reply…"
            value={replyVal}
            onChange={(e) =>
              setReplyDrafts((prev) => ({ ...prev, [thread.id]: e.target.value }))
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submitReply(thread.id);
              }
            }}
            style={{
              flex: 1,
              padding: '5px 8px',
              fontSize: 12.5,
              border: '1px solid var(--line-border)',
              borderRadius: 4
            }}
          />
          <button
            type="button"
            className="btn btn-compact"
            disabled={submitting || !replyVal.trim()}
            onClick={() => void submitReply(thread.id)}
          >
            Reply
          </button>
        </div>
      </div>
    );
  }

  return (
    <aside className="review-sidebar" aria-label="Inline review threads">
      <div className="review-header">
        <h2 className="review-title">
          Review ({openThreads.length} open
          {resolvedThreads.length > 0 ? `, ${resolvedThreads.length} resolved` : ''})
        </h2>
        <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => onToggleShowResolved(e.target.checked)}
          />
          <span>Show resolved</span>
        </label>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <label htmlFor="reviewerNameInput" style={{ color: 'var(--ink-secondary)', fontWeight: 600 }}>
          Commenting as
        </label>
        <input
          id="reviewerNameInput"
          type="text"
          value={authorName}
          onChange={(e) => setAuthorName(e.target.value)}
          style={{
            flex: 1,
            padding: '4px 8px',
            border: '1px solid var(--line-border)',
            borderRadius: 4,
            background: 'var(--surface-sheet)',
            fontSize: 12
          }}
        />
      </div>

      {(composerOpen || pendingAnchor) && pendingAnchor ? (
        <form className="composer-box" onSubmit={(e) => void submitNewThread(e)}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
            New comment on selected prose
          </div>
          <div className="quote-preview">“{pendingAnchor.quote}”</div>
          <textarea
            rows={3}
            placeholder="Add review question or note…"
            value={newCommentBody}
            onChange={(e) => setNewCommentBody(e.target.value)}
            style={{
              width: '100%',
              padding: 8,
              border: '1px solid var(--line-border)',
              borderRadius: 4,
              fontSize: 12.5,
              marginBottom: 8,
              resize: 'vertical'
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
            <button type="button" className="btn btn-compact" onClick={onCancelComposer}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-compact btn-primary"
              disabled={submitting || !newCommentBody.trim()}
            >
              Post comment
            </button>
          </div>
        </form>
      ) : (
        <div
          style={{
            fontSize: 12,
            color: 'var(--ink-secondary)',
            padding: '8px 10px',
            background: 'var(--surface-sheet)',
            borderRadius: 5,
            border: '1px solid var(--line-border)'
          }}
        >
          Select any prose passage in the document to anchor a new inline comment thread. Sidecar JSON files keep portable history in Git.
        </div>
      )}

      {unattachedThreads.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--conflict-garnet)' }}>
            Unattached anchors ({unattachedThreads.length})
          </div>
          {unattachedThreads.map(renderThreadCard)}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {attachedThreads.length === 0 && unattachedThreads.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--ink-secondary)' }}>
            No {showResolved ? '' : 'open '}threads on this document.
          </div>
        ) : (
          attachedThreads.map(renderThreadCard)
        )}
      </div>
    </aside>
  );
}
