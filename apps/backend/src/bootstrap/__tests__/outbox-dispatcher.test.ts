// TASK-006 — pure decision surface of the outbox dispatcher. The relay's DB behavior (claim /
// finalize / DLQ / purge under RLS) is exercised by the live-cluster suite (TASK-007 adds the CI
// row); what is unit-testable without a database is the backoff math the retry clock runs on.
import { describe, expect, it } from "vitest";
import { outboxBackoffMs } from "../outbox-dispatcher";

describe("outboxBackoffMs", () => {
  it("doubles per attempt from the base (attempt is 1-based)", () => {
    expect(outboxBackoffMs(1, 5_000, 900_000)).toBe(5_000);
    expect(outboxBackoffMs(2, 5_000, 900_000)).toBe(10_000);
    expect(outboxBackoffMs(3, 5_000, 900_000)).toBe(20_000);
    expect(outboxBackoffMs(6, 5_000, 900_000)).toBe(160_000);
  });

  it("caps at the ceiling instead of growing unboundedly", () => {
    expect(outboxBackoffMs(20, 5_000, 900_000)).toBe(900_000);
  });

  it("treats a degenerate attempt 0 as the base delay (never negative/zero backoff)", () => {
    expect(outboxBackoffMs(0, 5_000, 900_000)).toBe(5_000);
  });
});
