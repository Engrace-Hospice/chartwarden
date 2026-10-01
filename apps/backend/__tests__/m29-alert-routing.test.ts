// F-188 (#248) — M29's outbound operator alerts must be able to reach a person. Pure guards; the live proof on the
// real M36 emitter is `m29-alert-routing.live.test.ts`.
import { PLATFORM_DEFAULT_ALERT_RULES } from "@wardenx/messaging";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STORM_THRESHOLD,
  OUTBOUND_ALERT_WINDOW_MS,
  buildOutboundAlertEmit,
  buildStormEscalationEmit,
  emitOutboundAlert,
  outboundAlertCorrelationId,
  resolveStormThreshold,
  toEmitterSeverity,
} from "../src/modules/29-external-interfaces/outbound/alert-routing";
import {
  OUTBOUND_ALERT_KINDS,
  type OutboundAlert,
} from "../src/modules/29-external-interfaces/outbound/outbound-events";

const ENUM = ["info", "warn", "critical"];
const FEED = "11111111-1111-1111-1111-111111111111";
const alert = (over: Partial<OutboundAlert> = {}): OutboundAlert => ({
  kind: "hl7_outbound.transmission_failed",
  severity: "HIGH",
  channel: "operator-on-call",
  feedId: FEED,
  detail: "outbound ORM dead-lettered after 5 attempts",
  ...over,
});

describe("F-188 — every outbound alert kind has a seeded platform-default rule", () => {
  it.each(OUTBOUND_ALERT_KINDS)("%s has an enabled rule that names real recipients", (kind) => {
    const rules = PLATFORM_DEFAULT_ALERT_RULES.filter((r) => r.eventType === kind);
    expect(
      rules,
      `no platform-default alert_rule for '${kind}' — its alerts reach nobody`,
    ).toHaveLength(1);
    const rule = rules[0]!;
    expect(rule.enabled).toBe(true);
    expect(rule.recipientResolver).toBe("role_set");
    const roleKeys = (rule.resolverArgs as { roleKeys?: string[] }).roleKeys ?? [];
    expect(roleKeys.length).toBeGreaterThan(0);
  });

  it("a failed transmission reaches the operator (org_admin) AND the M11 owners; a BAA lapse reaches compliance, backstopped by org_admin (spec §5.3)", () => {
    const keys = (kind: string) =>
      (
        PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === kind)?.resolverArgs as {
          roleKeys: string[];
        }
      ).roleKeys;
    expect(keys("hl7_outbound.transmission_failed")).toEqual(["org_admin", "clinical_lead"]);
    expect(keys("external_feed.baa_expired")).toEqual(["compliance_officer", "org_admin"]);
    expect(keys("external_feed.baa_missing")).toEqual(["compliance_officer", "org_admin"]);
  });
});

describe("F-188 — the severity ladders meet in one place", () => {
  it("maps M29's HIGH/NORMAL to the emitter's alert_severity enum — the pass-through threw at the INSERT", () => {
    expect(toEmitterSeverity("HIGH")).toBe("critical");
    expect(toEmitterSeverity("NORMAL")).toBe("warn");
    for (const s of ["HIGH", "NORMAL"] as const) expect(ENUM).toContain(toEmitterSeverity(s));
  });

  it("builds a PHI-free emit input whose severity is always in the enum", () => {
    for (const kind of OUTBOUND_ALERT_KINDS) {
      for (const severity of ["HIGH", "NORMAL"] as const) {
        const input = buildOutboundAlertEmit(
          alert({ kind, severity }),
          new Date("2026-05-01T00:00:00Z"),
        );
        expect(ENUM).toContain(input.severity);
        expect(input.eventType).toBe(kind);
        expect(Object.keys(input.payload).sort()).toEqual(["detail", "feedId"]);
      }
    }
  });
});

