// apps/backend/src/modules/16-bereavement/lifecycle/schedule.ts — M16-T03 (§2.2, §2.5, D4).
//
// `generateOutreachSchedule` (§4.3): turn the D4 death-anchored cadence FLOOR — merged with whatever the
// tenant tightened — into the concrete `bereavement_outreach` rows the plan opens with. The floor itself,
// the tenant-tighten validator and the modality ladder are pure policy in `@wardenx/bereavement`; this
// module is the materialization: floor item + `death_date` → `due_at`, `late_grace_until`, the anniversary
// mark, and the per-contact modality the survivor's stated preferences resolve to.
//
// Three rules the generator will not break, each of which is a way an EHR quietly loses a regulatory
// obligation:
//
//   1. A floor contact is NEVER dropped. A survivor preference that excludes the floor modality re-MODALIZES
//      the touchpoint (see {@link resolveOutreachKind}); it does not delete it. The CoP 418.64(d) obligation
//      is to make bereavement contact, not to make it by telephone.
//   2. A regeneration (resume, opt-out rescind) materializes only FORWARD items. A touchpoint whose due
//      date passed during the pause is gone — re-creating it would manufacture a backdated obligation the
//      agency could never have met, and would then report it as missed.
//   3. Nothing is generated past the §2.5 `due_at` ceiling (window + 30-day grace). The DB CHECK enforces
//      the same bound against the denormalized `death_anchor_at`; generating past it would fail the INSERT
//      at the very end of a long transaction instead of here.
import {
  type BereavementCadenceItem,
  type BereavementCadenceMark,
  BEREAVEMENT_WINDOW_DAYS,
  OUTREACH_LATE_ATTEMPT_GRACE_DAYS,
  OUTREACH_MODALITY_RANK,
  effectiveCadence,
  isOutreachDueAtWithinCeiling,
  validateTenantCadence,
} from "@wardenx/bereavement";
import type {
  BereavementAnniversaryMark,
  BereavementOutreachKind,
  BereavementRiskTier,
  IsoInstant,
} from "@wardenx/types";
import { require_ } from "./errors";

const MS_PER_DAY = 86_400_000;

/** UTC midnight of a `YYYY-MM-DD` death date — the anchor every offset counts from (D4). */
function deathAnchorMs(deathDate: string): number {
  const ms = Date.parse(`${deathDate}T00:00:00.000Z`);
  if (Number.isNaN(ms)) {
    throw new RangeError(`bereavement: malformed death date '${deathDate}'`);
  }
  return ms;
}

/** One materialized `bereavement_outreach` row, before the org/plan/contact columns are stamped on. */
export interface PlannedOutreach {
  readonly mark: BereavementCadenceMark;
  readonly kind: BereavementOutreachKind;
  readonly anniversaryMark: BereavementAnniversaryMark | null;
  readonly dueAt: IsoInstant;
  readonly lateGraceUntil: IsoInstant;
  /** The denormalized §3.3.4 CHECK anchor (`death_anchor_at`) — copied onto the row, never re-derived. */
  readonly deathAnchorAt: IsoInstant;
  /** True when the survivor's stated preferences moved this contact off its floor modality (rule 1). */
  readonly preferenceSubstituted: boolean;
}

/** What the generator needs to know about the one survivor it is scheduling for. */
export interface OutreachScheduleContact {
  /** The D3/D8 tier driving which cadence applies. */
  readonly riskTier: BereavementRiskTier;
  /**
   * `bereaved_contact.outreach_preferences_jsonb.allowed_kinds` (§2.5). EMPTY / undefined means "no stated
   * preference" — the floor modality is used as-is. It does NOT mean "nothing is allowed": reading an
   * unstated preference as a total refusal would silently strip a survivor's whole program.
   */
  readonly allowedKinds?: ReadonlyArray<BereavementOutreachKind>;
}

/**
 * Resolve the modality for one floor item against a survivor's stated preferences (§2.5).
 *
 * The D4 "tenant may only substitute UPWARD" rule governs tenant POLICY, not a family's wishes: a survivor
 * who asked for letters only must not be visited in person because in-person outranks mail. So the
 * resolution prefers the closest allowed kind at-or-above the floor rank, and falls back to the
 * highest-ranked allowed kind when every permitted modality is lower-touch. Only when the family stated no
 * preference at all does the floor modality ride through unchanged.
 */
