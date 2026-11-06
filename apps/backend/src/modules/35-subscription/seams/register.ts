// apps/backend/src/modules/35-subscription/seams/register.ts — M35's live seam registrations (ADR-0108).
//
// `PatientCounterProvider` and `SubscriptionWorkBlockReader` replace their throwing deny-stubs with the Drizzle readers on a db boot. (`ClaimsBillingEntitlementReader`
// moved to M23 with ADR-0053 amendment 2026-11-06: the claims-billing gate follows the tenant's clearinghouse choice, not an
// add-on, and M23 registers it. A slice boot with no db keeps its stub and the gate fails CLOSED.)
import type { DbClient } from "@chartwarden/db";
import { registerSeam } from "../../../bootstrap/index";
import { createDrizzleSubscriptionWorkBlockReader } from "../addon/entitlement";
import { createDrizzlePatientCounterProvider } from "../billing-runtime/census";

export function registerM35Seams(deps: { readonly db?: DbClient } = {}): void {
  if (deps.db) {
    // ADR-0108 D8 — the real pseudonymized active-patient counter over `patient_active_period`.
    registerSeam("PatientCounterProvider", createDrizzlePatientCounterProvider(deps.db));
    // Owner decision D1: M23's claims-billing decision asks whether the subscription is suspended / paused / canceled.
    registerSeam("SubscriptionWorkBlockReader", createDrizzleSubscriptionWorkBlockReader(deps.db));
  }
}