describe("F-188 — the correlation id is a window, not a permanent key", () => {
  const t0 = new Date("2026-05-01T10:00:00Z");

  it("is stable inside a window for one (kind, feed) — a retry storm pages once", () => {
    const a = outboundAlertCorrelationId(alert(), t0);
    const b = outboundAlertCorrelationId(alert(), new Date(t0.getTime() + 59 * 60_000));
    expect(b).toBe(a);
  });

  it("changes in the next window — the SAME still-true condition pages again (the old id never changed)", () => {
    const a = outboundAlertCorrelationId(alert(), t0);
    const next = new Date(
      t0.getTime() + OUTBOUND_ALERT_WINDOW_MS["hl7_outbound.transmission_failed"],
    );
    expect(outboundAlertCorrelationId(alert(), next)).not.toBe(a);
  });

  it("differs per feed and per kind", () => {
    const a = outboundAlertCorrelationId(alert(), t0);
    expect(
      outboundAlertCorrelationId(alert({ feedId: "22222222-2222-2222-2222-222222222222" }), t0),
    ).not.toBe(a);
    expect(outboundAlertCorrelationId(alert({ kind: "external_feed.baa_expired" }), t0)).not.toBe(
      a,
    );
  });

  it("a BAA lapse repeats daily, a failed transmission hourly", () => {
    expect(OUTBOUND_ALERT_WINDOW_MS["hl7_outbound.transmission_failed"]).toBe(3_600_000);
    expect(OUTBOUND_ALERT_WINDOW_MS["external_feed.baa_expired"]).toBe(86_400_000);
    expect(OUTBOUND_ALERT_WINDOW_MS["external_feed.baa_missing"]).toBe(86_400_000);
  });
});

// ── F-199 — failure storms: the count, the escalation, and the threshold ─────────────────────────────────────────
describe("F-199 — resolveStormThreshold", () => {
  it("defaults to the documented threshold when unset or blank", () => {
    expect(resolveStormThreshold({})).toBe(DEFAULT_STORM_THRESHOLD);
    expect(resolveStormThreshold({ M29_ALERT_STORM_THRESHOLD: "  " })).toBe(
      DEFAULT_STORM_THRESHOLD,
    );
    expect(DEFAULT_STORM_THRESHOLD).toBe(10);
  });
  it("honours a valid integer override", () => {
    expect(resolveStormThreshold({ M29_ALERT_STORM_THRESHOLD: "25" })).toBe(25);
    expect(resolveStormThreshold({ M29_ALERT_STORM_THRESHOLD: "2" })).toBe(2);
  });
  it.each(["abc", "1", "0", "-5", "2.5", "100001", "NaN"])(
    "a bad value (%s) FALLS BACK — it must never silently disable escalation",
    (raw) => {
      expect(resolveStormThreshold({ M29_ALERT_STORM_THRESHOLD: raw })).toBe(
        DEFAULT_STORM_THRESHOLD,
      );
    },
  );
});

describe("F-199 — buildStormEscalationEmit", () => {
  const now = new Date("2026-06-01T03:00:00Z");
  it("is a critical, PHI-free alert of its OWN kind and correlation id, carrying the count and the feed", () => {
    const e = buildStormEscalationEmit(alert(), 10, now);
    expect(e.eventType).toBe("hl7_outbound.transmission_storm");
    expect(e.severity).toBe("critical");
    expect(e.payload).toMatchObject({ feedId: FEED, occurrences: 10, windowMinutes: 60 });
    expect(e.correlationId).toContain("hl7_outbound.transmission_storm");
    expect(e.correlationId).not.toBe(buildOutboundAlertEmit(alert(), now).correlationId);
    // No order, patient or segment content: ids + integers + a fixed sentence only.
    expect(JSON.stringify(e.payload)).not.toMatch(/MRN|DOB|PID|patient|orderId/i);
  });
  it("is stable inside a window and new in the next (once per window)", () => {
    const a = buildStormEscalationEmit(alert(), 10, now).correlationId;
    expect(
      buildStormEscalationEmit(alert(), 10, new Date(now.getTime() + 59 * 60_000)).correlationId,
    ).toBe(a);
    expect(
      buildStormEscalationEmit(alert(), 10, new Date(now.getTime() + 60 * 60_000)).correlationId,
    ).not.toBe(a);
  });
  it("only the per-message failure kind has an escalation", () => {
    expect(() =>
      buildStormEscalationEmit(alert({ kind: "external_feed.baa_expired" }), 10, now),
    ).toThrow(/no storm escalation/);
  });
});

