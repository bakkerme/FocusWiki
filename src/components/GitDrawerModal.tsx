import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Code2,
  ExternalLink,
  FileDiff,
  FilePlus2,
  FileText,
  FileX2,
  GitBranch,
  GitPullRequest,
  Layers,
  MessageSquare,
  RefreshCw,
  X
} from 'lucide-react';
import type {
  ChangeFileSummary,
  CodeDiffHunk,
  DiffToken,
  GitChangeReviewPayload,
  InertReviewBlock,
  MarkdownReviewEntry
} from '../../shared/changeReview';
import type { ProjectSummary } from '../../shared/types';
import { hasWorkingTreeStatus, managedGitLabel, workingTreeLabel, type ProjectGitStatusView } from '../utils/gitStatus';
import { useModalOverlayFocus } from '../utils/overlayModal';

interface Props {
  project: ProjectSummary;
  activeDocPath?: string;
  onClose: () => void;
  onStatusChanged: () => Promise<unknown>;
}

type ReviewResponse = GitChangeReviewPayload & { reviewId?: string };
const UNCONFIRMED_PROPOSAL =
  'Could not confirm the pull request. Your files are saved locally. Retry this proposal from the same review.';

function renderDiffTokens(tokens: DiffToken[]) {
  return tokens.map((tok, idx) => {
    if (tok.op === 'equal') {
      return <span key={idx}>{tok.text}</span>;
    }
    if (tok.op === 'del') {
      return (
        <del key={idx} className="rich-token-del">
          {tok.text}
        </del>
      );
    }
    return (
      <ins key={idx} className="rich-token-add">
        {tok.text}
      </ins>
    );
  });
}

