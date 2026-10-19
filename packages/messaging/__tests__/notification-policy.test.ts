// @wardenx/messaging — M36 WP 4.6 notification policy (ADR-0073).
//
// The acceptance ("routine suppressed in quiet hours, designated urgent still delivered"), the tighten-only property (no
// preference, rule override, shift or clock can remove or delay a designated route's platform floor), the quiet-hours clock
// edges (IANA zone, midnight crossing, spring-forward, fall-back; fixed instants, never the server zone) and the fail-safe
// reads (unknown shift, missing preferences, unreadable class). Every instant is a fixed ISO string.
import { describe, expect, it } from "vitest";
import {
  type AlertContext,
  type NotificationChannel,
  PLATFORM_CHANNEL_FLOOR,
  type PlannedDelivery,
  type PolicyAckClass,
  type QuietHoursConfig,
  type RecipientPreferences,
  type ShiftState,
  createInMemoryAlertEmitter,
  decideChannels,
  designatedClassOf,
  planFanOut,
  planFanOutDetailed,
} from "../src/index";

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const NIGHT: QuietHoursConfig = {
  tz: "America/Los_Angeles",
  ranges: [{ daysOfWeek: ALL_DAYS, start: "21:00", end: "07:00" }],
  severityOverride: "critical",
};
const prefs = (over: Partial<RecipientPreferences> = {}): RecipientPreferences => ({
  userId: "u-1",
  routingMap: {},
  quietHours: NIGHT,
  vacationForwardToUserId: null,
  vacationUntil: null,
  ...over,
});
const URGENT: AlertContext = {
  eventType: "m36.ack.requested",
  category: "clinical_urgent",
  severity: "warn",
};
const ROUTINE: AlertContext = {
  eventType: "m10.hope.sfv_created",
  category: "clinical_routine",
  severity: "warn",
};
const VERIFIED = new Map([["u-1", new Set<NotificationChannel>(["push", "sms", "email"])]]);
// 04:30Z = 21:30 PDT: inside the night window in the recipient's zone (and 04:30 UTC is outside a UTC 21-07 window? no: inside
// too, so the zone-sensitive cases below use other instants).
const NIGHT_INSTANT = new Date("2026-06-16T04:30:00Z");

const planned = (p: PlannedDelivery[], status = "pending") =>
  p.filter((r) => r.channel !== "in_app" && r.status === status).map((r) => r.channel);

describe("acceptance: quiet hours suppress routine, never a designated urgent route", () => {
  it("routine out-of-band is skipped with a reason; the designated urgent push is still delivered", () => {
    const preferences = new Map([
      ["u-1", prefs({ routingMap: { clinical_routine: { warn: ["email"] } } })],
    ]);
    const routine = planFanOutDetailed({
      alert: ROUTINE,
      channelsOverride: null,
      recipientUserIds: ["u-1"],
      preferences,
      at: NIGHT_INSTANT,
    });
    expect(routine.plan.find((r) => r.channel === "email")).toMatchObject({
      status: "skipped_quiet_hours",
      reason: "quiet_hours",
    });

    const urgent = planFanOutDetailed({
      alert: URGENT,
      channelsOverride: ["in_app"],
      recipientUserIds: ["u-1"],
      preferences,
      at: NIGHT_INSTANT,
      policy: { ackClass: "urgent", verifiedChannels: VERIFIED },
    });
    expect(planned(urgent.plan)).toEqual(["push"]);
    expect(urgent.trail).toEqual([
      {
        recipientUserId: "u-1",
        channel: "push",
        decision: "planned",
        reasons: ["designated_floor", "quiet_hours_bypassed"],
      },
    ]);
  });
});

