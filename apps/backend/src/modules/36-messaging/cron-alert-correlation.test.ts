import { describe, expect, it } from "vitest";
import { cronAlertCorrelationId } from "./cron-alert-correlation";

const DAY = new Date("2026-10-08T03:00:00.000Z");

describe("cronAlertCorrelationId", () => {
  it("differs per subject entity so a second NOE in the same org still alerts", () => {
    const a = cronAlertCorrelationId("m23-cron", "m23.noe.window_breached", { noeId: "n1" }, DAY);
    const b = cronAlertCorrelationId("m23-cron", "m23.noe.window_breached", { noeId: "n2" }, DAY);
    expect(a).not.toEqual(b);
  });

  it("is stable within a UTC day and renews the next day", () => {
    const p = { noeId: "n1", admissionId: "a1" };
    const same = cronAlertCorrelationId("m23-cron", "x", p, new Date("2026-10-08T22:00:00Z"));
    expect(cronAlertCorrelationId("m23-cron", "x", p, DAY)).toEqual(same);
    expect(
      cronAlertCorrelationId("m23-cron", "x", p, new Date("2026-10-09T01:00:00Z")),
    ).not.toEqual(same);
  });

  it("keys platform events on the jurisdiction and ignores non-subject payload fields", () => {
    const key = cronAlertCorrelationId(
      "m23-cron",
      "m23.mac_portal.unavailable",
      { macJurisdiction: "JJ", up: false, lastSeenUpAt: "t" },
      DAY,
    );
    expect(key).toBe("m23-cron:m23.mac_portal.unavailable:JJ:false:2026-10-08");
  });
});
