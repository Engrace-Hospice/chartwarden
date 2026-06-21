// @wardenx/ui — socket-provider (spec §5.1 socket-provider.tsx, §2519 realtime banner feed).
// Dependency-injected: the app passes a socket instance (e.g. socket.io-client) that
// satisfies `SocketLike`. The leaf declares only the minimal surface it needs, so it adds
// no socket.io dependency and stays usable before the realtime server (M1 §13.4) is wired.
import { createContext, useContext } from "react";
import type { JSX, ReactNode } from "react";

/** Minimal structural type the UI needs from a realtime socket client. */
export interface SocketLike {
  connected: boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
}

const SocketContext = createContext<SocketLike | null>(null);

export interface SocketProviderProps {
  socket: SocketLike;
  children: ReactNode;
}

export function SocketProvider({ socket, children }: SocketProviderProps): JSX.Element {
  return <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketLike {
  const ctx = useContext(SocketContext);
  if (ctx === null) {
    throw new Error("useSocket must be used within a <SocketProvider>");
  }
  return ctx;
}
