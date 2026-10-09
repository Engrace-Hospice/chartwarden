// apps/backend/src/modules/22-documents/render-pdf/forms/index.ts - the compiled FormSpec forms (GAP-033).
import { abnForm } from "./abn-form";
import {
  claimAcknowledgmentForm,
  denialAppealCoverForm,
  denialResolutionForm,
  medicaidClaimAcknowledgmentForm,
  noeReceiptForm,
  notrReceiptForm,
} from "./billing-forms";
import { ctiForm } from "./cti-form";
import { dischargeForm, transferForm } from "./discharge-form";
import { f2fForm } from "./f2f-form";
import { medicationOrderForm } from "./medication-order-form";
import { norForm } from "./nor-form";
import {
  dsarBundleForm,
  evvVerificationForm,
  tenantExportCoverForm,
  visitConfirmationForm,
} from "./operational-forms";
import { orderRecordForm } from "./order-record-form";
import { revocationForm } from "./revocation-form";

export { defineForm } from "./compile";
export type { CompiledForm } from "./compile";
export { providedFieldIds, COMPILER_PROVIDED_FIELDS } from "./spec";
export { ABN_PRESCRIBED_TEXT } from "./abn-form";

/** Every compiled form by M22 template key. Registered in ../registry.ts. */
export const COMPILED_FORMS = {
  cti: ctiForm,
  f2f: f2fForm,
  nor: norForm,
  revocation: revocationForm,
  discharge_summary: dischargeForm,
  discharge_summary_transfer: transferForm,
  abn: abnForm,
  // GAP-033 Wave 2 - the signed order documents (typed payloads built by M11 / M12 in the signing transaction).
  order_record: orderRecordForm,
  medication_order: medicationOrderForm,
  // GAP-033 Wave 3 - billing correspondence (the producers already ship the content; M22 validates it).
  noe_confirmation_receipt: noeReceiptForm,
  notr_confirmation_receipt: notrReceiptForm,
  claim_acknowledgment_letter: claimAcknowledgmentForm,
  medicaid_claim_acknowledgment_letter: medicaidClaimAcknowledgmentForm,
  denial_appeal_cover_letter: denialAppealCoverForm,
  denial_resolution_letter: denialResolutionForm,
  // GAP-033 Wave 4 - operational documents whose producers (M17, M18, M34) already ship the whole content.
  visit_confirmation: visitConfirmationForm,
  evv_verification: evvVerificationForm,
  dsar_bundle: dsarBundleForm,
  tenant_export_cover_letter: tenantExportCoverForm,
} as const;

/** The keys whose PDF title is the form's constant, PHI-free title (never payload-derived). */
export const FORM_TEMPLATE_KEYS: ReadonlySet<string> = new Set(Object.keys(COMPILED_FORMS));
