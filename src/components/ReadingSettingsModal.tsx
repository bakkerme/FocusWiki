import { useRef, type RefObject, type KeyboardEvent } from 'react';
import { RotateCcw, SlidersHorizontal, X } from 'lucide-react';
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
import { useModalOverlayFocus } from '../utils/overlayModal';

interface Props {
  preferences: ReadingPreferences;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  onChangeTextSize: (next: TextSizePreset) => void;
  onChangePageWidth: (next: PageWidthPreset) => void;
  onResetDefaults: () => void;
  onClose: () => void;
}

export function ReadingSettingsModal(props: Props) {
  const {
    preferences,
    restoreFocusRef,
    onChangeTextSize,
    onChangePageWidth,
    onResetDefaults,
    onClose
  } = props;

  const dialogRef = useRef<HTMLDivElement | null>(null);

  useModalOverlayFocus({
    active: true,
    containerRef: dialogRef,
    restoreFocusRef,
    initialFocusSelector: '.reading-settings-close-btn',
    onDismiss: onClose
  });

  const isDefault =
    preferences.textSize === DEFAULT_READING_PREFERENCES.textSize &&
    preferences.pageWidth === DEFAULT_READING_PREFERENCES.pageWidth;
  const activeTextSpec = getTextSizeSpec(preferences.textSize);
  const activeWidthSpec = getPageWidthSpec(preferences.pageWidth);

  function handlePresetKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const current = buttons.indexOf(event.currentTarget);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next].focus();
    buttons[next].click();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal-panel reading-settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="readingSettingsTitle"
        tabIndex={-1}
      >
        <div className="reading-settings-header">
          <div className="reading-settings-title-wrap">
            <SlidersHorizontal size={16} aria-hidden="true" />
            <h2 id="readingSettingsTitle">Reading settings</h2>
          </div>
          <button
            type="button"
            className="icon-btn panel-close-btn reading-settings-close-btn"
            onClick={onClose}
            aria-label="Close reading settings"
            title="Close reading settings"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <p className="reading-settings-note">
          Choose how pages look. Your preferences are saved in this browser.
        </p>

        <fieldset className="reading-pref-fieldset">
          <legend className="reading-pref-legend">Text size</legend>
          <div className="reading-preset-grid" role="radiogroup" aria-label="Text size">
            {TEXT_SIZE_OPTIONS.map((opt) => {
              const selected = preferences.textSize === opt.id;
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
        </fieldset>

        <fieldset className="reading-pref-fieldset">
          <legend className="reading-pref-legend">Page width</legend>
          <div className="reading-preset-grid" role="radiogroup" aria-label="Page width">
            {PAGE_WIDTH_OPTIONS.map((opt) => {
              const selected = preferences.pageWidth === opt.id;
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
        </fieldset>

        <div className="reading-live-sample" aria-hidden="true">
          <div className="reading-sample-heading">
            Preview · {activeTextSpec.label} ({activeTextSpec.detail}) · {activeWidthSpec.label} (
            {activeWidthSpec.detail})
          </div>
          <p
            className="reading-sample-copy"
            style={{
              fontSize: activeTextSpec.cssFontSize,
              lineHeight: activeTextSpec.cssLineHeight
            }}
          >
            Clear, scannable documentation scales comfortably without changing toolbars, sidebars,
            or Markdown source alignment.
          </p>
        </div>

        <div className="reading-settings-footer">
          <button
            type="button"
            className="btn btn-compact reading-reset-btn"
            onClick={onResetDefaults}
            disabled={isDefault}
          >
            <RotateCcw size={13} aria-hidden="true" />
            <span>Reset defaults</span>
          </button>
          <button
            type="button"
            className="btn btn-compact btn-primary reading-done-btn"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
