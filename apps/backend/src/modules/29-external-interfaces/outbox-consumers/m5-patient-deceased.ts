// apps/backend/src/modules/29-external-interfaces/outbox-consumers/m5-patient-deceased.ts — F-165 (#248):
// binds `m5.patient.deceased`. M29's own spec text (dependsOn 5): "`m5.patient.deceased` consumed via
// outbox to freeze inbound ADT processing for the decedent and to refuse any post-death A01/A04 events
// with a typed OperationOutcome."
//
// ── THIS CONSUMER BUILDS THE FIRST HALF ONLY — FREEZING WHAT IS ALREADY STAGED ─────────────────────────
//
// Every `hl7_inbound_proposal` row still `pending` and matched to the now-deceased patient
// (`matched_patient_id`, the table's own `idx_hip_matched_patient` index) is transitioned to `expired` via
// the SAME pure `expireProposal` decider the (also currently unbuilt — no cron worker anywhere calls it;
// `expireProposal` has had no caller in production since M29-T04) §2.2 72h SLA sweep would use, widened
// with an explicit `reason` override so the two mechanisms stay distinguishable in `decision_rationale`
// ("patient_deceased_freeze" here vs the SLA sweep's own default "auto_expired_pending_ttl_exceeded").
// Applied via the SAME atomic `WHERE id=? AND proposal_status='pending'` race-guard the T08 accept/reject
// routes use (`routes/store-drizzle.ts`), so a reviewer deciding the SAME proposal concurrently never
// loses a real decision to this system-driven sweep — whichever UPDATE lands second matches zero rows and
// is silently skipped, which is correct: a human's already-recorded accept/reject must stand, a later
// death event does not retroactively invalidate it.
//
// ── THE SECOND HALF IS NOT BUILT HERE, AND IS REPORTED, NOT GUESSED AT ──────────────────────────────────
//
// "Refuse any post-death A01/A04 events with a typed OperationOutcome" describes a REAL-TIME INGEST-TIME
// check — a NEW inbound ADT for a deceased patient must never even reach `pending` — which is not an
// outbox-consumer shape at all. `inbound/match-cascade.ts` runs synchronously, inside the MLLP listener's
// parse pipeline, against an injected `PatientReader` seam (M5, `@chartwarden/types`); that seam's
// `PatientIdentity` return shape carries NO deceased/status field of any kind (confirmed against
// `packages/types/src/patient.ts`'s full `PatientReader` interface), so nothing this outbox consumer
// writes can retroactively extend a DIFFERENT, later request's synchronous seam call. Building the refusal
// half needs one of: (a) a new field/method on M5's published `PatientReader` (a producer-side seam change
// outside this module — M29 cannot invent a fact M5 does not publish), or (b) a new persistent per-patient
// "reject future ADT" marker this consumer would be well placed to WRITE, plus new consultation logic in
// `match-cascade.ts` / `proposals/proposal-builder.ts` to READ it, plus a genuine design decision on what
// "refuse... with a typed OperationOutcome" actually returns over MLLP (which ACKs/NAKs a wire frame — see
// `listener/ack.ts` — not an HTTP `OperationOutcome` FHIR resource the way M28's REST surface would). That
// is new infrastructure and a product decision, not a wiring gap this pass fabricates a binding for.
//
// `m29.hl7_inbound_proposal.expired` had NO catalog entry at all before this pass (only `.accepted` /
// `.rejected` were registered in `events-by-m29.ts`) even though `expireProposal` has produced this exact
// envelope since M29-T04 — the identical "decision core ships, nothing registers or drains it" shape
// task-11's own header names for the sibling `.accepted`/`.rejected` pair. Catalogued alongside this
// consumer, record-only (no consumer anywhere reads a proposal's expiry — the row itself is the durable
// record, the same posture the sibling `.rejected` entry already states).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";

