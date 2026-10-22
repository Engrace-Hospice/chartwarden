// WP 2.7b / ADR-0058 - tag derivation, padding, cursor codec and the T arithmetic.
import { hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveOrgDek } from "../src/crypto/body-crypto";
import {
  CANDIDATE_CAP,
  DEFAULT_TAG_BITS,
  MAX_PAGES_PER_QUERY,
  type SearchKeyProvider,
  buildMessageTags,
  decodeSearchCursor,
  deriveChannelKey,
  deriveSearchKey,
  digestExclusion,
  encodeSearchCursor,
  falseCandidateRate,
  headBucketProbability,
  indexTagStrings,
  nameTokenDigest,
  padTags,
  paddedSize,
  shouldResizeTagBits,
  tagArithmetic,
  tagBitsForTotalRows,
  tagForPrefix,
  tagForWord,
  tokenizeForSearch,
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

describe("known-answer vectors (independent HKDF/HMAC reference, fixed inputs)", () => {
  const dek = Buffer.alloc(32, 0x42);
  // An independent reference derivation under the REMOVED legacy label: these vectors pin the tag arithmetic (the encodings), and
  // prove the module no longer derives under that label.
  const legacy = (org: string, version: string): Buffer =>
    Buffer.from(
      hkdfSync("sha256", dek, Buffer.alloc(0), `wardenx-message-search:${org}:${version}`, 32),
    );
  const keyA = legacy(ORG_A, "v1");

  it("deriveSearchKey: HKDF-SHA256, empty salt, info chartwarden-message-search:<org>:<label>; the legacy label is no longer derived", () => {
    expect(keyA.toString("hex")).toBe(
      "478d04a66604da7c9697c06edcfabe1069097599c1757c0fbb9bc73691f70d03",
    );
    expect(legacy(ORG_B, "v1").toString("hex")).toBe(
      "06680fa9f0947e984273f4630cedac1af8680f4b98470da3e2c732808307d636",
    );
    // the SAME DEK with another org, or another label, must give another key
    expect(deriveSearchKey(dek, ORG_A, "v1").equals(keyA)).toBe(false);
    expect(deriveSearchKey(dek, ORG_B, "v1").equals(deriveSearchKey(dek, ORG_A, "v1"))).toBe(false);
    expect(deriveSearchKey(dek, ORG_A, "v2").equals(deriveSearchKey(dek, ORG_A, "v1"))).toBe(false);
  });

  it("the writer's key is the chartwarden label: a literal key (independent Node HKDF) and literal tags", () => {
    const keyW = deriveSearchKey(dek, ORG_A, "v1");
    expect(keyW.toString("hex")).toBe(
      "6ceb092d6799ec6ad124bd0c8f93261fa039860c52b3b68125093056b347cb99",
    );
    expect(keyW.equals(keyA)).toBe(false);
    expect(tagForWord(keyW, "morphine", 19)).toBe(256730);
    expect(tagForPrefix(keyW, "morp", 19)).toBe(248389);
    expect(tagForPrefix(keyW, "mor", 19)).toBe(233133);
  });

  it("tags at T=19 are literal integers over the w\\0 / p\\0 len \\0 encodings (independent reference key)", () => {
    expect(tagForWord(keyA, "morphine", 19)).toBe(427393);
    expect(tagForPrefix(keyA, "morp", 19)).toBe(264399);
    expect(tagForPrefix(keyA, "mor", 19)).toBe(291042);
  });

  it("the same DEK under two org ids yields different tags for the same word", () => {
    const keyB = deriveSearchKey(dek, ORG_B, "v1");
    expect(tagForWord(keyA, "morphine", 19)).not.toBe(tagForWord(keyB, "morphine", 19));
    expect(tagForPrefix(keyA, "morp", 19)).not.toBe(tagForPrefix(keyB, "morp", 19));
  });
});

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

  it("shuffles: a real tag lands in every slot of the padded set", () => {
    const marker = 1_000_000; // a real tag; dummies at T=20 collide with it with probability ~1e-6
    const positions = new Set<number>();
    for (let trial = 0; trial < 600; trial += 1)
      positions.add(padTags([marker], 20).indexOf(marker));
    expect(positions.size).toBe(16);
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
    // alpha 3 + bravo 3 + charlie 3 + delta 3 + echo 2 + foxtrot 3 + golf 2 = 19 real tags -> 32
    expect(buildMessageTags(k, "alpha bravo charlie delta echo foxtrot golf", 19)).toHaveLength(32);
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
      [at, id, MAX_PAGES_PER_QUERY],
      ["2026-10-13", id, 1],
      ["2026-10-13T10:00:00Z", id, 1],
      ["2026-10-13T10:00:00.000+00:00", id, 1],
      ["Oct 13 2026", id, 1],
      ["not-a-date", id, 1],
      [at, "not-a-uuid", 1],
      [at, id, 1, "extra"],
      { createdAt: at },
    ]) {
      expect(decodeSearchCursor(encodeURIComponent(JSON.stringify(bad)))).toBeNull();
    }
  });

  it("pins the page boundary: 0..MAX_PAGES_PER_QUERY - 1 decode, MAX_PAGES_PER_QUERY does not", () => {
    for (const page of [0, MAX_PAGES_PER_QUERY - 1]) {
      expect(
        decodeSearchCursor(encodeSearchCursor({ createdAt: at, messageId: id, page }))?.page,
      ).toBe(page);
    }
    expect(MAX_PAGES_PER_QUERY).toBe(5);
    for (const page of [MAX_PAGES_PER_QUERY, MAX_PAGES_PER_QUERY + 1]) {
      expect(
        decodeSearchCursor(encodeSearchCursor({ createdAt: at, messageId: id, page })),
      ).toBeNull();
    }
  });

  it("refuses an oversized raw cursor before decoding it", () => {
    expect(decodeSearchCursor("a".repeat(100_000))).toBeNull();
    expect(decodeSearchCursor("%5B".repeat(200))).toBeNull();
  });

  it("encodes only the keyset: no tag, token or query-derived value", () => {
    const encoded = decodeURIComponent(
      encodeSearchCursor({ createdAt: at, messageId: id, page: 0 }),
    );
    expect(JSON.parse(encoded)).toEqual([at, id, 0]);
  });
});

