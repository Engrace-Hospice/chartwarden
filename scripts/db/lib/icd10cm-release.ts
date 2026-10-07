// scripts/db/lib/icd10cm-release.ts — the F-238 ICD-10-CM release parsers now live in the M38 loader package
// (`packages/terminology-loader`, GAP-108) so the production load pipeline and this one-off script share ONE
// implementation. Re-exported here so `scripts/db/load-icd10cm.ts` and its unit test are unchanged.
export * from "../../../packages/terminology-loader/src/parsers/icd10cm-release";
