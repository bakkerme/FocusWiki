import { useState } from 'react';
import type { EmbedAssetEntry, EmbedDescriptor } from '../../shared/types';

interface Props {
  projectId: string;
  existingEmbeds: EmbedAssetEntry[];
  onInsertEmbed: (desc: EmbedDescriptor) => void;
  onCreatedNewEmbedFile: () => Promise<void>;
  onClose: () => void;
}

const STARTER_COMPONENT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="color-scheme" content="light dark" />
  <style>
    :root {
      color-scheme: light dark;
      --bg: #ffffff;
      --line: #e5e7eb;
      --ink: #171717;
      --accent: #1d4ed8;
      --accent-soft: #eff6ff;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #141417;
        --line: #27272d;
        --ink: #f4f4f5;
        --accent: #60a5fa;
        --accent-soft: rgba(59, 130, 246, 0.16);
      }
    }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 14px; background: var(--bg); color: var(--ink); }
    .box { border: 1px solid var(--line); border-radius: 6px; padding: 12px; background: var(--bg); }
    button { padding: 6px 10px; border-radius: 5px; border: 1px solid var(--accent); background: var(--accent-soft); color: var(--accent); font-weight: 600; cursor: pointer; }
  </style>
</head>
<body>
  <div class="box">
    <div style="font-weight:700;margin-bottom:6px;" id="heading">Custom Project Widget</div>
    <p style="font-size:13px;margin:0 0 10px 0;" id="output">Counter: 0</p>
    <button type="button" id="incBtn">Advance counter</button>
  </div>
  <script>
    let count = 0;
    document.getElementById('incBtn').addEventListener('click', () => {
      count += 1;
      document.getElementById('output').textContent = 'Counter: ' + count;
      window.parent.postMessage({ type: 'cairn:embed:telemetry', summary: 'Counter = ' + count }, '*');
    });
    window.addEventListener('message', (ev) => {
      if (ev.data && ev.data.type === 'cairn:embed:init' && ev.data.props && ev.data.props.label) {
        document.getElementById('heading').textContent = String(ev.data.props.label);
      }
    });
    window.parent.postMessage({ type: 'cairn:embed:ready', height: document.documentElement.scrollHeight }, '*');
  </script>
</body>
</html>
`;

export function InsertEmbedModal({
  projectId,
  existingEmbeds,
  onInsertEmbed,
  onCreatedNewEmbedFile,
  onClose
}: Props) {
  const [tab, setTab] = useState<'existing' | 'new'>('existing');
  const [selectedSrc, setSelectedSrc] = useState<string>(existingEmbeds[0]?.src ?? '');
  const [title, setTitle] = useState<string>(existingEmbeds[0]?.name ?? 'Interactive Widget');
  const [propsText, setPropsText] = useState<string>('{}');

  const [newSlug, setNewSlug] = useState<string>('custom-tracker');
  const [newTitle, setNewTitle] = useState<string>('Custom Encounter Tracker');
  const [newSource, setNewSource] = useState<string>(STARTER_COMPONENT_HTML);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);

  function handleInsertExisting(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedSrc) return;
    try {
      const parsedProps = JSON.parse(propsText || '{}') as Record<string, unknown>;
      onInsertEmbed({
        src: selectedSrc,
        title: title.trim() || selectedSrc,
        height: 320,
        props: parsedProps
      });
      onClose();
    } catch {
      setError('Props must be valid JSON.');
    }
  }

  async function handleCreateAndInsert(e: React.FormEvent) {
    e.preventDefault();
    const cleanSlug = newSlug
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-');
    if (!cleanSlug) {
      setError('Component folder name is required.');
      return;
    }
    const targetSrc = `embeds/${cleanSlug}/index.html`;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/embeds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          src: targetSrc,
          source: newSource
        })
      });
      if (!res.ok) {
        const body = (await res.json()) as { message?: string };
        throw new Error(body.message ?? 'Could not write component file');
      }
      await onCreatedNewEmbedFile();
      onInsertEmbed({
        src: targetSrc,
        title: newTitle.trim() || cleanSlug,
        height: 240,
        props: { label: newTitle.trim() || cleanSlug }
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create component');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Insert or create project embed">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>Insert project-authored embed</h2>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="mode-switch" style={{ alignSelf: 'flex-start' }}>
          <button
            type="button"
            className={tab === 'existing' ? 'active' : ''}
            onClick={() => setTab('existing')}
          >
            Existing repo embeds ({existingEmbeds.length})
          </button>
          <button
            type="button"
            className={tab === 'new' ? 'active' : ''}
            onClick={() => setTab('new')}
          >
            Create new component in embeds/
          </button>
        </div>

        {error && (
          <div className="notice-banner conflict" style={{ borderRadius: 5 }}>
            {error}
          </div>
        )}

        {tab === 'existing' ? (
          <form onSubmit={handleInsertExisting} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
                Component entrypoint in repository
              </label>
              <select
                className="project-select"
                value={selectedSrc}
                onChange={(e) => {
                  setSelectedSrc(e.target.value);
                  const found = existingEmbeds.find((x) => x.src === e.target.value);
                  if (found) setTitle(found.name);
                }}
              >
                {existingEmbeds.map((emb) => (
                  <option key={emb.src} value={emb.src}>
                    {emb.src}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
                Display title
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                style={{ width: '100%', padding: '7px 10px', background: 'var(--surface-sheet)', color: 'var(--ink-primary)', border: '1px solid var(--line-border)', borderRadius: 5 }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
                Initial props JSON
              </label>
              <input
                type="text"
                value={propsText}
                onChange={(e) => setPropsText(e.target.value)}
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  fontFamily: 'var(--font-code)',
                  background: 'var(--surface-sheet)',
                  color: 'var(--ink-primary)',
                  border: '1px solid var(--line-border)',
                  borderRadius: 5
                }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="submit" className="btn btn-primary" disabled={!selectedSrc}>
                Insert embed block
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={(e) => void handleCreateAndInsert(e)} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
                  Component folder under embeds/
                </label>
                <input
                  type="text"
                  value={newSlug}
                  onChange={(e) => setNewSlug(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '7px 10px',
                    fontFamily: 'var(--font-code)',
                    background: 'var(--surface-sheet)',
                    color: 'var(--ink-primary)',
                    border: '1px solid var(--line-border)',
                    borderRadius: 5
                  }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
                  Block title
                </label>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  style={{ width: '100%', padding: '7px 10px', background: 'var(--surface-sheet)', color: 'var(--ink-primary)', border: '1px solid var(--line-border)', borderRadius: 5 }}
                />
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
                HTML/JS component source (saved directly to embeds/{newSlug || 'widget'}/index.html)
              </label>
              <textarea
                rows={11}
                value={newSource}
                onChange={(e) => setNewSource(e.target.value)}
                style={{
                  width: '100%',
                  fontFamily: 'var(--font-code)',
                  fontSize: 12,
                  padding: 10,
                  background: 'var(--surface-sheet)',
                  color: 'var(--ink-primary)',
                  border: '1px solid var(--line-border)',
                  borderRadius: 5
                }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Writing file…' : 'Write component & insert embed'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
