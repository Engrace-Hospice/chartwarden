// apps/backend/src/modules/20-field-safety/terminus/enter.ts - GAP-032: recording a terminus loop iteration
// as INTENT rows, inside the watchdog's per-alert tenant tx.
//
// Called for the entry (iteration 0, in the SAME tx as the state change) and for every later loop period.
// Nothing here touches the network: it only decides which effects this iteration owes and writes the ledger
// rows an executor (`./executor.ts`) will perform out of the tx.
//
// THE `page_ops` ROW IS THE ITERATION'S GATE. UNIQUE (alert, kind, iteration, attempt) means that of the ~20
// watchdog ticks (15 s) inside one loop period (60-300 s) exactly ONE inserts it; the other 19 see a
// conflict and do nothing - no duplicate outbox event, no duplicate page, no duplicate dial. The uniqueness
// is in the database, so two workers cannot double-fire either.
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import type { MembershipId } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import { type TerminusAlertAnchor, insertTerminusAction, listDialRows } from "./ledger";
import { planDialAttempt } from "./policy";

const CONSENT = schema.safetyEmergencyContactConsent;

/** Is the clinician's `emergency_contact_call` consent granted and unexpired right now? Read in the caller's tx
 *  (a read failure fails the tx and the next tick retries - it can never be recorded as "declined"). */
export async function emergencyContactConsentGrantedInTx(
  tx: DbClient,
  organizationId: string,
  clinicianMembershipId: MembershipId,
  at: Date,
): Promise<boolean> {
  const [row] = await tx
    .select({ expiresAt: CONSENT.expiresAt })
    .from(CONSENT)
    .where(
      and(
        eq(CONSENT.organizationId, organizationId),
        eq(CONSENT.clinicianMembershipId, clinicianMembershipId),
        eq(CONSENT.consentPurpose, "emergency_contact_call"),
        eq(CONSENT.status, "granted"),
      ),
    )
    .limit(1);
  if (!row) return false;
  return row.expiresAt === null || row.expiresAt.getTime() > at.getTime();
}

export interface TerminusIterationInput {
  readonly anchor: TerminusAlertAnchor;
  readonly sosAlertId: string;
  readonly loopIteration: number;
  readonly at: Date;
  /** The pure machine's consent boolean for this tick (`emergencyContactConsentGrantedInTx`). */
  readonly consentGranted: boolean;
  /** False when no pager is bound: the page row is recorded as skipped, not refused. */
  readonly pagerBound: boolean;
}

export interface TerminusIterationResult {
  /** True only for the one tick that created this iteration's rows. */
  readonly won: boolean;
}

export async function recordTerminusIteration(
  tx: DbClient,
  input: TerminusIterationInput,
): Promise<TerminusIterationResult> {
  const base = {
    anchor: input.anchor,
    sosAlertId: input.sosAlertId,
    loopIteration: input.loopIteration,
    at: input.at,
  } as const;

  const won = await insertTerminusAction(tx, {
    ...base,
    kind: "page_ops",
    attemptNo: 0,
    initial: input.pagerBound
      ? { status: "pending" }
      : { status: "skipped", outcomeCode: "pager_unbound" },
  });
  if (!won) return { won: false };

  // PSAP resolution needs the decrypted SOS coordinate (a tenant-DEK fetch that may be remote), so it is
  // an executor-run row rather than an in-tx lookup.
  await insertTerminusAction(tx, {
    ...base,
    kind: "resolve_psap",
    attemptNo: 0,
    initial: { status: "pending" },
  });

  const plan = planDialAttempt({
    priorDialRows: await listDialRows(tx, input.sosAlertId),
    now: input.at,
  });
  if (plan.kind === "insert") {
    await insertTerminusAction(tx, {
      ...base,
      kind: "dial_contact",
      attemptNo: plan.attemptNo,
      initial: input.consentGranted
        ? { status: "pending" }
        : { status: "skipped", outcomeCode: "consent_absent" },
    });
  }
  return { won: true };
}
