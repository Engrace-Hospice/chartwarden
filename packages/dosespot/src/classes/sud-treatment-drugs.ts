// @wardenx/dosespot — the SUD-treatment medication list (M12 spec §6 Part 2 table / §7.8, 42 CFR Part 2).
//
// ONE home for the list. `medication_order.is_sud_treatment` is derived from it on every draft write
// (M12 `dosespot-route-service-db.ts`) and the 0340 backfill migration's SQL list is asserted equal to it by
// `apps/backend/__tests__/m12-sud-treatment-drug-list.test.ts` — change it here and update that migration's
// successor (a NEW forward migration; never edit 0340) in the same change.
//
// Source: M12 spec §6 (compliance table): methadone, buprenorphine, naltrexone (OUD); disulfiram, acamprosate,
// naltrexone (AUD); varenicline (tobacco UD) — plus lofexidine (opioid-withdrawal, MAT adjunct). The M38
// `sud_treatment_medication` value set the spec names is not seeded in Phase 1, so M12 carries the closed
// list; when M38 seeds it, this array is the seed's source, not a competing copy.
//
// Matching is generic-name, whole-word and case-insensitive: a salt, strength or combination decoration
// ("buprenorphine/naloxone 8-2 mg", "NALTREXONE HCl") never hides the drug. Brand names are NOT matched
// (a clinical-content decision — see the M12 batch-7 report).
export const SUD_TREATMENT_DRUG_NAMES = [
  "methadone",
  "buprenorphine",
  "naltrexone",
  "disulfiram",
  "acamprosate",
  "lofexidine",
  "varenicline",
] as const;

const SUD_TREATMENT_DRUG_PATTERN = new RegExp(`\\b(${SUD_TREATMENT_DRUG_NAMES.join("|")})\\b`, "i");

export function isSudTreatmentDrug(drugName: string): boolean {
  return SUD_TREATMENT_DRUG_PATTERN.test(drugName);
}
