import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CommentAnchor,
  ConflictErrorPayload,
  DocumentPayload,
  EmbedDescriptor,
  ProjectSummary,
  ResolvedCommentThread,
  SearchResultItem
} from '../shared/types';
import { EditorBridgeContext } from './editor/EmbedContext';
import {
  VisualMarkdownEditor,
  type VisualEditorHandle
} from './editor/VisualMarkdownEditor';
import { SidebarNav } from './components/SidebarNav';
import { ReviewMargin } from './components/ReviewMargin';
import { GitDrawerModal } from './components/GitDrawerModal';
import { ConflictModal } from './components/ConflictModal';
import { InsertEmbedModal } from './components/InsertEmbedModal';

export function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>('');
  const [activeDocPath, setActiveDocPath] = useState<string>('');
  const [docSessionNonce, setDocSessionNonce] = useState<number>(0);

  const [initialDocMarkdown, setInitialDocMarkdown] = useState<string>('');
  const [liveMarkdown, setLiveMarkdown] = useState<string>('');
  const [editorMode, setEditorMode] = useState<'visual' | 'source'>('visual');
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'conflict' | 'error'>('saved');
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const [threads, setThreads] = useState<ResolvedCommentThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [showResolvedComments, setShowResolvedComments] = useState<boolean>(false);
  const [pendingAnchor, setPendingAnchor] = useState<CommentAnchor | null>(null);
  const [composerOpen, setComposerOpen] = useState<boolean>(false);
  const [reviewOpen, setReviewOpen] = useState<boolean>(true);

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);

  const [embedReloadToken, setEmbedReloadToken] = useState<number>(0);
  const [gitModalOpen, setGitModalOpen] = useState<boolean>(false);
  const [embedModalOpen, setEmbedModalOpen] = useState<boolean>(false);
  const [conflictData, setConflictData] = useState<ConflictErrorPayload | null>(null);

  const visualEditorRef = useRef<VisualEditorHandle | null>(null);
  const baseRevisionRef = useRef<string>('');
  const lastSavedMdRef = useRef<string>('');
  const liveMdRef = useRef<string>('');
  const activeProjectIdRef = useRef<string>('');
  const activeDocPathRef = useRef<string>('');
  const saveTimerRef = useRef<number | null>(null);

  activeProjectIdRef.current = activeProjectId;
  activeDocPathRef.current = activeDocPath;
  liveMdRef.current = liveMarkdown;

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  );

  const refreshProjects = useCallback(async (): Promise<ProjectSummary[]> => {
    const res = await fetch('/api/projects');
    if (!res.ok) throw new Error('Unable to load projects');
    const data = (await res.json()) as { projects: ProjectSummary[] };
    setProjects(data.projects);
    return data.projects;
  }, []);

  const loadDocument = useCallback(async (projectId: string, docPath: string) => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    const res = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/doc?path=${encodeURIComponent(docPath)}`
    );
    if (!res.ok) {
      setStatusNotice(`Could not open ${docPath} (${res.status})`);
      return;
    }

    const payload = (await res.json()) as DocumentPayload;
    baseRevisionRef.current = payload.revision;
    lastSavedMdRef.current = payload.markdown;
    liveMdRef.current = payload.markdown;

    setActiveProjectId(projectId);
    setActiveDocPath(payload.path);
    setInitialDocMarkdown(payload.markdown);
    setLiveMarkdown(payload.markdown);
    setThreads(payload.comments);
    setSaveState('saved');
    setConflictData(null);
    setPendingAnchor(null);
    setComposerOpen(false);
    setActiveThreadId(null);
    setDocSessionNonce((n) => n + 1);

    const url = new URL(window.location.href);
    url.searchParams.set('project', projectId);
    url.searchParams.set('doc', payload.path);
    window.history.replaceState({}, '', url.toString());
  }, []);

  // Initial load from URL params or default project
  useEffect(() => {
    let cancelled = false;
    async function boot() {
      const list = await refreshProjects();
      if (cancelled || list.length === 0) return;

      const params = new URLSearchParams(window.location.search);
      const urlProject = params.get('project');
      const urlDoc = params.get('doc');

      const chosenProj = list.find((p) => p.id === urlProject) ?? list[0];
      const chosenDoc =
        urlDoc && chosenProj.docs.some((d) => d.path === urlDoc)
          ? urlDoc
          : chosenProj.defaultDoc || chosenProj.docs[0]?.path || '';

      if (chosenDoc) {
        await loadDocument(chosenProj.id, chosenDoc);
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, [loadDocument, refreshProjects]);

  const performSave = useCallback(
    async (markdownToSave: string, forceOverwrite = false) => {
      const projId = activeProjectIdRef.current;
      const docPath = activeDocPathRef.current;
      if (!projId || !docPath) return;

      if (!forceOverwrite && markdownToSave === lastSavedMdRef.current) {
        setSaveState('saved');
        return;
      }

      setSaveState('saving');
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projId)}/doc`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: docPath,
            markdown: markdownToSave,
            baseRevision: baseRevisionRef.current,
            forceOverwrite
          })
        });

        if (res.status === 409) {
          const conflictPayload = (await res.json()) as ConflictErrorPayload;
          setSaveState('conflict');
          setConflictData(conflictPayload);
          return;
        }

        if (!res.ok) {
          setSaveState('error');
          setStatusNotice(`Save failed (${res.status}). Your edits remain in the editor.`);
          return;
        }

        const saved = (await res.json()) as {
          revision: string;
          comments: ResolvedCommentThread[];
        };
        baseRevisionRef.current = saved.revision;
        lastSavedMdRef.current = markdownToSave;
        setThreads(saved.comments);
        setConflictData(null);
        setSaveState(liveMdRef.current === markdownToSave ? 'saved' : 'dirty');
        void refreshProjects();
      } catch {
        setSaveState('error');
        setStatusNotice('Network error while saving draft.');
      }
    },
    [refreshProjects]
  );

  const scheduleAutosave = useCallback(
    (nextMarkdown: string) => {
      setLiveMarkdown(nextMarkdown);
      liveMdRef.current = nextMarkdown;

      if (saveState === 'conflict') {
        return;
      }

      if (nextMarkdown === lastSavedMdRef.current) {
        setSaveState('saved');
        return;
      }

      setSaveState('dirty');
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void performSave(liveMdRef.current, false);
      }, 600);
    },
    [performSave, saveState]
  );

  // Live SSE listener for external file / bot edits
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as {
          type: string;
          projectId?: string;
          relPath?: string;
          kind?: string;
        };
        if (msg.type !== 'workspace:changed') return;

        void refreshProjects();

        if (msg.projectId !== activeProjectIdRef.current) return;

        if (msg.kind === 'embed') {
          setEmbedReloadToken((n) => n + 1);
          setStatusNotice(`Reloaded updated component asset (${msg.relPath}).`);
          return;
        }

        if (msg.kind === 'comments') {
          void (async () => {
            const res = await fetch(
              `/api/projects/${encodeURIComponent(activeProjectIdRef.current)}/comments?path=${encodeURIComponent(activeDocPathRef.current)}`
            );
            if (res.ok) {
              const data = (await res.json()) as { threads: ResolvedCommentThread[] };
              setThreads(data.threads);
            }
          })();
          return;
        }

        if (msg.kind === 'doc' && msg.relPath === activeDocPathRef.current) {
          void (async () => {
            const res = await fetch(
              `/api/projects/${encodeURIComponent(activeProjectIdRef.current)}/doc?path=${encodeURIComponent(activeDocPathRef.current)}`
            );
            if (!res.ok) return;
            const diskDoc = (await res.json()) as DocumentPayload;
            if (diskDoc.revision === baseRevisionRef.current) {
              return; // Our own save echoed back
            }

            const hasLocalUnsaved = liveMdRef.current !== lastSavedMdRef.current;
            if (!hasLocalUnsaved) {
              baseRevisionRef.current = diskDoc.revision;
              lastSavedMdRef.current = diskDoc.markdown;
              liveMdRef.current = diskDoc.markdown;
              setLiveMarkdown(diskDoc.markdown);
              setInitialDocMarkdown(diskDoc.markdown);
              setThreads(diskDoc.comments);
              visualEditorRef.current?.replaceMarkdownFromExternal(diskDoc.markdown);
              setStatusNotice(`Updated ${diskDoc.path} from external file edit.`);
            } else {
              setStatusNotice(
                `External edit detected on ${diskDoc.path}. Saving will compare both versions without overwriting.`
              );
            }
          })();
        }
      } catch {
        // ignore malformed keepalive
      }
    };
    return () => {
      es.close();
    };
  }, [refreshProjects]);

  // Cross-project search
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const data = (await res.json()) as { results: SearchResultItem[] };
        setSearchResults(data.results);
      }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  async function handleSelectProject(nextProjectId: string) {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      await performSave(liveMdRef.current, false);
    }
    const proj = projects.find((p) => p.id === nextProjectId);
    if (!proj) return;
    const targetDoc = proj.defaultDoc || proj.docs[0]?.path || '';
    if (targetDoc) {
      await loadDocument(proj.id, targetDoc);
    }
  }

  async function handleSelectDoc(projectId: string, docPath: string) {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      await performSave(liveMdRef.current, false);
    }
    await loadDocument(projectId, docPath);
  }

  async function handleCreateDoc(relPath: string, title: string) {
    if (!activeProject) return;
    const res = await fetch(`/api/projects/${encodeURIComponent(activeProject.id)}/docs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: relPath, title })
    });
    if (!res.ok) {
      const body = (await res.json()) as { message?: string };
      throw new Error(body.message ?? 'Could not create file');
    }
    const created = (await res.json()) as { path: string };
    await refreshProjects();
    await loadDocument(activeProject.id, created.path);
  }

  async function handleCreateComment(author: string, body: string) {
    if (!activeProjectId || !activeDocPath || !pendingAnchor) return;
    // Flush any pending prose save first so disk matches selection
    if (liveMdRef.current !== lastSavedMdRef.current) {
      await performSave(liveMdRef.current, false);
    }
    const res = await fetch(`/api/projects/${encodeURIComponent(activeProjectId)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: activeDocPath,
        anchor: pendingAnchor,
        author,
        role: 'human',
        body
      })
    });
    if (res.ok) {
      const { thread } = (await res.json()) as { thread: ResolvedCommentThread };
      setThreads((prev) => [...prev, thread]);
      setActiveThreadId(thread.id);
      setPendingAnchor(null);
      setComposerOpen(false);
      void refreshProjects();
    }
  }

  async function handleReplyComment(threadId: string, author: string, body: string) {
    if (!activeProjectId || !activeDocPath) return;
    const res = await fetch(
      `/api/projects/${encodeURIComponent(activeProjectId)}/comments/${encodeURIComponent(threadId)}/replies`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: activeDocPath,
          author,
          role: 'human',
          body
        })
      }
    );
    if (res.ok) {
      const { thread } = (await res.json()) as { thread: ResolvedCommentThread };
      setThreads((prev) => prev.map((t) => (t.id === thread.id ? thread : t)));
    }
  }

  async function handleChangeThreadStatus(
    threadId: string,
    status: 'open' | 'resolved',
    actor: string
  ) {
    if (!activeProjectId || !activeDocPath) return;
    const res = await fetch(
      `/api/projects/${encodeURIComponent(activeProjectId)}/comments/${encodeURIComponent(threadId)}/status`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: activeDocPath,
          status,
          actor,
          role: 'human'
        })
      }
    );
    if (res.ok) {
      const { thread } = (await res.json()) as { thread: ResolvedCommentThread };
      setThreads((prev) => prev.map((t) => (t.id === thread.id ? thread : t)));
      void refreshProjects();
    }
  }

  function handleSwitchEditorMode(nextMode: 'visual' | 'source') {
    if (nextMode === editorMode) return;
    if (nextMode === 'visual') {
      setInitialDocMarkdown(liveMarkdown);
      setDocSessionNonce((n) => n + 1);
    }
    setEditorMode(nextMode);
  }

  function handleInsertEmbed(desc: EmbedDescriptor) {
    if (editorMode === 'visual' && visualEditorRef.current) {
      visualEditorRef.current.insertEmbedBlock(desc);
    } else {
      const snippet = `\n\`\`\`embed\nsrc: ${desc.src}\ntitle: ${desc.title}\nheight: ${desc.height}\nprops: ${JSON.stringify(desc.props)}\n\`\`\`\n`;
      scheduleAutosave(`${liveMarkdown.trimEnd()}\n${snippet}`);
    }
  }

  const bridgeValue = useMemo(
    () => ({
      projectId: activeProjectId,
      embedReloadToken,
      onNavigateDoc: (docPath: string) => {
        if (activeProjectId) {
          void handleSelectDoc(activeProjectId, docPath);
        }
      }
    }),
    [activeProjectId, embedReloadToken]
  );

  return (
    <EditorBridgeContext.Provider value={bridgeValue}>
      <div className={`workbench ${reviewOpen ? '' : 'review-closed'}`}>
        <SidebarNav
          projects={projects}
          activeProject={activeProject}
          activeDocPath={activeDocPath}
          searchQuery={searchQuery}
          searchResults={searchResults}
          onChangeSearch={setSearchQuery}
          onSelectProject={(id) => void handleSelectProject(id)}
          onSelectDoc={(projId, docPath) => void handleSelectDoc(projId, docPath)}
          onCreateDoc={handleCreateDoc}
          onOpenEmbedModal={() => setEmbedModalOpen(true)}
        />

        <main className="document-stage">
          <header className="repo-topbar">
            <div className="repo-meta-group">
              {activeProject && (
                <>
                  <span className="code-chip" title="Explicit local repository working copy">
                    {activeProject.rootPath}
                  </span>
                  <span className="code-chip" title="Current Git branch">
                    branch: {activeProject.git.branch}
                  </span>
                  <button
                    type="button"
                    className={`git-status-btn ${activeProject.git.isClean ? '' : 'dirty'}`}
                    onClick={() => setGitModalOpen(true)}
                  >
                    {activeProject.git.isClean
                      ? 'Working tree clean'
                      : `${activeProject.git.changedFiles.length} uncommitted ${
                          activeProject.git.changedFiles.length === 1 ? 'file' : 'files'
                        }`}
                  </button>
                </>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {saveState === 'saved' && <span className="save-badge saved">Saved to disk</span>}
              {(saveState === 'dirty' || saveState === 'saving') && (
                <span className="save-badge saving">
                  {saveState === 'saving' ? 'Saving…' : 'Unsaved changes'}
                </span>
              )}
              {saveState === 'conflict' && conflictData && (
                <button
                  type="button"
                  className="save-badge conflict"
                  onClick={() => setConflictData({ ...conflictData })}
                >
                  Conflict — resolve versions
                </button>
              )}
              {saveState === 'error' && (
                <span className="save-badge conflict">Save error</span>
              )}

              <button
                type="button"
                className="btn btn-compact"
                onClick={() => void performSave(liveMdRef.current, false)}
                disabled={saveState === 'saved' || saveState === 'saving'}
              >
                Save now
              </button>

              <div className="mode-switch" role="group" aria-label="Editor view mode">
                <button
                  type="button"
                  className={editorMode === 'visual' ? 'active' : ''}
                  onClick={() => handleSwitchEditorMode('visual')}
                >
                  Visual
                </button>
                <button
                  type="button"
                  className={editorMode === 'source' ? 'active' : ''}
                  onClick={() => handleSwitchEditorMode('source')}
                >
                  Markdown source
                </button>
              </div>

              <button
                type="button"
                className="btn btn-compact"
                onClick={() => setReviewOpen((v) => !v)}
              >
                {reviewOpen ? 'Hide review' : `Review (${threads.filter((t) => t.status === 'open').length})`}
              </button>
            </div>
          </header>

          {statusNotice && (
            <div className="notice-banner">
              <span>{statusNotice}</span>
              <button
                type="button"
                className="btn btn-compact"
                onClick={() => setStatusNotice(null)}
              >
                Dismiss
              </button>
            </div>
          )}

          {editorMode === 'visual' && activeProjectId && activeDocPath ? (
            <VisualMarkdownEditor
              key={`${activeProjectId}:${activeDocPath}:${docSessionNonce}`}
              ref={visualEditorRef}
              docKey={`${activeProjectId}:${activeDocPath}:${docSessionNonce}`}
              initialMarkdown={initialDocMarkdown}
              threads={threads}
              activeThreadId={activeThreadId}
              showResolvedComments={showResolvedComments}
              onMarkdownEdited={scheduleAutosave}
              onSelectionAnchorChange={(anc) => setPendingAnchor(anc)}
              onStartCommentWithAnchor={(anc) => {
                const chosen = anc ?? pendingAnchor;
                setReviewOpen(true);
                if (chosen) {
                  setPendingAnchor(chosen);
                  setComposerOpen(true);
                } else {
                  setStatusNotice('Select a prose phrase in the document first to anchor a comment.');
                }
              }}
              onSelectThread={(tid) => {
                setActiveThreadId(tid);
                setReviewOpen(true);
              }}
              onOpenInsertEmbedModal={() => setEmbedModalOpen(true)}
              onNavigateDoc={(targetPath) => {
                if (activeProjectId) {
                  void handleSelectDoc(activeProjectId, targetPath);
                }
              }}
              onTriggerImmediateSave={() => void performSave(liveMdRef.current, false)}
            />
          ) : (
            <div className="sheet-scroll">
              <div style={{ maxWidth: '78ch', margin: '0 auto 10px auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12.5, color: 'var(--ink-secondary)' }}>
                  Authoritative Markdown file: <span className="code-chip">{activeDocPath}</span>
                </span>
                <button
                  type="button"
                  className="btn btn-compact"
                  onClick={() => setEmbedModalOpen(true)}
                >
                  Insert embed syntax
                </button>
              </div>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <textarea
                  className="markdown-source-editor"
                  aria-label="Markdown source editor"
                  value={liveMarkdown}
                  onChange={(e) => scheduleAutosave(e.target.value)}
                />
              </div>
            </div>
          )}
        </main>

        {reviewOpen && (
          <ReviewMargin
            threads={threads}
            pendingAnchor={pendingAnchor}
            composerOpen={composerOpen}
            activeThreadId={activeThreadId}
            showResolved={showResolvedComments}
            onToggleShowResolved={setShowResolvedComments}
            onSelectThread={setActiveThreadId}
            onCancelComposer={() => {
              setComposerOpen(false);
              setPendingAnchor(null);
            }}
            onCreateComment={handleCreateComment}
            onReplyComment={handleReplyComment}
            onChangeThreadStatus={handleChangeThreadStatus}
          />
        )}
      </div>

      {gitModalOpen && activeProject && (
        <GitDrawerModal
          project={activeProject}
          onClose={() => setGitModalOpen(false)}
          onCommitted={async () => {
            await refreshProjects();
          }}
        />
      )}

      {embedModalOpen && activeProject && (
        <InsertEmbedModal
          projectId={activeProject.id}
          existingEmbeds={activeProject.embeds}
          onInsertEmbed={handleInsertEmbed}
          onCreatedNewEmbedFile={async () => {
            await refreshProjects();
            setEmbedReloadToken((n) => n + 1);
          }}
          onClose={() => setEmbedModalOpen(false)}
        />
      )}

      {conflictData && (
        <ConflictModal
          conflict={conflictData}
          onAcceptDiskVersion={() => {
            baseRevisionRef.current = conflictData.diskRevision;
            lastSavedMdRef.current = conflictData.diskMarkdown;
            liveMdRef.current = conflictData.diskMarkdown;
            setInitialDocMarkdown(conflictData.diskMarkdown);
            setLiveMarkdown(conflictData.diskMarkdown);
            setDocSessionNonce((n) => n + 1);
            setConflictData(null);
            setSaveState('saved');
            setStatusNotice(
              `Loaded external disk version. Your previous draft remains saved at ${conflictData.savedConflictCopyPath}.`
            );
          }}
          onOverwriteWithMine={() => {
            void performSave(conflictData.yourMarkdown, true);
          }}
          onDismiss={() => setConflictData(null)}
        />
      )}
    </EditorBridgeContext.Provider>
  );
}
