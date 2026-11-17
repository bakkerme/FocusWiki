import { Node, mergeAttributes } from '@tiptap/core';
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps
} from '@tiptap/react';
import {
  ArrowDown,
  ArrowUp,
  Info,
  Maximize2,
  Minimize2,
  RotateCw,
  SlidersHorizontal,
  Trash2
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditorBridge } from './EmbedContext';

const MIN_EMBED_HEIGHT = 110;
const MAX_EMBED_HEIGHT = 1100;
const PRE_MEASURE_HEIGHT = 150;

function clampHeight(h: number, min = MIN_EMBED_HEIGHT, max = MAX_EMBED_HEIGHT): number {
  if (!Number.isFinite(h)) return 280;
  return Math.min(max, Math.max(min, Math.ceil(h)));
}

function EmbedNodeView(props: NodeViewProps) {
  const { node, updateAttributes, deleteNode, editor, getPos } = props;
  const { projectId, embedReloadToken, isEditing } = useEditorBridge();

  const src = String(node.attrs.src ?? '');
  const title = String(node.attrs.title ?? src);
  const configuredHeight = Number(node.attrs.height ?? 320);
  const propsJson = String(node.attrs.propsJson ?? '{}');

  const instanceId = useMemo(
    () => `emb-${Math.random().toString(36).slice(2, 10)}`,
    []
  );

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const embedProtocolRef = useRef<'focus' | 'cairn'>('focus');
  const hasDynamicSizeRef = useRef<boolean>(false);
  const fallbackTimerRef = useRef<number | null>(null);

  const [sizingMode, setSizingMode] = useState<'measuring' | 'auto' | 'fallback'>('measuring');
  const [liveHeight, setLiveHeight] = useState<number>(PRE_MEASURE_HEIGHT);
  const [fallbackExpanded, setFallbackExpanded] = useState<boolean>(false);
  const [telemetry, setTelemetry] = useState<string>('Sandboxed component ready');
  const [localReload, setLocalReload] = useState<number>(0);

  const [infoOpen, setInfoOpen] = useState<boolean>(false);
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(false);
  const [confirmRemove, setConfirmRemove] = useState<boolean>(false);
  const [sourceCode, setSourceCode] = useState<string | null>(null);

  const [draftTitle, setDraftTitle] = useState<string>(title);
  const [draftHeight, setDraftHeight] = useState<string>(String(configuredHeight));
  const [draftProps, setDraftProps] = useState<string>(propsJson);
  const [propsError, setPropsError] = useState<string | null>(null);

  useEffect(() => {
    setDraftTitle(title);
    setDraftHeight(String(configuredHeight));
    setDraftProps(propsJson);
  }, [title, configuredHeight, propsJson]);

  // Close author-only inspector and delete confirmation when returning to Read mode
  useEffect(() => {
    if (!isEditing) {
      setInspectorOpen(false);
      setConfirmRemove(false);
    }
  }, [isEditing]);

  useEffect(() => {
    if (!confirmRemove) return;
    const t = window.setTimeout(() => setConfirmRemove(false), 3200);
    return () => window.clearTimeout(t);
  }, [confirmRemove]);

  const sendInitProps = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(propsJson) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    const prefix = embedProtocolRef.current === 'cairn' ? 'cairn:embed' : 'focus:embed';
    win.postMessage(
      {
        type: `${prefix}:init`,
        instanceId,
        props: parsed
      },
      '*'
    );
  }, [instanceId, propsJson]);

  // Reset measurement whenever the iframe URL reloads
  const sandboxUrl = useMemo(() => {
    if (!projectId || !src) return 'about:blank';
    const encodedSrc = src.split('/').map(encodeURIComponent).join('/');
    return `/embed-sandbox/${encodeURIComponent(projectId)}/${encodedSrc}?rev=${embedReloadToken}-${localReload}&instance=${encodeURIComponent(instanceId)}`;
  }, [projectId, src, embedReloadToken, localReload, instanceId]);

  useEffect(() => {
    embedProtocolRef.current = 'focus';
    hasDynamicSizeRef.current = false;
    setSizingMode('measuring');
    setLiveHeight(PRE_MEASURE_HEIGHT);
    if (fallbackTimerRef.current !== null) {
      window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, [sandboxUrl]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }
      const data = event.data as Record<string, unknown> | null;
      if (!data || typeof data !== 'object') return;
      if (typeof data.instanceId === 'string' && data.instanceId !== instanceId) {
        return;
      }

      if (data.type === 'cairn:embed:ready' || data.type === 'cairn:embed:resize' || data.type === 'cairn:embed:telemetry') {
        embedProtocolRef.current = 'cairn';
      }

      if (
        data.type === 'focus:embed:ready' ||
        data.type === 'focus:embed:resize' ||
        data.type === 'cairn:embed:ready' ||
        data.type === 'cairn:embed:resize'
      ) {
        if (typeof data.height === 'number' && Number.isFinite(data.height) && data.height >= 60) {
          hasDynamicSizeRef.current = true;
          if (fallbackTimerRef.current !== null) {
            window.clearTimeout(fallbackTimerRef.current);
            fallbackTimerRef.current = null;
          }
          setSizingMode('auto');
          setLiveHeight(clampHeight(data.height + 2));
        }
        if (data.type === 'focus:embed:ready' || data.type === 'cairn:embed:ready') {
          sendInitProps();
        }
      } else if (
        (data.type === 'focus:embed:telemetry' || data.type === 'cairn:embed:telemetry') &&
        typeof data.summary === 'string'
      ) {
        setTelemetry(data.summary.slice(0, 140));
      }
    }

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      if (fallbackTimerRef.current !== null) {
        window.clearTimeout(fallbackTimerRef.current);
      }
    };
  }, [instanceId, sendInitProps]);

  function handleIframeLoad() {
    sendInitProps();
    if (fallbackTimerRef.current !== null) {
      window.clearTimeout(fallbackTimerRef.current);
    }
    fallbackTimerRef.current = window.setTimeout(() => {
      fallbackTimerRef.current = null;
      if (!hasDynamicSizeRef.current) {
        setSizingMode('fallback');
        const boundedFallback = clampHeight(configuredHeight || 300, 160, 560);
        setLiveHeight(boundedFallback);
      }
    }, 260);
  }

  async function toggleInspector() {
    const next = !inspectorOpen;
    setInspectorOpen(next);
    if (next && sourceCode === null && projectId && src) {
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/embed-source?src=${encodeURIComponent(src)}`
        );
        if (res.ok) {
          const payload = (await res.json()) as { source: string };
          setSourceCode(payload.source);
        } else {
          setSourceCode(`Unable to load component source (${res.status}).`);
        }
      } catch {
        setSourceCode('Unable to fetch component source.');
      }
    }
  }

  function applyConfigChanges() {
    try {
      const parsed = JSON.parse(draftProps || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setPropsError('Props must be a JSON object.');
        return;
      }
      const numericHeight = clampHeight(Number.parseInt(draftHeight, 10) || 320, 140, 900);
      setPropsError(null);
      updateAttributes({
        title: draftTitle.trim() || src,
        height: numericHeight,
        propsJson: JSON.stringify(parsed)
      });
      setLocalReload((n) => n + 1);
    } catch {
      setPropsError('Invalid JSON syntax in props.');
    }
  }

  function moveBlock(direction: -1 | 1) {
    if (typeof getPos !== 'function') return;
    const pos = getPos();
    if (typeof pos !== 'number') return;
    const { doc, tr } = editor.state;
    const $pos = doc.resolve(pos);
    const index = $pos.index(0);
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= doc.childCount) return;

    const currentNode = doc.child(index);
    const siblingNode = doc.child(targetIndex);

    if (direction === -1) {
      const siblingStart = pos - siblingNode.nodeSize;
      tr.replaceWith(siblingStart, pos + currentNode.nodeSize, [currentNode, siblingNode]);
    } else {
      const currentEnd = pos + currentNode.nodeSize;
      tr.replaceWith(pos, currentEnd + siblingNode.nodeSize, [siblingNode, currentNode]);
    }
    editor.view.dispatch(tr.scrollIntoView());
  }

  const displayedHeight =
    sizingMode === 'fallback' && fallbackExpanded
      ? Math.max(liveHeight, 560)
      : liveHeight;

  return (
    <NodeViewWrapper
      className={`embed-frame-wrapper ${isEditing ? 'is-edit-mode' : 'is-read-mode'}`}
      data-sizing-mode={sizingMode}
      contentEditable={false}
    >
      <div className="embed-frame-header">
        <div className="embed-title-group">
          <div className="embed-frame-title">{title}</div>
          <div className={`embed-frame-src ${!isEditing && !infoOpen ? 'is-subtle-hidden' : ''}`}>
            {src}
          </div>
        </div>

        <div className="embed-frame-actions">
          {isEditing ? (
            <>
              <button
                type="button"
                className="icon-btn"
                onClick={() => moveBlock(-1)}
                aria-label="Move component block up"
                title="Move block up"
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => moveBlock(1)}
                aria-label="Move component block down"
                title="Move block down"
              >
                <ArrowDown size={14} />
              </button>
              <button
                type="button"
                className={`btn btn-compact ${inspectorOpen ? 'is-active-btn' : ''}`}
                onClick={() => void toggleInspector()}
                aria-expanded={inspectorOpen}
              >
                <SlidersHorizontal size={13} />
                <span>{inspectorOpen ? 'Hide config' : 'Source & props'}</span>
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setLocalReload((n) => n + 1)}
                aria-label="Reload component"
                title="Reload component"
              >
                <RotateCw size={14} />
              </button>
              <button
                type="button"
                className={confirmRemove ? 'btn btn-compact btn-danger' : 'icon-btn icon-btn-danger'}
                onClick={() => {
                  if (confirmRemove) {
                    deleteNode();
                  } else {
                    setConfirmRemove(true);
                  }
                }}
                aria-label={confirmRemove ? 'Confirm remove embed block' : 'Remove embed block'}
                title={confirmRemove ? 'Click again to remove block from document' : 'Remove embed block'}
              >
                <Trash2 size={14} />
                {confirmRemove && <span>Confirm</span>}
              </button>
            </>
          ) : (
            <>
              {sizingMode === 'fallback' && (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setFallbackExpanded((v) => !v)}
                  aria-label={fallbackExpanded ? 'Restore default frame height' : 'Expand frame height'}
                  title={fallbackExpanded ? 'Restore default frame height' : 'Expand frame height'}
                >
                  {fallbackExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                </button>
              )}
              <button
                type="button"
                className={`icon-btn ${infoOpen ? 'is-active' : ''}`}
                onClick={() => setInfoOpen((v) => !v)}
                aria-label="Component details and sandbox status"
                aria-expanded={infoOpen}
                title="Component path & sandbox status"
              >
                <Info size={14} />
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setLocalReload((n) => n + 1)}
                aria-label="Reload component"
                title="Reload component"
              >
                <RotateCw size={14} />
              </button>
            </>
          )}
        </div>
      </div>

      {!isEditing && infoOpen && (
        <div className="embed-info-bar">
          <code>{src}</code>
          <span>·</span>
          <span>Isolated null-origin sandbox</span>
          <span>·</span>
          <span>{telemetry}</span>
        </div>
      )}

      {isEditing && inspectorOpen && (
        <div className="embed-inspector-drawer">
          <div className="embed-inspector-grid">
            <div>
              <label className="field-label">Block title</label>
              <input
                type="text"
                className="field-input"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
              />
            </div>
            <div>
              <label className="field-label">Fallback height (px)</label>
              <input
                type="number"
                min={140}
                max={900}
                className="field-input"
                value={draftHeight}
                onChange={(e) => setDraftHeight(e.target.value)}
              />
            </div>
            <div>
              <label className="field-label">Initial props JSON</label>
              <input
                type="text"
                className="field-input field-code"
                value={draftProps}
                onChange={(e) => setDraftProps(e.target.value)}
              />
            </div>
          </div>
          {propsError && (
            <div style={{ color: 'var(--conflict-garnet)', marginBottom: 8, fontWeight: 600 }}>
              {propsError}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <button type="button" className="btn btn-compact btn-primary" onClick={applyConfigChanges}>
              Apply block settings
            </button>
            <span style={{ fontSize: 11.5, color: 'var(--ink-secondary)' }}>
              Repository asset: <code>{src}</code> · {telemetry}
            </span>
          </div>
          {sourceCode !== null && (
            <pre className="diff-viewer" style={{ maxHeight: 180 }}>
              {sourceCode}
            </pre>
          )}
        </div>
      )}

      <iframe
        ref={iframeRef}
        className="embed-sandbox-iframe"
        title={title}
        sandbox="allow-scripts"
        src={sandboxUrl}
        style={{ height: `${displayedHeight}px` }}
        onLoad={handleIframeLoad}
      />
    </NodeViewWrapper>
  );
}

export const EmbedBlockExtension = Node.create({
  name: 'embedBlock',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: '' },
      title: { default: '' },
      height: { default: 320 },
      propsJson: { default: '{}' }
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-embed-block]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-embed-block': 'true' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(EmbedNodeView);
  }
});
