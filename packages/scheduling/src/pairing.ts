// @chartwarden/scheduling — CW-PI-04: the pure verdict behind the older-visit pairing reconciliation.
//
// A visit is stamped at assignment with the discipline its clinician was scheduled under
// (`visit.assigned_discipline_at_assignment`). Today's rules refuse any (purpose, discipline) pair that is
// not BOTH accepted by the purpose's discipline gate ({@link VISIT_PURPOSE_DISCIPLINES}) AND a legal M8
// encounter pair ({@link encounterTypeForVisit}); visits created before those rules can carry one anyway.
// This module decides, for one such visit, whether it is still legal, can be re-stamped unambiguously, or
// needs a person. It is IO-free: the caller supplies the clinician's currently held and credentialed
// disciplines, so the same verdict backs the read-only detection and the apply step.

import type { VisitPurpose } from "@chartwarden/types";
import {
  type SchedulingDiscipline,
  VISIT_PURPOSE_DISCIPLINES,
  encounterTypeForVisit,
} from "./policy";

/** States in which a visit has not started: its stamped discipline may still be corrected. */
export const PAIRING_OPEN_STATUSES = ["proposed", "published"] as const;
/** States in which the clinician is on the way or on site: never edited underneath them, flagged instead. */
export const PAIRING_IN_PROGRESS_STATUSES = ["en_route", "in_visit"] as const;

/** Why an affected visit is left for a person instead of being re-stamped. Codes only. */
export type PairingReviewReason =
  | "VISIT_IN_PROGRESS"
  | "ASSIGNEE_NOT_ACTIVE"
  | "NO_LEGAL_DISCIPLINE_HELD"
  | "LEGAL_DISCIPLINE_NOT_CREDENTIALED"
  | "AMBIGUOUS_LEGAL_DISCIPLINES";

export type PairingVerdict =
  | { readonly kind: "legal" }
  /** A completed, cancelled, no-show or rescheduled visit: history, reported and never changed. */
  | { readonly kind: "historical" }
  /** Open visit whose assignee holds and is credentialed for exactly one discipline legal for the purpose. */
  | { readonly kind: "restamp"; readonly toDiscipline: SchedulingDiscipline }
  | { readonly kind: "review"; readonly reason: PairingReviewReason };

/** The disciplines a purpose can be scheduled for today: accepted by the gate AND with a legal M8 pair. */
export function legalDisciplinesForPurpose(purpose: VisitPurpose): readonly SchedulingDiscipline[] {
  const accepted: readonly SchedulingDiscipline[] = VISIT_PURPOSE_DISCIPLINES[purpose] ?? [];
  return accepted.filter((discipline) => encounterTypeForVisit(purpose, discipline) !== null);
}

/** Whether today's rules accept `discipline` (any stored string, a legacy value included) for `purpose`. */
export function isLegalVisitPairing(purpose: VisitPurpose, discipline: string): boolean {
  return (legalDisciplinesForPurpose(purpose) as readonly string[]).includes(discipline);
}

/** Every legal `purpose:discipline` key, for a database filter that selects the complement. */
export const LEGAL_VISIT_PAIRING_KEYS: readonly string[] = (
  Object.keys(VISIT_PURPOSE_DISCIPLINES) as VisitPurpose[]
).flatMap((purpose) =>
  legalDisciplinesForPurpose(purpose).map((discipline) => `${purpose}:${discipline}`),
);

export interface VisitPairingFacts {
  readonly status: string;
  readonly purpose: VisitPurpose;
  readonly stampedDiscipline: string;
  /** The assignee's membership is active (the write gate's `clinician_membership_active`). */
  readonly assigneeActive: boolean;
  /** Roles the assignee holds NOW that name a scheduling discipline. */
  readonly heldDisciplines: readonly SchedulingDiscipline[];
  /** Disciplines the assignee holds an active credential for on the visit's service date. */
  readonly credentialedDisciplines: readonly SchedulingDiscipline[];
}

/**
 * The verdict for one visit. A re-stamp keeps the assignee and the purpose: it only corrects the discipline
 * the visit was stamped with, and only when exactly one discipline is both legal for the purpose and held
 * and credentialed by that same clinician today. Everything else that is not legal is left for a person;
 * the policy order of {@link VISIT_PURPOSE_DISCIPLINES} is never used to break a tie.
 */
export function classifyVisitPairing(facts: VisitPairingFacts): PairingVerdict {
  if (isLegalVisitPairing(facts.purpose, facts.stampedDiscipline)) return { kind: "legal" };
  if ((PAIRING_IN_PROGRESS_STATUSES as readonly string[]).includes(facts.status)) {
    return { kind: "review", reason: "VISIT_IN_PROGRESS" };
  }
  if (!(PAIRING_OPEN_STATUSES as readonly string[]).includes(facts.status)) {
    return { kind: "historical" };
  }
  if (!facts.assigneeActive) return { kind: "review", reason: "ASSIGNEE_NOT_ACTIVE" };
  const legal = legalDisciplinesForPurpose(facts.purpose);
  const heldLegal = facts.heldDisciplines.filter((discipline) => legal.includes(discipline));
  if (heldLegal.length === 0) return { kind: "review", reason: "NO_LEGAL_DISCIPLINE_HELD" };
  const usable = heldLegal.filter((discipline) =>
    facts.credentialedDisciplines.includes(discipline),
  );
  if (usable.length === 0) {
    return { kind: "review", reason: "LEGAL_DISCIPLINE_NOT_CREDENTIALED" };
  }
  if (usable.length > 1) return { kind: "review", reason: "AMBIGUOUS_LEGAL_DISCIPLINES" };
  return { kind: "restamp", toDiscipline: usable[0] as SchedulingDiscipline };
}
