import { canonicalJson, contentHashSha256 } from "@chartwarden/cost-report";
// @chartwarden/cost-report — M27 snapshot canonicalization + content hash (D10) pure-domain unit tests.
//
// canonicalJson must be independent of object key insertion order at EVERY depth (the precondition for
// a stable content hash), while preserving array order (semantically meaningful). contentHashSha256
// must be deterministic for logically-identical inputs and must change when ANY field changes — the
// SNAPSHOT_CORRUPTED tamper-detection guarantee (§2.3 / §7.5).
import { describe, expect, it } from "vitest";

describe("canonicalJson — key-order stability", () => {
  it("shuffled top-level keys produce an identical string", () => {
    const a = { gamma: 3, alpha: 1, beta: 2 };
    const b = { beta: 2, gamma: 3, alpha: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("sorts keys at every nesting depth", () => {
    const a = { outer: { z: 1, a: 2 }, first: { y: 9, b: 8 } };
    const b = { first: { b: 8, y: 9 }, outer: { a: 2, z: 1 } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    // and the emitted key order is lexicographic
    expect(canonicalJson(a)).toBe('{"first":{"b":8,"y":9},"outer":{"a":2,"z":1}}');
  });

  it("preserves array order (order is meaningful)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it("sorts keys inside array elements without reordering the array", () => {
    const v = [
      { b: 1, a: 2 },
      { d: 3, c: 4 },
    ];
    expect(canonicalJson(v)).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
  });

  it("collapses Date via toJSON to match JSON.stringify semantics", () => {
    const d = new Date("2026-06-27T00:00:00.000Z");
    expect(canonicalJson({ when: d })).toBe('{"when":"2026-06-27T00:00:00.000Z"}');
  });

  it("passes primitives through unchanged", () => {
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
  });
});

describe("contentHashSha256 — determinism + tamper detection", () => {
  const snapshot = {
    providerEntityId: "pe-1",
    fiscalYearEnd: "2025-12-31",
    worksheets: { A: { line1: 1000, line2: 2000 }, S: { days: 365 } },
    totals: { aggregateCost: 3000 },
  };

  it("is a 64-char lowercase hex digest", () => {
    expect(contentHashSha256(snapshot)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for logically-identical inputs (shuffled key order)", () => {
    const reordered = {
      totals: { aggregateCost: 3000 },
      worksheets: { S: { days: 365 }, A: { line2: 2000, line1: 1000 } },
      fiscalYearEnd: "2025-12-31",
      providerEntityId: "pe-1",
    };
    expect(contentHashSha256(reordered)).toBe(contentHashSha256(snapshot));
  });

  it("changes when a numeric field is tampered (one cent off)", () => {
    const tampered = {
      ...snapshot,
      worksheets: { ...snapshot.worksheets, A: { line1: 1001, line2: 2000 } },
    };
    expect(contentHashSha256(tampered)).not.toBe(contentHashSha256(snapshot));
  });

  it("changes when a string field is tampered", () => {
    const tampered = { ...snapshot, providerEntityId: "pe-2" };
    expect(contentHashSha256(tampered)).not.toBe(contentHashSha256(snapshot));
  });

  it("changes when a field is added", () => {
    const extra = { ...snapshot, extra: true };
    expect(contentHashSha256(extra)).not.toBe(contentHashSha256(snapshot));
  });
});
