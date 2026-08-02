// M35-T03 — §D6 pseudonym hasher (W-SB-08 property test).
import { describe, expect, it } from "vitest";
import { BILLING_PSEUDONYM_HEX_LENGTH, computeBillingPseudonym, isBillingPseudonym } from "../src/pseudonym/hasher";
import { isValidBillingPseudonym } from "../src/domain/validation";

const KEY = "epoch-2026-01-secret-material";

describe("computeBillingPseudonym (D6)", () => {
  it("produces a 32-lowercase-hex digest that satisfies the §2.3 CHECK", () => {
    const p = computeBillingPseudonym(KEY, "a1b2c3d4-0000-0000-0000-000000000001");
    expect(p).toHaveLength(BILLING_PSEUDONYM_HEX_LENGTH);
    expect(isValidBillingPseudonym(p)).toBe(true);
    expect(isBillingPseudonym(p)).toBe(true);
  });

  it("is deterministic within a key epoch (same subject → same pseudonym)", () => {
    const a = computeBillingPseudonym(KEY, "patient-x");
    const b = computeBillingPseudonym(KEY, "patient-x");
    expect(a).toBe(b);
  });

  it("distinguishes different subjects and different key epochs", () => {
    expect(computeBillingPseudonym(KEY, "patient-x")).not.toBe(computeBillingPseudonym(KEY, "patient-y"));
    expect(computeBillingPseudonym(KEY, "patient-x")).not.toBe(
      computeBillingPseudonym("epoch-2026-07-secret", "patient-x"),
    );
  });

  it("never emits a raw UUID (36-char, dashed) into the pseudonym keyspace", () => {
    const raw = "a1b2c3d4-0000-0000-0000-000000000001";
    const p = computeBillingPseudonym(KEY, raw);
    expect(p).not.toBe(raw);
    expect(isValidBillingPseudonym(raw)).toBe(false);
  });

  it("refuses empty key material or subject", () => {
    expect(() => computeBillingPseudonym("", "x")).toThrow();
    expect(() => computeBillingPseudonym(KEY, "")).toThrow();
  });
});
