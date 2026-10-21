// @wardenx/messaging — the tighten-only floor of a `system_locked` platform alert rule (GAP-102).
//
// M36 spec §7.4 (line 401): a `system_locked` rule cannot be disabled or have its
// `recipient_resolver` changed; §1 (line 75) / D11: a tenant may TIGHTEN routing but never LOOSEN it
// (suppress channels, remove recipients, downgrade severity). So against a locked platform rule a
// tenant override may only (a) raise `severity_floor` on the info < warn < critical ladder, and
// (b) ADD channels to `channels_override`. `recipient_resolver`, `enabled = true` and the lock itself
// are immutable. Pure (no DB) so the in-memory service, the Drizzle service and the Drizzle emitter
// share one definition; migration 0334 enforces the same rule in a DB trigger.
import { ChartWardenError } from "@wardenx/types";
import type { AlertSeverity } from "../interfaces/kinds";
import { PLATFORM_DEFAULT_ALERT_RULES, SYSTEM_LOCKED_EVENT_TYPES } from "./alert-rules";

/** The legacy `alert_severity` ladder, lowest first (enum definition order, §3.2). */
export const ALERT_SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = {
  info: 0,
  warn: 1,
  critical: 2,
};

/** The fields of a tenant patch the floor judges. */
export interface LockedRulePatch {
  readonly enabled?: boolean;
  readonly severityFloor?: AlertSeverity;
  readonly recipientResolver?: string;
}

/**
 * Throw if `patch` would weaken the system_locked platform rule for `eventType`; a no-op for a
 * non-locked event type. Disabling stays 403 SYSTEM_LOCKED (§4.2); the new refusals are 422.
 */
export function assertLockedRulePatchAllowed(eventType: string, patch: LockedRulePatch): void {
  if (!isSystemLockedEventType(eventType)) return;
  const floor = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === eventType);
  if (!floor) return;
  if (patch.enabled === false) {
    throw new ChartWardenError("SYSTEM_LOCKED", "system_locked rules cannot be disabled", 403);
  }
  if (
    patch.recipientResolver !== undefined &&
    patch.recipientResolver !== floor.recipientResolver
  ) {
    throw new ChartWardenError(
      "LOCKED_RULE_RESOLVER_IMMUTABLE",
      `system_locked rule '${eventType}' cannot have its recipient resolver changed`,
      422,
    );
  }
  if (
    patch.severityFloor !== undefined &&
    ALERT_SEVERITY_RANK[patch.severityFloor] < ALERT_SEVERITY_RANK[floor.severityFloor]
  ) {
    throw new ChartWardenError(
      "LOCKED_RULE_SEVERITY_DOWNGRADE",
      `system_locked rule '${eventType}' cannot be downgraded below '${floor.severityFloor}'`,
      422,
    );
  }
}

/** The shape {@link selectEffectiveAlertRules} reads off a rule row. */
export interface EffectiveRuleRow {
  readonly organizationId: string | null;
  readonly severityFloor: AlertSeverity;
  readonly recipientResolver: string;
  /** jsonb `resolver_args` — part of WHO is notified, so it is immutable against a locked rule. */
  readonly resolverArgs: unknown;
  readonly channelsOverride: readonly string[] | null;
  readonly systemLocked: boolean;
}

/** Structural (key-order independent) equality of two jsonb values. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.hasOwn(b, k) &&
      jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** True when `eventType` has a `system_locked` platform default (judged against the platform seed). */
export function isSystemLockedEventType(eventType: string): boolean {
  return (SYSTEM_LOCKED_EVENT_TYPES as readonly string[]).includes(eventType);
}

function tightensLockedFloor(org: EffectiveRuleRow, floor: EffectiveRuleRow): boolean {
  if (org.recipientResolver !== floor.recipientResolver) return false;
  if (!jsonEqual(org.resolverArgs, floor.resolverArgs)) return false;
  if (ALERT_SEVERITY_RANK[org.severityFloor] < ALERT_SEVERITY_RANK[floor.severityFloor])
    return false;
  if (floor.channelsOverride === null) return true;
  const have = new Set(org.channelsOverride ?? []);
  return org.channelsOverride !== null && floor.channelsOverride.every((c) => have.has(c));
}

/**
 * The rules that actually fire for one event type in `orgId`, from that event's platform + org rows.
 * A tenant's own rows replace the platform default (clone-on-first-edit) EXCEPT against a locked
 * platform rule: there an org row only counts if it tightens the floor (same resolver + resolver_args, severity not
 * lower, channels a superset); anything weaker is ignored, and with none left the platform rule fires.
 */
export function selectEffectiveAlertRules<R extends EffectiveRuleRow>(
  rows: readonly R[],
  orgId: string,
): R[] {
  const platformRows = rows.filter((r) => r.organizationId === null);
  const lockedFloor = platformRows.find((r) => r.systemLocked);
  let orgRows = rows.filter((r) => r.organizationId === orgId);
  if (lockedFloor) orgRows = orgRows.filter((r) => tightensLockedFloor(r, lockedFloor));
  return orgRows.length > 0 ? orgRows : platformRows;
}
