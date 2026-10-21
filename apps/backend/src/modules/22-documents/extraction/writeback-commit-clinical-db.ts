// apps/backend/src/modules/22-documents/extraction/writeback-commit-clinical-db.ts — the F-238 commit of a
// completed review's approved MEDICATION and ALLERGY lines, run inside `completeReview`'s transaction right
// after F-235's demographics commit (`writeback-commit-db.ts`, untouched).
//
// Same discipline as F-235: inputs are read ONLY from the server (the review's own decisions joined to
// candidates of the review's own batch); values come from the stored candidate (DEK-decrypted here) or
// the reviewer's stored edit; one `extraction_provenance` row per planned line; and the events go out
// through the catalog-validating publisher in THIS transaction — any failure rolls the completion back.
//
//   medication lines → `m22.extraction.medication_history_requested` → M12 writes reconciliation-only
//                      `medication_history_record` rows (source `doclens_intake`). NEVER a medication_order.
//   allergy lines    → `m22.extraction.allergies_requested` → M5 writes `unverified` `patient_allergy` rows.
//
// Both replies are stamped back onto the provenance rows by `extraction-clinical-backref-consumer.ts`.
import { type DbClient, schema } from "@wardenx/db";
import {
  DegradedError,
  type DocLensBatchSudStatus,
  type DocLensClinicalLine,
  type ExtractionAllergiesRequestedPayload,
  type ExtractionMedicationHistoryRequestedPayload,
  M22_EXTRACTION_ALLERGIES_REQUESTED_EVENT,
  M22_EXTRACTION_MEDICATION_HISTORY_REQUESTED_EVENT,
  ChartWardenError,
} from "@wardenx/types";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { ExtractionWritebackDeps } from "./writeback-commit-db";
import {
  type ClinicalCandidateFact,
  type ClinicalWritebackExclusion,
  clinicalWritebackTargetOf,
  planDocLensClinicalWriteback,
} from "./writeback-plan-clinical";

const DOC = schema.documents;
const CP = schema.classifiedPages;
const EJ = schema.extractionJobs;
const ED = schema.extractionDecisions;
const EC = schema.extractionCandidates;
const PROV = schema.extractionProvenance;

/** The clinical commit's outcome on the `complete` response (ids, paths and reasons only — no values). */
export interface ClinicalWritebackSummary {
  readonly targetPatientId: string | null;
  /** Candidate field paths sent to M12 as medication-history lines. */
  readonly medicationHistoryFieldPaths: readonly string[];
  /** Candidate field paths sent to M5 as unverified allergies. */
  readonly allergyFieldPaths: readonly string[];
  readonly excluded: readonly ClinicalWritebackExclusion[];
}

