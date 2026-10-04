// apps/web/src/modules/22-documents — the PURE half of the DocLens review screens (F-237): labels,
// confidence bands, bounding-box geometry, and the three eligibility rules the workspace shows before the
// server enforces them (bulk-approve, chart write-back, vision-disagreement reason). No React, no IO, so
// each rule is unit-testable on its own and the screen cannot drift from a second copy of it.
//
// The rules MIRROR the server; they never replace it. Bulk-approve scope is enforced by the
// `extraction_high_risk_field_per_field_only` ABAC (422), the vision reason by
// `VISION_DISAGREEMENT_REASON_REQUIRED`, and what reaches the chart by the write-back planner
// (`writeback-plan.ts`) — which is why the completion result shows the SERVER's committed/excluded
// lists, not this file's prediction.
import type { Bbox, Candidate, SudStatus, WorkspacePage } from "./doclens-api";

// ── labels ─────────────────────────────────────────────────────────────────────────────────────────────

/** Field-path leaf → reviewer copy. Covers the v1 registry (`@wardenx/intake-extraction` schemas). */
const FIELD_LABEL: Record<string, string> = {
  "patient.legalFirstName": "Legal first name",
  "patient.legalLastName": "Legal last name",
  "patient.dateOfBirth": "Date of birth",
  "patient.preferredName": "Preferred name",
  "patient.phoneHome": "Home phone",
  "patient.phoneMobile": "Mobile phone",
  "patient.email": "Email",
  "patient.address.line1": "Street address",
  "patient.address.line2": "Apt / unit",
  "patient.address.city": "City",
  "patient.address.state": "State",
  "patient.address.postalCode": "ZIP code",
};
const SINGULAR: Record<string, string> = {
  medications: "Medication",
  allergies: "Allergy",
  diagnoses: "Diagnosis",
  problems: "Problem",
};

const words = (camel: string): string =>
  camel
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
const capital = (s: string): string => (s ? s[0]?.toUpperCase() + s.slice(1) : s);

/**
 * `patient.phoneHome` → "Home phone"; `medications[0].name` → "Medication 1 · name". A path the map
 * does not know falls back to its leaf in words, so an unmapped field is still readable, never blank.
 */
export function fieldLabel(fieldPath: string): string {
  const known = FIELD_LABEL[fieldPath];
  if (known) return known;
  const indexed = /^([a-zA-Z]+)\[(\d+)\](?:\.(.+))?$/.exec(fieldPath);
  if (indexed) {
    const [, list = "", index = "0", rest] = indexed;
    const noun = SINGULAR[list] ?? capital(words(list).replace(/s$/, ""));
    const head = `${noun} ${Number(index) + 1}`;
    return rest ? `${head} · ${words(rest.split(".").pop() ?? rest)}` : head;
  }
  const leaf = fieldPath.split(".").pop() ?? fieldPath;
  return capital(words(leaf));
}

