import type { ProjectSummary } from '../../shared/types';

// Accept both the legacy status response and managed status reported by the Git service.
export type ProjectGitStatusView = Pick<
  ProjectSummary['git'],
  'branch' | 'headSha' | 'ahead' | 'behind' | 'changedFiles'
> & {
  isClean: boolean | null;
  state?: 'ready' | 'unmanaged' | 'pending' | 'unavailable';
  changesTruncated?: boolean;
  fetchState?: 'pending' | 'current' | 'unavailable';
};

export function managedGitLabel(status: ProjectGitStatusView): string {
  switch (status.state) {
    case 'ready': return 'Managed Git ready';
    case 'pending': return 'Managed Git pending';
    case 'unavailable': return 'Managed Git unavailable';
    case 'unmanaged': return 'Managed Git not enabled';
    default: return status.branch === 'uninitialized' ? 'No Git checkout' : 'Managed Git status unconfirmed';
  }
}

export function hasWorkingTreeStatus(status: ProjectGitStatusView): boolean {
  return status.isClean !== null && status.branch !== 'uninitialized';
}

export function workingTreeLabel(status: ProjectGitStatusView): string {
  if (!hasWorkingTreeStatus(status)) return managedGitLabel(status);
  if (status.isClean) return 'Working copy clean';

  const count = status.changedFiles.length;
  return `${status.changesTruncated ? 'At least ' : ''}${count} changed ${count === 1 ? 'file' : 'files'} on disk`;
}
