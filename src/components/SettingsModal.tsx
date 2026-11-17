import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject
} from 'react';
import {
  BookOpen,
  CheckCircle2,
  Eye,
  EyeOff,
  FolderGit2,
  GitBranch,
  Info,
  KeyRound,
  Loader2,
  Palette,
  PenLine,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react';
import type {
  GitCredentialSummary,
  ProjectSummary,
  ServerEnvironmentInfo
} from '../../shared/types';
import {
  DEFAULT_READING_PREFERENCES,
  PAGE_WIDTH_OPTIONS,
  TEXT_SIZE_OPTIONS,
  getPageWidthSpec,
  getTextSizeSpec,
  type PageWidthPreset,
  type ReadingPreferences,
  type TextSizePreset
} from '../utils/readingPreferences';
import {
  DEFAULT_WORKSPACE_SETTINGS,
  THEME_MODE_OPTIONS,
  type GitDrawerDefaultTab,
  type ThemeMode,
  type WorkspaceSettings
} from '../utils/workspaceSettings';
import { useModalOverlayFocus } from '../utils/overlayModal';

export type SettingsSection =
  | 'reading'
  | 'appearance'
  | 'authoring'
  | 'repositories'
  | 'git-defaults'
  | 'credentials'
  | 'environment'
  | 'about';

interface NavItemSpec {
  id: SettingsSection;
  label: string;
  group: 'primary' | 'repos' | 'connections' | 'system';
  keywords: string;
  icon: typeof BookOpen;
}

const NAV_ITEMS: readonly NavItemSpec[] = [
  {
    id: 'reading',
    label: 'Reading',
    group: 'primary',
    keywords: 'text size font width narrow standard wide typography preset preview',
    icon: BookOpen
  },
  {
    id: 'appearance',
    label: 'Appearance',
    group: 'primary',
    keywords: 'theme dark light system color mode appearance',
    icon: Palette
  },
  {
    id: 'authoring',
    label: 'Authoring',
    group: 'primary',
    keywords: 'reviewer name commit author email identity markdown',
    icon: PenLine
  },
  {
    id: 'repositories',
    label: 'Repositories',
    group: 'repos',
    keywords: 'projects repos clone local folder manage import remove delete rename default page',
    icon: FolderGit2
  },
  {
    id: 'git-defaults',
    label: 'Git defaults',
    group: 'repos',
    keywords: 'branch pr pull request fetch commit push policy clean tree auto-fetch tab',
    icon: GitBranch
  },
  {
    id: 'credentials',
    label: 'Git credentials',
    group: 'connections',
    keywords: 'pat personal access token github gitlab gitea https auth password secret rotate',
    icon: KeyRound
  },
  {
    id: 'environment',
    label: 'Environment',
    group: 'system',
    keywords: 'paths config credentials encryption ssh server docker storage',
    icon: Server
  },
  {
    id: 'about',
    label: 'About',
    group: 'system',
    keywords: 'version security sandbox privacy cairn focus',
    icon: Info
  }
];

const GROUP_LABELS: Record<'primary' | 'repos' | 'connections' | 'system', string | null> = {
  primary: null,
  repos: 'Repos & Git',
  connections: 'Connections',
  system: 'System'
};

interface Props {
  initialSection?: SettingsSection;
  initialCredentialHost?: string;
  readingPreferences: ReadingPreferences;
  workspaceSettings: WorkspaceSettings;
  projects: ProjectSummary[];
  activeProjectId: string;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  onChangeTextSize: (next: TextSizePreset) => void;
  onChangePageWidth: (next: PageWidthPreset) => void;
  onResetReadingDefaults: () => void;
  onUpdateWorkspaceSettings: (updater: (prev: WorkspaceSettings) => WorkspaceSettings) => void;
  onResetWorkspaceDefaults: () => void;
  onSelectProject: (projectId: string) => void | Promise<void>;
  onRepoUpdated: (project: ProjectSummary) => Promise<void>;
  onRepoRemoved: (projectId: string) => Promise<void>;
  onOpenImportRepoModal: () => void;
  onClose: () => void;
}

export function SettingsModal(props: Props) {
  const {
    initialSection = 'reading',
    initialCredentialHost = '',
    readingPreferences,
    workspaceSettings,
    projects,
    activeProjectId,
    restoreFocusRef,
    onChangeTextSize,
    onChangePageWidth,
    onResetReadingDefaults,
    onUpdateWorkspaceSettings,
    onResetWorkspaceDefaults,
    onSelectProject,
    onRepoUpdated,
    onRepoRemoved,
    onOpenImportRepoModal,
    onClose
  } = props;

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const credTokenInputRef = useRef<HTMLInputElement | null>(null);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [navQuery, setNavQuery] = useState<string>('');

  // Repositories management state
  const [editingRepoId, setEditingRepoId] = useState<string | null>(null);
  const [editRepoName, setEditRepoName] = useState<string>('');
  const [editRepoDefaultDoc, setEditRepoDefaultDoc] = useState<string>('');
  const [savingRepoId, setSavingRepoId] = useState<string | null>(null);
  const [confirmRemoveRepoId, setConfirmRemoveRepoId] = useState<string | null>(null);
  const [removingRepoId, setRemovingRepoId] = useState<string | null>(null);
  const [repoFeedback, setRepoFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(
    null
  );

  // Credentials state
  const [credentials, setCredentials] = useState<GitCredentialSummary[]>([]);
  const [encryptionMode, setEncryptionMode] = useState<'env-key' | 'file-key' | 'memory-only'>('file-key');
  const [credsLoading, setCredsLoading] = useState<boolean>(false);
  const [credHost, setCredHost] = useState<string>(initialCredentialHost || 'github.com');
  const [credUsername, setCredUsername] = useState<string>('');
  const [credToken, setCredToken] = useState<string>('');
  const [showCredToken, setShowCredToken] = useState<boolean>(false);
  const [credSaving, setCredSaving] = useState<boolean>(false);
  const [credFeedback, setCredFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(
    null
  );
  const [removingCredId, setRemovingCredId] = useState<string | null>(null);
  const [testingCredId, setTestingCredId] = useState<string | null>(null);
  const [testUrl, setTestUrl] = useState<string>('');
  const [testPending, setTestPending] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Environment info state
  const [envInfo, setEnvInfo] = useState<ServerEnvironmentInfo | null>(null);
  const [envLoading, setEnvLoading] = useState<boolean>(false);

  useModalOverlayFocus({
    active: true,
    containerRef: dialogRef,
    restoreFocusRef,
    initialFocusSelector: '.reading-settings-close-btn',
    onDismiss: onClose
  });

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    if (initialCredentialHost) {
      setCredHost(initialCredentialHost);
    }
  }, [initialCredentialHost]);

  // '/' shortcut inside modal focuses left-rail Search input (unless typing in a field)
  useEffect(() => {
    const handleSlash = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== '/' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const target = ev.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (!dialogRef.current?.contains(target ?? document.activeElement)) return;
      ev.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener('keydown', handleSlash);
    return () => window.removeEventListener('keydown', handleSlash);
  }, []);

  async function refreshCredentials() {
    setCredsLoading(true);
    try {
      const res = await fetch('/api/settings/credentials');
      if (!res.ok) return;
      const body = (await res.json()) as {
        credentials: GitCredentialSummary[];
        encryptionMode: 'env-key' | 'file-key' | 'memory-only';
      };
      setCredentials(body.credentials);
      setEncryptionMode(body.encryptionMode);
    } finally {
      setCredsLoading(false);
    }
  }

  async function refreshEnvironment() {
    setEnvLoading(true);
    try {
      const res = await fetch('/api/settings/environment');
      if (!res.ok) return;
      const body = (await res.json()) as ServerEnvironmentInfo;
      setEnvInfo(body);
    } finally {
      setEnvLoading(false);
    }
  }

  useEffect(() => {
    if (section === 'credentials' || section === 'environment') {
      void refreshCredentials();
      void refreshEnvironment();
    }
  }, [section]);

  const filteredNavItems = useMemo(() => {
    const q = navQuery.trim().toLowerCase();
    if (!q) return NAV_ITEMS;
    return NAV_ITEMS.filter(
      (item) =>
        item.label.toLowerCase().includes(q) || item.keywords.toLowerCase().includes(q)
    );
  }, [navQuery]);

  // If filter hides the current section, select the first matching section automatically
  useEffect(() => {
    if (filteredNavItems.length > 0 && !filteredNavItems.some((i) => i.id === section)) {
      setSection(filteredNavItems[0].id);
    }
  }, [filteredNavItems, section]);

  const activeNav = NAV_ITEMS.find((i) => i.id === section) ?? NAV_ITEMS[0];

  const isReadingDefault =
    readingPreferences.textSize === DEFAULT_READING_PREFERENCES.textSize &&
    readingPreferences.pageWidth === DEFAULT_READING_PREFERENCES.pageWidth;
  const isAppearanceDefault =
    workspaceSettings.themeMode === DEFAULT_WORKSPACE_SETTINGS.themeMode;
  const isAuthoringDefault =
    workspaceSettings.reviewerName === DEFAULT_WORKSPACE_SETTINGS.reviewerName &&
    workspaceSettings.commitAuthorName === DEFAULT_WORKSPACE_SETTINGS.commitAuthorName &&
    workspaceSettings.commitAuthorEmail === DEFAULT_WORKSPACE_SETTINGS.commitAuthorEmail;
  const isGitDefaultsDefault =
    workspaceSettings.defaultGitTab === DEFAULT_WORKSPACE_SETTINGS.defaultGitTab &&
    workspaceSettings.autoFetchOnGitOpen === DEFAULT_WORKSPACE_SETTINGS.autoFetchOnGitOpen &&
    workspaceSettings.includePrRefsOnFetch === DEFAULT_WORKSPACE_SETTINGS.includePrRefsOnFetch;

  const restoreDisabled =
    section === 'reading'
      ? isReadingDefault
      : section === 'appearance'
        ? isAppearanceDefault
        : section === 'authoring'
          ? isAuthoringDefault
          : section === 'git-defaults'
            ? isGitDefaultsDefault
            : true;

  function handleRestoreDefaults() {
    if (section === 'reading') {
      onResetReadingDefaults();
    } else if (section === 'appearance') {
      onUpdateWorkspaceSettings((prev) => ({
        ...prev,
        themeMode: DEFAULT_WORKSPACE_SETTINGS.themeMode
      }));
    } else if (section === 'authoring') {
      onUpdateWorkspaceSettings((prev) => ({
        ...prev,
        reviewerName: DEFAULT_WORKSPACE_SETTINGS.reviewerName,
        commitAuthorName: DEFAULT_WORKSPACE_SETTINGS.commitAuthorName,
        commitAuthorEmail: DEFAULT_WORKSPACE_SETTINGS.commitAuthorEmail
      }));
    } else if (section === 'git-defaults') {
      onUpdateWorkspaceSettings((prev) => ({
        ...prev,
        defaultGitTab: DEFAULT_WORKSPACE_SETTINGS.defaultGitTab,
        autoFetchOnGitOpen: DEFAULT_WORKSPACE_SETTINGS.autoFetchOnGitOpen,
        includePrRefsOnFetch: DEFAULT_WORKSPACE_SETTINGS.includePrRefsOnFetch
      }));
    } else {
      onResetReadingDefaults();
      onResetWorkspaceDefaults();
    }
  }

  function handlePresetKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const buttons = Array.from(
      event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    );
    const current = buttons.indexOf(event.currentTarget);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (current + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + buttons.length) %
            buttons.length;
    buttons[next].focus();
    buttons[next].click();
  }

  async function handleSaveCredential(e: React.FormEvent) {
    e.preventDefault();
    if (!credHost.trim() || !credToken.trim() || credSaving) return;
    setCredSaving(true);
    setCredFeedback(null);
    try {
      const res = await fetch('/api/settings/credentials', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: credHost.trim(),
          ...(credUsername.trim() ? { username: credUsername.trim() } : {}),
          token: credToken
        })
      });
      const body = (await res.json()) as {
        credential?: GitCredentialSummary;
        credentials?: GitCredentialSummary[];
        message?: string;
      };
      if (!res.ok || !body.credential) {
        throw new Error(body.message ?? 'Could not save token');
      }
      if (body.credentials) setCredentials(body.credentials);
      setCredToken('');
      setCredUsername('');
      setShowCredToken(false);
      setCredFeedback({
        kind: 'ok',
        text: `Saved encrypted HTTPS token for ${body.credential.host} (${body.credential.maskedHint}).`
      });
    } catch (err) {
      setCredFeedback({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to save credential'
      });
    } finally {
      setCredSaving(false);
    }
  }

  async function handleRemoveCredential(id: string) {
    setRemovingCredId(id);
    setCredFeedback(null);
    try {
      const res = await fetch(`/api/settings/credentials/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      });
      const body = (await res.json()) as {
        credentials?: GitCredentialSummary[];
        message?: string;
      };
      if (!res.ok) {
        throw new Error(body.message ?? 'Could not remove token');
      }
      if (body.credentials) setCredentials(body.credentials);
      if (testingCredId === id) {
        setTestingCredId(null);
        setTestResult(null);
      }
    } catch (err) {
      setCredFeedback({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to remove credential'
      });
    } finally {
      setRemovingCredId(null);
    }
  }

  async function handleTestCredentialUrl(e: React.FormEvent) {
    e.preventDefault();
    if (!testUrl.trim() || testPending) return;
    setTestPending(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/settings/credentials/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: testUrl.trim() })
      });
      const body = (await res.json()) as {
        ok?: boolean;
        defaultBranch?: string | null;
        branchCount?: number;
        prCount?: number;
        message?: string;
      };
      if (!res.ok || !body.ok) {
        throw new Error(body.message ?? 'Connection check failed');
      }
      setTestResult({
        kind: 'ok',
        text: `Connected cleanly · ${body.branchCount ?? 0} branches${
          body.prCount ? `, ${body.prCount} PRs` : ''
        }${body.defaultBranch ? ` (default: ${body.defaultBranch})` : ''}.`
      });
    } catch (err) {
      setTestResult({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Connection failed'
      });
    } finally {
      setTestPending(false);
    }
  }

  function startEditingRepo(proj: ProjectSummary) {
    setConfirmRemoveRepoId(null);
    setRepoFeedback(null);
    setEditingRepoId(proj.id);
    setEditRepoName(proj.name);
    setEditRepoDefaultDoc(proj.defaultDoc);
  }

  async function handleSaveRepoEdit(e: React.FormEvent, projectId: string) {
    e.preventDefault();
    if (!editRepoName.trim() || savingRepoId) return;
    setSavingRepoId(projectId);
    setRepoFeedback(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editRepoName.trim(),
          defaultDoc: editRepoDefaultDoc.trim() || 'README.md'
        })
      });
      const body = (await res.json()) as { project?: ProjectSummary; message?: string };
      if (!res.ok || !body.project) {
        throw new Error(body.message ?? 'Could not update repository');
      }
      await onRepoUpdated(body.project);
      setEditingRepoId(null);
      setRepoFeedback({
        kind: 'ok',
        text: `Updated "${body.project.name}" (default page: ${body.project.defaultDoc}).`
      });
    } catch (err) {
      setRepoFeedback({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Update failed'
      });
    } finally {
      setSavingRepoId(null);
    }
  }

  async function handleRemoveRepo(proj: ProjectSummary) {
    if (removingRepoId) return;
    setRemovingRepoId(proj.id);
    setRepoFeedback(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(proj.id)}`, {
        method: 'DELETE'
      });
      const body = (await res.json()) as { removedId?: string; message?: string };
      if (!res.ok) {
        throw new Error(body.message ?? 'Could not remove repository');
      }
      setConfirmRemoveRepoId(null);
      if (editingRepoId === proj.id) {
        setEditingRepoId(null);
      }
      await onRepoRemoved(proj.id);
      setRepoFeedback({
        kind: 'ok',
        text: `Removed "${proj.name}" from Cairn (files on disk were not deleted).`
      });
    } catch (err) {
      setRepoFeedback({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Remove failed'
      });
    } finally {
      setRemovingRepoId(null);
    }
  }

  const activeTextSpec = getTextSizeSpec(readingPreferences.textSize);
  const activeWidthSpec = getPageWidthSpec(readingPreferences.pageWidth);

  const groupedNav = useMemo(() => {
    const groups: Array<{
      key: 'primary' | 'repos' | 'connections' | 'system';
      label: string | null;
      items: NavItemSpec[];
    }> = [
      { key: 'primary', label: GROUP_LABELS.primary, items: [] },
      { key: 'repos', label: GROUP_LABELS.repos, items: [] },
      { key: 'connections', label: GROUP_LABELS.connections, items: [] },
      { key: 'system', label: GROUP_LABELS.system, items: [] }
    ];
    for (const item of filteredNavItems) {
      groups.find((g) => g.key === item.group)?.items.push(item);
    }
    return groups.filter((g) => g.items.length > 0);
  }, [filteredNavItems]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal-panel reading-settings-modal settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settingsModalTitle"
        tabIndex={-1}
      >
        <aside className="settings-sidebar" aria-label="Settings sections">
          <div className="settings-search-wrap">
            <div className="settings-search-box">
              <Search size={13} className="settings-search-icon" aria-hidden="true" />
              <input
                ref={searchInputRef}
                type="search"
                className="settings-search-input"
                placeholder="Search"
                aria-label="Search settings"
                value={navQuery}
                onChange={(e) => setNavQuery(e.target.value)}
              />
              {!navQuery && (
                <kbd className="settings-search-kbd" aria-hidden="true">
                  /
                </kbd>
              )}
            </div>
          </div>

          <nav className="settings-nav-scroll">
            {groupedNav.length === 0 ? (
              <div className="settings-nav-empty">No matching settings.</div>
            ) : (
              groupedNav.map((group) => (
                <div key={group.key} className="settings-nav-group">
                  {group.label && <div className="settings-nav-group-label">{group.label}</div>}
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const active = section === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-settings-section={item.id}
                        className={`settings-nav-item ${active ? 'is-active' : ''}`}
                        aria-current={active ? 'page' : undefined}
                        onClick={() => setSection(item.id)}
                      >
                        <Icon size={14} className="settings-nav-icon" aria-hidden="true" />
                        <span>{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </nav>

          <div className="settings-sidebar-footer">
            <span className="settings-sidebar-meta">
              {projects.length} {projects.length === 1 ? 'repo' : 'repos'} connected
            </span>
          </div>
        </aside>

        <section className="settings-main">
          <header className="settings-main-header">
            <div className="settings-breadcrumb" id="settingsModalTitle">
              <span className="settings-breadcrumb-root">Settings</span>
              <span className="settings-breadcrumb-sep" aria-hidden="true">
                /
              </span>
              <span className="settings-breadcrumb-current">{activeNav.label}</span>
            </div>

            <div className="settings-header-actions">
              {(section === 'reading' ||
                section === 'appearance' ||
                section === 'authoring' ||
                section === 'git-defaults') && (
                <button
                  type="button"
                  className="btn btn-compact btn-quiet reading-reset-btn"
                  onClick={handleRestoreDefaults}
                  disabled={restoreDisabled}
                  title={`Restore default ${activeNav.label.toLowerCase()} settings`}
                >
                  <RotateCcw size={13} aria-hidden="true" />
                  <span>Restore defaults</span>
                </button>
              )}
              <button
                type="button"
                className="icon-btn panel-close-btn reading-settings-close-btn"
                onClick={onClose}
                aria-label="Close settings"
                title="Close settings"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          </header>

          <div className="settings-main-scroll">
            {section === 'reading' && (
              <div className="settings-section-stack">
                <div className="settings-group-block">
                  <h3 className="settings-group-title">Typography &amp; Measure</h3>
                  <div className="settings-card-group">
                    <div className="settings-card-row is-stacked-control">
                      <div className="settings-row-copy">
                        <div className="settings-row-title">Text size</div>
                        <div className="settings-row-desc">
                          Scales rendered documentation prose in this browser without altering Markdown files or toolbars.
                        </div>
                      </div>
                      <div className="reading-preset-grid" role="radiogroup" aria-label="Text size">
                        {TEXT_SIZE_OPTIONS.map((opt) => {
                          const selected = readingPreferences.textSize === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              tabIndex={selected ? 0 : -1}
                              onKeyDown={handlePresetKey}
                              data-pref-group="textSize"
                              data-pref-value={opt.id}
                              className={`reading-preset-btn ${selected ? 'is-selected' : ''}`}
                              onClick={() => onChangeTextSize(opt.id)}
                            >
                              <span className="reading-preset-label">{opt.label}</span>
                              <span className="reading-preset-detail">{opt.detail}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="settings-card-row is-stacked-control">
                      <div className="settings-row-copy">
                        <div className="settings-row-title">Page width</div>
                        <div className="settings-row-desc">
                          Maximum reading column measure when centered inside the main stage.
                        </div>
                      </div>
                      <div className="reading-preset-grid" role="radiogroup" aria-label="Page width">
                        {PAGE_WIDTH_OPTIONS.map((opt) => {
                          const selected = readingPreferences.pageWidth === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              tabIndex={selected ? 0 : -1}
                              onKeyDown={handlePresetKey}
                              data-pref-group="pageWidth"
                              data-pref-value={opt.id}
                              className={`reading-preset-btn ${selected ? 'is-selected' : ''}`}
                              onClick={() => onChangePageWidth(opt.id)}
                            >
                              <span className="reading-preset-label">{opt.label}</span>
                              <span className="reading-preset-detail">{opt.detail}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="settings-group-block reading-live-sample-group">
                  <h3 className="settings-group-title">Preview</h3>
                  <div className="reading-live-sample" aria-hidden="true">
                    <div className="reading-sample-heading">
                      Preview · {activeTextSpec.label} ({activeTextSpec.detail}) ·{' '}
                      {activeWidthSpec.label} ({activeWidthSpec.detail})
                    </div>
                    <p
                      className="reading-sample-copy"
                      style={{
                        fontSize: activeTextSpec.cssFontSize,
                        lineHeight: activeTextSpec.cssLineHeight
                      }}
                    >
                      Clear, scannable documentation scales comfortably without changing toolbars,
                      sidebars, or Markdown source alignment.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {section === 'appearance' && (
              <div className="settings-section-stack">
                <div className="settings-group-block">
                  <h3 className="settings-group-title">Theme</h3>
                  <div className="settings-card-group">
                    <div className="settings-card-row">
                      <div className="settings-row-copy">
                        <div className="settings-row-title">Color mode</div>
                        <div className="settings-row-desc">
                          Match your operating system preference or lock Focus to light or dark surfaces.
                        </div>
                      </div>
                      <div className="mode-switch settings-theme-switch" role="radiogroup" aria-label="Theme mode">
                        {THEME_MODE_OPTIONS.map((opt) => {
                          const selected = workspaceSettings.themeMode === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              className={selected ? 'active' : ''}
                              onClick={() =>
                                onUpdateWorkspaceSettings((prev) => ({
                                  ...prev,
                                  themeMode: opt.id as ThemeMode
                                }))
                              }
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {section === 'authoring' && (
              <div className="settings-section-stack">
                <div className="settings-group-block">
                  <h3 className="settings-group-title">Identity</h3>
                  <div className="settings-card-group">
                    <div className="settings-card-row">
                      <div className="settings-row-copy">
                        <label htmlFor="settingsReviewerName" className="settings-row-title">
                          Reviewer name
                        </label>
                        <div className="settings-row-desc">
                          Attribution used when creating inline comment threads, replies, and resolve events.
                        </div>
                      </div>
                      <input
                        id="settingsReviewerName"
                        type="text"
                        className="field-input settings-inline-input"
                        value={workspaceSettings.reviewerName}
                        placeholder="Reviewer"
                        onChange={(e) =>
                          onUpdateWorkspaceSettings((prev) => ({
                            ...prev,
                            reviewerName: e.target.value
                          }))
                        }
                      />
                    </div>

                    <div className="settings-card-row">
                      <div className="settings-row-copy">
                        <label htmlFor="settingsGitName" className="settings-row-title">
                          Git commit author name
                        </label>
                        <div className="settings-row-desc">
                          Pre-filled when committing working tree changes in the Repository Git drawer.
                        </div>
                      </div>
                      <input
                        id="settingsGitName"
                        type="text"
                        className="field-input settings-inline-input"
                        value={workspaceSettings.commitAuthorName}
                        placeholder="Workspace Author"
                        onChange={(e) =>
                          onUpdateWorkspaceSettings((prev) => ({
                            ...prev,
                            commitAuthorName: e.target.value
                          }))
                        }
                      />
                    </div>

                    <div className="settings-card-row">
                      <div className="settings-row-copy">
                        <label htmlFor="settingsGitEmail" className="settings-row-title">
                          Git commit author email
                        </label>
                        <div className="settings-row-desc">
                          Optional email for local commits (defaults to repository Git config if blank).
                        </div>
                      </div>
                      <input
                        id="settingsGitEmail"
                        type="email"
                        className="field-input settings-inline-input"
                        value={workspaceSettings.commitAuthorEmail}
                        placeholder="you@example.com"
                        onChange={(e) =>
                          onUpdateWorkspaceSettings((prev) => ({
                            ...prev,
                            commitAuthorEmail: e.target.value
                          }))
                        }
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {section === 'repositories' && (
              <div className="settings-section-stack">
                <div className="settings-group-block">
                  <div className="settings-group-head-row">
                    <h3 className="settings-group-title">Connected repositories ({projects.length})</h3>
                    <button
                      type="button"
                      className="btn btn-compact btn-primary"
                      onClick={() => {
                        onClose();
                        onOpenImportRepoModal();
                      }}
                    >
                      <Plus size={13} aria-hidden="true" />
                      <span>Add or clone repo…</span>
                    </button>
                  </div>

                  {repoFeedback && (
                    <div
                      className={`settings-inline-notice ${
                        repoFeedback.kind === 'err' ? 'is-error' : 'is-ok'
                      }`}
                    >
                      {repoFeedback.text}
                    </div>
                  )}

                  <div className="settings-card-group">
                    {projects.length === 0 ? (
                      <div className="settings-card-row">
                        <div className="settings-row-copy">
                          <div className="settings-row-title">No repositories connected</div>
                          <div className="settings-row-desc">
                            Clone a remote URL, attach a local checkout, or initialize a fresh documentation repository.
                          </div>
                        </div>
                      </div>
                    ) : (
                      projects.map((proj) => {
                        const isEditing = editingRepoId === proj.id;
                        const isConfirmingRemove = confirmRemoveRepoId === proj.id;
                        const isActive = proj.id === activeProjectId;
                        const docOptions = Array.from(
                          new Set([proj.defaultDoc, ...proj.docs.map((d) => d.path)].filter(Boolean))
                        );

                        return (
                          <div
                            key={proj.id}
                            className={`settings-card-row is-cred-item ${
                              isEditing ? 'is-stacked-control' : ''
                            }`}
                          >
                            {isEditing ? (
                              <form
                                className="settings-repo-edit-form"
                                onSubmit={(e) => void handleSaveRepoEdit(e, proj.id)}
                              >
                                <div className="settings-repo-edit-head">
                                  <strong>Edit repository</strong>
                                  <span className="code-chip">{proj.id}</span>
                                </div>
                                <div className="settings-cred-grid">
                                  <label className="settings-field-col">
                                    <span>Display name</span>
                                    <input
                                      type="text"
                                      className="field-input"
                                      value={editRepoName}
                                      onChange={(e) => setEditRepoName(e.target.value)}
                                      required
                                    />
                                  </label>
                                  <label className="settings-field-col">
                                    <span>Default page</span>
                                    {docOptions.length > 0 ? (
                                      <select
                                        className="field-input field-code"
                                        value={editRepoDefaultDoc}
                                        onChange={(e) => setEditRepoDefaultDoc(e.target.value)}
                                      >
                                        {docOptions.map((docPath) => (
                                          <option key={docPath} value={docPath}>
                                            {docPath}
                                          </option>
                                        ))}
                                      </select>
                                    ) : (
                                      <input
                                        type="text"
                                        className="field-input field-code"
                                        value={editRepoDefaultDoc}
                                        onChange={(e) => setEditRepoDefaultDoc(e.target.value)}
                                        placeholder="README.md"
                                      />
                                    )}
                                  </label>
                                </div>
                                <div className="settings-repo-edit-actions">
                                  <button
                                    type="button"
                                    className="btn btn-compact"
                                    onClick={() => setEditingRepoId(null)}
                                    disabled={savingRepoId === proj.id}
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    type="submit"
                                    className="btn btn-compact btn-primary"
                                    disabled={!editRepoName.trim() || savingRepoId === proj.id}
                                  >
                                    {savingRepoId === proj.id ? 'Saving…' : 'Save changes'}
                                  </button>
                                </div>
                              </form>
                            ) : (
                              <>
                                <div className="settings-row-copy">
                                  <div className="settings-row-title">
                                    <span>{proj.name}</span>
                                    <span className="code-chip" style={{ marginLeft: 4 }}>
                                      {proj.git.branch}
                                    </span>
                                    {isActive && (
                                      <span className="settings-badge is-ok" style={{ marginLeft: 4 }}>
                                        Active
                                      </span>
                                    )}
                                    <span className="settings-badge" style={{ marginLeft: 4 }}>
                                      {proj.docs.length} {proj.docs.length === 1 ? 'page' : 'pages'}
                                    </span>
                                  </div>
                                  <div className="settings-row-desc settings-mono-desc" title={proj.rootPath}>
                                    Default: <code>{proj.defaultDoc}</code> ·{' '}
                                    {proj.git.remoteUrl ? `${proj.git.remoteUrl} · ` : ''}
                                    {proj.rootPath}
                                  </div>
                                </div>

                                <div className="settings-repo-actions">
                                  {isConfirmingRemove ? (
                                    <>
                                      <button
                                        type="button"
                                        className="btn btn-compact btn-danger"
                                        disabled={removingRepoId === proj.id}
                                        onClick={() => void handleRemoveRepo(proj)}
                                      >
                                        {removingRepoId === proj.id ? 'Removing…' : 'Confirm remove'}
                                      </button>
                                      <button
                                        type="button"
                                        className="btn btn-compact"
                                        disabled={removingRepoId === proj.id}
                                        onClick={() => setConfirmRemoveRepoId(null)}
                                      >
                                        Cancel
                                      </button>
                                    </>
                                  ) : (
                                    <>
                                      {!isActive && (
                                        <button
                                          type="button"
                                          className="btn btn-compact"
                                          onClick={() => {
                                            void onSelectProject(proj.id);
                                            setRepoFeedback({
                                              kind: 'ok',
                                              text: `Switched workspace to "${proj.name}".`
                                            });
                                          }}
                                        >
                                          Open
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        className="btn btn-compact"
                                        onClick={() => startEditingRepo(proj)}
                                        title={`Edit name or default page for ${proj.name}`}
                                      >
                                        <PenLine size={12} aria-hidden="true" />
                                        <span>Edit</span>
                                      </button>
                                      <button
                                        type="button"
                                        className="btn btn-compact"
                                        onClick={() => {
                                          setEditingRepoId(null);
                                          setConfirmRemoveRepoId(proj.id);
                                          setRepoFeedback(null);
                                        }}
                                        title={`Remove ${proj.name} from Cairn (keeps files on disk)`}
                                      >
                                        <Trash2 size={12} aria-hidden="true" />
                                        <span>Remove</span>
                                      </button>
                                    </>
                                  )}
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                  <p className="import-hint-text">
                    Removing a repository disconnects it from Cairn’s registry while leaving all local files and Git history intact on disk.
                  </p>
                </div>
              </div>
            )}

            {section === 'git-defaults' && (
              <div className="settings-section-stack">
                <div className="settings-group-block">
                  <h3 className="settings-group-title">Git Drawer Preferences</h3>
                  <div className="settings-card-group">
                    <div className="settings-card-row">
                      <div className="settings-row-copy">
                        <div className="settings-row-title">Default Git drawer tab</div>
                        <div className="settings-row-desc">
                          Which tab opens first when you click the branch/status pill in the header.
                        </div>
                      </div>
                      <div
                        className="mode-switch settings-theme-switch"
                        role="radiogroup"
                        aria-label="Default Git drawer tab"
                      >
                        {(
                          [
                            { id: 'changes', label: 'Working changes' },
                            { id: 'branches', label: 'Branches & PRs' }
                          ] as const
                        ).map((opt) => {
                          const selected = workspaceSettings.defaultGitTab === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              className={selected ? 'active' : ''}
                              onClick={() =>
                                onUpdateWorkspaceSettings((prev) => ({
                                  ...prev,
                                  defaultGitTab: opt.id as GitDrawerDefaultTab
                                }))
                              }
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="settings-card-row">
                      <div className="settings-row-copy">
                        <div className="settings-row-title">Auto-fetch on Git drawer open</div>
                        <div className="settings-row-desc">
                          Automatically fetch remote branches and ahead/behind counts when opening the Repository Git dialog.
                        </div>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={workspaceSettings.autoFetchOnGitOpen}
                        aria-label="Auto-fetch on Git drawer open"
                        className={`settings-toggle-switch ${
                          workspaceSettings.autoFetchOnGitOpen ? 'is-on' : ''
                        }`}
                        onClick={() =>
                          onUpdateWorkspaceSettings((prev) => ({
                            ...prev,
                            autoFetchOnGitOpen: !prev.autoFetchOnGitOpen
                          }))
                        }
                      >
                        <span className="settings-toggle-thumb" />
                      </button>
                    </div>

                    <div className="settings-card-row">
                      <div className="settings-row-copy">
                        <div className="settings-row-title">Fetch Pull / Merge Request refs</div>
                        <div className="settings-row-desc">
                          Query <code>refs/pull/*/head</code> (GitHub/Gitea) and{' '}
                          <code>refs/merge-requests/*/head</code> (GitLab) during remote Fetch.
                        </div>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={workspaceSettings.includePrRefsOnFetch}
                        aria-label="Fetch Pull and Merge Request refs"
                        className={`settings-toggle-switch ${
                          workspaceSettings.includePrRefsOnFetch ? 'is-on' : ''
                        }`}
                        onClick={() =>
                          onUpdateWorkspaceSettings((prev) => ({
                            ...prev,
                            includePrRefsOnFetch: !prev.includePrRefsOnFetch
                          }))
                        }
                      >
                        <span className="settings-toggle-thumb" />
                      </button>
                    </div>
                  </div>
                </div>

                <div className="settings-group-block">
                  <h3 className="settings-group-title">Workspace Safety Guarantees</h3>
                  <div className="settings-card-group">
                    <div className="settings-card-row">
                      <div className="settings-row-copy">
                        <div className="settings-row-title">Local-only commits</div>
                        <div className="settings-row-desc">
                          Committing records staged edits on your active local branch and never pushes automatically to remotes.
                        </div>
                      </div>
                      <span className="settings-badge is-ok">Always on</span>
                    </div>
                    <div className="settings-card-row">
                      <div className="settings-row-copy">
                        <div className="settings-row-title">Clean working tree guard</div>
                        <div className="settings-row-desc">
                          Fast-forward pull and branch/PR checkouts block while uncommitted edits exist so drafts are never overwritten.
                        </div>
                      </div>
                      <span className="settings-badge is-ok">Enforced</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {section === 'credentials' && (
              <div className="settings-section-stack">
                <div className="settings-group-block">
                  <div className="settings-group-head-row">
                    <h3 className="settings-group-title">Add HTTPS Personal Access Token</h3>
                    <span className="settings-badge is-ok">
                      <ShieldCheck size={12} aria-hidden="true" />
                      <span>
                        {encryptionMode === 'env-key'
                          ? 'AES-256-GCM · Env key'
                          : encryptionMode === 'file-key'
                            ? 'AES-256-GCM · 0600 file key'
                            : 'Memory-only'}
                      </span>
                    </span>
                  </div>

                  <form className="settings-card-group settings-cred-form" onSubmit={(e) => void handleSaveCredential(e)}>
                    <div className="settings-card-row is-stacked-control">
                      <div className="settings-row-copy">
                        <div className="settings-row-title">Host &amp; token</div>
                        <div className="settings-row-desc">
                          Tokens are encrypted at rest outside repositories, never written into <code>.git/config</code>, and injected per command via a temporary credential helper.
                        </div>
                      </div>
                      <div className="settings-cred-grid">
                        <label className="settings-field-col">
                          <span>Git host</span>
                          <input
                            type="text"
                            className="field-input field-code"
                            placeholder="github.com"
                            value={credHost}
                            onChange={(e) => setCredHost(e.target.value)}
                            required
                          />
                        </label>
                        <label className="settings-field-col">
                          <span>Username (optional)</span>
                          <input
                            type="text"
                            className="field-input field-code"
                            placeholder="x-access-token"
                            value={credUsername}
                            onChange={(e) => setCredUsername(e.target.value)}
                          />
                        </label>
                        <label className="settings-field-col settings-field-wide">
                          <span>Personal Access Token (write-only)</span>
                          <div className="settings-secret-row">
                            <input
                              ref={credTokenInputRef}
                              type={showCredToken ? 'text' : 'password'}
                              className="field-input field-code"
                              placeholder="ghp_… or github_pat_… or glpat-…"
                              autoComplete="off"
                              value={credToken}
                              onChange={(e) => setCredToken(e.target.value)}
                              required
                            />
                            <button
                              type="button"
                              className="btn btn-compact"
                              onClick={() => setShowCredToken((v) => !v)}
                              aria-label={showCredToken ? 'Hide token' : 'Show token'}
                              title={showCredToken ? 'Hide token' : 'Show token'}
                            >
                              {showCredToken ? <EyeOff size={13} /> : <Eye size={13} />}
                            </button>
                            <button
                              type="submit"
                              className="btn btn-compact btn-primary"
                              disabled={!credHost.trim() || !credToken.trim() || credSaving}
                            >
                              {credSaving ? 'Saving…' : 'Save token'}
                            </button>
                          </div>
                        </label>
                      </div>
                    </div>
                  </form>

                  {credFeedback && (
                    <div
                      className={`settings-inline-notice ${
                        credFeedback.kind === 'err' ? 'is-error' : 'is-ok'
                      }`}
                    >
                      {credFeedback.text}
                    </div>
                  )}
                </div>

                <div className="settings-group-block">
                  <h3 className="settings-group-title">Configured Hosts ({credentials.length})</h3>
                  <div className="settings-card-group">
                    {credsLoading && credentials.length === 0 ? (
                      <div className="settings-card-row">
                        <div className="settings-row-desc">Loading credentials…</div>
                      </div>
                    ) : credentials.length === 0 ? (
                      <div className="settings-card-row">
                        <div className="settings-row-copy">
                          <div className="settings-row-title">No HTTPS tokens configured</div>
                          <div className="settings-row-desc">
                            Public repositories work without tokens. Add a PAT above to clone, fetch, or pull private HTTPS remotes.
                          </div>
                        </div>
                      </div>
                    ) : (
                      credentials.map((cred) => (
                        <div key={cred.id} className="settings-card-row is-cred-item">
                          <div className="settings-row-copy">
                            <div className="settings-row-title">
                              <code>{cred.host}</code>
                              <span className="code-chip" style={{ marginLeft: 8 }}>
                                {cred.maskedHint}
                              </span>
                              <span
                                className={`settings-badge ${cred.source === 'stored' ? 'is-ok' : ''}`}
                                style={{ marginLeft: 6 }}
                              >
                                {cred.source === 'stored' ? 'Encrypted' : 'Env'}
                              </span>
                            </div>
                            <div className="settings-row-desc">
                              Username: <code>{cred.username}</code>
                              {cred.updatedAt
                                ? ` · Updated ${new Date(cred.updatedAt).toLocaleDateString()}`
                                : ''}
                            </div>

                            {testingCredId === cred.id && (
                              <form
                                className="settings-test-form"
                                onSubmit={(e) => void handleTestCredentialUrl(e)}
                              >
                                <input
                                  type="text"
                                  className="field-input field-code"
                                  placeholder={`https://${cred.host}/owner/private-repo.git`}
                                  value={testUrl}
                                  onChange={(e) => setTestUrl(e.target.value)}
                                  required
                                />
                                <button
                                  type="submit"
                                  className="btn btn-compact btn-primary"
                                  disabled={!testUrl.trim() || testPending}
                                >
                                  {testPending ? (
                                    <Loader2 size={12} className="spin-icon" aria-hidden="true" />
                                  ) : (
                                    <CheckCircle2 size={12} aria-hidden="true" />
                                  )}
                                  <span>{testPending ? 'Checking…' : 'Probe'}</span>
                                </button>
                                {testResult && (
                                  <div
                                    className={`settings-test-result ${
                                      testResult.kind === 'err' ? 'is-error' : 'is-ok'
                                    }`}
                                  >
                                    {testResult.text}
                                  </div>
                                )}
                              </form>
                            )}
                          </div>

                          <div className="settings-cred-actions">
                            <button
                              type="button"
                              className="btn btn-compact"
                              onClick={() => {
                                setCredHost(cred.host);
                                setCredUsername(cred.username);
                                setCredToken('');
                                setCredFeedback(null);
                                window.setTimeout(() => credTokenInputRef.current?.focus(), 0);
                              }}
                              title={
                                cred.source === 'stored'
                                  ? `Replace token or username for ${cred.host}`
                                  : `Save an encrypted token overriding the env var for ${cred.host}`
                              }
                            >
                              <PenLine size={12} aria-hidden="true" />
                              <span>{cred.source === 'stored' ? 'Rotate' : 'Override'}</span>
                            </button>
                            <button
                              type="button"
                              className="btn btn-compact"
                              onClick={() => {
                                if (testingCredId === cred.id) {
                                  setTestingCredId(null);
                                  setTestResult(null);
                                } else {
                                  setTestingCredId(cred.id);
                                  setTestUrl(`https://${cred.host}/`);
                                  setTestResult(null);
                                }
                              }}
                            >
                              {testingCredId === cred.id ? 'Close test' : 'Test URL'}
                            </button>
                            {cred.source === 'stored' && (
                              <button
                                type="button"
                                className="btn btn-compact"
                                disabled={removingCredId === cred.id}
                                onClick={() => void handleRemoveCredential(cred.id)}
                                title={`Remove saved token for ${cred.host}`}
                              >
                                <Trash2 size={12} aria-hidden="true" />
                                <span>{removingCredId === cred.id ? 'Removing…' : 'Remove'}</span>
                              </button>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}

            {section === 'environment' && (
              <div className="settings-section-stack">
                <div className="settings-group-block">
                  <div className="settings-group-head-row">
                    <h3 className="settings-group-title">Server Storage &amp; Paths</h3>
                    <button
                      type="button"
                      className="btn btn-compact"
                      disabled={envLoading}
                      onClick={() => void refreshEnvironment()}
                    >
                      <RefreshCw size={12} className={envLoading ? 'spin-icon' : ''} aria-hidden="true" />
                      <span>{envLoading ? 'Refreshing…' : 'Refresh'}</span>
                    </button>
                  </div>
                  <div className="settings-card-group">
                    {envLoading && !envInfo ? (
                      <div className="settings-card-row">
                        <div className="settings-row-desc">Reading server configuration…</div>
                      </div>
                    ) : envInfo ? (
                      <>
                        <div className="settings-card-row">
                          <div className="settings-row-copy">
                            <div className="settings-row-title">Managed clones directory</div>
                            <div className="settings-row-desc settings-mono-desc">
                              {envInfo.managedReposDir}
                            </div>
                          </div>
                        </div>
                        <div className="settings-card-row">
                          <div className="settings-row-copy">
                            <div className="settings-row-title">Allowed local import roots</div>
                            <div className="settings-row-desc settings-mono-desc">
                              {envInfo.allowedImportRoots.join(', ')}
                            </div>
                          </div>
                        </div>
                        <div className="settings-card-row">
                          <div className="settings-row-copy">
                            <div className="settings-row-title">Registry config file</div>
                            <div className="settings-row-desc settings-mono-desc">
                              {envInfo.configPath ?? 'In-memory (no config file)'}
                            </div>
                          </div>
                        </div>
                        <div className="settings-card-row">
                          <div className="settings-row-copy">
                            <div className="settings-row-title">Encrypted credentials store</div>
                            <div className="settings-row-desc settings-mono-desc">
                              {envInfo.credentialsPath ?? 'Memory-only (ephemeral key)'}
                            </div>
                          </div>
                          <span className="settings-badge is-ok">{envInfo.encryptionMode}</span>
                        </div>
                        <div className="settings-card-row">
                          <div className="settings-row-copy">
                            <div className="settings-row-title">SSH transport client</div>
                            <div className="settings-row-desc">
                              OpenSSH client availability for <code>git@host:...</code> remotes.
                            </div>
                          </div>
                          <span
                            className={`settings-badge ${
                              envInfo.sshClientAvailable ? 'is-ok' : 'is-warn'
                            }`}
                          >
                            {envInfo.sshClientAvailable ? 'Available' : 'Not installed'}
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="settings-card-row">
                        <div className="settings-row-desc">Unable to load environment info.</div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {section === 'about' && (
              <div className="settings-section-stack">
                <div className="settings-group-block">
                  <h3 className="settings-group-title">Workspace Architecture</h3>
                  <div className="settings-card-group">
                    <div className="settings-card-row">
                      <div className="settings-row-copy">
                        <div className="settings-row-title">Self-hosted repository docs hub</div>
                        <div className="settings-row-desc">
                          Stores documentation in plain Git Markdown files with portable anchored comment sidecars and sandboxed opaque-origin iframe embeds.
                        </div>
                      </div>
                      <span className="settings-badge">v0.1.0</span>
                    </div>
                    <div className="settings-card-row">
                      <div className="settings-row-copy">
                        <div className="settings-row-title">Credential isolation</div>
                        <div className="settings-row-desc">
                          HTTPS Personal Access Tokens are AES-256-GCM encrypted in a 0600 file separate from repository checkouts, passed via child-process environment variables, and scrubbed from logs.
                        </div>
                      </div>
                      <span className="settings-badge is-ok">Isolated</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <footer className="settings-main-footer">
            <span className="settings-footer-hint">
              {section === 'credentials'
                ? 'Encrypted at rest on the Cairn server.'
                : section === 'repositories'
                  ? 'Saved to the Cairn repository registry.'
                  : section === 'environment' || section === 'about'
                    ? 'Server runtime diagnostics.'
                    : 'Saved automatically in this browser.'}
            </span>
            <button
              type="button"
              className="btn btn-compact btn-primary reading-done-btn"
              onClick={onClose}
            >
              Done
            </button>
          </footer>
        </section>
      </div>
    </div>
  );
}