/** The section a field is grouped under in the list (within its document type). */
export function fieldSection(fieldPath: string): string {
  if (fieldPath.startsWith("patient.address.")) return "Address";
  if (fieldPath.startsWith("patient.")) return "Patient";
  const list = /^([a-zA-Z]+)\[/.exec(fieldPath)?.[1];
  return list ? capital(words(list)) : "Other";
}

const DOC_TYPE_LABEL: Record<string, string> = {
  discharge_summary: "Discharge summary",
  med_recon: "Medication reconciliation",
  hp: "History & physical",
  lab: "Lab report",
  imaging: "Imaging report",
  consult: "Consult note",
  insurance_card: "Insurance card",
  photo_id: "Photo ID",
  advance_directive: "Advance directive",
  dpoa: "Durable power of attorney",
  transfer_record: "Transfer record",
  other: "Other",
  unknown: "Unclassified",
};
export const docTypeLabel = (v: string | null | undefined): string =>
  v ? (DOC_TYPE_LABEL[v] ?? capital(words(v))) : "Unclassified";

const BATCH_STATUS_LABEL: Record<string, string> = {
  uploaded: "Uploaded",
  docling_complete: "Reading pages",
  classifier_complete: "Classified",
  extraction_complete: "Ready for review",
  in_review: "In review",
  writeback_complete: "Complete",
  discarded: "Discarded",
  split_into_children: "Split",
  split_resolved_no_split: "Not split",
  parse_failed: "Could not read",
};
export const batchStatusLabel = (v: string): string => BATCH_STATUS_LABEL[v] ?? capital(words(v));

const SOURCE_LABEL: Record<string, string> = {
  fax: "Fax",
  email: "Email",
  scanned_physical: "Scanned copy",
  manual_upload: "Manual upload",
  portal: "Portal",
  api: "API",
};
export const sourceLabel = (v: string): string => SOURCE_LABEL[v] ?? capital(words(v));

/** The completion's exclusion reasons (`WritebackExclusionReason`) as reviewer copy. */
const EXCLUSION_LABEL: Record<string, string> = {
  not_a_writeback_target: "Not a chart field",
  risk_not_low: "Evidence only (risk)",
  sud_detected: "SUD-flagged page",
  patient_unresolved: "No patient matched to this batch",
  edited_value_missing: "Edited value missing",
  value_missing: "No value extracted",
  conflicting_values: "Conflicting values for the same field",
  // F-238 — the medication-history / allergy planner's reasons.
  risk_not_high: "Evidence only (risk tier)",
  sud_treatment_medication: "Substance-use treatment medication (42 CFR Part 2)",
  value_too_long: "Too long to record",
  duplicate_in_batch: "Listed twice in this packet",
};
/**
 * `not_a_writeback_target` covers two different things, and "Not a chart field" was wrong for both: the
 * patient's legal name and date of birth ARE chart fields, which intake never overwrites (they identify
 * the patient; a change is an identity correction), and diagnoses have no intake writeback yet (they are
 * reconciled by a clinician). Medication and allergy LINES do write back since F-238 — see
 * `clinicalTargetOf` — so the demographics planner's `not_a_writeback_target` for them is not shown.
 */
function notWrittenLabel(fieldPath: string): string {
  if (
    /^patient\.(legal(First|Middle|Last)Name|dob|dateOfBirth|sexAssignedAtBirth|ssn|mrn)\b/.test(
      fieldPath,
    )
  )
    return "Identity field — intake never changes it; correct it on the patient record if needed";
  if (/^(medications|allergies|diagnos)/.test(fieldPath))
    return "Kept as evidence — reconcile it in the chart; intake does not write it";
  return "Kept as evidence — intake does not write this field";
}

export const exclusionLabel = (v: string, fieldPath = ""): string =>
  v === "not_a_writeback_target"
    ? notWrittenLabel(fieldPath)
    : (EXCLUSION_LABEL[v] ?? capital(words(v)));

/** Statuses that still have pipeline work ahead of them (the queue's "Processing" KPI). */
export const PROCESSING_STATUSES = new Set(["uploaded", "docling_complete", "classifier_complete"]);
/** Statuses a reviewer can act on (the queue's "Ready for review" KPI). */
export const REVIEWABLE_STATUSES = new Set(["extraction_complete", "in_review"]);

// ── confidence + risk ──────────────────────────────────────────────────────────────────────────────────

export type Band = "high" | "medium" | "low";
export const confidenceBand = (c: number): Band =>
  c >= 0.9 ? "high" : c >= 0.75 ? "medium" : "low";
export const pct = (c: number): string => `${Math.round(c * 100)}%`;

/** Page classification below the §5 0.75 floor (or flagged by the classifier) needs a human label. */
export const needsManualLabel = (p: WorkspacePage): boolean =>
  p.needsHumanClassification || p.confidence === null || p.confidence < 0.75;

// ── geometry ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * A bbox in the page's own units (top-left origin, `[left, top, right, bottom]`) → CSS percentages of
 * the rendered page. Percentages, not pixels, so the overlay stays registered to the image at any
 * zoom/width; clamped so a box that spills past the page edge cannot escape the viewer.
 */
export function bboxPercent(
  bbox: Bbox,
  page: Pick<WorkspacePage, "width" | "height">,
): { left: string; top: string; width: string; height: string } {
  const [l, t, r, b] = bbox;
  const clamp = (v: number): number => Math.min(100, Math.max(0, v));
  const w = page.width > 0 ? page.width : 1;
  const h = page.height > 0 ? page.height : 1;
  const left = clamp((Math.min(l, r) / w) * 100);
  const top = clamp((Math.min(t, b) / h) * 100);
  const fmt = (v: number): string => `${Number(v.toFixed(3))}%`;
  return {
    left: fmt(left),
    top: fmt(top),
    width: fmt(Math.min(100 - left, (Math.abs(r - l) / w) * 100)),
    height: fmt(Math.min(100 - top, (Math.abs(b - t) / h) * 100)),
  };
}

// ── eligibility ────────────────────────────────────────────────────────────────────────────────────────

export const isApproved = (c: Candidate): boolean =>
  c.decision?.decision === "approve" || c.decision?.decision === "approve_with_edit";

/** A decided `approve` with the vision check disagreeing must carry a reason of at least 5 characters. */
export const MIN_REASON = 5;

/**
 * The fields the completion is EXPECTED to send to the chart: an approved write-back target that is not
 * on a SUD-flagged page (unless the flag was rejected as a false positive). A preview only — the dialog
 * says so, and the result shows what the server actually committed.
 */
export const updatesChart = (c: Candidate, sud: SudStatus): boolean =>
  c.writebackTarget && isApproved(c) && !(c.sudDetected && sud !== "rejected");

/**
 * F-238 — where an approved medication / allergy LINE goes: M12's medication history as an outside
 * medication for a clinician to reconcile (never an order), or M5's allergy list as UNVERIFIED. Mirrors the
 * server's `clinicalWritebackTargetOf` (the registry's `medications[].name` / `allergies[].substance`).
 */
export type ClinicalTarget = "medication_history" | "allergy";
export const clinicalTargetOf = (fieldPath: string): ClinicalTarget | null =>
  /^medications\[\d+\]\.name$/.test(fieldPath)
    ? "medication_history"
    : /^allergies\[\d+\]\.substance$/.test(fieldPath)
      ? "allergy"
      : null;

/** The approved medication / allergy lines completion is EXPECTED to send (a preview — the server also
 *  keeps substance-use treatment medications out while SUD is unresolved, and dedupes). */
export const updatesChartClinical = (c: Candidate, sud: SudStatus): boolean =>
  clinicalTargetOf(c.fieldPath) !== null &&
  c.riskLevel === "high" &&
  isApproved(c) &&
  !(c.sudDetected && sud !== "rejected");

/**
 * Bulk-approve scope: low risk, not SUD-tagged, not vision-disagreed, undecided, and source-confirmed
 * by THIS reviewer in this session. High-risk fields are never in scope (spec: per-field only).
 */
export const bulkEligible = (c: Candidate, confirmed: ReadonlySet<string>): boolean =>
  c.riskLevel === "low" &&
  !c.sudDetected &&
  c.vision.status !== "disagreed" &&
  c.decision === null &&
  confirmed.has(c.id);

/** Decision → state chip copy. */
export const decisionLabel = (d: string): string =>
  d === "approve"
    ? "Approved"
    : d === "approve_with_edit"
      ? "Edited"
      : d === "reject"
        ? "Rejected"
        : capital(words(d));

// ── F-238: coding checks on page-scanned ICD-10-CM codes ─────────────────────────────────────────────
/** `critical` = the code cannot stand as written; `warning` = the reviewer should look; `info` = context. */
export type CodingSeverity = "critical" | "warning" | "info";
const CODING_FLAG: Record<string, { label: string; severity: CodingSeverity }> = {
  code_not_valid_on_date: {
    label: "Not a valid code on the document's date",
    severity: "critical",
  },
  code_retired_since_written: {
    label: "Code retired since — needs a current code",
    severity: "critical",
  },
  unknown_code: { label: "Not an ICD-10-CM code", severity: "critical" },
  unacceptable_hospice_principal: {
    label: "Not acceptable as hospice principal",
    severity: "critical",
  },
  manifestation_code: { label: "Manifestation code — cannot be principal", severity: "critical" },
  symptom_code_as_principal: { label: "Symptom code as principal", severity: "warning" },
  combination_code_expected: { label: "Combination code expected", severity: "warning" },
  more_specific_code_supported: {
    label: "Documentation supports a more specific code",
    severity: "warning",
  },
  conflicting_codes: { label: "Coded differently elsewhere in the packet", severity: "warning" },
  resolved_condition: { label: "Documented as resolved", severity: "warning" },
  unspecified_code: { label: "Unspecified code", severity: "info" },
  ocr_repaired: { label: "Code read through OCR repair — check the page", severity: "info" },
  unreadable_code: { label: "Code on the page could not be read", severity: "warning" },
  part2_sud: { label: "42 CFR Part 2 — substance use disorder code", severity: "critical" },
};
export const codingFlagInfo = (kind: string): { label: string; severity: CodingSeverity } =>
  CODING_FLAG[kind] ?? { label: capital(words(kind)), severity: "warning" };
const SEVERITY_RANK: Record<CodingSeverity, number> = { critical: 0, warning: 1, info: 2 };
/** Most severe first, so the chip row leads with what blocks the code. */
export const sortedCodingFlags = <F extends { kind: string }>(flags: readonly F[]): F[] =>
  [...flags].sort(
    (a, b) =>
      SEVERITY_RANK[codingFlagInfo(a.kind).severity] -
      SEVERITY_RANK[codingFlagInfo(b.kind).severity],
  );

// ── F-238: does each document belong to this patient? (two identifiers: DOB + name) ───────────────────
export const IDENTITY_LABEL: Record<
  string,
  { label: string; tone: "success" | "warning" | "error" | "neutral" }
> = {
  match: { label: "Same patient", tone: "success" },
  possible: { label: "Check patient", tone: "warning" },
  mismatch: { label: "Different patient?", tone: "error" },
  unverified: { label: "No identifiers", tone: "neutral" },
};
const FIELD_WORD: Record<string, string> = {
  dateOfBirth: "date of birth",
  lastName: "last name",
  firstName: "first name",
};
/** "date of birth and last name differ" — field names only; the values are on the page. */
export const identityDetail = (disagreeing: readonly string[]): string =>
  disagreeing.length === 0
    ? ""
    : `${disagreeing.map((d) => FIELD_WORD[d] ?? d).join(" and ")} ${disagreeing.length === 1 ? "differs" : "differ"}`;
export const identityNeedsAnswer = (d: {
  identity: { status: string | null; resolution: string | null };
  duplicateOfPage: number | null;
}): boolean =>
  d.duplicateOfPage === null &&
  d.identity.resolution === null &&
  (d.identity.status === "possible" || d.identity.status === "mismatch");

/** F-238 — a records-request code on the fax names another referral / patient than the batch's. */
export type RecordsRequestConflictKind =
  | "code_names_another_referral"
  | "code_names_another_patient";
export const RECORDS_REQUEST_CONFLICT_LABEL: Readonly<Record<RecordsRequestConflictKind, string>> =
  {
    code_names_another_referral: "Request code is for another referral",
    code_names_another_patient: "Request code is for another patient",
  };
