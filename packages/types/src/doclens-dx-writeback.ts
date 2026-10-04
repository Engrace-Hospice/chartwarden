// @wardenx/types — the DocLens → M7 DIAGNOSIS writeback contract (F-238 dx-writeback).
//
// A completed DocLens review's reviewer-attested diagnoses become PROPOSED problems on M7 — never a
// charted problem. AI Governance v0.2 §2.1.1 ("hard blocks on AI-introduced changes to … codes";
// "explicit clinician acknowledgment") and M22 D5 (outbox only; the target module creates a draft, never
// an active/signed record) fix the shape:
//
//   • M22 sends only what the reviewer attested: the description as written (or the reviewer's edit),
//     the ICD-10-CM code AS PRINTED (every stored candidate value is grounded verbatim in the source text)
//     or as typed by the reviewer — never a model-suggested code (`extraction_candidate.value_code` is
//     never read on this path), and the document's own label for the diagnosis (`documentRole`).
//   • M7 lands each one in its own `problem_proposal` table (status `pending`), NOT in `problem`. Nothing
//     that reads `problem` — claim sequencing, the M7 claim-diagnoses gate, HOPE, the IDG packet, the
//     portal, version snapshots — can see a proposal. A clinician ACCEPTS one (choosing `kind` —
//     terminal/related/unrelated is the hospice physician's determination, never the document's
//     "principal" label) which creates the `problem` row (`source = 'intake_extraction'`), or DISMISSES it.
//
// Both modules import this one file (M7 and M22 share no `dependsOn` edge; `@wardenx/types` is the leaf
// both may read), so the shape/SUD rules M22 applies and M7 re-checks on receipt cannot drift.

/** M22 → M7: a completed review's approved diagnoses for ONE resolved patient. */
export const M22_EXTRACTION_DIAGNOSIS_COMMIT_REQUESTED_EVENT =
  "m22.extraction.diagnosis_commit_requested" as const;
/** M7 → M22: per-item outcomes (the proposals created) — the back-ref M22 stamps on provenance. */
export const M7_PROBLEM_DRAFT_CREATED_FROM_EXTRACTION_EVENT =
  "m7.problem.draft_created_from_extraction" as const;

/** How the SOURCE DOCUMENT labels a diagnosis. A suggestion carried to the accepting clinician — it never
 *  sets `problem.kind` (a document's "principal" is not the hospice terminal diagnosis). */
export type DocLensDiagnosisRole = "principal" | "secondary" | "history" | "unspecified";
export const DOCLENS_DIAGNOSIS_ROLES = [
  "principal",
  "secondary",
  "history",
  "unspecified",
] as const satisfies readonly DocLensDiagnosisRole[];

/** `problem_proposal.status` (mirrors the `problem_proposal_status` enum). */
export type ProblemProposalStatus = "pending" | "accepted" | "dismissed";

/** `problem_proposal.icd10_validation` (mirrors `problem_proposal_icd10_validation`): the M38 verdict on
 *  the as-written code as of the referral date. `unvalidated` = M38 could not answer (ICD-10-CM not
 *  loaded, seam unbound/erroring) — the code is KEPT, never dropped or replaced. */
export type ProblemProposalIcd10Validation = "valid" | "not_valid_as_of" | "unvalidated";

/** Where a proposal's ICD-10 code came from. There is no third value: a model-suggested code is never sent. */
export type DocLensIcd10Source = "document" | "reviewer_edit";

/** The three extractor field slots of one diagnosis (`diagnoses[n].<slot>`); same `n` within one
 *  extraction job = one diagnosis. */
export type DocLensDiagnosisSlot = "description" | "icd10" | "role";

const DIAGNOSIS_FIELD_RE = /^diagnoses\[(\d{1,4})\]\.(description|icd10|role)$/;

/** Parse a diagnosis field path, or null when the path is not one. */
export function parseDiagnosisFieldPath(
  fieldPath: string,
): { readonly index: number; readonly slot: DocLensDiagnosisSlot } | null {
  const m = DIAGNOSIS_FIELD_RE.exec(fieldPath);
  if (!m) return null;
  return { index: Number(m[1]), slot: m[2] as DocLensDiagnosisSlot };
}

/**
 * Normalize an as-written ICD-10-CM code to its canonical dotted, upper-case SHAPE, or null when it is not
 * one. Shape only — existence is M38's call. Accepts `i50.9`, `I509`, ` I50.9 `, `S72.001A`, `C4A.0`, `U07.1`;
 * rejects `I5`, `150.9` (a digit first), `I50.12345`, prose. Never alters a character beyond case, whitespace
 * and the dot position — so the code M7 stores is the code that was printed or typed.
 */
