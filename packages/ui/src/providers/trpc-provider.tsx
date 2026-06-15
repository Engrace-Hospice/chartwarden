// @wardenx/ui — trpc-provider (spec §5.1 trpc-provider.tsx). The API client is generic:
// a leaf UI package cannot import the backend's tRPC AppRouter type (that would invert the
// dependency and break `leaves-stay-leaves`). Instead the app calls `createApiProvider<TClient>()`
// with its router-typed client, getting back a typed Provider + hook. Until the tRPC layer
// lands the app can pass any HTTP/data client through the same context.
import { createContext, createElement, useContext } from "react";
import type { JSX, ReactNode } from "react";

export interface ApiProvider<TClient> {
  ApiProvider: (props: { client: TClient; children: ReactNode }) => JSX.Element;
  useApi: () => TClient;
}

/** Build a typed API-client context for a concrete client type. */
export function createApiProvider<TClient>(): ApiProvider<TClient> {
  const Context = createContext<TClient | null>(null);

  function ApiProvider({
    client,
    children,
  }: { client: TClient; children: ReactNode }): JSX.Element {
    return createElement(Context.Provider, { value: client }, children);
  }

  function useApi(): TClient {
    const ctx = useContext(Context);
    if (ctx === null) {
      throw new Error("useApi must be used within the ApiProvider returned by createApiProvider()");
    }
    return ctx;
  }

  return { ApiProvider, useApi };
}
