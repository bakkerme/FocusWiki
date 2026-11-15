import { useState } from 'react';
import { Search } from 'lucide-react';
import type { ProjectSummary, SearchResultItem } from '../../shared/types';

interface Props {
  projects: ProjectSummary[];
  activeProject: ProjectSummary | null;
  activeDocPath: string;
  searchQuery: string;
  searchResults: SearchResultItem[];
  onChangeSearch: (q: string) => void;
  onSelectProject: (projectId: string) => void;
  onSelectDoc: (projectId: string, docPath: string) => void;
  onCreateDoc: (relPath: string, title: string) => Promise<void>;
  onOpenEmbedModal: () => void;
}

export function SidebarNav(props: Props) {
  const {
    projects,
    activeProject,
    activeDocPath,
    searchQuery,
    searchResults,
    onChangeSearch,
    onSelectProject,
    onSelectDoc,
    onCreateDoc,
    onOpenEmbedModal
  } = props;

  const [creatingDoc, setCreatingDoc] = useState<boolean>(false);
  const [newDocTitle, setNewDocTitle] = useState<string>('');
  const [newDocPath, setNewDocPath] = useState<string>('docs/');
  const [createErr, setCreateErr] = useState<string | null>(null);

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!newDocTitle.trim() || !newDocPath.trim()) return;
    setCreateErr(null);
    try {
      await onCreateDoc(newDocPath.trim(), newDocTitle.trim());
      setNewDocTitle('');
      setNewDocPath('docs/');
      setCreatingDoc(false);
    } catch (err) {
      setCreateErr(err instanceof Error ? err.message : 'Could not create file');
    }
  }

  return (
    <aside className="nav-sidebar" aria-label="Projects and documents">
      <div className="brand-row">
        <h1 className="brand-name">Cairn</h1>
        <span className="brand-sub">Local repo docs</span>
      </div>

      <div className="project-select-box">
        <label htmlFor="projectSelect">Active repository</label>
        <select
          id="projectSelect"
          className="project-select"
          value={activeProject?.id ?? ''}
          onChange={(e) => onSelectProject(e.target.value)}
        >
          {projects.map((proj) => (
            <option key={proj.id} value={proj.id}>
              {proj.name} ({proj.git.branch})
            </option>
          ))}
        </select>
        {activeProject && <p className="project-desc">{activeProject.description}</p>}
      </div>

      <div>
        <label htmlFor="globalSearchInput" className="sidebar-heading">
          Search across projects
        </label>
        <div className="search-box">
          <Search size={14} className="search-icon" />
          <input
            id="globalSearchInput"
            type="search"
            className="search-input"
            placeholder="Find text, IP, rule, or embed…"
            value={searchQuery}
            onChange={(e) => onChangeSearch(e.target.value)}
          />
        </div>

        {searchQuery.trim() !== '' && (
          <div className="search-results-panel" style={{ marginTop: 6 }}>
            {searchResults.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--ink-secondary)', padding: 6 }}>
                No matching lines across registered repositories.
              </div>
            ) : (
              searchResults.map((hit, idx) => (
                <button
                  key={`${hit.projectId}:${hit.path}:${hit.line}:${idx}`}
                  type="button"
                  className="search-hit"
                  onClick={() => {
                    onSelectDoc(hit.projectId, hit.path);
                    onChangeSearch('');
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
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 6
            }}
          >
            <span className="sidebar-heading" style={{ margin: 0 }}>
              Documents ({activeProject.docs.length})
            </span>
            <button
              type="button"
              className="btn btn-compact"
              onClick={() => setCreatingDoc((v) => !v)}
            >
              {creatingDoc ? 'Cancel' : 'New doc'}
            </button>
          </div>

          {creatingDoc && (
            <form
              onSubmit={(e) => void handleCreateSubmit(e)}
              style={{
                background: 'var(--surface-sheet)',
                border: '1px solid var(--line-border)',
                borderRadius: 5,
                padding: 10,
                marginBottom: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 6
              }}
            >
              <input
                type="text"
                placeholder="Document title"
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
                style={{ padding: '5px 8px', border: '1px solid var(--line-border)', borderRadius: 4 }}
              />
              <input
                type="text"
                placeholder="docs/example.md"
                value={newDocPath}
                onChange={(e) => setNewDocPath(e.target.value)}
                style={{
                  padding: '5px 8px',
                  fontFamily: 'var(--font-code)',
                  fontSize: 12,
                  border: '1px solid var(--line-border)',
                  borderRadius: 4
                }}
              />
              {createErr && (
                <div style={{ fontSize: 11.5, color: 'var(--conflict-garnet)' }}>{createErr}</div>
              )}
              <button type="submit" className="btn btn-compact btn-primary">
                Create Markdown file
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
                  onClick={() => onSelectDoc(activeProject.id, doc.path)}
                >
                  <div style={{ minWidth: 0 }}>
                    <div className="doc-item-title">{doc.title}</div>
                    <div className="doc-item-path">{doc.path}</div>
                  </div>
                  {doc.openComments > 0 && (
                    <span className="comment-count-pill" title={`${doc.openComments} open threads`}>
                      {doc.openComments}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {activeProject && (
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 6
            }}
          >
            <span className="sidebar-heading" style={{ margin: 0 }}>
              Project embeds ({activeProject.embeds.length})
            </span>
            <button type="button" className="btn btn-compact" onClick={onOpenEmbedModal}>
              Add embed
            </button>
          </div>
          <div className="embed-inventory-list">
            {activeProject.embeds.map((emb) => (
              <div key={emb.src} className="embed-inventory-item">
                <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {emb.name}
                </span>
                <span style={{ fontFamily: 'var(--font-code)', fontSize: 11, color: 'var(--ink-secondary)' }}>
                  {emb.files.length} {emb.files.length === 1 ? 'file' : 'files'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
