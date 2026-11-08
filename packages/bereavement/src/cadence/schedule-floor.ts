// @chartwarden/bereavement — D4 death-date-anchored cadence floor + the tenant-tighten validator (M16-T01).
//
// The platform floor (ADR-0109 D2: the Medicare-aligned timeline for EVERY risk tier) is a MINIMUM: a tenant
// may add contacts, shift a floor contact EARLIER, and convert a floor contact to a higher-touch modality. It
// may never drop a floor contact, push one past its floor offset, or downgrade its modality. This module is the single source of truth for both halves —
// the floor table the schedule generator materializes from, and the validator that proves a tenant policy
// only tightened it. PURE DATA + pure functions — no IO, `@chartwarden/types`-only.

import type {
  BereavementAnniversaryMark,
  BereavementOutreachKind,
  BereavementRiskTier,
} from "@chartwarden/types";
import { isPermittedModalitySubstitution } from "../outreach-kinds";
import { OUTREACH_DUE_AT_CEILING_DAYS } from "../policy";

/** The stable identity of a floor contact, used to match a tenant row back to the item it tightens and
 *  persisted on `bereavement_outreach.cadence_mark` (ADR-0109 D4). */
export type BereavementCadenceMark =
  | "immediate_screen"
  | "condolence_letter"
  | "week_1"
  | "week_2"
  | "initial_outreach"
  /** DEPRECATED alias (pre-ADR-0109 d30 call). Sits in no floor; kept so old rows and consumers still resolve it. */
  | "one_month"
  | "two_month"
  | "three_month"
  | "six_month"
  | "nine_month"
  | "anniversary"
  | "anniversary_call"
  | "closeout_letter";

/** One contact on the cadence, as a day-offset from `death_date` plus its floor modality. */
export interface BereavementCadenceItem {
  readonly mark: BereavementCadenceMark;
  /** Days from `death_date`. The schedule generator turns this into `due_at`. */
  readonly offsetDays: number;
  /** The platform-floor modality; a tenant may substitute upward (see `isPermittedModalitySubstitution`). */
  readonly kind: BereavementOutreachKind;
  /** The `bereavement_anniversary_reminder` mark this contact belongs to, when it is a milestone. */
  readonly anniversaryMark: BereavementAnniversaryMark | null;
}

/**
 * ADR-0109 D2 — the universal Medicare-aligned timeline: EVERY tier gets these eight contacts, so a family
 * scored low by the rubric still receives the whole timeline. Days count from the UTC-midnight death date.
 *
 *   • `nine_month` keeps its legacy anniversary mark `nine_month_high_risk_only` (the enum value is not
 *     renamed; the UI relabels it "Month 9").
 *   • `anniversary` (the letter, shown as a "card") and `anniversary_call` share day 365; only the letter
 *     carries the reminder mark, so a plan seeds one reminder per milestone.
 *   • `closeout_letter` (day 390) is separable: a tenant may reschedule it earlier but never drop it, and it
 *     replaces the never-wired day-396 closeout phone call.
 */
const LOW_TIER_ITEMS: readonly BereavementCadenceItem[] = [
  { mark: "condolence_letter", offsetDays: 2, kind: "sympathy_letter", anniversaryMark: null },
  { mark: "initial_outreach", offsetDays: 28, kind: "phone_call", anniversaryMark: null },
  { mark: "three_month", offsetDays: 90, kind: "phone_call", anniversaryMark: "three_month" },
  { mark: "six_month", offsetDays: 180, kind: "phone_call", anniversaryMark: "six_month" },
  {
    mark: "nine_month",
    offsetDays: 270,
    kind: "phone_call",
    anniversaryMark: "nine_month_high_risk_only",
  },
  {
    mark: "anniversary",
    offsetDays: 365,
    kind: "anniversary_letter",
    anniversaryMark: "anniversary",
  },
  { mark: "anniversary_call", offsetDays: 365, kind: "phone_call", anniversaryMark: null },
  { mark: "closeout_letter", offsetDays: 390, kind: "sympathy_letter", anniversaryMark: null },
];

/** ADR-0109 D2 — moderate ADDS a week-2 call. */
const MODERATE_TIER_ADDITIONS: readonly BereavementCadenceItem[] = [
  { mark: "week_2", offsetDays: 14, kind: "phone_call", anniversaryMark: null },
];

/** ADR-0109 D2 — high ADDS a week-1 and a 2-month contact on top of the moderate set. */
const HIGH_TIER_ADDITIONS: readonly BereavementCadenceItem[] = [
  { mark: "week_1", offsetDays: 7, kind: "phone_call", anniversaryMark: null },
  { mark: "two_month", offsetDays: 60, kind: "phone_call", anniversaryMark: null },
];

