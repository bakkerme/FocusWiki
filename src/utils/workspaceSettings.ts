export type ThemeMode = 'system' | 'light' | 'dark';
export type GitDrawerDefaultTab = 'changes' | 'branches';

export interface WorkspaceSettings {
  themeMode: ThemeMode;
  reviewerName: string;
  commitAuthorName: string;
  commitAuthorEmail: string;
  defaultGitTab: GitDrawerDefaultTab;
  autoFetchOnGitOpen: boolean;
  includePrRefsOnFetch: boolean;
}

export const WORKSPACE_SETTINGS_STORAGE_KEY = 'focus:workspace-settings:v1';
export const WORKSPACE_SETTINGS_VERSION = 1;

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  themeMode: 'system',
  reviewerName: 'Reviewer',
  commitAuthorName: 'Workspace Author',
  commitAuthorEmail: '',
  defaultGitTab: 'changes',
  autoFetchOnGitOpen: false,
  includePrRefsOnFetch: true
};

export const THEME_MODE_OPTIONS: readonly { id: ThemeMode; label: string; description: string }[] = [
  { id: 'system', label: 'System', description: 'Follow OS appearance' },
  { id: 'light', label: 'Light', description: 'Always use light canvas' },
  { id: 'dark', label: 'Dark', description: 'Always use dark canvas' }
];

function isValidThemeMode(val: unknown): val is ThemeMode {
  return val === 'system' || val === 'light' || val === 'dark';
}

function isValidGitTab(val: unknown): val is GitDrawerDefaultTab {
  return val === 'changes' || val === 'branches';
}

function sanitizeString(val: unknown, fallback: string, maxLen = 120): string {
  if (typeof val !== 'string') return fallback;
  const trimmed = val.replace(/[\r\n\0]/g, '').slice(0, maxLen);
  return trimmed;
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

export function loadWorkspaceSettings(
  storage: Pick<Storage, 'getItem'> | null = getSafeBrowserStorage()
): WorkspaceSettings {
  if (!storage) {
    return { ...DEFAULT_WORKSPACE_SETTINGS };
  }
  try {
    const raw = storage.getItem(WORKSPACE_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_WORKSPACE_SETTINGS };
    }
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== WORKSPACE_SETTINGS_VERSION) {
      return { ...DEFAULT_WORKSPACE_SETTINGS };
    }
    const reviewer = sanitizeString(parsed.reviewerName, DEFAULT_WORKSPACE_SETTINGS.reviewerName);
    const commitName = sanitizeString(
      parsed.commitAuthorName,
      DEFAULT_WORKSPACE_SETTINGS.commitAuthorName
    );
    const commitEmail = sanitizeString(
      parsed.commitAuthorEmail,
      DEFAULT_WORKSPACE_SETTINGS.commitAuthorEmail
    );
    return {
      themeMode: isValidThemeMode(parsed.themeMode)
        ? parsed.themeMode
        : DEFAULT_WORKSPACE_SETTINGS.themeMode,
      reviewerName: reviewer.trim() || DEFAULT_WORKSPACE_SETTINGS.reviewerName,
      commitAuthorName: commitName.trim() || DEFAULT_WORKSPACE_SETTINGS.commitAuthorName,
      commitAuthorEmail: commitEmail.trim(),
      defaultGitTab: isValidGitTab(parsed.defaultGitTab)
        ? parsed.defaultGitTab
        : DEFAULT_WORKSPACE_SETTINGS.defaultGitTab,
      autoFetchOnGitOpen:
        typeof parsed.autoFetchOnGitOpen === 'boolean'
          ? parsed.autoFetchOnGitOpen
          : DEFAULT_WORKSPACE_SETTINGS.autoFetchOnGitOpen,
      includePrRefsOnFetch:
        typeof parsed.includePrRefsOnFetch === 'boolean'
          ? parsed.includePrRefsOnFetch
          : DEFAULT_WORKSPACE_SETTINGS.includePrRefsOnFetch
    };
  } catch {
    return { ...DEFAULT_WORKSPACE_SETTINGS };
  }
}

export function saveWorkspaceSettings(
  settings: WorkspaceSettings,
  storage: Pick<Storage, 'setItem'> | null = getSafeBrowserStorage()
): boolean {
  if (!storage) {
    return false;
  }
  try {
    const payload = {
      version: WORKSPACE_SETTINGS_VERSION,
      themeMode: isValidThemeMode(settings.themeMode)
        ? settings.themeMode
        : DEFAULT_WORKSPACE_SETTINGS.themeMode,
      reviewerName:
        sanitizeString(settings.reviewerName, DEFAULT_WORKSPACE_SETTINGS.reviewerName).trim() ||
        DEFAULT_WORKSPACE_SETTINGS.reviewerName,
      commitAuthorName:
        sanitizeString(
          settings.commitAuthorName,
          DEFAULT_WORKSPACE_SETTINGS.commitAuthorName
        ).trim() || DEFAULT_WORKSPACE_SETTINGS.commitAuthorName,
      commitAuthorEmail: sanitizeString(
        settings.commitAuthorEmail,
        DEFAULT_WORKSPACE_SETTINGS.commitAuthorEmail
      ).trim(),
      defaultGitTab: isValidGitTab(settings.defaultGitTab)
        ? settings.defaultGitTab
        : DEFAULT_WORKSPACE_SETTINGS.defaultGitTab,
      autoFetchOnGitOpen: Boolean(settings.autoFetchOnGitOpen),
      includePrRefsOnFetch: Boolean(settings.includePrRefsOnFetch)
    };
    storage.setItem(WORKSPACE_SETTINGS_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function applyThemeMode(themeMode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (themeMode === 'light' || themeMode === 'dark') {
    root.setAttribute('data-theme', themeMode);
    root.style.colorScheme = themeMode;
  } else {
    root.removeAttribute('data-theme');
    root.style.colorScheme = 'light dark';
  }
}
