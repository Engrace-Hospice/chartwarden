// apps/backend/__tests__/encounter-late-entry.test.ts — M8-T07 (§2.5 D4, §7.5, §7.6).
//
// The pure §2.5 late-entry domain: the three-tier clock (computed at finalize-time off service_date) and
// the two override workflows + sign-gate guard. No DB — the org-local finalize day, the caller's role and
// step-up freshness are injected. Walks the §7.5 (significant 3–14d Clinical Supervisor override) and
// §7.6 (administrative >14d Director override) acceptance scenarios end-to-end over the pure functions.
import { describe, expect, it } from "vitest";
import {
  LATE_ENTRY_TIER_DAY_CEILINGS,
  checkLateEntryOverrideSatisfied,
  computeLateEntryTier,
  daysLate,
  decideAdministrativeLateOverride,
  decideSignificantLateOverride,
  lateEntryBanner,
  requiresLateEntryOverride,
} from "../src/modules/08-encounters/late-entry/index";
import { EncounterStateError } from "../src/modules/08-encounters/lifecycle/index";

/** Pull the outbox event names off a side-effect list (test helper). */
function outboxEvents(effects: ReadonlyArray<{ kind: string }>): string[] {
  return effects
    .filter((e): e is { kind: "outbox"; event: string } => e.kind === "outbox")
    .map((e) => e.event);
}

/** Pull the set-field column names off a side-effect list (test helper). */
function setFields(effects: ReadonlyArray<{ kind: string }>): string[] {
  return effects
    .filter((e): e is { kind: "set_field"; field: string } => e.kind === "set_field")
    .map((e) => e.field);
}

/** Assert that `fn` throws an EncounterStateError with the given §2.5/§2.7 code. */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`expected EncounterStateError(${code}) but nothing threw`);
  } catch (err) {
    expect(err).toBeInstanceOf(EncounterStateError);
    expect((err as EncounterStateError).code).toBe(code);
  }
}

const SERVICE = "2026-06-01"; // the day the visit occurred

