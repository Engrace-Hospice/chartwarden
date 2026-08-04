import type { OrderKind } from "@wardenx/types";
// @wardenx/orders — §2.4 D5 standing-order template + spawn engine — M11-T04.
import { describe, expect, it } from "vitest";
import type { OrderSideEffect } from "../src/lifecycle/effects";
import {
  DEFAULT_SPAWN_HOUR,
  type StandingOrderSpawnFacts,
  assertSpawnAllowed,
  assertStandingKindEligible,
  computeNextSpawnAt,
  isSpawnDue,
  planStandingCreation,
  planStandingDiscontinuation,
  planStandingSpawn,
} from "../src/lifecycle/standing-order";

const TZ = "America/Los_Angeles";
function outboxEvents(effects: ReadonlyArray<OrderSideEffect>): string[] {
  return effects
    .filter((e): e is Extract<OrderSideEffect, { kind: "outbox" }> => e.kind === "outbox")
    .map((e) => e.event);
}

describe("§2.4 D5 assertStandingKindEligible", () => {
  it("accepts only lab / supply / ancillary_service", () => {
    for (const kind of ["lab", "supply", "ancillary_service"] as const) {
      expect(() => assertStandingKindEligible(kind)).not.toThrow();
    }
  });

  it("rejects dme / comfort_kit / loc-change / recert / idg", () => {
    for (const kind of [
      "dme",
      "comfort_kit",
      "level_of_care_change",
      "recertification",
      "idg_requested",
    ] as OrderKind[]) {
      expect(() => assertStandingKindEligible(kind)).toThrowError(
        expect.objectContaining({ code: "STANDING_KIND_NOT_ELIGIBLE" }),
      );
    }
  });
});

describe("§2.4 D5 computeNextSpawnAt", () => {
  // 2026-06-22 is a Monday; 08:00 PDT = 15:00Z.
  const monday0800 = "2026-06-22T15:00:00.000Z";

  it("daily → next calendar day at the org-local spawn hour (06:00)", () => {
    expect(computeNextSpawnAt("daily", {}, monday0800, TZ)).toBe("2026-06-23T13:00:00.000Z");
  });

  it("weekly → next configured weekday (a week out from a same-day anchor)", () => {
    expect(computeNextSpawnAt("weekly", { daysOfWeek: ["mon"] }, monday0800, TZ)).toBe(
      "2026-06-29T13:00:00.000Z",
    );
  });

  it("biweekly → the configured weekday a fortnight out", () => {
    expect(computeNextSpawnAt("biweekly", { daysOfWeek: ["mon"] }, monday0800, TZ)).toBe(
      "2026-07-06T13:00:00.000Z",
    );
  });

  it("weekly with no daysOfWeek defaults to the anchor's weekday", () => {
    expect(computeNextSpawnAt("weekly", {}, monday0800, TZ)).toBe("2026-06-29T13:00:00.000Z");
  });

  it("monthly → same day-of-month next month", () => {
    expect(computeNextSpawnAt("monthly", {}, monday0800, TZ)).toBe("2026-07-22T13:00:00.000Z");
  });

  it("monthly clamps an out-of-range day to the target month's last day (Jan 31 → Feb 28)", () => {
    // 2026-01-31 12:00 PST = 20:00Z. Feb 2026 has 28 days; 06:00 PST = 14:00Z (winter offset).
    expect(computeNextSpawnAt("monthly", { dayOfMonth: 31 }, "2026-01-31T20:00:00.000Z", TZ)).toBe(
      "2026-02-28T14:00:00.000Z",
    );
  });

  it("prn never auto-spawns (returns null)", () => {
    expect(computeNextSpawnAt("prn", {}, monday0800, TZ)).toBeNull();
  });

  it("honours a tenant spawnHour override", () => {
    expect(computeNextSpawnAt("daily", { spawnHour: 9 }, monday0800, TZ)).toBe(
      "2026-06-23T16:00:00.000Z",
    );
    expect(DEFAULT_SPAWN_HOUR).toBe(6);
  });
});

