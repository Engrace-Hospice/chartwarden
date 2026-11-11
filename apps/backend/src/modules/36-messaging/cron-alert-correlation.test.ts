import { CLEARINGHOUSE_HOLD_ALERT_CODES } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  assertHoldAlertHadRecipients,
  cronAlertCorrelationId,
  isClearinghouseHoldAlert,
} from "./cron-alert-correlation";

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

// The clearinghouse held-work alerts (CH-4 / F1): the emitter collapses a repeat of an (org, correlation id) and writes no deliveries,
// so the id must tell a held claim's warning from a held NOE's critical alert, and one six-hour window from the next.
describe("cronAlertCorrelationId for a clearinghouse held-work alert", () => {
  const HOLD = CLEARINGHOUSE_HOLD_ALERT_CODES.m23;
  const claim = { queue: "claim.submit", reason: "not_active" };
  const noe = { queue: "noe.submit", reason: "not_active" };
  const at = (iso: string) => new Date(iso);

  it("a warning for a held claim and a critical alert for a held NOE on the same day get different ids", () => {
    const warn = cronAlertCorrelationId(
      "m23-cron",
      HOLD,
      claim,
      at("2026-11-09T02:00:00Z"),
      "warn",
    );
    const critical = cronAlertCorrelationId(
      "m23-cron",
      HOLD,
      noe,
      at("2026-11-09T09:00:00Z"),
      "critical",
    );
    expect(warn).not.toEqual(critical);
    // severity alone separates them, whatever the queue
    expect(
      cronAlertCorrelationId("m23-cron", HOLD, claim, at("2026-11-09T02:00:00Z"), "critical"),
    ).not.toEqual(warn);
  });

  it("the same key in two windows six hours apart gets different ids, so the six-hour re-alert is not collapsed", () => {
    const first = cronAlertCorrelationId(
      "m23-cron",
      HOLD,
      claim,
      at("2026-11-09T02:00:00Z"),
      "warn",
    );
    const sixHoursLater = cronAlertCorrelationId(
      "m23-cron",
      HOLD,
      claim,
      at("2026-11-09T08:00:00Z"),
      "warn",
    );
    expect(sixHoursLater).not.toEqual(first);
    // any two instants a full window apart land in different windows, wherever the boundary falls
    for (const iso of ["2026-11-09T05:59:59Z", "2026-11-09T06:00:00Z", "2026-11-09T11:59:59Z"]) {
      const t = at(iso);
      const later = new Date(t.getTime() + 6 * 60 * 60_000);
      expect(cronAlertCorrelationId("m23-cron", HOLD, claim, later, "warn")).not.toEqual(
        cronAlertCorrelationId("m23-cron", HOLD, claim, t, "warn"),
      );
    }
  });

  it("the same key within one window gets the same id, so a repeat is still absorbed", () => {
    const a = cronAlertCorrelationId("m23-cron", HOLD, claim, at("2026-11-09T06:01:00Z"), "warn");
    const b = cronAlertCorrelationId("m23-cron", HOLD, claim, at("2026-11-09T11:58:00Z"), "warn");
    expect(b).toEqual(a);
  });

  it("M41 keeps the submission drain and the ack pull apart, and ignores the changing waiting count", () => {
    const M41 = CLEARINGHOUSE_HOLD_ALERT_CODES.m41;
    const now = at("2026-11-09T09:00:00Z");
    const drain = cronAlertCorrelationId(
      "m41-cron",
      M41,
      { queue: "m41.submission.drain", waiting: 3 },
      now,
      "warn",
    );
    const pull = cronAlertCorrelationId(
      "m41-cron",
      M41,
      { queue: "m41.ack.pull", waiting: 3 },
      now,
      "warn",
    );
    const drainLater = cronAlertCorrelationId(
      "m41-cron",
      M41,
      { queue: "m41.submission.drain", waiting: 9 },
      now,
      "warn",
    );
    const coded = cronAlertCorrelationId(
      "m41-cron",
      M41,
      { queue: "m41.ack.pull", waiting: 3, code: "CLEARINGHOUSE_CREDENTIAL_UNREADABLE" },
      now,
      "warn",
    );
    expect(drain).not.toEqual(pull);
    expect(drainLater).toEqual(drain);
    expect(coded).not.toEqual(pull);
  });

  it("only the held-work alerts are windowed: every other alert keeps its per-day key, whatever severity is passed", () => {
    const p = { noeId: "n1" };
    const day = cronAlertCorrelationId("m23-cron", "m23.noe.window_breached", p, DAY);
    expect(
      cronAlertCorrelationId("m23-cron", "m23.noe.window_breached", p, DAY, "critical"),
    ).toEqual(day);
    expect(isClearinghouseHoldAlert("m23.noe.window_breached")).toBe(false);
    expect(isClearinghouseHoldAlert(HOLD)).toBe(true);
  });
});

describe("assertHoldAlertHadRecipients", () => {
  const HOLD = CLEARINGHOUSE_HOLD_ALERT_CODES.m23;

  it("refuses a held-work alert that resolved no recipient, with a typed code", () => {
    expect(() =>
      assertHoldAlertHadRecipients(HOLD, { alertId: "a", resolvedRecipientCount: 0 }),
    ).toThrow(expect.objectContaining({ code: "ALERT_NO_RECIPIENT" }));
  });

  it("accepts one that addressed somebody, and leaves every other alert alone", () => {
    expect(() =>
      assertHoldAlertHadRecipients(HOLD, { alertId: "a", resolvedRecipientCount: 2 }),
    ).not.toThrow();
    expect(() =>
      assertHoldAlertHadRecipients("m23.noe.window_breached", {
        alertId: "a",
        resolvedRecipientCount: 0,
      }),
    ).not.toThrow();
    expect(() => assertHoldAlertHadRecipients(HOLD, undefined)).not.toThrow(); // an emitter that says nothing is not a refusal
  });
});
