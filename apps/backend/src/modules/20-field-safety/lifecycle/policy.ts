// apps/backend/src/modules/20-field-safety/lifecycle/policy.ts — M20-T03 (§2.2.4, §4.3, D4).
//
// The effective-policy resolver every other decider in this directory reads its thresholds from. §2.2.4 is
// explicit that `safetyPolicyResolver.effectivePolicy(orgId, asOf)` is the ONLY read path and that consumers
// never touch `safety_policy_version` directly — because the version row is a SNAPSHOT: a 2031 review of a
// 2026 incident has to read the 2026 thresholds, and reading today's would turn a policy that tightened into
// a regression that never happened.
//
// THE FLOOR IS MERGED UNDER, NOT OVER (M20-F03). There is no org-NULL platform row — `SAFETY_POLICY_FLOOR`
// is a code constant (@chartwarden/types) that the migration seeds each tenant's first version from and that
// this resolver fills any absent knob with. "Absent" is not a state today (every §3.3 column is NOT NULL),
// and that is exactly why the merge is written defensively: the day a migration adds a knob, every version
// row written before it carries `undefined` for it, and a resolver that passed the undefined through would
// hand a `NaN` threshold to the SLA watchdog. Merging under makes that day a no-op.
//
// TIGHTEN-ONLY IS A BAND PER KNOB, NOT ONE COMPARISON (§2.2.4 / D4). "Tighter" runs in opposite directions:
// a SHORTER overdue threshold alerts the supervisor sooner (tighter), a SHORTER mid-visit cadence makes the
// clinician check in more often (also tighter), and a LONGER cancel window gives more chance to undo an
// accidental press (tighter again). So the editor validates membership in `SAFETY_POLICY_BOUNDS` per knob
// plus the ladder invariant, which is the same pair migration 0110's `m20_spv_*_band` / `m20_spv_overdue_
// ladder` CHECKs hold — restated here so the DON gets a 422 naming the knob rather than a driver-level
// constraint violation naming a constraint.
//
// AFTER-HOURS NEEDS A TIMEZONE THE POLICY ROW DOES NOT CARRY. `after_hours_start_hour` / `_end_hour` are
// bare integers with no zone column (§3.3), and the D14 after-hours decision — whether a 22:30 SOS unions
// M19's on-call roster into the recipient set — is wrong by up to eight hours if the hour is read off UTC.
// So {@link isAfterHours} takes the org's IANA zone as a REQUIRED argument. There is no default: a silent
// "UTC" would make a Pacific agency's night shift start at 10 a.m. and nothing would ever say so.
import type {
  IsoInstant,
  OrgId,
  SafetyIncidentCategory,
  SafetyPolicyEffectiveDto,
  SafetyPolicyVersionId,
  SafetySubscriptionModel,
} from "@chartwarden/types";
import { SAFETY_POLICY_BOUNDS, SAFETY_POLICY_FLOOR } from "@chartwarden/types";
import { requireSafety } from "./errors";

/** One `safety_policy_version` row as the resolver sees it. Every knob is OPTIONAL here and NOT NULL in the
 *  schema — see the header on why the merge is defensive. */
export interface SafetyPolicyVersionFacts {
  readonly versionId: SafetyPolicyVersionId;
  readonly effectiveFrom: IsoInstant;
  readonly effectiveTo: IsoInstant | null;
  readonly midVisitCadenceMinutes?: number;
  readonly midVisitMinVisitDurationMinutes?: number;
  readonly preVisitWindowMinutes?: number;
  readonly postVisitWindowMinutes?: number;
  readonly gentleReminderMinutes?: number;
  readonly supervisorAlertMinutes?: number;
  readonly escalationMinutes?: number;
  readonly sosEquivalentMinutes?: number;
  readonly sosCancelWindowSeconds?: number;
  readonly sosCancelRequiresBiometric?: boolean;
  readonly sosContinuousLocationEnabled?: boolean;
  readonly sosContinuousLocationSampleSeconds?: number;
  readonly sosContinuousLocationMaxDurationHours?: number;
  readonly sosTier1SlaSeconds?: number;
  readonly sosTier2SlaSeconds?: number;
  readonly sosTier3SlaSeconds?: number;
  readonly subscriptionModel?: SafetySubscriptionModel;
  readonly afterHoursStartHour?: number;
  readonly afterHoursEndHour?: number;
  readonly oshaReportableAutoFlagCategories?: readonly SafetyIncidentCategory[];
}