describe("T arithmetic (ADR-0058 table, recomputed from its stated assumptions)", () => {
  // Sparse prefix set {3,5,8,12} (2026-10-13): D = 1e5 whole-word + ~1e5 prefix tags = 2e5; n ~ 14.5 real tags per message
  // pads to N = 16, so 5e6 x 16 = 8e7 rows (7.25e7 real, 7.5e6 dummy).
  const D = 2e5;
  const ROWS = 8e7;
  // [T, tags per bucket, share sharing, rows per bucket] as printed in the ADR (rounded)
  const TABLE: ReadonlyArray<readonly [number, number, number, number]> = [
    [20, 0.19, 0.17, 76],
    [19, 0.38, 0.32, 153],
    [18, 0.76, 0.53, 305],
    [17, 1.53, 0.78, 610],
    [16, 3.05, 0.95, 1221],
  ];
  it.each(TABLE)("T=%i", (t, perBucket, share, rows) => {
    const a = tagArithmetic(t, D, ROWS);
    expect(a.tagsPerBucket).toBeCloseTo(perBucket, 1);
    expect(a.shareSharingBucket).toBeCloseTo(share, 2);
    expect(a.rowsPerBucket).toBeCloseTo(rows, -0.5);
  });

  it("T=24 and T=32 rows of the table", () => {
    const t24 = tagArithmetic(24, D, ROWS);
    expect(t24.tagsPerBucket).toBeCloseTo(0.012, 3);
    expect(t24.shareSharingBucket).toBeCloseTo(0.012, 3); // ADR prints 1.2% (exact 1.19%)
    expect(t24.rowsPerBucket).toBeCloseTo(4.8, 1);
    const t32 = tagArithmetic(32, D, ROWS);
    expect(t32.tagsPerBucket).toBeCloseTo(4.7e-5, 6);
    expect(t32.shareSharingBucket).toBeCloseTo(0.00005, 5);
    expect(t32.rowsPerBucket).toBeCloseTo(0.019, 3);
  });

  it("the chosen T=19 numbers: 153 rows per bucket, 138 real + 14 dummy, 203 candidates for m=50", () => {
    const a = tagArithmetic(DEFAULT_TAG_BITS, D, ROWS);
    expect(a.rowsPerBucket).toBeCloseTo(153, 0);
    expect(tagArithmetic(19, D, 7.25e7).rowsPerBucket).toBeCloseTo(138, 0);
    expect(tagArithmetic(19, D, 7.5e6).rowsPerBucket).toBeCloseTo(14, 0);
    expect(50 + a.rowsPerBucket).toBeLessThan(CANDIDATE_CAP);
    expect(falseCandidateRate(50, a.rowsPerBucket)).toBeCloseTo(0.75, 2);
    expect(falseCandidateRate(500, a.rowsPerBucket)).toBeCloseTo(0.23, 2);
    // With the sparse set T = 18 (355 candidates for m=50) still fits the cap; T = 17 (660) is the first to exceed it.
    expect(50 + tagArithmetic(18, D, ROWS).rowsPerBucket).toBeLessThan(CANDIDATE_CAP);
    expect(50 + tagArithmetic(17, D, ROWS).rowsPerBucket).toBeGreaterThan(CANDIDATE_CAP);
  });

  it("multi-word false candidates and the tail bound", () => {
    const perMessage = 153 / 5e6;
    expect(5e6 * perMessage ** 2).toBeCloseTo(0.0047, 3);
    expect(headBucketProbability(19, 5000)).toBeCloseTo(0.0095, 4);
    expect(headBucketProbability(19, 3e4)).toBeCloseTo(0.056, 3);
    expect(headBucketProbability(18, 5000)).toBeCloseTo(0.019, 3);
    expect(headBucketProbability(18, 3e4)).toBeCloseTo(0.108, 3);
    expect(headBucketProbability(16, 5000)).toBeCloseTo(0.074, 2); // ADR prints 7.4% (exact 7.35%)
    expect(headBucketProbability(16, 3e4)).toBeCloseTo(0.367, 3);
  });

  it("H2 sizing rule T = clamp(round(log2(totalRows / 150)), 12, 20) recomputes the ADR table", () => {
    // The reference tenant's 8e7 stored rows give the chosen 19; every table row's own rows-per-bucket figure maps back to its T.
    expect(tagBitsForTotalRows(ROWS)).toBe(19);
    // ... and it picks the table row whose rows-per-bucket is closest (in log2) to the 150 target.
    const nearest = [...TABLE].sort(
      (a, b) => Math.abs(Math.log2(a[3] / 150)) - Math.abs(Math.log2(b[3] / 150)),
    )[0];
    expect(nearest?.[0]).toBe(tagBitsForTotalRows(ROWS));
    for (const [t, , , rows] of TABLE) {
      expect(tagArithmetic(t, D, ROWS).rowsPerBucket).toBeCloseTo(rows, -0.5);
      expect(tagBitsForTotalRows(150 * 2 ** t)).toBe(Math.min(20, Math.max(12, t)));
    }
    expect(tagBitsForTotalRows(ROWS / 10)).toBe(16); // a tenant ten times smaller
    expect(tagBitsForTotalRows(null)).toBe(19);
    expect(tagBitsForTotalRows(0)).toBe(19);
    expect(tagBitsForTotalRows(10)).toBe(12);
    expect(tagBitsForTotalRows(1e12)).toBe(20);
  });

  it("a stored T is rebuilt only when the rule differs by 2 or more bits", () => {
    expect(shouldResizeTagBits(19, ROWS)).toBe(false);
    expect(shouldResizeTagBits(18, ROWS)).toBe(false); // one bit off is rounding, not a reason to take search down
    expect(shouldResizeTagBits(17, ROWS)).toBe(true);
    expect(shouldResizeTagBits(19, ROWS / 8)).toBe(true);
    expect(shouldResizeTagBits(12, 0)).toBe(false); // an empty index is never "resized" to the unknown-tenant default
  });
});

