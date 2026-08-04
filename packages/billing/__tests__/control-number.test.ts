import {
  CONTROL_NUMBER_RE,
  type ControlNumberInput,
  deriveControlNumber,
  isValidControlNumber,
  parseControlNumber,
} from "@wardenx/billing";
// @wardenx/billing — M23 deterministic claim_control_number derivation (D4 / §2.6) pure-domain tests.
//
// The control number is the idempotency key BOTH internally (the
// `(provider_entity_id, claim_control_number, attempt_index)` unique index) AND at the MAC. The D4
// invariants under test: (1) collision-freedom — distinct (ccn, service-month, claim-id-prefix, attempt)
// tuples derive DISTINCT control numbers over a ≥10k-tuple fuzz (the 24-bit UUID prefix is the entropy
// source; the DB unique index is the hard backstop); (2) the format/length contract (<23 chars, the
// canonical regex); (3) determinism (identical inputs → identical string); (4) parse round-trips the
// structural segments. Pure: no DB/Fastify/BullMQ; data is injected.
import { describe, expect, it } from "vitest";

/** A valid 6-char CCN pool (the regex permits mixed-case alphanumerics). */
const CCN_POOL = ["381588", "12AB34", "999999", "00000A", "Z1Y2X3", "aaaaaa", "5L7M9N"] as const;
/** A small pool of service-period start months (drives the `yymmdd` segment / per-month namespace). */
const SERVICE_FROM_POOL = [
  "2026-01-15",
  "2026-02-01",
  "2025-12-31",
  "2026-06-28",
  "2024-02-29", // leap day — a valid calendar date
] as const;

/** Deterministically distinct claim UUID whose first 6 hex chars encode `i` (so prefixes never collide). */
function claimIdForIndex(i: number): string {
  const hex6 = i.toString(16).padStart(6, "0");
  return `${hex6}-1111-4111-8111-111111111111`;
}

describe("deriveControlNumber — D4 format + length contract", () => {
  it("produces the canonical `{ccn}-{yymmdd}-{base36(5)}-{attempt:02d}` shape", () => {
    const cn = deriveControlNumber({
      ccn: "381588",
      serviceFrom: "2026-06-01",
      claimId: "09a1bc00-1111-4111-8111-111111111111",
      attemptIndex: 3,
    });
    expect(cn).toMatch(CONTROL_NUMBER_RE);
    const parts = cn.split("-");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("381588");
    expect(parts[1]).toBe("260601");
    expect(parts[2]).toHaveLength(5);
    expect(parts[3]).toBe("03");
  });

  it("is exactly 22 chars (strictly under the 23-char MAC field ceiling)", () => {
    const cn = deriveControlNumber({
      ccn: "381588",
      serviceFrom: "2026-06-01",
      claimId: claimIdForIndex(42),
      attemptIndex: 0,
    });
    expect(cn).toHaveLength(22);
    expect(cn.length).toBeLessThan(23);
    expect(isValidControlNumber(cn)).toBe(true);
  });

  it("zero-pads the attempt index to two digits", () => {
    const cn = deriveControlNumber({
      ccn: "381588",
      serviceFrom: "2026-01-15",
      claimId: claimIdForIndex(7),
      attemptIndex: 5,
    });
    expect(cn.endsWith("-05")).toBe(true);
  });

  it("pads the base36 segment to five chars for a tiny prefix", () => {
    const cn = deriveControlNumber({
      ccn: "381588",
      serviceFrom: "2026-01-15",
      claimId: "00000000-1111-4111-8111-111111111111", // prefix 0 → base36 "00000"
      attemptIndex: 0,
    });
    expect(parseControlNumber(cn)?.claimIdPrefixBase36).toBe("00000");
  });

  it("lowercases the hex prefix before base36 encoding (case-insensitive UUID input)", () => {
    const lower = deriveControlNumber({
      ccn: "381588",
      serviceFrom: "2026-01-15",
      claimId: "00abcd00-1111-4111-8111-111111111111",
      attemptIndex: 0,
    });
    const upper = deriveControlNumber({
      ccn: "381588",
      serviceFrom: "2026-01-15",
      claimId: "00ABCD00-1111-4111-8111-111111111111",
      attemptIndex: 0,
    });
    expect(lower).toBe(upper);
  });

  it("derives the yymmdd from the service-FROM month/day, including a leap day", () => {
    const cn = deriveControlNumber({
      ccn: "999999",
      serviceFrom: "2024-02-29",
      claimId: claimIdForIndex(1),
      attemptIndex: 1,
    });
    expect(parseControlNumber(cn)?.yymmdd).toBe("240229");
  });
});

