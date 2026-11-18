export interface ProjectSourceMeta {
  originType?: 'managed-clone' | 'local-link' | 'initialized';
  remoteUrl?: string;
  importedAt?: string;
}

export interface ProjectConfig {
  id: string;
  name: string;
  description: string;
  rootPath: string;
  defaultDoc: string;
  source?: ProjectSourceMeta;
}

export interface GitChangedFile {
  path: string;
  oldPath?: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | string;
}

export interface GitRepoStatus {
  branch: string;
  headSha: string;
  headSubject: string;
  isClean: boolean;
  changedFiles: GitChangedFile[];
  statusIncomplete?: boolean;
  remoteName?: string | null;
  remoteUrl?: string | null;
  ahead?: number;
  behind?: number;
}

export interface GitBranchEntry {
  name: string;
  kind: 'local' | 'remote';
  remote?: string;
  upstream?: string;
  sha: string;
  subject: string;
  isCurrent: boolean;
}

export interface GitPullRequestRef {
  number: number;
  ref: string;
  sha: string;
  localBranch: string;
  checkedOut: boolean;
  subject?: string;
}

export interface GitRefsPayload {
  status: GitRepoStatus;
  hasRemote: boolean;
  remoteName: string | null;
  remoteUrl: string | null;
  ahead: number;
  behind: number;
  branches: GitBranchEntry[];
  pullRequests: GitPullRequestRef[];
}

export interface RepoInspectionResult {
  valid: boolean;
  path: string;
  suggestedId: string;
  suggestedName: string;
  suggestedDefaultDoc: string;
  docCount: number;
  embedCount: number;
  scanIncomplete?: boolean;
  isGitRepo: boolean;
  branch?: string;
  remoteUrl?: string | null;
  alreadyRegisteredId?: string | null;
  error?: string;
}

export interface RemoteInspectResult {
  url: string;
  defaultBranch: string | null;
  branches: string[];
  pullRequests: Array<{ number: number; ref: string; sha: string }>;
}

export interface GitCredentialSummary {
  id: string;
  host: string;
  username: string;
  maskedHint: string;
  source: 'stored' | 'env';
  updatedAt?: string;
}

export interface ServerEnvironmentInfo {
  managedReposDir: string;
  allowedImportRoots: string[];
  configPath: string | null;
  credentialsPath: string | null;
  encryptionMode: 'env-key' | 'file-key' | 'memory-only';
  sshClientAvailable: boolean;
  projectCount: number;
}

export interface DocTreeEntry {
  path: string;
  title: string;
  updatedAt: string;
  openComments: number;
}

export interface EmbedAssetEntry {
  src: string;
  name: string;
  directory: string;
  files: string[];
}

export interface ProjectSummary extends ProjectConfig {
  git: GitRepoStatus;
  docs: DocTreeEntry[];
  embeds: EmbedAssetEntry[];
  scanIncomplete?: boolean;
  watchIncomplete?: boolean;
}

export interface EmbedDescriptor {
  src: string;
  title: string;
  height: number;
  props: Record<string, unknown>;
}

export interface CommentAnchor {
  quote: string;
  prefix: string;
  suffix: string;
  headingContext?: string;
}

export type AnchorStatus = 'attached' | 'orphaned' | 'ambiguous';

export interface CommentMessage {
  id: string;
  author: string;
  role: 'human' | 'bot';
  createdAt: string;
  body: string;
}

export interface CommentHistoryEvent {
  action: 'created' | 'replied' | 'resolved' | 'reopened';
  actor: string;
  role: 'human' | 'bot';
  at: string;
  note?: string;
}

export interface CommentThread {
  id: string;
  status: 'open' | 'resolved';
  createdAt: string;
  updatedAt: string;
  anchor: CommentAnchor;
  messages: CommentMessage[];
  history: CommentHistoryEvent[];
}

export interface ResolvedCommentThread extends CommentThread {
  anchorStatus: AnchorStatus;
  anchorReason?: string;
  blockIndex?: number;
  blockOffset?: number;
}

export interface CommentSidecarFile {
  version: 1;
  document: string;
  threads: CommentThread[];
}

export interface ProseMirrorMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface ProseMirrorNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ProseMirrorNode[];
  marks?: ProseMirrorMark[];
  text?: string;
}

export interface DocumentPayload {
  projectId: string;
  path: string;
  markdown: string;
  revision: string;
  mtimeMs: number;
  docJson: ProseMirrorNode;
  comments: ResolvedCommentThread[];
  conflicts: string[];
  conflictsIncomplete?: boolean;
}

export interface ConflictErrorPayload {
  error: 'revision_conflict';
  message: string;
  path: string;
  diskRevision: string;
  diskMarkdown: string;
  yourMarkdown: string;
  savedConflictCopyPath: string;
}

export interface SearchResultItem {
  projectId: string;
  projectName: string;
  path: string;
  title: string;
  line: number;
  snippet: string;
}

/** Optional client request fields; omitted commit paths retain whole-checkout behavior. */
export interface GitCommitSelection {
  paths?: string[];
}

export interface CloneOptions {
  shallow?: boolean;
}
