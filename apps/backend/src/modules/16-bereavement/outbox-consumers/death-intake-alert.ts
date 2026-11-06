// apps/backend/src/modules/16-bereavement/outbox-consumers/death-intake-alert.ts — ADR-0110 D7.
//
// A death opened an `eligible` bereavement plan and nobody is assigned yet (counselor auto-assignment does not
// exist), so the bereavement oversight roles are told. Shared by the two intake paths that can open the plan
// (`m6.bereavement.eligible` and the `m6.admission.discharged` safety net): whichever inserts the row emits,
// and M36's `(org, correlationId)` dedupe (`m16:death_intake:<planId>`) collapses a second emit for one plan.
//
// Runs AFTER the plan-insert transaction committed, so a notification failure can never undo the plan. The
// emitter error is NOT swallowed: it fails the delivery attempt (the relay logs it); the retry finds the plan
// (`idempotent_skip`) and does not re-alert, which is why the alert is advisory — the 48h counselor-assignment
// alert and the worklist are the backstops.
import type { AlertPort } from "../routes/write-service";

export async function emitDeathIntakeAlert(
  alerts: AlertPort | undefined,
  facts: { readonly organizationId: string; readonly planId: string; readonly deathDate: string },
): Promise<void> {
  if (alerts === undefined) return;
  await alerts.emit({
    organizationId: facts.organizationId,
    kind: "death_intake",
    payload: { planId: facts.planId, deathDate: facts.deathDate },
  });
}