describe("§2.4 D5 spawn gate (isSpawnDue / assertSpawnAllowed)", () => {
  const now = "2026-06-22T15:00:00.000Z";
  const base: StandingOrderSpawnFacts = {
    status: "active",
    isSigned: true,
    effectiveFrom: "2026-06-01T00:00:00.000Z",
    effectiveUntil: "2026-12-31T00:00:00.000Z",
    maxSpawns: 10,
    spawnCount: 3,
  };

  it("is due when active, signed, in-window, and under the cap", () => {
    expect(isSpawnDue(base, now)).toBe(true);
    expect(() => assertSpawnAllowed(base, now)).not.toThrow();
  });

  it("is not due / throws when the template is not active", () => {
    const paused = { ...base, status: "paused" as const };
    expect(isSpawnDue(paused, now)).toBe(false);
    expect(() => assertSpawnAllowed(paused, now)).toThrowError(
      expect.objectContaining({ code: "STANDING_ORDER_NOT_ACTIVE" }),
    );
  });

  it("is not due / throws when the template is unsigned (no signature anchor)", () => {
    const unsigned = { ...base, isSigned: false };
    expect(isSpawnDue(unsigned, now)).toBe(false);
    expect(() => assertSpawnAllowed(unsigned, now)).toThrowError(
      expect.objectContaining({ code: "STANDING_ORDER_NOT_SIGNED" }),
    );
  });

  it("is not due / throws outside the effective window", () => {
    const early = { ...base, effectiveFrom: "2026-07-01T00:00:00.000Z" };
    expect(isSpawnDue(early, now)).toBe(false);
    expect(() => assertSpawnAllowed(early, now)).toThrowError(
      expect.objectContaining({ code: "STANDING_OUTSIDE_EFFECTIVE_WINDOW" }),
    );
  });

  it("is not due / throws when the max_spawns cap is reached", () => {
    const capped = { ...base, maxSpawns: 3, spawnCount: 3 };
    expect(isSpawnDue(capped, now)).toBe(false);
    expect(() => assertSpawnAllowed(capped, now)).toThrowError(
      expect.objectContaining({ code: "STANDING_MAX_SPAWNS_REACHED" }),
    );
  });

  it("treats a null max_spawns as uncapped", () => {
    expect(isSpawnDue({ ...base, maxSpawns: null, spawnCount: 9_999 }, now)).toBe(true);
  });
});

describe("§2.4 / §5.5 planStandingCreation", () => {
  it("audits + emits standing_created for an eligible kind signed by an eligible discipline", () => {
    const effects = planStandingCreation({ kind: "lab", signerDiscipline: "medical_director" });
    expect(outboxEvents(effects)).toEqual(["m11.order.standing_created"]);
    expect(effects).toContainEqual({ kind: "audit" });
  });

  it("rejects an ineligible standing kind", () => {
    expect(() =>
      planStandingCreation({ kind: "dme", signerDiscipline: "medical_director" }),
    ).toThrowError(expect.objectContaining({ code: "STANDING_KIND_NOT_ELIGIBLE" }));
  });

  it("rejects a signer not eligible for the kind", () => {
    expect(() => planStandingCreation({ kind: "lab", signerDiscipline: "msw" })).toThrowError(
      expect.objectContaining({ code: "SIGNER_NOT_ELIGIBLE" }),
    );
  });
});

describe("§2.4 D5 / W-SO-01 / W-SO-02 planStandingSpawn", () => {
  const now = "2026-06-22T15:00:00.000Z";

  it("scheduled spawn is born active, emits spawned→signed→downstream, advances next_spawn_at", () => {
    const plan = planStandingSpawn({
      kind: "lab",
      cadence: "weekly",
      cadenceDetail: { daysOfWeek: ["mon"] },
      spawnedBy: "system",
      now,
      timeZone: TZ,
    });
    expect(plan.spawnedOrderStatus).toBe("active");
    expect(plan.events).toEqual([
      "m11.order.standing_spawned",
      "m11.order.signed",
      "m11.order.hl7_orm_requested", // the lab kind's downstream signed event (§4.4)
    ]);
    expect(plan.nextSpawnAt).toBe("2026-06-29T13:00:00.000Z");
  });

  it("PRN spawn does not move the schedule (next_spawn_at stays null)", () => {
    const plan = planStandingSpawn({
      kind: "supply",
      cadence: "prn",
      cadenceDetail: {},
      spawnedBy: "clinician_request",
      now,
      timeZone: TZ,
    });
    expect(plan.spawnedBy).toBe("clinician_request");
    expect(plan.nextSpawnAt).toBeNull();
    expect(plan.events).toEqual([
      "m11.order.standing_spawned",
      "m11.order.signed",
      "m11.order.supply_fulfillment_requested",
    ]);
  });

  it("rejects spawning an ineligible kind", () => {
    expect(() =>
      planStandingSpawn({
        kind: "recertification",
        cadence: "weekly",
        cadenceDetail: {},
        spawnedBy: "system",
        now,
        timeZone: TZ,
      }),
    ).toThrowError(expect.objectContaining({ code: "STANDING_KIND_NOT_ELIGIBLE" }));
  });
});

describe("§2.4 planStandingDiscontinuation", () => {
  it("stops the template and carries the also-discontinue-instances election", () => {
    const a = planStandingDiscontinuation(false);
    expect(outboxEvents(a.effects)).toEqual(["m11.order.standing_discontinued"]);
    expect(a.alsoDiscontinueInstances).toBe(false);
    expect(planStandingDiscontinuation(true).alsoDiscontinueInstances).toBe(true);
  });
});
