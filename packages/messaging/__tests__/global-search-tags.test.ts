// WP 2.7b / ADR-0058 - tag derivation, padding, cursor codec and the T arithmetic.
import { describe, expect, it } from "vitest";
import { deriveOrgDek } from "../src/crypto/body-crypto";
import {
  CANDIDATE_CAP,
  DEFAULT_TAG_BITS,
  type SearchKeyProvider,
  buildMessageTags,
  decodeSearchCursor,
  deriveSearchKey,
  encodeSearchCursor,
  falseCandidateRate,
  headBucketProbability,
  padTags,
  paddedSize,
  tagArithmetic,
  tagBitsForDistinctTags,
  tagForPrefix,
  tagForWord,
} from "../src/search/global";

const KEK = Buffer.alloc(32, 7);
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

/** Test stub of the port: the legacy HKDF DEK, label "legacy". No production wiring exists in C1. */
const stubProvider: SearchKeyProvider = {
  activeVersion: async () => "legacy",
  liveVersions: async () => ["legacy"],
  tagKey: async (orgId, version) => deriveSearchKey(deriveOrgDek(KEK, orgId), orgId, version),
};

describe("search key and tags", () => {
  it("derives K_search with the version TEXT label and a domain-separated info string", () => {
    const dek = deriveOrgDek(KEK, ORG_A);
    const k = deriveSearchKey(dek, ORG_A, "v1");
    expect(k).toHaveLength(32);
    expect(k.equals(dek)).toBe(false);
    expect(k.equals(deriveSearchKey(dek, ORG_A, "v1"))).toBe(true);
  });

  it("tags differ per tenant and per key version, and are deterministic", async () => {
    const a = await stubProvider.tagKey(ORG_A, "legacy");
    const b = await stubProvider.tagKey(ORG_B, "legacy");
    const dekA = deriveOrgDek(KEK, ORG_A);
    const a2 = deriveSearchKey(dekA, ORG_A, "v2");
    expect(tagForWord(a, "morphine", 19)).toBe(tagForWord(a, "morphine", 19));
    expect(tagForWord(a, "morphine", 20)).not.toBe(tagForWord(b, "morphine", 20));
    const sameWord = [a, b, a2].map((k) => tagForWord(k, "morphine", 20));
    expect(new Set(sameWord).size).toBe(3);
  });

  it("separates whole-word and prefix tags and keeps them under 2^T", async () => {
    const k = await stubProvider.tagKey(ORG_A, "legacy");
    expect(tagForWord(k, "mor", 20)).not.toBe(tagForPrefix(k, "mor", 20));
    for (const t of [12, 19, 20]) {
      for (const w of ["alpha", "bravo", "charlie", "delta"]) {
        const v = tagForWord(k, w, t);
        expect(Number.isInteger(v) && v >= 0 && v < 2 ** t).toBe(true);
      }
    }
  });

  it("truncates to the FIRST T bits of the 32-bit HMAC prefix (T=19 is the T=20 value >> 1)", async () => {
    const k = await stubProvider.tagKey(ORG_A, "legacy");
    expect(tagForWord(k, "morphine", 19)).toBe(tagForWord(k, "morphine", 20) >> 1);
    expect(tagForPrefix(k, "morp", 12)).toBe(tagForPrefix(k, "morp", 20) >> 8);
  });

  it("rejects an out-of-range tag width", async () => {
    const k = await stubProvider.tagKey(ORG_A, "legacy");
    expect(() => tagForWord(k, "morphine", 21)).toThrow(RangeError);
    expect(() => tagForWord(k, "morphine", 11)).toThrow(RangeError);
  });
});

