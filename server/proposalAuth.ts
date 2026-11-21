import type { Request, RequestHandler } from 'express';
import { createLogger } from './logger.js';

const log = createLogger('focuswiki');
const verified = new WeakMap<Request, { login: string; canPublish: boolean }>();

// Called only by the Serve access gate after channel, identity and origin checks.
export function recordServeIdentity(req: Request, login: string, canPublish: boolean): void {
  verified.set(req, { login, canPublish });
}

/** Route middleware for the managed Git review and proposal handlers. */
export const proposalAuth: RequestHandler = (req, res, next) => {
  const identity = verified.get(req);
  if (!identity) {
    log.warn('Blocked proposal request', { error: 'identity_required', method: req.method, path: req.path });
    res.status(401).json({ error: 'identity_required' });
    return;
  }
  if (req.method === 'POST' && !identity.canPublish) {
    log.warn('Blocked proposal request', { error: 'publisher_required', method: req.method, path: req.path });
    res.status(403).json({ error: 'publisher_required' });
    return;
  }
  res.locals.proposalActor = identity.login;
  next();
};
