// Step 7, Billing: clearinghouse. What the operator is shown and offered, as pure functions of the server's masked view. The server is the
// authority on every rule (verify before activate, the BAA gate, the vendor lock); this only decides what to OFFER and which facts hold.
import { describe, expect, it } from "vitest";
import {
  type ClearinghouseView,
  clearinghouseActions,
  clearinghouseFacts,
  isTransmitting,
  needsSecret,
} from "./clearinghouse-model";

const BAA = {
  heldBy: "tenant" as const,
  effectiveDate: "2026-01-15",
  documentRef: "Claim.MD BAA, contract folder 7",
  recordedAt: "2026-11-02T10:00:00.000Z",
  verified: null,
  revoked: false,
  revokedAt: null,
  revokedReasonCode: null,
};

const view = (over: Partial<ClearinghouseView> = {}): ClearinghouseView => ({
  vendor: "claimmd",
  mode: "production",
  status: "draft",
  source: "tenant",
  hasSecret: true,
  verifiableBy: "connection_test",
  verification: null,
  lastTest: null,
  baaRequired: true,
  baa: null,
  activatedAt: null,
  version: 2,
  updatedAt: "2026-11-02T09:00:00.000Z",
  hasContract: false,
  ...over,
});

const NOTHING: ClearinghouseView = view({
  vendor: null,
  mode: null,
  status: null,
  source: "none",
  hasSecret: false,
  verifiableBy: null,
  baaRequired: false,
  version: null,
  updatedAt: null,
});

const stateOf = (facts: ReturnType<typeof clearinghouseFacts>, key: string) =>
  facts.find((f) => f.key === key)?.state;

describe("isTransmitting / needsSecret", () => {
  it("is true for the two vendors ChartWarden transmits through, false for outside and for nothing", () => {
    expect(isTransmitting(view({ vendor: "stedi" }))).toBe(true);
    expect(isTransmitting(view({ vendor: "claimmd" }))).toBe(true);
    expect(isTransmitting(view({ vendor: "outside", mode: null }))).toBe(false);
    expect(isTransmitting(NOTHING)).toBe(false);
  });

  it("needs a credential for a first choice and whenever vendor or mode changes, never for outside, and not when nothing changes", () => {
    expect(needsSecret(NOTHING, { vendor: "stedi", mode: "test" })).toBe(true);
    expect(needsSecret(view(), { vendor: "stedi", mode: "production" })).toBe(true);
    expect(needsSecret(view(), { vendor: "claimmd", mode: "test" })).toBe(true);
    expect(needsSecret(view(), { vendor: "claimmd", mode: "production" })).toBe(false);
    expect(needsSecret(view(), { vendor: "outside", mode: "production" })).toBe(false);
    expect(needsSecret(NOTHING, { vendor: "outside", mode: "test" })).toBe(false);
  });

  it("needs a credential when the stored choice is the outside one and a vendor is picked", () => {
    expect(
      needsSecret(view({ vendor: "outside", mode: null, hasSecret: false }), {
        vendor: "claimmd",
        mode: "production",
      }),
    ).toBe(true);
  });
});