export function resolveOutreachKind(
  floorKind: BereavementOutreachKind,
  allowedKinds: ReadonlyArray<BereavementOutreachKind> | undefined,
): { readonly kind: BereavementOutreachKind; readonly substituted: boolean } {
  if (!allowedKinds || allowedKinds.length === 0) return { kind: floorKind, substituted: false };
  if (allowedKinds.includes(floorKind)) return { kind: floorKind, substituted: false };

  const floorRank = OUTREACH_MODALITY_RANK[floorKind];
  const ranked = [...allowedKinds].sort(
    (a, b) => OUTREACH_MODALITY_RANK[a] - OUTREACH_MODALITY_RANK[b],
  );
  const atOrAbove = ranked.find((k) => OUTREACH_MODALITY_RANK[k] >= floorRank);
  const chosen = atOrAbove ?? ranked[ranked.length - 1];
  return { kind: chosen as BereavementOutreachKind, substituted: true };
}

/** Materialize one cadence item against a death anchor. */
function materialize(
  item: BereavementCadenceItem,
  deathDate: string,
  contact: OutreachScheduleContact,
): PlannedOutreach {
  const anchorMs = deathAnchorMs(deathDate);
  const dueAtMs = anchorMs + item.offsetDays * MS_PER_DAY;
  const resolved = resolveOutreachKind(item.kind, contact.allowedKinds);
  return {
    mark: item.mark,
    kind: resolved.kind,
    anniversaryMark: item.anniversaryMark,
    dueAt: new Date(dueAtMs).toISOString(),
    lateGraceUntil: new Date(
      dueAtMs + OUTREACH_LATE_ATTEMPT_GRACE_DAYS * MS_PER_DAY,
    ).toISOString(),
    deathAnchorAt: new Date(anchorMs).toISOString(),
    preferenceSubstituted: resolved.substituted,
  };
}

/** Options for {@link generateOutreachSchedule}. */
export interface GenerateScheduleOptions {
  /**
   * Only materialize items due at or after this instant (a resume / rescind regeneration). Omit for the
   * initial `seedRosterAndSchedule`, which materializes the whole 13-month book from the death date.
   */
  readonly fromIso?: IsoInstant;
  /** The tenant's tightened cadence for this tier; omitted / empty falls back to the D4 platform floor. */
  readonly tenantItems?: ReadonlyArray<BereavementCadenceItem>;
}

/**
 * §4.3 `generateOutreachSchedule` — the D4 platform floor merged with the tenant tighten, materialized for
 * one bereaved contact. A tenant cadence that LOOSENS the floor is refused (422
 * `TENANT_CADENCE_LOOSENS_FLOOR`) rather than silently repaired: a policy editor that quietly re-adds the
 * contact the tenant deleted teaches the tenant that the floor is negotiable.
 */
export function generateOutreachSchedule(
  deathDate: string,
  contact: OutreachScheduleContact,
  options: GenerateScheduleOptions = {},
): ReadonlyArray<PlannedOutreach> {
  if (options.tenantItems && options.tenantItems.length > 0) {
    const violations = validateTenantCadence(contact.riskTier, options.tenantItems);
    require_(
      violations.length === 0,
      "TENANT_CADENCE_LOOSENS_FLOOR",
      `the tenant cadence loosens the ${contact.riskTier}-tier platform floor: ${violations
        .map((v) => `${v.mark}:${v.code}`)
        .join(", ")}`,
    );
  }

  const items = effectiveCadence(contact.riskTier, options.tenantItems);
  const fromMs = options.fromIso === undefined ? Number.NEGATIVE_INFINITY : Date.parse(options.fromIso);

  return items
    .map((item) => materialize(item, deathDate, contact))
    // Rule 3 — never generate past the §2.5 ceiling the DB CHECK enforces.
    .filter((row) => isOutreachDueAtWithinCeiling(deathDate, row.dueAt))
    // Rule 2 — a regeneration is forward-only.
    .filter((row) => Date.parse(row.dueAt) >= fromMs);
}

/**
 * The `bereavement_anniversary_reminder` marks a plan seeds at open (§2.2 `seedRosterAndSchedule`). Derived
 * from the tier's cadence rather than hard-coded, so an elevated-risk plan gets the
 * `nine_month_high_risk_only` row and a low-risk plan does not — a hard-coded list would seed a reminder
 * for a touchpoint the cadence never scheduled, and the §4.9 lookahead cron would alert on a phantom.
 */
export function anniversaryMarksForTier(
  tier: BereavementRiskTier,
  tenantItems?: ReadonlyArray<BereavementCadenceItem>,
): ReadonlyArray<BereavementAnniversaryMark> {
  const marks = new Set<BereavementAnniversaryMark>();
  for (const item of effectiveCadence(tier, tenantItems)) {
    if (item.anniversaryMark !== null) marks.add(item.anniversaryMark);
  }
  return [...marks];
}

/** D4 — the plan's `archives_at` (`death_date + 396 days`), which M36 pre-computes its channel archive on
 *  and `m16.bereavement.plan_opened` carries. */
export function planArchivesAt(deathDate: string): IsoInstant {
  return new Date(deathAnchorMs(deathDate) + BEREAVEMENT_WINDOW_DAYS * MS_PER_DAY).toISOString();
}
