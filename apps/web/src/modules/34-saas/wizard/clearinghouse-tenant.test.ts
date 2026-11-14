// What the tenant is shown and offered on the clearinghouse step, as pure functions of the server's masked view. The server owns every rule
// (verify before activate, the BAA gate, the vendor lock); this only keeps the member from being handed a button it is certain to refuse.
import { describe, expect, it } from "vitest";
import {
  isChosenOutside,
  tenantActionsOf,
  tenantConsequenceOf,
  tenantFactsOf,
} from "./clearinghouse-tenant";
import { CLAIMMD_DRAFT, clearinghouseView } from "./panel-fixtures";

const verifiedBaa = (over = {}) => ({
  heldBy: "tenant" as const,
  effectiveDate: "2026-10-01",
  documentRef: "Claim.MD BAA, signed copy",
  recordedAt: "2026-11-02T00:00:00.000Z",
  verified: { at: "2026-11-03T00:00:00.000Z" },
  revoked: false,
  revokedAt: null,
  revokedReasonCode: null,
  ...over,
});

describe("tenantFactsOf", () => {
  it("asks for a choice when none is on record, and says when only the deployment names one", () => {
    expect(tenantFactsOf(clearinghouseView())).toEqual([
      { key: "chosen", label: "A clearinghouse is chosen", state: "pending" },
    ]);
    const [fact] = tenantFactsOf(clearinghouseView({ source: "platform_env", vendor: "stedi" }));
    expect(fact?.detail).toContain("none is recorded for your organization");
  });

  it("says billing outside ChartWarden needs nothing", () => {
    const [fact] = tenantFactsOf(
      clearinghouseView({ vendor: "outside", source: "tenant", status: "active" }),
    );
    expect(fact).toMatchObject({ label: "Billing outside ChartWarden", state: "ok" });
    expect(fact?.detail).toContain("will not send claims");
  });

  it("walks a vendor from chosen to active in the tenant's voice", () => {
    const facts = tenantFactsOf({ ...CLAIMMD_DRAFT, baa: verifiedBaa({ verified: null }) });
    expect(facts.map((f) => [f.key, f.state])).toEqual([
      ["chosen", "ok"],
      ["secret", "ok"],
      ["baa-recorded", "ok"],
      ["baa-verified", "pending"],
      ["connection", "pending"],
      ["active", "pending"],
    ]);
    expect(facts.find((f) => f.key === "baa-verified")?.label).toBe(
      "ChartWarden verified your vendor BAA",
    );
  });

  it("names the last connection test that did not pass", () => {
    const facts = tenantFactsOf({
      ...CLAIMMD_DRAFT,
      lastTest: { outcome: "credential_rejected", at: "2026-11-04T00:00:00.000Z" },
    });
    expect(facts.find((f) => f.key === "connection")?.detail).toContain(
      "the vendor rejected the credential",
    );
  });
});

describe("tenantActionsOf", () => {
  it("offers nothing to a member who cannot write", () => {
    expect(tenantActionsOf(CLAIMMD_DRAFT, false)).toEqual({
      canRecordBaa: false,
      canVerifyConnection: false,
      canActivate: false,
      waitingForBaa: false,
      showActivation: false,
    });
  });

  it("offers the BAA and the connection check on a fresh vendor choice", () => {
    expect(tenantActionsOf(CLAIMMD_DRAFT, true)).toMatchObject({
      canRecordBaa: true,
      canVerifyConnection: true,
      canActivate: false,
      showActivation: true,
    });
  });

  it("waits on ChartWarden while a recorded BAA is unverified", () => {
    const view = {
      ...CLAIMMD_DRAFT,
      status: "verified" as const,
      baa: verifiedBaa({ verified: null }),
    };
    expect(tenantActionsOf(view, true)).toMatchObject({ waitingForBaa: true, canActivate: false });
  });

  it("offers Activate once the connection and the BAA are both verified", () => {
    const view = { ...CLAIMMD_DRAFT, status: "verified" as const, baa: verifiedBaa() };
    expect(tenantActionsOf(view, true)).toMatchObject({ canActivate: true, waitingForBaa: false });
  });

  it("offers nothing on billing outside ChartWarden", () => {
    const view = clearinghouseView({ vendor: "outside", source: "tenant", status: "active" });
    expect(tenantActionsOf(view, true)).toMatchObject({
      canRecordBaa: false,
      canVerifyConnection: false,
      canActivate: false,
      showActivation: false,
    });
  });
});

describe("tenantConsequenceOf", () => {
  it("says what billing outside ChartWarden does", () => {
    expect(
      tenantConsequenceOf(clearinghouseView(), { vendor: "outside", mode: "production" }),
    ).toBe(
      "ChartWarden will not send claims; steps 8 and 9 are skipped. No credential, BAA or activation is needed.",
    );
  });

  it("warns that a changed vendor or mode starts again at draft", () => {
    expect(tenantConsequenceOf(CLAIMMD_DRAFT, { vendor: "stedi", mode: "production" })).toContain(
      "starts the new configuration at draft",
    );
  });

  it("says nothing extra for a first choice or an unchanged one", () => {
    expect(
      tenantConsequenceOf(clearinghouseView(), { vendor: "claimmd", mode: "production" }),
    ).toContain("never shown again");
    expect(
      tenantConsequenceOf(CLAIMMD_DRAFT, { vendor: "claimmd", mode: "production" }),
    ).toBeUndefined();
  });
});

describe("isChosenOutside", () => {
  it("is true only for the organization's own choice of billing outside ChartWarden", () => {
    expect(isChosenOutside(clearinghouseView({ vendor: "outside", source: "tenant" }))).toBe(true);
    expect(isChosenOutside(clearinghouseView({ vendor: "outside", source: "platform_env" }))).toBe(
      false,
    );
    expect(isChosenOutside(CLAIMMD_DRAFT)).toBe(false);
    expect(isChosenOutside(clearinghouseView())).toBe(false);
  });
});
