// Starter terminology for a fresh local/demo stack (`db:seed:terminology`). A SUBSET, not a release:
// enough for the ICD-10-CM and LOINC pickers to find what the demo charts and orders already carry.
// The full ICD-10-CM release is `bun run db:load:icd10cm`, which replaces the ICD rows below in place.
//
// ICD-10-CM: CDC/NCHS, public domain. Every code here is a billable leaf with the identical display in
// the FY2026 and FY2027 releases (checked against both order files), so one list serves both versions.
//
// LOINC: this file contains LOINC content.
//   This material contains content from LOINC (http://loinc.org). LOINC is copyright (c) 1995-2026,
//   Regenstrief Institute, Inc. and the Logical Observation Identifiers Names and Codes (LOINC) Committee
//   and is available at no cost under the license at http://loinc.org/license. LOINC(r) is a registered
//   United States trademark of Regenstrief Institute, Inc.
// TODO(licence-owner): confirm a small LOINC subset may ship in this private repo / SaaS image before
// this merges. No agent attests to a licence; remove the LOINC block if the owner says no.
//
// SNOMED CT is deliberately absent (affiliate licence; the golden path does not need it).
import { PLATFORM_CODE_SYSTEMS } from "@wardenx/terminology";

function licenseOf(id: "icd10cm" | "loinc"): string {
  const row = PLATFORM_CODE_SYSTEMS.find((s) => s.id === id);
  if (!row) throw new Error(`code system ${id} missing from PLATFORM_CODE_SYSTEMS`);
  return row.licenseSource;
}

export const ICD10CM_STARTER_LICENSE = licenseOf("icd10cm");
export const LOINC_STARTER_LICENSE = licenseOf("loinc");

export interface StarterIcd10cm {
  /** Dotted, as the chart stores it. */
  readonly code: string;
  readonly display: string;
  /** Tabular List chapter number. */
  readonly chapter: string;
}

export const ICD10CM_STARTER_CODES: readonly StarterIcd10cm[] = [
  {
    code: "C34.90",
    display: "Malignant neoplasm of unspecified part of unspecified bronchus or lung",
    chapter: "2",
  },
  { code: "C25.9", display: "Malignant neoplasm of pancreas, unspecified", chapter: "2" },
  { code: "C80.1", display: "Malignant (primary) neoplasm, unspecified", chapter: "2" },
  {
    code: "C50.919",
    display: "Malignant neoplasm of unspecified site of unspecified female breast",
    chapter: "2",
  },
  { code: "C61", display: "Malignant neoplasm of prostate", chapter: "2" },
  { code: "E11.9", display: "Type 2 diabetes mellitus without complications", chapter: "4" },
  {
    code: "F03.90",
    display:
      "Unspecified dementia, unspecified severity, without behavioral disturbance, psychotic disturbance, mood disturbance, and anxiety",
    chapter: "5",
  },
  { code: "G30.9", display: "Alzheimer's disease, unspecified", chapter: "6" },
  { code: "I50.9", display: "Heart failure, unspecified", chapter: "9" },
  {
    code: "I25.10",
    display: "Atherosclerotic heart disease of native coronary artery without angina pectoris",
    chapter: "9",
  },
  { code: "J44.9", display: "Chronic obstructive pulmonary disease, unspecified", chapter: "10" },
  { code: "J96.11", display: "Chronic respiratory failure with hypoxia", chapter: "10" },
  { code: "N18.6", display: "End stage renal disease", chapter: "14" },
  { code: "R06.00", display: "Dyspnea, unspecified", chapter: "18" },
  { code: "R64", display: "Cachexia", chapter: "18" },
  { code: "Z51.5", display: "Encounter for palliative care", chapter: "21" },
];

export interface StarterLoinc {
  readonly code: string;
  readonly display: string;
}

// Panels first (the orders demo uses 24323-8 and 24320-4), then common hospice-lab analytes.
export const LOINC_STARTER_CODES: readonly StarterLoinc[] = [
  { code: "24323-8", display: "Comprehensive metabolic panel" },
  { code: "24320-4", display: "Basic metabolic panel" },
  { code: "24331-1", display: "Lipid panel" },
  { code: "24325-3", display: "Hepatic function panel" },
  { code: "58410-2", display: "CBC panel - Blood by Automated count" },
  { code: "718-7", display: "Hemoglobin [Mass/volume] in Blood" },
  { code: "6690-2", display: "Leukocytes [#/volume] in Blood by Automated count" },
  { code: "777-3", display: "Platelets [#/volume] in Blood by Automated count" },
  { code: "2345-7", display: "Glucose [Mass/volume] in Serum or Plasma" },
  { code: "2160-0", display: "Creatinine [Mass/volume] in Serum or Plasma" },
  { code: "3094-0", display: "Urea nitrogen [Mass/volume] in Serum or Plasma" },
  { code: "2951-2", display: "Sodium [Moles/volume] in Serum or Plasma" },
  { code: "2823-3", display: "Potassium [Moles/volume] in Serum or Plasma" },
  { code: "17861-6", display: "Calcium [Mass/volume] in Serum or Plasma" },
  {
    code: "1742-6",
    display: "Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma",
  },
  {
    code: "1920-8",
    display: "Aspartate aminotransferase [Enzymatic activity/volume] in Serum or Plasma",
  },
  { code: "1751-7", display: "Albumin [Mass/volume] in Serum or Plasma" },
  { code: "4548-4", display: "Hemoglobin A1c/Hemoglobin.total in Blood" },
  { code: "3016-3", display: "Thyrotropin [Units/volume] in Serum or Plasma" },
  { code: "6301-6", display: "INR in Platelet poor plasma by Coagulation assay" },
];

/** LOINC mod-10: double the digits in odd positions from the right, sum all digits, check = (10 - sum % 10) % 10. */
export function loincCheckDigitOk(code: string): boolean {
  const m = /^(\d{1,7})-(\d)$/.exec(code);
  if (!m) return false;
  const digits = [...(m[1] as string)].reverse().map(Number);
  const sum = digits.reduce((acc, d, i) => {
    if (i % 2 === 1) return acc + d; // even position from the right (1-based) is summed as is
    const doubled = d * 2;
    return acc + Math.floor(doubled / 10) + (doubled % 10);
  }, 0);
  return (10 - (sum % 10)) % 10 === Number(m[2]);
}
