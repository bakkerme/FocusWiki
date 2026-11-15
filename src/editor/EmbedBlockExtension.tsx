import { Node, mergeAttributes } from '@tiptap/core';
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps
} from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { useEditorBridge } from './EmbedContext';

function EmbedNodeView(props: NodeViewProps) {
  const { node, updateAttributes, deleteNode, editor, getPos } = props;
  const { projectId, embedReloadToken } = useEditorBridge();

  const src = String(node.attrs.src ?? '');
  const title = String(node.attrs.title ?? src);
  const configuredHeight = Number(node.attrs.height ?? 340);
  const propsJson = String(node.attrs.propsJson ?? '{}');

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [liveHeight, setLiveHeight] = useState<number>(configuredHeight);
  const [telemetry, setTelemetry] = useState<string>('Sandboxed component ready');
  const [localReload, setLocalReload] = useState<number>(0);
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(false);
  const [sourceCode, setSourceCode] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState<string>(title);
  const [draftProps, setDraftProps] = useState<string>(propsJson);
  const [propsError, setPropsError] = useState<string | null>(null);

  useEffect(() => {
    setDraftTitle(title);
    setDraftProps(propsJson);
  }, [title, propsJson]);

  function sendInitProps() {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(propsJson) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    win.postMessage(
      {
        type: 'cairn:embed:init',
        props: parsed
      },
      '*'
    );
  }

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }
      const data = event.data;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'cairn:embed:ready') {
        if (typeof data.height === 'number' && data.height >= 120 && data.height <= 1400) {
          setLiveHeight(Math.round(data.height) + 6);
        }
        sendInitProps();
      } else if (data.type === 'cairn:embed:resize') {
        if (typeof data.height === 'number' && data.height >= 120 && data.height <= 1400) {
          setLiveHeight(Math.round(data.height) + 6);
        }
      } else if (data.type === 'cairn:embed:telemetry' && typeof data.summary === 'string') {
        setTelemetry(data.summary.slice(0, 140));
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [propsJson]);

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
      setPropsError(null);
      updateAttributes({
        title: draftTitle.trim() || src,
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

  const sandboxUrl = projectId
    ? `/embed-sandbox/${encodeURIComponent(projectId)}/${src
        .split('/')
        .map(encodeURIComponent)
        .join('/')}?rev=${embedReloadToken}-${localReload}`
    : 'about:blank';

  return (
    <NodeViewWrapper className="embed-frame-wrapper" contentEditable={false}>
      <div className="embed-frame-header">
        <div>
          <div className="embed-frame-title">{title}</div>
          <div className="embed-frame-src">{src}</div>
        </div>
        <div className="embed-frame-actions">
          <button
            type="button"
            className="btn btn-compact"
            onClick={() => moveBlock(-1)}
            title="Move component block up"
          >
            Move up
          </button>
          <button
            type="button"
            className="btn btn-compact"
            onClick={() => moveBlock(1)}
            title="Move component block down"
          >
            Move down
          </button>
          <button
            type="button"
            className="btn btn-compact"
            onClick={() => void toggleInspector()}
          >
            {inspectorOpen ? 'Hide config' : 'Source & props'}
          </button>
          <button
            type="button"
            className="btn btn-compact"
            onClick={() => setLocalReload((n) => n + 1)}
          >
            Reload
          </button>
          <button
            type="button"
            className="btn btn-compact"
            onClick={() => deleteNode()}
            title="Remove embed reference from document"
          >
            Remove
          </button>
        </div>
      </div>

      {inspectorOpen && (
        <div className="embed-inspector-drawer">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
                Block title
              </label>
              <input
                type="text"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  border: '1px solid #cfd8d7',
                  borderRadius: 4
                }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
                Initial props JSON
              </label>
              <input
                type="text"
                value={draftProps}
                onChange={(e) => setDraftProps(e.target.value)}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  fontFamily: 'var(--font-code)',
                  border: '1px solid #cfd8d7',
                  borderRadius: 4
                }}
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
              Component source in repository ({src})
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
        style={{ height: `${liveHeight}px` }}
        onLoad={sendInitProps}
      />

      <div className="embed-frame-footer">
        <span>{telemetry}</span>
        <span>Isolated sandbox (null origin)</span>
      </div>
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
      height: { default: 340 },
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
