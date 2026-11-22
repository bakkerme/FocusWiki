import { createConnection } from 'node:net';
import { enrollmentBinding, type EnrolledProject } from './enrollment.js';
import {
  DEFAULT_GIT_SOCKET, GitRpcError, MAX_GIT_REQUEST_BYTES, MAX_GIT_RESPONSE_BYTES, readGitError,
  type GitRequest, type GitStatuses, type GitUpdateResult, type ProposalInput, type ProposalReview, type PublishedProposal
} from './gitProtocol.js';

export class GitSocketClient {
  constructor(private readonly socketPath = DEFAULT_GIT_SOCKET) {}

  statuses(signal?: AbortSignal): Promise<GitStatuses> {
    return this.request({ verb: 'statuses' }, 750, signal);
  }

  review(project: EnrolledProject, actor: string, signal?: AbortSignal): Promise<ProposalReview> {
    return this.request({ verb: 'review', projectId: project.id, binding: enrollmentBinding(project), actor }, 30_000, signal);
  }

  update(project: EnrolledProject, actor: string, signal?: AbortSignal): Promise<GitUpdateResult> {
    return this.request({ verb: 'update', projectId: project.id, binding: enrollmentBinding(project), actor }, 65_000, signal);
  }

  propose(project: EnrolledProject, actor: string, input: ProposalInput, signal?: AbortSignal): Promise<PublishedProposal> {
    return this.request({ verb: 'propose', projectId: project.id, binding: enrollmentBinding(project), actor, input }, 90_000, signal);
  }

  private request<T>(request: GitRequest, timeout: number, signal?: AbortSignal): Promise<T> {
    const frame = Buffer.from(JSON.stringify(request) + '\n');
    if (frame.length > MAX_GIT_REQUEST_BYTES) return Promise.reject(new GitRpcError('invalid_git_request'));
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(new GitRpcError('git_timeout'));
      const socket = createConnection(this.socketPath);
      let received = 0;
      const chunks: Buffer[] = [];

      function finish(error?: GitRpcError, result?: T) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        socket.destroy();
        if (error) reject(error);
        else resolve(result as T);
      }

      const abort = () => finish(new GitRpcError('git_timeout'));
      const timer = setTimeout(abort, timeout);
      signal?.addEventListener('abort', abort, { once: true });
      socket.on('error', () => finish(new GitRpcError('git_unavailable')));
      socket.on('close', () => finish(new GitRpcError('git_unavailable')));
      socket.once('connect', () => socket.write(frame));
      socket.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_GIT_RESPONSE_BYTES) return finish(new GitRpcError('git_response_too_large'));
        chunks.push(chunk);
        if (chunk.at(-1) !== 10) return;
        try {
          const reply = JSON.parse(Buffer.concat(chunks, received).toString('utf8'));
          if (!reply || typeof reply !== 'object') throw new Error('Invalid reply.');
          if (reply.ok === true && reply.result && typeof reply.result === 'object') finish(undefined, reply.result as T);
          else finish(readGitError(reply.error));
        } catch {
          finish(new GitRpcError('git_unavailable'));
        }
      });
    });
  }
}
