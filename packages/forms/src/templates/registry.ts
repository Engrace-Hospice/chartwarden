// @wardenx/forms — §4.5 the 31 v1 platform-floor Form Template Library as pure data.
//
// One row per §4.5 template-library entry. `lab_results_pdf` declares `clinical_record` as its default
// retention class; the D23 SUD auto-tag promotes an individual render to `compliance_42cfr_part2` at the
// render layer (not here). The `bereavement_letter` is a single key with a `letterKind` payload
// discriminator selecting one of seven sub-layouts (§4.5 / M16 D14). The actual react-pdf / Puppeteer
// components + payload schemas land per-template in later M22 tasks; T01 ships the registry only.

import type { FormTemplateDescriptor } from "./interface";

/** §4.5 — the platform-floor template registry (the 31 v1 keys; `bereavement_letter` fans out to seven
 * sub-layouts via the payload `letterKind` discriminator). */
export const FORM_TEMPLATE_REGISTRY: readonly FormTemplateDescriptor[] = [
  { key: "election_statement", aggregateType: "election_statement", engine: "react_pdf", retentionClass: "compliance", patientFacing: true },
  { key: "revocation", aggregateType: "revocation", engine: "react_pdf", retentionClass: "compliance", patientFacing: true },
  { key: "cti", aggregateType: "cti", engine: "react_pdf", retentionClass: "compliance", patientFacing: false },
  { key: "f2f", aggregateType: "f2f", engine: "react_pdf", retentionClass: "compliance", patientFacing: false },
  { key: "nor", aggregateType: "nor", engine: "react_pdf", retentionClass: "compliance", patientFacing: true },
  { key: "discharge_summary", aggregateType: "discharge_summary", engine: "react_pdf", retentionClass: "compliance", patientFacing: true },
  { key: "discharge_summary_v2_external_source", aggregateType: "discharge_summary", engine: "react_pdf", retentionClass: "compliance", patientFacing: true },
  { key: "discharge_summary_v2_external_source_cosigned", aggregateType: "discharge_summary", engine: "react_pdf", retentionClass: "compliance", patientFacing: true },
  { key: "nomnc", aggregateType: "nomnc", engine: "react_pdf", retentionClass: "compliance", patientFacing: true },
  { key: "abn", aggregateType: "abn", engine: "react_pdf", retentionClass: "compliance", patientFacing: true },
  { key: "hipaa_privacy_notice", aggregateType: "hipaa_privacy_notice", engine: "react_pdf", retentionClass: "compliance", patientFacing: true },
  { key: "code_status_directive", aggregateType: "code_status_directive", engine: "react_pdf", retentionClass: "compliance", patientFacing: true },
  { key: "encounter_pdf", aggregateType: "encounter", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false },
  { key: "order_record", aggregateType: "order_record", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false },
  { key: "lab_results_pdf", aggregateType: "order_record", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false },
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
  { key: "bereavement_letter", aggregateType: "bereavement_letter", engine: "react_pdf", retentionClass: "bereavement", patientFacing: true },
  { key: "visit_confirmation_letter", aggregateType: "visit_confirmation", engine: "react_pdf", retentionClass: "operational", patientFacing: true },
  { key: "evv_verification", aggregateType: "evv_verification", engine: "puppeteer", retentionClass: "compliance", patientFacing: false },
  { key: "patient_amendment_statement_of_disagreement", aggregateType: "patient_amendment_statement_of_disagreement", engine: "react_pdf", retentionClass: "compliance", patientFacing: true },
  { key: "consent_record", aggregateType: "consent_record", engine: "react_pdf", retentionClass: "compliance", patientFacing: true },
] as const;

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
