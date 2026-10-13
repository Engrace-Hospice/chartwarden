// M36 WP 2.13 / ADR-0058 P1 — the backfill's escrow-drill gate and the fail-closed legacy-key boot check.
import { describe, expect, it } from "vitest";
import {
  LegacyBodyKeyMissingError,
  assertLegacyBodyKeyAvailable,
} from "../src/modules/36-messaging/body-legacy-key-check";
import {
  BODY_BACKFILL_ESCROW_DRILL_ENV,
  BodyBackfillRefusedError,
  assertBodyBackfillAllowed,
} from "../src/modules/36-messaging/jobs/body-backfill";

describe("backfill escrow-drill gate (ADR-0058 P1 precondition)", () => {
  const prod = { NODE_ENV: "production" } as NodeJS.ProcessEnv;

  it("refuses a real run in production unless the drill is confirmed, with the flag name in the message", () => {
    expect(() => assertBodyBackfillAllowed(prod, false)).toThrow(BodyBackfillRefusedError);
    expect(() => assertBodyBackfillAllowed(prod, false)).toThrow(BODY_BACKFILL_ESCROW_DRILL_ENV);
    for (const v of ["", "false", "1", "yes"]) {
      expect(() =>
        assertBodyBackfillAllowed({ ...prod, [BODY_BACKFILL_ESCROW_DRILL_ENV]: v }, false),
      ).toThrow(BodyBackfillRefusedError);
    }
  });

  it("allows it once confirmed, a dry run anywhere, and any run outside production", () => {
    expect(() =>
      assertBodyBackfillAllowed({ ...prod, [BODY_BACKFILL_ESCROW_DRILL_ENV]: " TRUE " }, false),
    ).not.toThrow();
    expect(() => assertBodyBackfillAllowed(prod, true)).not.toThrow();
    expect(() => assertBodyBackfillAllowed({ NODE_ENV: "development" }, false)).not.toThrow();
    expect(() => assertBodyBackfillAllowed({}, false)).not.toThrow();
  });
});

describe("legacy body key boot check (fail closed in production)", () => {
  const key = Buffer.alloc(32, 9).toString("base64");
  const legacy = { message: 3, message_revision: 1 };
  const none = { message: 0, message_revision: 0 };

  it("production + legacy rows + key missing or malformed fails closed", () => {
    expect(() => assertLegacyBodyKeyAvailable(legacy, { NODE_ENV: "production" })).toThrow(
      LegacyBodyKeyMissingError,
    );
    expect(() =>
      assertLegacyBodyKeyAvailable(legacy, {
        NODE_ENV: "production",
        MESSAGING_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64"),
      }),
    ).toThrow(LegacyBodyKeyMissingError);
  });

  it("reports (never throws) for the other combinations", () => {
    const prodKey = { NODE_ENV: "production", MESSAGING_ENCRYPTION_KEY: key };
    expect(assertLegacyBodyKeyAvailable(legacy, prodKey)).toMatchObject({
      state: "legacy_rows_key_present",
      legacyRows: { total: 4 },
    });
    expect(assertLegacyBodyKeyAvailable(none, { NODE_ENV: "production" }).state).toBe("ring_only");
    expect(assertLegacyBodyKeyAvailable(legacy, { NODE_ENV: "development" }).state).toBe(
      "legacy_rows_key_missing",
    );
  });
});
