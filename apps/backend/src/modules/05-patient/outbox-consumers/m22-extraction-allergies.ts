// apps/backend/src/modules/05-patient/outbox-consumers/m22-extraction-allergies.ts — the LIVE
// `m22.extraction.allergies_requested` consumer: M5's half of the DocLens allergy writeback (F-238).
//
// The allergy list is M5's (architecture §10.6.6: "Allergies → Module 5 → Allergy (linked to Patient)").
// Each line a DocLens reviewer attested becomes ONE `patient_allergy` row, `verification_status =
// 'unverified'`, `source = 'intake_extraction'`, the line verbatim in `allergen_text` — the reviewer
// attested that the referral fax SAYS this, not that it is clinically confirmed. A clinician verifies it
// or marks it entered-in-error (`POST /api/v1/patients/:id/allergies/:allergyId/verify|entered-in-error`).
// Unverified is still shown to prescribers, labelled (an unverified allergy is safer shown than hidden).
// `reaction` / `severity` are never inferred here — the reaction, when the fax stated one, is inside the
// verbatim text.
//
// IDEMPOTENT + DEDUPED (the M12 sibling's rules): a line whose candidate already has a row →
// `already_present`; a line whose dedupe key matches an existing NON-entered-in-error allergy on this
// patient (any source) → `duplicate` (flagged back, not written twice). An allergy a clinician marked
// entered-in-error does not block a later fax from reporting it again — that is a new claim to verify.
//
// FAIL DIRECTIONS (the F-235 consumer's): malformed / cross-tenant / wrong-target payload, unknown patient,
// or a MERGED patient THROW (retry → DLQ). ONE TRANSACTION with the reply.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
  type ClinicalDraftCreatedFromExtractionPayload,
  type DocLensClinicalLineOutcome,
  type ExtractionAllergiesRequestedPayload,
  M5_ALLERGY_DRAFT_CREATED_FROM_EXTRACTION_EVENT,
  M22_EXTRACTION_ALLERGIES_REQUESTED_EVENT,
  doclensClinicalLineKey,
  parseDocLensClinicalCommit,
} from "@wardenx/types";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { M5OutboxPort } from "../deceased-db";

const P = schema.patients;
const ALG = schema.patientAllergies;

export const M5_EXTRACTION_ALLERGY_CONSUMER = {
  eventName: M22_EXTRACTION_ALLERGIES_REQUESTED_EVENT,
  consumerName: "m5.extraction-allergy-writeback",
} as const;

function fail(msg: string): never {
  throw new Error(`${M5_EXTRACTION_ALLERGY_CONSUMER.consumerName}: ${msg}`);
}

/** Apply one commit in ONE transaction; returns the reply it published. */
export async function applyAllergyWriteback(
  db: DbClient,
  outbox: M5OutboxPort,
  payload: ExtractionAllergiesRequestedPayload,
  now: () => Date = () => new Date(),
): Promise<ClinicalDraftCreatedFromExtractionPayload> {
  const organizationId = payload.organizationId;
  const patientId = payload.targetAggregateId;
  return withOrgContext<DbClient, ClinicalDraftCreatedFromExtractionPayload>(
    db,
    { organizationId, userId: "" },
    async (tx) => {
      const [patient] = await tx
        .select({
          status: P.status,
          providerEntityId: P.providerEntityId,
          locationId: P.locationId,
        })
        .from(P)
        .where(eq(P.id, patientId))
        .limit(1);
      if (!patient) fail(`patient '${patientId}' not found in this tenant`);
      if (patient.status === "merged") {
        fail(`patient '${patientId}' is merged — a writeback to a merged chart needs a human`);
      }

      const keyed = payload.lines.map((l) => ({ line: l, key: doclensClinicalLineKey(l.text) }));
      const existingByCandidate = new Map(
        (
          await tx
            .select({ id: ALG.id, candidateId: ALG.sourceExtractionCandidateId })
            .from(ALG)
            .where(
              inArray(
                ALG.sourceExtractionCandidateId,
                keyed.map((k) => k.line.candidateId),
              ),
            )
        ).map((r) => [r.candidateId as string, r.id]),
      );
      const existingByKey = new Map(
        (
          await tx
            .select({ id: ALG.id, key: ALG.allergenKey })
            .from(ALG)
            .where(
              and(
                eq(ALG.patientId, patientId),
                ne(ALG.verificationStatus, "entered_in_error"),
                inArray(
                  ALG.allergenKey,
                  keyed.map((k) => k.key),
                ),
              ),
            )
        ).map((r) => [r.key, r.id]),
      );

      const reportedAt = new Date(payload.requestedAt);
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
          .insert(ALG)
          .values({
            organizationId,
            providerEntityId: patient.providerEntityId,
            locationId: patient.locationId,
            patientId,
            allergenText: line.text,
            allergenKey: key,
            verificationStatus: "unverified",
            source: "intake_extraction",
            sourceExtractionCandidateId: line.candidateId,
            sourceExtractionDecisionId: line.decisionId,
            sourceExtractionCommitId: payload.extractionCommitId,
            sourceDocumentId: line.sourceDocumentId,
            sourcePage: line.sourcePage,
            reportedByMembershipId: payload.reviewerMembershipId,
            reportedAt: Number.isNaN(reportedAt.getTime()) ? now() : reportedAt,
          })
          .returning({ id: ALG.id });
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
        eventName: M5_ALLERGY_DRAFT_CREATED_FROM_EXTRACTION_EVENT,
        payload: reply as unknown as Record<string, unknown>,
        organizationId,
        aggregateKind: "patient",
        aggregateId: patientId,
      });
      return reply;
    },
  );
}

/** Build the live binding the composition root registers with the boot outbox dispatcher. */
export function buildM5ExtractionAllergyConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: M5OutboxPort;
  readonly now?: () => Date;
}) {
  return {
    consumerName: M5_EXTRACTION_ALLERGY_CONSUMER.consumerName,
    consumerModule: "m5" as const,
    eventTypes: [M5_EXTRACTION_ALLERGY_CONSUMER.eventName] as const,
    async handle(event: { readonly organizationId: string; readonly payload: unknown }) {
      const parsed = parseDocLensClinicalCommit(event.payload, event.organizationId, "m5");
      if (!parsed.ok) fail(parsed.reason);
      await applyAllergyWriteback(deps.db, deps.outbox, parsed.payload, deps.now);
    },
  };
}