describe("per-channel keys and name exclusion", () => {
  const searchKey = deriveSearchKey(Buffer.alloc(32, 0x42), ORG_A, "v1");
  const CH1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const CH2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  it("a channel key is deterministic and bound to channel, T and version", () => {
    const k = deriveChannelKey(searchKey, "v1", 19, CH1);
    expect(k).toHaveLength(32);
    expect(deriveChannelKey(searchKey, "v1", 19, CH1).equals(k)).toBe(true);
    expect(deriveChannelKey(searchKey, "v1", 19, CH2).equals(k)).toBe(false);
    expect(deriveChannelKey(searchKey, "v1", 18, CH1).equals(k)).toBe(false);
    expect(deriveChannelKey(searchKey, "v2", 19, CH1).equals(k)).toBe(false);
    expect(k.equals(searchKey)).toBe(false);
  });

  it("the same word has unrelated tags in two channels (a bucket is not a cross-channel label)", () => {
    const a = deriveChannelKey(searchKey, "v1", 19, CH1);
    const b = deriveChannelKey(searchKey, "v1", 19, CH2);
    const words = [
      "morphine",
      "hospice",
      "agitation",
      "lorazepam",
      "family",
      "visit",
      "nausea",
      "dyspnea",
    ];
    const same = words.filter((w) => tagForWord(a, w, 19) === tagForWord(b, w, 19));
    expect(same.length).toBeLessThanOrEqual(1); // chance collision only: 8 words at p = 2^-19
  });

  it("excluded name tokens produce no whole-word and no prefix tag, and are dropped like a stop word", () => {
    const excluded = digestExclusion(searchKey, new Set([nameTokenDigest(searchKey, "lindqvist")]));
    expect(tokenizeForSearch("Mrs Lindqvist needs morphine", excluded)).toEqual([
      "mrs",
      "needs",
      "morphine",
    ]);
    expect(tokenizeForSearch("Mrs Lindqvist needs morphine")).toContain("lindqvist");
    const ch = deriveChannelKey(searchKey, "v1", 19, CH1);
    const withName = new Set(indexTagStrings(tokenizeForSearch("lindqvist")).map((i) => i));
    expect(withName.size).toBeGreaterThan(1); // whole word + prefixes exist without exclusion
    // with exclusion a body that is ONLY the name has no real tags: padded dummies only (16 rows)
    expect(buildMessageTags(ch, "lindqvist", 19, excluded)).toHaveLength(16);
    expect(indexTagStrings(tokenizeForSearch("lindqvist", excluded))).toEqual([]);
  });

  it("the name digest is keyed: another key gives another digest, and it never equals a tag input", () => {
    const other = deriveSearchKey(Buffer.alloc(32, 0x43), ORG_A, "v1");
    expect(nameTokenDigest(searchKey, "lindqvist")).toHaveLength(16);
    expect(nameTokenDigest(searchKey, "lindqvist")).not.toBe(nameTokenDigest(other, "lindqvist"));
    expect(digestExclusion(searchKey, new Set()).has("lindqvist")).toBe(false);
  });
});