describe("padding (ADR-0058 decision 4)", () => {
  it("N = max(16, 2^ceil(log2 n)), 16 when n = 0", () => {
    const cases: ReadonlyArray<readonly [number, number]> = [
      [0, 16],
      [1, 16],
      [7, 16],
      [16, 16],
      [17, 32],
      [24, 32],
      [32, 32],
      [33, 64],
      [100, 128],
      [1025, 2048],
    ];
    for (const [n, expected] of cases) expect(paddedSize(n)).toBe(expected);
  });

  it("pads to N with uniform T-bit dummies, drawn fresh on every call", () => {
    const real = [1, 2, 3, 4, 5, 6, 7];
    const one = padTags(real, 19);
    const two = padTags(real, 19);
    expect(one).toHaveLength(16);
    expect(two).toHaveLength(16);
    expect(one.every((t) => Number.isInteger(t) && t >= 0 && t < 2 ** 19)).toBe(true);
    // the real tags survive and the dummy multiset differs between two replaces of the same message
    for (const r of real) expect(one).toContain(r);
    expect([...one].sort((x, y) => x - y)).not.toEqual([...two].sort((x, y) => x - y));
    // an n = 0 message is padded too, so "no indexable content" is not distinguishable
    expect(padTags([], 19)).toHaveLength(16);
  });

  it("does not leave real tags first (order carries no meaning)", () => {
    const real = Array.from({ length: 8 }, (_, i) => i);
    const firstEightReal = Array.from({ length: 30 }, () => padTags(real, 20).slice(0, 8)).filter(
      (head) => head.every((t, i) => t === i),
    );
    expect(firstEightReal.length).toBeLessThan(30);
  });

  it("dummies are roughly uniform over the T-bit range", () => {
    const dummies = padTags([], 12).concat(...Array.from({ length: 200 }, () => padTags([], 12)));
    const high = dummies.filter((t) => t >= 2 ** 11).length;
    expect(high / dummies.length).toBeGreaterThan(0.4);
    expect(high / dummies.length).toBeLessThan(0.6);
  });

  it("buildMessageTags pads the real tags of a body", async () => {
    const k = await stubProvider.tagKey(ORG_A, "legacy");
    expect(buildMessageTags(k, "morphine", 19)).toHaveLength(16);
    expect(buildMessageTags(k, "5 mg", 19)).toHaveLength(16);
    // alpha 4 + bravo 4 + charlie 6 + delta 4 + echo 3 = 21 real tags -> 32
    expect(buildMessageTags(k, "alpha bravo charlie delta echo", 19)).toHaveLength(32);
  });
});

describe("cursor codec (created_at, id, page)", () => {
  const id = "33333333-3333-3333-3333-333333333333";
  const at = "2026-10-13T10:00:00.000Z";

  it("round-trips", () => {
    expect(
      decodeSearchCursor(encodeSearchCursor({ createdAt: at, messageId: id, page: 2 })),
    ).toEqual({
      createdAt: at,
      messageId: id,
      page: 2,
    });
  });

  it("rejects tampered, malformed and out-of-range cursors", () => {
    const good = encodeSearchCursor({ createdAt: at, messageId: id, page: 1 });
    expect(decodeSearchCursor(`${good}x`)).toBeNull();
    expect(decodeSearchCursor("")).toBeNull();
    expect(decodeSearchCursor("%E0%A4%A")).toBeNull();
    for (const bad of [
      [at, id],
      [at, id, "1"],
      [at, id, -1],
      [at, id, 1.5],
      [at, id, 99],
      ["not-a-date", id, 1],
      [at, "not-a-uuid", 1],
      [at, id, 1, "extra"],
      { createdAt: at },
    ]) {
      expect(decodeSearchCursor(encodeURIComponent(JSON.stringify(bad)))).toBeNull();
    }
  });

  it("encodes only the keyset: no tag, token or query-derived value", () => {
    const encoded = decodeURIComponent(
      encodeSearchCursor({ createdAt: at, messageId: id, page: 0 }),
    );
    expect(JSON.parse(encoded)).toEqual([at, id, 0]);
  });
});

