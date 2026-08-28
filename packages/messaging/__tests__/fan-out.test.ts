// @wardenx/messaging — M36-T04 fan-out tests (spec §2.1, §2.4.4, §2.5, §2.6).
//
// The pure planner: in-app floor is unconditional, out-of-band is additive per preference (or
// the rule override), voice is SOS-only, quiet hours skip below the override floor, and vacation
// forwarding redirects out-of-band to the backup (single hop). Quiet-hours tests use tz `UTC`
// and an all-days window so the assertions turn only on the clock, never the calendar.
import { describe, expect, it } from "vitest";
import {
  type AlertContext,
  type FanOutInput,
  type PlannedDelivery,
  type RecipientPreferences,
  type RoutingMap,
  planFanOut,
} from "../src/index";

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function prefs(over: Partial<RecipientPreferences> & { userId: string }): RecipientPreferences {
  return {
    routingMap: {},
    quietHours: { tz: "UTC", ranges: [], severityOverride: "critical" },
    vacationForwardToUserId: null,
    vacationUntil: null,
    ...over,
  };
}

function input(over: Partial<FanOutInput> & { alert: AlertContext }): FanOutInput {
  return {
    channelsOverride: null,
    recipientUserIds: [],
    preferences: new Map(),
    at: new Date("2026-06-15T12:00:00Z"), // mid-day UTC, outside any quiet window
    ...over,
  };
}

const CLINICAL_ROUTINE: AlertContext = {
  eventType: "m10.hope.sfv_created",
  category: "clinical_routine",
  severity: "warn",
};

const rows = (p: PlannedDelivery[], userId: string) =>
  p.filter((r) => r.recipientUserId === userId);

describe("fan-out planner — the in-app floor (§2.1.1)", () => {
  it("plans an in-app pending row for every recipient, even with no preferences", () => {
    const plan = planFanOut(input({ alert: CLINICAL_ROUTINE, recipientUserIds: ["u-1", "u-2"] }));
    expect(plan).toHaveLength(2);
    for (const u of ["u-1", "u-2"]) {
      const r = rows(plan, u);
      expect(r).toEqual([
        {
          recipientUserId: u,
          forwardedFromUserId: null,
          channel: "in_app",
          status: "pending",
          alertCategory: "clinical_routine",
          alertSeverity: "warn",
        },
      ]);
    }
  });
});

describe("fan-out planner — out-of-band channels (§2.1.2)", () => {
  const routingMap: RoutingMap = { clinical_routine: { warn: ["in_app", "push", "email"] } };

  it("adds the recipient's preferred out-of-band channels (in_app not duplicated)", () => {
    const plan = planFanOut(
      input({
        alert: CLINICAL_ROUTINE,
        recipientUserIds: ["u-1"],
        preferences: new Map([["u-1", prefs({ userId: "u-1", routingMap })]]),
      }),
    );
    expect(plan.map((r) => r.channel)).toEqual(["in_app", "push", "email"]);
    expect(plan.every((r) => r.status === "pending")).toBe(true);
  });

  it("channels_override REPLACES the routing map for out-of-band (floor still added)", () => {
    const plan = planFanOut(
      input({
        alert: CLINICAL_ROUTINE,
        channelsOverride: ["sms"],
        recipientUserIds: ["u-1"],
        preferences: new Map([["u-1", prefs({ userId: "u-1", routingMap })]]),
      }),
    );
    expect(plan.map((r) => r.channel)).toEqual(["in_app", "sms"]);
  });

  it("recipient with no preferences entry gets the floor only", () => {
    const plan = planFanOut(
      input({ alert: CLINICAL_ROUTINE, recipientUserIds: ["u-x"], preferences: new Map() }),
    );
    expect(plan.map((r) => r.channel)).toEqual(["in_app"]);
  });
});

describe("fan-out planner — voice is SOS-only (§2.5)", () => {
  const wantsVoice: RoutingMap = {
    field_safety: { critical: ["in_app", "voice", "sms"] },
    clinical_routine: { warn: ["in_app", "voice"] },
  };

  it("includes voice for a critical field-safety alert", () => {
    const plan = planFanOut(
      input({
        alert: { eventType: "field_safety.sos", category: "field_safety", severity: "critical" },
        recipientUserIds: ["u-1"],
        preferences: new Map([["u-1", prefs({ userId: "u-1", routingMap: wantsVoice })]]),
      }),
    );
    expect(plan.map((r) => r.channel)).toEqual(["in_app", "voice", "sms"]);
  });

  it("drops voice for any non-SOS alert, even if the routing map asks for it", () => {
    const plan = planFanOut(
      input({
        alert: CLINICAL_ROUTINE,
        recipientUserIds: ["u-1"],
        preferences: new Map([["u-1", prefs({ userId: "u-1", routingMap: wantsVoice })]]),
      }),
    );
    expect(plan.map((r) => r.channel)).toEqual(["in_app"]); // voice stripped, nothing else asked
  });
});