export function normalizeIcd10CmShape(raw: string): string | null {
  const s = raw.replace(/\s+/g, "").toUpperCase().replace(/\.$/, "");
  if (s.length === 0) return null;
  const undotted = s.replace(".", "");
  if (s.includes(".") && s.indexOf(".") !== 3) return null;
  if ((s.match(/\./g) ?? []).length > 1) return null;
  if (!/^[A-Z][0-9][0-9A-Z][0-9A-Z]{0,4}$/.test(undotted)) return null;
  return undotted.length > 3 ? `${undotted.slice(0, 3)}.${undotted.slice(3)}` : undotted;
}

/** 42 CFR Part 2 — an ICD-10-CM substance-related disorder code: F10–F19 EXCLUDING F17 (nicotine). */
export function isSudIcd10Code(code: string | null): boolean {
  if (code === null) return false;
  const n = normalizeIcd10CmShape(code);
  return n !== null && /^F1[0-689]/.test(n);
}

/** The per-patient dedupe key of a proposal: the normalized code when there is one, else the normalized
 *  description. Two pending proposals for one patient never share a key (a DB unique index enforces it). */
export function diagnosisDedupeKey(icd10Code: string | null, description: string): string {
  const code = icd10Code === null ? null : normalizeIcd10CmShape(icd10Code);
  if (code !== null) return `icd10:${code}`;
  return `desc:${description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()}`;
}

/** Map an extracted role label onto the four roles; anything else is `unspecified` (never guessed upward). */
export function normalizeDiagnosisRole(raw: string | null): DocLensDiagnosisRole {
  if (raw === null) return "unspecified";
  const v = raw.trim().toLowerCase();
  if (v === "principal" || v === "primary") return "principal";
  if (v === "secondary" || v === "history" || v === "unspecified") return v;
  return "unspecified";
}

/** One attested diagnosis in a commit. */
export interface DocLensDiagnosisItem {
  /** Stable per (extraction job, index): `<extractionJobId>#<n>`. Idempotency + back-ref key. */
  readonly itemKey: string;
  readonly description: string;
  /** Canonical-shape ICD-10-CM code as printed / as typed by the reviewer, or null when there is none. */
  readonly icd10Code: string | null;
  readonly icd10Source: DocLensIcd10Source | null;
  readonly documentRole: DocLensDiagnosisRole;
  /** 42 CFR Part 2: an F10–F19 (not F17) code or SUD wording. M7 re-derives from the code and ORs. */
  readonly sudRelated: boolean;
}

/** `m22.extraction.diagnosis_commit_requested` payload. */
export interface ExtractionDiagnosisCommitRequestedPayload {
  /** The completed `extraction_review` — one commit per review. */
  readonly extractionCommitId: string;
  readonly organizationId: string;
  readonly intakeBatchId: string;
  readonly targetModule: "m7";
  /** The resolved patient (`intake_upload_batch.patient_id`); M7 resolves the care plan itself. */
  readonly targetAggregateId: string;
  readonly sourceDocumentIds: readonly string[];
  readonly reviewerMembershipId: string;
  /** The as-of date (YYYY-MM-DD) M38 validates codes against: the day the referral packet was received. */
  readonly referralDate: string;
  readonly diagnoses: readonly DocLensDiagnosisItem[];
  readonly requestedAt: string;
}

/** Per-item outcome M7 reports back. `proposed` created a pending proposal; `already_proposed` found one
 *  (a redelivery, or the same diagnosis already pending for the patient) — both name the proposal the chart
 *  now holds. `skipped` holds nothing, with the reason. */
export type DocLensDiagnosisOutcome =
  | {
      readonly itemKey: string;
      readonly outcome: "proposed" | "already_proposed";
      readonly proposalId: string;
      /** An ACTIVE problem on the patient's plan with the same code — flagged, never merged. */
      readonly duplicateOfProblemId: string | null;
    }
  | { readonly itemKey: string; readonly outcome: "skipped"; readonly reason: string };

/** `m7.problem.draft_created_from_extraction` payload — M7's reply to a diagnosis commit. */
export interface ProblemDraftCreatedFromExtractionPayload {
  readonly patientId: string;
  readonly organizationId: string;
  readonly extractionCommitId: string;
  readonly carePlanId: string | null;
  readonly itemOutcomes: readonly DocLensDiagnosisOutcome[];
  readonly appliedAt: string;
}
