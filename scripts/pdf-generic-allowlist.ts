/**
 * GAP-033 - the M22 template registries and the allow-lists `arch:pdf-templates` reads.
 *
 * Two registries exist and had drifted: the forms library (`@wardenx/forms` FORM_TEMPLATE_REGISTRY - the D14/D16
 * descriptors) and the renderer's PLATFORM_TEMPLATE_TABLE (what a render request can actually name). The renderer
 * table is the one a request resolves against; this file is the single, reviewed statement of how the two relate
 * and of which renderer keys still draw through the structured GENERIC builder instead of a bespoke form.
 *
 * Every list is a RATCHET: an entry whose reason has been overtaken (a generic key that gained a builder, an alias
 * whose target vanished, a forms-only key that gained a render path) FAILS the gate until it is deleted, so
 * these lists can only shrink toward "every template has a real layout".
 */

/**
 * GAP-033 - why a key is still on the readable generic builder instead of a bespoke form. Each reason names the
 * SPECIFIC blocker verified against the producer's code (waves 2-3 were investigated key by key); "scheduled" is
 * never a reason on its own. Keys with a bespoke form (the CoP documents, the signed order documents, the billing correspondence
 * and the operational sheets: visit confirmation, EVV verification, DSAR transmittal, tenant-export cover letter)
 * are not listed here.
 */
const ID_ONLY =
  "producer event carries identifiers only: a bespoke layout has nothing to draw until the owning module builds a typed renderPayload in its signing transaction (the M6 / M11 / M12 pattern) and M22 validates it";
const NO_PRODUCER =
  "no module emits a render request for this template yet, so there is no producer payload to lay out";
const BEREAVEMENT_WORDING =
  "the fixed condolence / program wording of each letter is program-authored content that compliance and the bereavement program must supply (as for the ABN): it is not invented in code";
const TABULAR_BY_DESIGN =
  "Arbitrary column sets owned by M33: a dedicated tabular-report builder (not a form) is the target; the generic builder is the correct path until then.";
const DATA_ARTIFACT =
  "M27 renders a data-file artifact (the ECR / PI text is carried as `payloadRef`, not a form): the generic builder draws a reference sheet only; the artifact bytes are not a PDF layout problem. A cover sheet needs the cost-report summary the event does not carry.";

/**
 * Renderer keys WITHOUT a bespoke builder in DEFAULT_PDF_RENDERERS -> why. A key may not be in both this list and
 * the registry (the ratchet), and a renderer key in neither fails the gate.
 */
