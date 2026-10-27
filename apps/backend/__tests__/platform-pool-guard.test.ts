// A platform cron whose active-org fan-out needs DATABASE_PLATFORM_URL must not register at all without it:
// the enumerator rejects on every tick (fail-loud by design), and a worker that can only ever fail floods the
// DLQ alert log. M35/M4 already skip with a warning; this guard is the shared form of that check.
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it, vi } from "vitest";
import { hasPlatformPool } from "../src/bootstrap/platform-pool-guard";

const fakePool = {} as DbClient;

describe("hasPlatformPool", () => {
  it("returns true and stays silent when the platform pool is configured", () => {
    const warn = vi.fn();

    expect(hasPlatformPool(fakePool, "M6 admission crons", warn)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns false and warns once, naming the cron and the missing variable, when it is not", () => {
    const warn = vi.fn();

    expect(hasPlatformPool(undefined, "M6 admission crons", warn)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "M6 admission crons disabled: DATABASE_PLATFORM_URL (active-org fan-out) is required",
    );
  });

  it("appends the consequence so an operator knows what stays undone", () => {
    const warn = vi.fn();

    hasPlatformPool(undefined, "M6 admission crons", warn, "due-reminder jobs will not run");

    expect(warn).toHaveBeenCalledWith(
      "M6 admission crons disabled: DATABASE_PLATFORM_URL (active-org fan-out) is required — due-reminder jobs will not run",
    );
  });
});
