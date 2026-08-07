// @wardenx/quality — opioid drug-name classification for `opioid_on_admission_rate`. Pure. No IO.
//
// M38's proper RxNorm-code-based classification path (`value_set` / `value_set_member`, keyed on a real
// RxCUI) is NOT usable here: `concept_rxnorm` is fed only by a live monthly RxNorm/UMLS loader, and no
// RxNorm concept data is checked into this repo (confirmed — `packages/terminology/src/seed/
// value-set-members.ts` explicitly leaves `comfort_kit_medications` uncurated for the identical reason).
// Matching by a hand-typed RxCUI number here would be worse than not matching at all — a wrong numeric
// code silently misclassifies forever with no way to self-verify.
//
// So this classifies by DRUG NAME instead, against `medication_order.drug_name` (free text). A curated,
// versioned, reviewable name list — the SAME shape as `HVLDL_QUALIFYING_DISCIPLINES_v<FY>` — is the
// honest alternative: every entry here is a well-established generic ingredient or brand name, not a
// number that could be transposed. A hospice's clinical pharmacist can review/extend this list directly;
// getting a NAME wrong is visible on inspection in a way a wrong RxCUI digit is not.
//
// ★ FLAGGED (not silently asserted as complete): this is a platform-default surveillance list, not a
// CMS-published or NLM-authoritative therapeutic-class source. `opioid_on_admission_rate` is explicitly an
// INFORMATIONAL measure (its own calculator's doc comment), not a CMS HCI-scored indicator — lower stakes
// than a public-reporting figure, but still worth a real RxNorm-backed reclassification once M38's loader
// (§4.3 of the M38 spec) actually ships and `concept_rxnorm`/`comfort_kit_medications` are populated.

/**
 * Common opioid generic ingredient names + well-known US brand names, lower-cased. Matched as a
 * case-insensitive SUBSTRING of `medication_order.drugName` (e.g. "Oxycodone 5mg" matches "oxycodone";
 * "OxyContin ER" matches "oxycontin"). Versioned so a future review is a single reviewed constant change,
 * not a reverse-engineering exercise (the `HCI_THRESHOLDS_v<FY>` / `HVLDL_QUALIFYING_DISCIPLINES_v<FY>`
 * precedent).
 */
export const OPIOID_DRUG_NAME_PATTERNS_v2025: readonly string[] = [
  // Generic ingredient names.
  "morphine",
  "oxycodone",
  "hydrocodone",
  "hydromorphone",
  "fentanyl",
  "methadone",
  "codeine",
  "tramadol",
  "oxymorphone",
  "buprenorphine",
  "tapentadol",
  "meperidine",
  "levorphanol",
  // Common brand names whose product name does not obviously contain the generic name above.
  "oxycontin",
  "percocet",
  "vicodin",
  "dilaudid",
  "duragesic",
  "opana",
  "roxanol",
  "ms contin",
  "actiq",
  "demerol",
  "belbuca",
  "butrans",
] as const;

/** Case-insensitive substring match against {@link OPIOID_DRUG_NAME_PATTERNS_v2025}. */
export function isOpioidDrugName(drugName: string): boolean {
  const lower = drugName.toLowerCase();
  return OPIOID_DRUG_NAME_PATTERNS_v2025.some((pattern) => lower.includes(pattern));
}
