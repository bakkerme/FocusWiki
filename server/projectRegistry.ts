import fs from 'node:fs';
import path from 'node:path';
import type { ProjectConfig, ProjectGitStatus } from '../shared/types.js';
import { enrollmentBinding, isLocalProject, type EnrolledProject, type EnrollmentEntry } from './enrollment.js';

export interface EnrollmentSyncDiff {
  added: ProjectConfig[];
  removed: string[];
  updated: ProjectConfig[];
  rootChanged: string[];
  changed: boolean;
}

export class ProjectRegistry {
  private readonly projects = new Map<string, ProjectConfig>();
  private readonly enrolled = new Map<string, EnrolledProject>();
  private readonly enrollmentDirs?: { reposDir: string; localReposDir?: string };
  private lastEntries?: EnrollmentEntry[];

  constructor(
    projects: ProjectConfig[],
    enrollment?: { projects: EnrollmentEntry[]; reposDir: string; localReposDir?: string }
  ) {
    if (enrollment) {
      this.enrollmentDirs = {
        reposDir: enrollment.reposDir,
        localReposDir: enrollment.localReposDir
      };
      this.syncEnrollment(enrollment.projects);
    } else {
      // Operator-supplied browse-only roots, including the fictional samples.
      for (const project of projects) {
        const { id, name, description, rootPath, defaultDoc } = project;
        this.projects.set(id, { id, name, description, defaultDoc, rootPath: path.resolve(rootPath) });
      }
    }
  }

  syncEnrollment(entries: EnrollmentEntry[]): EnrollmentSyncDiff {
    if (!this.enrollmentDirs) {
      throw new Error('Cannot sync enrollment on a non-enrollment ProjectRegistry.');
    }
    const nextProjects = new Map<string, ProjectConfig>();
    const nextEnrolled = new Map<string, EnrolledProject>();
    for (const project of entries) {
      if (isLocalProject(project)) {
        if (!this.enrollmentDirs.localReposDir) {
          throw new Error(`Local project "${project.id}" requires FOCUSWIKI_LOCAL_REPOS_DIR.`);
        }
        nextProjects.set(project.id, {
          id: project.id,
          name: project.name,
          description: '',
          defaultDoc: project.defaultDoc ?? 'README.md',
          rootPath: path.resolve(this.enrollmentDirs.localReposDir, project.id)
        });
        continue;
      }
      nextEnrolled.set(project.id, project);
      nextProjects.set(project.id, {
        id: project.id,
        name: project.name,
        description: '',
        defaultDoc: project.defaultDoc ?? 'README.md',
        rootPath: path.resolve(this.enrollmentDirs.reposDir, project.id)
      });
    }

    const added: ProjectConfig[] = [];
    const removed: string[] = [];
    const updated: ProjectConfig[] = [];
    const rootChanged: string[] = [];

    for (const id of this.projects.keys()) {
      if (!nextProjects.has(id)) removed.push(id);
    }
    for (const [id, nextProject] of nextProjects) {
      const prevProject = this.projects.get(id);
      if (!prevProject) {
        added.push(nextProject);
        continue;
      }
      const prevManaged = this.enrolled.get(id);
      const nextManaged = nextEnrolled.get(id);
      const prevBind = prevManaged ? enrollmentBinding(prevManaged) : null;
      const nextBind = nextManaged ? enrollmentBinding(nextManaged) : null;
      if (prevProject.rootPath !== nextProject.rootPath) {
        rootChanged.push(id);
      }
      if (prevProject.name !== nextProject.name ||
          prevProject.defaultDoc !== nextProject.defaultDoc ||
          prevProject.rootPath !== nextProject.rootPath ||
          prevBind !== nextBind) {
        updated.push(nextProject);
      }
    }

    this.projects.clear();
    for (const [id, project] of nextProjects) this.projects.set(id, project);
    this.enrolled.clear();
    for (const [id, project] of nextEnrolled) this.enrolled.set(id, project);
    this.lastEntries = entries.map((entry) => ({ ...entry }));

    const changed = added.length > 0 || removed.length > 0 || updated.length > 0;
    return { added, removed, updated, rootChanged, changed };
  }

  enrollmentSnapshot(): EnrollmentEntry[] | undefined {
    return this.lastEntries?.map((entry) => ({ ...entry }));
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
