// `per_diem_rate_calculation.rhc_carry_over` (migration 0376) is an append-only pricing snapshot (M23 §3.6 / D7: the
// BEFORE UPDATE OR DELETE trigger raises M23_TABLE_APPEND_ONLY; corrections go through a TOB 817 replacement), so
// rows priced before the `sending_hospice` span kind existed are never rewritten. Between 981ece675 and 16dea2298
// a transfer-in's sending-hospice span was stored as `{ source: "internal", kind: "stay" }` (with the sending
// hospice's NPI when captured); the claim detail maps it to the current kind at READ time.
import { describe, expect, it } from "vitest";
import { perDiemClassPricingView } from "../routes/read-service";
import { normalizeStoredRhcCarryOver } from "../services/rhc-carry-over-stored";

const CLAIM_ADMISSION = "11111111-1111-4111-8111-111111111111";
const EARLIER_ADMISSION = "22222222-2222-4222-8222-222222222222";

type StoredSpan = Record<string, unknown>;
const span = (over: StoredSpan = {}): StoredSpan => ({
  source: "internal",
  kind: "stay",
  start: "2026-01-01",
  end: "2026-01-20",
  endAssumed: false,
  countedDays: 20,
  hospiceNpi: null,
  ref: EARLIER_ADMISSION,
  ...over,
});
const stored = (chain: StoredSpan[]): Record<string, unknown> => ({
  electionDate: "2026-02-10",
  priorDays: 40,
  chainDays: 40,
  basis: "internal_only",
  startsAtDay: 41,
  highRateDaysRemaining: 20,
  daysSinceLastCare: 1,
  chain,
  warnings: [],
  hetsCheck: null,
});
const kinds = (raw: unknown): string[] =>
  normalizeStoredRhcCarryOver(raw, { admissionId: CLAIM_ADMISSION })?.chain.map((s) => s.kind) ??
  [];

describe("normalizeStoredRhcCarryOver — old span labels on immutable rows", () => {
  it("relabels an internal 'stay' that carries a hospice NPI (our own stays never did) as the sending hospice", () => {
    expect(kinds(stored([span({ hospiceNpi: "1649726464" })]))).toEqual(["sending_hospice"]);
  });

  it("relabels the claim admission's own internal span (the priced transfer-in's sending hospice, NPI not captured)", () => {
    expect(kinds(stored([span({ ref: CLAIM_ADMISSION })]))).toEqual(["sending_hospice"]);
  });

  it("relabels the earlier of two internal spans of one admission that hand off on the transfer day", () => {
    const raw = stored([
      span({ start: "2025-12-20", end: "2026-01-01", countedDays: 13 }), // sending, NPI not captured
      span({ start: "2026-01-01", end: "2026-01-20", countedDays: 19 }), // our stay
    ]);
    expect(kinds(raw)).toEqual(["sending_hospice", "stay"]);
  });

  it("keeps current-shape rows and genuine own stays / HETS rows as they are", () => {
    const raw = stored([
      span({ ref: "33333333-3333-4333-8333-333333333333", start: "2025-11-01", end: "2025-11-30" }),
      span({ kind: "sending_hospice", hospiceNpi: "1649726464", start: "2025-12-01" }),
      span({ source: "hets", kind: "benefit_period", hospiceNpi: "1234567893", ref: null }),
      span({ source: "hets", kind: "election", hospiceNpi: null, ref: null }),
    ]);
    expect(kinds(raw)).toEqual(["stay", "sending_hospice", "benefit_period", "election"]);
    expect(normalizeStoredRhcCarryOver(raw, { admissionId: CLAIM_ADMISSION })).toEqual(raw);
  });

  it("never mutates the stored row", () => {
    const raw = stored([span({ hospiceNpi: "1649726464" })]);
    const before = structuredClone(raw);
    normalizeStoredRhcCarryOver(raw, { admissionId: CLAIM_ADMISSION });
    expect(raw).toEqual(before);
  });

  it("reads a missing / malformed value as no carry-over recorded, and an unknown kind by its source", () => {
    expect(normalizeStoredRhcCarryOver(null, { admissionId: CLAIM_ADMISSION })).toBeNull();
    expect(normalizeStoredRhcCarryOver(undefined, { admissionId: CLAIM_ADMISSION })).toBeNull();
    expect(normalizeStoredRhcCarryOver("x", { admissionId: CLAIM_ADMISSION })).toBeNull();
    expect(
      normalizeStoredRhcCarryOver({ priorDays: 3 }, { admissionId: CLAIM_ADMISSION }),
    ).toBeNull();
    expect(
      kinds(stored([span({ kind: "own_stay" }), span({ source: "hets", kind: "noe", ref: null })])),
    ).toEqual(["stay", "election"]);
  });
});

describe("perDiemClassPricingView — the claim detail reads the normalized carry-over", () => {
  it("maps an old-shape row's sending span to the current kind", () => {
    const view = perDiemClassPricingView(
      {
        perDiemClassCode: "651",
        perDiemRateCents: 21_800,
        wageIndexCcn: "381588",
        wageIndexFiscalYear: 2026,
        wageIndexFactor: "1.0000",
        segments: [],
        calculatedAt: new Date("2026-02-28T00:00:00Z"),
        rhcDays1to60: 19,
        rhcDays61Plus: 0,
        rhcCarryOver: stored([span({ ref: CLAIM_ADMISSION, hospiceNpi: "1649726464" })]),
      },
      { admissionId: CLAIM_ADMISSION },
    );
    expect(view.rhcCarryOver?.chain[0]?.kind).toBe("sending_hospice");
    expect(view.rhcCarryOver?.chain[0]?.hospiceNpi).toBe("1649726464");
  });
});
