// apps/backend/src/modules/22-documents/extraction/extraction-clinical-backref-consumer.ts — the LIVE
// back-ref consumer for the F-238 clinical writeback replies:
//   `m12.medication_history_record.draft_created_from_extraction` (medication lines → M12 history rows)
//   `m5.patient_allergy.draft_created_from_extraction`             (allergy lines → M5 unverified allergies)
//
// For every line the chart now holds (`created`, `already_present`, or `duplicate` — the last points at the
// row an earlier commit wrote) it stamps that line's `extraction_provenance.target_aggregate_id` with the
// ROW ID the target module reports — the per-line "which chart row did this extraction produce?" answer.
// A `skipped` line stays unstamped. Then the terminal `m22.extraction.commit_completed` (targetModule
// `m12` or `m5`) — once, only when this delivery stamped something, so a redelivery is a no-op.
//
// FAIL-CLOSED (the F-235 back-ref's rules): malformed / cross-tenant payload, an unknown review, or a reply
// whose patient is not the batch's resolved patient THROWS → retry → DLQ. A candidate the reply names that
// is not one of THIS review's decisions is never stamped (the WHERE ties every stamp to the review).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
  type ClinicalDraftCreatedFromExtractionPayload,
  type DocLensClinicalLineOutcome,
  M5_ALLERGY_DRAFT_CREATED_FROM_EXTRACTION_EVENT,
  M12_MEDICATION_HISTORY_DRAFT_CREATED_FROM_EXTRACTION_EVENT,
  M22_EXTRACTION_COMMIT_COMPLETED_EVENT,
} from "@wardenx/types";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { ExtractionOutboxPort } from "./writeback-commit-db";

const PROV = schema.extractionProvenance;
const ED = schema.extractionDecisions;
const ER = schema.extractionReviews;
const BATCH = schema.intakeUploadBatches;

export const M22_EXTRACTION_CLINICAL_BACKREF_CONSUMER = {
  eventNames: [
    M12_MEDICATION_HISTORY_DRAFT_CREATED_FROM_EXTRACTION_EVENT,
    M5_ALLERGY_DRAFT_CREATED_FROM_EXTRACTION_EVENT,
  ],
  consumerName: "m22.extraction-clinical-writeback-backref",
} as const;

const TARGET_BY_EVENT: Readonly<Record<string, "m12" | "m5">> = {
  [M12_MEDICATION_HISTORY_DRAFT_CREATED_FROM_EXTRACTION_EVENT]: "m12",
  [M5_ALLERGY_DRAFT_CREATED_FROM_EXTRACTION_EVENT]: "m5",
};

function fail(msg: string): never {
  throw new Error(`${M22_EXTRACTION_CLINICAL_BACKREF_CONSUMER.consumerName}: ${msg}`);
}

export function parseClinicalReply(
  raw: unknown,
  organizationId: string,
): ClinicalDraftCreatedFromExtractionPayload {
  const p = raw as Partial<ClinicalDraftCreatedFromExtractionPayload> | null;
  if (
    !p ||
    typeof p.patientId !== "string" ||
    typeof p.organizationId !== "string" ||
    typeof p.extractionCommitId !== "string" ||
    typeof p.appliedAt !== "string" ||
    !Array.isArray(p.lineOutcomes)
  ) {
    fail("malformed clinical writeback reply — refusing to guess");
  }
  if (p.organizationId !== organizationId) {
    fail(`payload org ${p.organizationId} != outbox row org ${organizationId}`);
  }
  for (const o of p.lineOutcomes as unknown[]) {
    const l = o as Partial<Record<string, unknown>> | null;
    if (!l || typeof l.candidateId !== "string") fail("malformed lineOutcomes entry");
    if (l.outcome === "skipped") continue;
    if (
      (l.outcome !== "created" && l.outcome !== "already_present" && l.outcome !== "duplicate") ||
      typeof l.recordId !== "string"
    ) {
      fail("malformed lineOutcomes entry");
    }
  }
  return p as ClinicalDraftCreatedFromExtractionPayload;
}

