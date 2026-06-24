// @wardenx/forms — §4.5 the 31 v1 platform-floor Form Template Library as pure data.
//
// One row per §4.5 template-library entry. `lab_results_pdf` declares `clinical_record` as its default
// retention class; the D23 SUD auto-tag promotes an individual render to `compliance_42cfr_part2` at the
// render layer (not here). The `bereavement_letter` is a single key with a `letterKind` payload
// discriminator selecting one of seven sub-layouts (§4.5 / M16 D14). The actual react-pdf / Puppeteer
// components + payload schemas land per-template in later M22 tasks.
//
// Each descriptor also carries the §4.5 / D16 golden-template-diff inputs: `version` (the D14 platform
// semver, v1-locked at `1.0.0`), `requiredFields` (platform-floor layout fields an overlay may neither
// drop nor weaken), `tightenableFields` (value spaces an overlay may NARROW but never WIDEN), and
// `requiredWatermarks` (platform watermarks an overlay must preserve — e.g. `CRITICAL RESULT`, D22). The
// `resolveTemplate` / overlay validator in ./library.ts enforce these (the platform floor always wins).

import type { FormTemplateDescriptor } from "./interface";

/** The §4.5 v1 lock ships every platform template at this semver (later platform versions bump per-key). */
export const V1_TEMPLATE_VERSION = "1.0.0";

/** The §2.3 / D16 layout fields EVERY platform template guarantees and an overlay can never drop. The
 * regulatory templates extend this with their statute-mandated text below. */
const BASE_REQUIRED_FIELDS = ["organization_letterhead", "document_title", "generated_at"] as const;

/** The minimal row authored per template; `toDescriptor` fills the D14/D16 defaults so the 31 rows stay
 * readable. `requiredFields` here are the template-SPECIFIC regulatory floors ADDED to {@link BASE_REQUIRED_FIELDS}. */
interface TemplateSeed
  extends Omit<FormTemplateDescriptor, "version" | "requiredFields" | "tightenableFields" | "requiredWatermarks"> {
  readonly extraRequiredFields?: readonly string[];
  readonly tightenableFields?: readonly string[];
  readonly requiredWatermarks?: readonly string[];
}

function toDescriptor(seed: TemplateSeed): FormTemplateDescriptor {
  return {
    key: seed.key,
    aggregateType: seed.aggregateType,
    engine: seed.engine,
    retentionClass: seed.retentionClass,
    patientFacing: seed.patientFacing,
    version: V1_TEMPLATE_VERSION,
    requiredFields: [...BASE_REQUIRED_FIELDS, ...(seed.extraRequiredFields ?? [])],
    tightenableFields: seed.tightenableFields ?? [],
    requiredWatermarks: seed.requiredWatermarks ?? [],
  };
}

/** §4.5 — the platform-floor template registry (the 31 v1 keys; `bereavement_letter` fans out to seven
 * sub-layouts via the payload `letterKind` discriminator). */