/** finalize day = SERVICE + n calendar days. */
function plusDays(n: number): string {
  return new Date(Date.parse(`${SERVICE}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

describe("M8-T07 §2.5 late-entry tier clock", () => {
  it("bins each tier at the §2.5 day-ceilings (24h / 72h / 14d)", () => {
    // ≤ 24h → normal (same day + next day).
    expect(computeLateEntryTier({ serviceDate: SERVICE, asOfDate: plusDays(0) })).toBe("normal");
    expect(computeLateEntryTier({ serviceDate: SERVICE, asOfDate: plusDays(1) })).toBe("normal");
    // 24h–72h → late_entry (days 2–3).
    expect(computeLateEntryTier({ serviceDate: SERVICE, asOfDate: plusDays(2) })).toBe("late_entry");
    expect(computeLateEntryTier({ serviceDate: SERVICE, asOfDate: plusDays(3) })).toBe("late_entry");
    // 72h–14d → significant_late_entry (days 4–14).
    expect(computeLateEntryTier({ serviceDate: SERVICE, asOfDate: plusDays(4) })).toBe(
      "significant_late_entry",
    );
    expect(computeLateEntryTier({ serviceDate: SERVICE, asOfDate: plusDays(14) })).toBe(
      "significant_late_entry",
    );
    // > 14d → administrative_override (day 15+).
    expect(computeLateEntryTier({ serviceDate: SERVICE, asOfDate: plusDays(15) })).toBe(
      "administrative_override",
    );
    expect(computeLateEntryTier({ serviceDate: SERVICE, asOfDate: plusDays(40) })).toBe(
      "administrative_override",
    );
  });

  it("exposes the §2.5 ceilings as data and counts days late off service_date", () => {
    expect(LATE_ENTRY_TIER_DAY_CEILINGS).toEqual({
      normal: 1,
      late_entry: 3,
      significant_late_entry: 14,
    });
    expect(daysLate(SERVICE, plusDays(5))).toBe(5);
  });

  it("renders the §2.5 banner only for the two override tiers", () => {
    expect(lateEntryBanner("normal", 1)).toBeNull();
    expect(lateEntryBanner("late_entry", 3)).toBeNull();
    expect(lateEntryBanner("significant_late_entry", 5)).toBe(
      "Late entry — documented 5 days after service",
    );
    expect(lateEntryBanner("administrative_override", 22)).toBe(
      "Administrative late entry — 22 days after service",
    );
  });

  it("marks which tiers require an override before sign", () => {
    expect(requiresLateEntryOverride("normal")).toBe(false);
    expect(requiresLateEntryOverride("late_entry")).toBe(false);
    expect(requiresLateEntryOverride("significant_late_entry")).toBe(true);
    expect(requiresLateEntryOverride("administrative_override")).toBe(true);
  });
});

describe("M8-T07 §2.3 sign gate (check 5) — late-entry override required", () => {
  it("passes for normal / late_entry tiers regardless of override presence", () => {
    expect(() =>
      checkLateEntryOverrideSatisfied({
        tier: "normal",
        significantOverridePresent: false,
        administrativeOverridePresent: false,
      }),
    ).not.toThrow();
    expect(() =>
      checkLateEntryOverrideSatisfied({
        tier: "late_entry",
        significantOverridePresent: false,
        administrativeOverridePresent: false,
      }),
    ).not.toThrow();
  });

  it("refuses a significant late entry without a supervisor override", () => {
    expectCode(
      () =>
        checkLateEntryOverrideSatisfied({
          tier: "significant_late_entry",
          significantOverridePresent: false,
          administrativeOverridePresent: false,
        }),
      "SIGNIFICANT_LATE_ENTRY_OVERRIDE_REQUIRED",
    );
  });

  it("refuses an administrative late entry without a director override", () => {
    expectCode(
      () =>
        checkLateEntryOverrideSatisfied({
          tier: "administrative_override",
          significantOverridePresent: false,
          administrativeOverridePresent: false,
        }),
      "ADMINISTRATIVE_LATE_OVERRIDE_REQUIRED",
    );
  });

  it("passes once the matching override is recorded", () => {
    expect(() =>
      checkLateEntryOverrideSatisfied({
        tier: "significant_late_entry",
        significantOverridePresent: true,
        administrativeOverridePresent: false,
      }),
    ).not.toThrow();
    expect(() =>
      checkLateEntryOverrideSatisfied({
        tier: "administrative_override",
        significantOverridePresent: false,
        administrativeOverridePresent: true,
      }),
    ).not.toThrow();
  });
});

describe("M8-T07 §7.5 — significant late entry (3–14 days)", () => {
  it("RN at T+5 days: tier is significant and the sign gate refuses", () => {
    const tier = computeLateEntryTier({ serviceDate: SERVICE, asOfDate: plusDays(5) });
    expect(tier).toBe("significant_late_entry");
    expectCode(
      () =>
        checkLateEntryOverrideSatisfied({
          tier,
          significantOverridePresent: false,
          administrativeOverridePresent: false,
        }),
      "SIGNIFICANT_LATE_ENTRY_OVERRIDE_REQUIRED",
    );
  });

  it("Clinical Supervisor override (reason ≥ 40 + step-up) reifies the row and publishes warn outbox", () => {
    const effects = decideSignificantLateOverride({
      tier: "significant_late_entry",
      isSupervisor: true,
      reason: "Visit notes were captured on paper at the bedside; transcribed once back in network range.",
      stepUpFresh: true,
    });
    expect(setFields(effects)).toEqual([
      "significant_late_override_by",
      "significant_late_override_reason",
    ]);
    expect(outboxEvents(effects)).toEqual(["m8.encounter.late_entry_override"]);
    expect(effects.some((e) => e.kind === "audit")).toBe(true);
    // After the override is recorded, the §2.3 gate passes.
    expect(() =>
      checkLateEntryOverrideSatisfied({
        tier: "significant_late_entry",
        significantOverridePresent: true,
        administrativeOverridePresent: false,
      }),
    ).not.toThrow();
  });

  it("rejects a non-supervisor, a short reason, a stale step-up, and a tier mismatch", () => {
    const ok = {
      tier: "significant_late_entry" as const,
      isSupervisor: true,
      reason: "Documented late after returning from an out-of-network rural visit; transcribed promptly.",
      stepUpFresh: true,
    };
    expectCode(
      () => decideSignificantLateOverride({ ...ok, isSupervisor: false }),
      "SIGNIFICANT_LATE_OVERRIDE_NOT_PERMITTED",
    );
    expectCode(
      () => decideSignificantLateOverride({ ...ok, reason: "too short" }),
      "SIGNIFICANT_LATE_OVERRIDE_REASON_TOO_SHORT",
    );
    expectCode(
      () => decideSignificantLateOverride({ ...ok, stepUpFresh: false }),
      "STEP_UP_AUTH_REQUIRED",
    );
    expectCode(
      () => decideSignificantLateOverride({ ...ok, tier: "administrative_override" }),
      "LATE_ENTRY_TIER_MISMATCH",
    );
  });
});

describe("M8-T07 §7.6 — administrative override (>14 days)", () => {
  it("RN at T+22 days: tier is administrative and the sign gate refuses", () => {
    const tier = computeLateEntryTier({ serviceDate: SERVICE, asOfDate: plusDays(22) });
    expect(tier).toBe("administrative_override");
    expect(lateEntryBanner(tier, daysLate(SERVICE, plusDays(22)))).toBe(
      "Administrative late entry — 22 days after service",
    );
    expectCode(
      () =>
        checkLateEntryOverrideSatisfied({
          tier,
          significantOverridePresent: false,
          administrativeOverridePresent: false,
        }),
      "ADMINISTRATIVE_LATE_OVERRIDE_REQUIRED",
    );
  });

  it("Director override (reason ≥ 100 + step-up) reifies the row and publishes critical compliance outbox", () => {
    const effects = decideAdministrativeLateOverride({
      tier: "administrative_override",
      isDirector: true,
      reason:
        "Encounter surfaced during a chart audit twenty-two days after the visit; the DON authorizes a " +
        "late administrative entry to complete the clinical record per agency policy and CoP 418.104.",
      stepUpFresh: true,
    });
    expect(setFields(effects)).toEqual([
      "administrative_override_by",
      "administrative_override_reason",
    ]);
    expect(outboxEvents(effects)).toEqual(["m8.encounter.administrative_override"]);
    expect(effects.some((e) => e.kind === "audit")).toBe(true);
    expect(() =>
      checkLateEntryOverrideSatisfied({
        tier: "administrative_override",
        significantOverridePresent: false,
        administrativeOverridePresent: true,
      }),
    ).not.toThrow();
  });

  it("rejects a non-director, a < 100-char reason, a stale step-up, and a tier mismatch", () => {
    const ok = {
      tier: "administrative_override" as const,
      isDirector: true,
      reason:
        "Director-authorized administrative late entry to complete the official clinical record after a " +
        "delayed discovery during routine compliance review; documented per agency policy and CoP rules.",
      stepUpFresh: true,
    };
    expectCode(
      () => decideAdministrativeLateOverride({ ...ok, isDirector: false }),
      "ADMINISTRATIVE_OVERRIDE_NOT_PERMITTED",
    );
    expectCode(
      () => decideAdministrativeLateOverride({ ...ok, reason: "only forty-ish characters, well under one hundred." }),
      "ADMINISTRATIVE_OVERRIDE_REASON_TOO_SHORT",
    );
    expectCode(
      () => decideAdministrativeLateOverride({ ...ok, stepUpFresh: false }),
      "STEP_UP_AUTH_REQUIRED",
    );
    expectCode(
      () => decideAdministrativeLateOverride({ ...ok, tier: "significant_late_entry" }),
      "LATE_ENTRY_TIER_MISMATCH",
    );
  });
});
