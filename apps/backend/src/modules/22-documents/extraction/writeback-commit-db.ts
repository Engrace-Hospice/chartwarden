// apps/backend/src/modules/22-documents/extraction/writeback-commit-db.ts — the §7.1 W1 steps 11–12
// chart-writeback COMMIT, run inside `completeReview`'s transaction (F-235, #248).
//
// Inputs are read ONLY from the server: the review's `extraction_decision` rows joined to their
// `extraction_candidate` → `extraction_job` → `classified_page`, constrained to the review's own batch (a
// decision pointing at another batch's candidate is simply not loaded). Values come from the stored
// candidate (`value_cipher`, DEK-decrypted here; or `value_text`) or the reviewer's stored
// `edited_value` — never from the request body.
//
// In ONE transaction with the review's `complete` transition it inserts one `extraction_provenance` row per
// committed decision and publishes `m22.extraction.commit_requested` through the catalog-validating
// publisher. Any failure (no publisher, no cipher for a ciphered value, a source document with no
// version) throws and rolls the whole completion back: the review stays `in_progress`, nothing is
// half-committed, and the reviewer sees the error instead of a "complete" that wrote nothing.
import { type DbClient, schema } from "@wardenx/db";
import {
  DOCLENS_M5_WRITEBACK_FIELDS,
  DegradedError,
  type ExtractionCommitRequestedPayload,
  M22_EXTRACTION_COMMIT_REQUESTED_EVENT,
  WardenXError,
} from "@wardenx/types";
import { and, eq, inArray } from "drizzle-orm";
import type { CandidateValueCipher } from "./candidate-value-cipher";
import {
  type WritebackCandidateFact,
  type WritebackExclusion,
  planDocLensWriteback,
} from "./writeback-plan";

const DOC = schema.documents;
const CP = schema.classifiedPages;
const EJ = schema.extractionJobs;
const ED = schema.extractionDecisions;
const EC = schema.extractionCandidates;
const PROV = schema.extractionProvenance;

