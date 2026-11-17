import type { DocTreeEntry } from '../../shared/types';

export interface DocTreeFileNode {
  kind: 'file';
  doc: DocTreeEntry;
  name: string;
  dirPath: string;
  isOverview: boolean;
  isDefault: boolean;
}

export interface DocTreeFolderNode {
  kind: 'folder';
  key: string;
  label: string;
  depth: number;
  folders: DocTreeFolderNode[];
  overviewFiles: DocTreeFileNode[];
  regularFiles: DocTreeFileNode[];
  files: DocTreeFileNode[];
  totalDocs: number;
  openComments: number;
}

export interface DocTreeRoot {
  rootFiles: DocTreeFileNode[];
  folders: DocTreeFolderNode[];
  allFolderKeys: string[];
}

const NATURAL_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base'
});

export function isOverviewDocName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower === 'readme.md' || lower === 'index.md';
}

function compareFileNodes(a: DocTreeFileNode, b: DocTreeFileNode): number {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  if (a.isOverview !== b.isOverview) return a.isOverview ? -1 : 1;
  const byName = NATURAL_COLLATOR.compare(a.name, b.name);
  if (byName !== 0) return byName;
  return a.doc.path.localeCompare(b.doc.path);
}

function compareFolderNodes(a: DocTreeFolderNode, b: DocTreeFolderNode): number {
  const byLabel = NATURAL_COLLATOR.compare(a.label, b.label);
  if (byLabel !== 0) return byLabel;
  return a.key.localeCompare(b.key);
}

interface RawFolderBuilder {
  key: string;
  segment: string;
  subfolders: Map<string, RawFolderBuilder>;
  files: DocTreeFileNode[];
}

function finalizeFolder(builder: RawFolderBuilder): DocTreeFolderNode {
  const sortedFiles = [...builder.files].sort(compareFileNodes);
  const overviewFiles = sortedFiles.filter((f) => f.isDefault || f.isOverview);
  const regularFiles = sortedFiles.filter((f) => !f.isDefault && !f.isOverview);

  const childFolders = Array.from(builder.subfolders.values())
    .map(finalizeFolder)
    .sort(compareFolderNodes);

  const directComments = sortedFiles.reduce((sum, f) => sum + f.doc.openComments, 0);
  const childComments = childFolders.reduce((sum, c) => sum + c.openComments, 0);
  const childTotalDocs = childFolders.reduce((sum, c) => sum + c.totalDocs, 0);

  let node: DocTreeFolderNode = {
    kind: 'folder',
    key: builder.key,
    label: builder.segment,
    depth: 0,
    folders: childFolders,
    overviewFiles,
    regularFiles,
    files: sortedFiles,
    totalDocs: sortedFiles.length + childTotalDocs,
    openComments: directComments + childComments
  };

  // Compact empty single-child intermediate directory chains (e.g. packages/core/docs)
  while (node.files.length === 0 && node.folders.length === 1) {
    const onlyChild = node.folders[0];
    node = {
      kind: 'folder',
      key: onlyChild.key,
      label: `${node.label}/${onlyChild.label}`,
      depth: 0,
      folders: onlyChild.folders,
      overviewFiles: onlyChild.overviewFiles,
      regularFiles: onlyChild.regularFiles,
      files: onlyChild.files,
      totalDocs: onlyChild.totalDocs,
      openComments: onlyChild.openComments
    };
  }

  return node;
}

function assignDepthAndCollectKeys(
  folders: DocTreeFolderNode[],
  depth: number,
  keysOut: string[]
): DocTreeFolderNode[] {
  return folders.map((folder) => {
    keysOut.push(folder.key);
    const updatedChildren = assignDepthAndCollectKeys(folder.folders, depth + 1, keysOut);
    return {
      ...folder,
      depth,
      folders: updatedChildren
    };
  });
}

