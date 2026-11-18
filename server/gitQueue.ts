import { GitRpcError } from './gitProtocol.js';

interface Job {
  key: string;
  start: () => void;
}

/** Bound waiting and running jobs, with exclusive access per checkout. */
export class GitQueue {
  private readonly active = new Set<string>();
  private readonly waiting: Job[] = [];
  private readonly shutdown = new AbortController();

  constructor(private readonly concurrency = 2, private readonly waitCapacity = 16) {}

  canRunInBackground(key: string): boolean {
    return !this.shutdown.signal.aborted && this.active.size < this.concurrency &&
      !this.active.has(key) && this.waiting.length === 0;
  }

  run<T>(key: string, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const jobSignal = AbortSignal.any([signal, this.shutdown.signal]);
    if (jobSignal.aborted) return Promise.reject(new GitRpcError('git_timeout'));
    const canStart = this.canRunInBackground(key);
    if (!canStart && this.waiting.length >= this.waitCapacity) return Promise.reject(new GitRpcError('git_busy'));
    return new Promise<T>((resolve, reject) => {
      const cancelWaiting = () => {
        const index = this.waiting.indexOf(job);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new GitRpcError('git_timeout'));
        this.drain();
      };
      const job = {
        key,
        start: () => {
          jobSignal.removeEventListener('abort', cancelWaiting);
          this.active.add(key);
          Promise.resolve().then(() => {
            jobSignal.throwIfAborted();
            return work(jobSignal);
          }).then(resolve, reject).finally(() => {
            this.active.delete(key);
            this.drain();
          });
        }
      };

      if (canStart) job.start();
      else {
        this.waiting.push(job);
        jobSignal.addEventListener('abort', cancelWaiting, { once: true });
        this.drain();
      }
    });
  }

  close(): void {
    this.shutdown.abort();
  }

  private drain(): void {
    while (!this.shutdown.signal.aborted && this.active.size < this.concurrency) {
      const index = this.waiting.findIndex(({ key }) => !this.active.has(key));
      if (index < 0) return;
      this.waiting.splice(index, 1)[0].start();
    }
  }
}
