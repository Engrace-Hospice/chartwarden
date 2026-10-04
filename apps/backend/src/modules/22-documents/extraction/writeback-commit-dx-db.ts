// apps/backend/src/modules/22-documents/extraction/writeback-commit-dx-db.ts — the DIAGNOSIS half of the
// §7.1 W1 steps 11–12 chart-writeback commit (F-238 dx-writeback), run inside `completeReview`'s
// transaction right after the F-235 M5 commit (`writeback-commit-db.ts`, which it mirrors).
//
// Inputs are read ONLY from the server: the review's `extraction_decision` rows joined to their
// `extraction_candidate` → `extraction_job` → `classified_page`, constrained to the review's own batch.
// Values come from the stored candidate (DEK-decrypted here) or the reviewer's stored edit — never from the
// request body, and never from `extraction_candidate.value_code` (a model-assigned code is not an input).
//
// In the completion transaction it inserts one `extraction_provenance` row per committed decision
// (`target_module = 'm7'`, stamped with the proposal id when M7 replies) and publishes ONE
// `m22.extraction.diagnosis_commit_requested` for the batch's patient. A failure throws and rolls the whole
// completion back (the F-235 rule): the review stays `in_progress`, nothing is half-committed.
//
// WHY A SEPARATE EVENT and not `commit_requested` with `targetModule = 'm7'`: M22 D5 names one event with a
// discriminator, but on the outbox every declared consumer receives every row — M5's consumer fail-closes
// (DLQ) on a non-M5 payload, and each target would have to ack the others' commits. One event per target
// keeps each consumer's contract exact; the payload still carries `targetModule` as D5 asks.
import { type DbClient, schema } from "@wardenx/db";
import {
  DegradedError,
  type ExtractionDiagnosisCommitRequestedPayload,
  M22_EXTRACTION_DIAGNOSIS_COMMIT_REQUESTED_EVENT,
  WardenXError,
} from "@wardenx/types";
import { and, eq, inArray, like } from "drizzle-orm";
import type { ExtractionOutboxPort, ExtractionWritebackDeps } from "./writeback-commit-db";
import {
  type DiagnosisCandidateFact,
  type DiagnosisWritebackExclusion,
  planDiagnosisWriteback,
} from "./writeback-plan-dx";

const DOC = schema.documents;
const CP = schema.classifiedPages;
const EJ = schema.extractionJobs;
const ED = schema.extractionDecisions;
const EC = schema.extractionCandidates;
const PROV = schema.extractionProvenance;
const BATCH = schema.intakeUploadBatches;

/** The diagnosis commit's outcome on the `complete` response (ids, keys, paths and reasons — no values). */
export interface ExtractionDiagnosisWritebackSummary {
  readonly targetModule: "m7" | null;
  readonly targetAggregateId: string | null;
  readonly committedItemKeys: readonly string[];
  readonly committedFieldPaths: readonly string[];
  readonly excluded: readonly DiagnosisWritebackExclusion[];
}

export async function commitReviewDiagnosisWriteback(
  tx: DbClient,
  deps: ExtractionWritebackDeps,
  input: {
    readonly organizationId: string;
    readonly reviewId: string;
    readonly batchId: string;
    readonly batchPatientId: string | null;
    readonly reviewerMembershipId: string;
    readonly batchSudStatus?: "not_detected" | "detected" | "confirmed" | "rejected";
  },
): Promise<ExtractionDiagnosisWritebackSummary> {
  const rows = await tx
    .select({
      decisionId: ED.id,
      decision: ED.decision,
      editedValue: ED.editedValue,
      editedCode: ED.editedCode,
      candidateId: EC.id,
      fieldPath: EC.fieldPath,
      sudDetected: EC.sudDetected,
      valueCipher: EC.valueCipher,
      valueText: EC.valueText,
      sourcePage: EC.sourcePage,
      sourceBoundingBox: EC.sourceBoundingBox,
      extractionJobId: EJ.id,
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
      and(
        eq(ED.extractionReviewId, input.reviewId),
        eq(CP.intakeUploadBatchId, input.batchId),
        like(EC.fieldPath, "diagnoses[%"),
      ),
    );
  if (rows.length === 0) {
    return {
      targetModule: null,
      targetAggregateId: null,
      committedItemKeys: [],
      committedFieldPaths: [],
      excluded: [],
    };
  }

  // Decrypt only an approved-as-extracted value (an edit carries its own attested value).
  const facts: DiagnosisCandidateFact[] = [];
  for (const r of rows) {
    let extractedValue: string | null = null;
    if (r.decision === "approve") {
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
      extractionJobId: r.extractionJobId,
      fieldPath: r.fieldPath,
      sudDetected: r.sudDetected,
      extractedValue,
      decision: r.decision,
      editedValue: r.editedValue,
      editedCode: r.editedCode,
      sourceDocumentId: r.sourceDocumentId,
    });
  }

  const plan = planDiagnosisWriteback({
    batchPatientId: input.batchPatientId,
    facts,
    ...(input.batchSudStatus ? { batchSudStatus: input.batchSudStatus } : {}),
  });
  if (plan.items.length === 0 || plan.targetPatientId === null) {
    return {
      targetModule: null,
      targetAggregateId: null,
      committedItemKeys: [],
      committedFieldPaths: [],
      excluded: plan.excluded,
    };
  }
  const outbox: ExtractionOutboxPort | undefined = deps.outbox;
  if (!outbox) {
    throw new DegradedError(
      "extraction-writeback",
      "no outbox publisher is bound for the DocLens writeback; the review cannot be committed",
    );
  }

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
    if (!r) throw new Error(`diagnosis writeback plan referenced unknown decision ${c.decisionId}`);
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
      targetModule: "m7",
      targetFieldPath: c.fieldPath,
      targetAggregateId: null, // the M7 proposal id, stamped when M7 replies
    });
  }

  // The as-of date M38 validates the printed codes against: the day the referral packet arrived.
  const [batch] = await tx
    .select({ uploadedAt: BATCH.uploadedAt })
    .from(BATCH)
    .where(eq(BATCH.id, input.batchId))
    .limit(1);
  const now = deps.now?.() ?? new Date();
  const referralDate = (batch?.uploadedAt ?? now).toISOString().slice(0, 10);

  const payload: ExtractionDiagnosisCommitRequestedPayload = {
    extractionCommitId: input.reviewId,
    organizationId: input.organizationId,
    intakeBatchId: input.batchId,
    targetModule: "m7",
    targetAggregateId: plan.targetPatientId,
    sourceDocumentIds,
    reviewerMembershipId: input.reviewerMembershipId,
    referralDate,
    diagnoses: plan.items,
    requestedAt: now.toISOString(),
  };
  await outbox.publish(tx, {
    eventName: M22_EXTRACTION_DIAGNOSIS_COMMIT_REQUESTED_EVENT,
    payload: payload as unknown as Record<string, unknown>,
    organizationId: input.organizationId,
    aggregateKind: "extraction_review",
    aggregateId: input.reviewId,
  });

  return {
    targetModule: "m7",
    targetAggregateId: plan.targetPatientId,
    committedItemKeys: plan.items.map((i) => i.itemKey),
    committedFieldPaths: plan.committed.map((c) => c.fieldPath),
    excluded: plan.excluded,
  };
}