describe("fan-out planner — quiet hours (§2.5)", () => {
  const quietNight = {
    tz: "UTC",
    ranges: [{ daysOfWeek: ALL_DAYS, start: "21:00", end: "07:00" }],
    severityOverride: "critical" as const,
  };
  const routingMap: RoutingMap = {
    clinical_routine: { warn: ["in_app", "push"] },
    clinical_urgent: { critical: ["in_app", "push"] },
  };
  const atNight = new Date("2026-06-15T22:00:00Z"); // inside the 21:00–07:00 UTC window

  it("skips out-of-band below the override floor inside the window; in-app still pending", () => {
    const plan = planFanOut(
      input({
        alert: CLINICAL_ROUTINE,
        recipientUserIds: ["u-1"],
        preferences: new Map([
          ["u-1", prefs({ userId: "u-1", routingMap, quietHours: quietNight })],
        ]),
        at: atNight,
      }),
    );
    expect(rows(plan, "u-1")).toEqual([
      expect.objectContaining({ channel: "in_app", status: "pending" }),
      expect.objectContaining({ channel: "push", status: "skipped_quiet_hours" }),
    ]);
  });

  it("at/above the override floor punches through quiet hours (§7.5)", () => {
    const plan = planFanOut(
      input({
        alert: { eventType: "lab.critical", category: "clinical_urgent", severity: "critical" },
        recipientUserIds: ["u-1"],
        preferences: new Map([
          ["u-1", prefs({ userId: "u-1", routingMap, quietHours: quietNight })],
        ]),
        at: atNight,
      }),
    );
    expect(plan.every((r) => r.status === "pending")).toBe(true);
    expect(plan.map((r) => r.channel)).toEqual(["in_app", "push"]);
  });

  it("outside the window, out-of-band is delivered normally", () => {
    const plan = planFanOut(
      input({
        alert: CLINICAL_ROUTINE,
        recipientUserIds: ["u-1"],
        preferences: new Map([
          ["u-1", prefs({ userId: "u-1", routingMap, quietHours: quietNight })],
        ]),
        at: new Date("2026-06-15T12:00:00Z"),
      }),
    );
    expect(plan.every((r) => r.status === "pending")).toBe(true);
  });
});

describe("fan-out planner — vacation forwarding (§2.6 / §7.6)", () => {
  const routingMap: RoutingMap = { clinical_routine: { warn: ["in_app", "sms"] } };
  const now = new Date("2026-06-15T12:00:00Z");
  const future = new Date("2026-06-20T00:00:00Z");

  it("forwards out-of-band to the backup and records a forwarded row for the original", () => {
    const original = prefs({
      userId: "u-orig",
      routingMap,
      vacationForwardToUserId: "u-backup",
      vacationUntil: future,
    });
    const backup = prefs({ userId: "u-backup", routingMap });
    const plan = planFanOut(
      input({
        alert: CLINICAL_ROUTINE,
        recipientUserIds: ["u-orig"],
        preferences: new Map([
          ["u-orig", original],
          ["u-backup", backup],
        ]),
        at: now,
      }),
    );
    // original: in-app floor (still reaches a connected user) + a forwarded SMS marker
    expect(rows(plan, "u-orig")).toEqual([
      expect.objectContaining({ channel: "in_app", status: "pending", forwardedFromUserId: null }),
      expect.objectContaining({ channel: "sms", status: "forwarded", forwardedFromUserId: null }),
    ]);
    // backup: the redirected SMS, tagged with who it was forwarded from
    expect(rows(plan, "u-backup")).toEqual([
      expect.objectContaining({
        channel: "sms",
        status: "pending",
        forwardedFromUserId: "u-orig",
      }),
    ]);
  });

  it("is single-hop: a backup who is themselves on vacation is NOT re-forwarded", () => {
    const original = prefs({
      userId: "u-orig",
      routingMap,
      vacationForwardToUserId: "u-backup",
      vacationUntil: future,
    });
    const backup = prefs({
      userId: "u-backup",
      routingMap,
      vacationForwardToUserId: "u-third",
      vacationUntil: future,
    });
    const plan = planFanOut(
      input({
        alert: CLINICAL_ROUTINE,
        recipientUserIds: ["u-orig"],
        preferences: new Map([
          ["u-orig", original],
          ["u-backup", backup],
        ]),
        at: now,
      }),
    );
    expect(plan.some((r) => r.recipientUserId === "u-third")).toBe(false);
    expect(rows(plan, "u-backup")).toEqual([
      expect.objectContaining({ channel: "sms", status: "pending" }),
    ]);
  });

  it("ignores an expired vacation window (delivers to the original)", () => {
    const past = new Date("2026-06-10T00:00:00Z");
    const original = prefs({
      userId: "u-orig",
      routingMap,
      vacationForwardToUserId: "u-backup",
      vacationUntil: past,
    });
    const plan = planFanOut(
      input({
        alert: CLINICAL_ROUTINE,
        recipientUserIds: ["u-orig"],
        preferences: new Map([["u-orig", original]]),
        at: now,
      }),
    );
    expect(plan.some((r) => r.status === "forwarded")).toBe(false);
    expect(rows(plan, "u-orig").map((r) => r.channel)).toEqual(["in_app", "sms"]);
  });
});
