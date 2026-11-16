export interface ProjectConfig {
  id: string;
  name: string;
  description: string;
  rootPath: string;
  defaultDoc: string;
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
