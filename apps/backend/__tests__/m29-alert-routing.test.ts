// F-186 (#248) — M29's outbound operator alerts must be able to reach a person. Pure guards; the live proof on the
// real M36 emitter is `m29-alert-routing.live.test.ts`.
import { PLATFORM_DEFAULT_ALERT_RULES } from "@wardenx/messaging";
import { describe, expect, it } from "vitest";
import {
  OUTBOUND_ALERT_WINDOW_MS,
  buildOutboundAlertEmit,
  outboundAlertCorrelationId,
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

describe("F-186 — every outbound alert kind has a seeded platform-default rule", () => {
  it.each(OUTBOUND_ALERT_KINDS)("%s has an enabled rule that names real recipients", (kind) => {
    const rules = PLATFORM_DEFAULT_ALERT_RULES.filter((r) => r.eventType === kind);
    expect(rules, `no platform-default alert_rule for '${kind}' — its alerts reach nobody`).toHaveLength(1);
    const rule = rules[0]!;
    expect(rule.enabled).toBe(true);
    expect(rule.recipientResolver).toBe("role_set");
    const roleKeys = (rule.resolverArgs as { roleKeys?: string[] }).roleKeys ?? [];
    expect(roleKeys.length).toBeGreaterThan(0);
  });

  it("a failed transmission reaches the operator (org_admin) AND the M11 owners; a BAA lapse reaches compliance, backstopped by org_admin (spec §5.3)", () => {
    const keys = (kind: string) =>
      ((PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === kind)?.resolverArgs as { roleKeys: string[] })
        .roleKeys);
    expect(keys("hl7_outbound.transmission_failed")).toEqual(["org_admin", "clinical_lead"]);
    expect(keys("external_feed.baa_expired")).toEqual(["compliance_officer", "org_admin"]);
    expect(keys("external_feed.baa_missing")).toEqual(["compliance_officer", "org_admin"]);
  });
});

describe("F-186 — the severity ladders meet in one place", () => {
  it("maps M29's HIGH/NORMAL to the emitter's alert_severity enum — the pass-through threw at the INSERT", () => {
    expect(toEmitterSeverity("HIGH")).toBe("critical");
    expect(toEmitterSeverity("NORMAL")).toBe("warn");
    for (const s of ["HIGH", "NORMAL"] as const) expect(ENUM).toContain(toEmitterSeverity(s));
  });

  it("builds a PHI-free emit input whose severity is always in the enum", () => {
    for (const kind of OUTBOUND_ALERT_KINDS) {
      for (const severity of ["HIGH", "NORMAL"] as const) {
        const input = buildOutboundAlertEmit(alert({ kind, severity }), new Date("2026-05-01T00:00:00Z"));
        expect(ENUM).toContain(input.severity);
        expect(input.eventType).toBe(kind);
        expect(Object.keys(input.payload).sort()).toEqual(["detail", "feedId"]);
      }
    }
  });
});

describe("F-186 — the correlation id is a window, not a permanent key", () => {
  const t0 = new Date("2026-05-01T10:00:00Z");

  it("is stable inside a window for one (kind, feed) — a retry storm pages once", () => {
    const a = outboundAlertCorrelationId(alert(), t0);
    const b = outboundAlertCorrelationId(alert(), new Date(t0.getTime() + 59 * 60_000));
    expect(b).toBe(a);
  });

  it("changes in the next window — the SAME still-true condition pages again (the old id never changed)", () => {
    const a = outboundAlertCorrelationId(alert(), t0);
    const next = new Date(t0.getTime() + OUTBOUND_ALERT_WINDOW_MS["hl7_outbound.transmission_failed"]);
    expect(outboundAlertCorrelationId(alert(), next)).not.toBe(a);
  });

  it("differs per feed and per kind", () => {
    const a = outboundAlertCorrelationId(alert(), t0);
    expect(outboundAlertCorrelationId(alert({ feedId: "22222222-2222-2222-2222-222222222222" }), t0)).not.toBe(a);
    expect(outboundAlertCorrelationId(alert({ kind: "external_feed.baa_expired" }), t0)).not.toBe(a);
  });

  it("a BAA lapse repeats daily, a failed transmission hourly", () => {
    expect(OUTBOUND_ALERT_WINDOW_MS["hl7_outbound.transmission_failed"]).toBe(3_600_000);
    expect(OUTBOUND_ALERT_WINDOW_MS["external_feed.baa_expired"]).toBe(86_400_000);
    expect(OUTBOUND_ALERT_WINDOW_MS["external_feed.baa_missing"]).toBe(86_400_000);
  });
});
