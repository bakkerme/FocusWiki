import { useRef } from 'react';
import { useModalOverlayFocus } from '../utils/overlayModal';
import type { ConflictErrorPayload } from '../../shared/types';

interface Props {
  conflict: ConflictErrorPayload;
  onAcceptDiskVersion: () => void;
  onOverwriteWithMine: () => void;
  onDismiss: () => void;
}

export function ConflictModal({
  conflict,
  onAcceptDiskVersion,
  onOverwriteWithMine,
  onDismiss
}: Props) {
  const modalRef = useRef<HTMLDivElement>(null);
  useModalOverlayFocus({ active: true, containerRef: modalRef, onDismiss });
  return (
    <div className="modal-backdrop" onClick={onDismiss}>
      <div
        className="modal-panel"
        ref={modalRef}
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="conflict-modal-title"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Concurrent file edit conflict resolution"
      >
        <div>
          <h2 id="conflict-modal-title" style={{ margin: 0, fontSize: 17, color: 'var(--conflict-garnet)' }}>
            External file edit detected — both versions preserved
          </h2>
          <p style={{ margin: '6px 0 0 0', fontSize: 13, color: 'var(--ink-secondary)' }}>
            <code>{conflict.path}</code> changed on disk while you had unsaved edits. Disk was not
            overwritten, and your editor draft was backed up to{' '}
            <span className="code-chip">{conflict.savedConflictCopyPath}</span>.
          </p>
        </div>

        <div className="conflict-columns">
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>
              Current version on disk (External / Bot)
            </div>
            <pre className="diff-viewer" style={{ maxHeight: 280 }}>
              {conflict.diskMarkdown}
            </pre>
          </div>

          <div>
            <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>
              Your unsaved editor version
            </div>
            <pre className="diff-viewer" style={{ maxHeight: 280 }}>
              {conflict.yourMarkdown}
            </pre>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <button type="button" className="btn" onClick={onDismiss}>
            Keep comparing
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn" onClick={onAcceptDiskVersion}>
              Load external disk version
            </button>
            <button type="button" className="btn btn-primary" onClick={onOverwriteWithMine}>
              Save my version over disk
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
