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
  FolderGit2,
  Info,
  Palette,
  PenLine,
  RotateCcw,
  Search,
  X
} from 'lucide-react';
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
  type ThemeMode,
  type WorkspaceSettings
} from '../utils/workspaceSettings';
import { useModalOverlayFocus } from '../utils/overlayModal';

export type SettingsSection =
  | 'reading'
  | 'appearance'
  | 'authoring'
  | 'repositories'
  | 'about';

interface NavItemSpec {
  id: SettingsSection;
  label: string;
  group: 'primary' | 'repos' | 'system';
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
    keywords: 'reviewer name comment identity',
    icon: PenLine
  },
  {
    id: 'repositories',
    label: 'Repositories',
    group: 'repos',
    keywords: 'projects repos operator managed enrollment access publishing',
    icon: FolderGit2
  },
  {
    id: 'about',
    label: 'About',
    group: 'system',
    keywords: 'version security sandbox privacy cairn focus',
    icon: Info
  }
];

const GROUP_LABELS: Record<'primary' | 'repos' | 'system', string | null> = {
  primary: null,
  repos: 'Workspace',
  system: 'System'
};

interface Props {
  initialSection?: SettingsSection;
  readingPreferences: ReadingPreferences;
  workspaceSettings: WorkspaceSettings;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  onChangeTextSize: (next: TextSizePreset) => void;
  onChangePageWidth: (next: PageWidthPreset) => void;
  onResetReadingDefaults: () => void;
  onUpdateWorkspaceSettings: (updater: (prev: WorkspaceSettings) => WorkspaceSettings) => void;
  onClose: () => void;
}

export function SettingsModal(props: Props) {
  const {
    initialSection = 'reading',
    readingPreferences,
    workspaceSettings,
    restoreFocusRef,
    onChangeTextSize,
    onChangePageWidth,
    onResetReadingDefaults,
    onUpdateWorkspaceSettings,
    onClose
  } = props;

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [navQuery, setNavQuery] = useState<string>('');

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
    workspaceSettings.reviewerName === DEFAULT_WORKSPACE_SETTINGS.reviewerName;

  const restoreDisabled =
    section === 'reading'
      ? isReadingDefault
      : section === 'appearance'
        ? isAppearanceDefault
        : isAuthoringDefault;

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
        reviewerName: DEFAULT_WORKSPACE_SETTINGS.reviewerName
      }));
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

  const activeTextSpec = getTextSizeSpec(readingPreferences.textSize);
  const activeWidthSpec = getPageWidthSpec(readingPreferences.pageWidth);

  const groupedNav = useMemo(() => {
    const groups: Array<{
      key: 'primary' | 'repos' | 'system';
      label: string | null;
      items: NavItemSpec[];
    }> = [
      { key: 'primary', label: GROUP_LABELS.primary, items: [] },
      { key: 'repos', label: GROUP_LABELS.repos, items: [] },
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
              {(section === 'reading' || section === 'appearance' || section === 'authoring') && (
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
                  </div>
                </div>
              </div>
            )}

            {section === 'repositories' && (
              <div className="settings-group-block">
                <h3 className="settings-group-title">Repository enrollment</h3>
                <div className="settings-card-group">
                  <div className="settings-card-row">
                    <div className="settings-row-copy">
                      <div className="settings-row-title">Managed by your workspace operator</div>
                      <div className="settings-row-desc">
                        Ask your workspace operator to add a repository or enable pull request publishing.
                        The operator configures the working copy, upstream repository, and credentials on the server.
                        Enrolled repositories appear in the sidebar.
                      </div>
                    </div>
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
                  </div>
                </div>
              </div>
            )}
          </div>

          <footer className="settings-main-footer">
            {section !== 'repositories' && section !== 'about' && (
              <span className="settings-footer-hint">Saved automatically in this browser.</span>
            )}
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
