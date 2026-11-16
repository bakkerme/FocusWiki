import { useRef, useState, type RefObject } from 'react';
import { Blocks, FileText, Plus, Search, Settings, X } from 'lucide-react';
import type { ProjectSummary, SearchResultItem } from '../../shared/types';
import { useModalOverlayFocus } from '../utils/overlayModal';

interface Props {
  projects: ProjectSummary[];
  activeProject: ProjectSummary | null;
  activeDocPath: string;
  isEditing: boolean;
  isOverlay: boolean;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  settingsTriggerRef?: RefObject<HTMLButtonElement>;
  searchQuery: string;
  searchResults: SearchResultItem[];
  onChangeSearch: (q: string) => void;
  onSelectProject: (projectId: string) => void;
  onSelectDoc: (projectId: string, docPath: string) => void;
  onCreateDoc: (relPath: string, title: string) => Promise<void>;
  onOpenEmbedModal: () => void;
  onOpenReadingSettings: () => void;
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
    searchQuery,
    searchResults,
    onChangeSearch,
    onSelectProject,
    onSelectDoc,
    onCreateDoc,
    onOpenEmbedModal,
    onOpenReadingSettings,
    onClose
  } = props;

  const navRef = useRef<HTMLElement | null>(null);
  const [creatingDoc, setCreatingDoc] = useState<boolean>(false);
  const [newDocTitle, setNewDocTitle] = useState<string>('');
  const [newDocPath, setNewDocPath] = useState<string>('docs/');
  const [createErr, setCreateErr] = useState<string | null>(null);

  useModalOverlayFocus({
    active: isOverlay,
    containerRef: navRef,
    restoreFocusRef,
    initialFocusSelector: '#globalSearchInput',
    onDismiss: onClose
  });

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!newDocTitle.trim() || !newDocPath.trim()) return;
    setCreateErr(null);
    try {
      await onCreateDoc(newDocPath.trim(), newDocTitle.trim());
      setNewDocTitle('');
      setNewDocPath('docs/');
      setCreatingDoc(false);
      if (isOverlay) {
        onClose();
      }
    } catch (err) {
      setCreateErr(err instanceof Error ? err.message : 'Could not create file');
    }
  }

  return (
    <aside
      id="cairn-nav-panel"
      ref={navRef}
      className={`nav-sidebar ${isOverlay ? 'is-overlay is-overlay-open is-mobile-open' : 'is-docked'}`}
      role={isOverlay ? 'dialog' : undefined}
      aria-modal={isOverlay ? 'true' : undefined}
      aria-label="Projects and documents"
      tabIndex={-1}
    >
      <div className="brand-row">
        <div className="brand-identity">
          <span className="brand-name">Cairn</span>
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
        <label htmlFor="projectSelect">Repository</label>
        <select
          id="projectSelect"
          className="project-select"
          value={activeProject?.id ?? ''}
          title={activeProject?.description ?? 'Select repository'}
          onChange={(e) => {
            onSelectProject(e.target.value);
          }}
        >
          {projects.map((proj) => (
            <option key={proj.id} value={proj.id}>
              {proj.name}
            </option>
          ))}
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

      {activeProject && (
        <nav className="sidebar-docs-section" aria-label={`${activeProject.name} documents`}>
          <div className="sidebar-section-header">
            <span className="sidebar-heading">Pages</span>
            <button
              type="button"
              className="btn btn-compact btn-quiet"
              onClick={() => setCreatingDoc((v) => !v)}
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
                  const slug = t
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-|-$/g, '');
                  if (slug) setNewDocPath(`docs/${slug}.md`);
                }}
              />
              <input
                type="text"
                placeholder="docs/example.md"
                className="field-input field-code"
                value={newDocPath}
                onChange={(e) => setNewDocPath(e.target.value)}
              />
              {createErr && <div className="form-error-text">{createErr}</div>}
              <button type="submit" className="btn btn-compact btn-primary">
                Create page
              </button>
            </form>
          )}

          <div className="doc-list">
            {activeProject.docs.map((doc) => {
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
            })}
          </div>
        </nav>
      )}

      <div className="sidebar-utility-footer">
        <button
          ref={settingsTriggerRef}
          type="button"
          className="sidebar-settings-btn"
          onClick={onOpenReadingSettings}
          aria-label="Reading settings"
          title="Reading settings — text size and page width"
        >
          <Settings size={14} className="sidebar-settings-icon" aria-hidden="true" />
          <span>Reading settings</span>
        </button>
      </div>

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
    </aside>
  );
}
