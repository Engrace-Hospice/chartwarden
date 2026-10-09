// @wardenx/billing — the TENANT-ENTERED hospice visit-charge schedule domain. PURE: no Fastify, no Drizzle, no clock.
//
// A hospice claim reports every visit as its own line with "a charge amount" (CMS Pub. 100-04 ch. 11 §30.3), but a
// visit's charge is informational — the visit is bundled into the level-of-care payment — so the number belongs to
// the hospice's own charge master, not to CMS. WardenX has none, so a billing administrator keys a charge PER
// 15-MINUTE UNIT PER DISCIPLINE, per provider entity, effective-dated and append-only like the rate table (F-210).
// This module owns the rules that keep that hand-keyed input honest and the FAIL-CLOSED resolution: a billed visit
// whose discipline has no charge on its date is reported as missing, never defaulted to a guess.
import type { IsoDate } from "../contracts";
import { toEpochDay } from "../domain/dates";
import type { Cents } from "../domain/money";

/** The disciplines a visit charge is keyed for: what a visit line is coded from (an aide is `chha`). */
export const VISIT_CHARGE_DISCIPLINES = ["rn", "lpn", "chha", "msw", "pt", "ot", "slp"] as const;
export type VisitChargeDiscipline = (typeof VISIT_CHARGE_DISCIPLINES)[number];

/** Per-15-minute-unit charge per discipline, whole cents; `null` = no charge entered for that discipline. */
export type VisitUnitCharges = { readonly [D in VisitChargeDiscipline]: Cents | null };

/** Plausibility ceiling per 15-minute unit, in cents ($1,000.00): catches dollars keyed as cents. A charge may be 0. */
export const VISIT_CHARGE_MAX_CENTS = 100_000;

/** One effective-dated version of a provider entity's schedule. */
export interface VisitChargeVersion {
  readonly effectiveFrom: IsoDate;
  /** `null` = open-ended. */
  readonly effectiveTo: IsoDate | null;
  readonly charges: VisitUnitCharges;
}

export interface VisitChargeEntry {
  readonly effectiveFrom: IsoDate;
  readonly effectiveTo?: IsoDate | null;
  readonly charges: VisitUnitCharges;
}

export type VisitChargeValidation =
  | { readonly ok: true; readonly effectiveTo: IsoDate | null }
  | { readonly ok: false; readonly errors: readonly string[] };

function isDate(s: string): boolean {
  try {
    toEpochDay(s);
    return true;
  } catch {
    return false;
  }
}

/** Validate a keyed schedule entry: a sane window, at least one charge, every charge whole cents inside the band. */
export function validateVisitChargeEntry(entry: VisitChargeEntry): VisitChargeValidation {
  const errors: string[] = [];
  let any = false;
  for (const discipline of VISIT_CHARGE_DISCIPLINES) {
    const v = entry.charges[discipline];
    if (v === null) continue;
    any = true;
    if (!Number.isInteger(v) || v < 0) {
      errors.push(`${discipline} charge must be a whole number of cents (0 or more)`);
    } else if (v > VISIT_CHARGE_MAX_CENTS) {
      errors.push(
        `${discipline} charge (${v}) is outside the plausible band 0-${VISIT_CHARGE_MAX_CENTS} cents per 15 minutes; charges are WHOLE CENTS ($25.00 is 2500, not 25)`,
      );
    }
  }
  if (!any) errors.push("enter a charge for at least one discipline");

  const effectiveTo = entry.effectiveTo ?? null;
  if (!isDate(entry.effectiveFrom)) {
    errors.push("effectiveFrom must be a valid YYYY-MM-DD date");
  } else if (effectiveTo !== null) {
    if (!isDate(effectiveTo)) errors.push("effectiveTo must be a valid YYYY-MM-DD date");
    else if (effectiveTo < entry.effectiveFrom) {
      errors.push("effectiveTo must not precede effectiveFrom");
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, effectiveTo };
}

const covers = (v: VisitChargeVersion, date: IsoDate): boolean =>
  v.effectiveFrom <= date && (v.effectiveTo === null || v.effectiveTo >= date);

/** The per-unit charge for `discipline` on `date` from the covering version, or `null` (no version / no charge). */
export function visitUnitChargeOn(
  versions: readonly VisitChargeVersion[],
  date: IsoDate,
  discipline: VisitChargeDiscipline,
): Cents | null {
  const version = versions.find((v) => covers(v, date));
  return version === undefined ? null : version.charges[discipline];
}

/**
 * The disciplines with a billed visit on a date that has no charge, each once, in vocabulary order. Non-empty means
 * the claim cannot be assembled honestly (fail closed).
 */
export function missingVisitCharges(
  versions: readonly VisitChargeVersion[],
  billed: readonly { readonly serviceDate: IsoDate; readonly discipline: VisitChargeDiscipline }[],
): readonly VisitChargeDiscipline[] {
  const missing = new Set<VisitChargeDiscipline>();
  for (const line of billed) {
    if (visitUnitChargeOn(versions, line.serviceDate, line.discipline) === null) {
      missing.add(line.discipline);
    }
  }
  return VISIT_CHARGE_DISCIPLINES.filter((d) => missing.has(d));
}