describe("designated route: the platform floor", () => {
  it("plans the class floor on verified channels, omits an unverified one with a reason", () => {
    const only = new Map([["u-1", new Set<NotificationChannel>(["push"])]]);
    const out = decideChannels({
      category: "clinical_urgent",
      severity: "warn",
      ackClass: "critical",
      baseChannels: [],
      verifiedChannels: only.get("u-1"),
      prefs: undefined,
      shift: "unknown",
      at: NIGHT_INSTANT,
    });
    expect(out).toEqual([
      { channel: "push", decision: "planned", reasons: ["designated_floor"] },
      {
        channel: "sms",
        decision: "omitted",
        reasons: ["designated_floor", "no_verified_endpoint"],
      },
    ]);
  });

  it("a recipient with no preferences row still gets the floor on their verified endpoint", () => {
    const { plan } = planFanOutDetailed({
      alert: URGENT,
      channelsOverride: ["in_app"],
      recipientUserIds: ["u-1"],
      preferences: new Map(),
      at: NIGHT_INSTANT,
      policy: { ackClass: "important", verifiedChannels: VERIFIED },
    });
    expect(planned(plan)).toEqual(["push"]);
  });

  it("a recipient with no verified endpoint gets in-app only and an explained omission", () => {
    const r = planFanOutDetailed({
      alert: URGENT,
      channelsOverride: ["in_app"],
      recipientUserIds: ["u-1"],
      preferences: new Map(),
      at: NIGHT_INSTANT,
      policy: { ackClass: "urgent", verifiedChannels: new Map() },
    });
    expect(r.plan.map((x) => x.channel)).toEqual(["in_app"]);
    expect(r.trail[0]).toMatchObject({
      decision: "omitted",
      reasons: ["designated_floor", "no_verified_endpoint"],
    });
  });

  it("preferences and rule overrides only ADD channels; voice stays out unless SOS-eligible", () => {
    const out = decideChannels({
      category: "clinical_urgent",
      severity: "warn",
      ackClass: "urgent",
      baseChannels: ["email", "push"],
      verifiedChannels: new Set<NotificationChannel>(["push", "email"]),
      prefs: undefined,
      shift: "unknown",
      at: NIGHT_INSTANT,
    });
    expect(out.map((d) => [d.channel, d.reasons[0]])).toEqual([
      ["push", "designated_floor"],
      ["email", "designated_added"],
    ]);
  });

  it("is never forwarded to a vacation backup", () => {
    const preferences = new Map([
      [
        "u-1",
        prefs({ vacationForwardToUserId: "u-2", vacationUntil: new Date("2026-07-01T00:00:00Z") }),
      ],
    ]);
    const { plan } = planFanOutDetailed({
      alert: URGENT,
      channelsOverride: ["in_app"],
      recipientUserIds: ["u-1"],
      preferences,
      at: NIGHT_INSTANT,
      policy: { ackClass: "urgent", verifiedChannels: VERIFIED },
    });
    expect(plan.some((r) => r.status === "forwarded" || r.forwardedFromUserId !== null)).toBe(
      false,
    );
    expect(planned(plan)).toEqual(["push"]);
  });
});

