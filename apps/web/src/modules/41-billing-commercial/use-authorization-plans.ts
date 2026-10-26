// apps/web/src/modules/41-billing-commercial — the entity's plans, as the authorization screens need them (plan names for rows and
// the form's plan choice, authorization policy for the drawer).
//   GET /api/v1/billing/commercial/payer-plans?providerEntityId   (no patient data)
import { useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { AuthorizationPlan } from "./commercial-model";

export type AuthorizationPlansState =
  | { readonly state: "loading" }
  | { readonly state: "error" }
  | { readonly state: "ready"; readonly plans: readonly AuthorizationPlan[] };

export function useAuthorizationPlans(providerEntityId: string): {
  plans: AuthorizationPlansState;
  retry: () => void;
} {
  const client = useApiClient();
  const [plans, setPlans] = useState<AuthorizationPlansState>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is a retry trigger, not a value the effect reads.
  useEffect(() => {
    if (!providerEntityId) return;
    let active = true;
    setPlans({ state: "loading" });
    void client
      .GET("/api/v1/billing/commercial/payer-plans", {
        params: { query: { providerEntityId } },
      })
      .then(({ data, error }) => {
        if (!active) return;
        setPlans(
          error || !data
            ? { state: "error" }
            : {
                state: "ready",
                plans: data.items.map((p) => ({
                  id: p.id,
                  payerId: p.payerId,
                  planName: p.planName,
                  authorizationRequirement: p.authorizationRequirement,
                  authorizationLeadDays: p.authorizationLeadDays,
                })),
              },
        );
      })
      .catch(() => {
        if (active) setPlans({ state: "error" });
      });
    return () => {
      active = false;
    };
  }, [client, providerEntityId, attempt]);

  return { plans, retry: () => setAttempt((n) => n + 1) };
}
