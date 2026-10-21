// GAP-032 - the pure pacing / idempotency rules of the SOS terminus ledger (no database).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SAFETY_TERMINUS_ACTION_KINDS,
  SAFETY_TERMINUS_ACTION_STATUSES,
  SAFETY_TERMINUS_OUTCOME_CODES,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";

import {
  DIAL_MAX_ATTEMPTS,
  DIAL_REDIAL_SPACING_MS,
  dialIdempotencyKey,
  planDialAttempt,
  retryBackoffMs,
  terminusIdempotencyKey,
} from "../src/modules/20-field-safety/terminus/policy";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

type Row = Parameters<typeof planDialAttempt>[0]["priorDialRows"][number];
const row = (over: Partial<Row>): Row => ({
  attemptNo: 0,
  status: "failed",
  outcomeCode: "vendor_refused",
  settledAt: ago(DIAL_REDIAL_SPACING_MS + 1),
  ...over,
});

describe("planDialAttempt", () => {
  it("inserts attempt 0 when no dial has ever been planned", () => {
    expect(planDialAttempt({ priorDialRows: [], now: NOW })).toEqual({
      kind: "insert",
      attemptNo: 0,
    });
  });

  it("does nothing while a dial is pending or in flight", () => {
    for (const status of ["pending", "attempting"] as const) {
      expect(
        planDialAttempt({ priorDialRows: [row({ status, settledAt: null })], now: NOW }),
      ).toEqual({ kind: "none" });
    }
  });

  it("never repeats a call the vendor accepted", () => {
    expect(
      planDialAttempt({
        priorDialRows: [row({ status: "succeeded", outcomeCode: "ok" })],
        now: NOW,
      }),
    ).toEqual({ kind: "none" });
  });

  it("does not redial a terminal skip (no consent, bad number, dial disabled)", () => {
    for (const outcomeCode of [
      "consent_absent",
      "number_invalid",
      "dial_disabled",
      "voice_unbound",
    ]) {
      expect(
        planDialAttempt({
          priorDialRows: [row({ status: "skipped", outcomeCode: outcomeCode as never })],
          now: NOW,
        }),
      ).toEqual({ kind: "none" });
    }
  });

  it("holds a redial back for 9 minutes and releases it at 10", () => {
    const nine = row({ settledAt: ago(DIAL_REDIAL_SPACING_MS - 60_000) });
    expect(planDialAttempt({ priorDialRows: [nine], now: NOW })).toEqual({ kind: "none" });
    const ten = row({ settledAt: ago(DIAL_REDIAL_SPACING_MS) });
    expect(planDialAttempt({ priorDialRows: [ten], now: NOW })).toEqual({
      kind: "insert",
      attemptNo: 1,
    });
  });

  it("stops at the attempt cap", () => {
    const rows = Array.from({ length: DIAL_MAX_ATTEMPTS }, (_, i) => row({ attemptNo: i }));
    expect(planDialAttempt({ priorDialRows: rows, now: NOW })).toEqual({ kind: "none" });
  });

  it("numbers the next attempt after the highest prior attempt", () => {
    const rows = [row({ attemptNo: 0 }), row({ attemptNo: 1 })];
    expect(planDialAttempt({ priorDialRows: rows, now: NOW })).toEqual({
      kind: "insert",
      attemptNo: 2,
    });
  });
});

describe("terminus idempotency keys", () => {
  it("is stable per (alert, kind, iteration, attempt) and distinct across them", () => {
    const a = terminusIdempotencyKey("sos-1", "page_ops", 2, 0);
    expect(a).toBe(terminusIdempotencyKey("sos-1", "page_ops", 2, 0));
    expect(a).not.toBe(terminusIdempotencyKey("sos-1", "page_ops", 3, 0));
    expect(a).not.toBe(terminusIdempotencyKey("sos-1", "dial_contact", 2, 0));
    expect(dialIdempotencyKey("sos-1", 0, 1)).toBe("m20:sos:sos-1:dial_contact:0:1");
  });
});

describe("ledger vocabulary mirrors the migration CHECKs", () => {
  const sql = readFileSync(
    join(__dirname, "../../../packages/db/migrations/0900_m20_sos_terminus_action_ledger.sql"),
    "utf8",
  );
  const listIn = (constraint: string): string[] => {
    const m = new RegExp(`"${constraint}" CHECK \\([\\s\\S]*?IN \\(([^)]*)\\)`).exec(sql);
    return (m?.[1] ?? "").match(/'([a-z0-9_]+)'/g)?.map((s) => s.replaceAll("'", "")) ?? [];
  };
  it("keeps kinds, statuses and outcome codes in lock-step with @chartwarden/types", () => {
    expect(listIn("m20_ssta_kind")).toEqual([...SAFETY_TERMINUS_ACTION_KINDS]);
    expect(listIn("m20_ssta_outcome")).toEqual([...SAFETY_TERMINUS_OUTCOME_CODES]);
    // m20_ssta_status is `"status" IN (...)`, the same shape.
    expect(listIn("m20_ssta_status")).toEqual([...SAFETY_TERMINUS_ACTION_STATUSES]);
  });
});

describe("retryBackoffMs", () => {
  it("grows from 15s and caps at 60s", () => {
    expect(retryBackoffMs(1)).toBe(15_000);
    expect(retryBackoffMs(2)).toBe(30_000);
    expect(retryBackoffMs(3)).toBe(60_000);
    expect(retryBackoffMs(9)).toBe(60_000);
  });
});