export function buildDocTree(docs: DocTreeEntry[], defaultDoc = ''): DocTreeRoot {
  const normalizedDefault = defaultDoc.replace(/\\/g, '/').replace(/^\/+/, '');
  const rootFiles: DocTreeFileNode[] = [];
  const topFolders = new Map<string, RawFolderBuilder>();

  for (const doc of docs) {
    const cleanPath = doc.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = cleanPath.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    const fileName = segments[segments.length - 1];
    const dirSegments = segments.slice(0, -1);
    const dirPath = dirSegments.join('/');
    const fileNode: DocTreeFileNode = {
      kind: 'file',
      doc: { ...doc, path: cleanPath },
      name: fileName,
      dirPath,
      isOverview: isOverviewDocName(fileName),
      isDefault: cleanPath === normalizedDefault
    };

    if (dirSegments.length === 0) {
      rootFiles.push(fileNode);
      continue;
    }

    let currentMap = topFolders;
    let currentBuilder: RawFolderBuilder | undefined;
    let builtKey = '';

    for (const seg of dirSegments) {
      builtKey = builtKey ? `${builtKey}/${seg}` : seg;
      let next = currentMap.get(seg);
      if (!next) {
        next = {
          key: builtKey,
          segment: seg,
          subfolders: new Map(),
          files: []
        };
        currentMap.set(seg, next);
      }
      currentBuilder = next;
      currentMap = next.subfolders;
    }

    currentBuilder!.files.push(fileNode);
  }

  rootFiles.sort(compareFileNodes);

  const finalizedTop = Array.from(topFolders.values())
    .map(finalizeFolder)
    .sort(compareFolderNodes);

  const allFolderKeys: string[] = [];
  const folders = assignDepthAndCollectKeys(finalizedTop, 0, allFolderKeys);

  return {
    rootFiles,
    folders,
    allFolderKeys
  };
}

export function folderContainsDoc(folderKey: string, docPath: string): boolean {
  if (!folderKey || !docPath) return false;
  const cleanDoc = docPath.replace(/\\/g, '/').replace(/^\/+/, '');
  return cleanDoc.startsWith(`${folderKey}/`);
}

export function getAncestorFolderKeys(docPath: string, allFolderKeys: string[]): string[] {
  if (!docPath) return [];
  return allFolderKeys.filter((key) => folderContainsDoc(key, docPath));
}

export function computeDefaultExpandedFolders(
  tree: DocTreeRoot,
  activeDocPath: string,
  totalProjectDocs: number
): Record<string, boolean> {
  const expanded: Record<string, boolean> = {};
  const activeAncestors = new Set(getAncestorFolderKeys(activeDocPath, tree.allFolderKeys));
  const singlePrimaryTopFolder =
    tree.folders.length === 1 && tree.folders[0].regularFiles.length <= 28
      ? tree.folders[0].key
      : null;

  function visit(folder: DocTreeFolderNode): void {
    if (activeAncestors.has(folder.key)) {
      expanded[folder.key] = true;
    } else if (totalProjectDocs <= 16) {
      expanded[folder.key] = true;
    } else if (
      folder.depth === 0 &&
      (folder.key.toLowerCase() === 'docs' || folder.key === singlePrimaryTopFolder) &&
      folder.regularFiles.length <= 28
    ) {
      expanded[folder.key] = true;
    } else if (folder.depth >= 1 && folder.totalDocs <= 2 && folder.folders.length === 0) {
      expanded[folder.key] = true;
    } else {
      expanded[folder.key] = false;
    }

    for (const child of folder.folders) {
      visit(child);
    }
  }

  for (const folder of tree.folders) {
    visit(folder);
  }

  return expanded;
}

export function deriveDefaultNewDocDir(activeDocPath: string): string {
  const clean = activeDocPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const slashIdx = clean.lastIndexOf('/');
  if (slashIdx > 0) {
    return `${clean.slice(0, slashIdx + 1)}`;
  }
  return 'docs/';
}
