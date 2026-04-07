import { createContext, useContext, type ReactNode } from "react";

const CurrentWorkspaceIdContext = createContext<string | null>(null);

export function CurrentWorkspaceIdProvider({
  workspaceId,
  children,
}: {
  workspaceId: string | null;
  children: ReactNode;
}) {
  return (
    <CurrentWorkspaceIdContext.Provider value={workspaceId}>
      {children}
    </CurrentWorkspaceIdContext.Provider>
  );
}

export function useCurrentWorkspaceId(): string | null {
  return useContext(CurrentWorkspaceIdContext);
}
