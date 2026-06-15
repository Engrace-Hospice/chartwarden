// @wardenx/audit — Eraser semantics for retention-driven destruction (M4-T08, M4 spec §6, §10.6).
//
// A destruction certificate may approve erasing a tenant's expired audit data, but TWO rules
// override the certificate row-by-row and must be enforced where the erasure actually happens —
// never trusted to the approval UI:
//
//   1. LEGAL-HOLD SUPREMACY (§10.6, D1): a row matched by an active `legal_hold` is never touched
//      by retention-driven destruction. The hold wins over the certificate; the row is skipped.
//   2. PART 2 LIFETIME RETENTION (§6, D8): a `compliance_42cfr_part2` (SUD) audit row must be kept
//      for the patient's lifetime PLUS six years after death (42 CFR §2.x). The eraser refuses it
//      while the patient is `active`, or `deceased` but within six years of the death date; only a
//      patient deceased > 6 years lets the row be erased.
//
// Like the rest of the M4 surface this is pure logic over injected ports (the production Drizzle
// adapter — patient lookup, legal-hold match, the partitioned DELETE — is a tracked follow-up); a
// reusable in-memory adapter lives in ./ports for the route/destruction tests to run against.

/** Audit retention class incl. the Part 2 fourth value (mirrors the query DTO + trigger gen). */
export type AuditRetentionClass =
  | "operational"
  | "compliance"
  | "legal_hold"
  | "compliance_42cfr_part2";

/** True when a row's class is the Part 2 (SUD) class the lifetime check guards (§6). */
export function isPartTwoRetention(retentionClass: AuditRetentionClass): boolean {
  return retentionClass === "compliance_42cfr_part2";
}

/** Patient lifecycle facts the Part 2 retention check needs (§6 `loadPatient`). */
export interface PatientLifecycle {
  readonly status: "active" | "deceased";
  /** ISO-8601 date of death; required to evaluate the 6-year post-death window. */
  readonly deceasedDate?: string | null;
}

/** One row-group a destruction run asks the eraser to erase (spec §6 `EraseInput`). */
export interface EraseInput {
  readonly retentionClass: AuditRetentionClass;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly organizationId: string;
  readonly destructionCertificateId: string;
  /**
   * The patient the row concerns — drives the §6 lifetime check for Part 2 rows. When absent the
   * eraser falls back to `ports.patientIdForResource`; a Part 2 row that resolves to no patient is
   * refused defensively (a Part 2 row should always carry a patient).
   */
  readonly patientId?: string;
}

/** The exhaustive outcome of erasing one row-group (spec §6 `EraseOutcome`). */
export type EraseOutcome =
  | { readonly kind: "erased"; readonly rowsErased: number }
  | {
      readonly kind: "refused_part_two_retention";
      readonly reason: "patient_alive" | "within_6yr_post_death";
    }
  | { readonly kind: "refused_legal_hold"; readonly legalHoldId: string }
  | { readonly kind: "refused_class_not_eligible"; readonly class: string };

/** Ports the eraser resolves through — injected so the logic stays infra-free + testable. */
export interface EraserPorts {
  /** The id of an active legal hold covering this row-group, or null when none (§10.6). */
  legalHoldFor(input: EraseInput): string | null | Promise<string | null>;
  /** Patient lifecycle for the Part 2 check; null when the patient is unknown. */
  loadPatient(
    organizationId: string,
    patientId: string,
  ): PatientLifecycle | null | Promise<PatientLifecycle | null>;
  /** Resolve the patient a Part 2 resource belongs to when `EraseInput.patientId` is absent. */
  patientIdForResource?(resourceKind: string, resourceId: string): string | null;
  /** Perform the actual erasure (crypto-erase / partitioned DELETE); returns rows erased. */
  performErasure(input: EraseInput): number | Promise<number>;
  /** Injected clock so the 6-year post-death window is deterministic in tests. */
  now(): Date;
}

/** Add `years` whole years to `date` (UTC), for the §6 six-year post-death window. */
function addYears(date: Date, years: number): Date {
  const out = new Date(date.getTime());
  out.setUTCFullYear(out.getUTCFullYear() + years);
  return out;
}

/**
 * Erase one row-group, enforcing legal-hold supremacy then the Part 2 lifetime retention rule
 * before the standard erase (spec §6). Returns the outcome the destruction workflow tallies —
 * it never throws on a refusal; refusing IS the correct, recorded result.
 */
export async function eraseAuditRows(
  input: EraseInput,
  ports: EraserPorts,
): Promise<EraseOutcome> {
  // 1. Legal-hold supremacy (§10.6, D1) — a held row is never touched by retention destruction.
  const legalHoldId = await ports.legalHoldFor(input);
  if (legalHoldId) return { kind: "refused_legal_hold", legalHoldId };

  // A `legal_hold`-classed row is not retention-destruction eligible at all (§10.5
  // "nothing in legal_hold is ever touched") — defensive even if no hold row matched above.
  if (input.retentionClass === "legal_hold") {
    return { kind: "refused_class_not_eligible", class: input.retentionClass };
  }

  // 2. Part 2 lifetime retention (§6, D8).
  if (isPartTwoRetention(input.retentionClass)) {
    const patientId =
      input.patientId ?? ports.patientIdForResource?.(input.resourceKind, input.resourceId) ?? null;

    // A Part 2 row should always resolve to a patient; if it can't, refuse (don't risk erasing
    // protected SUD history with no lifetime context).
    if (!patientId) return { kind: "refused_part_two_retention", reason: "patient_alive" };

    const patient = await ports.loadPatient(input.organizationId, patientId);
    if (patient?.status === "active") {
      return { kind: "refused_part_two_retention", reason: "patient_alive" };
    }
    if (patient?.status === "deceased" && patient.deceasedDate) {
      const window = addYears(new Date(patient.deceasedDate), 6);
      if (window > ports.now()) {
        return { kind: "refused_part_two_retention", reason: "within_6yr_post_death" };
      }
      // Deceased AND > 6 years post-death — erasure permitted; fall through.
    } else if (patient?.status === "deceased" && !patient.deceasedDate) {
      // Deceased with no recorded death date — can't prove the window elapsed; refuse.
      return { kind: "refused_part_two_retention", reason: "within_6yr_post_death" };
    }
  }

  // 3. Standard erase path.
  const rowsErased = await ports.performErasure(input);
  return { kind: "erased", rowsErased };
}
