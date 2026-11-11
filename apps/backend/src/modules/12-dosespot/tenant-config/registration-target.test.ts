import type { DbClient } from "@chartwarden/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BINDINGS_LOCK_WAIT_MS, vendorWriteIsCurrent } from "./registration-target";

const ORG = "11111111-1111-4111-8111-111111111111";

afterEach(() => vi.useRealTimers());

describe("the vendor-binding advisory-lock wait", () => {
  it("uses a monotonic deadline, so moving wall time backward cannot extend the five-second bound", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
    let attempts = 0;
    const tx = {
      execute: async () => {
        attempts += 1;
        return { rows: [{ locked: false }] };
      },
    } as unknown as DbClient;

    const result = vendorWriteIsCurrent(tx, ORG, "sandbox:clinic-1");
    await vi.advanceTimersByTimeAsync(BINDINGS_LOCK_WAIT_MS - 100);
    vi.setSystemTime(new Date("2026-11-10T11:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toBe(false);
    expect(attempts).toBeGreaterThan(1);
  });
});
