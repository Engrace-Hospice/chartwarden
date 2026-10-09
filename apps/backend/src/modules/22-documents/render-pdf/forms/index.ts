// apps/backend/src/modules/22-documents/render-pdf/forms/index.ts - the compiled FormSpec forms (GAP-033).
import { abnForm } from "./abn-form";
import { ctiForm } from "./cti-form";
import { dischargeForm, transferForm } from "./discharge-form";
import { f2fForm } from "./f2f-form";
import { norForm } from "./nor-form";
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
} as const;

/** The keys whose PDF title is the form's constant, PHI-free title (never payload-derived). */
export const FORM_TEMPLATE_KEYS: ReadonlySet<string> = new Set(Object.keys(COMPILED_FORMS));
