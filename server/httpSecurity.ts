import { isIP } from 'node:net';
import type { Socket } from 'node:net';
import { Router, type Request, type RequestHandler } from 'express';
import { createLogger } from './logger.js';
import { proposalAuth, recordServeIdentity } from './proposalAuth.js';

const log = createLogger('focuswiki');

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

const LOGIN_SYNTAX = /^[^\s,@\x00-\x1f\x7f-\uffff]+@[^\s,@\x00-\x1f\x7f-\uffff]+$/;

function validLogin(login: string): boolean {
  return login.length <= 256 && !login.startsWith('=?') && LOGIN_SYNTAX.test(login);
}

export interface ServeAccessOptions {
  origin: string;
  publishers: string[];
  trustedConnections: WeakSet<Socket>;
}

function singleHeader(req: Request, name: string): string | undefined {
  const values = req.headersDistinct[name];
  return values?.length === 1 ? values[0] : undefined;
}

function createServeAccess(options: ServeAccessOptions): RequestHandler {
  const browser = URL.parse(options.origin);
  if (!browser || browser.protocol !== 'https:' || browser.origin !== options.origin ||
      !browser.hostname.endsWith('.ts.net') || !validateHost(browser.host)) {
    throw new Error('FOCUSWIKI_PUBLIC_ORIGIN must be an exact HTTPS Tailscale Serve origin.');
  }
  const publishers = new Set(options.publishers);
  if ([...publishers].some((login) => !validLogin(login))) {
    throw new Error('FOCUSWIKI_PUBLISHERS must contain exact Tailscale user logins.');
  }

  return (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!options.trustedConnections.has(req.socket)) {
      log.warn('Blocked HTTP request', { error: 'untrusted_proxy', method: req.method, path: req.path });
      res.status(403).json({ error: 'untrusted_proxy' });
      return;
    }
    const login = singleHeader(req, 'tailscale-user-login');
    if (!login || !validLogin(login) || req.headersDistinct['tailscale-funnel-request']) {
      log.warn('Blocked HTTP request', {
        error: 'identity_required',
        method: req.method,
        path: req.path,
        funnel: Boolean(req.headersDistinct['tailscale-funnel-request'])
      });
      res.status(401).json({ error: 'identity_required' });
      return;
    }
    // Serve may set the backend Host to localhost for Unix socket targets.
    const forwardedHost = singleHeader(req, 'x-forwarded-host');
    if (validateHost(forwardedHost) !== browser.host || singleHeader(req, 'x-forwarded-proto') !== 'https') {
      log.warn('Blocked HTTP request', {
        error: 'origin_blocked',
        method: req.method,
        path: req.path,
        expectedHost: browser.host
      });
      res.status(403).json({ error: 'origin_blocked' });
      return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const fetchSite = req.headersDistinct['sec-fetch-site'];
      if (singleHeader(req, 'origin') !== browser.origin ||
          (fetchSite && (fetchSite.length !== 1 || fetchSite[0] !== 'same-origin'))) {
        log.warn('Blocked HTTP request', { error: 'csrf_blocked', method: req.method, path: req.path });
        res.status(403).json({ error: 'csrf_blocked' });
        return;
      }
    }
    res.locals.browserOrigin = browser.origin;
    recordServeIdentity(req, login, publishers.has(login));
    next();
  };
}

export function createHttpSecurity(options: { allowedHosts?: string[]; serveAccess?: ServeAccessOptions } = {}): RequestHandler {
  const allowed = (options.allowedHosts ?? (process.env.FOCUSWIKI_ALLOWED_HOSTS ?? '').split(','))
    .map((entry) => validateHost(entry.trim())).filter((entry): entry is string => entry !== null);
  const security = Router();
  security.use((req, res, next) => {
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
    if (options.serveAccess) {
      next();
      return;
    }
    const name = hostName(host).replace(/\.$/, '');
    const ip = name.startsWith('[') ? name.slice(1, -1) : name;
    if (!isIP(ip) && name.includes('.') && !LAN_SUFFIXES.some((suffix) => name.endsWith(suffix)) && !explicitlyAllowed(host, allowed)) {
      res.status(403).json({ error: 'host_blocked', message: 'Host is not an allowed LAN hostname.' });
      return;
    }
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
  });
  if (options.serveAccess) {
    security.use(createServeAccess(options.serveAccess));
    security.get('/api/projects/:projectId/git/diff', proposalAuth);
    security.post('/api/projects/:projectId/git/propose', proposalAuth);
  }
  return security;
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
    if (!read && !write && !(req.method === 'POST' && /^\/api\/projects\/[^/]+\/git\/propose\/?$/i.test(req.path))) {
      next();
      return;
    }
    const now = Date.now();
    const bucket = /^\/api\/projects\/[^/]+\/git\//i.test(req.path) ? 'git' : 'browse';
    const key = `${req.socket.remoteAddress ?? 'unknown'}:${bucket}`;
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
