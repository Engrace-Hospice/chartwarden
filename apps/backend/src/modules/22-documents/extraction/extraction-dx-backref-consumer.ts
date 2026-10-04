// apps/backend/src/modules/22-documents/extraction/extraction-dx-backref-consumer.ts — the LIVE
// `m7.problem.draft_created_from_extraction` consumer (M22 §4.11 `m{N}-draft-created`; W1 steps 12–13;
// F-238 dx-writeback). The diagnosis twin of `extraction-backref-consumer.ts` (F-235, M5).
//
// M7 replies to `m22.extraction.diagnosis_commit_requested` with a per-diagnosis outcome. For every item
// M7 now holds as a proposal (`proposed` or `already_proposed`) this stamps the item's
// `extraction_provenance` rows with the PROPOSAL id — "which extraction produced this proposed problem?" —
// and emits the terminal `m22.extraction.commit_completed` (`targetModule: 'm7'`). A `skipped` item's
// provenance stays unstamped (the chart holds nothing for it).
//
// Idempotent: only rows still `target_aggregate_id IS NULL` are stamped, and `commit_completed` is emitted
// only when this delivery stamped something. FAIL-CLOSED: a malformed / cross-tenant payload, an item key
// that is not `<extractionJobId>#<n>`, or a reply whose patient is not the commit's target THROWS → DLQ.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
  type DocLensDiagnosisOutcome,
  M7_PROBLEM_DRAFT_CREATED_FROM_EXTRACTION_EVENT,
  M22_EXTRACTION_COMMIT_COMPLETED_EVENT,
  type ProblemDraftCreatedFromExtractionPayload,
} from "@wardenx/types";
import { and, eq, inArray, isNull, like } from "drizzle-orm";
import type { ExtractionOutboxPort } from "./writeback-commit-db";

const PROV = schema.extractionProvenance;
const ED = schema.extractionDecisions;
const EC = schema.extractionCandidates;
const ER = schema.extractionReviews;
const BATCH = schema.intakeUploadBatches;

export const M22_EXTRACTION_DX_BACKREF_CONSUMER = {
  eventName: M7_PROBLEM_DRAFT_CREATED_FROM_EXTRACTION_EVENT,
  consumerName: "m22.extraction-diagnosis-backref",
} as const;

const ITEM_KEY_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})#(\d{1,4})$/i;

function fail(msg: string): never {
  throw new Error(`${M22_EXTRACTION_DX_BACKREF_CONSUMER.consumerName}: ${msg}`);
}

/** `<extractionJobId>#<n>` → its parts, or a fail-closed throw. */
export function parseDiagnosisItemKey(itemKey: string): { jobId: string; index: number } {
  const m = ITEM_KEY_RE.exec(itemKey);
  if (!m) fail(`malformed itemKey '${itemKey}'`);
  return { jobId: (m[1] as string).toLowerCase(), index: Number(m[2]) };
}

function parsePayload(
  raw: unknown,
  organizationId: string,
): ProblemDraftCreatedFromExtractionPayload {
  const p = raw as Partial<ProblemDraftCreatedFromExtractionPayload> | null;
  if (
    !p ||
    typeof p.patientId !== "string" ||
    typeof p.organizationId !== "string" ||
    typeof p.extractionCommitId !== "string" ||
    typeof p.appliedAt !== "string" ||
    !Array.isArray(p.itemOutcomes)
  ) {
    fail("malformed m7.problem.draft_created_from_extraction payload — refusing to guess");
  }
  if (p.organizationId !== organizationId) {
    fail(`payload org ${p.organizationId} != outbox row org ${organizationId}`);
  }
  for (const o of p.itemOutcomes as unknown[]) {
    const f = o as Partial<DocLensDiagnosisOutcome> & { proposalId?: unknown } & {
      reason?: unknown;
    };
    if (!f || typeof f.itemKey !== "string") fail("malformed itemOutcomes entry");
    if (f.outcome === "proposed" || f.outcome === "already_proposed") {
      if (typeof f.proposalId !== "string") fail("held itemOutcome without a proposalId");
    } else if (f.outcome !== "skipped") {
      fail("malformed itemOutcomes entry");
    }
    parseDiagnosisItemKey(f.itemKey);
  }
  return p as ProblemDraftCreatedFromExtractionPayload;
}

/** Build the live binding the composition root registers with the boot outbox dispatcher. */
export function buildM22ExtractionDiagnosisBackrefConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: ExtractionOutboxPort;
  readonly now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  return {
    consumerName: M22_EXTRACTION_DX_BACKREF_CONSUMER.consumerName,
    consumerModule: "m22" as const,
    eventTypes: [M22_EXTRACTION_DX_BACKREF_CONSUMER.eventName] as const,
    async handle(event: { readonly organizationId: string; readonly payload: unknown }) {
      const payload = parsePayload(event.payload, event.organizationId);

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

          const reviewDecisions = tx
            .select({ id: ED.id })
            .from(ED)
            .where(eq(ED.extractionReviewId, payload.extractionCommitId));
          /** The candidate ids of one diagnosis item (same job, same `diagnoses[n]`). */
          const itemCandidates = (itemKey: string) => {
            const { jobId, index } = parseDiagnosisItemKey(itemKey);
            return tx
              .select({ id: EC.id })
              .from(EC)
              .where(
                and(eq(EC.extractionJobId, jobId), like(EC.fieldPath, `diagnoses[${index}].%`)),
              );
          };

          const stampedIds: string[] = [];
          for (const o of payload.itemOutcomes) {
            if (o.outcome === "skipped") continue;
            const stamped = await tx
              .update(PROV)
              .set({ targetAggregateId: o.proposalId })
              .where(
                and(
                  eq(PROV.targetModule, "m7"),
                  isNull(PROV.targetAggregateId),
                  inArray(PROV.extractionDecisionId, reviewDecisions),
                  inArray(PROV.extractionCandidateId, itemCandidates(o.itemKey)),
                ),
              )
              .returning({ id: PROV.id });
            stampedIds.push(...stamped.map((r) => r.id));
          }
          if (stampedIds.length === 0) return; // all skipped, or a redelivery already stamped + announced

          const skippedFieldPaths: string[] = [];
          for (const o of payload.itemOutcomes) {
            if (o.outcome !== "skipped") continue;
            const rows = await tx
              .select({ fieldPath: PROV.targetFieldPath })
              .from(PROV)
              .where(
                and(
                  eq(PROV.targetModule, "m7"),
                  inArray(PROV.extractionDecisionId, reviewDecisions),
                  inArray(PROV.extractionCandidateId, itemCandidates(o.itemKey)),
                ),
              );
            skippedFieldPaths.push(...rows.map((r) => r.fieldPath));
          }

          await deps.outbox.publish(tx, {
            eventName: M22_EXTRACTION_COMMIT_COMPLETED_EVENT,
            payload: {
              extractionCommitId: payload.extractionCommitId,
              targetModule: "m7",
              targetAggregateId: payload.patientId,
              provenanceIds: stampedIds,
              skippedFieldPaths: skippedFieldPaths.sort(),
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