/**
 * ADR-0109 D2 — complicated ADDS an immediate screen and converts the week-1 contact to an in-person visit.
 *
 * "Immediate" is encoded as a 2-day floor rather than day 0 deliberately: a tenant may only shift a floor
 * contact EARLIER, so a day-0 floor would leave no room to tighten, and a same-day screen is not
 * operationally reachable for most agencies. Day 2 keeps the 48-hour clinical intent AND keeps the
 * tighten direction usable.
 */
const COMPLICATED_TIER_ADDITIONS: readonly BereavementCadenceItem[] = [
  { mark: "immediate_screen", offsetDays: 2, kind: "phone_call", anniversaryMark: null },
  { mark: "week_1", offsetDays: 7, kind: "in_person_visit", anniversaryMark: null },
];

function mergeByMark(
  base: readonly BereavementCadenceItem[],
  additions: readonly BereavementCadenceItem[],
): readonly BereavementCadenceItem[] {
  const byMark = new Map<BereavementCadenceMark, BereavementCadenceItem>();
  for (const item of [...base, ...additions]) byMark.set(item.mark, item);
  return [...byMark.values()].sort((a, b) => a.offsetDays - b.offsetDays);
}

const MODERATE_TIER_ITEMS = mergeByMark(LOW_TIER_ITEMS, MODERATE_TIER_ADDITIONS);
const HIGH_TIER_ITEMS = mergeByMark(MODERATE_TIER_ITEMS, HIGH_TIER_ADDITIONS);
const COMPLICATED_TIER_ITEMS = mergeByMark(HIGH_TIER_ITEMS, COMPLICATED_TIER_ADDITIONS);

/**
 * ADR-0109 D2 — the platform-floor cadence per risk tier, CUMULATIVE: each tier is the tier below it plus its
 * own additions, so a survivor's program can never lose a contact by being scored at a higher risk. Counts:
 * low 8, moderate 9, high 11, complicated 12.
 *
 * Reading note (§7.4): the spec's high-tier narrative shows in-person visits at week 1 / month 1 / month 3.
 * That narrative describes a TENANT-TIGHTENED schedule (a permitted upward modality substitution); the
 * binding floor is this cumulative set, and a tenant is free to reproduce §7.4 exactly on top of it.
 */
export const BEREAVEMENT_CADENCE_FLOOR: {
  readonly [K in BereavementRiskTier]: readonly BereavementCadenceItem[];
} = {
  low: LOW_TIER_ITEMS,
  moderate: MODERATE_TIER_ITEMS,
  high: HIGH_TIER_ITEMS,
  complicated: COMPLICATED_TIER_ITEMS,
} as const;

// ── ADR-0109 D4: classifying rows written before `cadence_mark` existed ─────────────────────────────

const MS_PER_DAY = 86_400_000;

/** The facts of a `bereavement_outreach` row that `inferLegacyMark` reads. */
export interface LegacyOutreachFacts {
  readonly kind: BereavementOutreachKind;
  readonly anniversaryMark: BereavementAnniversaryMark | null;
  readonly deathAnchorAt: string;
  readonly dueAt: string;
}

/** A milestone row's mark follows its anniversary mark exactly (the pre-ADR-0109 floor wrote one per row). */
const MARK_FOR_ANNIVERSARY_MARK: Readonly<
  Record<BereavementAnniversaryMark, BereavementCadenceMark>
> = {
  one_month: "one_month",
  three_month: "three_month",
  six_month: "six_month",
  nine_month_high_risk_only: "nine_month",
  anniversary: "anniversary",
};

/** The kinds a letter-shaped floor contact (condolence, closeout) can carry, after any survivor re-modalization. */
const LETTER_KINDS: ReadonlySet<BereavementOutreachKind> = new Set([
  "sympathy_letter",
  "sympathy_card",
  "anniversary_letter",
]);

/** Marks with no anniversary mark, by exact due offset and letter-ness. Day 7 appears twice on purpose: the
 *  pre-ADR-0109 condolence letter was due on day 7, which is also week 1's day (a call, not a letter). */
const MARK_BY_OFFSET: ReadonlyArray<{
  readonly offsetDays: number;
  readonly letter: boolean;
  readonly mark: BereavementCadenceMark;
}> = [
  { offsetDays: 2, letter: true, mark: "condolence_letter" },
  { offsetDays: 7, letter: true, mark: "condolence_letter" },
  { offsetDays: 2, letter: false, mark: "immediate_screen" },
  { offsetDays: 7, letter: false, mark: "week_1" },
  { offsetDays: 14, letter: false, mark: "week_2" },
  { offsetDays: 28, letter: false, mark: "initial_outreach" },
  { offsetDays: 60, letter: false, mark: "two_month" },
  { offsetDays: 365, letter: false, mark: "anniversary_call" },
  { offsetDays: 390, letter: true, mark: "closeout_letter" },
];