describe("tighten-only property (enumerated: no property library is installed)", () => {
  const CLASSES: PolicyAckClass[] = ["important", "urgent", "critical"];
  const SUBSETS: NotificationChannel[][] = [
    [],
    ["push"],
    ["sms"],
    ["email"],
    ["push", "sms"],
    ["push", "sms", "email"],
  ];
  const BASES: NotificationChannel[][] = [
    [],
    ["email"],
    ["sms", "push"],
    ["voice"],
    ["email", "voice", "push"],
  ];
  const QUIET: QuietHoursConfig[] = [
    { tz: "UTC", ranges: [], severityOverride: "critical" },
    {
      tz: "UTC",
      ranges: [{ daysOfWeek: ALL_DAYS, start: "00:00", end: "23:59" }],
      severityOverride: "critical",
    },
    {
      tz: "Asia/Kolkata",
      ranges: [{ daysOfWeek: ALL_DAYS, start: "21:00", end: "07:00" }],
      severityOverride: "critical",
    },
    {
      tz: "America/New_York",
      ranges: [{ daysOfWeek: ALL_DAYS, start: "00:00", end: "00:00" }],
      severityOverride: "info",
    },
    {
      tz: "America/Los_Angeles",
      ranges: [{ daysOfWeek: [], start: "21:00", end: "07:00" }],
      severityOverride: "warn",
    },
  ];
  const SHIFTS: ShiftState[] = ["on_shift", "off_shift", "unknown"];
  const INSTANTS = [
    "2026-03-08T06:59:00Z",
    "2026-03-08T07:00:00Z",
    "2026-06-16T04:30:00Z",
    "2026-11-01T05:30:00Z",
    "2026-11-01T06:30:00Z",
    "2026-12-25T12:00:00Z",
  ].map((i) => new Date(i));

  it("for every preference, override, shift, endpoint set and instant the result contains floor ∩ verified, all pending, all verified", () => {
    let cases = 0;
    for (const ackClass of CLASSES)
      for (const verified of SUBSETS)
        for (const base of BASES)
          for (const quietHours of QUIET)
            for (const shift of SHIFTS)
              for (const at of INSTANTS)
                for (const severity of ["info", "warn", "critical"] as const) {
                  const v = new Set<NotificationChannel>(verified);
                  const out = decideChannels({
                    category: "clinical_urgent",
                    severity,
                    ackClass,
                    baseChannels: base,
                    verifiedChannels: v,
                    prefs: prefs({ quietHours }),
                    shift,
                    at,
                  });
                  const delivered = out
                    .filter((d) => d.decision === "planned")
                    .map((d) => d.channel);
                  expect(out.some((d) => d.decision === "suppressed")).toBe(false);
                  for (const c of PLATFORM_CHANNEL_FLOOR[ackClass]) {
                    if (v.has(c)) expect(delivered).toContain(c);
                  }
                  for (const c of delivered) expect(v.has(c === "voice" ? "sms" : c)).toBe(true);
                  expect(delivered).not.toContain("in_app");
                  cases += 1;
                }
    expect(cases).toBeGreaterThan(10000);
  });

  it("the floor table itself is frozen, so no caller can loosen it", () => {
    expect(Object.isFrozen(PLATFORM_CHANNEL_FLOOR)).toBe(true);
    expect(Object.isFrozen(PLATFORM_CHANNEL_FLOOR.urgent)).toBe(true);
    expect(() => {
      (PLATFORM_CHANNEL_FLOOR.urgent as unknown as string[]).pop();
    }).toThrow();
  });
});

describe("designatedClassOf", () => {
  it("only the four assignee-facing request events are designated", () => {
    expect(designatedClassOf("m36.message.urgent_sent", {})).toEqual({
      ackClass: "urgent",
      defaulted: false,
    });
    expect(designatedClassOf("m36.ack.escalated", { ackClass: "critical" })).toEqual({
      ackClass: "critical",
      defaulted: false,
    });
    expect(designatedClassOf("m36.ack.failed_unreachable", { ackClass: "urgent" })).toBeNull();
    expect(designatedClassOf("m36.ack.route_unavailable", {})).toBeNull();
    expect(designatedClassOf("m10.hope.sfv_created", {})).toBeNull();
  });

  it("an unreadable class is defaulted to urgent and flagged, never downgraded to not-designated", () => {
    for (const bad of [undefined, "", "routine", 5, null, {}]) {
      expect(designatedClassOf("m36.ack.reassigned", { ackClass: bad })).toEqual({
        ackClass: "urgent",
        defaulted: true,
      });
    }
  });
});