describe("deriveControlNumber — determinism", () => {
  it("identical inputs always yield the identical string", () => {
    const input: ControlNumberInput = {
      ccn: "381588",
      serviceFrom: "2026-06-01",
      claimId: claimIdForIndex(1234),
      attemptIndex: 4,
    };
    expect(deriveControlNumber(input)).toBe(deriveControlNumber({ ...input }));
  });

  it("trims surrounding whitespace on the CCN before deriving", () => {
    const a = deriveControlNumber({
      ccn: "  381588  ",
      serviceFrom: "2026-06-01",
      claimId: claimIdForIndex(2),
      attemptIndex: 0,
    });
    const b = deriveControlNumber({
      ccn: "381588",
      serviceFrom: "2026-06-01",
      claimId: claimIdForIndex(2),
      attemptIndex: 0,
    });
    expect(a).toBe(b);
  });
});

describe("deriveControlNumber — collision-freedom fuzz (≥10,000 tuples)", () => {
  it("derives DISTINCT control numbers across 12,000 distinct (ccn, month, claim, attempt) tuples", () => {
    const TUPLES = 12_000;
    const seen = new Set<string>();
    for (let i = 0; i < TUPLES; i++) {
      const cn = deriveControlNumber({
        ccn: CCN_POOL[i % CCN_POOL.length]!,
        serviceFrom: SERVICE_FROM_POOL[i % SERVICE_FROM_POOL.length]!,
        claimId: claimIdForIndex(i), // globally distinct 24-bit prefix
        attemptIndex: i % 6,
      });
      // Every derived number must be well-formed AND under the MAC ceiling.
      expect(cn).toMatch(CONTROL_NUMBER_RE);
      expect(cn.length).toBeLessThan(23);
      seen.add(cn);
    }
    // Zero collisions ⇒ the Set retained every one of the 12,000 tuples.
    expect(seen.size).toBe(TUPLES);
  });

  it("the claim-id prefix differentiates two claims sharing the SAME ccn+month+attempt", () => {
    const base = { ccn: "381588", serviceFrom: "2026-01-15", attemptIndex: 0 } as const;
    const a = deriveControlNumber({ ...base, claimId: claimIdForIndex(100) });
    const b = deriveControlNumber({ ...base, claimId: claimIdForIndex(101) });
    expect(a).not.toBe(b);
  });

  it("the attempt index differentiates re-dispatches of the SAME claim", () => {
    const base = {
      ccn: "381588",
      serviceFrom: "2026-01-15",
      claimId: claimIdForIndex(500),
    } as const;
    expect(deriveControlNumber({ ...base, attemptIndex: 0 })).not.toBe(
      deriveControlNumber({ ...base, attemptIndex: 1 }),
    );
  });

  it("the CCN namespace differentiates identical claims at different provider entities", () => {
    const base = {
      serviceFrom: "2026-01-15",
      claimId: claimIdForIndex(900),
      attemptIndex: 0,
    } as const;
    expect(deriveControlNumber({ ...base, ccn: "381588" })).not.toBe(
      deriveControlNumber({ ...base, ccn: "999999" }),
    );
  });
});

