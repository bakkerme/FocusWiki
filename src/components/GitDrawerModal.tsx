import { useEffect, useState } from 'react';
import type { GitRepoStatus, ProjectSummary } from '../../shared/types';

interface Props {
  project: ProjectSummary;
  onClose: () => void;
  onCommitted: () => Promise<void>;
}

export function GitDrawerModal({ project, onClose, onCommitted }: Props) {
  const [loading, setLoading] = useState<boolean>(true);
  const [status, setStatus] = useState<GitRepoStatus>(project.git);
  const [diffText, setDiffText] = useState<string>('');
  const [commitMessage, setCommitMessage] = useState<string>('');
  const [authorName, setAuthorName] = useState<string>('Workspace Author');
  const [committing, setCommitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [commitResult, setCommitResult] = useState<string | null>(null);

  async function loadDiff() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/git/diff`);
      if (!res.ok) throw new Error(`Failed to read Git diff (${res.status})`);
      const data = (await res.json()) as { status: GitRepoStatus; diff: string };
      setStatus(data.status);
      setDiffText(data.diff);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to inspect Git working tree');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDiff();
  }, [project.id]);

  async function handleCommit(e: React.FormEvent) {
    e.preventDefault();
    if (!commitMessage.trim()) return;
    setCommitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/git/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: commitMessage.trim(),
          authorName: authorName.trim() || 'Workspace Author'
        })
      });
      const payload = (await res.json()) as { sha?: string; subject?: string; message?: string };
      if (!res.ok) {
        throw new Error(payload.message ?? 'Git commit failed');
      }
      setCommitMessage('');
      setCommitResult(`Committed ${payload.sha}: ${payload.subject} (local only; never pushed).`);
      await loadDiff();
      await onCommitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Git commit failed');
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Git working copy status and diff">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 17 }}>Working copy & local Git commit</h2>
            <div style={{ fontSize: 12, color: 'var(--ink-secondary)', marginTop: 3 }}>
              Checkout: <span className="code-chip">{project.rootPath}</span> · Branch:{' '}
              <span className="code-chip">{status.branch}</span> · HEAD:{' '}
              <span className="code-chip">{status.headSha || 'none'}</span>
            </div>
          </div>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        {commitResult && (
          <div className="notice-banner" style={{ borderRadius: 5, border: '1px solid #b7dad6' }}>
            <span>{commitResult}</span>
          </div>
        )}

        {error && (
          <div className="notice-banner conflict" style={{ borderRadius: 5 }}>
            <span>{error}</span>
          </div>
        )}

        <div>
          <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>
            Uncommitted files ({status.changedFiles.length})
          </div>
          {status.changedFiles.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--ink-secondary)' }}>
              Working tree is clean. Autosaves and external edits appear here before any commit.
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {status.changedFiles.map((f) => (
                <span key={f.path} className="code-chip">
                  {f.status}: {f.path}
                </span>
              ))}
            </div>
          )}
        </div>

        <div>
          <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>
            Unified diff against HEAD
          </div>
          {loading ? (
            <div style={{ fontSize: 12.5, color: 'var(--ink-secondary)' }}>Reading Git diff…</div>
          ) : (
            <pre className="diff-viewer">{diffText || 'No uncommitted diff lines.'}</pre>
          )}
        </div>

        <form onSubmit={(e) => void handleCommit(e)} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>
            Deliberate local commit (writes to local branch {status.branch}; never pushes)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
            <input
              type="text"
              placeholder="Describe document, comment, or embed changes…"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              disabled={status.isClean || committing}
              style={{
                padding: '7px 10px',
                border: '1px solid var(--line-border)',
                borderRadius: 5
              }}
            />
            <input
              type="text"
              placeholder="Author name"
              value={authorName}
              onChange={(e) => setAuthorName(e.target.value)}
              disabled={status.isClean || committing}
              style={{
                padding: '7px 10px',
                border: '1px solid var(--line-border)',
                borderRadius: 5
              }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11.5, color: 'var(--ink-secondary)' }}>
              Appends required OpenBot Co-authored-by trailer automatically.
            </span>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={status.isClean || !commitMessage.trim() || committing}
            >
              {committing ? 'Committing…' : 'Commit changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