/**
 * ADR-0109 D4 — the cadence mark a row with a NULL `cadence_mark` was generated for, or `null` when it matches
 * no floor contact (an ad-hoc touchpoint). The tier-change top-up counts these marks as already present so it
 * never adds a floor contact a family already has.
 *
 * ponytail: an exact-offset heuristic. Tenant tightening is never persisted today, so legacy due dates are
 * whole floor offsets. A letter-only survivor's re-modalized week-1 contact is a letter on day 7 and reads as
 * `condolence_letter`; the top-up is forward-only and day 7 is long past by any tier change, so the
 * ambiguity cannot add a contact. Upgrade path: backfill `cadence_mark` and drop this function.
 */
export function inferLegacyMark(row: LegacyOutreachFacts): BereavementCadenceMark | null {
  if (row.anniversaryMark !== null) return MARK_FOR_ANNIVERSARY_MARK[row.anniversaryMark];
  const offsetDays = (Date.parse(row.dueAt) - Date.parse(row.deathAnchorAt)) / MS_PER_DAY;
  if (!Number.isInteger(offsetDays)) return null;
  const letter = LETTER_KINDS.has(row.kind);
  return (
    MARK_BY_OFFSET.find((m) => m.offsetDays === offsetDays && m.letter === letter)?.mark ?? null
  );
}

/** How a tenant policy violated the D4 floor. Every code is a "you loosened it" finding — a tenant adding
 *  contacts or moving them earlier produces no violation at all. */
export type BereavementCadenceViolationCode =
  | "floor_contact_dropped"
  | "floor_contact_delayed"
  | "modality_downgraded"
  | "due_beyond_window_ceiling";

/** One finding from {@link validateTenantCadence}. */
export interface BereavementCadenceViolation {
  readonly code: BereavementCadenceViolationCode;
  readonly mark: BereavementCadenceMark;
  readonly detail: string;
}

/**
 * D4 — proves a tenant cadence only TIGHTENED the platform floor for the given tier. Returns every
 * violation found (not just the first) so the tenant-policy editor can show the whole list at once.
 *
 * Fail-closed by construction: a floor item with no tenant counterpart is a violation, so an empty tenant
 * policy does not read as "compliant, nothing to check" — it reads as every floor contact dropped.
 */
export function validateTenantCadence(
  tier: BereavementRiskTier,
  tenantItems: readonly BereavementCadenceItem[],
): readonly BereavementCadenceViolation[] {
  const violations: BereavementCadenceViolation[] = [];
  const tenantByMark = new Map(tenantItems.map((i) => [i.mark, i]));

  for (const floor of BEREAVEMENT_CADENCE_FLOOR[tier]) {
    const tenant = tenantByMark.get(floor.mark);
    if (!tenant) {
      violations.push({
        code: "floor_contact_dropped",
        mark: floor.mark,
        detail: `the ${tier}-tier floor requires a ${floor.mark} contact`,
      });
      continue;
    }
    if (tenant.offsetDays > floor.offsetDays) {
      violations.push({
        code: "floor_contact_delayed",
        mark: floor.mark,
        detail: `day ${tenant.offsetDays} is later than the floor's day ${floor.offsetDays}`,
      });
    }
    if (!isPermittedModalitySubstitution(floor.kind, tenant.kind)) {
      violations.push({
        code: "modality_downgraded",
        mark: floor.mark,
        detail: `'${tenant.kind}' is lower-touch than the floor's '${floor.kind}'`,
      });
    }
  }

  for (const item of tenantItems) {
    if (item.offsetDays < 0 || item.offsetDays > OUTREACH_DUE_AT_CEILING_DAYS) {
      violations.push({
        code: "due_beyond_window_ceiling",
        mark: item.mark,
        detail: `day ${item.offsetDays} is outside [0, ${OUTREACH_DUE_AT_CEILING_DAYS}]`,
      });
    }
  }

  return violations;
}

/** D4 — the effective cadence for a tier: the tenant policy when it validates, the platform floor when the
 *  tenant declared none. A cadence with violations is never silently repaired — the caller must reject it. */
export function effectiveCadence(
  tier: BereavementRiskTier,
  tenantItems?: readonly BereavementCadenceItem[],
): readonly BereavementCadenceItem[] {
  if (!tenantItems || tenantItems.length === 0) return BEREAVEMENT_CADENCE_FLOOR[tier];
  const violations = validateTenantCadence(tier, tenantItems);
  if (violations.length > 0) {
    throw new RangeError(
      `bereavement: tenant cadence loosens the ${tier}-tier platform floor (${violations
        .map((v) => `${v.mark}:${v.code}`)
        .join(", ")})`,
    );
  }
  return [...tenantItems].sort((a, b) => a.offsetDays - b.offsetDays);
}
