// apps/web/src/modules/34-saas/wizard — which onboarding keys and roles the signed-in person holds, so the wizard offers only what they
// can do. The server enforces every key regardless; this keeps a person from filling in a form for a 403. Fail closed: while the
// session is loading, or when it carries none, nothing is held.
import { useMemo } from "react";
import { useSession } from "../../../shell/session";
import { ONBOARDING_KEYS } from "./wizard-model";

export { ONBOARDING_KEYS };

/** The signed-in person's permission keys (empty until the session answers). */
export function usePermissions(): ReadonlySet<string> {
  const permissions = useSession()?.permissions;
  return useMemo(() => new Set(permissions ?? []), [permissions]);
}

/** The signed-in person's role keys (empty until the session answers). */
export function useRoles(): readonly string[] {
  const roles = useSession()?.roles;
  return useMemo(() => roles ?? [], [roles]);
}
