// apps/backend/src/modules/12-dosespot/prescriber-eligibility.ts — M12-T08 the §2.1 / §4.7 prescriber-
// eligibility matrix, in its own leaf module so BOTH the §4.7 ABAC predicate resolver (abac-predicates.ts)
// and the route service (routes/service.ts) can import it without a circular dependency (the service injects
// its `DoseSpotAbacResolver` type into abac-predicates, so the eligibility primitive must live below both).
import type { MedClass } from "@wardenx/types";

/** The disciplines eligible to author a non-controlled medication order (RN drafting-on-behalf included). */
export const PRESCRIBE_DISCIPLINES: ReadonlySet<string> = new Set([
  "hospice_physician",
  "medical_director",
  "np",
  "pa",
  "rn_case_manager",
  "clinical_supervisor",
]);

/** The disciplines eligible to author a controlled-substance order (prescriber-only — no RN/CS drafting). */
export const CONTROLLED_PRESCRIBE_DISCIPLINES: ReadonlySet<string> = new Set([
  "hospice_physician",
  "medical_director",
  "np",
  "pa",
]);

/**
 * §2.1 / §4.7 — whether a discipline may author a medication order of `medClass`. Controlled substances are
 * prescriber-only (DEA-registered MD/NP/PA); standard / compounded permit the RN-drafting-on-behalf path.
 */
export function prescriberEligible(discipline: string, medClass: MedClass): boolean {
  const d = discipline.toLowerCase();
  if (medClass === "controlled_substance") return CONTROLLED_PRESCRIBE_DISCIPLINES.has(d);
  return PRESCRIBE_DISCIPLINES.has(d);
}
