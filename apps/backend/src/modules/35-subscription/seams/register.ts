// apps/backend/src/modules/35-subscription/seams/register.ts — M35's live seam registrations (ADR-0108).
//
// `ClaimsBillingEntitlementReader` and `PatientCounterProvider` replace their throwing deny-stubs with the Drizzle readers on a db boot. A slice boot
// with no db keeps the stub, and the claims-billing gate then fails CLOSED (boot refuses a non-`off` enforcement mode
// on an unbound seam).
import type { DbClient } from "@chartwarden/db";
import { registerSeam } from "../../../bootstrap/index";
import { createDrizzleClaimsBillingEntitlementReader } from "../addon/entitlement";
import { createDrizzlePatientCounterProvider } from "../billing-runtime/census";

export function registerM35Seams(deps: { readonly db?: DbClient } = {}): void {
  if (deps.db) {
    registerSeam(
      "ClaimsBillingEntitlementReader",
      createDrizzleClaimsBillingEntitlementReader(deps.db),
    );
    // ADR-0108 D8 — the real pseudonymized active-patient counter over `patient_active_period`.
    registerSeam("PatientCounterProvider", createDrizzlePatientCounterProvider(deps.db));
  }
}
