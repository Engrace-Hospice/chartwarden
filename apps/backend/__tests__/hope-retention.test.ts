// GAP-181 — the pure HOPE retention evaluator + the M4 legal-hold scope projection. Architecture OPEN-021 and
// the M10 spec §3 retention class set the horizons (7y standard; 10y from the last iQIES transmission for a
// submitted record); a tenant/state override can only lengthen them; a legal hold, an open iQIES error or a
// pending correction blocks eligibility outright.
import { describe, expect, it } from "vitest";
import { legalHoldScopeOf } from "../src/modules/04-audit/legal-hold-scope";
import {
  type HopeRetentionFacts,
  addYears,
  effectiveYears,
  evaluateHopeRetention,
} from "../src/modules/10-hope/jobs/retention";

const facts = (over: Partial<HopeRetentionFacts> = {}): HopeRetentionFacts => ({
  patientId: "p1",
  lastEffectiveAt: new Date("2018-03-10T00:00:00.000Z"),
  lastTransmittedAt: null,
  openIqiesError: false,
  pendingCorrection: false,
  legalHold: false,
  ...over,
});

describe("evaluateHopeRetention", () => {
  it("keeps an unsubmitted record for 7 years from the last effective date", () => {
    const before = evaluateHopeRetention(facts(), new Date("2025-03-09T23:59:59.000Z"));
    expect(before).toMatchObject({ status: "cleared", basis: "standard_7y", retentionYears: 7 });
    const after = evaluateHopeRetention(facts(), new Date("2025-03-10T00:00:00.000Z"));
    expect(after).toMatchObject({ status: "eligible", blockers: [] });
    expect(after.eligibleAt.toISOString()).toBe("2025-03-10T00:00:00.000Z");
  });

  it("holds a SUBMITTED record 10 years from the last transmission (CMS extended_for_cms)", () => {
    const submitted = facts({ lastTransmittedAt: new Date("2019-01-15T00:00:00.000Z") });
    const at9 = evaluateHopeRetention(submitted, new Date("2028-01-14T00:00:00.000Z"));
    expect(at9).toMatchObject({
      status: "cleared",
      basis: "submitted_cms_10y",
      retentionYears: 10,
    });
    const at10 = evaluateHopeRetention(submitted, new Date("2029-01-15T00:00:00.000Z"));
    expect(at10.status).toBe("eligible");
  });

  it("never releases a submitted record earlier than the standard horizon", () => {
    // Transmitted long ago, but the record was touched recently: 7y from the last effective date wins.
    const d = evaluateHopeRetention(
      facts({
        lastEffectiveAt: new Date("2026-01-01T00:00:00.000Z"),
        lastTransmittedAt: new Date("2010-01-01T00:00:00.000Z"),
      }),
      new Date("2030-01-01T00:00:00.000Z"),
    );
    expect(d).toMatchObject({ status: "cleared", basis: "standard_7y" });
    expect(d.eligibleAt.toISOString()).toBe("2033-01-01T00:00:00.000Z");
  });

  it("blocks — never flags — while a legal hold, open iQIES error or pending correction exists", () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    expect(evaluateHopeRetention(facts({ legalHold: true }), now)).toMatchObject({
      status: "blocked",
      blockers: ["legal_hold"],
    });
    expect(
      evaluateHopeRetention(facts({ openIqiesError: true, pendingCorrection: true }), now),
    ).toMatchObject({ status: "blocked", blockers: ["open_iqies_error", "pending_correction"] });
  });

  it("an override can only LENGTHEN the horizon", () => {
    const now = new Date("2026-01-01T00:00:00.000Z"); // 7y10m after the last effective date
    expect(evaluateHopeRetention(facts(), now, 3).status).toBe("eligible"); // shorter: ignored
    expect(evaluateHopeRetention(facts(), now, 10)).toMatchObject({
      status: "cleared",
      retentionYears: 10,
    });
    expect(effectiveYears(7, 3)).toBe(7);
    expect(effectiveYears(7, 12)).toBe(12);
    expect(effectiveYears(7, Number.NaN)).toBe(7);
    expect(effectiveYears(10, null)).toBe(10);
  });

  it("addYears clamps 29 February into a non-leap year", () => {
    expect(addYears(new Date("2020-02-29T00:00:00.000Z"), 7).toISOString()).toBe(
      "2027-02-28T00:00:00.000Z",
    );
  });
});

describe("legalHoldScopeOf — conservative M4 hold projection", () => {
  it("is empty with no active holds", () => {
    expect(legalHoldScopeOf([])).toEqual({ orgWide: false, patientIds: new Set() });
  });
  it("scopes down to the patients a hold names", () => {
    const s = legalHoldScopeOf([{ patientIds: ["a", "b"] }, { patientIds: ["c"], dateRange: {} }]);
    expect(s.orgWide).toBe(false);
    expect([...s.patientIds].sort()).toEqual(["a", "b", "c"]);
  });
  it("treats a hold with no patient selector as ORG-WIDE", () => {
    expect(legalHoldScopeOf([{ resourceKinds: ["encounter"] }]).orgWide).toBe(true);
    expect(legalHoldScopeOf([{ patientIds: [] }]).orgWide).toBe(true);
    expect(legalHoldScopeOf([null]).orgWide).toBe(true);
  });
  it("does not read a messaging-only (channelIds/userIds) hold as org-wide or as a patient hold", () => {
    const id = "44444444-4444-4444-8444-444444444444";
    expect(legalHoldScopeOf([{ channelIds: [id] }, { userIds: [id], dateRange: {} }])).toEqual({
      orgWide: false,
      patientIds: new Set(),
    });
    expect(legalHoldScopeOf([{ channelIds: [id], patientIds: ["p"] }]).patientIds).toEqual(
      new Set(["p"]),
    );
  });
});