export const GENERIC_ALLOWLIST: Readonly<Record<string, string>> = {
  encounter:
    "M8 ships `documentRenderPayload.final = ''` by design: the pinned narrative is sealed under the tenant DEK (#122) and must not ride the outbox in the clear. A bespoke layout needs an M22-side hydrator that opens the pin under the render's tenant context (design alternative D2), not a producer snapshot.",
  medication_administration_record: `M13's renderPayload is a per-dose snapshot (drug, dose, time, mode) with no patient identity, administering clinician or outcome; ${ID_ONLY}`,
  medication_reconciliation_worksheet: `M13's renderPayload is {triggerKind, finalizedAt}: ${ID_ONLY}`,
  patient_medication_list:
    "M22 assembles typed content itself (render-variants: M12 getActiveMedications) but it carries `patientId` only; the per-page patient identity a medication list needs requires M22-side PatientReader hydration at render time, which the pure payload -> DocModel pipeline does not have yet.",
  care_plan: `m7.care_plan.version_signed carries {planId, versionId, patientId, admissionId, kind, snapshotRef} - a pointer to the snapshot, not its content: ${ID_ONLY}`,
  aide_poc:
    "M15's `snapshot` content blob is `Type.Unknown()` in the catalog with no typed schema; it needs a TypeBox schema in packages/types and a live producer-blob check before a layout can be trusted.",
  msw_plan:
    "M15's `snapshot` content blob is `Type.Unknown()` in the catalog with no typed schema; it needs a TypeBox schema in packages/types and a live producer-blob check before a layout can be trusted.",
  spiritual_plan:
    "M15's `snapshot` content blob is `Type.Unknown()` in the catalog with no typed schema; it needs a TypeBox schema in packages/types and a live producer-blob check before a layout can be trusted.",
  volunteer_plan:
    "M15's `snapshot` content blob is `Type.Unknown()` in the catalog with no typed schema; it needs a TypeBox schema in packages/types and a live producer-blob check before a layout can be trusted.",
  lab_results_pdf:
    "M22's lab-results variant carries values without reference ranges or abnormal flags, so the CRITICAL RESULT watermark (D22) cannot be derived, and only `patientId` (no per-page identity); it needs M29 reference-range data and M22-side identity hydration.",
  consent_record:
    "M39 renders it through its own bridge (39-consent/render-consumer.ts) from {consentRecordId, typeKey, grantorKind, effectiveAt, expiresAt, recipients, jurisdictionCode}: no signer name, purpose or scope text, and there are twelve consent types whose 45 CFR 164.508(c) / 42 CFR 2.31 authorization wording compliance must supply (as for the ABN) before a faithful layout can be written.",
  patient_amendment_statement_of_disagreement: `${NO_PRODUCER} (render-variants/statement-of-disagreement.ts plans the version append; the live consumer is deferred).`,
  hope_summary: `m10.hope.summary_requested carries {assessmentId, requestedBy, patientId}: ${ID_ONLY}`,
  assessment_summary:
    "m9.assessment.summary_requested carries {patientId, asOfDate, scales[], lang}: the scale NAMES only, not the scores or dates a summary exists to show; the owning module must ship the typed summary (and the per-page identity).",
  safety_incident_report: `m20.safety.incident_report_requested carries {incidentId, patientId, renderTargetKind}: ${ID_ONLY}`,
  cost_report_ecr: DATA_ARTIFACT,
  cost_report_pi: DATA_ARTIFACT,
  cost_report_supporting_doc: DATA_ARTIFACT,
  body_release_authorization: `m37.body_release.document_requested carries {bodyReleaseId, patientId}: ${ID_ONLY}`,
  comfort_kit_return_receipt: `m21.supply_request.document_requested carries {supplyRequestId, dispatchId, documentKind}; the DEA-1304 receipt needs the reconciled lot / quantity manifest from M21's rows: ${ID_ONLY}`,
  supply_bill_of_lading: `m21.supply_request.document_requested carries {supplyRequestId, dispatchId, documentKind}; the bill of lading needs the dispatch manifest from M21's rows: ${ID_ONLY}`,
  bereavement_letter: `m16.bereavement.outreach_artifact_requested ships payloadJsonb {outreachKind, anniversaryMark, deathDate, dueAt} only: no decedent name, no recipient (bereaved_contact.display_name is plaintext but is not on the wire), no counselor or hospice name, so a letter has no addressee; and ${BEREAVEMENT_WORDING} (seven outreach kinds).`,
  bereavement_welcome_packet: `the plan-open request ships payloadJsonb {deathDate} only: no decedent or recipient name, no counselor, no hospice contact details, and ${BEREAVEMENT_WORDING}.`,
  report_export: TABULAR_BY_DESIGN,
  scheduled_report: TABULAR_BY_DESIGN,
};

/**
 * Forms-registry key -> the renderer key the same artifact renders under, where the two registries spell it
 * differently. A forms key that resolves to a renderer key directly needs no entry.
 */
export const FORMS_KEY_ALIASES: Readonly<Record<string, string>> = {
  encounter_pdf: "encounter",
  visit_confirmation_letter: "visit_confirmation",
  comfort_kit_receipt: "comfort_kit_return_receipt",
  // The external-source discharge variants are the same artifact family as the discharge summary; a distinct
  // layout (with the D21 external-source watermark) has not been built, so they render as discharge_summary.
  discharge_summary_v2_external_source: "discharge_summary",
  discharge_summary_v2_external_source_cosigned: "discharge_summary",
};

/**
 * Forms-registry keys with NO render path at all: nothing can request them, so no document is ever produced.
 * Listed so that is a recorded fact rather than a silent gap; the entry must be deleted when a path exists.
 */
export const FORMS_ONLY_KEYS: Readonly<Record<string, string>> = {
  nomnc:
    "CMS-10123 NOMNC: no module emits a render request and CMS prescribes the wording (compliance must supply it, as for the ABN).",
  hipaa_privacy_notice:
    "Notice of Privacy Practices: a static tenant document delivered at admission; no render request exists yet.",
  code_status_directive:
    "Code status / POLST directive: M8 records the order but emits no render request yet.",
  emar_snapshot:
    "eMAR snapshot: M13 renders the medication administration record (medication_administration_record); a separate snapshot template has no producer.",
};