export async function commitClinicalWriteback(
  tx: DbClient,
  deps: ExtractionWritebackDeps,
  input: {
    readonly organizationId: string;
    readonly reviewId: string;
    readonly batchId: string;
    readonly batchPatientId: string | null;
    readonly reviewerMembershipId: string;
    readonly batchSudStatus: DocLensBatchSudStatus;
  },
): Promise<ClinicalWritebackSummary> {
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
      and(
        eq(ED.extractionReviewId, input.reviewId),
        eq(CP.intakeUploadBatchId, input.batchId),
        // F-238 — a document a reviewer marked as ANOTHER patient's never reaches this patient's chart.
        or(isNull(CP.identityResolution), ne(CP.identityResolution, "other_patient")),
      ),
    );

  // Decrypt only an APPROVED (not edited) medication/allergy candidate — nothing else on this path.
  const facts: ClinicalCandidateFact[] = [];
  for (const r of rows) {
    if (clinicalWritebackTargetOf(r.fieldPath) === null) continue;
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
      fieldPath: r.fieldPath,
      riskLevel: r.riskLevel,
      sudDetected: r.sudDetected,
      extractedValue,
      decision: r.decision,
      editedValue: r.editedValue,
      sourceDocumentId: r.sourceDocumentId,
      sourcePage: r.sourcePage,
    });
  }

  const plan = planDocLensClinicalWriteback({
    batchPatientId: input.batchPatientId,
    batchSudStatus: input.batchSudStatus,
    facts,
  });
  const summary: ClinicalWritebackSummary = {
    targetPatientId: plan.targetPatientId,
    medicationHistoryFieldPaths: plan.medicationLines.map((l) => l.fieldPath),
    allergyFieldPaths: plan.allergyLines.map((l) => l.fieldPath),
    excluded: plan.excluded,
  };
  const patientId = plan.targetPatientId;
  if (patientId === null) return summary;
  if (!deps.outbox) {
    throw new DegradedError(
      "extraction-writeback",
      "no outbox publisher is bound for the WardenLens writeback; the review cannot be committed",
    );
  }
  const outbox = deps.outbox;

  const allLines = [...plan.medicationLines, ...plan.allergyLines];
  const sourceDocumentIds = [...new Set(allLines.map((l) => l.sourceDocumentId))];
  const docs = await tx
    .select({ id: DOC.id, activeVersionId: DOC.activeVersionId })
    .from(DOC)
    .where(inArray(DOC.id, sourceDocumentIds));
  const versionByDoc = new Map(docs.map((d) => [d.id, d.activeVersionId]));
  for (const id of sourceDocumentIds) {
    if (!versionByDoc.get(id)) {
      throw new ChartWardenError(
        "SOURCE_DOCUMENT_UNRESOLVED",
        "an approved field's source document has no filed version to cite as provenance; the review cannot be committed",
        409,
      );
    }
  }

  const rowByDecision = new Map(rows.map((r) => [r.decisionId, r]));
  const insertProvenance = async (
    lines: readonly DocLensClinicalLine[],
    targetModule: "m12" | "m5",
  ): Promise<void> => {
    for (const l of lines) {
      const r = rowByDecision.get(l.decisionId);
      if (!r)
        throw new Error(`clinical writeback plan referenced unknown decision ${l.decisionId}`);
      await tx.insert(PROV).values({
        organizationId: input.organizationId,
        extractionDecisionId: l.decisionId,
        extractionCandidateId: l.candidateId,
        sourceDocumentId: l.sourceDocumentId,
        sourceDocumentVersionId: versionByDoc.get(l.sourceDocumentId) as string,
        sourcePage: r.sourcePage,
        sourceBoundingBox: r.sourceBoundingBox,
        classifierModelVersionRef: r.classifierModelVersionRef,
        extractorModelVersionRef: r.extractorModelVersionRef,
        visionVerifierModelVersionRef: r.visionVerifierModelVersionRef,
        targetModule,
        targetFieldPath: l.fieldPath,
        targetAggregateId: null, // stamped from the target module's per-line reply (the row it wrote)
      });
    }
  };

  const requestedAt = (deps.now?.() ?? new Date()).toISOString();
  const base = {
    extractionCommitId: input.reviewId,
    organizationId: input.organizationId,
    intakeBatchId: input.batchId,
    targetAggregateId: patientId,
    reviewerMembershipId: input.reviewerMembershipId,
    batchSudStatus: input.batchSudStatus,
    requestedAt,
  };

  if (plan.medicationLines.length > 0) {
    await insertProvenance(plan.medicationLines, "m12");
    const payload: ExtractionMedicationHistoryRequestedPayload = {
      ...base,
      targetModule: "m12",
      lines: plan.medicationLines,
    };
    await outbox.publish(tx, {
      eventName: M22_EXTRACTION_MEDICATION_HISTORY_REQUESTED_EVENT,
      payload: payload as unknown as Record<string, unknown>,
      organizationId: input.organizationId,
      aggregateKind: "extraction_review",
      aggregateId: input.reviewId,
    });
  }
  if (plan.allergyLines.length > 0) {
    await insertProvenance(plan.allergyLines, "m5");
    const payload: ExtractionAllergiesRequestedPayload = {
      ...base,
      targetModule: "m5",
      lines: plan.allergyLines,
    };
    await outbox.publish(tx, {
      eventName: M22_EXTRACTION_ALLERGIES_REQUESTED_EVENT,
      payload: payload as unknown as Record<string, unknown>,
      organizationId: input.organizationId,
      aggregateKind: "extraction_review",
      aggregateId: input.reviewId,
    });
  }
  return summary;
}
