// apps/backend/src/modules/22-documents/events-by-m22-clinical.ts — the F-238 half of M22's outbox catalog:
// the DocLens medication-history (→ M12) and allergy (→ M5) commit requests. Spread into
// `M22_OUTBOX_EVENTS` (events-by-m22.ts), so the boot catalog and `arch:outbox-bindings` see them there.
//
// WHY TWO EVENTS, NOT `commit_requested` WITH A WIDER `targetModule`. M22 D5 sketches ONE request event with
// a `targetModule` discriminator. The dispatcher delivers an event to EVERY declared consumer, and the live
// M5 demographics consumer (F-235) fails closed — throws → DLQ — on any `targetModule` other than `m5`.
// A discriminated single event would therefore make each target's consumer receive, and have to correctly
// ignore, every other target's PHI payload. One event per target keeps each payload with the one module
// that applies it. The shape is still D5's: `targetModule` + `targetAggregateId`, server-side attested
// values, a `m{N}.{aggregate}.draft_created_from_extraction` reply, provenance stamped by M22.
import { Type } from "@sinclair/typebox";
import {
  M22_EXTRACTION_ALLERGIES_REQUESTED_EVENT,
  M22_EXTRACTION_MEDICATION_HISTORY_REQUESTED_EVENT,
  type ModuleEventContribution,
} from "@chartwarden/types";

const Id = Type.String({ minLength: 1 });
const Iso = Type.String({ minLength: 1 });

const Line = Type.Object({
  candidateId: Id,
  decisionId: Id,
  fieldPath: Id,
  lineIndex: Type.Integer({ minimum: 0 }),
  text: Type.String({ minLength: 1, maxLength: 500 }),
  sourceDocumentId: Id,
  sourcePage: Type.Integer({ minimum: 0 }),
});

const commitPayload = (targetModule: "m12" | "m5") =>
  Type.Object({
    extractionCommitId: Id,
    organizationId: Id,
    intakeBatchId: Id,
    targetModule: Type.Literal(targetModule),
    targetAggregateId: Id,
    reviewerMembershipId: Id,
    batchSudStatus: Type.Union([
      Type.Literal("not_detected"),
      Type.Literal("detected"),
      Type.Literal("confirmed"),
      Type.Literal("rejected"),
    ]),
    lines: Type.Array(Line, { minItems: 1 }),
    requestedAt: Iso,
  });

export const M22_CLINICAL_WRITEBACK_EVENTS: ModuleEventContribution = [
  {
    eventName: M22_EXTRACTION_MEDICATION_HISTORY_REQUESTED_EVENT,
    moduleOwner: "m22",
    description:
      "A completed DocLens review's approved MEDICATION lines for ONE resolved patient (F-238). Each line is the reviewer-attested text, verbatim — never parsed or coded. M12 records them as reconciliation-only `medication_history_record` rows (source `doclens_intake`; D10 — never linked to, and never creating, a `medication_order`, D12) and replies with `m12.medication_history_record.draft_created_from_extraction`. MAT-drug lines and SUD-flagged candidates never appear unless the batch's SUD detection was rejected as a false positive.",
    payloadSchema: commitPayload("m12"),
    declaredConsumers: ["m12"],
    isOutboxOnly: true,
  },
  {
    eventName: M22_EXTRACTION_ALLERGIES_REQUESTED_EVENT,
    moduleOwner: "m22",
    description:
      "A completed DocLens review's approved ALLERGY lines for ONE resolved patient (F-238). M5 records each as an UNVERIFIED `patient_allergy` (source `intake_extraction`) for a clinician to verify or mark entered-in-error, and replies with `m5.patient_allergy.draft_created_from_extraction`.",
    payloadSchema: commitPayload("m5"),
    declaredConsumers: ["m5"],
    isOutboxOnly: true,
  },
];
