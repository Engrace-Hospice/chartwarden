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

/** Wave 2-4 of GAP-033 are scheduled follow-ups; each key below is readable (the generic builder draws every
 *  payload field as a structured, openable PDF) but is NOT a regulation-faithful bespoke layout yet. */
const CLINICAL_WAVE2 =
  "GAP-033 wave 2 (clinical record / CoP document): readable via the generic structured builder; bespoke FormSpec layout scheduled.";
const BILLING_WAVE3 =
  "GAP-033 wave 3 (billing / cost-report correspondence): readable via the generic structured builder; bespoke layout scheduled.";
const OPERATIONAL_WAVE4 =
  "GAP-033 wave 4 (patient-facing / operational): readable via the generic structured builder; bespoke layout scheduled.";
const TABULAR_BY_DESIGN =
  "Arbitrary column sets owned by M33: a dedicated tabular-report builder (not a form) is the target; the generic builder is the correct path until then.";

/**
 * Renderer keys WITHOUT a bespoke builder in DEFAULT_PDF_RENDERERS -> why. A key may not be in both this list and
 * the registry (the ratchet), and a renderer key in neither fails the gate.
 */
export const GENERIC_ALLOWLIST: Readonly<Record<string, string>> = {
  encounter: CLINICAL_WAVE2,
  order_record: CLINICAL_WAVE2,
  medication_order: CLINICAL_WAVE2,
  medication_administration_record: CLINICAL_WAVE2,
  medication_reconciliation_worksheet: CLINICAL_WAVE2,
  patient_medication_list: CLINICAL_WAVE2,
  care_plan: CLINICAL_WAVE2,
  aide_poc: CLINICAL_WAVE2,
  msw_plan: CLINICAL_WAVE2,
  spiritual_plan: CLINICAL_WAVE2,
  volunteer_plan: CLINICAL_WAVE2,
  lab_results_pdf: CLINICAL_WAVE2,
  consent_record: CLINICAL_WAVE2,
  patient_amendment_statement_of_disagreement: CLINICAL_WAVE2,
  hope_summary: CLINICAL_WAVE2,
  assessment_summary: CLINICAL_WAVE2,
  safety_incident_report: CLINICAL_WAVE2,
  noe_confirmation_receipt: BILLING_WAVE3,
  notr_confirmation_receipt: BILLING_WAVE3,
  claim_acknowledgment_letter: BILLING_WAVE3,
  medicaid_claim_acknowledgment_letter: BILLING_WAVE3,
  denial_appeal_cover_letter: BILLING_WAVE3,
  denial_resolution_letter: BILLING_WAVE3,
  cost_report_ecr: BILLING_WAVE3,
  cost_report_pi: BILLING_WAVE3,
  cost_report_supporting_doc: BILLING_WAVE3,
  body_release_authorization: BILLING_WAVE3,
  comfort_kit_return_receipt: BILLING_WAVE3,
  supply_bill_of_lading: BILLING_WAVE3,
  bereavement_letter: OPERATIONAL_WAVE4,
  bereavement_welcome_packet: OPERATIONAL_WAVE4,
  visit_confirmation: OPERATIONAL_WAVE4,
  evv_verification: OPERATIONAL_WAVE4,
  dsar_bundle: OPERATIONAL_WAVE4,
  tenant_export_cover_letter: OPERATIONAL_WAVE4,
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
