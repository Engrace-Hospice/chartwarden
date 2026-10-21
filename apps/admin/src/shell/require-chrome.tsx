import { LoadingSpinner } from "@chartwarden/ui";
// apps/admin/src/shell — the admin console's auth guard (M1/M34, ADR-0030). Ported from
// apps/web/src/shell/app.tsx's `RequireChrome`, plus one addition this app needs that web's doesn't:
// once authenticated, the actor must also hold the `platform_ops` role — the same role the backend's
// own `tenant_lifecycle_platform_ops` ABAC predicate requires on every route this app calls
// (apps/backend/.../34-saas-tenant-platform/abac-predicates.ts). This is a UX guard only — the
// server remains the authoritative enforcer either way; without it, a signed-in but non-platform-ops
// actor would see a console frame full of screens that all 403, with no explanation.
import type { JSX, ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { guardChromedRoute } from "./actor-session";
import { useSessionState } from "./session";

export function RequireChrome({ children }: { children: ReactNode }): JSX.Element {
  const { status, session } = useSessionState();
  const outcome = guardChromedRoute(status);
  if (outcome === "loading") return <LoadingSpinner label="Loading console…" />;
  if (outcome === "redirect") return <Navigate to="/login" replace />;
  if (outcome === "outage") return <Navigate to="/error" replace />;
  if (!session?.roles?.includes("platform_ops")) return <Navigate to="/403" replace />;
  return <>{children}</>;
}