const TEMPLATE_SEEDS: readonly TemplateSeed[] = [
  { key: "election_statement", aggregateType: "election_statement", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, extraRequiredFields: ["election_effective_date", "beneficiary_signature_block", "attending_physician_block"] },
  { key: "revocation", aggregateType: "revocation", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, extraRequiredFields: ["revocation_effective_date", "beneficiary_signature_block"] },
  { key: "cti", aggregateType: "cti", engine: "react_pdf", retentionClass: "compliance", patientFacing: false, extraRequiredFields: ["physician_signature_block", "terminal_prognosis_statement"] },
  { key: "f2f", aggregateType: "f2f", engine: "react_pdf", retentionClass: "compliance", patientFacing: false, extraRequiredFields: ["physician_signature_block", "encounter_date"] },
  { key: "nor", aggregateType: "nor", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, extraRequiredFields: ["beneficiary_rights_text"] },
  { key: "discharge_summary", aggregateType: "discharge_summary", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, extraRequiredFields: ["discharge_date", "discharge_reason"] },
  { key: "discharge_summary_v2_external_source", aggregateType: "discharge_summary", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, extraRequiredFields: ["discharge_date", "discharge_reason", "source_facility_name", "source_proposal_id"], requiredWatermarks: ["DISCHARGE RECORDED FROM EXTERNAL NOTIFICATION — PENDING MEDICAL DIRECTOR REVIEW"] },
  { key: "discharge_summary_v2_external_source_cosigned", aggregateType: "discharge_summary", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, extraRequiredFields: ["discharge_date", "discharge_reason", "source_facility_name", "source_proposal_id", "medical_director_signature_block"] },
  { key: "nomnc", aggregateType: "nomnc", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, extraRequiredFields: ["nomnc_required_text", "appeal_rights_text"] },
  { key: "abn", aggregateType: "abn", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, extraRequiredFields: ["abn_required_text", "cost_estimate_block", "beneficiary_option_block"] },
  { key: "hipaa_privacy_notice", aggregateType: "hipaa_privacy_notice", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, extraRequiredFields: ["npp_required_wording", "patient_rights_block"] },
  { key: "code_status_directive", aggregateType: "code_status_directive", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, extraRequiredFields: ["code_status_field", "physician_signature_block"], tightenableFields: ["code_status_field"] },
  { key: "encounter_pdf", aggregateType: "encounter", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false },
  { key: "order_record", aggregateType: "order_record", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false },
  { key: "lab_results_pdf", aggregateType: "order_record", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false, extraRequiredFields: ["result_values_block"] },
  { key: "medication_order", aggregateType: "medication_order", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false },
  { key: "patient_medication_list", aggregateType: "patient_medication_list", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: true },
  { key: "medication_reconciliation_worksheet", aggregateType: "medication_reconciliation_worksheet", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false },
  { key: "emar_snapshot", aggregateType: "medication_administration_record", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false },
  { key: "comfort_kit_receipt", aggregateType: "comfort_kit_receipt", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: true },
  { key: "idg_patient_packet", aggregateType: "idg_patient_packet", engine: "puppeteer", retentionClass: "clinical_record", patientFacing: false },
  { key: "idg_minutes", aggregateType: "idg_minutes", engine: "puppeteer", retentionClass: "clinical_record", patientFacing: false },
  { key: "aide_poc", aggregateType: "aide_poc", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false },
  { key: "msw_plan", aggregateType: "msw_plan", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false },
  { key: "spiritual_plan", aggregateType: "spiritual_plan", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false },
  { key: "volunteer_plan", aggregateType: "volunteer_plan", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false },
  { key: "bereavement_letter", aggregateType: "bereavement_letter", engine: "react_pdf", retentionClass: "bereavement", patientFacing: true, extraRequiredFields: ["letter_body", "letter_kind"] },
  { key: "visit_confirmation_letter", aggregateType: "visit_confirmation", engine: "react_pdf", retentionClass: "operational", patientFacing: true },
  { key: "evv_verification", aggregateType: "evv_verification", engine: "puppeteer", retentionClass: "compliance", patientFacing: false },
  { key: "patient_amendment_statement_of_disagreement", aggregateType: "patient_amendment_statement_of_disagreement", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, extraRequiredFields: ["statement_of_disagreement_text"] },
  { key: "consent_record", aggregateType: "consent_record", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, extraRequiredFields: ["consent_scope_block", "signature_block"] },
];

/** §4.5 — the platform-floor template registry (the 31 v1 keys, D14/D16 defaults filled by {@link toDescriptor}). */
export const FORM_TEMPLATE_REGISTRY: readonly FormTemplateDescriptor[] = TEMPLATE_SEEDS.map(toDescriptor);

/** §4.5 — the seven `bereavement_letter` sub-layouts selected by the payload `letterKind` discriminator. */
export const BEREAVEMENT_LETTER_KINDS = [
  "condolence",
  "welcome_packet",
  "anniversary",
  "scheduled_contact",
  "complicated_grief_referral",
  "opt_out_confirmation",
  "closeout",
] as const;

/** One of the seven §4.5 bereavement-letter sub-layouts. */
export type BereavementLetterKind = (typeof BEREAVEMENT_LETTER_KINDS)[number];

/** Resolve a template descriptor by its platform key (`undefined` when unknown). */
export function findFormTemplate(key: string): FormTemplateDescriptor | undefined {
  return FORM_TEMPLATE_REGISTRY.find((t) => t.key === key);
}