describe("F-199 — emitOutboundAlert (over a fake emitter that counts like M36)", () => {
  const now = new Date("2026-06-01T03:00:00Z");
  /** Counts per correlationId exactly as the Drizzle persist does; records every emit call. */
  function fakeEmitter() {
    const counts = new Map<string, number>();
    const calls: Array<{ eventType: string; correlationId: string; countRepeats?: boolean }> = [];
    return {
      calls,
      port: {
        emit: async (
          _org: string,
          input: { eventType: string; correlationId: string; countRepeats?: boolean },
        ) => {
          calls.push(input);
          if (!input.countRepeats) return { alertId: "a" };
          const n = (counts.get(input.correlationId) ?? 0) + 1;
          counts.set(input.correlationId, n);
          return { alertId: "a", occurrences: n };
        },
      },
    };
  }
  const storm = (calls: ReturnType<typeof fakeEmitter>["calls"]) =>
    calls.filter((c) => c.eventType === "hl7_outbound.transmission_storm");

  it("the FIRST failure is one immediate counted emit — no escalation, no added call", async () => {
    const f = fakeEmitter();
    await emitOutboundAlert(f.port, "org", alert(), now, 10);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({
      eventType: "hl7_outbound.transmission_failed",
      countRepeats: true,
    });
  });

  it("a storm of 200 escalates EXACTLY ONCE, on the call that reaches the threshold", async () => {
    const f = fakeEmitter();
    for (let i = 0; i < 200; i++) await emitOutboundAlert(f.port, "org", alert(), now, 10);
    expect(storm(f.calls)).toHaveLength(1);
    expect(f.calls.filter((c) => c.eventType === "hl7_outbound.transmission_failed")).toHaveLength(
      200,
    );
    // the escalation came right after the 10th failure, not before and not later
    const idx = f.calls.findIndex((c) => c.eventType === "hl7_outbound.transmission_storm");
    expect(
      f.calls.slice(0, idx).filter((c) => c.eventType === "hl7_outbound.transmission_failed"),
    ).toHaveLength(10);
  });

  it("below the threshold there is no escalation", async () => {
    const f = fakeEmitter();
    for (let i = 0; i < 9; i++) await emitOutboundAlert(f.port, "org", alert(), now, 10);
    expect(storm(f.calls)).toHaveLength(0);
  });

  it("the next window starts a fresh count and can escalate again", async () => {
    const f = fakeEmitter();
    for (let i = 0; i < 10; i++) await emitOutboundAlert(f.port, "org", alert(), now, 10);
    const later = new Date(now.getTime() + 60 * 60_000);
    for (let i = 0; i < 10; i++) await emitOutboundAlert(f.port, "org", alert(), later, 10);
    expect(storm(f.calls)).toHaveLength(2);
  });

  it("a different feed has its own count", async () => {
    const f = fakeEmitter();
    for (let i = 0; i < 6; i++) {
      await emitOutboundAlert(f.port, "org", alert(), now, 10);
      await emitOutboundAlert(
        f.port,
        "org",
        alert({ feedId: "22222222-2222-2222-2222-222222222222" }),
        now,
        10,
      );
    }
    expect(storm(f.calls)).toHaveLength(0); // 6 + 6, never 10 on one feed
  });

  it("BAA kinds are counted but NEVER escalated (one standing condition, already critical)", async () => {
    const f = fakeEmitter();
    for (let i = 0; i < 50; i++)
      await emitOutboundAlert(f.port, "org", alert({ kind: "external_feed.baa_expired" }), now, 10);
    expect(storm(f.calls)).toHaveLength(0);
    expect(f.calls.every((c) => c.countRepeats === true)).toBe(true);
  });

  it("an emitter that does not count (no `occurrences`) never escalates — and never throws", async () => {
    const calls: unknown[] = [];
    const port = {
      emit: async (_o: string, i: unknown) => {
        calls.push(i);
        return { alertId: "a" };
      },
    };
    for (let i = 0; i < 30; i++) await emitOutboundAlert(port, "org", alert(), now, 10);
    expect(calls).toHaveLength(30);
  });
});
