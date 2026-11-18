import { isIP } from 'node:net';
import type { RequestHandler } from 'express';

const HOST_SYNTAX = /^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/;
const LAN_SUFFIXES = ['.local', '.lan', '.internal', '.home.arpa', '.ts.net'];

/** Returns a normalized authority, never an interpolatable unvalidated header. */
export function validateHost(value: string | undefined): string | null {
  if (!value || /[\s\x00-\x1f\x7f]/.test(value) || !HOST_SYNTAX.test(value)) return null;
  const port = /:(\d+)$/.exec(value)?.[1];
  if (port && Number(port) > 65535) return null;
  const hostname = hostName(value);
  if (value.startsWith('[')) {
    if (isIP(hostname.slice(1, -1)) !== 6) return null;
  } else if (hostname.length > 253 || !hostname.replace(/\.$/, '').split('.').every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) {
    return null;
  }
  return value.toLowerCase();
}

function hostName(host: string): string {
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
}

function explicitlyAllowed(host: string, allowed: string[]): boolean {
  return allowed.some((entry) => entry === host || entry === hostName(host));
}

export function createHttpSecurity(options: { allowedHosts?: string[] } = {}): RequestHandler {
  const allowed = (options.allowedHosts ?? (process.env.FOCUSWIKI_ALLOWED_HOSTS ?? '').split(','))
    .map((entry) => validateHost(entry.trim())).filter((entry): entry is string => entry !== null);
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    const routePath = req.path.toLowerCase();
    if (!routePath.startsWith('/embed-sandbox/')) {
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Content-Security-Policy', [
        "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self'",
        "frame-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'"
      ].join('; '));
    }
    const host = validateHost(req.get('host'));
    if (!host) {
      res.status(400).json({ error: 'invalid_host', message: 'Invalid Host header.' });
      return;
    }
    const name = hostName(host).replace(/\.$/, '');
    const ip = name.startsWith('[') ? name.slice(1, -1) : name;
    if (!isIP(ip) && name.includes('.') && !LAN_SUFFIXES.some((suffix) => name.endsWith(suffix)) && !explicitlyAllowed(host, allowed)) {
      res.status(403).json({ error: 'host_blocked', message: 'Host is not an allowed LAN hostname.' });
      return;
    }
    res.locals.validatedHost = host;
    if (routePath.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      let blocked = req.get('sec-fetch-site')?.toLowerCase() === 'cross-site';
      const origin = req.get('origin');
      if (origin !== undefined) {
        try {
          const parsed = new URL(origin);
          const originHost = validateHost(parsed.host);
          blocked ||= !['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || !originHost || (originHost !== host && !explicitlyAllowed(originHost, allowed));
        } catch {
          blocked = true;
        }
      }
      if (blocked) {
        res.status(403).json({ error: 'csrf_blocked', message: 'Cross-origin API mutations are forbidden.' });
        return;
      }
    }
    next();
  };
}

export interface RateLimitOptions {
  maxRequests?: number;
  windowMs?: number;
}

/** A bounded per-peer sliding window. Proxy-supplied IP headers are deliberately ignored. */
export function createExpensiveRequestLimiter(options: RateLimitOptions = {}): RequestHandler {
  const positive = (value: number, fallback: number) => Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
  const max = positive(options.maxRequests ?? Number(process.env.FOCUSWIKI_RATE_LIMIT_MAX ?? 60), 60);
  const windowMs = positive(options.windowMs ?? Number(process.env.FOCUSWIKI_RATE_LIMIT_WINDOW_MS ?? 60000), 60000);
  const peers = new Map<string, number[]>();
  return (req, res, next) => {
    const read = ['GET', 'HEAD'].includes(req.method) && /^\/api\/(?:search|projects|projects\/[^/]+\/git\/diff)\/?$/i.test(req.path);
    const write = req.method === 'POST' && /^\/api\/(?:projects\/(?:inspect-local|inspect-remote|import)|(?:settings\/)?credentials\/test|projects\/[^/]+\/git\/(?:fetch|pull))\/?$/i.test(req.path);
    if (!read && !write) {
      next();
      return;
    }
    const now = Date.now();
    const key = `${req.socket.remoteAddress ?? 'unknown'}:${read ? 'read' : 'write'}`;
    for (const [peer, timestamps] of peers) {
      if (timestamps[timestamps.length - 1] <= now - windowMs) peers.delete(peer);
    }
    const recent = (peers.get(key) ?? []).filter((at) => at > now - windowMs);
    if (recent.length >= max || (!peers.has(key) && peers.size >= 4096)) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(((recent[0] ?? now) + windowMs - now) / 1000))));
      res.status(429).json({ error: 'rate_limited', message: 'Too many expensive requests. Please retry shortly.' });
      return;
    }
    recent.push(now);
    peers.set(key, recent);
    next();
  };
}