function renderInertBlock(block: InertReviewBlock) {
  switch (block.kind) {
    case 'heading': {
      const Tag = (
        block.level === 1
          ? 'h3'
          : block.level === 2
            ? 'h4'
            : 'h5'
      ) as 'h3' | 'h4' | 'h5';
      return <Tag className={`rich-md-heading level-${block.level}`}>{block.text}</Tag>;
    }
    case 'paragraph':
      return <p className="rich-md-paragraph">{block.text}</p>;
    case 'blockquote':
      return <blockquote className="rich-md-blockquote">{block.text}</blockquote>;
    case 'list': {
      const ListTag = block.ordered ? 'ol' : 'ul';
      return (
        <ListTag className="rich-md-list">
          {block.items.map((item, idx) => (
            <li key={idx}>
              {typeof item.checked === 'boolean' && (
                <span className="rich-task-box" aria-hidden="true">
                  {item.checked ? '☑ ' : '☐ '}
                </span>
              )}
              <span>{item.text}</span>
            </li>
          ))}
        </ListTag>
      );
    }
    case 'table':
      return (
        <div className="rich-table-scroll">
          <table className="rich-md-table">
            <thead>
              <tr>
                {block.headers.map((h, idx) => (
                  <th key={idx}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rIdx) => (
                <tr key={rIdx}>
                  {row.map((cell, cIdx) => (
                    <td key={cIdx}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'embed':
      return (
        <div className="rich-inert-embed">
          <div className="rich-inert-embed-top">
            <Layers size={13} aria-hidden="true" />
            <strong>Embedded component: {block.descriptor.title}</strong>
            <span className="rich-inert-note">Inert metadata preview</span>
          </div>
          <div className="rich-inert-embed-meta">
            <span>
              src: <code>{block.descriptor.src}</code>
            </span>
            <span>
              height: <code>{block.descriptor.height}px</code>
            </span>
            <span>
              props: <code>{JSON.stringify(block.descriptor.props)}</code>
            </span>
          </div>
        </div>
      );
    case 'code':
      return (
        <div className="rich-code-fence">
          {block.language && <div className="rich-code-lang">{block.language}</div>}
          <pre>{block.code}</pre>
        </div>
      );
    case 'hr':
      return <hr className="rich-md-hr" />;
    case 'raw':
      return (
        <div className="rich-code-fence">
          <div className="rich-code-lang">Preserved Markdown ({block.rawKind})</div>
          <pre>{block.value}</pre>
        </div>
      );
  }
}

function renderCodeHunks(hunks: CodeDiffHunk[]) {
  if (hunks.length === 0) {
    return <div className="rich-empty-note">No line differences against HEAD.</div>;
  }
  return (
    <div className="code-hunks-list">
      {hunks.map((hunk, hIdx) => (
        <div key={hIdx} className="code-hunk-card">
          <div className="code-hunk-header">{hunk.header}</div>
          <div className="code-hunk-table-wrap">
            <table className="code-hunk-table">
              <tbody>
                {hunk.lines.map((line, lIdx) => (
                  <tr key={lIdx} className={`code-line-row is-${line.kind}`}>
                    <td className="code-line-num">{line.oldLine ?? ''}</td>
                    <td className="code-line-num">{line.newLine ?? ''}</td>
                    <td className="code-line-sig" aria-hidden="true">
                      {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                    </td>
                    <td className="code-line-text">{line.text || ' '}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function renderMarkdownEntry(entry: MarkdownReviewEntry, index: number) {
  if (entry.type === 'unchanged-group') {
    return (
      <div key={index} className="rich-unchanged-divider">
        <span>
          {entry.count} unchanged {entry.count === 1 ? 'section block' : 'section blocks'}
        </span>
      </div>
    );
  }

  if (entry.type === 'context-heading') {
    return (
      <div key={index} className="rich-context-heading">
        <span className="rich-context-marker">Section</span>
        <span className="rich-context-title">{entry.text}</span>
      </div>
    );
  }

  if (entry.type === 'formatting-only') {
    return (
      <div key={index} className="rich-change-card is-formatting-only">
        <div className="rich-change-card-head">
          <span className="change-pill is-formatting">Formatting only</span>
          <span className="rich-formatting-explanation">{entry.note}</span>
        </div>
        <details className="rich-formatting-details">
          <summary>Inspect rendered {entry.block.kind === 'table' ? 'table' : 'block'}</summary>
          <div className="rich-formatting-preview">{renderInertBlock(entry.block)}</div>
        </details>
      </div>
    );
  }

  if (entry.type === 'added') {
    return (
      <div key={index} className="rich-change-card is-added">
        <div className="rich-change-card-head">
          <span className="change-pill is-added">Added {entry.block.kind}</span>
        </div>
        <div className="rich-change-body">{renderInertBlock(entry.block)}</div>
      </div>
    );
  }

  if (entry.type === 'removed') {
    return (
      <div key={index} className="rich-change-card is-removed">
        <div className="rich-change-card-head">
          <span className="change-pill is-removed">Removed {entry.block.kind}</span>
        </div>
        <div className="rich-change-body is-struck">{renderInertBlock(entry.block)}</div>
      </div>
    );
  }

  // entry.type === 'modified'
  const { before, after } = entry;

  if (
    entry.wordDiff &&
    (after.kind === 'paragraph' || after.kind === 'blockquote' || after.kind === 'heading')
  ) {
    return (
      <div key={index} className="rich-change-card is-modified">
        <div className="rich-change-card-head">
          <span className="change-pill is-modified">Edited {after.kind}</span>
        </div>
        <div className="rich-change-body">
          {after.kind === 'blockquote' ? (
            <blockquote className="rich-md-blockquote">{renderDiffTokens(entry.wordDiff)}</blockquote>
          ) : after.kind === 'heading' ? (
            <div className={`rich-md-heading level-${after.level}`}>
              {renderDiffTokens(entry.wordDiff)}
            </div>
          ) : (
            <p className="rich-md-paragraph">{renderDiffTokens(entry.wordDiff)}</p>
          )}
        </div>
      </div>
    );
  }

  if (entry.tableDiff && before.kind === 'table' && after.kind === 'table') {
    const td = entry.tableDiff;
    return (
      <div key={index} className="rich-change-card is-modified">
        <div className="rich-change-card-head">
          <span className="change-pill is-modified">
            {td.alignmentChangedOnly ? 'Table column alignment changed' : 'Edited table'}
          </span>
        </div>
        <div className="rich-table-scroll">
          <table className="rich-md-table is-diff-table">
            <thead>
              <tr>
                {td.headers.map((h, cIdx) => (
                  <th key={cIdx}>
                    <div>{h.tokens ? renderDiffTokens(h.tokens) : h.after || h.before}</div>
                    {h.alignBefore !== h.alignAfter && (
                      <div className="rich-align-note">
                        align: {h.alignBefore ?? 'auto'} → {h.alignAfter ?? 'auto'}
                      </div>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {td.rows.map((row, rIdx) => (
                <tr key={rIdx} className={`rich-table-row is-${row.status}`}>
                  {row.cells.map((cell, cIdx) => (
                    <td key={cIdx}>
                      {row.status === 'added' ? (
                        <ins className="rich-token-add">{cell.after}</ins>
                      ) : row.status === 'removed' ? (
                        <del className="rich-token-del">{cell.before}</del>
                      ) : cell.tokens ? (
                        renderDiffTokens(cell.tokens)
                      ) : (
                        cell.after
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (entry.listItemDiffs && after.kind === 'list') {
    const ListTag = after.ordered ? 'ol' : 'ul';
    return (
      <div key={index} className="rich-change-card is-modified">
        <div className="rich-change-card-head">
          <span className="change-pill is-modified">Edited list</span>
        </div>
        <ListTag className="rich-md-list">
          {entry.listItemDiffs.map((item, idx) => (
            <li key={idx} className={`rich-list-diff-item is-${item.status}`}>
              {(typeof item.checkedBefore === 'boolean' ||
                typeof item.checkedAfter === 'boolean') && (
                <span className="rich-task-box">
                  {item.checkedBefore !== item.checkedAfter &&
                  typeof item.checkedBefore === 'boolean' &&
                  typeof item.checkedAfter === 'boolean'
                    ? `${item.checkedBefore ? '☑' : '☐'} → ${item.checkedAfter ? '☑ ' : '☐ '}`
                    : item.checkedAfter
                      ? '☑ '
                      : '☐ '}
                </span>
              )}
              {item.status === 'added' ? (
                <ins className="rich-token-add">{item.textAfter}</ins>
              ) : item.status === 'removed' ? (
                <del className="rich-token-del">{item.textBefore}</del>
              ) : item.tokens ? (
                renderDiffTokens(item.tokens)
              ) : (
                <span>{item.textAfter}</span>
              )}
            </li>
          ))}
        </ListTag>
      </div>
    );
  }

  if (before.kind === 'embed' && after.kind === 'embed') {
    return (
      <div key={index} className="rich-change-card is-modified">
        <div className="rich-change-card-head">
          <span className="change-pill is-modified">Edited embedded component</span>
          <span className="rich-inert-note">Inert metadata diff — component not executed</span>
        </div>
        <div className="rich-embed-diff-grid">
          <div>
            <div className="rich-side-label">Before (HEAD)</div>
            {renderInertBlock(before)}
          </div>
          <div>
            <div className="rich-side-label">Current working file</div>
            {renderInertBlock(after)}
          </div>
        </div>
      </div>
    );
  }

  if (entry.codeHunks) {
    return (
      <div key={index} className="rich-change-card is-modified">
        <div className="rich-change-card-head">
          <span className="change-pill is-modified">Edited code block</span>
        </div>
        {renderCodeHunks(entry.codeHunks)}
      </div>
    );
  }

  return (
    <div key={index} className="rich-change-card is-modified">
      <div className="rich-change-card-head">
        <span className="change-pill is-modified">Edited {after.kind}</span>
      </div>
      <div className="rich-embed-diff-grid">
        <div>
          <div className="rich-side-label">Before (HEAD)</div>
          {renderInertBlock(before)}
        </div>
        <div>
          <div className="rich-side-label">Current working file</div>
          {renderInertBlock(after)}
        </div>
      </div>
    </div>
  );
}

function pullRequestLink(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https:\/\/[^/\\]/i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function GitDrawerModal({ project, activeDocPath, onClose, onStatusChanged }: Props) {
  const modalRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [viewMode, setViewMode] = useState<'rich' | 'raw-file' | 'raw-all'>('rich');
  const [message, setMessage] = useState('');
  const [publishing, setPublishing] = useState(false);
  const publishingRef = useRef(false);
  const [retry, setRetry] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<{ sha: string; url: string | null } | null>(null);
  const gitUrl = `/api/projects/${encodeURIComponent(project.id)}/git`;

  function dismiss() {
    if (!publishingRef.current) onClose();
  }

  useModalOverlayFocus({
    active: true,
    containerRef: modalRef,
    initialFocusSelector: '.change-review-close-btn',
    onDismiss: dismiss
  });

  const loadReview = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setReview(null);
    setSelectedPaths([]);
    setViewMode('rich');
    setRetry(false);
    setError(null);

    try {
      const response = await fetch(`${gitUrl}/diff`, { cache: 'no-store', signal });
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Managed change review is unavailable for this repository. Ask your workspace operator about enrollment.');
        }
        throw new Error(`Unable to load working changes (${response.status}). Try starting a new review.`);
      }
      const data = (await response.json()) as ReviewResponse;
      if (signal?.aborted) return;
      setReview(data);
      setSelectedPath((previous) => {
        const preferred = [previous, activeDocPath].find((path) => data.files.some((file) => file.path === path));
        return preferred ?? data.files[0]?.path ?? '';
      });
    } catch (err) {
      if (!signal?.aborted) {
        setError(err instanceof Error ? err.message : 'Unable to load working changes.');
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [activeDocPath, gitUrl]);

  useEffect(() => {
    const controller = new AbortController();
    void loadReview(controller.signal);
    return () => controller.abort();
  }, [loadReview]);

  const reviewId = typeof review?.reviewId === 'string' && review.reviewId.trim() ? review.reviewId : null;
  const canPublish = !loading && !publishing && Boolean(reviewId && selectedPaths.length && message.trim());

  async function publishProposal(event: React.FormEvent) {
    event.preventDefault();
    if (!canPublish || !reviewId || publishingRef.current) return;

    publishingRef.current = true;
    setPublishing(true);
    setError(null);
    setPublished(null);
    try {
      const response = await fetch(`${gitUrl}/propose`, {
        method: 'POST',
        mode: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-FocusWiki-Intent': 'propose'
        },
        body: JSON.stringify({ reviewId, message: message.trim(), paths: selectedPaths })
      });
      const result = await response.json().catch(() => null) as { sha?: unknown; url?: unknown } | null;

      if ([409, 410, 412].includes(response.status)) {
        setReview(null);
        setSelectedPaths([]);
        setRetry(false);
        setError('This review is stale or the upstream base moved. Start a new review and select the files again.');
        return;
      }
      if ([401, 403, 404].includes(response.status)) {
        setError('Publishing is unavailable for this repository. Ask your workspace operator to check managed Git access.');
        return;
      }
      if (response.status === 400 || response.status === 422) {
        setRetry(false);
        setError('The server rejected this proposal. Check the message and selected files before trying again.');
        return;
      }
      if (!response.ok || typeof result?.sha !== 'string' || !result.sha.trim()) {
        setRetry(true);
        setError(UNCONFIRMED_PROPOSAL);
        return;
      }

      setPublished({ sha: result.sha, url: pullRequestLink(result.url) });
      setReview(null);
      setSelectedPaths([]);
      setMessage('');
      setRetry(false);
      void onStatusChanged().catch(() => undefined);
    } catch {
      setRetry(true);
      setError(UNCONFIRMED_PROPOSAL);
    } finally {
      publishingRef.current = false;
      setPublishing(false);
    }
  }

  const selectedFile = review?.files.find((file) => file.path === selectedPath) ?? review?.files[0] ?? null;
  const projectStatus: ProjectGitStatusView = project.git;
  const status: ProjectGitStatusView = review?.status ?? projectStatus;
  const checkoutStatus = projectStatus.state ? projectStatus : status;
  const changedCount = review?.files.length ?? 0;

  function renderFileIcon(file: ChangeFileSummary) {
    if (file.status === 'added' || file.status === 'untracked') {
      return <FilePlus2 size={14} className="change-file-icon is-added" aria-hidden="true" />;
    }
    if (file.status === 'deleted') {
      return <FileX2 size={14} className="change-file-icon is-removed" aria-hidden="true" />;
    }
    if (file.category === 'comments') {
      return <MessageSquare size={14} className="change-file-icon" aria-hidden="true" />;
    }
    if (file.category === 'code') {
      return <Code2 size={14} className="change-file-icon" aria-hidden="true" />;
    }
    return <FileText size={14} className="change-file-icon" aria-hidden="true" />;
  }

  function renderSelectedFileRichBody(file: ChangeFileSummary) {
    if (file.isBinary) {
      return (
        <div className="rich-status-box">
          <strong>Binary file ({file.status})</strong>
          <p>
            Rich text comparison is unavailable for binary content ({file.beforeBytes} B in HEAD →{' '}
            {file.afterBytes} B in working copy). This file will be included in the local commit.
          </p>
        </div>
      );
    }

    if (file.category === 'markdown' && file.markdownReview) {
      const md = file.markdownReview;
      return (
        <div className="rich-markdown-review">
          {file.truncated && (
            <div className="rich-truncation-banner">
              Large document preview truncated at 256 KB. Switch to Raw git diff to inspect full patch lines.
            </div>
          )}

          {file.formattingOnly ? (
            <div className="rich-summary-callout is-formatting">
              <strong>Formatting-only Markdown change</strong>
              <span>
                No prose, heading, embed, or table cell values changed relative to HEAD — only Markdown syntax spacing was normalized.
              </span>
            </div>
          ) : md.formattingOnlyTables > 0 && md.substantiveCount > 0 ? (
            <div className="rich-summary-callout">
              <strong>
                {md.substantiveCount} content {md.substantiveCount === 1 ? 'change' : 'changes'} +{' '}
                {md.formattingOnlyTables} formatting-only{' '}
                {md.formattingOnlyTables === 1 ? 'table' : 'tables'}
              </strong>
              <span>
                Content edits are highlighted below; pipe-padding changes on untouched table cells are separated so they don’t obscure prose edits.
              </span>
            </div>
          ) : null}

          <div className="rich-entries-stack">
            {md.entries.length === 0 ? (
              <div className="rich-empty-note">Whitespace-only difference against HEAD.</div>
            ) : (
              md.entries.map((entry, idx) => renderMarkdownEntry(entry, idx))
            )}
          </div>
        </div>
      );
    }

    if (file.category === 'comments' && file.commentReview && !file.commentReview.parseError) {
      const cr = file.commentReview;
      return (
        <div className="rich-comments-review">
          {cr.documentPath && (
            <div className="rich-context-heading">
              <span className="rich-context-marker">Sidecar target</span>
              <span className="rich-context-title">{cr.documentPath}</span>
            </div>
          )}
          {cr.changes.length === 0 ? (
            <div className="rich-empty-note">Formatting-only update in comment sidecar JSON.</div>
          ) : (
            cr.changes.map((c) => (
              <div key={c.threadId} className={`rich-change-card is-${c.changeKind === 'added' ? 'added' : c.changeKind === 'removed' ? 'removed' : 'modified'}`}>
                <div className="rich-change-card-head">
                  <span
                    className={`change-pill is-${
                      c.changeKind === 'added'
                        ? 'added'
                        : c.changeKind === 'removed'
                          ? 'removed'
                          : 'modified'
                    }`}
                  >
                    {c.summary}
                  </span>
                </div>
                {c.quote && <div className="quote-preview">“{c.quote}”</div>}
                {c.addedMessages.length > 0 && (
                  <div className="rich-comment-messages">
                    {c.addedMessages.map((m, idx) => (
                      <div key={idx} className="rich-comment-msg">
                        <span className="msg-author">{m.author}</span>{' '}
                        <span className="role-tag">{m.role}</span>
                        <div className="msg-body">{m.body}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      );
    }

    if (file.codeReview) {
      return (
        <div className="rich-code-review">
          <div className="rich-code-fallback-banner">
            <Code2 size={14} aria-hidden="true" />
            <span>
              Source code diff ({file.codeReview.languageHint}) · +{file.codeReview.addedLines} / −
              {file.codeReview.removedLines} lines
            </span>
          </div>
          {file.truncated && (
            <div className="rich-truncation-banner">
              Diff preview truncated for size. Switch to Raw git diff for full git output.
            </div>
          )}
          {renderCodeHunks(file.codeReview.hunks)}
        </div>
      );
    }

    return (
      <pre className="diff-viewer">{file.rawPatch || 'No textual diff lines available.'}</pre>
    );
  }

  return (
    <div className="modal-backdrop" onClick={dismiss}>
      <div
        ref={modalRef}
        className="modal-panel change-review-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="change-review-title"
        tabIndex={-1}
      >
        <div className="change-review-header">
          <div className="change-review-title-block">
            <div className="change-review-title-row">
              <h2 id="change-review-title">Review working changes</h2>
              {status.branch && status.branch !== 'uninitialized' && (
                <span className="code-chip">
                  <GitBranch size={11} aria-hidden="true" /> {status.branch}
                  {status.headSha && <span title={status.headSha}>@ {status.headSha.slice(0, 12)}</span>}
                </span>
              )}
            </div>
            <div className="change-review-checkout" title={project.rootPath}>
              Checkout <code>{project.rootPath}</code>
            </div>
            <div className="change-review-status">
              {managedGitLabel(projectStatus)}
              {hasWorkingTreeStatus(checkoutStatus) && <> · {workingTreeLabel(checkoutStatus)}</>}
              {hasWorkingTreeStatus(checkoutStatus) && Boolean(checkoutStatus.ahead || checkoutStatus.behind) && (
                <> · {checkoutStatus.ahead ?? 0} ahead, {checkoutStatus.behind ?? 0} behind last known upstream</>
              )}
              {projectStatus.fetchState === 'pending' && <> · Upstream check pending</>}
              {projectStatus.fetchState === 'unavailable' && <> · Upstream check unavailable</>}
            </div>
          </div>

          <div className="change-review-header-actions">
            <button
              type="button"
              className="btn btn-compact"
              onClick={() => {
                void loadReview();
                void onStatusChanged().catch(() => undefined);
              }}
              disabled={loading || publishing}
            >
              <RefreshCw size={13} aria-hidden="true" />
              <span>New review</span>
            </button>
            <button
              type="button"
              className="icon-btn panel-close-btn change-review-close-btn"
              onClick={dismiss}
              disabled={publishing}
              aria-label="Close Git dialog"
              title="Close"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        {published && (
          <div className="notice-banner change-review-banner" role="status">
            <span>
              Pull request published for <code>{published.sha}</code>. Check its review and merge status on your Git host.
              {!published.url && ' The server returned no usable link.'}
            </span>
            {published.url && (
              <a className="btn btn-compact" href={published.url} target="_blank" rel="noopener noreferrer">
                Open pull request <ExternalLink size={13} aria-hidden="true" />
              </a>
            )}
          </div>
        )}

        {error && (
          <div className="notice-banner conflict change-review-banner" role="alert">{error}</div>
        )}

        {loading ? (
          <div className="change-review-empty" role="status">Inspecting files saved on disk…</div>
        ) : review && changedCount > 0 ? (
          <div className="change-review-body">
            <aside className="change-file-rail" aria-label="Changed files in working copy">
              <div className="change-rail-heading">
                Changed files ({review.files.length})
              </div>
              <div className="change-file-list">
                {review.files.map((file) => {
                  const active = selectedFile?.path === file.path && viewMode !== 'raw-all';
                  return (
                    <div className="change-file-select-row" key={file.path}>
                      {reviewId && (
                        <label className="change-file-checkbox">
                          <input
                            type="checkbox"
                            aria-label={`Include ${file.path} in proposal`}
                            checked={selectedPaths.includes(file.path)}
                            disabled={publishing || retry}
                            onChange={(event) => {
                              const checked = event.target.checked;
                              setSelectedPaths((previous) => checked
                                ? [...previous, file.path]
                                : previous.filter((path) => path !== file.path));
                            }}
                          />
                        </label>
                      )}
                      <button
                        type="button"
                        className={`change-file-item ${active ? 'active' : ''}`}
                        onClick={() => {
                          setSelectedPath(file.path);
                          if (viewMode === 'raw-all') {
                            setViewMode('rich');
                          }
                        }}
                      >
                        <div className="change-file-item-top">
                          {renderFileIcon(file)}
                          <span className="change-file-human">{file.humanTitle}</span>
                        </div>
                        <div className="change-file-path">
                          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                        </div>
                        <div className="change-file-meta-row">
                          <span
                            className={`change-status-tag is-${
                              file.formattingOnly ? 'formatting' : file.status
                            }`}
                          >
                            {file.formattingOnly ? 'formatting' : file.status}
                          </span>
                          <span className="change-file-summary">{file.summaryLabel}</span>
                        </div>
                      </button>
                    </div>
                  );
                })}
              </div>
            </aside>

            <section className="change-detail-pane" aria-label="Selected file comparison">
              {selectedFile && (
                <>
                  <div className="change-detail-toolbar">
                    <div className="change-detail-identity">
                      <div className="change-detail-title">{selectedFile.humanTitle}</div>
                      <div className="change-detail-path">
                        {selectedFile.oldPath
                          ? `${selectedFile.oldPath} → ${selectedFile.path}`
                          : selectedFile.path}
                      </div>
                    </div>

                    <div
                      className="mode-switch change-view-switch"
                      role="group"
                      aria-label="Diff display mode"
                    >
                      <button
                        type="button"
                        className={viewMode === 'rich' ? 'active' : ''}
                        aria-pressed={viewMode === 'rich'}
                        onClick={() => setViewMode('rich')}
                      >
                        Rich review
                      </button>
                      <button
                        type="button"
                        className={viewMode === 'raw-file' ? 'active' : ''}
                        aria-pressed={viewMode === 'raw-file'}
                        onClick={() => setViewMode('raw-file')}
                      >
                        Raw diff
                      </button>
                      {review.files.length > 1 && (
                        <button
                          type="button"
                          className={viewMode === 'raw-all' ? 'active' : ''}
                          aria-pressed={viewMode === 'raw-all'}
                          onClick={() => setViewMode('raw-all')}
                        >
                          All raw ({review.files.length})
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="change-detail-scroll">
                    {viewMode === 'rich' ? (
                      renderSelectedFileRichBody(selectedFile)
                    ) : viewMode === 'raw-file' ? (
                      <pre className="diff-viewer">
                        {selectedFile.rawPatch || 'No textual git diff lines for this file.'}
                      </pre>
                    ) : (
                      <pre className="diff-viewer">
                        {review.diff || 'No uncommitted diff lines.'}
                      </pre>
                    )}
                  </div>
                </>
              )}
            </section>
          </div>
        ) : (
          <div className="change-review-empty">
            {review?.status.isClean === true && (
              <CheckCircle2 size={20} aria-hidden="true" />
            )}
            <div>
              {review?.status.isClean === true
                ? 'No reviewable changes in this snapshot.'
                : review
                  ? 'The server returned no files for review.'
                  : 'Start a new review to compare the files currently saved on disk.'}
              {reviewId && review?.commitScopeNote && <p>{review.commitScopeNote}</p>}
            </div>
          </div>
        )}

        {review && !reviewId && changedCount > 0 && (
          <div className="change-proposal-footer">
            <div className="change-proposal-scope">
              This review is available for inspection. Ask your workspace operator to enable publishing.
            </div>
          </div>
        )}
        {reviewId && changedCount > 0 && (
          <form className="change-proposal-footer" onSubmit={(event) => void publishProposal(event)}>
            <div className="change-proposal-scope" id="proposal-scope">
              <FileDiff size={13} aria-hidden="true" />
              <span>
                {selectedPaths.length} of {changedCount} selected. Saved changes are local until you propose them.
              </span>
            </div>
            {review?.commitScopeNote && <div className="change-proposal-note">{review.commitScopeNote}</div>}
            <div className="change-proposal-inputs">
              <input
                type="text"
                className="field-input"
                aria-label="Proposal message"
                placeholder="Summarize the selected changes"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                disabled={publishing || retry}
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!canPublish}
                aria-describedby="proposal-scope"
              >
                <GitPullRequest size={14} aria-hidden="true" />
                {publishing ? 'Proposing…' : retry ? 'Retry proposal' : 'Propose changes'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
