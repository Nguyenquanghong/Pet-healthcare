import type { ReactNode } from "react";

type AppStoreProviderProps = {
  children: ReactNode;
};

export function AppStoreProvider({ children }: AppStoreProviderProps) {
  return children;
}