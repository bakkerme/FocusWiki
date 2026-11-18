import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  Blocks,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FileText,
  Info,
  Folder,
  FolderOpen,
  Plus,
  Search,
  Settings,
  X
} from 'lucide-react';
import type { DocTreeEntry, ProjectSummary, SearchResultItem } from '../../shared/types';
import {
  buildDocTree,
  computeDefaultExpandedFolders,
  deriveDefaultNewDocDir,
  folderContainsDoc,
  getAncestorFolderKeys,
  type DocTreeFolderNode
} from '../utils/docTree';
import { useModalOverlayFocus } from '../utils/overlayModal';

const SIDEBAR_FOLDERS_STORAGE_KEY = 'focus:sidebar-folders:v1';

function loadPersistedFolderState(): Record<string, Record<string, boolean>> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.sessionStorage.getItem(SIDEBAR_FOLDERS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as Record<string, Record<string, boolean>>;
  } catch {
    return {};
  }
}

function savePersistedFolderState(state: Record<string, Record<string, boolean>>): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SIDEBAR_FOLDERS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage quota or private-mode restrictions
  }
}

interface Props {
  projects: ProjectSummary[];
  activeProject: ProjectSummary | null;
  activeDocPath: string;
  isEditing: boolean;
  isOverlay: boolean;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  settingsTriggerRef?: RefObject<HTMLButtonElement>;
  enrollmentTriggerRef?: RefObject<HTMLButtonElement>;
  searchQuery: string;
  searchResults: SearchResultItem[];
  onChangeSearch: (q: string) => void;
  onSelectProject: (projectId: string) => void;
  onSelectDoc: (projectId: string, docPath: string) => void;
  onCreateDoc: (relPath: string, title: string) => Promise<void>;
  onOpenEmbedModal: () => void;
  onOpenReadingSettings: () => void;
  onOpenEnrollment: () => void;
  onClose: () => void;
}