import { expireProposal } from "../proposals/decision";
import type { M29WriteOutboxPort } from "../routes/store-drizzle";

const PROPOSAL = schema.hl7InboundProposal;

/** A system-driven write (a death cascade, not a human reviewer) names no acting membership — the F-102
 *  `CONSUMER_USER_ID` convention this arc uses throughout. */
const CONSUMER_USER_ID = "";

/** The `decision_rationale` this freeze writes — distinguishable from the (also unbuilt) SLA sweep's own
 *  default reason, so an operator reading a proposal's history knows which mechanism closed it. */
const DECEASED_FREEZE_REASON = "patient_deceased_freeze";

export const M29_PATIENT_DECEASED_CONSUMER = {
  eventName: "m5.patient.deceased",
  consumerName: "m29.m5-patient-deceased",
} as const;

export interface M29PatientDeceasedConsumerDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s `m29.*` against the boot catalog (`m29OutboxPublisher`). */
  readonly outbox: M29WriteOutboxPort;
}

function stringField(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * M29's live `m5.patient.deceased` binding (F-165, #248) — freezes every still-`pending`
 * `hl7_inbound_proposal` matched to the decedent. A patient with no open proposals (the common case) is a
 * true no-op after one indexed read; a decedent with several stale proposals (e.g. a lagging referring
 * facility still sending ADT^A08 updates) has each one expired independently, in its own guarded UPDATE,
 * so one row losing its race to a concurrent human decision never blocks the rest.
 */
export function buildM29PatientDeceasedConsumer(deps: M29PatientDeceasedConsumerDeps) {
  return {
    consumerName: M29_PATIENT_DECEASED_CONSUMER.consumerName,
    consumerModule: "m29" as const,
    eventTypes: [M29_PATIENT_DECEASED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const organizationId = event.organizationId;
      const patientId = stringField(event.payload, "patientId");
      if (patientId === undefined) {
        throw new Error(
          `${M29_PATIENT_DECEASED_CONSUMER.consumerName}: ${M29_PATIENT_DECEASED_CONSUMER.eventName} carries no patientId`,
        );
      }

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;

          const pending = await tx
            .select({ id: PROPOSAL.id, proposalStatus: PROPOSAL.proposalStatus })
            .from(PROPOSAL)
            .where(
              and(
                eq(PROPOSAL.organizationId, organizationId),
                eq(PROPOSAL.matchedPatientId, patientId),
                eq(PROPOSAL.proposalStatus, "pending"),
              ),
            );

          const now = new Date();
          for (const row of pending) {
            const decision = expireProposal(
              { id: row.id, organizationId, proposalStatus: row.proposalStatus },
              now,
              DECEASED_FREEZE_REASON,
            );
            // Only ever null when `row.proposalStatus` was already non-pending — impossible given the
            // WHERE clause above at SELECT time, kept as defense against a future caller reusing this
            // loop over an unfiltered read.
            if (!decision) continue;

            const [updated] = await tx
              .update(PROPOSAL)
              .set({
                proposalStatus: decision.update.proposalStatus,
                decidedByMembershipId: decision.update.decidedByMembershipId,
                decidedAt: decision.update.decidedAt,
                decisionRationale: decision.update.decisionRationale,
              })
              .where(and(eq(PROPOSAL.id, row.id), eq(PROPOSAL.proposalStatus, "pending")))
              .returning({ id: PROPOSAL.id });

            // A concurrent human decision won the race between the SELECT above and this UPDATE — the
            // atomic WHERE matched zero rows. Correct: a real reviewer's accept/reject stands and this
            // freeze silently skips that one row rather than overwriting it.
            if (!updated) continue;

            await deps.outbox.publish(tx, {
              eventName: decision.event.name,
              payload: decision.event.payload as unknown as Record<string, unknown>,
              organizationId,
              aggregateKind: "hl7_inbound_proposal",
              aggregateId: row.id,
            });
          }
        },
      );
    },
  };
}
