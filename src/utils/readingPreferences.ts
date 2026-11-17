export type TextSizePreset = 'small' | 'standard' | 'large';
export type PageWidthPreset = 'narrow' | 'standard' | 'wide';

export interface ReadingPreferences {
  textSize: TextSizePreset;
  pageWidth: PageWidthPreset;
}

export interface TextSizeOptionSpec {
  id: TextSizePreset;
  label: string;
  detail: string;
  cssFontSize: string;
  cssLineHeight: string;
  cssReviewSize: string;
}

export interface PageWidthOptionSpec {
  id: PageWidthPreset;
  label: string;
  detail: string;
  cssMaxWidth: string;
}

export const READING_PREFERENCES_STORAGE_KEY = 'focus:reading-preferences:v1';
const LEGACY_READING_PREFERENCES_STORAGE_KEY = 'cairn:reading-preferences:v1';
export const READING_PREFERENCES_VERSION = 1;

export const DEFAULT_READING_PREFERENCES: ReadingPreferences = {
  textSize: 'standard',
  pageWidth: 'standard'
};

export const TEXT_SIZE_OPTIONS: readonly TextSizeOptionSpec[] = [
  {
    id: 'small',
    label: 'Small',
    detail: '16px',
    cssFontSize: '1rem',
    cssLineHeight: '1.6',
    cssReviewSize: '0.9375rem'
  },
  {
    id: 'standard',
    label: 'Standard',
    detail: '18px',
    cssFontSize: '1.125rem',
    cssLineHeight: '1.65',
    cssReviewSize: '1rem'
  },
  {
    id: 'large',
    label: 'Large',
    detail: '20px',
    cssFontSize: '1.25rem',
    cssLineHeight: '1.68',
    cssReviewSize: '1.08rem'
  }
];

export const PAGE_WIDTH_OPTIONS: readonly PageWidthOptionSpec[] = [
  {
    id: 'narrow',
    label: 'Narrow',
    detail: '640px',
    cssMaxWidth: '640px'
  },
  {
    id: 'standard',
    label: 'Standard',
    detail: '760px',
    cssMaxWidth: '760px'
  },
  {
    id: 'wide',
    label: 'Wide',
    detail: '960px',
    cssMaxWidth: '960px'
  }
];

function isValidTextSize(val: unknown): val is TextSizePreset {
  return val === 'small' || val === 'standard' || val === 'large';
}

function isValidPageWidth(val: unknown): val is PageWidthPreset {
  return val === 'narrow' || val === 'standard' || val === 'wide';
}

function getSafeBrowserStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null;
    }
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadReadingPreferences(
  storage: Pick<Storage, 'getItem'> | null = getSafeBrowserStorage()
): ReadingPreferences {
  if (!storage) {
    return { ...DEFAULT_READING_PREFERENCES };
  }
  try {
    const raw =
      storage.getItem(READING_PREFERENCES_STORAGE_KEY) ??
      storage.getItem(LEGACY_READING_PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_READING_PREFERENCES };
    }
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== READING_PREFERENCES_VERSION) {
      return { ...DEFAULT_READING_PREFERENCES };
    }
    return {
      textSize: isValidTextSize(parsed.textSize)
        ? parsed.textSize
        : DEFAULT_READING_PREFERENCES.textSize,
      pageWidth: isValidPageWidth(parsed.pageWidth)
        ? parsed.pageWidth
        : DEFAULT_READING_PREFERENCES.pageWidth
    };
  } catch {
    return { ...DEFAULT_READING_PREFERENCES };
  }
}

export function saveReadingPreferences(
  prefs: ReadingPreferences,
  storage: Pick<Storage, 'setItem'> | null = getSafeBrowserStorage()
): boolean {
  if (!storage) {
    return false;
  }
  try {
    const payload = {
      version: READING_PREFERENCES_VERSION,
      textSize: isValidTextSize(prefs.textSize)
        ? prefs.textSize
        : DEFAULT_READING_PREFERENCES.textSize,
      pageWidth: isValidPageWidth(prefs.pageWidth)
        ? prefs.pageWidth
        : DEFAULT_READING_PREFERENCES.pageWidth
    };
    storage.setItem(READING_PREFERENCES_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function getTextSizeSpec(id: TextSizePreset): TextSizeOptionSpec {
  return TEXT_SIZE_OPTIONS.find((o) => o.id === id) ?? TEXT_SIZE_OPTIONS[1];
}

export function getPageWidthSpec(id: PageWidthPreset): PageWidthOptionSpec {
  return PAGE_WIDTH_OPTIONS.find((o) => o.id === id) ?? PAGE_WIDTH_OPTIONS[1];
}