export function SidebarNav(props: Props) {
  const {
    projects,
    activeProject,
    activeDocPath,
    isEditing,
    isOverlay,
    restoreFocusRef,
    settingsTriggerRef,
    enrollmentTriggerRef,
    searchQuery,
    searchResults,
    onChangeSearch,
    onSelectProject,
    onSelectDoc,
    onCreateDoc,
    onOpenEmbedModal,
    onOpenReadingSettings,
    onOpenEnrollment,
    onClose
  } = props;

  const navRef = useRef<HTMLElement | null>(null);
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const [creatingDoc, setCreatingDoc] = useState<boolean>(false);
  const [newDocTitle, setNewDocTitle] = useState<string>('');
  const [newDocPath, setNewDocPath] = useState<string>('docs/');
  const [pathManuallyEdited, setPathManuallyEdited] = useState<boolean>(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [expandedByProject, setExpandedByProject] = useState<
    Record<string, Record<string, boolean>>
  >(loadPersistedFolderState);

  useModalOverlayFocus({
    active: isOverlay,
    containerRef: navRef,
    restoreFocusRef,
    initialFocusSelector: '#globalSearchInput',
    onDismiss: onClose
  });

  const docTree = useMemo(
    () => (activeProject ? buildDocTree(activeProject.docs, activeProject.defaultDoc) : null),
    [activeProject]
  );

  const defaultExpanded = useMemo(
    () =>
      docTree && activeProject
        ? computeDefaultExpandedFolders(docTree, activeDocPath, activeProject.docs.length)
        : {},
    [docTree, activeDocPath, activeProject]
  );

  // Ensure ancestor folders of activeDocPath open when navigating to a page,
  // and keep the active item visible inside the sidebar scroll region without touching window.scrollY.
  useEffect(() => {
    if (!activeProject || !docTree || !activeDocPath) return;
    const projectId = activeProject.id;
    const ancestors = getAncestorFolderKeys(activeDocPath, docTree.allFolderKeys);

    if (ancestors.length > 0) {
      setExpandedByProject((prev) => {
        const currentProjMap = prev[projectId];
        if (!currentProjMap) return prev;
        const needsOpen = ancestors.some((key) => currentProjMap[key] === false);
        if (!needsOpen) return prev;
        const nextProjMap = { ...currentProjMap };
        for (const key of ancestors) {
          nextProjMap[key] = true;
        }
        const next = { ...prev, [projectId]: nextProjMap };
        savePersistedFolderState(next);
        return next;
      });
    }

    const rafId = window.requestAnimationFrame(() => {
      const container = treeScrollRef.current;
      if (!container) return;
      const activeEl = container.querySelector<HTMLElement>('.doc-item.active');
      if (!activeEl) return;
      const containerRect = container.getBoundingClientRect();
      const itemRect = activeEl.getBoundingClientRect();
      if (itemRect.top < containerRect.top + 8) {
        container.scrollTop -= containerRect.top + 8 - itemRect.top;
      } else if (itemRect.bottom > containerRect.bottom - 8) {
        container.scrollTop += itemRect.bottom - (containerRect.bottom - 8);
      }
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [activeProject?.id, activeDocPath, docTree]);

  function isFolderExpanded(folderKey: string): boolean {
    if (!activeProject) return false;
    const override = expandedByProject[activeProject.id]?.[folderKey];
    if (typeof override === 'boolean') return override;
    return defaultExpanded[folderKey] ?? false;
  }

  function handleToggleFolder(folderKey: string) {
    if (!activeProject) return;
    const projectId = activeProject.id;
    const nextValue = !isFolderExpanded(folderKey);
    setExpandedByProject((prev) => {
      const nextProjMap = {
        ...(prev[projectId] ?? {}),
        [folderKey]: nextValue
      };
      const next = { ...prev, [projectId]: nextProjMap };
      savePersistedFolderState(next);
      return next;
    });
  }

  const anyTopFolderExpanded = useMemo(() => {
    if (!docTree || !activeProject) return false;
    return docTree.folders.some((f) => {
      const override = expandedByProject[activeProject.id]?.[f.key];
      return typeof override === 'boolean' ? override : (defaultExpanded[f.key] ?? false);
    });
  }, [docTree, activeProject, expandedByProject, defaultExpanded]);

  function handleToggleAllFolders() {
    if (!activeProject || !docTree || docTree.allFolderKeys.length === 0) return;
    const projectId = activeProject.id;
    const targetOpen = !anyTopFolderExpanded;
    setExpandedByProject((prev) => {
      const nextProjMap: Record<string, boolean> = {};
      for (const key of docTree.allFolderKeys) {
        nextProjMap[key] = targetOpen;
      }
      const next = { ...prev, [projectId]: nextProjMap };
      savePersistedFolderState(next);
      return next;
    });
  }

  function handleToggleCreateForm() {
    setCreatingDoc((wasOpen) => {
      const nextOpen = !wasOpen;
      if (nextOpen) {
        const suggestedDir = deriveDefaultNewDocDir(activeDocPath);
        setNewDocTitle('');
        setNewDocPath(suggestedDir);
        setPathManuallyEdited(false);
        setCreateErr(null);
      }
      return nextOpen;
    });
  }

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!newDocTitle.trim() || !newDocPath.trim()) return;
    setCreateErr(null);
    try {
      await onCreateDoc(newDocPath.trim(), newDocTitle.trim());
      setNewDocTitle('');
      setNewDocPath('docs/');
      setPathManuallyEdited(false);
      setCreatingDoc(false);
      if (isOverlay) {
        onClose();
      }
    } catch (err) {
      setCreateErr(err instanceof Error ? err.message : 'Could not create file');
    }
  }

  function renderDocItem(doc: DocTreeEntry) {
    if (!activeProject) return null;
    const isActive = doc.path === activeDocPath;
    return (
      <button
        key={doc.path}
        type="button"
        className={`doc-item ${isActive ? 'active' : ''}`}
        aria-current={isActive ? 'page' : undefined}
        title={`${doc.title} — ${doc.path}`}
        onClick={() => {
          onSelectDoc(activeProject.id, doc.path);
          if (isOverlay) {
            onClose();
          }
        }}
      >
        <FileText size={14} className="doc-item-icon" aria-hidden="true" />
        <span className="doc-item-title">{doc.title}</span>
        {doc.openComments > 0 && (
          <span
            className="comment-count-pill"
            title={`${doc.openComments} open ${doc.openComments === 1 ? 'thread' : 'threads'}`}
          >
            {doc.openComments}
          </span>
        )}
      </button>
    );
  }

  function renderFolderNode(folder: DocTreeFolderNode) {
    const expanded = isFolderExpanded(folder.key);
    const containsActive = folderContainsDoc(folder.key, activeDocPath);

    return (
      <div
        key={folder.key}
        className={`doc-folder-group ${expanded ? 'is-open' : 'is-collapsed'}`}
        data-folder-path={folder.key}
      >
        <button
          type="button"
          className={`doc-folder-toggle ${expanded ? 'is-expanded' : ''} ${
            containsActive && !expanded ? 'has-active-child' : ''
          }`}
          aria-expanded={expanded}
          title={`${folder.key}/ (${folder.totalDocs} ${folder.totalDocs === 1 ? 'page' : 'pages'})`}
          onClick={() => handleToggleFolder(folder.key)}
        >
          <ChevronRight size={13} className="doc-folder-chevron" aria-hidden="true" />
          {expanded ? (
            <FolderOpen size={13.5} className="doc-folder-icon" aria-hidden="true" />
          ) : (
            <Folder size={13.5} className="doc-folder-icon" aria-hidden="true" />
          )}
          <span className="doc-folder-name">{folder.label}</span>
          {!expanded && folder.openComments > 0 && (
            <span
              className="comment-count-pill"
              title={`${folder.openComments} open ${
                folder.openComments === 1 ? 'thread' : 'threads'
              } in ${folder.key}/`}
            >
              {folder.openComments}
            </span>
          )}
          <span className="doc-folder-count" aria-hidden="true">
            {folder.totalDocs}
          </span>
        </button>

        {expanded && (
          <div className="doc-folder-children">
            {folder.overviewFiles.map((f) => renderDocItem(f.doc))}
            {folder.folders.map((sub) => renderFolderNode(sub))}
            {folder.regularFiles.map((f) => renderDocItem(f.doc))}
          </div>
        )}
      </div>
    );
  }

  return (
    <aside
      id="focus-nav-panel"
      ref={navRef}
      className={`nav-sidebar ${isOverlay ? 'is-overlay is-overlay-open is-mobile-open' : 'is-docked'}`}
      role={isOverlay ? 'dialog' : undefined}
      aria-modal={isOverlay ? 'true' : undefined}
      aria-label="Projects and documents"
      tabIndex={-1}
    >
      <div className="brand-row">
        <div className="brand-identity">
          <span className="brand-name">Focus</span>
          <span className="brand-sub">Docs</span>
        </div>
        <button
          type="button"
          className="icon-btn panel-close-btn mobile-drawer-close"
          onClick={onClose}
          aria-label="Close navigation"
          title="Close navigation"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="project-select-box">
        <div className="project-select-header">
          <label htmlFor="projectSelect">Repository</label>
          <button
            ref={enrollmentTriggerRef}
            type="button"
            className="btn btn-compact btn-quiet project-enrollment-btn"
            onClick={() => {
              if (isOverlay) onClose();
              onOpenEnrollment();
            }}
            title="How repositories are enrolled"
          >
            <Info size={12} aria-hidden="true" />
            <span>Enrollment</span>
          </button>
        </div>
        <select
          id="projectSelect"
          className="project-select"
          value={activeProject?.id ?? ''}
          disabled={projects.length === 0}
          title={activeProject?.description ?? 'Select repository'}
          onChange={(e) => {
            onSelectProject(e.target.value);
          }}
        >
          {projects.length === 0 ? (
            <option value="">No repositories</option>
          ) : (
            projects.map((proj) => (
              <option key={proj.id} value={proj.id}>
                {proj.name}
              </option>
            ))
          )}
        </select>
      </div>

      <div className="sidebar-search-section">
        <label htmlFor="globalSearchInput" className="sr-only">
          Search across projects
        </label>
        <div className="search-box">
          <Search size={14} className="search-icon" aria-hidden="true" />
          <input
            id="globalSearchInput"
            type="search"
            className="search-input"
            placeholder="Search across projects…"
            value={searchQuery}
            onChange={(e) => onChangeSearch(e.target.value)}
          />
        </div>

        {searchQuery.trim() !== '' && (
          <div className="search-results-panel">
            {searchResults.length === 0 ? (
              <div className="search-empty">No matching lines across repositories.</div>
            ) : (
              searchResults.map((hit, idx) => (
                <button
                  key={`${hit.projectId}:${hit.path}:${hit.line}:${idx}`}
                  type="button"
                  className="search-hit"
                  onClick={() => {
                    onSelectDoc(hit.projectId, hit.path);
                    onChangeSearch('');
                    if (isOverlay) {
                      onClose();
                    }
                  }}
                >
                  <div className="search-hit-title">{hit.title}</div>
                  <div className="search-hit-meta">
                    {hit.projectName} · {hit.path}:{hit.line}
                  </div>
                  <div className="search-hit-snippet">{hit.snippet}</div>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {activeProject && docTree && (
        <nav className="sidebar-docs-section" aria-label={`${activeProject.name} documents`}>
          <div className="sidebar-section-header">
            <div className="sidebar-heading-group">
              <span className="sidebar-heading">Pages</span>
              {activeProject.docs.length > 0 && (
                <span className="sidebar-doc-total" aria-label={`${activeProject.docs.length} pages`}>
                  {activeProject.docs.length}
                </span>
              )}
            </div>
            <div className="sidebar-section-actions">
              {docTree.folders.length > 0 && (
                <button
                  type="button"
                  className="icon-btn sidebar-tree-action-btn"
                  onClick={handleToggleAllFolders}
                  aria-label={anyTopFolderExpanded ? 'Collapse all folders' : 'Expand all folders'}
                  title={anyTopFolderExpanded ? 'Collapse all folders' : 'Expand all folders'}
                >
                  {anyTopFolderExpanded ? (
                    <ChevronsDownUp size={13.5} aria-hidden="true" />
                  ) : (
                    <ChevronsUpDown size={13.5} aria-hidden="true" />
                  )}
                </button>
              )}
              <button
                type="button"
                className="btn btn-compact btn-quiet"
                onClick={handleToggleCreateForm}
                title="Create a new Markdown page in this repository"
              >
                {creatingDoc ? (
                  <span>Cancel</span>
                ) : (
                  <>
                    <Plus size={13} aria-hidden="true" />
                    <span>New</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {creatingDoc && (
            <form onSubmit={(e) => void handleCreateSubmit(e)} className="new-doc-form">
              <input
                type="text"
                placeholder="Page title"
                className="field-input"
                value={newDocTitle}
                onChange={(e) => {
                  const t = e.target.value;
                  setNewDocTitle(t);
                  if (!pathManuallyEdited) {
                    const slug = t
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, '-')
                      .replace(/^-|-$/g, '');
                    const slashIdx = newDocPath.lastIndexOf('/');
                    const dirPrefix = slashIdx >= 0 ? newDocPath.slice(0, slashIdx + 1) : 'docs/';
                    setNewDocPath(slug ? `${dirPrefix}${slug}.md` : dirPrefix);
                  }
                }}
              />
              <input
                type="text"
                placeholder="docs/example.md"
                className="field-input field-code"
                value={newDocPath}
                onChange={(e) => {
                  setPathManuallyEdited(true);
                  setNewDocPath(e.target.value);
                }}
              />
              {createErr && <div className="form-error-text">{createErr}</div>}
              <button type="submit" className="btn btn-compact btn-primary">
                Create page
              </button>
            </form>
          )}

          <div ref={treeScrollRef} className="doc-tree-scroll">
            <div className="doc-list">
              {docTree.rootFiles.map((f) => renderDocItem(f.doc))}
              {docTree.folders.map((folder) => renderFolderNode(folder))}
            </div>
          </div>
        </nav>
      )}

      <div className="sidebar-footer">
        {activeProject && activeProject.embeds.length > 0 && (
          <div className="sidebar-embeds-footer">
            {isEditing ? (
              <div>
                <div className="sidebar-section-header">
                  <span className="sidebar-heading">Project embeds</span>
                  <button
                    type="button"
                    className="btn btn-compact btn-quiet"
                    onClick={() => {
                      if (isOverlay) {
                        onClose();
                      }
                      onOpenEmbedModal();
                    }}
                  >
                    <Blocks size={12} aria-hidden="true" />
                    <span>Add embed</span>
                  </button>
                </div>
                <div className="embed-inventory-list">
                  {activeProject.embeds.map((emb) => (
                    <div key={emb.src} className="embed-inventory-item" title={emb.src}>
                      <span className="embed-inv-name">{emb.name}</span>
                      <span className="embed-inv-meta">
                        {emb.files.length} {emb.files.length === 1 ? 'file' : 'files'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <details className="sidebar-embeds-disclosure">
                <summary>
                  <Blocks size={13} aria-hidden="true" />
                  <span>
                    {activeProject.embeds.length} project{' '}
                    {activeProject.embeds.length === 1 ? 'embed' : 'embeds'}
                  </span>
                </summary>
                <div className="embed-inventory-list" style={{ marginTop: 6 }}>
                  {activeProject.embeds.map((emb) => (
                    <div key={emb.src} className="embed-inventory-item" title={emb.src}>
                      <span className="embed-inv-name">{emb.name}</span>
                      <span className="embed-inv-meta">{emb.directory}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        <div className="sidebar-utility-footer">
          <button
            ref={settingsTriggerRef}
            type="button"
            className="sidebar-settings-btn"
            onClick={onOpenReadingSettings}
            aria-label="Settings"
            title="Settings for reading, appearance, and authoring"
          >
            <Settings size={15} className="sidebar-settings-icon" aria-hidden="true" />
            <span>Settings</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
