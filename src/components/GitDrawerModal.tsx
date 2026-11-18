import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Code2,
  Download,
  FileDiff,
  FilePlus2,
  FileText,
  FileX2,
  GitBranch,
  GitPullRequest,
  KeyRound,
  Layers,
  MessageSquare,
  RefreshCw,
  Search,
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
import type { GitCommitSelection, GitRefsPayload, GitRepoStatus, ProjectSummary } from '../../shared/types';
import { useModalOverlayFocus } from '../utils/overlayModal';

interface Props {
  project: ProjectSummary;
  activeDocPath?: string;
  defaultAuthorName?: string;
  defaultAuthorEmail?: string;
  defaultTab?: 'changes' | 'branches';
  autoFetchOnOpen?: boolean;
  includePrRefsOnFetch?: boolean;
  onOpenCredentialsSettings?: (host?: string) => void;
  onClose: () => void;
  onCommitted: () => Promise<void>;
  onRepoSynced?: (notice: string) => Promise<void>;
}

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

export function GitDrawerModal({
  project,
  activeDocPath,
  defaultAuthorName,
  defaultAuthorEmail,
  defaultTab = 'changes',
  autoFetchOnOpen = false,
  includePrRefsOnFetch = true,
  onOpenCredentialsSettings,
  onClose,
  onCommitted,
  onRepoSynced
}: Props) {
  const modalRef = useRef<HTMLDivElement | null>(null);
  const [modalTab, setModalTab] = useState<'changes' | 'branches'>(defaultTab);
  const [loading, setLoading] = useState<boolean>(true);
  const [refsLoading, setRefsLoading] = useState<boolean>(true);
  const [review, setReview] = useState<GitChangeReviewPayload>({
    status: { ...project.git, isClean: project.git.isClean === true },
    diff: '',
    snapshotDigest: '',
    commitScopeNote: '',
    files: []
  });
  const [refsData, setRefsData] = useState<GitRefsPayload | null>(null);
  const [branchFilter, setBranchFilter] = useState<string>('');
  const [prNumberInput, setPrNumberInput] = useState<string>('');
  const [syncingAction, setSyncingAction] = useState<'fetch' | 'pull' | 'checkout' | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [viewMode, setViewMode] = useState<'rich' | 'raw-file' | 'raw-all'>('rich');
  const [commitMessage, setCommitMessage] = useState<string>('');
  const [authorName, setAuthorName] = useState<string>(defaultAuthorName || 'Workspace Author');
  const [committing, setCommitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [authPromptHost, setAuthPromptHost] = useState<string | null>(null);
  const [commitResult, setCommitResult] = useState<string | null>(null);

  useModalOverlayFocus({
    active: true,
    containerRef: modalRef,
    initialFocusSelector: '.change-review-close-btn',
    onDismiss: onClose
  });

  async function loadDiff(preferredPath?: string) {
    setLoading(true);
    setError(null);
    setAuthPromptHost(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/git/diff`);
      if (!res.ok) throw new Error(`Failed to read working-tree changes (${res.status})`);
      const data = (await res.json()) as GitChangeReviewPayload;
      setReview(data);
      setSelectedPaths(data.status.changedFiles.map((file) => file.path));
      const candidates = data.files.map((f) => f.path);
      setSelectedPath((prev) => {
        if (preferredPath && candidates.includes(preferredPath)) return preferredPath;
        if (prev && candidates.includes(prev)) return prev;
        if (activeDocPath && candidates.includes(activeDocPath)) return activeDocPath;
        return candidates[0] ?? '';
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to inspect Git working tree');
    } finally {
      setLoading(false);
    }
  }

  async function loadRefs() {
    setRefsLoading(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/git/refs`);
      if (!res.ok) return;
      const data = (await res.json()) as GitRefsPayload;
      setRefsData(data);
    } catch {
      // non-fatal
    } finally {
      setRefsLoading(false);
    }
  }

  useEffect(() => {
    void loadDiff(activeDocPath);
    void loadRefs();
    if (autoFetchOnOpen && project.git.remoteName) {
      void handleFetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  async function handleFetch() {
    if (syncingAction) return;
    setSyncingAction('fetch');
    setError(null);
    setAuthPromptHost(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/git/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includePrRefs: includePrRefsOnFetch })
      });
      const body = (await res.json()) as GitRefsPayload & {
        error?: string;
        host?: string | null;
        message?: string;
      };
      if (!res.ok) {
        if (res.status === 401 || body.error === 'auth_required') {
          setAuthPromptHost(body.host ?? null);
        }
        throw new Error(body.message ?? 'Fetch failed');
      }
      setRefsData(body);
      setCommitResult(
        `Fetched remote branches${body.pullRequests.length > 0 ? ` and ${body.pullRequests.length} PR refs` : ''} from ${body.remoteName ?? 'origin'}.`
      );
      await onCommitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fetch failed');
    } finally {
      setSyncingAction(null);
    }
  }

  async function handlePull() {
    if (syncingAction) return;
    setSyncingAction('pull');
    setError(null);
    setAuthPromptHost(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/git/pull`, {
        method: 'POST'
      });
      const body = (await res.json()) as {
        status?: GitRepoStatus;
        summary?: string;
        updated?: boolean;
        error?: string;
        host?: string | null;
        message?: string;
      };
      if (!res.ok) {
        if (res.status === 401 || body.error === 'auth_required') {
          setAuthPromptHost(body.host ?? null);
        }
        throw new Error(body.message ?? 'Pull failed');
      }
      const notice = body.summary ?? 'Pulled latest changes from remote.';
      setCommitResult(notice);
      await loadDiff(activeDocPath);
      await loadRefs();
      if (onRepoSynced) {
        await onRepoSynced(notice);
      } else {
        await onCommitted();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pull failed');
    } finally {
      setSyncingAction(null);
    }
  }

  async function handleCheckoutTarget(target: {
    kind: 'local' | 'remote' | 'pr';
    ref: string;
    prNumber?: number;
  }) {
    if (syncingAction) return;
    setSyncingAction('checkout');
    setError(null);
    setAuthPromptHost(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/git/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target)
      });
      const body = (await res.json()) as {
        status?: GitRepoStatus;
        branch?: string;
        error?: string;
        host?: string | null;
        message?: string;
      };
      if (!res.ok) {
        if (res.status === 401 || body.error === 'auth_required') {
          setAuthPromptHost(body.host ?? null);
        }
        throw new Error(body.message ?? 'Branch checkout failed');
      }
      const notice = `Switched repository to ${body.branch ?? target.ref}.`;
      setCommitResult(notice);
      if (target.kind === 'pr') setPrNumberInput('');
      await loadDiff(activeDocPath);
      await loadRefs();
      if (onRepoSynced) {
        await onRepoSynced(notice);
      } else {
        await onCommitted();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout failed');
    } finally {
      setSyncingAction(null);
    }
  }

  async function handleCommit(e: React.FormEvent) {
    e.preventDefault();
    if (!commitMessage.trim() || review.status.isClean || !selectedPaths.length) return;
    setCommitting(true);
    setError(null);
    setAuthPromptHost(null);
    try {
      const selection: GitCommitSelection = {
        paths: selectedPaths.length === review.status.changedFiles.length ? undefined : selectedPaths
      };
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/git/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: commitMessage.trim(),
          authorName: authorName.trim() || 'Workspace Author',
          ...(defaultAuthorEmail?.trim() ? { authorEmail: defaultAuthorEmail.trim() } : {}),
          ...selection,
          expectedSnapshotDigest: review.snapshotDigest
        })
      });

      const payload = (await res.json()) as {
        sha?: string;
        subject?: string;
        status?: GitRepoStatus;
        error?: string;
        message?: string;
        latestReview?: GitChangeReviewPayload;
      };

      if (res.status === 409 && payload.latestReview) {
        setReview(payload.latestReview);
        setSelectedPaths((previous) => previous.filter((path) => payload.latestReview!.status.changedFiles.some((file) => file.path === path)));
        const nextFiles = payload.latestReview.files.map((f) => f.path);
        if (!nextFiles.includes(selectedPath)) {
          setSelectedPath(nextFiles[0] ?? '');
        }
        setError(
          payload.message ??
            'Working files changed since this review opened. Inspect the updated file list before committing.'
        );
        return;
      }

      if (!res.ok) {
        throw new Error(payload.message ?? 'Git commit failed');
      }

      setCommitMessage('');
      setCommitResult(
        `Committed ${payload.sha}: ${payload.subject} (saved on local branch ${review.status.branch}; never pushed).`
      );
      await loadDiff();
      await onCommitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Git commit failed');
    } finally {
      setCommitting(false);
    }
  }

  const selectedFile: ChangeFileSummary | null =
    review.files.find((f) => f.path === selectedPath) ?? review.files[0] ?? null;

  const status = review.status;
  const changedCount = status.changedFiles.length;

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

  const filterNeedle = branchFilter.trim().toLowerCase();
  const localBranches = (refsData?.branches ?? []).filter(
    (b) =>
      b.kind === 'local' &&
      (!filterNeedle ||
        b.name.toLowerCase().includes(filterNeedle) ||
        b.subject.toLowerCase().includes(filterNeedle))
  );
  const remoteBranches = (refsData?.branches ?? []).filter(
    (b) =>
      b.kind === 'remote' &&
      (!filterNeedle ||
        b.name.toLowerCase().includes(filterNeedle) ||
        b.subject.toLowerCase().includes(filterNeedle))
  );
  const prRefs = (refsData?.pullRequests ?? []).filter(
    (pr) =>
      !filterNeedle ||
      `#${pr.number}`.includes(filterNeedle) ||
      pr.localBranch.toLowerCase().includes(filterNeedle) ||
      (pr.subject ?? '').toLowerCase().includes(filterNeedle)
  );
  const hasRemote = Boolean(refsData?.hasRemote ?? status.remoteName);
  const aheadCount = refsData?.ahead ?? status.ahead ?? 0;
  const behindCount = refsData?.behind ?? status.behind ?? 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={modalRef}
        className="modal-panel change-review-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Repository Git sync, branches, and working changes"
        tabIndex={-1}
      >
        <div className="change-review-header">
          <div className="change-review-title-block">
            <div className="change-review-title-row">
              <h2>Repository Git</h2>
              <span className="code-chip">
                <GitBranch size={11} aria-hidden="true" /> {status.branch}
                {status.headSha ? ` @ ${status.headSha}` : ''}
              </span>
              {aheadCount > 0 && (
                <span className="code-chip git-sync-chip" title={`${aheadCount} local commit(s) ahead`}>
                  <ArrowUp size={11} aria-hidden="true" /> {aheadCount}
                </span>
              )}
              {behindCount > 0 && (
                <span className="code-chip git-sync-chip is-behind" title={`${behindCount} commit(s) behind remote`}>
                  <ArrowDown size={11} aria-hidden="true" /> {behindCount}
                </span>
              )}
            </div>
            <div className="change-review-checkout" title={project.rootPath}>
              Checkout: <code>{project.rootPath}</code>
              {refsData?.remoteUrl && (
                <span className="git-remote-inline" title={refsData.remoteUrl}>
                  {' '}· Remote: <code>{refsData.remoteUrl}</code>
                </span>
              )}
            </div>
          </div>

          <div className="change-review-header-actions">
            {hasRemote && (
              <>
                <button
                  type="button"
                  className="btn btn-compact"
                  onClick={() => void handleFetch()}
                  disabled={Boolean(syncingAction) || committing}
                  title="Fetch latest remote branches and pull request refs"
                >
                  <RefreshCw size={13} aria-hidden="true" />
                  <span>{syncingAction === 'fetch' ? 'Fetching…' : 'Fetch'}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-compact"
                  onClick={() => void handlePull()}
                  disabled={!status.isClean || Boolean(syncingAction) || committing}
                  title={
                    !status.isClean
                      ? 'Commit or revert local changes before pulling'
                      : 'Fast-forward pull current branch from remote'
                  }
                >
                  <Download size={13} aria-hidden="true" />
                  <span>{syncingAction === 'pull' ? 'Pulling…' : 'Pull'}</span>
                </button>
              </>
            )}
            <button
              type="button"
              className="btn btn-compact"
              onClick={() => {
                void loadDiff(selectedPath);
                void loadRefs();
              }}
              disabled={loading || committing || Boolean(syncingAction)}
              title="Refresh Git status"
            >
              <RefreshCw size={13} aria-hidden="true" />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              className="icon-btn panel-close-btn change-review-close-btn"
              onClick={onClose}
              aria-label="Close Git dialog"
              title="Close"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="git-modal-subbar">
          <div className="mode-switch" role="tablist" aria-label="Git inspection view">
            <button
              type="button"
              role="tab"
              aria-selected={modalTab === 'changes'}
              className={modalTab === 'changes' ? 'active' : ''}
              onClick={() => setModalTab('changes')}
            >
              <span>Working changes{changedCount > 0 ? ` (${changedCount})` : ''}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={modalTab === 'branches'}
              className={modalTab === 'branches' ? 'active' : ''}
              onClick={() => setModalTab('branches')}
            >
              <GitBranch size={12} aria-hidden="true" />
              <span>Branches & PRs</span>
            </button>
          </div>
        </div>

        {commitResult && (
          <div className="notice-banner change-review-banner">
            <span>{commitResult}</span>
          </div>
        )}

        {error && (
          <div className="notice-banner conflict change-review-banner">
            <span>{error}</span>
            {authPromptHost && onOpenCredentialsSettings && (
              <button
                type="button"
                className="btn btn-compact"
                onClick={() => {
                  onClose();
                  onOpenCredentialsSettings(authPromptHost);
                }}
              >
                <KeyRound size={12} aria-hidden="true" />
                <span>Configure PAT for {authPromptHost}</span>
              </button>
            )}
          </div>
        )}

        {modalTab === 'changes' ? (
          <>
            {loading ? (
              <div className="change-review-empty">Inspecting working copy against HEAD…</div>
            ) : status.isClean || review.files.length === 0 ? (
              <div className="change-review-empty">
                <CheckCircle2 size={20} aria-hidden="true" />
                <div>
                  <strong>Working copy matches HEAD ({status.branch})</strong>
                  <p>
                    Autosaved edits, comment updates, and new components appear here before you commit.
                  </p>
                </div>
              </div>
            ) : (
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
                          <input type="checkbox" aria-label={`Include ${file.path} in commit`} checked={selectedPaths.includes(file.path)} disabled={committing} onChange={(e) => {
                            setSelectedPaths((previous) => e.target.checked ? [...previous, file.path] : previous.filter((path) => path !== file.path));
                          }} />
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
                            onClick={() => setViewMode('rich')}
                          >
                            Rich review
                          </button>
                          <button
                            type="button"
                            className={viewMode === 'raw-file' ? 'active' : ''}
                            onClick={() => setViewMode('raw-file')}
                          >
                            Raw diff
                          </button>
                          {review.files.length > 1 && (
                            <button
                              type="button"
                              className={viewMode === 'raw-all' ? 'active' : ''}
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
            )}

            <form className="change-commit-footer" onSubmit={(e) => void handleCommit(e)}>
              <div className="change-commit-scope">
                <FileDiff size={13} aria-hidden="true" />
                <span>
                  {`${selectedPaths.length} of ${changedCount} changed files selected. Local branch ${status.branch} (never pushes).`}
                </span>
              </div>
              <div className="change-commit-inputs">
                <input
                  type="text"
                  className="field-input commit-message-input"
                  aria-label="Commit message"
                  placeholder={
                    status.isClean
                      ? 'No uncommitted changes'
                      : 'Summarize these changes for local Git history…'
                  }
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  disabled={status.isClean || committing}
                />
                <input
                  type="text"
                  className="field-input commit-author-input"
                  aria-label="Commit author name"
                  placeholder="Author name"
                  value={authorName}
                  onChange={(e) => setAuthorName(e.target.value)}
                  disabled={status.isClean || committing}
                />
                <button
                  type="submit"
                  className="btn btn-primary commit-submit-btn"
                  disabled={status.isClean || !selectedPaths.length || !commitMessage.trim() || committing}
                >
                  {committing
                    ? 'Committing…'
                    : selectedPaths.length > 0
                      ? `Commit ${selectedPaths.length} ${selectedPaths.length === 1 ? 'file' : 'files'}`
                      : 'Commit changes'}
                </button>
              </div>
            </form>
          </>
        ) : (
          <div className="git-branches-panel">
            {!status.isClean && (
              <div className="git-dirty-guard-banner">
                Working copy has {changedCount} uncommitted{' '}
                {changedCount === 1 ? 'file' : 'files'}. Commit or revert changes before switching
                branches or pulling.
              </div>
            )}

            <div className="git-branches-toolbar">
              <div className="search-box git-branch-filter-box">
                <Search size={13} className="search-icon" aria-hidden="true" />
                <input
                  type="search"
                  className="search-input"
                  aria-label="Filter branches and pull requests"
                  placeholder="Filter branches or PRs…"
                  value={branchFilter}
                  onChange={(e) => setBranchFilter(e.target.value)}
                />
              </div>

              {hasRemote && (
                <form
                  className="git-pr-quick-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const num = Number.parseInt(prNumberInput.trim().replace(/^#/, ''), 10);
                    if (!Number.isInteger(num) || num <= 0) {
                      setError('Enter a positive pull request number.');
                      return;
                    }
                    void handleCheckoutTarget({ kind: 'pr', ref: `pr/${num}`, prNumber: num });
                  }}
                >
                  <input
                    type="text"
                    className="field-input field-code git-pr-input"
                    aria-label="Pull request number"
                    placeholder="PR #"
                    value={prNumberInput}
                    onChange={(e) => setPrNumberInput(e.target.value)}
                    disabled={!status.isClean || Boolean(syncingAction)}
                  />
                  <button
                    type="submit"
                    className="btn btn-compact"
                    disabled={!status.isClean || !prNumberInput.trim() || Boolean(syncingAction)}
                    title="Fetch and check out pull request by number"
                  >
                    <GitPullRequest size={13} aria-hidden="true" />
                    <span>Checkout PR</span>
                  </button>
                </form>
              )}
            </div>

            {refsLoading ? (
              <div className="change-review-empty">Loading branches and pull requests…</div>
            ) : (
              <div className="git-refs-scroll">
                <section className="git-ref-group">
                  <div className="git-ref-group-heading">
                    <span>Pull requests ({prRefs.length})</span>
                    {hasRemote && (
                      <span className="git-ref-group-hint">
                        Click Fetch above to refresh PR heads from remote
                      </span>
                    )}
                  </div>
                  {prRefs.length === 0 ? (
                    <div className="git-ref-empty">
                      No fetched PR branches yet. Use Fetch or enter a PR # above.
                    </div>
                  ) : (
                    <div className="git-ref-list">
                      {prRefs.map((pr) => (
                        <div
                          key={pr.ref}
                          className={`git-ref-row ${pr.checkedOut ? 'is-current' : ''}`}
                        >
                          <div className="git-ref-main">
                            <div className="git-ref-title">
                              <GitPullRequest size={13} aria-hidden="true" />
                              <strong>PR #{pr.number}</strong>
                              <span className="code-chip">{pr.sha}</span>
                              {pr.checkedOut && <span className="git-current-pill">Active</span>}
                            </div>
                            {pr.subject && <div className="git-ref-subject">{pr.subject}</div>}
                          </div>
                          {!pr.checkedOut && (
                            <button
                              type="button"
                              className="btn btn-compact"
                              disabled={!status.isClean || Boolean(syncingAction)}
                              onClick={() =>
                                void handleCheckoutTarget({
                                  kind: 'pr',
                                  ref: pr.localBranch,
                                  prNumber: pr.number
                                })
                              }
                            >
                              Switch
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="git-ref-group">
                  <div className="git-ref-group-heading">
                    <span>Local branches ({localBranches.length})</span>
                  </div>
                  {localBranches.length === 0 ? (
                    <div className="git-ref-empty">No matching local branches.</div>
                  ) : (
                    <div className="git-ref-list">
                      {localBranches.map((br) => (
                        <div
                          key={br.name}
                          className={`git-ref-row ${br.isCurrent ? 'is-current' : ''}`}
                        >
                          <div className="git-ref-main">
                            <div className="git-ref-title">
                              <GitBranch size={13} aria-hidden="true" />
                              <code>{br.name}</code>
                              <span className="code-chip">{br.sha}</span>
                              {br.isCurrent && <span className="git-current-pill">Active</span>}
                            </div>
                            {br.subject && <div className="git-ref-subject">{br.subject}</div>}
                          </div>
                          {!br.isCurrent && (
                            <button
                              type="button"
                              className="btn btn-compact"
                              disabled={!status.isClean || Boolean(syncingAction)}
                              onClick={() =>
                                void handleCheckoutTarget({ kind: 'local', ref: br.name })
                              }
                            >
                              Switch
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {remoteBranches.length > 0 && (
                  <section className="git-ref-group">
                    <div className="git-ref-group-heading">
                      <span>Remote branches ({remoteBranches.length})</span>
                    </div>
                    <div className="git-ref-list">
                      {remoteBranches.map((br) => (
                        <div key={br.name} className="git-ref-row">
                          <div className="git-ref-main">
                            <div className="git-ref-title">
                              <GitBranch size={13} aria-hidden="true" />
                              <code>{br.name}</code>
                              <span className="code-chip">{br.sha}</span>
                            </div>
                            {br.subject && <div className="git-ref-subject">{br.subject}</div>}
                          </div>
                          <button
                            type="button"
                            className="btn btn-compact"
                            disabled={!status.isClean || Boolean(syncingAction)}
                            onClick={() =>
                              void handleCheckoutTarget({ kind: 'remote', ref: br.name })
                            }
                          >
                            Checkout
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
