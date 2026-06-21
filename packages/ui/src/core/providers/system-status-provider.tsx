// @wardenx/ui — system-status-provider (spec §5.1, §2519 "system.status_changed → banner").
// Holds the current system-status components in React context. Transport-agnostic: the
// consuming app passes the live `components` (polled from GET /api/v1/system/status or
// pushed over the socket), keeping this leaf free of any client dependency.
import { createContext, useContext } from "react";
import type { JSX, ReactNode } from "react";
import type { SystemStatusComponent } from "../types";

export interface SystemStatusContextValue {
  components: SystemStatusComponent[];
}

const SystemStatusContext = createContext<SystemStatusContextValue | null>(null);

export interface SystemStatusProviderProps {
  components: SystemStatusComponent[];
  children: ReactNode;
}

export function SystemStatusProvider({
  components,
  children,
}: SystemStatusProviderProps): JSX.Element {
  return (
    <SystemStatusContext.Provider value={{ components }}>{children}</SystemStatusContext.Provider>
  );
}

export function useSystemStatus(): SystemStatusContextValue {
  const ctx = useContext(SystemStatusContext);
  if (ctx === null) {
    throw new Error("useSystemStatus must be used within a <SystemStatusProvider>");
  }
  return ctx;
}
