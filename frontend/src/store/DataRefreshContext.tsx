import { createContext, useContext, useMemo, type ReactNode } from "react";

type DataRefresh = { version: number; changeVersion: number };
const DataRefreshContext = createContext<DataRefresh | undefined>(undefined);

// Queries only subscribe to the refresh version, not cached business entities.
export function DataRefreshProvider({ version, changeVersion, children }: DataRefresh & { children: ReactNode }) {
  const value = useMemo(() => ({ version, changeVersion }), [version, changeVersion]);
  return <DataRefreshContext.Provider value={value}>{children}</DataRefreshContext.Provider>;
}

export function useDataRefresh() {
  const value = useContext(DataRefreshContext);
  if (!value) throw new Error("useDataRefresh must be used within DataRefreshProvider");
  return value;
}

export function useDataVersion() { return useDataRefresh().version; }
