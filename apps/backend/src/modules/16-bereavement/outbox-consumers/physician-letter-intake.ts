// apps/backend/src/modules/16-bereavement/outbox-consumers/physician-letter-intake.ts — ADR-0109 D6.
//
// The two intake paths that can open a bereavement plan (`m6.bereavement.eligible` and the `m6.admission.discharged` safety net) also
// open its physician condolence letter, `pending_review`, in the SAME transaction as the plan insert: a plan opened by this delivery
// has exactly one letter, and a conflict-absorbed redelivery (no plan inserted) creates none. The letter is due the UTC-midnight death
// date plus two days and addresses the care team's attending when M5 resolves one; otherwise the reviewer picks an internal clinician
// at approval. The attending is resolved BEFORE the transaction (a seam call inside our own transaction self-deadlocks the pool,
// M21-T05); a resolver that is unbound or throws leaves the recipient open, never blocks the plan.
//
// The `physician_letter_pending_review` alert runs AFTER the commit, like `death_intake`, best-effort and logged: a retry of the delivery
// finds the plan already opened and does not re-alert, so the review queue (the letter is `pending_review` either way) is the backstop.
import { type DbClient, schema } from "@chartwarden/db";
import { emitAlertBestEffort } from "../alert-port";
import { physicianLetterDueAt } from "../lifecycle/physician-letter";
import type { AlertPort } from "../routes/write-service";

/** M5's attending lookup, org-explicit (a relay tick is not a request). Null = nobody resolved. */
export type AttendingUserResolver = (
  organizationId: string,
  patientId: string,
) => Promise<string | null>;

/** The attending the care team resolves, or null: an unbound or failing seam never blocks the intake. */
export async function resolveAttendingOrNull(
  resolver: AttendingUserResolver | undefined,
  organizationId: string,
  patientId: string,
): Promise<string | null> {
  if (resolver === undefined) return null;
  try {
    return (await resolver(organizationId, patientId)) ?? null;
  } catch (err) {
    // The recipient stays open for the reviewer to name; the failure is logged (ids only) so an unbound or broken seam is visible.
    // eslint-disable-next-line no-console -- consumers log via console (M9/M20 precedent).
    console.warn(
      "m16.physician_letter: attending lookup failed; the reviewer will name the recipient",
      {
        organizationId,
        patientId,
        error: err instanceof Error ? err.name : "unknown",
      },
    );
    return null;
  }
}

/** The plan facts the letter row is sited from. */
export interface PendingLetterFacts {
  readonly organizationId: string;
  readonly planId: string;
  readonly patientId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly deathDate: string;
  readonly attendingUserId: string | null;
}

/** Insert the plan's `pending_review` letter on the plan-insert transaction. `plan_id` is UNIQUE, so a repeat is a no-op. */
export async function insertPendingPhysicianLetter(
  tx: DbClient,
  facts: PendingLetterFacts,
): Promise<void> {
  await tx
    .insert(schema.bereavementPhysicianLetter)
    .values({
      organizationId: facts.organizationId,
      providerEntityId: facts.providerEntityId,
      locationId: facts.locationId,
      planId: facts.planId,
      patientId: facts.patientId,
      attendingUserId: facts.attendingUserId,
      status: "pending_review",
      dueAt: physicianLetterDueAt(facts.deathDate),
    })
    .onConflictDoNothing();
}

/** Tell the oversight roles a letter awaits review. Unbound alerts => skipped. Best-effort and logged: see `emitAlertBestEffort`. */
export async function emitPhysicianLetterPendingAlert(
  alerts: AlertPort | undefined,
  facts: { readonly organizationId: string; readonly planId: string },
): Promise<void> {
  await emitAlertBestEffort(alerts, {
    organizationId: facts.organizationId,
    kind: "physician_letter_pending_review",
    payload: { planId: facts.planId },
  });
}
