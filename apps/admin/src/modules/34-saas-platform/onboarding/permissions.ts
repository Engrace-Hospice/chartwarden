// apps/admin/src/modules/34-saas-platform/onboarding — which onboarding writes the signed-in operator may make, so the console offers only
// those (React review M1). The server enforces every key regardless; this keeps an operator from typing a reason for a 403. Fail closed:
// while the session is loading, or when it carries no permissions, nothing is offered.
import { useMemo } from "react";
import { useSession } from "../../../shell/session";
import { ONBOARDING_KEYS } from "./wizard-model";

export { ONBOARDING_KEYS };

/** The signed-in operator's permission keys (empty until the session answers). */
export function usePermissions(): ReadonlySet<string> {
  const permissions = useSession()?.permissions;
  return useMemo(() => new Set(permissions ?? []), [permissions]);
}

/** Whether the operator holds every one of `keys`. */
export function useCan(...keys: readonly string[]): boolean {
  const held = usePermissions();
  return keys.every((k) => held.has(k));
}