/** The catalog-validating tx publisher, bound to `m22` at the composition root (structural). */
export interface ExtractionOutboxPort {
  publish(
    tx: DbClient,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

/** What the writeback commit needs beyond the database. Both absent on a slice/no-KMS boot. */
export interface ExtractionWritebackDeps {
  readonly outbox?: ExtractionOutboxPort;
  readonly cipher?: CandidateValueCipher;
  readonly now?: () => Date;
}

/** The commit's outcome, returned on the `complete` response (ids, paths and reasons only — no values). */
export interface ExtractionWritebackSummary {
  readonly targetModule: "m5" | null;
  readonly targetAggregateId: string | null;
  readonly committedFieldPaths: readonly string[];
  readonly excluded: readonly WritebackExclusion[];
}

export async function commitReviewWriteback(
  tx: DbClient,
  deps: ExtractionWritebackDeps,
  input: {
    readonly organizationId: string;
    readonly reviewId: string;
    readonly batchId: string;
    readonly batchPatientId: string | null;
    readonly reviewerMembershipId: string;
    /** F-237 — see `planDocLensWriteback`'s `batchSudStatus`. */
    readonly batchSudStatus?: "not_detected" | "detected" | "confirmed" | "rejected";
  },
): Promise<ExtractionWritebackSummary> {
  const rows = await tx
    .select({
      decisionId: ED.id,
      decision: ED.decision,
      editedValue: ED.editedValue,
      candidateId: EC.id,
      fieldPath: EC.fieldPath,
      riskLevel: EC.riskLevel,
      sudDetected: EC.sudDetected,
      valueCipher: EC.valueCipher,
      valueText: EC.valueText,
      sourcePage: EC.sourcePage,
      sourceBoundingBox: EC.sourceBoundingBox,
      extractorModelVersionRef: EJ.extractorModelVersionRef,
      visionVerifierModelVersionRef: EJ.visionVerifierModelVersionRef,
      sourceDocumentId: CP.sourceDocumentId,
      classifierModelVersionRef: CP.classifierModelVersionRef,
    })
    .from(ED)
    .innerJoin(EC, eq(EC.id, ED.extractionCandidateId))
    .innerJoin(EJ, eq(EJ.id, EC.extractionJobId))
    .innerJoin(CP, eq(CP.id, EJ.classifiedPageId))
    .where(
      and(eq(ED.extractionReviewId, input.reviewId), eq(CP.intakeUploadBatchId, input.batchId)),
    );

  // Decrypt only what could be committed: an approved (not edited), allowlisted candidate. A medication or
  // any other non-target value is never decrypted on this path.
  const facts: WritebackCandidateFact[] = [];
  for (const r of rows) {
    let extractedValue: string | null = null;
    const needsValue =
      r.decision === "approve" && Object.hasOwn(DOCLENS_M5_WRITEBACK_FIELDS, r.fieldPath);
    if (needsValue) {
      if (r.valueCipher !== null) {
        if (!deps.cipher) {
          throw new DegradedError(
            "extraction-writeback",
            "no tenant-DEK cipher is bound for extraction candidate values; the review cannot be committed",
          );
        }
        extractedValue = await deps.cipher.decrypt(input.organizationId, r.valueCipher);
      } else {
        extractedValue = r.valueText;
      }
    }
    facts.push({
      candidateId: r.candidateId,
      decisionId: r.decisionId,
      fieldPath: r.fieldPath,
      riskLevel: r.riskLevel,
      sudDetected: r.sudDetected,
      extractedValue,
      decision: r.decision,
      editedValue: r.editedValue,
      sourceDocumentId: r.sourceDocumentId,
    });
  }

  const plan = planDocLensWriteback({
    batchPatientId: input.batchPatientId,
    facts,
    ...(input.batchSudStatus ? { batchSudStatus: input.batchSudStatus } : {}),
  });
  if (plan.committed.length === 0 || plan.targetPatientId === null) {
    return {
      targetModule: null,
      targetAggregateId: null,
      committedFieldPaths: [],
      excluded: plan.excluded,
    };
  }
  if (!deps.outbox) {
    throw new DegradedError(
      "extraction-writeback",
      "no outbox publisher is bound for the DocLens writeback; the review cannot be committed",
    );
  }

  // Provenance needs the source document's CURRENT version (§3.3, NOT NULL). An intake batch whose source
  // document was never filed has nothing to cite — refuse rather than invent a version id.
  const sourceDocumentIds = [...new Set(plan.committed.map((c) => c.sourceDocumentId))];
  const docs = await tx
    .select({ id: DOC.id, activeVersionId: DOC.activeVersionId })
    .from(DOC)
    .where(inArray(DOC.id, sourceDocumentIds));
  const versionByDoc = new Map(docs.map((d) => [d.id, d.activeVersionId]));
  for (const id of sourceDocumentIds) {
    if (!versionByDoc.get(id)) {
      throw new WardenXError(
        "SOURCE_DOCUMENT_UNRESOLVED",
        "an approved field's source document has no filed version to cite as provenance; the review cannot be committed",
        409,
      );
    }
  }

  const rowByDecision = new Map(rows.map((r) => [r.decisionId, r]));
  for (const c of plan.committed) {
    const r = rowByDecision.get(c.decisionId);
    if (!r) throw new Error(`writeback plan referenced unknown decision ${c.decisionId}`);
    await tx.insert(PROV).values({
      organizationId: input.organizationId,
      extractionDecisionId: c.decisionId,
      extractionCandidateId: c.candidateId,
      sourceDocumentId: c.sourceDocumentId,
      sourceDocumentVersionId: versionByDoc.get(c.sourceDocumentId) as string,
      sourcePage: r.sourcePage,
      sourceBoundingBox: r.sourceBoundingBox,
      classifierModelVersionRef: r.classifierModelVersionRef,
      extractorModelVersionRef: r.extractorModelVersionRef,
      visionVerifierModelVersionRef: r.visionVerifierModelVersionRef,
      targetModule: "m5",
      targetFieldPath: c.fieldPath,
      targetAggregateId: null, // stamped when M5 replies (m5.patient.draft_created_from_extraction)
    });
  }

  const payload: ExtractionCommitRequestedPayload = {
    extractionCommitId: input.reviewId,
    organizationId: input.organizationId,
    intakeBatchId: input.batchId,
    targetModule: "m5",
    targetAggregateId: plan.targetPatientId,
    sourceDocumentIds,
    reviewerMembershipId: input.reviewerMembershipId,
    fields: plan.fields,
    requestedAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  await deps.outbox.publish(tx, {
    eventName: M22_EXTRACTION_COMMIT_REQUESTED_EVENT,
    payload: payload as unknown as Record<string, unknown>,
    organizationId: input.organizationId,
    aggregateKind: "extraction_review",
    aggregateId: input.reviewId,
  });

  return {
    targetModule: "m5",
    targetAggregateId: plan.targetPatientId,
    committedFieldPaths: plan.fields.map((f) => f.fieldPath),
    excluded: plan.excluded,
  };
}
