import { createContext, useContext } from 'react';

export interface EditorBridgeContextValue {
  projectId: string;
  embedReloadToken: number;
  onNavigateDoc: (docPath: string) => void;
}

export const EditorBridgeContext = createContext<EditorBridgeContextValue>({
  projectId: '',
  embedReloadToken: 0,
  onNavigateDoc: () => {}
});

export function useEditorBridge(): EditorBridgeContextValue {
  return useContext(EditorBridgeContext);
}
