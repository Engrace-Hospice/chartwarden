// @wardenx/ui — API client React context (F0-T02, ADR-0032). Replaces the Phase-0
// `trpc-provider.tsx` placeholder (the backend is REST, not tRPC). The M1 shell builds one
// `ApiClient` via createApiClient() and provides it here; every screen reads it with useApiClient().
import { createContext, createElement, useContext } from "react";
import type { JSX, ReactNode } from "react";
import type { ApiClient } from "./client";

const ApiClientContext = createContext<ApiClient | null>(null);

export interface ApiClientProviderProps {
  client: ApiClient;
  children: ReactNode;
}

export function ApiClientProvider({ client, children }: ApiClientProviderProps): JSX.Element {
  return createElement(ApiClientContext.Provider, { value: client }, children);
}

/** Read the typed API client from context. Throws if used outside <ApiClientProvider>. */
export function useApiClient(): ApiClient {
  const ctx = useContext(ApiClientContext);
  if (ctx === null) {
    throw new Error("useApiClient must be used within <ApiClientProvider>");
  }
  return ctx;
}