describe("T arithmetic (ADR-0058 table, recomputed from its stated assumptions)", () => {
  const D = 4e5;
  const ROWS = 1.6e8;
  // [T, tags per bucket, share sharing, rows per bucket] as printed in the ADR (rounded)
  const TABLE: ReadonlyArray<readonly [number, number, number, number]> = [
    [20, 0.38, 0.32, 153],
    [19, 0.76, 0.53, 305],
    [18, 1.53, 0.78, 610],
    [16, 6.1, 0.998, 2441],
  ];
  it.each(TABLE)("T=%i", (t, perBucket, share, rows) => {
    const a = tagArithmetic(t, D, ROWS);
    expect(a.tagsPerBucket).toBeCloseTo(perBucket, 1);
    expect(a.shareSharingBucket).toBeCloseTo(share, 2);
    expect(a.rowsPerBucket).toBeCloseTo(rows, -0.5);
  });

  it("T=24 and T=32 rows of the table", () => {
    const t24 = tagArithmetic(24, D, ROWS);
    expect(t24.tagsPerBucket).toBeCloseTo(0.024, 3);
    expect(t24.shareSharingBucket).toBeCloseTo(0.023, 2); // ADR prints 2.3% (exact 2.36%)
    expect(t24.rowsPerBucket).toBeCloseTo(9.5, 1);
    const t32 = tagArithmetic(32, D, ROWS);
    expect(t32.tagsPerBucket).toBeCloseTo(9.3e-5, 6);
    expect(t32.shareSharingBucket).toBeCloseTo(0.00009, 5);
    expect(t32.rowsPerBucket).toBeCloseTo(0.04, 2);
  });

  it("the chosen T=19 numbers: 305 rows per bucket, 229 real + 76 dummy, 355 candidates for m=50", () => {
    const a = tagArithmetic(DEFAULT_TAG_BITS, D, ROWS);
    expect(a.rowsPerBucket).toBeCloseTo(305, 0);
    expect(tagArithmetic(19, D, 1.2e8).rowsPerBucket).toBeCloseTo(229, 0);
    expect(tagArithmetic(19, D, 4e7).rowsPerBucket).toBeCloseTo(76, 0);
    expect(50 + a.rowsPerBucket).toBeLessThan(CANDIDATE_CAP);
    expect(falseCandidateRate(50, a.rowsPerBucket)).toBeCloseTo(0.86, 2);
    expect(falseCandidateRate(500, a.rowsPerBucket)).toBeCloseTo(0.38, 2);
    // T = 18 already exceeds the cap for the typical rare word
    expect(50 + tagArithmetic(18, D, ROWS).rowsPerBucket).toBeGreaterThan(CANDIDATE_CAP);
  });

  it("multi-word false candidates and the tail bound", () => {
    const perMessage = 305 / 5e6;
    expect(5e6 * perMessage ** 2).toBeCloseTo(0.019, 3);
    expect(headBucketProbability(19, 5000)).toBeCloseTo(0.0095, 4);
    expect(headBucketProbability(19, 3e4)).toBeCloseTo(0.056, 3);
    expect(headBucketProbability(18, 5000)).toBeCloseTo(0.019, 3);
    expect(headBucketProbability(18, 3e4)).toBeCloseTo(0.108, 3);
    expect(headBucketProbability(16, 5000)).toBeCloseTo(0.074, 2); // ADR prints 7.4% (exact 7.35%)
    expect(headBucketProbability(16, 3e4)).toBeCloseTo(0.367, 3);
  });

  it("the per-tenant sizing rule gives 19 for D=4e5, 16 for a tenant ten times smaller, 19 when unknown", () => {
    expect(tagBitsForDistinctTags(4e5)).toBe(19);
    expect(tagBitsForDistinctTags(4e4)).toBe(16);
    expect(tagBitsForDistinctTags(null)).toBe(19);
    expect(tagBitsForDistinctTags(10)).toBe(12);
    expect(tagBitsForDistinctTags(1e9)).toBe(20);
  });
});
