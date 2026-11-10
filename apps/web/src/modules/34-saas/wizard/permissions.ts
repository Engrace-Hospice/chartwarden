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

/** Whether the person holds every one of `keys` (naming none answers false: a gate with no key is a bug, not an open door). */
export function useCan(...keys: readonly string[]): boolean {
  const held = usePermissions();
  return keys.length > 0 && keys.every((k) => held.has(k));
}