describe("non-designated routes: preferences honoured, shift fails safe", () => {
  const base = {
    category: "clinical_routine",
    severity: "warn",
    ackClass: null,
    baseChannels: ["email"],
    verifiedChannels: undefined,
    prefs: prefs(),
    at: new Date("2026-06-16T19:00:00Z"),
  } as const; // 12:00 PDT

  it("unknown shift delivers; a known off-shift recipient is treated as quiet; on-shift changes nothing", () => {
    expect(decideChannels({ ...base, shift: "unknown" })[0]?.decision).toBe("planned");
    expect(decideChannels({ ...base, shift: "on_shift" })[0]?.decision).toBe("planned");
    expect(decideChannels({ ...base, shift: "off_shift" })[0]).toMatchObject({
      decision: "suppressed",
      reasons: ["off_shift"],
    });
  });

  it("the recipient's severity override still punches through quiet hours and off shift", () => {
    const crit = { ...base, severity: "critical" } as const;
    expect(decideChannels({ ...crit, shift: "off_shift" })[0]?.decision).toBe("planned");
    expect(decideChannels({ ...crit, at: NIGHT_INSTANT, shift: "unknown" })[0]?.decision).toBe(
      "planned",
    );
  });

  it("with no policy input the planner is the M20 engine unchanged (suppressed row carries only a reason code)", () => {
    const plan = planFanOut({
      alert: ROUTINE,
      channelsOverride: null,
      recipientUserIds: ["u-1"],
      preferences: new Map([
        ["u-1", prefs({ routingMap: { clinical_routine: { warn: ["sms"] } } })],
      ]),
      at: NIGHT_INSTANT,
    });
    expect(plan.map((r) => [r.channel, r.status])).toEqual([
      ["in_app", "pending"],
      ["sms", "skipped_quiet_hours"],
    ]);
  });
});

describe("quiet-hours clock edges (recipient zone, fixed instants)", () => {
  const routineAt = (iso: string, quietHours: QuietHoursConfig): string =>
    decideChannels({
      category: "clinical_routine",
      severity: "warn",
      ackClass: null,
      baseChannels: ["email"],
      verifiedChannels: undefined,
      prefs: prefs({ quietHours }),
      shift: "unknown",
      at: new Date(iso),
    })[0]?.decision ?? "none";

  it("midnight-crossing window uses the recipient's zone, start inclusive, end exclusive", () => {
    expect(routineAt("2026-06-16T03:59:00Z", NIGHT)).toBe("planned"); // 20:59 PDT
    expect(routineAt("2026-06-16T04:00:00Z", NIGHT)).toBe("suppressed"); // 21:00 PDT
    expect(routineAt("2026-06-16T08:00:00Z", NIGHT)).toBe("suppressed"); // 01:00 PDT, after midnight
    expect(routineAt("2026-06-16T13:59:00Z", NIGHT)).toBe("suppressed"); // 06:59 PDT
    expect(routineAt("2026-06-16T14:00:00Z", NIGHT)).toBe("planned"); // 07:00 PDT
  });

  it("the same instant gives different answers in different zones (the server zone is irrelevant)", () => {
    const at = "2026-06-16T14:30:00Z"; // 07:30 PDT (not quiet) / 20:00 Kolkata (not quiet) / 10:30 EDT
    const kolkata = { ...NIGHT, tz: "Asia/Kolkata" };
    expect(routineAt(at, NIGHT)).toBe("planned");
    expect(routineAt("2026-06-16T16:00:00Z", kolkata)).toBe("suppressed"); // 21:30 IST
    expect(routineAt("2026-06-16T16:00:00Z", NIGHT)).toBe("planned"); // 09:00 PDT
  });

  const NY = (start: string, end: string): QuietHoursConfig => ({
    tz: "America/New_York",
    ranges: [{ daysOfWeek: ALL_DAYS, start, end }],
    severityOverride: "critical",
  });

  it("spring-forward (2026-03-08 NY, 02:00 EST -> 03:00 EDT): wall-clock comparison, no phantom hour", () => {
    const w = NY("02:00", "04:00");
    expect(routineAt("2026-03-08T06:59:00Z", w)).toBe("planned"); // 01:59 EST
    expect(routineAt("2026-03-08T07:00:00Z", w)).toBe("suppressed"); // 03:00 EDT (02:xx never exists)
    expect(routineAt("2026-03-08T07:59:00Z", w)).toBe("suppressed"); // 03:59 EDT
    expect(routineAt("2026-03-08T08:00:00Z", w)).toBe("planned"); // 04:00 EDT
  });

  it("fall-back (2026-11-01 NY, 02:00 EDT -> 01:00 EST): the repeated hour is quiet on both passes", () => {
    const w = NY("01:00", "02:00");
    expect(routineAt("2026-11-01T04:59:00Z", w)).toBe("planned"); // 00:59 EDT
    expect(routineAt("2026-11-01T05:30:00Z", w)).toBe("suppressed"); // 01:30 EDT
    expect(routineAt("2026-11-01T06:30:00Z", w)).toBe("suppressed"); // 01:30 EST (second pass)
    expect(routineAt("2026-11-01T07:00:00Z", w)).toBe("planned"); // 02:00 EST
  });

  it("a designated route is delivered at every one of those edges", () => {
    for (const iso of [
      "2026-03-08T07:00:00Z",
      "2026-11-01T05:30:00Z",
      "2026-11-01T06:30:00Z",
      "2026-06-16T08:00:00Z",
    ]) {
      const out = decideChannels({
        category: "clinical_urgent",
        severity: "warn",
        ackClass: "urgent",
        baseChannels: [],
        verifiedChannels: new Set<NotificationChannel>(["push"]),
        prefs: prefs({ quietHours: NY("00:00", "00:00") }),
        shift: "off_shift",
        at: new Date(iso),
      });
      expect(out[0]?.decision).toBe("planned");
    }
  });
});

