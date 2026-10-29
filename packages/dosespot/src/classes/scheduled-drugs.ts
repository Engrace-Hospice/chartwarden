// @chartwarden/dosespot — advisory DEA schedule for a drug NAME (M12 §2.1 class flag stays authoritative).
//
// `medication_order.is_controlled_substance` and `dea_schedule` come from the order CLASS (`isEpcsRequired`), and
// that flag gates EPCS signing and the eMAR witness step. A scheduled drug saved as `standard` therefore reads
// "not controlled". This list only ADVISES: it never changes a class, a signing path or a witness rule. Same
// shape as `sud-treatment-drugs.ts` (closed list, generic name, whole word, case-insensitive; brand names are
// NOT matched).
//
// CLINICAL CONTENT — NOT YET PHARMACIST-REVIEWED. The schedules below are a seed list of common hospice
// comfort-kit and opioid/benzodiazepine drugs; a clinical owner must confirm it before it is relied on.
// Combination products whose schedule depends on the combination (e.g. codeine/acetaminophen) are left out.
import type { DeaSchedule } from "@chartwarden/types";

export const SCHEDULED_DRUG_SCHEDULES: Readonly<Record<string, DeaSchedule>> = {
  morphine: "II",
  oxycodone: "II",
  hydromorphone: "II",
  oxymorphone: "II",
  fentanyl: "II",
  methadone: "II",
  hydrocodone: "II",
  meperidine: "II",
  tapentadol: "II",
  methylphenidate: "II",
  buprenorphine: "III",
  lorazepam: "IV",
  diazepam: "IV",
  alprazolam: "IV",
  clonazepam: "IV",
  midazolam: "IV",
  temazepam: "IV",
  phenobarbital: "IV",
  zolpidem: "IV",
  tramadol: "IV",
  carisoprodol: "IV",
  lacosamide: "V",
  pregabalin: "V",
};

const SCHEDULED_DRUG_PATTERN = new RegExp(
  `\\b(${Object.keys(SCHEDULED_DRUG_SCHEDULES).join("|")})\\b`,
  "gi",
);

/**
 * The most restrictive (lowest-numbered) schedule among ALL matched names, or null when none match. `\b` also
 * matches across a hyphen or slash ("non-morphine" matches): for an advisory a false positive is the safer error.
 */
export function advisoryDeaSchedule(drugName: string): DeaSchedule | null {
  const order: readonly DeaSchedule[] = ["II", "III", "IV", "V"];
  let best = -1;
  for (const m of drugName.matchAll(SCHEDULED_DRUG_PATTERN)) {
    const schedule = SCHEDULED_DRUG_SCHEDULES[(m[1] ?? "").toLowerCase()];
    const rank = schedule ? order.indexOf(schedule) : -1;
    if (rank >= 0 && (best < 0 || rank < best)) best = rank;
  }
  return best < 0 ? null : (order[best] ?? null);
}
