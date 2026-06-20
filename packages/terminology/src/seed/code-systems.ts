// @wardenx/terminology — the platform `code_system` catalog seed (M38-T08, spec §3.9).
//
// Phase-1 bootstrap seeds one catalog row per code system M38 owns. This is the typed,
// deterministic source of truth a seed runner inserts into `code_system`; the actual concept
// DATA for each system is loaded later by the per-system loaders (§4.3), not here.
//
// CPT is DELIBERATELY ABSENT (§7.8 / D4): `id` is a {@link CodeSystemId}, whose union omits
// `'cpt'`, so a CPT catalog row fails to compile — and `licenseSource` never needs `'ama'`
// (the only license source CPT would carry) until that PR lands.

import type { CodeSystemId } from "../interfaces/kinds";

/** License provenance for a code system (§3.9). `'ama'` is reserved for CPT (D4); unused today. */
export type CodeSystemLicenseSource = "public" | "umls" | "regenstrief" | "ama";

/** One platform `code_system` catalog row (§3.3, §3.9). */
export interface PlatformCodeSystemSeed {
  readonly id: CodeSystemId;
  readonly name: string;
  readonly licenseSource: CodeSystemLicenseSource;
  readonly sourceUri: string;
}

/**
 * The eleven Phase-1 code systems (§3.9). Order is stable for deterministic seeding/tests;
 * exactly mirrors the {@link CodeSystemId} union — every member has a row, no extras.
 */
export const PLATFORM_CODE_SYSTEMS: readonly PlatformCodeSystemSeed[] = [
  {
    id: "icd10cm",
    name: "ICD-10-CM",
    licenseSource: "public",
    sourceUri: "https://www.cms.gov/medicare/coding/icd10",
  },
  {
    id: "icd10pcs",
    name: "ICD-10-PCS",
    licenseSource: "public",
    sourceUri: "https://www.cms.gov/medicare/coding/icd10",
  },
  {
    id: "snomed",
    name: "SNOMED CT US",
    licenseSource: "umls",
    sourceUri: "https://www.nlm.nih.gov/healthit/snomedct",
  },
  {
    id: "loinc",
    name: "LOINC",
    licenseSource: "regenstrief",
    sourceUri: "https://loinc.org",
  },
  {
    id: "rxnorm",
    name: "RxNorm",
    licenseSource: "public",
    sourceUri: "https://www.nlm.nih.gov/research/umls/rxnorm",
  },
  {
    id: "ndc",
    name: "NDC",
    licenseSource: "public",
    sourceUri:
      "https://www.fda.gov/drugs/drug-approvals-and-databases/national-drug-code-directory",
  },
  {
    id: "hcpcs",
    name: "HCPCS (incl Q)",
    licenseSource: "public",
    sourceUri: "https://www.cms.gov/medicare/coding/medhcpcsgeninfo",
  },
  {
    id: "cvx",
    name: "CVX (vaccines)",
    licenseSource: "public",
    sourceUri: "https://www2a.cdc.gov/vaccines/iis/iisstandards/vaccines.asp",
  },
  {
    id: "revenue",
    name: "UB-04 revenue",
    licenseSource: "public",
    sourceUri: "https://www.nubc.org",
  },
  {
    id: "carc",
    name: "X12 CARC",
    licenseSource: "public",
    sourceUri: "https://x12.org/codes/claim-adjustment-reason-codes",
  },
  {
    id: "rarc",
    name: "X12 RARC",
    licenseSource: "public",
    sourceUri: "https://x12.org/codes/remittance-advice-remark-codes",
  },
] as const;
