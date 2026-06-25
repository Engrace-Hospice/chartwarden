// @wardenx/admin-ui-shell — current-tenant context for the platform-ops console (M34 §3.1/§5.1).
// The platform-ops tenant routes are keyed by `:orgSlug` (e.g. `/tenants/:orgSlug/onboarding`). The
// shell reads that slug once, at the route boundary, and publishes it through React context so every
// nested tenant surface (overview cards, support-session banner, export queues) resolves the same
// tenant identity without re-parsing the URL or threading props.
//
// Renderer-only: this is a thin context wrapper — it owns no data fetching. The host app passes the
// slug it extracted from its router (react-router `useParams().orgSlug`), keeping this package free
// of a router dependency. Lantern: no presentation here, so nothing to style.
import { createContext, useContext } from "react";
import type { JSX, ReactNode } from "react";

/** The current platform-ops tenant, identified by its URL `:orgSlug`. */
export interface TenantContextValue {
  /** The `:orgSlug` path segment of the active tenant route. */
  orgSlug: string;
}

const TenantContext = createContext<TenantContextValue | null>(null);

export interface TenantContextProviderProps {
  /** The `:orgSlug` route param the host router resolved for this tenant route. */
  orgSlug: string;
  children: ReactNode;
}

/** Publishes the active tenant's `:orgSlug` to the platform-ops tenant subtree. */
export function TenantContextProvider({
  orgSlug,
  children,
}: TenantContextProviderProps): JSX.Element {
  return <TenantContext.Provider value={{ orgSlug }}>{children}</TenantContext.Provider>;
}

/** Read the active tenant context. Throws if used outside a <TenantContextProvider>. */
export function useTenantContext(): TenantContextValue {
  const ctx = useContext(TenantContext);
  if (ctx === null) {
    throw new Error("useTenantContext must be used within a <TenantContextProvider>");
  }
  return ctx;
}

/** Read the active tenant context without throwing — null outside a provider (e.g. tenant-list). */
export function useOptionalTenantContext(): TenantContextValue | null {
  return useContext(TenantContext);
}
