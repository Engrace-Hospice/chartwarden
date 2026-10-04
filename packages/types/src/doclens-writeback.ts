// @wardenx/types — the DocLens → M5 demographics WRITEBACK contract (F-235, #248).
//
// The M22 §7.1 W1 steps 11–13 chart-writeback handshake, narrowed by two decisions recorded in
// docs/history/outbox-248-builds.md (F-231 options A1 + B, decided 2026-10-03):
//
//   A1 — MEDICATIONS ARE EXCLUDED from DocLens writeback. M12 D12 and AI Governance §2.1.1 hard-block
//        AI-introduced medication changes; extracted medications stay read-only review evidence. Nothing
//        in this contract can target M12, and `m12.medication_order.draft_created_from_extraction` has no
//        M22 consumer.
//   B  — the M5 target is a DEMOGRAPHICS UPDATE on the batch's ALREADY-RESOLVED patient (the M29
//        accept→apply precedent, M5 §4.9/§4.10), never a headless patient create, and only for the
//        LOW-RISK CONTACT fields AI Governance §7.3.2 names ("demographics, contacts"). Identity-defining
//        fields (legal name, DOB, sex — they drive M5 §2.3 matching and billing identity), identifiers
//        (MBI/SSN/MRN — never mutable from an external source, M5 D12) and terminology-coded fields
//        (language, marital status — need an M38 value-set mapping nobody has specified) are NOT on it.
//
// Both modules import this one file (M5 and M22 share no `dependsOn` edge; `@wardenx/types` is the leaf
// both may read), so the allowlist the M22 planner applies and the one M5 re-checks on receipt cannot drift.

import type { ChartTargetModule } from "./documents";

/** The patch slot an allowlisted extraction field writes into on the M5 patient. */
export type DocLensM5WritebackSlot =
  | "preferredName"
  | "phoneHome"
  | "phoneMobile"
  | "email"
  | "address.line1"
  | "address.line2"
  | "address.city"
  | "address.state"
  | "address.postalCode";

/**
 * The COMPLETE allowlist of extractor field paths DocLens may write back to M5, keyed by the field path
 * the extractor emits. A field path not in this map is never written back by anyone — it stays review
 * evidence on `extraction_candidate`.
 */
export const DOCLENS_M5_WRITEBACK_FIELDS: Readonly<Record<string, DocLensM5WritebackSlot>> = {
  "patient.preferredName": "preferredName",
  "patient.phoneHome": "phoneHome",
  "patient.phoneMobile": "phoneMobile",
  "patient.email": "email",
  "patient.address.line1": "address.line1",
  "patient.address.line2": "address.line2",
  "patient.address.city": "address.city",
  "patient.address.state": "address.state",
  "patient.address.postalCode": "address.postalCode",
};

/** The one chart-target module DocLens writes back to today (A1 + B). */
export const DOCLENS_WRITEBACK_TARGET_MODULES = [
  "m5",
] as const satisfies readonly ChartTargetModule[];

/** M22 → M5: a completed review's approved, allowlisted demographics for one resolved patient. */
export const M22_EXTRACTION_COMMIT_REQUESTED_EVENT = "m22.extraction.commit_requested" as const;
/** M22 (terminal): M5's reply has been stamped onto `extraction_provenance`. */
export const M22_EXTRACTION_COMMIT_COMPLETED_EVENT = "m22.extraction.commit_completed" as const;
/** M5 → M22: the writeback was applied (the back-ref M22 stamps on `extraction_provenance`). */
export const M5_DRAFT_CREATED_FROM_EXTRACTION_EVENT =
  "m5.patient.draft_created_from_extraction" as const;

/** One approved field in a commit: the extractor field path and the attested value (the reviewer's edit
 *  when `approve_with_edit`, else the decrypted extracted value). */
export interface DocLensCommitField {
  readonly fieldPath: string;
  readonly value: string;
}

/** `m22.extraction.commit_requested` payload (M22 §4.10 row, grouped per target aggregate per W1 step 11). */
export interface ExtractionCommitRequestedPayload {
  /** The commit's correlation id — the `extraction_review` that was completed. One commit per review. */
  readonly extractionCommitId: string;
  readonly organizationId: string;
  readonly intakeBatchId: string;
  readonly targetModule: "m5";
  /** The resolved patient the writeback applies to (`intake_upload_batch.patient_id`). */
  readonly targetAggregateId: string;
  readonly sourceDocumentIds: readonly string[];
  readonly reviewerMembershipId: string;
  readonly fields: readonly DocLensCommitField[];
  readonly requestedAt: string;
}

/** Per-field outcome M5 reports back. `applied` wrote a new chart row; `already_present` found the exact
 *  value already on the chart (a redelivery, or a fax repeating a known contact) and wrote nothing. Both
 *  mean the chart now holds the attested value. `skipped` means it does not, with the reason. */
export type DocLensFieldOutcome =
  | { readonly fieldPath: string; readonly outcome: "applied" | "already_present" }
  | { readonly fieldPath: string; readonly outcome: "skipped"; readonly reason: string };

/** `m5.patient.draft_created_from_extraction` payload — M5's reply to a commit. */
export interface DraftCreatedFromExtractionPayload {
  readonly patientId: string;
  readonly organizationId: string;
  readonly extractionCommitId: string;
  readonly fieldOutcomes: readonly DocLensFieldOutcome[];
  readonly appliedAt: string;
}