describe("AlertEmitter wiring (in-memory ports)", () => {
  const verifiedChannels = new Map([["u-1", new Set<NotificationChannel>(["push"])]]);
  const run = async (opts: Parameters<typeof createInMemoryAlertEmitter>[0]) => {
    const { emitter, recorded } = createInMemoryAlertEmitter({
      now: () => NIGHT_INSTANT,
      preferences: new Map([["u-1", prefs()]]),
      verifiedChannels,
      ...opts,
    });
    await emitter.emit("org-1", {
      eventType: "m36.ack.requested",
      severity: "warn",
      correlationId: "c-1",
      payload: { recipientUserId: "u-1", ackClass: "urgent", message: "x" },
    });
    return recorded[0];
  };

  it("policy off (default): the seeded in-app-only rule is untouched", async () => {
    const alert = await run({});
    expect(alert?.deliveries.map((d) => d.channel)).toEqual(["in_app"]);
    expect(alert?.payload).not.toHaveProperty("policyTrail");
  });

  it("policy on: the urgent request alert gains a push route at night and records an id-only trail", async () => {
    const alert = await run({ policyEnabledEventTypes: new Set(["m36.ack.requested"]) });
    expect(alert?.deliveries.map((d) => [d.channel, d.status])).toEqual([
      ["in_app", "pending"],
      ["push", "pending"],
    ]);
    expect(alert?.payload.policyTrail).toEqual([
      {
        recipientUserId: "u-1",
        channel: "push",
        decision: "planned",
        reasons: ["designated_floor", "quiet_hours_bypassed"],
      },
    ]);
  });

  it("policy on for another event only: this event stays in-app", async () => {
    const alert = await run({ policyEnabledEventTypes: new Set(["m36.ack.escalated"]) });
    expect(alert?.deliveries.map((d) => d.channel)).toEqual(["in_app"]);
  });

  it("policy on but no verified endpoint: in-app only, omission explained", async () => {
    const alert = await run({
      policyEnabledEventTypes: new Set(["m36.ack.requested"]),
      verifiedChannels: new Map(),
    });
    expect(alert?.deliveries.map((d) => d.channel)).toEqual(["in_app"]);
    expect(alert?.payload.policyTrail).toEqual([
      {
        recipientUserId: "u-1",
        channel: "push",
        decision: "omitted",
        reasons: ["designated_floor", "no_verified_endpoint"],
      },
    ]);
  });
});
