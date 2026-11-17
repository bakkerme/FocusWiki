import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  CheckCircle2,
  FolderGit2,
  FolderPlus,
  GitBranch,
  GitPullRequest,
  KeyRound,
  Link2,
  Loader2,
  RefreshCw,
  Trash2,
  X
} from 'lucide-react';
import type {
  CloneOptions,
  ProjectSummary,
  RemoteInspectResult,
  RepoInspectionResult
} from '../../shared/types';
import { useModalOverlayFocus } from '../utils/overlayModal';

type ImportTab = 'clone' | 'local' | 'init' | 'manage';

interface Props {
  projects: ProjectSummary[];
  activeProjectId: string;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  onImported: (project: ProjectSummary) => Promise<void>;
  onRemoved: (removedId: string) => Promise<void>;
  onOpenCredentialsSettings?: (host?: string) => void;
  onClose: () => void;
}

export function ImportRepoModal(props: Props) {
  const {
    projects,
    activeProjectId,
    restoreFocusRef,
    onImported,
    onRemoved,
    onOpenCredentialsSettings,
    onClose
  } = props;

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<ImportTab>('clone');
  const [error, setError] = useState<string | null>(null);
  const [authPromptHost, setAuthPromptHost] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Clone tab state
  const [shallow, setShallow] = useState(false);
  const [cloneUrl, setCloneUrl] = useState<string>('');
  const [cloneName, setCloneName] = useState<string>('');
  const [cloneDefaultDoc, setCloneDefaultDoc] = useState<string>('');
  const [cloneTargetKind, setCloneTargetKind] = useState<'default' | 'branch' | 'pr'>('default');
  const [cloneBranch, setCloneBranch] = useState<string>('');
  const [clonePrNumber, setClonePrNumber] = useState<string>('');
  const [authExpanded, setAuthExpanded] = useState<boolean>(false);
  const [cloneToken, setCloneToken] = useState<string>('');
  const [cloneSaveToken, setCloneSaveToken] = useState<boolean>(true);
  const [inspectingRemote, setInspectingRemote] = useState<boolean>(false);
  const [remotePreview, setRemotePreview] = useState<RemoteInspectResult | null>(null);

  // Local folder tab state
  const [localPath, setLocalPath] = useState<string>('');
  const [localName, setLocalName] = useState<string>('');
  const [localDefaultDoc, setLocalDefaultDoc] = useState<string>('');
  const [inspectingLocal, setInspectingLocal] = useState<boolean>(false);
  const [localPreview, setLocalPreview] = useState<RepoInspectionResult | null>(null);
  const [importHints, setImportHints] = useState<{
    managedReposDir: string;
    allowedImportRoots: string[];
  } | null>(null);

  // Init new repo tab state
  const [initName, setInitName] = useState<string>('');
  const [initDefaultDoc, setInitDefaultDoc] = useState<string>('README.md');

  // Manage tab confirmation state
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useModalOverlayFocus({
    active: true,
    containerRef: dialogRef,
    restoreFocusRef,
    initialFocusSelector: '.import-repo-close-btn',
    onDismiss: onClose
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/projects/import-config');
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          managedReposDir: string;
          allowedImportRoots: string[];
        };
        if (!cancelled) setImportHints(data);
      } catch {
        // optional hints
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleInspectRemote() {
    if (!cloneUrl.trim() || inspectingRemote) return;
    setError(null);
    setAuthPromptHost(null);
    setInspectingRemote(true);
    try {
      const payload: Record<string, unknown> = { url: cloneUrl.trim() };
      if (cloneToken.trim()) {
        payload.token = cloneToken.trim();
        payload.saveToken = cloneSaveToken;
      }
      const res = await fetch('/api/projects/inspect-remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const body = (await res.json()) as RemoteInspectResult & {
        error?: string;
        host?: string | null;
        message?: string;
      };
      if (!res.ok) {
        if (res.status === 401 || body.error === 'auth_required') {
          setAuthExpanded(true);
          setAuthPromptHost(body.host ?? null);
        }
        throw new Error(body.message ?? 'Could not inspect remote repository');
      }
      setRemotePreview(body);
      if (body.defaultBranch && !cloneBranch) {
        setCloneBranch(body.defaultBranch);
      }
    } catch (err) {
      setRemotePreview(null);
      setError(err instanceof Error ? err.message : 'Remote inspection failed');
    } finally {
      setInspectingRemote(false);
    }
  }

  async function handleCloneSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!cloneUrl.trim() || submitting) return;
    setError(null);
    setAuthPromptHost(null);
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> & CloneOptions = {
        mode: 'clone',
        shallow,
        url: cloneUrl.trim()
      };
      if (cloneName.trim()) payload.name = cloneName.trim();
      if (cloneDefaultDoc.trim()) payload.defaultDoc = cloneDefaultDoc.trim();
      if (cloneToken.trim()) {
        payload.token = cloneToken.trim();
        payload.saveToken = cloneSaveToken;
      }
      if (cloneTargetKind === 'branch' && cloneBranch.trim()) {
        payload.branch = cloneBranch.trim();
      } else if (cloneTargetKind === 'pr' && clonePrNumber.trim()) {
        const parsed = Number.parseInt(clonePrNumber.trim().replace(/^#/, ''), 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new Error('Pull request number must be a positive integer.');
        }
        payload.prNumber = parsed;
      }

      const res = await fetch('/api/projects/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const body = (await res.json()) as {
        project?: ProjectSummary;
        error?: string;
        host?: string | null;
        message?: string;
      };
      if (!res.ok || !body.project) {
        if (res.status === 401 || body.error === 'auth_required') {
          setAuthExpanded(true);
          setAuthPromptHost(body.host ?? null);
        }
        throw new Error(body.message ?? 'Could not clone repository');
      }
      await onImported(body.project);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Clone failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleInspectLocal() {
    if (!localPath.trim() || inspectingLocal) return;
    setError(null);
    setInspectingLocal(true);
    try {
      const res = await fetch('/api/projects/inspect-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: localPath.trim() })
      });
      const body = (await res.json()) as RepoInspectionResult & { message?: string };
      if (!res.ok) {
        throw new Error(body.message ?? 'Could not inspect directory');
      }
      setLocalPreview(body);
      if (!localName.trim()) setLocalName(body.suggestedName);
      if (!localDefaultDoc.trim()) setLocalDefaultDoc(body.suggestedDefaultDoc);
    } catch (err) {
      setLocalPreview(null);
      setError(err instanceof Error ? err.message : 'Directory inspection failed');
    } finally {
      setInspectingLocal(false);
    }
  }

  async function handleLocalSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!localPath.trim() || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/projects/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'local',
          path: localPath.trim(),
          ...(localName.trim() ? { name: localName.trim() } : {}),
          ...(localDefaultDoc.trim() ? { defaultDoc: localDefaultDoc.trim() } : {})
        })
      });
      const body = (await res.json()) as { project?: ProjectSummary; message?: string };
      if (!res.ok || !body.project) {
        throw new Error(body.message ?? 'Could not connect local directory');
      }
      await onImported(body.project);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect folder');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleInitSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!initName.trim() || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/projects/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'init',
          name: initName.trim(),
          defaultDoc: initDefaultDoc.trim() || 'README.md'
        })
      });
      const body = (await res.json()) as { project?: ProjectSummary; message?: string };
      if (!res.ok || !body.project) {
        throw new Error(body.message ?? 'Could not initialize repository');
      }
      await onImported(body.project);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Initialization failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemoveRepo(projectId: string) {
    setError(null);
    setRemovingId(projectId);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'DELETE'
      });
      const body = (await res.json()) as { removedId?: string; message?: string };
      if (!res.ok) {
        throw new Error(body.message ?? 'Could not remove repository');
      }
      setConfirmRemoveId(null);
      await onRemoved(projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed');
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal-panel import-repo-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="importRepoTitle"
        tabIndex={-1}
      >
        <div className="import-modal-header">
          <div>
            <h2 id="importRepoTitle">Repositories</h2>
            <p className="import-modal-subtitle">
              Clone a Git repository, connect a local checkout, or start a new docs repo without editing config files.
            </p>
          </div>
          <button
            type="button"
            className="icon-btn panel-close-btn import-repo-close-btn"
            onClick={onClose}
            aria-label="Close repository import"
            title="Close"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="mode-switch import-mode-tabs" role="tablist" aria-label="Repository import method">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'clone'}
            className={tab === 'clone' ? 'active' : ''}
            onClick={() => {
              setTab('clone');
              setError(null);
            }}
          >
            <FolderGit2 size={13} aria-hidden="true" />
            <span>Clone URL</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'local'}
            className={tab === 'local' ? 'active' : ''}
            onClick={() => {
              setTab('local');
              setError(null);
            }}
          >
            <Link2 size={13} aria-hidden="true" />
            <span>Local folder</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'init'}
            className={tab === 'init' ? 'active' : ''}
            onClick={() => {
              setTab('init');
              setError(null);
            }}
          >
            <FolderPlus size={13} aria-hidden="true" />
            <span>New repo</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'manage'}
            className={tab === 'manage' ? 'active' : ''}
            onClick={() => {
              setTab('manage');
              setError(null);
            }}
          >
            <span>Connected ({projects.length})</span>
          </button>
        </div>

        {error && (
          <div className="notice-banner conflict import-error-banner">
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
                <span>Manage tokens</span>
              </button>
            )}
          </div>
        )}

        {tab === 'clone' && (
          <form className="import-form" onSubmit={(e) => void handleCloneSubmit(e)}>
            <label className="import-field">
              <span className="import-field-label">Git repository URL</span>
              <div className="import-input-row">
                <input
                  type="text"
                  className="field-input field-code"
                  placeholder="https://github.com/org/docs-repo.git"
                  value={cloneUrl}
                  onChange={(e) => {
                    setCloneUrl(e.target.value);
                    setRemotePreview(null);
                  }}
                  required
                />
                <button
                  type="button"
                  className="btn btn-compact"
                  onClick={() => void handleInspectRemote()}
                  disabled={!cloneUrl.trim() || inspectingRemote || submitting}
                  title="Check remote branches and open pull requests before cloning"
                >
                  {inspectingRemote ? (
                    <Loader2 size={13} className="spin-icon" aria-hidden="true" />
                  ) : (
                    <RefreshCw size={13} aria-hidden="true" />
                  )}
                  <span>{inspectingRemote ? 'Inspecting…' : 'Inspect'}</span>
                </button>
              </div>
            </label>

            <div className="import-auth-disclosure">
              <button
                type="button"
                className="import-auth-toggle"
                aria-expanded={authExpanded}
                onClick={() => setAuthExpanded((v) => !v)}
              >
                <KeyRound size={12} aria-hidden="true" />
                <span>
                  {authExpanded
                    ? 'Hide Personal Access Token (optional)'
                    : 'Private repo? Use or save a Personal Access Token'}
                </span>
              </button>

              {authExpanded && (
                <div className="import-auth-box">
                  <label className="import-field">
                    <span className="import-field-label">
                      Personal Access Token {authPromptHost ? `for ${authPromptHost}` : '(optional)'}
                    </span>
                    <input
                      type="password"
                      className="field-input field-code"
                      placeholder="ghp_… or github_pat_… or glpat-…"
                      autoComplete="off"
                      value={cloneToken}
                      onChange={(e) => setCloneToken(e.target.value)}
                    />
                  </label>
                  <label className="import-save-token-check">
                    <input
                      type="checkbox"
                      checked={cloneSaveToken}
                      onChange={(e) => setCloneSaveToken(e.target.checked)}
                    />
                    <span>Save encrypted token for this host in Settings</span>
                  </label>
                </div>
              )}
            </div>

            {remotePreview && (
              <div className="import-inspect-card">
                <div className="import-inspect-summary">
                  <CheckCircle2 size={14} aria-hidden="true" />
                  <span>
                    Found {remotePreview.branches.length}{' '}
                    {remotePreview.branches.length === 1 ? 'branch' : 'branches'}
                    {remotePreview.pullRequests.length > 0
                      ? ` and ${remotePreview.pullRequests.length} pull ${
                          remotePreview.pullRequests.length === 1 ? 'request' : 'requests'
                        }`
                      : ''}
                    {remotePreview.defaultBranch ? ` · default: ${remotePreview.defaultBranch}` : ''}
                  </span>
                </div>
              </div>
            )}

            <div className="import-target-picker">
              <span className="import-field-label">Start on</span>
              <div className="import-radio-row">
                <label className="import-radio-chip">
                  <input
                    type="radio"
                    name="cloneTarget"
                    checked={cloneTargetKind === 'default'}
                    onChange={() => setCloneTargetKind('default')}
                  />
                  <span>Default branch</span>
                </label>
                <label className="import-radio-chip">
                  <input
                    type="radio"
                    name="cloneTarget"
                    checked={cloneTargetKind === 'branch'}
                    onChange={() => setCloneTargetKind('branch')}
                  />
                  <GitBranch size={12} aria-hidden="true" />
                  <span>Branch</span>
                </label>
                <label className="import-radio-chip">
                  <input
                    type="radio"
                    name="cloneTarget"
                    checked={cloneTargetKind === 'pr'}
                    onChange={() => setCloneTargetKind('pr')}
                  />
                  <GitPullRequest size={12} aria-hidden="true" />
                  <span>Pull request</span>
                </label>
              </div>

              {cloneTargetKind === 'branch' && (
                <div className="import-subfield">
                  {remotePreview && remotePreview.branches.length > 0 ? (
                    <select
                      className="field-input field-code"
                      aria-label="Branch to clone"
                      value={cloneBranch}
                      onChange={(e) => setCloneBranch(e.target.value)}
                    >
                      {remotePreview.branches.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      className="field-input field-code"
                      placeholder="docs/feature-branch"
                      aria-label="Branch name"
                      value={cloneBranch}
                      onChange={(e) => setCloneBranch(e.target.value)}
                    />
                  )}
                </div>
              )}

              {cloneTargetKind === 'pr' && (
                <div className="import-subfield">
                  {remotePreview && remotePreview.pullRequests.length > 0 ? (
                    <select
                      className="field-input field-code"
                      aria-label="Pull request to check out"
                      value={clonePrNumber}
                      onChange={(e) => setClonePrNumber(e.target.value)}
                    >
                      <option value="">Select PR…</option>
                      {remotePreview.pullRequests.map((pr) => (
                        <option key={pr.number} value={String(pr.number)}>
                          PR #{pr.number} ({pr.sha})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      className="field-input field-code"
                      placeholder="42"
                      aria-label="Pull request number"
                      value={clonePrNumber}
                      onChange={(e) => setClonePrNumber(e.target.value)}
                    />
                  )}
                </div>
              )}
            </div>

            <label className="import-save-token-check">
              <input type="checkbox" checked={shallow} onChange={(e) => setShallow(e.target.checked)} disabled={submitting} />
              <span>Shallow clone (latest commit only — faster for large repos)</span>
            </label>

            <div className="import-two-col">
              <label className="import-field">
                <span className="import-field-label">Display name (optional)</span>
                <input
                  type="text"
                  className="field-input"
                  placeholder="Auto-derived from repo name"
                  value={cloneName}
                  onChange={(e) => setCloneName(e.target.value)}
                />
              </label>
              <label className="import-field">
                <span className="import-field-label">Default page (optional)</span>
                <input
                  type="text"
                  className="field-input field-code"
                  placeholder="Auto-detect README / docs"
                  value={cloneDefaultDoc}
                  onChange={(e) => setCloneDefaultDoc(e.target.value)}
                />
              </label>
            </div>

            {importHints && (
              <div className="import-hint-text">
                Clones into <code>{importHints.managedReposDir}</code> and registers immediately.
              </div>
            )}

            <div className="import-modal-footer">
              <button type="button" className="btn btn-compact" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-compact btn-primary"
                disabled={!cloneUrl.trim() || submitting}
              >
                {submitting ? 'Cloning…' : 'Clone & import'}
              </button>
            </div>
          </form>
        )}

        {tab === 'local' && (
          <form className="import-form" onSubmit={(e) => void handleLocalSubmit(e)}>
            <label className="import-field">
              <span className="import-field-label">Existing directory path</span>
              <div className="import-input-row">
                <input
                  type="text"
                  className="field-input field-code"
                  placeholder="/workspace/my-docs-repo"
                  value={localPath}
                  onChange={(e) => {
                    setLocalPath(e.target.value);
                    setLocalPreview(null);
                  }}
                  required
                />
                <button
                  type="button"
                  className="btn btn-compact"
                  onClick={() => void handleInspectLocal()}
                  disabled={!localPath.trim() || inspectingLocal || submitting}
                >
                  {inspectingLocal ? 'Checking…' : 'Inspect'}
                </button>
              </div>
            </label>

            {importHints && (
              <div className="import-hint-text">
                Allowed roots: <code>{importHints.allowedImportRoots.join(', ')}</code>
              </div>
            )}

            {localPreview && (
              <div className="import-inspect-card">
                <div className="import-inspect-summary">
                  <CheckCircle2 size={14} aria-hidden="true" />
                  <span>
                    {localPreview.docCount} Markdown {localPreview.docCount === 1 ? 'page' : 'pages'}
                    {localPreview.embedCount > 0
                      ? ` · ${localPreview.embedCount} ${localPreview.embedCount === 1 ? 'embed' : 'embeds'}`
                      : ''}
                    {localPreview.isGitRepo ? ` · Git branch ${localPreview.branch}` : ' · plain folder (non-Git)'}
                  </span>
                </div>
                {localPreview.alreadyRegisteredId && (
                  <div className="import-inspect-warn">
                    Already connected as <code>{localPreview.alreadyRegisteredId}</code>.
                  </div>
                )}
              </div>
            )}

            <div className="import-two-col">
              <label className="import-field">
                <span className="import-field-label">Display name</span>
                <input
                  type="text"
                  className="field-input"
                  placeholder="My Project Docs"
                  value={localName}
                  onChange={(e) => setLocalName(e.target.value)}
                />
              </label>
              <label className="import-field">
                <span className="import-field-label">Default page</span>
                <input
                  type="text"
                  className="field-input field-code"
                  placeholder="README.md"
                  value={localDefaultDoc}
                  onChange={(e) => setLocalDefaultDoc(e.target.value)}
                />
              </label>
            </div>

            <div className="import-modal-footer">
              <button type="button" className="btn btn-compact" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-compact btn-primary"
                disabled={
                  !localPath.trim() || submitting || Boolean(localPreview?.alreadyRegisteredId)
                }
              >
                {submitting ? 'Connecting…' : 'Connect repository'}
              </button>
            </div>
          </form>
        )}

        {tab === 'init' && (
          <form className="import-form" onSubmit={(e) => void handleInitSubmit(e)}>
            <label className="import-field">
              <span className="import-field-label">Repository name</span>
              <input
                type="text"
                className="field-input"
                placeholder="Architecture Notes"
                value={initName}
                onChange={(e) => setInitName(e.target.value)}
                required
              />
            </label>

            <label className="import-field">
              <span className="import-field-label">Initial page path</span>
              <input
                type="text"
                className="field-input field-code"
                placeholder="README.md"
                value={initDefaultDoc}
                onChange={(e) => setInitDefaultDoc(e.target.value)}
              />
            </label>

            {importHints && (
              <div className="import-hint-text">
                Creates a new Git repository on branch <code>main</code> inside{' '}
                <code>{importHints.managedReposDir}</code>.
              </div>
            )}

            <div className="import-modal-footer">
              <button type="button" className="btn btn-compact" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-compact btn-primary"
                disabled={!initName.trim() || submitting}
              >
                {submitting ? 'Creating…' : 'Create repository'}
              </button>
            </div>
          </form>
        )}

        {tab === 'manage' && (
          <div className="import-manage-list">
            <p className="import-hint-text">
              Removing a repository disconnects it from Focus without deleting files on disk.
            </p>
            {projects.length === 0 ? (
              <div className="import-empty-note">No repositories connected yet.</div>
            ) : (
              projects.map((proj) => (
                <div
                  key={proj.id}
                  className={`import-manage-item ${proj.id === activeProjectId ? 'is-active' : ''}`}
                >
                  <div className="import-manage-meta">
                    <div className="import-manage-title">
                      <strong>{proj.name}</strong>
                      <span className="code-chip">{proj.git.branch}</span>
                    </div>
                    <div className="import-manage-path" title={proj.rootPath}>
                      {proj.rootPath}
                    </div>
                  </div>
                  <div className="import-manage-actions">
                    {confirmRemoveId === proj.id ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-compact btn-danger"
                          disabled={removingId === proj.id}
                          onClick={() => void handleRemoveRepo(proj.id)}
                        >
                          {removingId === proj.id ? 'Removing…' : 'Confirm'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-compact"
                          onClick={() => setConfirmRemoveId(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-compact"
                        onClick={() => setConfirmRemoveId(proj.id)}
                        title={`Remove ${proj.name} from Focus (keeps files on disk)`}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                        <span>Remove</span>
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
