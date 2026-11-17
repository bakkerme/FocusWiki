import { useRef, useState, type RefObject } from 'react';
import {
  BookOpen,
  CheckCircle2,
  CornerUpLeft,
  History,
  Pencil,
  RotateCcw,
  X
} from 'lucide-react';
import type { CommentAnchor, ResolvedCommentThread } from '../../shared/types';
import type { WorkspaceMode } from '../editor/EmbedContext';
import { useModalOverlayFocus } from '../utils/overlayModal';

interface Props {
  threads: ResolvedCommentThread[];
  pendingAnchor: CommentAnchor | null;
  composerOpen: boolean;
  activeThreadId: string | null;
  showResolved: boolean;
  workspaceMode: WorkspaceMode;
  isOverlay: boolean;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  authorName: string;
  onChangeAuthorName: (next: string) => void;
  commentDraft: string;
  onChangeCommentDraft: (next: string) => void;
  replyDrafts: Record<string, string>;
  onChangeReplyDraft: (threadId: string, next: string) => void;
  expandedHistory: Record<string, boolean>;
  onToggleHistory: (threadId: string) => void;
  onToggleShowResolved: (next: boolean) => void;
  onSelectThread: (threadId: string | null) => void;
  onLocateInRead: (threadId: string) => void;
  onOpenComposer: () => void;
  onCancelComposer: () => void;
  onCreateComment: (author: string, body: string) => Promise<void>;
  onReplyComment: (threadId: string, author: string, body: string) => Promise<void>;
  onChangeThreadStatus: (
    threadId: string,
    status: 'open' | 'resolved',
    actor: string
  ) => Promise<void>;
  onClose: () => void;
}

