// @wardenx/bereavement — D4 death-date-anchored cadence floor + the tenant-tighten validator (M16-T01).
//
// The CoP 418.64(d) platform floor is a MINIMUM: a tenant may add contacts, shift a floor contact EARLIER,
// and convert a floor contact to a higher-touch modality. It may never drop a floor contact, push one past
// its floor offset, or downgrade its modality. This module is the single source of truth for both halves —
// the floor table the schedule generator materializes from, and the validator that proves a tenant policy
// only tightened it. PURE DATA + pure functions — no IO, `@wardenx/types`-only.

import type {
  BereavementAnniversaryMark,
  BereavementOutreachKind,
  BereavementRiskTier,
} from "@wardenx/types";
import {
  OUTREACH_DUE_AT_CEILING_DAYS,
  BEREAVEMENT_WINDOW_DAYS,
} from "../policy";
import { isPermittedModalitySubstitution } from "../outreach-kinds";

/** The stable identity of a floor contact, used to match a tenant row back to the item it tightens. */
export type BereavementCadenceMark =
  | "immediate_screen"
  | "condolence_letter"
  | "week_1"
  | "week_2"
  | "one_month"
  | "two_month"
  | "three_month"
  | "six_month"
  | "nine_month"
  | "anniversary"
  | "closeout";

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

/** D4 — the condolence letter every tier gets, "≤ 7 days" from death. */
const CONDOLENCE_LETTER: BereavementCadenceItem = {
  mark: "condolence_letter",
  offsetDays: 7,
  kind: "sympathy_letter",
  anniversaryMark: null,
};

const LOW_TIER_ITEMS: readonly BereavementCadenceItem[] = [
  CONDOLENCE_LETTER,
  { mark: "one_month", offsetDays: 30, kind: "phone_call", anniversaryMark: "one_month" },
  { mark: "three_month", offsetDays: 90, kind: "phone_call", anniversaryMark: "three_month" },
  { mark: "six_month", offsetDays: 180, kind: "phone_call", anniversaryMark: "six_month" },
  {
    mark: "anniversary",
    offsetDays: 365,
    kind: "anniversary_letter",
    anniversaryMark: "anniversary",
  },
];

/** D4 — moderate ADDS a week-2 contact and the 9-month milestone (the `nine_month_high_risk_only`
 *  anniversary mark exists precisely for the elevated-risk tiers). */
const MODERATE_TIER_ADDITIONS: readonly BereavementCadenceItem[] = [
  { mark: "week_2", offsetDays: 14, kind: "phone_call", anniversaryMark: null },
  {
    mark: "nine_month",
    offsetDays: 270,
    kind: "phone_call",
    anniversaryMark: "nine_month_high_risk_only",
  },
];

/** D4 — high ADDS a week-1 and a 2-month contact on top of the moderate set. */
const HIGH_TIER_ADDITIONS: readonly BereavementCadenceItem[] = [
  { mark: "week_1", offsetDays: 7, kind: "phone_call", anniversaryMark: null },
  { mark: "two_month", offsetDays: 60, kind: "phone_call", anniversaryMark: null },
];

/**
 * D4 — complicated ADDS an immediate screen and converts the week-1 contact to an in-person visit.
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
 * D4 — the platform-floor cadence per risk tier, CUMULATIVE: each tier is the tier below it plus its own
 * additions, so a survivor's program can never lose a contact by being scored at a higher risk.
 *
 * Reading note (§7.4): the spec's high-tier narrative shows in-person visits at week 1 / month 1 / month 3
 * and omits the 9-month contact. That narrative describes a TENANT-TIGHTENED schedule (Engrace converts
 * phone contacts to in-person, which is a permitted upward substitution); the binding floor is D4's
 * cumulative set, which keeps the moderate-tier 9-month contact at high and complicated. Where the two
 * readings differ, D4 — the locked decision — wins, and a tenant is free to reproduce §7.4 exactly on top
 * of it. The month-13 closeout contact §7.4 also lists is NOT a tier item: the auto-close worker creates it
 * (§7.11), so it is exported separately as {@link CLOSEOUT_CADENCE_ITEM}.
 */
export const BEREAVEMENT_CADENCE_FLOOR: {
  readonly [K in BereavementRiskTier]: readonly BereavementCadenceItem[];
} = {
  low: LOW_TIER_ITEMS,
  moderate: MODERATE_TIER_ITEMS,
  high: HIGH_TIER_ITEMS,
  complicated: COMPLICATED_TIER_ITEMS,
} as const;

/** §7.11 — the closeout contact the 13-month auto-close worker materializes. Day 396 is the window's
 *  exclusive end, which is exactly the day the worker fires. */
export const CLOSEOUT_CADENCE_ITEM: BereavementCadenceItem = {
  mark: "closeout",
  offsetDays: BEREAVEMENT_WINDOW_DAYS,
  kind: "phone_call",
  anniversaryMark: null,
};

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
