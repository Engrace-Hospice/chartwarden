// apps/backend/src/modules/22-documents/extraction/extraction-backref-consumer.ts — the LIVE
// `m5.patient.draft_created_from_extraction` consumer (M22 §4.11 `m5-draft-created.ts`; W1 steps 12–13;
// F-235, #248).
//
// M5 replies to `m22.extraction.commit_requested` with a per-field outcome. For every field the chart now
// holds (`applied` or `already_present`) this stamps `extraction_provenance.target_aggregate_id` with the
// patient — the "what extraction produced this chart row?" answer §3.3 exists for — and then emits the
// terminal `m22.extraction.commit_completed`. A `skipped` field's provenance stays unstamped: it would be a
// false claim that the chart holds a value it does not.
//
// Idempotent: only rows still `target_aggregate_id IS NULL` are stamped, and `commit_completed` is emitted
// only when this delivery stamped something — so a redelivery (dispatcher crash between handle() and the
// receipt write) is a no-op rather than a second terminal event.
//
// FAIL-CLOSED: a malformed payload, a cross-tenant payload, or a reply whose patient is not the one the
// commit targeted (the batch's `patient_id`) THROWS → retry → DLQ. Never a guessed stamp.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  type DocLensFieldOutcome,
  type DraftCreatedFromExtractionPayload,
  M5_DRAFT_CREATED_FROM_EXTRACTION_EVENT,
  M22_EXTRACTION_COMMIT_COMPLETED_EVENT,
} from "@chartwarden/types";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { ExtractionOutboxPort } from "./writeback-commit-db";

const PROV = schema.extractionProvenance;
const ED = schema.extractionDecisions;
const ER = schema.extractionReviews;
const BATCH = schema.intakeUploadBatches;

export const M22_EXTRACTION_BACKREF_CONSUMER = {
  eventName: M5_DRAFT_CREATED_FROM_EXTRACTION_EVENT,
  consumerName: "m22.extraction-writeback-backref",
} as const;

function fail(msg: string): never {
  throw new Error(`${M22_EXTRACTION_BACKREF_CONSUMER.consumerName}: ${msg}`);
}

function parsePayload(raw: unknown, organizationId: string): DraftCreatedFromExtractionPayload {
  const p = raw as Partial<DraftCreatedFromExtractionPayload> | null;
  if (
    !p ||
    typeof p.patientId !== "string" ||
    typeof p.organizationId !== "string" ||
    typeof p.extractionCommitId !== "string" ||
    typeof p.appliedAt !== "string" ||
    !Array.isArray(p.fieldOutcomes)
  ) {
    fail("malformed m5.patient.draft_created_from_extraction payload — refusing to guess");
  }
  if (p.organizationId !== organizationId) {
    fail(`payload org ${p.organizationId} != outbox row org ${organizationId}`);
  }
  for (const o of p.fieldOutcomes as unknown[]) {
    const f = o as Partial<DocLensFieldOutcome> | null;
    if (
      !f ||
      typeof f.fieldPath !== "string" ||
      (f.outcome !== "applied" && f.outcome !== "already_present" && f.outcome !== "skipped")
    ) {
      fail("malformed fieldOutcomes entry");
    }
  }
  return p as DraftCreatedFromExtractionPayload;
}

/** Build the live binding the composition root registers with the boot outbox dispatcher. */
export function buildM22ExtractionBackrefConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: ExtractionOutboxPort;
  readonly now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  return {
    consumerName: M22_EXTRACTION_BACKREF_CONSUMER.consumerName,
    consumerModule: "m22" as const,
    eventTypes: [M22_EXTRACTION_BACKREF_CONSUMER.eventName] as const,
    async handle(event: { readonly organizationId: string; readonly payload: unknown }) {
      const payload = parsePayload(event.payload, event.organizationId);
      const held = payload.fieldOutcomes
        .filter((o) => o.outcome === "applied" || o.outcome === "already_present")
        .map((o) => o.fieldPath);
      const skipped = payload.fieldOutcomes
        .filter((o) => o.outcome === "skipped")
        .map((o) => o.fieldPath);

      await withOrgContext(
        deps.db,
        { organizationId: event.organizationId, userId: "" },
        async (txRaw) => {
          const tx = txRaw as DbClient;
          // The commit id is the completed review; its batch's patient is the only legal target.
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

          const stamped = await tx
            .update(PROV)
            .set({ targetAggregateId: payload.patientId })
            .where(
              and(
                eq(PROV.targetModule, "m5"),
                isNull(PROV.targetAggregateId),
                inArray(PROV.targetFieldPath, held),
                inArray(
                  PROV.extractionDecisionId,
                  tx
                    .select({ id: ED.id })
                    .from(ED)
                    .where(eq(ED.extractionReviewId, payload.extractionCommitId)),
                ),
              ),
            )
            .returning({ id: PROV.id });
          if (stamped.length === 0) return; // redelivery — already stamped and announced

          await deps.outbox.publish(tx, {
            eventName: M22_EXTRACTION_COMMIT_COMPLETED_EVENT,
            payload: {
              extractionCommitId: payload.extractionCommitId,
              targetModule: "m5",
              targetAggregateId: payload.patientId,
              provenanceIds: stamped.map((r) => r.id),
              skippedFieldPaths: skipped,
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
