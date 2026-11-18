import fs from 'node:fs';
import path from 'node:path';
import type { ProjectConfig, ProjectGitStatus } from '../shared/types.js';
import type { EnrolledProject } from './enrollment.js';

export class ProjectRegistry {
  private readonly projects = new Map<string, ProjectConfig>();
  private readonly enrolled = new Map<string, EnrolledProject>();

  constructor(projects: ProjectConfig[], enrollment?: { projects: EnrolledProject[]; reposDir: string }) {
    if (enrollment) {
      for (const project of enrollment.projects) {
        this.enrolled.set(project.id, project);
        this.projects.set(project.id, {
          id: project.id,
          name: project.name,
          description: '',
          defaultDoc: project.defaultDoc ?? 'README.md',
          rootPath: path.resolve(enrollment.reposDir, project.id)
        });
      }
    } else {
      // Operator-supplied browse-only roots, including the fictional samples.
      for (const project of projects) {
        const { id, name, description, rootPath, defaultDoc } = project;
        this.projects.set(id, { id, name, description, defaultDoc, rootPath: path.resolve(rootPath) });
      }
    }
  }

  list(): ProjectConfig[] {
    return [...this.projects.values()];
  }

  get(projectId: string): ProjectConfig | undefined {
    return this.projects.get(projectId);
  }

  managed(projectId: string): EnrolledProject | undefined {
    return this.enrolled.get(projectId);
  }
}

export function hasWorkingTree(root: string): boolean {
  try {
    return fs.lstatSync(root).isDirectory() && fs.realpathSync(root) === root;
  } catch {
    return false;
  }
}

export function unavailableGitStatus(
  project?: EnrolledProject,
  state: 'pending' | 'unavailable' = 'unavailable'
): ProjectGitStatus {
  return {
    state: project ? state : 'unmanaged',
    branch: project?.branch ?? '',
    remoteUrl: project?.remote ?? null,
    headSha: '',
    headSubject: '',
    isClean: null,
    changedFiles: []
  };
}
