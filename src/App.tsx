import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  GitBranch,
  MessageSquare,
  PanelLeft,
  Pencil,
  RotateCcw
} from 'lucide-react';
import type {
  CommentAnchor,
  ConflictErrorPayload,
  DocumentPayload,
  EmbedDescriptor,
  ProjectSummary,
  ResolvedCommentThread,
  SearchResultItem
} from '../shared/types';
import { EditorBridgeContext, type WorkspaceMode } from './editor/EmbedContext';
import {
  VisualMarkdownEditor,
  type VisualEditorHandle
} from './editor/VisualMarkdownEditor';
import { SidebarNav } from './components/SidebarNav';
import { MarkdownSourceWorkspace } from './components/MarkdownSourceWorkspace';
import { ReviewMargin } from './components/ReviewMargin';
import { GitDrawerModal } from './components/GitDrawerModal';
import { ConflictModal } from './components/ConflictModal';
import { InsertEmbedModal } from './components/InsertEmbedModal';
import { SettingsModal, type SettingsSection } from './components/SettingsModal';
import { ImportRepoModal } from './components/ImportRepoModal';
import { useOverlayScrollLock } from './utils/overlayModal';
import {
  DEFAULT_READING_PREFERENCES,
  getPageWidthSpec,
  getTextSizeSpec,
  loadReadingPreferences,
  saveReadingPreferences,
  type PageWidthPreset,
  type ReadingPreferences,
  type TextSizePreset
} from './utils/readingPreferences';
import {
  DEFAULT_WORKSPACE_SETTINGS,
  applyThemeMode,
  loadWorkspaceSettings,
  saveWorkspaceSettings,
  type WorkspaceSettings
} from './utils/workspaceSettings';

export type LayoutTier = 'overlay' | 'medium-desktop' | 'wide-desktop';

type SaveStateKind = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';
type SaveOutcome = 'saved' | 'superseded' | 'conflict' | 'error';

interface EditSessionBaseline {
  projectId: string;
  docPath: string;
  markdown: string;
}

interface UndoRevertSnapshot {
  projectId: string;
  docPath: string;
  baselineMarkdown: string;
  revertedDraftMarkdown: string;
}

const OVERLAY_MEDIA_QUERY = '(max-width: 1024px), (max-height: 540px)';
const WIDE_DESKTOP_MEDIA_QUERY = '(min-width: 1320px) and (min-height: 541px)';

function readInitialModeFromUrl(): WorkspaceMode {
  if (typeof window === 'undefined') return 'read';
  const raw = new URLSearchParams(window.location.search).get('mode');
  if (raw === 'visual' || raw === 'source' || raw === 'read') {
    return raw;
  }
  return 'read';
}

function detectLayoutTier(): LayoutTier {
  if (typeof window === 'undefined') return 'wide-desktop';
  if (window.matchMedia(OVERLAY_MEDIA_QUERY).matches) {
    return 'overlay';
  }
  if (window.matchMedia(WIDE_DESKTOP_MEDIA_QUERY).matches) {
    return 'wide-desktop';
  }
  return 'medium-desktop';
}

