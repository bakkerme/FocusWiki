import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CommentAnchor,
  CommentSidecarFile,
  CommentThread
} from '../shared/types.js';
import { writeFileAtomicSync } from './fileLock.js';
import { resolveSafeProjectPath } from './pathGuard.js';

export class CommentNotFoundError extends Error {
  public readonly statusCode = 404;

  constructor(threadId: string) {
    super(`Comment thread "${threadId}" not found.`);
    this.name = 'CommentNotFoundError';
  }
}

export function getCommentSidecarRelPath(docRelPath: string): string {
  if (docRelPath.endsWith('.md')) {
    return `${docRelPath.slice(0, -3)}.comments.json`;
  }
  return `${docRelPath}.comments.json`;
}

export function readCommentSidecar(projectRoot: string, docRelPath: string): CommentSidecarFile {
  const sidecarRel = getCommentSidecarRelPath(docRelPath);
  const { absolutePath } = resolveSafeProjectPath(projectRoot, sidecarRel);
  if (!fs.existsSync(absolutePath)) {
    return {
      version: 1,
      document: docRelPath,
      threads: []
    };
  }
  try {
    const raw = fs.readFileSync(absolutePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CommentSidecarFile>;
    return {
      version: 1,
      document: docRelPath,
      threads: Array.isArray(parsed.threads) ? parsed.threads : []
    };
  } catch {
    return {
      version: 1,
      document: docRelPath,
      threads: []
    };
  }
}

export function writeCommentSidecar(
  projectRoot: string,
  docRelPath: string,
  sidecar: CommentSidecarFile
): void {
  const sidecarRel = getCommentSidecarRelPath(docRelPath);
  const { absolutePath } = resolveSafeProjectPath(projectRoot, sidecarRel);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o770 });
  writeFileAtomicSync(absolutePath, `${JSON.stringify(sidecar, null, 2)}\n`, 0o660);
}

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export function createCommentThread(
  projectRoot: string,
  docRelPath: string,
  input: {
    anchor: CommentAnchor;
    author: string;
    role: 'human' | 'bot';
    body: string;
  }
): CommentThread {
  const now = new Date().toISOString();
  const sidecar = readCommentSidecar(projectRoot, docRelPath);
  const thread: CommentThread = {
    id: makeId('thr'),
    status: 'open',
    createdAt: now,
    updatedAt: now,
    anchor: {
      quote: input.anchor.quote,
      prefix: input.anchor.prefix ?? '',
      suffix: input.anchor.suffix ?? '',
      ...(input.anchor.headingContext ? { headingContext: input.anchor.headingContext } : {})
    },
    messages: [
      {
        id: makeId('msg'),
        author: input.author.trim() || 'Reviewer',
        role: input.role,
        createdAt: now,
        body: input.body.trim()
      }
    ],
    history: [
      {
        action: 'created',
        actor: input.author.trim() || 'Reviewer',
        role: input.role,
        at: now
      }
    ]
  };
  sidecar.threads.push(thread);
  writeCommentSidecar(projectRoot, docRelPath, sidecar);
  return thread;
}

export function addCommentReply(
  projectRoot: string,
  docRelPath: string,
  threadId: string,
  input: {
    author: string;
    role: 'human' | 'bot';
    body: string;
  }
): CommentThread {
  const now = new Date().toISOString();
  const sidecar = readCommentSidecar(projectRoot, docRelPath);
  const thread = sidecar.threads.find((t) => t.id === threadId);
  if (!thread) {
    throw new CommentNotFoundError(threadId);
  }
  const actor = input.author.trim() || 'Reviewer';
  thread.messages.push({
    id: makeId('msg'),
    author: actor,
    role: input.role,
    createdAt: now,
    body: input.body.trim()
  });
  thread.history.push({
    action: 'replied',
    actor,
    role: input.role,
    at: now
  });
  thread.updatedAt = now;
  writeCommentSidecar(projectRoot, docRelPath, sidecar);
  return thread;
}

export function updateCommentStatus(
  projectRoot: string,
  docRelPath: string,
  threadId: string,
  input: {
    status: 'open' | 'resolved';
    actor: string;
    role: 'human' | 'bot';
    note?: string;
  }
): CommentThread {
  const now = new Date().toISOString();
  const sidecar = readCommentSidecar(projectRoot, docRelPath);
  const thread = sidecar.threads.find((t) => t.id === threadId);
  if (!thread) {
    throw new CommentNotFoundError(threadId);
  }
  const actor = input.actor.trim() || 'Reviewer';
  thread.status = input.status;
  thread.updatedAt = now;
  thread.history.push({
    action: input.status === 'resolved' ? 'resolved' : 'reopened',
    actor,
    role: input.role,
    at: now,
    ...(input.note?.trim() ? { note: input.note.trim() } : {})
  });
  writeCommentSidecar(projectRoot, docRelPath, sidecar);
  return thread;
}
