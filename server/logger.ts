export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50
};

const MAX_FIELD_CHARS = 300;

export function parseLogLevel(raw = process.env.FOCUSWIKI_LOG_LEVEL): LogLevel {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' ||
      normalized === 'error' || normalized === 'silent') {
    return normalized;
  }
  return 'info';
}

/** Strips control characters/newlines and redacts credential-like patterns before logging. */
export function sanitizeLogText(value: string, maxLength = MAX_FIELD_CHARS): string {
  let clean = value
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(Authorization\s*:\s*(?:Basic|Bearer|Token)\s+)[^\s'",;]+/gi, '$1[REDACTED]')
    .replace(/\b((?:Basic|Bearer)\s+)[A-Za-z0-9+/_=-]{12,}\b/g, '$1[REDACTED]')
    .replace(/(https?:\/\/)([^\s/@:]+:[^\s/@]+)@/gi, '$1[REDACTED]@')
    .replace(/\b(?:x-access-token:)[^\s'"@]+/gi, 'x-access-token:[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, '[REDACTED_TOKEN]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (clean.length > maxLength) {
    clean = `${clean.slice(0, Math.max(0, maxLength - 3))}...`;
  }
  return clean;
}

export type LogFields = Record<string, string | number | boolean | null | undefined>;

function formatFields(fields?: LogFields): string {
  if (!fields) return '';
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(fields)) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'number' || typeof raw === 'boolean') {
      parts.push(`${key}=${raw}`);
    } else {
      const sanitized = sanitizeLogText(raw);
      if (!sanitized) continue;
      parts.push(/[\s="]/.test(sanitized) ? `${key}=${JSON.stringify(sanitized)}` : `${key}=${sanitized}`);
    }
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export function createLogger(component: string): Logger {
  const emit = (level: Exclude<LogLevel, 'silent'>, message: string, fields?: LogFields) => {
    if (LEVEL_RANK[level] < LEVEL_RANK[parseLogLevel()]) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [${component}] ${sanitizeLogText(message, 400)}${formatFields(fields)}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields)
  };
}