export function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>('');
  const [activeDocPath, setActiveDocPath] = useState<string>('');
  const [docSessionNonce, setDocSessionNonce] = useState<number>(0);

  const [initialDocMarkdown, setInitialDocMarkdown] = useState<string>('');
  const [liveMarkdown, setLiveMarkdown] = useState<string>('');
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(readInitialModeFromUrl);
  const [saveState, setSaveState] = useState<SaveStateKind>('saved');
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [editSessionBaseline, setEditSessionBaseline] = useState<EditSessionBaseline | null>(null);
  const [sessionActionPending, setSessionActionPending] = useState<'done' | 'revert' | null>(null);
  const [undoRevertSnapshot, setUndoRevertSnapshot] = useState<UndoRevertSnapshot | null>(null);

  const [threads, setThreads] = useState<ResolvedCommentThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [showResolvedComments, setShowResolvedComments] = useState<boolean>(false);
  const [pendingAnchor, setPendingAnchor] = useState<CommentAnchor | null>(null);
  const [composerOpen, setComposerOpen] = useState<boolean>(false);

  const [workspaceSettings, setWorkspaceSettings] = useState<WorkspaceSettings>(
    loadWorkspaceSettings
  );
  // Lifted review draft & author state so dismissing/rotating drawers never discards drafts
  const [authorName, setAuthorName] = useState<string>(
    () => loadWorkspaceSettings().reviewerName
  );
  const [commentDraft, setCommentDraft] = useState<string>('');
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [expandedHistory, setExpandedHistory] = useState<Record<string, boolean>>({});

  const [layoutTier, setLayoutTier] = useState<LayoutTier>(detectLayoutTier);
  const [desktopNavOpen, setDesktopNavOpen] = useState<boolean>(true);
  const [desktopReviewOpen, setDesktopReviewOpen] = useState<boolean>(() => {
    const initialTier = detectLayoutTier();
    return initialTier === 'wide-desktop' && readInitialModeFromUrl() !== 'source';
  });
  const [overlayDrawer, setOverlayDrawer] = useState<'nav' | 'review' | null>(null);

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);

  const [embedReloadToken, setEmbedReloadToken] = useState<number>(0);
  const [gitModalOpen, setGitModalOpen] = useState<boolean>(false);
  const [embedModalOpen, setEmbedModalOpen] = useState<boolean>(false);
  const [importModalOpen, setImportModalOpen] = useState<boolean>(false);
  const [initialLoaded, setInitialLoaded] = useState<boolean>(false);
  const [readingSettingsOpen, setReadingSettingsOpen] = useState<boolean>(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('reading');
  const [settingsCredHost, setSettingsCredHost] = useState<string>('');
  const [readingPreferences, setReadingPreferences] = useState<ReadingPreferences>(
    loadReadingPreferences
  );
  const [conflictData, setConflictData] = useState<ConflictErrorPayload | null>(null);

  const visualEditorRef = useRef<VisualEditorHandle | null>(null);
  const mainStageRef = useRef<HTMLElement | null>(null);
  const navTriggerRef = useRef<HTMLButtonElement | null>(null);
  const reviewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const importTriggerRef = useRef<HTMLButtonElement | null>(null);

  const baseRevisionRef = useRef<string>('');
  const lastSavedMdRef = useRef<string>('');
  const liveMdRef = useRef<string>('');
  const activeProjectIdRef = useRef<string>('');
  const activeDocPathRef = useRef<string>('');
  const workspaceModeRef = useRef<WorkspaceMode>(workspaceMode);
  const saveStateRef = useRef<SaveStateKind>(saveState);
  const editSessionBaselineRef = useRef<EditSessionBaseline | null>(null);
  const lastConflictPayloadRef = useRef<ConflictErrorPayload | null>(null);
  const composerOpenRef = useRef<boolean>(false);
  const commentDraftRef = useRef<string>('');
  const reviewOpenBeforeSourceRef = useRef<boolean>(true);
  const saveTimerRef = useRef<number | null>(null);
  const saveEpochRef = useRef<number>(0);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());

  activeProjectIdRef.current = activeProjectId;
  activeDocPathRef.current = activeDocPath;
  liveMdRef.current = liveMarkdown;
  workspaceModeRef.current = workspaceMode;
  saveStateRef.current = saveState;
  editSessionBaselineRef.current = editSessionBaseline;
  composerOpenRef.current = composerOpen;
  commentDraftRef.current = commentDraft;

  const isOverlayLayout = layoutTier === 'overlay';
  const effectiveNavVisible = isOverlayLayout ? overlayDrawer === 'nav' : desktopNavOpen;
  const effectiveReviewVisible = isOverlayLayout ? overlayDrawer === 'review' : desktopReviewOpen;
  const isOverlayModalOpen = isOverlayLayout && overlayDrawer !== null;
  const anyDialogOpen =
    readingSettingsOpen ||
    gitModalOpen ||
    embedModalOpen ||
    importModalOpen ||
    Boolean(conflictData);
  const lockDocumentScroll = isOverlayModalOpen || readingSettingsOpen;
  const stageInert = isOverlayModalOpen || anyDialogOpen;

  useOverlayScrollLock(lockDocumentScroll);

  useEffect(() => {
    applyThemeMode(workspaceSettings.themeMode);
  }, [workspaceSettings.themeMode]);

  // Set native HTML inert attribute on <main> while an overlay drawer or modal dialog is open
  useEffect(() => {
    const stageEl = mainStageRef.current;
    if (!stageEl) return;
    if (stageInert) {
      stageEl.setAttribute('inert', '');
    } else {
      stageEl.removeAttribute('inert');
    }
  }, [stageInert]);

  function updateReadingPreferences(updater: (prev: ReadingPreferences) => ReadingPreferences) {
    setReadingPreferences((prev) => {
      const next = updater(prev);
      saveReadingPreferences(next);
      return next;
    });
  }

  function updateWorkspaceSettings(updater: (prev: WorkspaceSettings) => WorkspaceSettings) {
    setWorkspaceSettings((prev) => {
      const next = updater(prev);
      saveWorkspaceSettings(next);
      if (next.reviewerName !== prev.reviewerName) {
        setAuthorName(next.reviewerName);
      }
      return next;
    });
  }

  function handleChangeReviewAuthorName(nextAuthor: string) {
    setAuthorName(nextAuthor);
    updateWorkspaceSettings((prev) => ({
      ...prev,
      reviewerName: nextAuthor.trim() || DEFAULT_WORKSPACE_SETTINGS.reviewerName
    }));
  }

  function handleResetWorkspaceDefaults() {
    updateWorkspaceSettings(() => ({ ...DEFAULT_WORKSPACE_SETTINGS }));
  }

  function handleChangeTextSize(textSize: TextSizePreset) {
    updateReadingPreferences((prev) => ({ ...prev, textSize }));
  }

  function handleChangePageWidth(pageWidth: PageWidthPreset) {
    updateReadingPreferences((prev) => ({ ...prev, pageWidth }));
  }

  function handleResetReadingPreferences() {
    updateReadingPreferences(() => ({ ...DEFAULT_READING_PREFERENCES }));
  }

  function handleOpenReadingSettings(section: SettingsSection = 'reading', credHost = '') {
    if (isOverlayLayout) {
      setOverlayDrawer(null);
    }
    setSettingsSection(section);
    setSettingsCredHost(credHost);
    setReadingSettingsOpen(true);
  }

  // Track responsive layout tiers + visualViewport height + prevent horizontal page pan
  useEffect(() => {
    const syncViewportMetrics = () => {
      const vv = window.visualViewport;
      const heightPx = Math.round(vv ? vv.height : window.innerHeight);
      document.documentElement.style.setProperty('--vvh', `${heightPx}px`);
      if (window.scrollX !== 0 && !document.body.dataset.overlayLocked) {
        window.scrollTo(0, window.scrollY);
      }

      const nextTier = detectLayoutTier();
      setLayoutTier((prevTier) => {
        if (prevTier !== nextTier) {
          if (nextTier !== 'overlay') {
            setOverlayDrawer(null);
          }
          if (nextTier === 'medium-desktop') {
            // Avoid dual-sidebar squeeze on medium widths
            setDesktopReviewOpen((revOpen) => {
              if (revOpen && (composerOpenRef.current || commentDraftRef.current.trim())) {
                setDesktopNavOpen(false);
                return true;
              }
              return false;
            });
          }
        }
        return nextTier;
      });
    };

    syncViewportMetrics();

    const overlayMq = window.matchMedia(OVERLAY_MEDIA_QUERY);
    const wideMq = window.matchMedia(WIDE_DESKTOP_MEDIA_QUERY);
    overlayMq.addEventListener('change', syncViewportMetrics);
    wideMq.addEventListener('change', syncViewportMetrics);
    window.addEventListener('resize', syncViewportMetrics, { passive: true });
    window.addEventListener('orientationchange', syncViewportMetrics, { passive: true });
    window.visualViewport?.addEventListener('resize', syncViewportMetrics, { passive: true });

    return () => {
      overlayMq.removeEventListener('change', syncViewportMetrics);
      wideMq.removeEventListener('change', syncViewportMetrics);
      window.removeEventListener('resize', syncViewportMetrics);
      window.removeEventListener('orientationchange', syncViewportMetrics);
      window.visualViewport?.removeEventListener('resize', syncViewportMetrics);
    };
  }, []);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  );

  const openThreadCount = useMemo(
    () => threads.filter((t) => t.status === 'open').length,
    [threads]
  );

  const refreshProjects = useCallback(async (): Promise<ProjectSummary[]> => {
    const res = await fetch('/api/projects');
    if (!res.ok) throw new Error('Unable to load projects');
    const data = (await res.json()) as { projects: ProjectSummary[] };
    setProjects(data.projects);
    return data.projects;
  }, []);

  const syncUrlParams = useCallback((projectId: string, docPath: string, mode: WorkspaceMode) => {
    const url = new URL(window.location.href);
    url.searchParams.set('project', projectId);
    url.searchParams.set('doc', docPath);
    if (mode === 'read') {
      url.searchParams.delete('mode');
    } else {
      url.searchParams.set('mode', mode);
    }
    window.history.replaceState({}, '', url.toString());
  }, []);

  const loadDocument = useCallback(
    async (projectId: string, docPath: string) => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      saveEpochRef.current += 1;

      const isDifferentDoc =
        projectId !== activeProjectIdRef.current || docPath !== activeDocPathRef.current;

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
      lastConflictPayloadRef.current = null;

      setActiveProjectId(projectId);
      setActiveDocPath(payload.path);
      setInitialDocMarkdown(payload.markdown);
      setLiveMarkdown(payload.markdown);
      setThreads(payload.comments);
      setSaveState('saved');
      setConflictData(null);
      if (workspaceModeRef.current !== 'read') {
        const nextBaseline: EditSessionBaseline = {
          projectId,
          docPath: payload.path,
          markdown: payload.markdown
        };
        editSessionBaselineRef.current = nextBaseline;
        setEditSessionBaseline(nextBaseline);
      } else {
        editSessionBaselineRef.current = null;
        setEditSessionBaseline(null);
      }
      if (isDifferentDoc) {
        setUndoRevertSnapshot(null);
        setPendingAnchor(null);
        setComposerOpen(false);
        setCommentDraft('');
        setReplyDrafts({});
        setExpandedHistory({});
        setActiveThreadId(null);
      }
      setDocSessionNonce((n) => n + 1);

      const modeForUrl = workspaceModeRef.current;
      syncUrlParams(projectId, payload.path, modeForUrl);

      if (isDifferentDoc && typeof window !== 'undefined' && !document.body.dataset.overlayLocked) {
        window.scrollTo(0, 0);
      }
    },
    [syncUrlParams]
  );

  // Initial load from URL params or default project
  useEffect(() => {
    let cancelled = false;
    async function boot() {
      try {
        const list = await refreshProjects();
        if (cancelled) return;
        if (list.length === 0) {
          setActiveProjectId('');
          setActiveDocPath('');
          return;
        }

        const params = new URLSearchParams(window.location.search);
        const urlProject = params.get('project');
        const urlDoc = params.get('doc');

        const chosenProj = list.find((p) => p.id === urlProject) ?? list[0];
        const chosenDoc =
          urlDoc && chosenProj.docs.some((d) => d.path === urlDoc)
            ? urlDoc
            : chosenProj.docs.some((d) => d.path === chosenProj.defaultDoc)
              ? chosenProj.defaultDoc
              : chosenProj.docs[0]?.path || '';

        if (chosenDoc) {
          await loadDocument(chosenProj.id, chosenDoc);
        } else {
          setActiveProjectId(chosenProj.id);
          setActiveDocPath('');
        }
      } finally {
        if (!cancelled) {
          setInitialLoaded(true);
        }
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, [loadDocument, refreshProjects]);

  const performSave = useCallback(
    (
      markdownToSave: string,
      forceOverwrite = false,
      options?: { expectedEpoch?: number; alwaysVerifyDisk?: boolean }
    ): Promise<SaveOutcome> => {
      const expectedEpoch = options?.expectedEpoch;
      const alwaysVerifyDisk = Boolean(options?.alwaysVerifyDisk);

      const runTask = async (): Promise<SaveOutcome> => {
        if (typeof expectedEpoch === 'number' && expectedEpoch !== saveEpochRef.current) {
          return 'superseded';
        }

        const projId = activeProjectIdRef.current;
        const docPath = activeDocPathRef.current;
        if (!projId || !docPath) return 'error';

        if (
          !forceOverwrite &&
          !alwaysVerifyDisk &&
          saveStateRef.current !== 'error' &&
          saveStateRef.current !== 'conflict' &&
          markdownToSave === lastSavedMdRef.current
        ) {
          setSaveState('saved');
          return 'saved';
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
            lastConflictPayloadRef.current = conflictPayload;
            saveStateRef.current = 'conflict';
            setSaveState('conflict');
            setConflictData(conflictPayload);
            return 'conflict';
          }

          if (!res.ok) {
            saveStateRef.current = 'error';
            setSaveState('error');
            setStatusNotice(`Save failed (${res.status}). Your edits remain in the editor.`);
            return 'error';
          }

          const saved = (await res.json()) as {
            revision: string;
            comments: ResolvedCommentThread[];
          };
          baseRevisionRef.current = saved.revision;
          lastSavedMdRef.current = markdownToSave;
          lastConflictPayloadRef.current = null;
          setThreads(saved.comments);
          setConflictData(null);

          if (typeof expectedEpoch !== 'number' || expectedEpoch === saveEpochRef.current) {
            const nextState: SaveStateKind =
              liveMdRef.current === markdownToSave ? 'saved' : 'dirty';
            saveStateRef.current = nextState;
            setSaveState(nextState);
          }
          void refreshProjects();
          return 'saved';
        } catch {
          saveStateRef.current = 'error';
          setSaveState('error');
          setStatusNotice('Network error while saving draft. Your edits remain in the editor.');
          return 'error';
        }
      };

      const queued = saveChainRef.current.then(runTask, runTask);
      saveChainRef.current = queued.then(
        () => undefined,
        () => undefined
      );
      return queued;
    },
    [refreshProjects]
  );

  const scheduleAutosave = useCallback(
    (nextMarkdown: string) => {
      setLiveMarkdown(nextMarkdown);
      liveMdRef.current = nextMarkdown;
      setUndoRevertSnapshot(null);

      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      const epoch = ++saveEpochRef.current;

      if (saveStateRef.current === 'conflict') {
        return;
      }

      if (nextMarkdown === lastSavedMdRef.current && saveStateRef.current !== 'error') {
        saveStateRef.current = 'saved';
        setSaveState('saved');
        return;
      }

      saveStateRef.current = 'dirty';
      setSaveState('dirty');
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void performSave(liveMdRef.current, false, { expectedEpoch: epoch });
      }, 600);
    },
    [performSave]
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
        if (msg.type === 'projects:updated') {
          void refreshProjects();
          return;
        }
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
            if (
              diskDoc.revision === baseRevisionRef.current ||
              diskDoc.markdown === liveMdRef.current
            ) {
              baseRevisionRef.current = diskDoc.revision;
              return;
            }

            const hasLocalUnsaved = liveMdRef.current !== lastSavedMdRef.current;
            const hasActiveSessionChanges =
              workspaceModeRef.current !== 'read' &&
              Boolean(editSessionBaselineRef.current) &&
              liveMdRef.current !== editSessionBaselineRef.current!.markdown;

            if (!hasLocalUnsaved && !hasActiveSessionChanges) {
              baseRevisionRef.current = diskDoc.revision;
              lastSavedMdRef.current = diskDoc.markdown;
              liveMdRef.current = diskDoc.markdown;
              if (workspaceModeRef.current !== 'read') {
                const syncedBaseline: EditSessionBaseline = {
                  projectId: activeProjectIdRef.current,
                  docPath: diskDoc.path,
                  markdown: diskDoc.markdown
                };
                editSessionBaselineRef.current = syncedBaseline;
                setEditSessionBaseline(syncedBaseline);
              }
              setLiveMarkdown(diskDoc.markdown);
              setInitialDocMarkdown(diskDoc.markdown);
              setThreads(diskDoc.comments);
              visualEditorRef.current?.replaceMarkdownFromExternal(diskDoc.markdown);
              setStatusNotice(`Updated ${diskDoc.path} from external file edit.`);
            } else {
              setStatusNotice(
                `External edit detected on ${diskDoc.path}. Saving or reverting will compare both versions without overwriting.`
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

  async function openProjectSummary(proj: ProjectSummary, preferredDoc?: string) {
    const targetDoc =
      preferredDoc && proj.docs.some((d) => d.path === preferredDoc)
        ? preferredDoc
        : proj.docs.some((d) => d.path === proj.defaultDoc)
          ? proj.defaultDoc
          : proj.docs[0]?.path || '';

    if (targetDoc) {
      await loadDocument(proj.id, targetDoc);
    } else {
      setActiveProjectId(proj.id);
      setActiveDocPath('');
      setInitialDocMarkdown('');
      setLiveMarkdown('');
      setThreads([]);
      setEditSessionBaseline(null);
      editSessionBaselineRef.current = null;
      setWorkspaceMode('read');
      workspaceModeRef.current = 'read';
      syncUrlParams(proj.id, '', 'read');
    }
  }

  async function handleOpenGitModal() {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      await performSave(liveMdRef.current, false);
    }
    setGitModalOpen(true);
  }

  async function handleSelectProject(nextProjectId: string) {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      await performSave(liveMdRef.current, false);
    }
    const proj = projects.find((p) => p.id === nextProjectId);
    if (!proj) return;
    await openProjectSummary(proj);
  }

  async function handleRepoImported(imported: ProjectSummary) {
    const list = await refreshProjects();
    const fresh = list.find((p) => p.id === imported.id) ?? imported;
    await openProjectSummary(fresh);
    setStatusNotice(`Connected repository "${fresh.name}" on branch ${fresh.git.branch}.`);
  }

  async function handleRepoRemoved(removedId: string) {
    const list = await refreshProjects();
    if (activeProjectId === removedId) {
      if (list.length > 0) {
        await openProjectSummary(list[0]);
      } else {
        setActiveProjectId('');
        setActiveDocPath('');
        setInitialDocMarkdown('');
        setLiveMarkdown('');
        setThreads([]);
      }
    }
    setStatusNotice(`Removed repository "${removedId}" from Focus (files kept on disk).`);
  }

  async function handleRepoUpdated(updated: ProjectSummary) {
    await refreshProjects();
    setStatusNotice(`Updated repository "${updated.name}" (default page: ${updated.defaultDoc}).`);
  }

  async function handleRepoSynced(notice: string) {
    const list = await refreshProjects();
    const current = list.find((p) => p.id === activeProjectIdRef.current);
    if (current) {
      await openProjectSummary(current, activeDocPathRef.current);
      setEmbedReloadToken((n) => n + 1);
    }
    setStatusNotice(notice);
  }

  async function handleSelectDoc(projectId: string, docPath: string) {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      await performSave(liveMdRef.current, false);
    }
    if (isOverlayLayout) {
      setOverlayDrawer(null);
    }
    await loadDocument(projectId, docPath);
    window.requestAnimationFrame(() => {
      window.scrollTo(0, 0);
    });
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
    handleSwitchWorkspaceMode('visual');
  }

  async function handleCreateComment(author: string, body: string) {
    if (!activeProjectId || !activeDocPath || !pendingAnchor) return;
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
      setCommentDraft('');
      window.getSelection()?.removeAllRanges();
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
      setReplyDrafts((prev) => ({ ...prev, [threadId]: '' }));
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
      if (status === 'resolved' && !showResolvedComments && activeThreadId === threadId) {
        setActiveThreadId(null);
      }
      void refreshProjects();
    }
  }

  function handleSwitchWorkspaceMode(nextMode: WorkspaceMode) {
    if (nextMode === workspaceMode) return;
    const enteringEditing = workspaceMode === 'read' && nextMode !== 'read';
    const leavingEditing = workspaceMode !== 'read' && nextMode === 'read';
    const leavingSource = workspaceMode === 'source' && nextMode !== 'source';
    const enteringSource = workspaceMode !== 'source' && nextMode === 'source';

    if (enteringEditing && activeProjectId && activeDocPath) {
      const snapshot: EditSessionBaseline = {
        projectId: activeProjectId,
        docPath: activeDocPath,
        markdown: liveMdRef.current
      };
      editSessionBaselineRef.current = snapshot;
      setEditSessionBaseline(snapshot);
      setUndoRevertSnapshot(null);
    } else if (leavingEditing) {
      editSessionBaselineRef.current = null;
      setEditSessionBaseline(null);
    }

    if (leavingSource) {
      setInitialDocMarkdown(liveMdRef.current);
      setDocSessionNonce((n) => n + 1);
      if (!isOverlayLayout) {
        setDesktopReviewOpen(
          layoutTier === 'medium-desktop' && desktopNavOpen
            ? false
            : reviewOpenBeforeSourceRef.current
        );
      }
    } else if (enteringSource) {
      reviewOpenBeforeSourceRef.current = desktopReviewOpen;
      setDesktopReviewOpen(false);
      if (overlayDrawer === 'review') {
        setOverlayDrawer(null);
      }
    }

    workspaceModeRef.current = nextMode;
    setWorkspaceMode(nextMode);
    if (activeProjectId && activeDocPath) {
      syncUrlParams(activeProjectId, activeDocPath, nextMode);
    }
  }

  async function handleFinishEditing() {
    if (sessionActionPending) return;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    if (saveStateRef.current === 'conflict') {
      if (lastConflictPayloadRef.current) {
        setConflictData({ ...lastConflictPayloadRef.current });
      }
      setStatusNotice('Resolve the external file conflict before leaving Edit mode.');
      return;
    }

    setSessionActionPending('done');
    try {
      const needsSaveOrRetry =
        liveMdRef.current !== lastSavedMdRef.current ||
        saveStateRef.current === 'error' ||
        saveStateRef.current === 'saving';

      if (needsSaveOrRetry) {
        const outcome = await performSave(liveMdRef.current, false, {
          expectedEpoch: saveEpochRef.current,
          alwaysVerifyDisk: saveStateRef.current === 'error'
        });
        if (outcome !== 'saved') {
          return;
        }
      } else {
        // Wait for any already-queued save chain task before exiting
        await saveChainRef.current;
        const latestSaveState = saveStateRef.current as SaveStateKind;
        if (latestSaveState === 'conflict' || latestSaveState === 'error') {
          return;
        }
      }

      handleSwitchWorkspaceMode('read');
    } finally {
      setSessionActionPending(null);
    }
  }

  async function handleRevertEditSession() {
    const baseline = editSessionBaselineRef.current;
    if (!baseline || sessionActionPending) return;
    if (liveMdRef.current === baseline.markdown && saveStateRef.current === 'saved') {
      return;
    }

    const revertedDraft = liveMdRef.current;

    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const revertEpoch = ++saveEpochRef.current;

    setSessionActionPending('revert');
    try {
      const outcome = await performSave(baseline.markdown, false, {
        expectedEpoch: revertEpoch,
        alwaysVerifyDisk: true
      });
      if (outcome !== 'saved') {
        return;
      }

      liveMdRef.current = baseline.markdown;
      setLiveMarkdown(baseline.markdown);
      setInitialDocMarkdown(baseline.markdown);
      setDocSessionNonce((n) => n + 1);
      setUndoRevertSnapshot({
        projectId: baseline.projectId,
        docPath: baseline.docPath,
        baselineMarkdown: baseline.markdown,
        revertedDraftMarkdown: revertedDraft
      });
      setStatusNotice('Reverted edits from this editing session.');
      handleSwitchWorkspaceMode('read');
    } finally {
      setSessionActionPending(null);
    }
  }

  function handleUndoRevert() {
    if (
      !undoRevertSnapshot ||
      undoRevertSnapshot.projectId !== activeProjectId ||
      undoRevertSnapshot.docPath !== activeDocPath
    ) {
      return;
    }
    const restoredBaseline: EditSessionBaseline = {
      projectId: undoRevertSnapshot.projectId,
      docPath: undoRevertSnapshot.docPath,
      markdown: undoRevertSnapshot.baselineMarkdown
    };
    editSessionBaselineRef.current = restoredBaseline;
    setEditSessionBaseline(restoredBaseline);
    setInitialDocMarkdown(undoRevertSnapshot.revertedDraftMarkdown);
    setLiveMarkdown(undoRevertSnapshot.revertedDraftMarkdown);
    liveMdRef.current = undoRevertSnapshot.revertedDraftMarkdown;
    setDocSessionNonce((n) => n + 1);
    setUndoRevertSnapshot(null);
    setStatusNotice(null);
    workspaceModeRef.current = 'visual';
    setWorkspaceMode('visual');
    syncUrlParams(activeProjectId, activeDocPath, 'visual');
    scheduleAutosave(undoRevertSnapshot.revertedDraftMarkdown);
  }

  function handleLocateThreadInRead(threadId: string) {
    if (workspaceMode === 'source') {
      setInitialDocMarkdown(liveMarkdown);
      setDocSessionNonce((n) => n + 1);
      setWorkspaceMode('read');
      if (activeProjectId && activeDocPath) {
        syncUrlParams(activeProjectId, activeDocPath, 'read');
      }
    }
    setActiveThreadId(threadId);
    if (isOverlayLayout) {
      // Return directly to the document in overlay mode and scroll to the anchored prose
      setOverlayDrawer(null);
    } else {
      setDesktopReviewOpen(true);
      if (layoutTier === 'medium-desktop') {
        setDesktopNavOpen(false);
      }
    }
    window.setTimeout(() => {
      visualEditorRef.current?.scrollToThreadAnchor(threadId);
    }, 80);
  }

  function handleInsertEmbed(desc: EmbedDescriptor) {
    if (workspaceMode === 'read') {
      handleSwitchWorkspaceMode('visual');
      window.setTimeout(() => {
        visualEditorRef.current?.insertEmbedBlock(desc);
      }, 60);
      return;
    }
    if (workspaceMode === 'visual' && visualEditorRef.current) {
      visualEditorRef.current.insertEmbedBlock(desc);
    } else {
      const snippet = `\n\`\`\`embed\nsrc: ${desc.src}\ntitle: ${desc.title}\nheight: ${desc.height}\nprops: ${JSON.stringify(desc.props)}\n\`\`\`\n`;
      scheduleAutosave(`${liveMarkdown.trimEnd()}\n${snippet}`);
    }
  }

  function toggleNavPanel() {
    if (isOverlayLayout) {
      setOverlayDrawer((prev) => (prev === 'nav' ? null : 'nav'));
    } else {
      setDesktopNavOpen((prev) => {
        const next = !prev;
        if (next && layoutTier === 'medium-desktop') {
          setDesktopReviewOpen(false);
        }
        return next;
      });
    }
  }

  function closeNavPanel() {
    if (isOverlayLayout) {
      setOverlayDrawer((prev) => (prev === 'nav' ? null : prev));
    } else {
      setDesktopNavOpen(false);
    }
  }

  function openReviewPanel() {
    if (isOverlayLayout) {
      setOverlayDrawer('review');
    } else {
      setDesktopReviewOpen(true);
      if (layoutTier === 'medium-desktop') {
        setDesktopNavOpen(false);
      }
    }
  }

  function toggleReviewPanel() {
    if (isOverlayLayout) {
      setOverlayDrawer((prev) => (prev === 'review' ? null : 'review'));
    } else {
      setDesktopReviewOpen((prev) => {
        const next = !prev;
        if (next && layoutTier === 'medium-desktop') {
          setDesktopNavOpen(false);
        }
        return next;
      });
    }
  }

  function closeReviewPanel() {
    if (isOverlayLayout) {
      setOverlayDrawer((prev) => (prev === 'review' ? null : prev));
    } else {
      setDesktopReviewOpen(false);
    }
  }

  const isEditing = workspaceMode !== 'read';

  const bridgeValue = useMemo(
    () => ({
      projectId: activeProjectId,
      embedReloadToken,
      workspaceMode,
      isEditing,
      onNavigateDoc: (docPath: string) => {
        if (activeProjectId) {
          void handleSelectDoc(activeProjectId, docPath);
        }
      }
    }),
    [activeProjectId, embedReloadToken, workspaceMode, isEditing]
  );

  const workbenchClasses = [
    'workbench',
    isOverlayLayout ? 'is-overlay-layout' : 'is-desktop-layout',
    !isOverlayLayout ? (effectiveNavVisible ? 'nav-open' : 'nav-closed') : 'nav-closed',
    !isOverlayLayout ? (effectiveReviewVisible ? 'review-open' : 'review-closed') : 'review-closed'
  ]
    .filter(Boolean)
    .join(' ');

  const hasSessionChanges = Boolean(
    isEditing &&
      editSessionBaseline &&
      editSessionBaseline.projectId === activeProjectId &&
      editSessionBaseline.docPath === activeDocPath &&
      liveMarkdown !== editSessionBaseline.markdown
  );
  const sessionBusy = sessionActionPending !== null;

  const textSizeSpec = getTextSizeSpec(readingPreferences.textSize);
  const pageWidthSpec = getPageWidthSpec(readingPreferences.pageWidth);
  const workbenchStyle = {
    '--focus-prose-size': textSizeSpec.cssFontSize,
    '--focus-prose-line-height': textSizeSpec.cssLineHeight,
    '--focus-prose-max-width': pageWidthSpec.cssMaxWidth,
    '--focus-review-prose-size': textSizeSpec.cssReviewSize
  } as React.CSSProperties;

  return (
    <EditorBridgeContext.Provider value={bridgeValue}>
      <div
        className={workbenchClasses}
        style={workbenchStyle}
        data-workspace-mode={workspaceMode}
        data-save-state={saveState}
        data-layout-tier={layoutTier}
        data-text-size={readingPreferences.textSize}
        data-page-width={readingPreferences.pageWidth}
      >
        {isOverlayModalOpen && (
          <div
            className="drawer-backdrop"
            aria-hidden="true"
            onClick={() => setOverlayDrawer(null)}
          />
        )}

        {effectiveNavVisible && (
          <SidebarNav
            projects={projects}
            activeProject={activeProject}
            activeDocPath={activeDocPath}
            isEditing={isEditing}
            isOverlay={isOverlayLayout}
            restoreFocusRef={navTriggerRef}
            settingsTriggerRef={settingsTriggerRef}
            importTriggerRef={importTriggerRef}
            searchQuery={searchQuery}
            searchResults={searchResults}
            onChangeSearch={setSearchQuery}
            onSelectProject={(id) => void handleSelectProject(id)}
            onSelectDoc={(projId, docPath) => void handleSelectDoc(projId, docPath)}
            onCreateDoc={handleCreateDoc}
            onOpenEmbedModal={() => setEmbedModalOpen(true)}
            onOpenReadingSettings={() => handleOpenReadingSettings('reading')}
            onOpenImportRepoModal={() => setImportModalOpen(true)}
            onClose={closeNavPanel}
          />
        )}

        <main
          ref={mainStageRef}
          className="document-stage"
          aria-hidden={stageInert ? 'true' : undefined}
        >
          <header className={`repo-topbar ${isEditing ? 'is-editing-bar' : 'is-reading-bar'}`}>
            <div className="repo-meta-group">
              {(isOverlayLayout || !effectiveNavVisible) && (
                <button
                  ref={navTriggerRef}
                  type="button"
                  className={`btn btn-compact nav-toggle-btn mobile-nav-btn ${effectiveNavVisible ? 'is-active-btn' : ''}`}
                  onClick={toggleNavPanel}
                  aria-expanded={effectiveNavVisible}
                  aria-controls="focus-nav-panel"
                  aria-label={effectiveNavVisible ? 'Close navigation' : 'Open navigation'}
                  title={effectiveNavVisible ? 'Hide pages navigation' : 'Open pages navigation'}
                >
                  <PanelLeft size={15} aria-hidden="true" />
                  <span className="nav-btn-label">Docs</span>
                </button>
              )}

              {activeProject && (
                <>
                  {(isOverlayLayout || !effectiveNavVisible) && (
                    <span
                      className="topbar-project-name"
                      title={`${activeProject.name} — ${activeDocPath}`}
                    >
                      {activeProject.name}
                    </span>
                  )}

                  <button
                    type="button"
                    className={`git-status-btn ${activeProject.git.isClean ? 'is-clean' : 'dirty'}`}
                    onClick={() => void handleOpenGitModal()}
                    aria-label={`Repository ${activeProject.name} on branch ${activeProject.git.branch}, ${
                      activeProject.git.isClean
                        ? 'working tree clean'
                        : `${activeProject.git.changedFiles.length} uncommitted ${
                            activeProject.git.changedFiles.length === 1 ? 'file' : 'files'
                          }`
                    }. Open Git branches, PRs, pull, and change review.`}
                    title={`Checkout: ${activeProject.rootPath} (${activeProject.git.branch}) — Branches, PRs, Pull & Diff`}
                  >
                    <GitBranch size={12} aria-hidden="true" />
                    <span className="git-branch-name">{activeProject.git.branch}</span>
                    {!activeProject.git.isClean ? (
                      <>
                        <span className="git-dirty-count">
                          {activeProject.git.changedFiles.length}
                        </span>
                        <span className="git-status-word">uncommitted</span>
                      </>
                    ) : (
                      <span className="git-status-word">clean</span>
                    )}
                    {(activeProject.git.behind ?? 0) > 0 && (
                      <span className="git-behind-pill" title={`${activeProject.git.behind} commit(s) behind remote`}>
                        ↓{activeProject.git.behind}
                      </span>
                    )}
                  </button>
                </>
              )}
            </div>

            <div className="topbar-actions">
              {isEditing && saveState === 'saved' && (
                <span
                  className="save-badge saved"
                  title="Working file saved on disk (uncommitted until explicit Git commit)"
                >
                  Saved
                </span>
              )}
              {(saveState === 'dirty' || saveState === 'saving') && (
                <span className="save-badge saving">
                  {saveState === 'saving' ? 'Saving…' : 'Unsaved'}
                </span>
              )}
              {saveState === 'conflict' && (conflictData || lastConflictPayloadRef.current) && (
                <button
                  type="button"
                  className="save-badge conflict"
                  onClick={() => {
                    const c = conflictData ?? lastConflictPayloadRef.current;
                    if (c) setConflictData({ ...c });
                  }}
                >
                  Conflict — resolve
                </button>
              )}
              {saveState === 'error' && (
                <span className="save-badge conflict">Save error</span>
              )}

              {isEditing && saveState === 'dirty' && (
                <button
                  type="button"
                  className="btn btn-compact save-now-btn"
                  onClick={() => void performSave(liveMdRef.current, false)}
                >
                  Save now
                </button>
              )}

              {workspaceMode === 'read' ? (
                <div className="primary-action-pair" role="group" aria-label="Document actions">
                  <button
                    type="button"
                    className="btn btn-compact btn-edit-entry"
                    onClick={() => handleSwitchWorkspaceMode('visual')}
                    title="Enter authoring mode (Visual editor or Markdown source)"
                  >
                    <Pencil size={13} aria-hidden="true" />
                    <span>Edit</span>
                  </button>

                  <button
                    ref={reviewTriggerRef}
                    type="button"
                    className={`btn btn-compact review-toggle-btn ${effectiveReviewVisible ? 'is-active-btn' : ''}`}
                    onClick={toggleReviewPanel}
                    aria-expanded={effectiveReviewVisible}
                    aria-controls="focus-review-panel"
                    title={effectiveReviewVisible ? 'Close review panel' : 'Open review threads'}
                  >
                    <MessageSquare size={13} aria-hidden="true" />
                    <span>Review</span>
                    {openThreadCount > 0 && (
                      <span className="topbar-count-pill">{openThreadCount}</span>
                    )}
                  </button>
                </div>
              ) : (
                <div className="authoring-action-cluster">
                  <div className="mode-switch" role="group" aria-label="Authoring format">
                    <button
                      type="button"
                      data-mode="visual"
                      className={workspaceMode === 'visual' ? 'active' : ''}
                      disabled={sessionBusy}
                      onClick={() => handleSwitchWorkspaceMode('visual')}
                    >
                      Visual editor
                    </button>
                    <button
                      type="button"
                      data-mode="source"
                      className={workspaceMode === 'source' ? 'active' : ''}
                      disabled={sessionBusy}
                      onClick={() => handleSwitchWorkspaceMode('source')}
                    >
                      Markdown source
                    </button>
                  </div>

                  <div className="primary-action-pair" role="group" aria-label="Edit session actions">
                    <button
                      type="button"
                      className="btn btn-compact btn-revert-session"
                      onClick={() => void handleRevertEditSession()}
                      disabled={!hasSessionChanges || sessionBusy}
                      title={
                        hasSessionChanges
                          ? 'Restore document to how it looked when you entered Edit'
                          : 'No changes made since entering Edit'
                      }
                    >
                      <RotateCcw size={13} className="revert-btn-icon" aria-hidden="true" />
                      <span>{sessionActionPending === 'revert' ? 'Reverting…' : 'Revert'}</span>
                    </button>

                    <button
                      type="button"
                      className="btn btn-compact btn-primary btn-done-editing"
                      onClick={() => void handleFinishEditing()}
                      disabled={sessionBusy}
                      title="Save changes and return to Read mode"
                    >
                      <Check size={13} aria-hidden="true" />
                      <span>{sessionActionPending === 'done' ? 'Saving…' : 'Done'}</span>
                    </button>

                    <button
                      ref={reviewTriggerRef}
                      type="button"
                      className={`btn btn-compact review-toggle-btn ${effectiveReviewVisible ? 'is-active-btn' : ''}`}
                      onClick={toggleReviewPanel}
                      aria-expanded={effectiveReviewVisible}
                      aria-controls="focus-review-panel"
                      title={effectiveReviewVisible ? 'Close review panel' : 'Open review threads'}
                    >
                      <MessageSquare size={13} aria-hidden="true" />
                      <span className="review-editing-label">Review</span>
                      {openThreadCount > 0 && (
                        <span className="topbar-count-pill">{openThreadCount}</span>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </header>

          {statusNotice && (
            <div className="notice-banner">
              <span>{statusNotice}</span>
              <div className="notice-banner-actions">
                {undoRevertSnapshot &&
                  undoRevertSnapshot.projectId === activeProjectId &&
                  undoRevertSnapshot.docPath === activeDocPath && (
                    <button
                      type="button"
                      className="btn btn-compact btn-undo-revert"
                      onClick={handleUndoRevert}
                    >
                      Undo revert
                    </button>
                  )}
                <button
                  type="button"
                  className="btn btn-compact"
                  onClick={() => {
                    setStatusNotice(null);
                    setUndoRevertSnapshot(null);
                  }}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {workspaceMode !== 'source' && activeProjectId && activeDocPath ? (
            <VisualMarkdownEditor
              key={`${activeProjectId}:${activeDocPath}:${docSessionNonce}`}
              ref={visualEditorRef}
              docKey={`${activeProjectId}:${activeDocPath}:${docSessionNonce}`}
              projectName={activeProject?.name}
              docPath={activeDocPath}
              editable={workspaceMode === 'visual'}
              initialMarkdown={initialDocMarkdown}
              threads={threads}
              activeThreadId={activeThreadId}
              showResolvedComments={showResolvedComments}
              onMarkdownEdited={scheduleAutosave}
              onSelectionAnchorChange={(anc) => {
                if (anc !== null) {
                  setPendingAnchor(anc);
                } else if (!composerOpenRef.current && !commentDraftRef.current.trim()) {
                  setPendingAnchor(null);
                }
              }}
              onStartCommentWithAnchor={(anc) => {
                const chosen = anc ?? pendingAnchor;
                openReviewPanel();
                if (chosen) {
                  setPendingAnchor(chosen);
                  setComposerOpen(true);
                } else {
                  setStatusNotice('Select a prose phrase in the document first to anchor a comment.');
                }
              }}
              onSelectThread={(tid) => {
                setActiveThreadId(tid);
                openReviewPanel();
              }}
              onOpenInsertEmbedModal={() => setEmbedModalOpen(true)}
              onOpenRepoDetails={() => void handleOpenGitModal()}
              onNavigateDoc={(targetPath) => {
                if (activeProjectId) {
                  void handleSelectDoc(activeProjectId, targetPath);
                }
              }}
              onTriggerImmediateSave={() => void performSave(liveMdRef.current, false)}
            />
          ) : workspaceMode === 'source' && activeDocPath ? (
            <MarkdownSourceWorkspace
              docPath={activeDocPath}
              markdown={liveMarkdown}
              threads={threads}
              onChangeMarkdown={scheduleAutosave}
              onOpenInsertEmbedModal={() => setEmbedModalOpen(true)}
              onTriggerImmediateSave={() => void performSave(liveMdRef.current, false)}
              onLocateThreadInRead={handleLocateThreadInRead}
            />
          ) : !initialLoaded ? (
            <div className="sheet-scroll">Loading workspace…</div>
          ) : activeProject ? (
            <div className="sheet-scroll">
              <div className="empty-workspace-card">
                <h2>No Markdown pages in {activeProject.name}</h2>
                <p>
                  This repository doesn’t have any <code>.md</code> documents yet on branch{' '}
                  <code>{activeProject.git.branch}</code>.
                </p>
                <div className="empty-workspace-actions">
                  <button
                    type="button"
                    className="btn btn-compact btn-primary"
                    onClick={() => void handleCreateDoc('README.md', activeProject.name)}
                  >
                    Create README.md
                  </button>
                  <button
                    type="button"
                    className="btn btn-compact"
                    onClick={() => setGitModalOpen(true)}
                  >
                    Branches &amp; Git
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="sheet-scroll">
              <div className="empty-workspace-card">
                <h2>No repositories connected</h2>
                <p>Clone a Git repository or connect a local folder to start reading and editing.</p>
                <div className="empty-workspace-actions">
                  <button
                    type="button"
                    className="btn btn-compact btn-primary"
                    onClick={() => setImportModalOpen(true)}
                  >
                    Add repository
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>

        {effectiveReviewVisible && (
          <ReviewMargin
            threads={threads}
            pendingAnchor={pendingAnchor}
            composerOpen={composerOpen}
            activeThreadId={activeThreadId}
            showResolved={showResolvedComments}
            workspaceMode={workspaceMode}
            isOverlay={isOverlayLayout}
            restoreFocusRef={reviewTriggerRef}
            authorName={authorName}
            onChangeAuthorName={handleChangeReviewAuthorName}
            commentDraft={commentDraft}
            onChangeCommentDraft={setCommentDraft}
            replyDrafts={replyDrafts}
            onChangeReplyDraft={(tid, next) =>
              setReplyDrafts((prev) => ({ ...prev, [tid]: next }))
            }
            expandedHistory={expandedHistory}
            onToggleHistory={(tid) =>
              setExpandedHistory((prev) => ({ ...prev, [tid]: !prev[tid] }))
            }
            onToggleShowResolved={setShowResolvedComments}
            onSelectThread={(tid) => {
              setActiveThreadId(tid);
              if (tid && workspaceMode !== 'source' && !isOverlayLayout) {
                visualEditorRef.current?.scrollToThreadAnchor(tid);
              }
            }}
            onLocateInRead={handleLocateThreadInRead}
            onOpenComposer={() => {
              if (pendingAnchor) {
                setComposerOpen(true);
              }
            }}
            onCancelComposer={() => {
              setComposerOpen(false);
              setCommentDraft('');
              setPendingAnchor(null);
              window.getSelection()?.removeAllRanges();
            }}
            onCreateComment={handleCreateComment}
            onReplyComment={handleReplyComment}
            onChangeThreadStatus={handleChangeThreadStatus}
            onClose={closeReviewPanel}
          />
        )}
      </div>

      {readingSettingsOpen && (
        <SettingsModal
          initialSection={settingsSection}
          initialCredentialHost={settingsCredHost}
          readingPreferences={readingPreferences}
          workspaceSettings={workspaceSettings}
          projects={projects}
          activeProjectId={activeProjectId}
          restoreFocusRef={isOverlayLayout ? navTriggerRef : settingsTriggerRef}
          onChangeTextSize={handleChangeTextSize}
          onChangePageWidth={handleChangePageWidth}
          onResetReadingDefaults={handleResetReadingPreferences}
          onUpdateWorkspaceSettings={updateWorkspaceSettings}
          onResetWorkspaceDefaults={handleResetWorkspaceDefaults}
          onSelectProject={handleSelectProject}
          onRepoUpdated={handleRepoUpdated}
          onRepoRemoved={handleRepoRemoved}
          onOpenImportRepoModal={() => setImportModalOpen(true)}
          onClose={() => setReadingSettingsOpen(false)}
        />
      )}

      {gitModalOpen && activeProject && (
        <GitDrawerModal
          project={activeProject}
          activeDocPath={activeDocPath}
          defaultAuthorName={workspaceSettings.commitAuthorName}
          defaultAuthorEmail={workspaceSettings.commitAuthorEmail}
          defaultTab={workspaceSettings.defaultGitTab}
          autoFetchOnOpen={workspaceSettings.autoFetchOnGitOpen}
          includePrRefsOnFetch={workspaceSettings.includePrRefsOnFetch}
          onOpenCredentialsSettings={(host) => handleOpenReadingSettings('credentials', host ?? '')}
          onClose={() => setGitModalOpen(false)}
          onCommitted={async () => {
            await refreshProjects();
          }}
          onRepoSynced={handleRepoSynced}
        />
      )}

      {importModalOpen && (
        <ImportRepoModal
          projects={projects}
          activeProjectId={activeProjectId}
          restoreFocusRef={isOverlayLayout ? navTriggerRef : importTriggerRef}
          onImported={handleRepoImported}
          onRemoved={handleRepoRemoved}
          onOpenCredentialsSettings={(host) => handleOpenReadingSettings('credentials', host ?? '')}
          onClose={() => setImportModalOpen(false)}
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
            lastConflictPayloadRef.current = null;
            setInitialDocMarkdown(conflictData.diskMarkdown);
            setLiveMarkdown(conflictData.diskMarkdown);
            setDocSessionNonce((n) => n + 1);
            setConflictData(null);
            saveStateRef.current = 'saved';
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
