// GAP-050 — the M33 `cron-parser`-over-IANA-TZ adapter (`LIVE_CRON`, 33-reporting/wiring.ts).
//
// Before this, `CronPort.nextRunAfter` was a fail-closed stub: every schedule create / update / resume
// threw `M33InfraPortUnbound` (a 5xx), so no tenant could ever create a scheduled report and the §4.8
// `report.scheduled_run` cron had nothing to fire. The in-memory slice's deterministic stub cron made the
// route suite pass throughout — `reporting-inject.test.ts` creates and resumes schedules happily — which is
// exactly why nothing caught it. These tests run the PRODUCTION adapter.
//
// The interesting half is not "does cron-parser parse cron"; it is the two inputs cron-parser accepts that
// it should not, both of which the adapter rejects itself (see `LIVE_CRON`'s doc comment), and the
// strictly-after contract `cronFires` silently depends on to derive its second fire.
import { describe, expect, it } from "vitest";

import {
  CronExpressionInvalidError,
  CronTooFrequentError,
  assertCronCadence,
} from "../src/modules/33-reporting/routes/write-service";
import { LIVE_CRON } from "../src/modules/33-reporting/wiring";

const at = (iso: string) => new Date(iso);

/** The `cronFires` helper (write-service-drizzle.ts) verbatim: the second fire is derived FROM the first. */
const twoFires = (expression: string, tz: string, now: Date) => {
  const first = LIVE_CRON.nextRunAfter(expression, tz, now);
  const second = LIVE_CRON.nextRunAfter(expression, tz, first);
  return { first, second };
};

