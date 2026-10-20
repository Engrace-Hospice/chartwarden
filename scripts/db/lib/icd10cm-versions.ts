// The ICD-10-CM version rows shared by `load-icd10cm.ts` (the full CDC/NCHS release) and
// `seed-terminology.ts` (the offline starter subset). Same ids and dates on purpose: search filters
// by each concept's own dates, not by version, so a subset under any other id would show every code
// twice once the real release is loaded. Under these ids the loader replaces the subset in place.

export interface Icd10cmVersion {
  readonly version: "FY2026" | "FY2027";
  /** Fixed ids, so a re-run is idempotent rather than accumulating versions. */
  readonly id: string;
  readonly releasedOn: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export const ICD10CM_FY2026: Icd10cmVersion = {
  version: "FY2026",
  id: "38000000-0000-4000-8000-0000000a2026",
  releasedOn: "2025-06-10",
  effectiveFrom: "2025-10-01",
  effectiveTo: "2026-09-30",
};

export const ICD10CM_FY2027: Icd10cmVersion = {
  version: "FY2027",
  id: "38000000-0000-4000-8000-0000000a2027",
  releasedOn: "2026-06-03",
  effectiveFrom: "2026-10-01",
  effectiveTo: null,
};
