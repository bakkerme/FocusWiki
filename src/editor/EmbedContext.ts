import { createContext, useContext } from 'react';

export type WorkspaceMode = 'read' | 'visual' | 'source';

export interface EditorBridgeContextValue {
  projectId: string;
  embedReloadToken: number;
  workspaceMode: WorkspaceMode;
  isEditing: boolean;
  onNavigateDoc: (docPath: string) => void;
}

export const EditorBridgeContext = createContext<EditorBridgeContextValue>({
  projectId: '',
  embedReloadToken: 0,
  workspaceMode: 'read',
  isEditing: false,
  onNavigateDoc: () => {}
});

export function useEditorBridge(): EditorBridgeContextValue {
  return useContext(EditorBridgeContext);
}