/** §2.2.4 — the tenant's version row with the platform floor merged UNDER it. */
export function mergeEffectivePolicy(
  orgId: OrgId,
  version: SafetyPolicyVersionFacts,
): SafetyPolicyEffectiveDto {
  const f = SAFETY_POLICY_FLOOR;
  return {
    organizationId: orgId,
    versionId: version.versionId,
    effectiveFrom: version.effectiveFrom,
    effectiveTo: version.effectiveTo,
    midVisitCadenceMinutes: version.midVisitCadenceMinutes ?? f.midVisitCadenceMinutes,
    midVisitMinVisitDurationMinutes:
      version.midVisitMinVisitDurationMinutes ?? f.midVisitMinVisitDurationMinutes,
    preVisitWindowMinutes: version.preVisitWindowMinutes ?? f.preVisitWindowMinutes,
    postVisitWindowMinutes: version.postVisitWindowMinutes ?? f.postVisitWindowMinutes,
    gentleReminderMinutes: version.gentleReminderMinutes ?? f.gentleReminderMinutes,
    supervisorAlertMinutes: version.supervisorAlertMinutes ?? f.supervisorAlertMinutes,
    escalationMinutes: version.escalationMinutes ?? f.escalationMinutes,
    sosEquivalentMinutes: version.sosEquivalentMinutes ?? f.sosEquivalentMinutes,
    sosCancelWindowSeconds: version.sosCancelWindowSeconds ?? f.sosCancelWindowSeconds,
    sosCancelRequiresBiometric: version.sosCancelRequiresBiometric ?? f.sosCancelRequiresBiometric,
    sosContinuousLocationEnabled:
      version.sosContinuousLocationEnabled ?? f.sosContinuousLocationEnabled,
    sosContinuousLocationSampleSeconds:
      version.sosContinuousLocationSampleSeconds ?? f.sosContinuousLocationSampleSeconds,
    sosContinuousLocationMaxDurationHours:
      version.sosContinuousLocationMaxDurationHours ?? f.sosContinuousLocationMaxDurationHours,
    sosTier1SlaSeconds: version.sosTier1SlaSeconds ?? f.sosTier1SlaSeconds,
    sosTier2SlaSeconds: version.sosTier2SlaSeconds ?? f.sosTier2SlaSeconds,
    sosTier3SlaSeconds: version.sosTier3SlaSeconds ?? f.sosTier3SlaSeconds,
    subscriptionModel:
      version.subscriptionModel ?? (f.subscriptionModel as SafetySubscriptionModel),
    afterHoursStartHour: version.afterHoursStartHour ?? f.afterHoursStartHour,
    afterHoursEndHour: version.afterHoursEndHour ?? f.afterHoursEndHour,
    oshaReportableAutoFlagCategories:
      version.oshaReportableAutoFlagCategories ?? f.oshaReportableAutoFlagCategories,
  };
}

/** §3.2 Phase E — the knob set a tenant's FIRST version row is seeded with (the floor verbatim). Exposed so
 *  the onboarding path and the tests seed from one place rather than restating twenty numbers. */
export function safetyPolicyFloorSeed(): Omit<
  SafetyPolicyEffectiveDto,
  "organizationId" | "versionId" | "effectiveFrom" | "effectiveTo"
> {
  const {
    organizationId: _o,
    versionId: _v,
    effectiveFrom: _f,
    effectiveTo: _t,
    ...knobs
  } = mergeEffectivePolicy("" as OrgId, {
    versionId: "" as SafetyPolicyVersionId,
    effectiveFrom: new Date(0).toISOString(),
    effectiveTo: null,
  });
  return knobs;
}

/** The knobs a tenant may edit — the bounded subset of {@link SafetyPolicyEffectiveDto}. */
export type SafetyPolicyPatch = Partial<
  Omit<SafetyPolicyEffectiveDto, "organizationId" | "versionId" | "effectiveFrom" | "effectiveTo">
>;

/** One knob that failed the D4 band check. */
export interface SafetyPolicyBoundViolation {
  readonly field: keyof typeof SAFETY_POLICY_BOUNDS;
  readonly value: number;
  readonly min: number;
  readonly max: number;
}

/** §2.2.4 / D4 — every bounded knob in `patch`, checked against its own band. Returned rather than thrown
 *  so the §5 policy editor can mark all the offending inputs at once instead of one per round trip. */
export function policyBoundViolations(
  patch: SafetyPolicyPatch,
): readonly SafetyPolicyBoundViolation[] {
  const violations: SafetyPolicyBoundViolation[] = [];
  for (const [field, band] of Object.entries(SAFETY_POLICY_BOUNDS) as [
    keyof typeof SAFETY_POLICY_BOUNDS,
    { readonly min: number; readonly max: number },
  ][]) {
    const value = (patch as Record<string, unknown>)[field];
    if (typeof value !== "number") continue;
    if (!Number.isFinite(value) || value < band.min || value > band.max) {
      violations.push({ field, value, min: band.min, max: band.max });
    }
  }
  return violations;
}

/**
 * §2.2.4 / D4 — the editor's gate. Validates the D4 band per knob AND the ladder invariant, against the
 * MERGED result (patch over the current effective policy), because a patch that moves only
 * `supervisor_alert_minutes` can still invert a ladder whose other three rungs it never mentions.
 *
 * `editReason` is required at ≥30 chars: a policy edit is the one act in this module that changes how long
 * a clinician in distress goes unwatched, and §8.8.2's compliance read is "why did they loosen it".
 */