describe("GAP-050 M33 cron adapter — tenant-timezone evaluation", () => {
  it("evaluates the expression in the TENANT's zone, not the server's", () => {
    // 09:00 in New York is 14:00Z while EST is in effect — the whole reason report_schedule stores
    // tenant_timezone. A UTC-naive parse would have returned 09:00Z.
    const next = LIVE_CRON.nextRunAfter(
      "0 9 * * *",
      "America/New_York",
      at("2026-01-15T12:00:00.000Z"),
    );
    expect(next.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  it("holds the tenant's WALL CLOCK across a DST transition (the UTC instant moves, 09:00 local does not)", () => {
    // 2026-03-08 is US spring-forward. "Every day at 09:00" must stay 09:00 in New York on both sides:
    // 14:00Z under EST, 13:00Z under EDT. A fixed UTC offset would drift the report an hour twice a year.
    const { first, second } = twoFires(
      "0 9 * * *",
      "America/New_York",
      at("2026-03-07T12:00:00.000Z"),
    );
    expect(first.toISOString()).toBe("2026-03-07T14:00:00.000Z"); // EST
    expect(second.toISOString()).toBe("2026-03-08T13:00:00.000Z"); // EDT — one hour earlier in UTC
    const localHour = (d: Date) =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        hour12: false,
      }).format(d);
    expect(localHour(first)).toBe(localHour(second));
  });

  it("returns the fire STRICTLY after `after`, so the cadence check's second fire is a real next fire", () => {
    // `cronFires` derives the second fire by calling back in with the first. If `next()` were
    // inclusive of its currentDate this would return the SAME instant twice, the gap would be 0, and
    // every schedule would trip CRON_TOO_FREQUENT — including hourly ones.
    const onBoundary = at("2026-06-01T10:00:00.000Z");
    expect(LIVE_CRON.nextRunAfter("0 * * * *", "UTC", onBoundary).toISOString()).toBe(
      "2026-06-01T11:00:00.000Z",
    );
  });
});

describe("GAP-050 M33 cron adapter — the §2.3 five-minute cadence floor", () => {
  it("feeds a passing pair for a 5-minute cron (the exact boundary)", () => {
    const { first, second } = twoFires("*/5 * * * *", "UTC", at("2026-06-01T10:02:00.000Z"));
    expect(second.getTime() - first.getTime()).toBe(5 * 60_000);
    expect(() => assertCronCadence(first, second)).not.toThrow();
  });

  it("feeds a failing pair for a per-minute cron", () => {
    const { first, second } = twoFires("* * * * *", "UTC", at("2026-06-01T10:00:30.000Z"));
    expect(second.getTime() - first.getTime()).toBe(60_000);
    expect(() => assertCronCadence(first, second)).toThrow(CronTooFrequentError);
  });

  it("catches a 6-field seconds expression, which cron-parser accepts happily", () => {
    // `*/10 * * * * *` is every 10 SECONDS. cron-parser parses 6-field expressions without complaint,
    // so the floor — not the parser — is what stops a tenant scheduling a report six times a minute.
    const { first, second } = twoFires("*/10 * * * * *", "UTC", at("2026-06-01T10:00:00.000Z"));
    expect(second.getTime() - first.getTime()).toBe(10_000);
    expect(() => assertCronCadence(first, second)).toThrow(CronTooFrequentError);
  });
});

describe("GAP-050 M33 cron adapter — refusals are 422s, never a 5xx", () => {
  it("REJECTS a blank expression, which cron-parser silently reads as '* * * * *'", () => {
    // The hazard this guard exists for: `resumeSchedule` computes only the FIRST fire and never asserts
    // cadence, so without this a blank cron_expression would resume as a once-a-minute report rather
    // than failing. Proven by asserting the parser's own behaviour underneath.
    expect(() => LIVE_CRON.nextRunAfter("", "UTC", at("2026-06-01T10:00:00.000Z"))).toThrow(
      CronExpressionInvalidError,
    );
    expect(() => LIVE_CRON.nextRunAfter("   ", "UTC", at("2026-06-01T10:00:00.000Z"))).toThrow(
      CronExpressionInvalidError,
    );
  });

  it("REJECTS a timezone Intl does not recognize, naming it (cron-parser reports only 'unhandled timestamp')", () => {
    let caught: unknown;
    try {
      LIVE_CRON.nextRunAfter("0 9 * * *", "Mars/Olympus_Mons", at("2026-06-01T10:00:00.000Z"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CronExpressionInvalidError);
    expect((caught as Error).message).toContain("Mars/Olympus_Mons");
    expect((caught as CronExpressionInvalidError).statusCode).toBe(422);
  });

  it("REJECTS an empty timezone (cron-parser throws deep in its evaluator, not at parse)", () => {
    expect(() => LIVE_CRON.nextRunAfter("0 9 * * *", "", at("2026-06-01T10:00:00.000Z"))).toThrow(
      CronExpressionInvalidError,
    );
  });

  it("REJECTS a malformed expression, keeping the parser's own reason in the message", () => {
    let caught: unknown;
    try {
      LIVE_CRON.nextRunAfter("0 99 * * *", "UTC", at("2026-06-01T10:00:00.000Z"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CronExpressionInvalidError);
    expect((caught as Error).message).toContain("99");
    expect((caught as CronExpressionInvalidError).code).toBe("CRON_EXPRESSION_INVALID");
  });

  it("REJECTS an expression with no future occurrence (February 30th)", () => {
    expect(() =>
      LIVE_CRON.nextRunAfter("0 9 30 2 *", "UTC", at("2026-06-01T10:00:00.000Z")),
    ).toThrow(CronExpressionInvalidError);
  });

  it("carries HTTP 422 on every refusal — a bad cadence is the caller's input error, not an outage", () => {
    for (const [expression, tz] of [
      ["", "UTC"],
      ["0 9 * * *", "Nowhere/Nothing"],
      ["nonsense", "UTC"],
    ] as const) {
      try {
        LIVE_CRON.nextRunAfter(expression, tz, at("2026-06-01T10:00:00.000Z"));
        throw new Error(`expected a refusal for '${expression}' / '${tz}'`);
      } catch (err) {
        expect(err).toBeInstanceOf(CronExpressionInvalidError);
        expect((err as CronExpressionInvalidError).statusCode).toBe(422);
      }
    }
  });
});