export function ReviewMargin(props: Props) {
  const {
    threads,
    pendingAnchor,
    composerOpen,
    activeThreadId,
    showResolved,
    workspaceMode,
    isOverlay,
    restoreFocusRef,
    authorName,
    onChangeAuthorName,
    commentDraft,
    onChangeCommentDraft,
    replyDrafts,
    onChangeReplyDraft,
    expandedHistory,
    onToggleHistory,
    onToggleShowResolved,
    onSelectThread,
    onLocateInRead,
    onOpenComposer,
    onCancelComposer,
    onCreateComment,
    onReplyComment,
    onChangeThreadStatus,
    onClose
  } = props;

  const panelRef = useRef<HTMLElement | null>(null);
  const [editingAuthor, setEditingAuthor] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const openThreads = threads.filter((t) => t.status === 'open');
  const resolvedThreads = threads.filter((t) => t.status === 'resolved');
  const visibleThreads = showResolved ? threads : openThreads;

  const unattachedThreads = visibleThreads.filter((t) => t.anchorStatus !== 'attached');
  const attachedThreads = visibleThreads.filter((t) => t.anchorStatus === 'attached');

  const showComposer =
    Boolean(composerOpen && pendingAnchor) && workspaceMode !== 'source';

  useModalOverlayFocus({
    active: isOverlay,
    containerRef: panelRef,
    restoreFocusRef,
    initialFocusSelector: showComposer ? '.composer-textarea' : '.panel-close-btn',
    onDismiss: onClose
  });

  async function submitNewThread(e: React.FormEvent) {
    e.preventDefault();
    if (!commentDraft.trim() || !pendingAnchor) return;
    setSubmitting(true);
    try {
      await onCreateComment(authorName.trim() || 'Reviewer', commentDraft.trim());
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
    } finally {
      setSubmitting(false);
    }
  }

  function renderThreadCard(thread: ResolvedCommentThread) {
    const isActive = thread.id === activeThreadId;
    const isResolved = thread.status === 'resolved';
    const isUnattached = thread.anchorStatus !== 'attached';
    const replyVal = replyDrafts[thread.id] ?? '';
    const historyShown = Boolean(expandedHistory[thread.id]);
    const latestMsg = thread.messages[thread.messages.length - 1];

    const badgeLabel =
      thread.anchorStatus === 'attached'
        ? isResolved
          ? 'Resolved'
          : 'Open'
        : thread.anchorStatus === 'orphaned'
          ? 'Orphaned anchor'
          : 'Ambiguous anchor';

    if (!isActive) {
      return (
        <div
          key={thread.id}
          className={[
            'thread-card',
            'is-compact',
            isResolved ? 'is-resolved' : '',
            isUnattached ? 'unattached' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          role="button"
          tabIndex={0}
          onClick={() => onSelectThread(thread.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelectThread(thread.id);
            }
          }}
        >
          <div className="thread-compact-top">
            <div className="thread-compact-meta">
              <span
                className={`anchor-badge ${thread.anchorStatus} ${isResolved ? 'resolved' : ''}`}
              >
                {badgeLabel}
              </span>
              {latestMsg && <span className="msg-author">{latestMsg.author}</span>}
              <span className="thread-msg-count">
                {thread.messages.length} {thread.messages.length === 1 ? 'note' : 'notes'}
              </span>
            </div>

            {workspaceMode === 'source' && thread.anchorStatus === 'attached' ? (
              <button
                type="button"
                className="btn btn-compact btn-quiet"
                onClick={(e) => {
                  e.stopPropagation();
                  onLocateInRead(thread.id);
                }}
                title="View anchored passage in Read mode"
              >
                <BookOpen size={12} aria-hidden="true" />
                <span>View</span>
              </button>
            ) : isResolved ? (
              <button
                type="button"
                className="btn btn-compact btn-quiet"
                onClick={(e) => {
                  e.stopPropagation();
                  void onChangeThreadStatus(thread.id, 'open', authorName);
                }}
              >
                Reopen
              </button>
            ) : null}
          </div>

          <div className="quote-preview is-compact-quote">“{thread.anchor.quote}”</div>

          {latestMsg && <div className="thread-compact-snippet">{latestMsg.body}</div>}
        </div>
      );
    }

    return (
      <div
        key={thread.id}
        className={[
          'thread-card',
          'active',
          'is-expanded',
          isResolved ? 'is-resolved' : '',
          isUnattached ? 'unattached' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => onSelectThread(thread.id)}
      >
        <div className="thread-expanded-top">
          <span
            className={`anchor-badge ${thread.anchorStatus} ${isResolved ? 'resolved' : ''}`}
          >
            {badgeLabel}
          </span>
          <div className="thread-card-actions">
            {workspaceMode === 'source' && thread.anchorStatus === 'attached' ? (
              <button
                type="button"
                className="btn btn-compact btn-quiet"
                onClick={(e) => {
                  e.stopPropagation();
                  onLocateInRead(thread.id);
                }}
                title="Switch to Read mode and scroll to anchored prose"
              >
                <BookOpen size={12} aria-hidden="true" />
                <span>View in Read</span>
              </button>
            ) : isOverlay && thread.anchorStatus === 'attached' ? (
              <button
                type="button"
                className="btn btn-compact btn-quiet"
                onClick={(e) => {
                  e.stopPropagation();
                  onLocateInRead(thread.id);
                }}
                title="Return to document and scroll to highlighted passage"
              >
                <CornerUpLeft size={12} aria-hidden="true" />
                <span>Passage</span>
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-compact btn-quiet"
              onClick={(e) => {
                e.stopPropagation();
                onToggleHistory(thread.id);
              }}
              title="Toggle portable thread audit log"
            >
              <History size={12} aria-hidden="true" />
              <span>{historyShown ? 'Hide log' : `History (${thread.history.length})`}</span>
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
                <CheckCircle2 size={12} aria-hidden="true" />
                <span>Resolve</span>
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
                <RotateCcw size={12} aria-hidden="true" />
                <span>Reopen</span>
              </button>
            )}
          </div>
        </div>

        <div className="quote-preview">“{thread.anchor.quote}”</div>

        {thread.anchorReason && (
          <div className="anchor-warning-note">{thread.anchorReason}</div>
        )}

        <div className="thread-messages">
          {thread.messages.map((m) => (
            <div key={m.id} className="msg-item">
              <div className="msg-header-row">
                <span className="msg-author">{m.author}</span>
                <span className="role-tag">{m.role}</span>
              </div>
              <div className="msg-body">{m.body}</div>
            </div>
          ))}
        </div>

        {historyShown && (
          <div className="thread-history-log">
            {thread.history.map((h, idx) => (
              <div key={idx}>
                {h.action} by <strong>{h.actor}</strong> ({h.role})
                {h.note ? `: ${h.note}` : ''}
              </div>
            ))}
          </div>
        )}

        <div className="thread-reply-row" onClick={(e) => e.stopPropagation()}>
          <input
            type="text"
            className="field-input"
            placeholder={`Reply as ${authorName.trim() || 'Reviewer'}…`}
            value={replyVal}
            onChange={(e) => onChangeReplyDraft(thread.id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submitReply(thread.id);
              }
            }}
          />
          <button
            type="button"
            className="btn btn-compact btn-primary"
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
    <aside
      id="focus-review-panel"
      ref={panelRef}
      className={`review-sidebar ${isOverlay ? 'is-overlay is-overlay-open is-mobile-open' : 'is-docked'}`}
      role={isOverlay ? 'dialog' : undefined}
      aria-modal={isOverlay ? 'true' : undefined}
      aria-label="Inline review threads"
      tabIndex={-1}
    >
      <div className="review-header">
        <div className="review-header-left">
          <h2 className="review-title">Review</h2>
          <span className="review-count-summary">
            {openThreads.length} open
            {resolvedThreads.length > 0 ? ` · ${resolvedThreads.length} resolved` : ''}
          </span>
        </div>

        <div className="review-header-right">
          <label className="resolved-toggle-label">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => onToggleShowResolved(e.target.checked)}
            />
            <span>Resolved</span>
          </label>
          <button
            type="button"
            className="icon-btn panel-close-btn mobile-drawer-close"
            onClick={onClose}
            aria-label="Close review"
            title="Close review"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="reviewer-identity-bar">
        {editingAuthor ? (
          <div className="reviewer-edit-row">
            <label htmlFor="reviewerNameInput" className="sr-only">
              Reviewer display name
            </label>
            <input
              id="reviewerNameInput"
              type="text"
              className="field-input"
              value={authorName}
              autoFocus
              onChange={(e) => onChangeAuthorName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') {
                  setEditingAuthor(false);
                }
              }}
            />
            <button
              type="button"
              className="btn btn-compact"
              onClick={() => setEditingAuthor(false)}
            >
              Done
            </button>
          </div>
        ) : (
          <div className="reviewer-pill-row">
            <span className="reviewer-label">Commenting as</span>
            <button
              type="button"
              className="reviewer-name-btn"
              onClick={() => setEditingAuthor(true)}
              title="Change reviewer display name"
            >
              <span>{authorName.trim() || 'Reviewer'}</span>
              <Pencil size={11} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {showComposer && pendingAnchor ? (
        <form className="composer-box" onSubmit={(e) => void submitNewThread(e)}>
          <div className="composer-heading">New comment on selection</div>
          <div className="quote-preview">“{pendingAnchor.quote}”</div>
          <textarea
            rows={3}
            className="composer-textarea"
            placeholder="Add review question or feedback…"
            value={commentDraft}
            autoFocus={!isOverlay}
            onChange={(e) => onChangeCommentDraft(e.target.value)}
          />
          <div className="composer-actions">
            <button type="button" className="btn btn-compact" onClick={onCancelComposer}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-compact btn-primary"
              disabled={submitting || !commentDraft.trim()}
            >
              Post comment
            </button>
          </div>
        </form>
      ) : pendingAnchor && workspaceMode !== 'source' ? (
        <div className="selection-ready-bar">
          <div className="selection-ready-quote">“{pendingAnchor.quote}”</div>
          <button
            type="button"
            className="btn btn-compact btn-primary"
            onClick={onOpenComposer}
          >
            Comment on selection
          </button>
        </div>
      ) : workspaceMode === 'source' ? (
        <div className="review-quiet-hint">
          Prose anchors attach in rendered view. Select a thread to view its passage in Read mode.
        </div>
      ) : visibleThreads.length === 0 ? (
        <div className="review-empty-state">
          No {showResolved ? '' : 'open '}threads yet. Highlight any prose phrase in the document to add feedback.
        </div>
      ) : (
        <div className="review-quiet-hint">
          Select a thread to reply, or highlight prose in the document to add a note.
        </div>
      )}

      {unattachedThreads.length > 0 && (
        <div className="thread-section">
          <div className="unattached-heading">
            Needs re-anchoring ({unattachedThreads.length})
          </div>
          {unattachedThreads.map(renderThreadCard)}
        </div>
      )}

      {attachedThreads.length > 0 && (
        <div className="thread-section">
          {attachedThreads.map(renderThreadCard)}
        </div>
      )}
    </aside>
  );
}