export function assertPolicyEditValid(input: {
  readonly current: SafetyPolicyEffectiveDto;
  readonly patch: SafetyPolicyPatch;
  readonly editReason: string;
}): SafetyPolicyPatch {
  requireSafety(
    input.editReason.trim().length >= 30,
    "POLICY_EDIT_REASON_REQUIRED",
    "a policy edit records why the agency changed its own safety thresholds; 30 characters is the floor",
  );

  const merged = { ...input.current, ...input.patch };
  const violations = policyBoundViolations(merged);
  requireSafety(
    violations.length === 0,
    "POLICY_OUT_OF_BOUNDS",
    violations
      .map((v) => `${String(v.field)}=${v.value} is outside the platform band [${v.min}, ${v.max}]`)
      .join("; "),
  );

  requireSafety(
    merged.gentleReminderMinutes <= merged.supervisorAlertMinutes &&
      merged.supervisorAlertMinutes <= merged.escalationMinutes &&
      merged.escalationMinutes <= merged.sosEquivalentMinutes,
    "POLICY_LADDER_INVALID",
    "the four overdue thresholds are a ladder: gentle_reminder ≤ supervisor_alert ≤ escalation ≤ sos_equivalent",
  );
  requireSafety(
    merged.sosTier1SlaSeconds <= merged.sosTier2SlaSeconds &&
      merged.sosTier2SlaSeconds <= merged.sosTier3SlaSeconds,
    "POLICY_LADDER_INVALID",
    "the three SOS tier SLAs are a ladder: tier1 ≤ tier2 ≤ tier3",
  );

  return input.patch;
}

/** §8.8.2 — which knobs moved and in which direction, for the `m20.safety.policy_changed` payload.
 *  `loosen` should be unreachable while {@link assertPolicyEditValid} guards every write; if one ever
 *  appears in the ledger, the entry is itself the compliance flag. */
export function policyThresholdDiffs(
  current: SafetyPolicyEffectiveDto,
  patch: SafetyPolicyPatch,
): readonly { readonly field: string; readonly direction: "tighten" | "loosen" }[] {
  // Per-knob direction of "tighter" (§2.2.4): shorter overdue thresholds and shorter cadences are tighter;
  // a LONGER cancel window and a SHORTER stream duration are tighter. Anything not listed has no direction.
  const tighterWhenSmaller: readonly string[] = [
    "midVisitCadenceMinutes",
    "preVisitWindowMinutes",
    "postVisitWindowMinutes",
    "gentleReminderMinutes",
    "supervisorAlertMinutes",
    "escalationMinutes",
    "sosEquivalentMinutes",
    "sosContinuousLocationSampleSeconds",
    "sosContinuousLocationMaxDurationHours",
    "sosTier1SlaSeconds",
    "sosTier2SlaSeconds",
    "sosTier3SlaSeconds",
  ];
  const tighterWhenLarger: readonly string[] = ["sosCancelWindowSeconds"];

  const diffs: { field: string; direction: "tighten" | "loosen" }[] = [];
  for (const [field, next] of Object.entries(patch)) {
    const before = (current as unknown as Record<string, unknown>)[field];
    if (typeof next !== "number" || typeof before !== "number" || next === before) continue;
    if (tighterWhenSmaller.includes(field)) {
      diffs.push({ field, direction: next < before ? "tighten" : "loosen" });
    } else if (tighterWhenLarger.includes(field)) {
      diffs.push({ field, direction: next > before ? "tighten" : "loosen" });
    }
  }
  return diffs;
}

/** The org-local hour (0–23) an instant falls on, in `timeZone`. */
function orgLocalHour(instant: IsoInstant, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
  }).formatToParts(new Date(instant));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0");
}

/**
 * D14 / §7.5 — is `atIso` inside the tenant's after-hours window?
 *
 * The window WRAPS midnight in the ordinary configuration (18:00 → 08:00), so the test is a disjunction,
 * not a range. A naive `start <= h && h < end` would report that 22:30 on a Saturday is business hours and
 * the M19 on-call roster would never be unioned into the SOS recipient set — the exact D14 failure.
 *
 * `timeZone` is required; see the header.
 */
export function isAfterHours(
  policy: Pick<SafetyPolicyEffectiveDto, "afterHoursStartHour" | "afterHoursEndHour">,
  atIso: IsoInstant,
  timeZone: string,
): boolean {
  const hour = orgLocalHour(atIso, timeZone);
  const { afterHoursStartHour: start, afterHoursEndHour: end } = policy;
  // A degenerate window (start === end) means "always after hours" — a 24-hour on-call posture. It is a
  // legal configuration for a small agency and reading it as "never" would silence every night.
  if (start === end) return true;
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}
