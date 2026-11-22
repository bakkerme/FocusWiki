import { createHash } from 'node:crypto';
import type { GitChangeReviewPayload } from '../shared/changeReview.js';
import type { ProjectGitStatus } from '../shared/types.js';
import { validProjectFile, validProjectId } from './enrollment.js';

export const DEFAULT_GIT_SOCKET = '/run/focuswiki/git.sock';
export const MAX_GIT_REQUEST_BYTES = 128 * 1024;
export const MAX_GIT_RESPONSE_BYTES = 8 * 1024 * 1024;
export function isGitSha(value: unknown): value is string {
  return typeof value === 'string' && (value.length === 40 || value.length === 64) &&
    !/[^a-f0-9]/.test(value);
}

export interface ProposalContext {
  projectId: string;
  workTree: string;
  gitDir: string;
  remote: string;
  branch: string;
}

export interface ProposalInput {
  reviewId: string;
  message: string;
  paths: string[];
}

export interface ProposalReview extends GitChangeReviewPayload {
  reviewId: string;
}

export interface PublishedProposal {
  url: string;
  sha: string;
}

export interface GitUpdateResult {
  updated: boolean;
  previousSha: string;
  headSha: string;
  status: ProjectGitStatus;
}

export interface ProposalService {
  /** The companion validates the PR base branch against the worker-owned HEAD. */
  enforcesManagedBase?: true;
  reviewProposal(ctx: ProposalContext): Promise<ProposalReview>;
  publishProposal(ctx: ProposalContext, input: ProposalInput): Promise<PublishedProposal>;
  getRepoToken(ctx: ProposalContext, mode: 'read' | 'write'): Promise<string>;
}

export type GitRequest =
  | { verb: 'statuses' }
  | { verb: 'review'; projectId: string; binding: string; actor: string }
  | { verb: 'update'; projectId: string; binding: string; actor: string }
  | { verb: 'propose'; projectId: string; binding: string; actor: string; input: ProposalInput };

export type GitStatuses = Record<string, ProjectGitStatus>;
export type GitResult = GitStatuses | ProposalReview | PublishedProposal | GitUpdateResult;

const failures = {
  git_unavailable: [503, 'Managed Git is unavailable. Try again later.'],
  git_not_ready: [503, 'The managed checkout is not ready.'],
  git_busy: [503, 'Managed Git is busy. Try again shortly.'],
  git_timeout: [504, 'The managed Git request timed out.'],
  git_dirty_worktree: [409, 'Save or propose local changes before pulling upstream updates.'],
  git_not_fast_forward: [409, 'Upstream history cannot be fast-forwarded cleanly.'],
  proposal_auth_required: [403, 'Verified proposal authorization is required.'],
  proposal_unavailable: [503, 'Git proposals are unavailable.'],
  invalid_git_request: [400, 'Invalid managed Git request.'],
  unknown_git_project: [404, 'The project is not enrolled for managed Git.'],
  proposal_conflict: [409, 'The review is stale or the base branch has moved. Refresh the review before retrying.'],
  proposal_rejected: [422, 'The proposal could not be completed with the selected files.'],
  git_operation_failed: [502, 'The managed Git operation failed.'],
  git_response_too_large: [413, 'The Git result exceeds the review size limit.']
} as const;

export type GitFailureCode = keyof typeof failures;

export class GitRpcError extends Error {
  readonly status: number;
  /** Internal diagnostic reason for server logs only; never returned to clients. */
  readonly detail?: string;
  constructor(readonly code: GitFailureCode, detail?: string) {
    super(failures[code][1]);
    this.status = failures[code][0];
    this.detail = detail;
  }
}

export function readGitError(code: unknown): GitRpcError {
  return new GitRpcError(typeof code === 'string' && Object.hasOwn(failures, code)
    ? code as GitFailureCode : 'git_unavailable');
}

function exactKeys(value: object, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function validProposalActor(actor: unknown): actor is string {
  return typeof actor === 'string' && actor === actor.trim() && /^[!-~]{1,256}$/.test(actor);
}

export function proposalBranch(actor: string, nonce: string): string {
  const digest = createHash('sha256').update(JSON.stringify([actor, nonce])).digest('hex');
  return `focuswiki/${digest.slice(0, 40)}`;
}

export function unwrapReviewId(reviewId: string): { nonce: string; innerId: string } {
  const match = /^([a-f0-9-]{36})\.([!-~]{1,475})$/.exec(reviewId);
  if (match?.[0] !== reviewId) throw new GitRpcError('invalid_git_request');
  return { nonce: match[1], innerId: match[2] };
}

export function parseProposalInput(input: unknown): ProposalInput {
  const value = input as Partial<ProposalInput> | null;
  if (!value || typeof value !== 'object' || !exactKeys(value, ['reviewId', 'message', 'paths']) ||
      typeof value.reviewId !== 'string' || value.reviewId !== value.reviewId.trim() || !/^[!-~]{1,512}$/.test(value.reviewId) ||
      typeof value.message !== 'string' || !value.message.trim() || value.message.includes('\0') ||
      Buffer.byteLength(value.message) > 8192 ||
      !Array.isArray(value.paths) || !value.paths.length || value.paths.length > 100 ||
      !value.paths.every(validProjectFile) || new Set(value.paths).size !== value.paths.length) {
    throw new GitRpcError('invalid_git_request');
  }
  return { reviewId: value.reviewId, message: value.message, paths: value.paths };
}

export function parseGitRequest(raw: Buffer): GitRequest {
  const value = JSON.parse(raw.toString('utf8')) as { verb?: unknown; projectId?: unknown; binding?: unknown; actor?: unknown; input?: unknown } | null;
  if (value && typeof value === 'object') {
    if (value.verb === 'statuses' && exactKeys(value, ['verb'])) return { verb: 'statuses' };
    if (validProjectId(value.projectId) && typeof value.binding === 'string' &&
        value.binding.length === 64 && isGitSha(value.binding) && validProposalActor(value.actor)) {
      if (value.verb === 'review' && exactKeys(value, ['verb', 'projectId', 'binding', 'actor'])) {
        return { verb: 'review', projectId: value.projectId, binding: value.binding, actor: value.actor };
      }
      if (value.verb === 'update' && exactKeys(value, ['verb', 'projectId', 'binding', 'actor'])) {
        return { verb: 'update', projectId: value.projectId, binding: value.binding, actor: value.actor };
      }
      if (value.verb === 'propose' && exactKeys(value, ['verb', 'projectId', 'binding', 'actor', 'input'])) {
        return { verb: 'propose', projectId: value.projectId, binding: value.binding, actor: value.actor, input: parseProposalInput(value.input) };
      }
    }
  }
  throw new GitRpcError('invalid_git_request');
}
