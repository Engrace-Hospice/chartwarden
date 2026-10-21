import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { nextScanAfter } from "./retention-governance-service";
import { isLegalHoldViolation, rejectIfUnderLegalHold } from "./under-hold";

describe("nextScanAfter (weekly Sunday 02:00 UTC)", () => {
  it("returns the coming Sunday 02:00 UTC from midweek", () => {
    expect(nextScanAfter(new Date("2026-10-21T15:30:00Z")).toISOString()).toBe(
      "2026-10-25T02:00:00.000Z",
    );
  });
  it("returns the same day when it is Sunday before 02:00", () => {
    expect(nextScanAfter(new Date("2026-10-25T01:59:59Z")).toISOString()).toBe(
      "2026-10-25T02:00:00.000Z",
    );
  });
  it("rolls a week when it is Sunday at or after 02:00", () => {
    expect(nextScanAfter(new Date("2026-10-25T02:00:00Z")).toISOString()).toBe(
      "2026-11-01T02:00:00.000Z",
    );
  });
});

describe("legal-hold backstop mapping", () => {
  it("recognises SQLSTATE 23001 directly and as a driver cause", () => {
    expect(isLegalHoldViolation({ code: "23001" })).toBe(true);
    expect(isLegalHoldViolation(new Error("x", { cause: { code: "23001" } }))).toBe(true);
    expect(isLegalHoldViolation({ code: "23505" })).toBe(false);
    expect(isLegalHoldViolation(null)).toBe(false);
  });
  it("turns the trigger refusal into a typed 409 and passes other errors through", async () => {
    const err = await rejectIfUnderLegalHold(async () => {
      throw { code: "23001" };
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChartWardenError);
    expect((err as ChartWardenError).code).toBe("MESSAGE_UNDER_LEGAL_HOLD");
    expect((err as ChartWardenError).statusCode).toBe(409);
    await expect(
      rejectIfUnderLegalHold(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