describe("deriveControlNumber — malformed-input rejection (throws RangeError)", () => {
  const good = {
    ccn: "381588",
    serviceFrom: "2026-01-15",
    claimId: claimIdForIndex(1),
    attemptIndex: 0,
  } as const;

  it("rejects a CCN that is not 6 chars (too short)", () => {
    expect(() => deriveControlNumber({ ...good, ccn: "12345" })).toThrow(RangeError);
  });

  it("rejects a CCN that is not 6 chars (too long)", () => {
    expect(() => deriveControlNumber({ ...good, ccn: "1234567" })).toThrow(RangeError);
  });

  it("rejects a CCN with a non-alphanumeric char", () => {
    expect(() => deriveControlNumber({ ...good, ccn: "3815-8" })).toThrow(RangeError);
  });

  it("rejects a non-ISO service-from date", () => {
    expect(() => deriveControlNumber({ ...good, serviceFrom: "06/01/2026" })).toThrow(RangeError);
  });

  it("rejects a negative attempt index", () => {
    expect(() => deriveControlNumber({ ...good, attemptIndex: -1 })).toThrow(RangeError);
  });

  it("rejects an attempt index above 99", () => {
    expect(() => deriveControlNumber({ ...good, attemptIndex: 100 })).toThrow(RangeError);
  });

  it("rejects a non-integer attempt index", () => {
    expect(() => deriveControlNumber({ ...good, attemptIndex: 1.5 })).toThrow(RangeError);
  });

  it("rejects a claim id that yields fewer than 6 leading hex chars", () => {
    expect(() => deriveControlNumber({ ...good, claimId: "abc" })).toThrow(RangeError);
  });

  it("rejects a claim id whose leading chars are non-hex", () => {
    expect(() =>
      deriveControlNumber({ ...good, claimId: "ghijkl00-1111-4111-8111-111111111111" }),
    ).toThrow(RangeError);
  });
});

describe("parseControlNumber — total parse (never throws) + round-trip", () => {
  it("round-trips the structural segments of every derived number", () => {
    for (let i = 0; i < 250; i++) {
      const ccn = CCN_POOL[i % CCN_POOL.length]!;
      const serviceFrom = SERVICE_FROM_POOL[i % SERVICE_FROM_POOL.length]!;
      const attemptIndex = i % 100;
      const cn = deriveControlNumber({
        ccn,
        serviceFrom,
        claimId: claimIdForIndex(i),
        attemptIndex,
      });
      const parsed = parseControlNumber(cn);
      expect(parsed).not.toBeNull();
      expect(parsed!.ccn).toBe(ccn);
      expect(parsed!.yymmdd).toBe(serviceFrom.slice(2).replace(/-/g, ""));
      expect(parsed!.attemptIndex).toBe(attemptIndex);
      // The parsed prefix recovers the original 24-bit value.
      expect(Number.parseInt(parsed!.claimIdPrefixBase36, 36)).toBe(i);
    }
  });

  it("returns null for a structurally malformed string", () => {
    expect(parseControlNumber("not-a-control-number")).toBeNull();
    expect(parseControlNumber("381588-260601-zz-03")).toBeNull(); // base36 segment wrong width
    expect(parseControlNumber("38158-260601-00abc-03")).toBeNull(); // 5-char ccn
    expect(parseControlNumber("")).toBeNull();
  });

  it("returns null when the base36 segment contains an uppercase char", () => {
    expect(parseControlNumber("381588-260601-00ABc-03")).toBeNull();
  });
});

describe("isValidControlNumber — format + length predicate", () => {
  it("accepts a freshly derived number", () => {
    expect(
      isValidControlNumber(
        deriveControlNumber({
          ...{
            ccn: "381588",
            serviceFrom: "2026-01-15",
            claimId: claimIdForIndex(3),
            attemptIndex: 2,
          },
        }),
      ),
    ).toBe(true);
  });

  it("rejects a malformed string", () => {
    expect(isValidControlNumber("381588-260601-00abc")).toBe(false);
  });

  it("rejects a string that is well-formed-looking but at/over the 23-char ceiling", () => {
    // A 7-digit attempt segment would push length past the ceiling AND fail the regex.
    expect(isValidControlNumber("381588-260601-00abc-0000003")).toBe(false);
  });
});