/** Build the live binding the composition root registers with the boot outbox dispatcher. */
export function buildM22ExtractionClinicalBackrefConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: ExtractionOutboxPort;
  readonly now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  return {
    consumerName: M22_EXTRACTION_CLINICAL_BACKREF_CONSUMER.consumerName,
    consumerModule: "m22" as const,
    eventTypes: [...M22_EXTRACTION_CLINICAL_BACKREF_CONSUMER.eventNames],
    async handle(event: {
      readonly organizationId: string;
      readonly eventType: string;
      readonly payload: unknown;
    }) {
      const payload = parseClinicalReply(event.payload, event.organizationId);
      // The event type decides the provenance target module; any other name is not ours to stamp.
      const targetModule = TARGET_BY_EVENT[event.eventType];
      if (targetModule === undefined) fail(`unexpected event type ${event.eventType}`);
      const held = payload.lineOutcomes.filter(
        (o): o is Extract<DocLensClinicalLineOutcome, { recordId: string }> =>
          o.outcome !== "skipped",
      );
      const skippedCandidateIds = payload.lineOutcomes
        .filter((o) => o.outcome === "skipped")
        .map((o) => o.candidateId);

      await withOrgContext(
        deps.db,
        { organizationId: event.organizationId, userId: "" },
        async (txRaw) => {
          const tx = txRaw as DbClient;
          const [review] = await tx
            .select({ batchPatientId: BATCH.patientId })
            .from(ER)
            .innerJoin(BATCH, eq(BATCH.id, ER.intakeUploadBatchId))
            .where(eq(ER.id, payload.extractionCommitId))
            .limit(1);
          if (!review) fail(`no extraction_review '${payload.extractionCommitId}' in this tenant`);
          if (review.batchPatientId !== payload.patientId) {
            fail(
              `reply patient ${payload.patientId} is not the commit's target (batch patient ${String(review.batchPatientId)})`,
            );
          }
          if (held.length === 0) return;

          const reviewDecisions = tx
            .select({ id: ED.id })
            .from(ED)
            .where(eq(ED.extractionReviewId, payload.extractionCommitId));
          const stampedIds: string[] = [];
          for (const o of held) {
            const stamped = await tx
              .update(PROV)
              .set({ targetAggregateId: o.recordId })
              .where(
                and(
                  eq(PROV.targetModule, targetModule),
                  isNull(PROV.targetAggregateId),
                  eq(PROV.extractionCandidateId, o.candidateId),
                  inArray(PROV.extractionDecisionId, reviewDecisions),
                ),
              )
              .returning({ id: PROV.id });
            for (const s of stamped) stampedIds.push(s.id);
          }
          if (stampedIds.length === 0) return; // redelivery — already stamped and announced

          const skippedFieldPaths =
            skippedCandidateIds.length === 0
              ? []
              : (
                  await tx
                    .select({ fieldPath: PROV.targetFieldPath })
                    .from(PROV)
                    .where(
                      and(
                        eq(PROV.targetModule, targetModule),
                        inArray(PROV.extractionCandidateId, skippedCandidateIds),
                        inArray(PROV.extractionDecisionId, reviewDecisions),
                      ),
                    )
                ).map((r) => r.fieldPath);

          await deps.outbox.publish(tx, {
            eventName: M22_EXTRACTION_COMMIT_COMPLETED_EVENT,
            payload: {
              extractionCommitId: payload.extractionCommitId,
              targetModule,
              targetAggregateId: payload.patientId,
              provenanceIds: stampedIds,
              skippedFieldPaths,
              completedAt: now().toISOString(),
            },
            organizationId: event.organizationId,
            aggregateKind: "extraction_review",
            aggregateId: payload.extractionCommitId,
          });
        },
      );
    },
  };
}