describe("clearinghouseFacts", () => {
  it("has nothing met when no clearinghouse is chosen", () => {
    const facts = clearinghouseFacts(NOTHING);
    expect(facts.map((f) => f.key)).toEqual(["chosen"]);
    expect(stateOf(facts, "chosen")).toBe("pending");
  });

  it("does not count the deployment's shared fallback as this tenant's choice, and says so", () => {
    const facts = clearinghouseFacts(view({ source: "platform_env", version: null }));
    expect(stateOf(facts, "chosen")).toBe("pending");
    expect(facts[0]?.detail).toMatch(/shared|deployment/i);
  });

  it("is one fact for a tenant billing outside: chosen, and nothing to verify or activate", () => {
    const facts = clearinghouseFacts(
      view({
        vendor: "outside",
        mode: null,
        status: "active",
        hasSecret: false,
        baaRequired: false,
      }),
    );
    expect(facts.map((f) => [f.key, f.state])).toEqual([["chosen", "ok"]]);
  });

  it("walks a vendor from the choice to activation, one fact each", () => {
    const draft = clearinghouseFacts(view());
    expect(draft.map((f) => f.key)).toEqual([
      "chosen",
      "secret",
      "baa-recorded",
      "baa-verified",
      "connection",
      "active",
    ]);
    expect(draft.map((f) => f.state)).toEqual([
      "ok",
      "ok",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);

    const done = clearinghouseFacts(
      view({
        status: "active",
        baa: { ...BAA, verified: { at: "2026-11-03T10:00:00.000Z" } },
        verification: {
          kind: "connection_test",
          evidence: null,
          verifiedAt: "2026-11-03T11:00:00.000Z",
        },
        activatedAt: "2026-11-03T12:00:00.000Z",
      }),
    );
    expect(done.every((f) => f.state === "ok")).toBe(true);
  });

  it("names the last connection test's outcome when it failed, so the operator knows what to fix", () => {
    const facts = clearinghouseFacts(
      view({ lastTest: { outcome: "credential_rejected", at: "2026-11-03T11:00:00.000Z" } }),
    );
    const connection = facts.find((f) => f.key === "connection");
    expect(connection?.state).toBe("pending");
    expect(String(connection?.detail)).toMatch(/rejected/i);
  });

  it("says the BAA is the tenant's to record (not the operator's) while none is on file", () => {
    const facts = clearinghouseFacts(view());
    expect(String(facts.find((f) => f.key === "baa-recorded")?.detail)).toMatch(/tenant/i);
  });
});

describe("clearinghouseActions", () => {
  const none = {
    canVerifyBaa: false,
    canRevokeBaa: false,
    canVerifyConnection: false,
    tenantActivationNote: null,
  };

  it("offers only the choice before one is made", () => {
    expect(clearinghouseActions(NOTHING)).toEqual(none);
  });

  it("offers nothing past the choice for a tenant billing outside", () => {
    expect(
      clearinghouseActions(
        view({ vendor: "outside", mode: null, status: "active", hasSecret: false }),
      ),
    ).toEqual(none);
  });

  it("offers the connection verification on a draft with a credential, and not without one", () => {
    expect(clearinghouseActions(view()).canVerifyConnection).toBe(true);
    expect(clearinghouseActions(view({ hasSecret: false })).canVerifyConnection).toBe(false);
    expect(clearinghouseActions(view({ status: "verified" })).canVerifyConnection).toBe(false);
  });

  it("offers the BAA verification only for a recorded, unverified BAA", () => {
    expect(clearinghouseActions(view()).canVerifyBaa).toBe(false);
    expect(clearinghouseActions(view({ baa: BAA })).canVerifyBaa).toBe(true);
    expect(
      clearinghouseActions(view({ baa: { ...BAA, verified: { at: "2026-11-03T10:00:00.000Z" } } }))
        .canVerifyBaa,
    ).toBe(false);
  });

  it("never offers an operator activation: it says the tenant's own billing administrator activates, and what is missing before that", async () => {
    const verifiedConnection = view({ status: "verified" });
    const blocked = clearinghouseActions(verifiedConnection);
    expect(blocked).not.toHaveProperty("canActivate");
    expect(blocked.tenantActivationNote).toMatch(/BAA/);
    expect(blocked.tenantActivationNote).toMatch(/tenant's own billing administrator/);

    const ready = clearinghouseActions(
      view({ status: "verified", baa: { ...BAA, verified: { at: "2026-11-03T10:00:00.000Z" } } }),
    );
    expect(ready).not.toHaveProperty("canActivate");
    expect(ready.tenantActivationNote).toMatch(/tenant's own billing administrator activates/);
    expect(ready.tenantActivationNote).not.toMatch(/Verify the vendor BAA/);

    // nothing to say while the connection is still unverified
    expect(clearinghouseActions(view()).tenantActivationNote).toBeNull();
  });

  it("offers BAA revocation for an active vendor and removes it after revocation", () => {
    const active = clearinghouseActions(
      view({ status: "active", baa: { ...BAA, verified: { at: "2026-11-03T10:00:00.000Z" } } }),
    );
    expect(active.canRevokeBaa).toBe(true);
    expect(active.canVerifyBaa).toBe(false);

    const revoked = clearinghouseActions(
      view({
        status: "verified",
        baa: {
          ...BAA,
          revoked: true,
          revokedAt: "2026-11-04T10:00:00.000Z",
          revokedReasonCode: "vendor_terminated",
        },
      }),
    );
    expect(revoked.canRevokeBaa).toBe(false);
    expect(revoked.canVerifyBaa).toBe(false);
  });
});
