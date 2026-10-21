// apps/backend/src/modules/12-dosespot/outbox-consumers/m22-extraction-medication-history.ts — the LIVE
// `m22.extraction.medication_history_requested` consumer: M12's half of the DocLens medication-history
// writeback (F-238).
//
// WHAT IT WRITES, AND WHAT IT CAN NEVER WRITE. Each line a DocLens reviewer attested becomes ONE
// `medication_history_record` row with `source = 'doclens_intake'` — the M12 D10 external-medication-
// history store, "persisted for clinical reconciliation but never auto-linked to medication_order". The
// line goes into `drug_name` VERBATIM; strength / dose_form / sig / RxNorm stay NULL (no AI parse, and no
// RxNorm lookup either — M38's RxNorm concepts arrive only via its scheduled loader, and resolving a free-
// text line such as "metoprolol tartrate 25 mg PO BID" to an RxCUI is itself a parse, not a pure code
// lookup; a guessed code on an outside med list is worse than none). This file does not import, read or write
// `medication_order` in any form: M12 D12 / AI Governance §2.1.1's hard block on AI-introduced medication
// changes is the reason the target is the history store and not an order draft. A clinician reconciles
// the row (`POST /api/v1/medication-history-records/:id/reconcile`); an order, if one is wanted, is
// written by a prescriber in the normal prescribe flow — nothing here pre-fills it.
//
// IDEMPOTENT + DEDUPED. A line whose candidate already has a row → `already_present` (a redelivery).
// A line whose dedupe key (`doclensClinicalLineKey`) already exists for this patient from an earlier DocLens
// commit → `duplicate` (the repeat fax is flagged back, not written twice). Both report the existing row
// id so M22 can stamp provenance on what the chart actually holds.
//
// ONE TRANSACTION: the rows and the `m12.medication_history_record.draft_created_from_extraction` reply
// commit together. FAIL-CLOSED: a malformed, cross-tenant or wrong-target payload THROWS (retry → DLQ).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  type ClinicalDraftCreatedFromExtractionPayload,
  type DocLensClinicalLineOutcome,
  type ExtractionMedicationHistoryRequestedPayload,
  M12_MEDICATION_HISTORY_DRAFT_CREATED_FROM_EXTRACTION_EVENT,
  M22_EXTRACTION_MEDICATION_HISTORY_REQUESTED_EVENT,
  doclensClinicalLineKey,
  parseDocLensClinicalCommit,
} from "@chartwarden/types";
import { and, eq, inArray } from "drizzle-orm";
import type { DoseSpotWriteOutboxPort } from "../dosespot-route-service-db";

const MHR = schema.medicationHistoryRecords;

export const M12_EXTRACTION_MEDICATION_HISTORY_CONSUMER = {
  eventName: M22_EXTRACTION_MEDICATION_HISTORY_REQUESTED_EVENT,
  consumerName: "m12.extraction-medication-history",
} as const;

function fail(msg: string): never {
  throw new Error(`${M12_EXTRACTION_MEDICATION_HISTORY_CONSUMER.consumerName}: ${msg}`);
}

/** Apply one commit in ONE transaction; returns the reply it published. */
export async function applyMedicationHistoryWriteback(
  db: DbClient,
  outbox: DoseSpotWriteOutboxPort,
  payload: ExtractionMedicationHistoryRequestedPayload,
  now: () => Date = () => new Date(),
): Promise<ClinicalDraftCreatedFromExtractionPayload> {
  const organizationId = payload.organizationId;
  const patientId = payload.targetAggregateId;
  return withOrgContext<DbClient, ClinicalDraftCreatedFromExtractionPayload>(
    db,
    { organizationId, userId: "" },
    async (tx) => {
      const keyed = payload.lines.map((l) => ({ line: l, key: doclensClinicalLineKey(l.text) }));
      const existingByCandidate = new Map(
        (
          await tx
            .select({ id: MHR.id, candidateId: MHR.sourceExtractionCandidateId })
            .from(MHR)
            .where(
              inArray(
                MHR.sourceExtractionCandidateId,
                keyed.map((k) => k.line.candidateId),
              ),
            )
        ).map((r) => [r.candidateId as string, r.id]),
      );
      const existingByKey = new Map(
        (
          await tx
            .select({ id: MHR.id, key: MHR.lineKey })
            .from(MHR)
            .where(
              and(
                eq(MHR.patientId, patientId),
                eq(MHR.source, "doclens_intake"),
                inArray(
                  MHR.lineKey,
                  keyed.map((k) => k.key),
                ),
              ),
            )
        ).map((r) => [r.key as string, r.id]),
      );

      const attestedAt = new Date(payload.requestedAt);
      const outcomes: DocLensClinicalLineOutcome[] = [];
      for (const { line, key } of keyed) {
        const own = existingByCandidate.get(line.candidateId);
        if (own) {
          outcomes.push({
            candidateId: line.candidateId,
            outcome: "already_present",
            recordId: own,
          });
          continue;
        }
        const dup = existingByKey.get(key);
        if (dup) {
          outcomes.push({ candidateId: line.candidateId, outcome: "duplicate", recordId: dup });
          continue;
        }
        const [row] = await tx
          .insert(MHR)
          .values({
            organizationId,
            patientId,
            source: "doclens_intake",
            pullId: null,
            sourceEventId: payload.extractionCommitId,
            lineIndex: line.lineIndex,
            drugName: line.text, // the attested line, verbatim — never parsed
            sourceExtractionCandidateId: line.candidateId,
            sourceExtractionDecisionId: line.decisionId,
            sourceDocumentId: line.sourceDocumentId,
            sourcePage: line.sourcePage,
            attestedByMembershipId: payload.reviewerMembershipId,
            attestedAt: Number.isNaN(attestedAt.getTime()) ? now() : attestedAt,
            lineKey: key,
          })
          .returning({ id: MHR.id });
        if (!row) fail("insert returned no row");
        existingByKey.set(key, row.id);
        outcomes.push({ candidateId: line.candidateId, outcome: "created", recordId: row.id });
      }

      const reply: ClinicalDraftCreatedFromExtractionPayload = {
        patientId,
        organizationId,
        extractionCommitId: payload.extractionCommitId,
        lineOutcomes: outcomes,
        appliedAt: now().toISOString(),
      };
      await outbox.publish(tx, {
        eventName: M12_MEDICATION_HISTORY_DRAFT_CREATED_FROM_EXTRACTION_EVENT,
        payload: reply as unknown as Record<string, unknown>,
        organizationId,
        aggregateKind: "medication_history_record",
        aggregateId: payload.extractionCommitId,
      });
      return reply;
    },
  );
}

/** Build the live binding the composition root registers with the boot outbox dispatcher. */
export function buildM12ExtractionMedicationHistoryConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: DoseSpotWriteOutboxPort;
  readonly now?: () => Date;
}) {
  return {
    consumerName: M12_EXTRACTION_MEDICATION_HISTORY_CONSUMER.consumerName,
    consumerModule: "m12" as const,
    eventTypes: [M12_EXTRACTION_MEDICATION_HISTORY_CONSUMER.eventName] as const,
    async handle(event: { readonly organizationId: string; readonly payload: unknown }) {
      const parsed = parseDocLensClinicalCommit(event.payload, event.organizationId, "m12");
      if (!parsed.ok) fail(parsed.reason);
      await applyMedicationHistoryWriteback(deps.db, deps.outbox, parsed.payload, deps.now);
    },
  };
}
