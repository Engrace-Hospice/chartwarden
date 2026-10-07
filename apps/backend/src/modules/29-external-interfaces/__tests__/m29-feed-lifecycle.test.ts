// apps/backend/src/modules/29-external-interfaces/__tests__ — M29-T03 feed lifecycle + BAA gate + credential
// rotation unit tests (§2.2/§2.3/§4.11.1, D16/D18).
import { describe, expect, it } from "vitest";

import {
  type ExternalInterfaceBaaGate,
  type ExternalInterfaceBaaResult,
  decideBaaGate,
  evaluateFeedActivationBaaGate,
} from "../feed/baa-gate";
import { canRetireCredential, planCredentialRotation } from "../feed/credential-lifecycle";
import {
  EXTERNAL_FEED_INITIAL_STATUS,
  canExternalFeedTransition,
  decideFeedRevokeStep,
  externalFeedCoApprovalSatisfied,
  externalFeedEdgeBindsListener,
  externalFeedEdgeRequiresComplianceCoApproval,
  externalFeedServePosture,
  externalFeedTransition,
} from "../feed/lifecycle";

describe("decideFeedRevokeStep (GAP-153)", () => {
  it("the first call is the first approval", () => {
    expect(decideFeedRevokeStep(null, "m1")).toBe("request");
  });
  it("a distinct second approver completes the revoke", () => {
    expect(decideFeedRevokeStep("m1", "m2")).toBe("complete");
  });
  it("the same membership cannot approve twice", () => {
    expect(decideFeedRevokeStep("m1", "m1")).toBe("self_approval");
  });
});

describe("external_feed onboarding FSM (§2.2)", () => {
  it("starts at proposed", () => {
    expect(EXTERNAL_FEED_INITIAL_STATUS).toBe("proposed");
    expect(externalFeedTransition(null, "proposed")?.auditAction).toBe(
      "m29.external_feed.proposed",
    );
  });

  it("permits the happy path proposed → pending_approval → active", () => {
    expect(canExternalFeedTransition("proposed", "pending_approval")).toBe(true);
    expect(canExternalFeedTransition("pending_approval", "active")).toBe(true);
  });

  it("permits suspend/un-suspend and revoke from active or suspended", () => {
    expect(canExternalFeedTransition("active", "suspended")).toBe(true);
    expect(canExternalFeedTransition("suspended", "active")).toBe(true);
    expect(canExternalFeedTransition("active", "revoked")).toBe(true);
    expect(canExternalFeedTransition("suspended", "revoked")).toBe(true);
  });

  it("fails closed on illegal edges and out of terminal states", () => {
    expect(canExternalFeedTransition("proposed", "active")).toBe(false); // must go through pending_approval
    expect(canExternalFeedTransition("revoked", "active")).toBe(false); // terminal
    expect(canExternalFeedTransition("rejected", "pending_approval")).toBe(false); // terminal
    expect(canExternalFeedTransition("active", "proposed")).toBe(false);
  });

  it("flags ONLY pending_approval → active as the compliance co-approval edge", () => {
    expect(externalFeedEdgeRequiresComplianceCoApproval("pending_approval", "active")).toBe(true);
    expect(externalFeedEdgeRequiresComplianceCoApproval("suspended", "active")).toBe(false);
    expect(externalFeedEdgeRequiresComplianceCoApproval("proposed", "pending_approval")).toBe(
      false,
    );
  });

  it("requires two distinct approver memberships (D18)", () => {
    expect(externalFeedCoApprovalSatisfied("op-1", "compl-2")).toBe(true);
    expect(externalFeedCoApprovalSatisfied("op-1", "op-1")).toBe(false); // same membership signs both
    expect(externalFeedCoApprovalSatisfied("op-1", null)).toBe(false);
    expect(externalFeedCoApprovalSatisfied(null, "compl-2")).toBe(false);
  });

  it("flags BOTH activation edges as listener-binding (BAA gate runs)", () => {
    expect(externalFeedEdgeBindsListener("pending_approval", "active")).toBe(true);
    expect(externalFeedEdgeBindsListener("suspended", "active")).toBe(true);
    expect(externalFeedEdgeBindsListener("active", "suspended")).toBe(false);
    expect(externalFeedEdgeBindsListener("active", "revoked")).toBe(false);
  });

  it("resolves the serve posture per status", () => {
    expect(externalFeedServePosture("active")).toEqual({ kind: "serving" });
    expect(externalFeedServePosture("pending_approval")).toEqual({
      kind: "awaiting_approval",
      status: "pending_approval",
    });
    expect(externalFeedServePosture("suspended")).toEqual({ kind: "suspended" });
    expect(externalFeedServePosture("revoked")).toEqual({
      kind: "terminated",
      terminalStatus: "revoked",
    });
  });
});

describe("BAA gate (D16, §2.3)", () => {
  const active: ExternalInterfaceBaaResult = {
    isActive: true,
    status: "executed",
    expiresOn: null,
  };
  const expired: ExternalInterfaceBaaResult = {
    isActive: false,
    status: "expired",
    expiresOn: "2020-01-01",
  };
  const missing: ExternalInterfaceBaaResult = {
    isActive: false,
    status: "missing",
    expiresOn: null,
  };
  const pending: ExternalInterfaceBaaResult = {
    isActive: false,
    status: "pending",
    expiresOn: null,
  };

  it("maps status to a distinguishable refuse reason", () => {
    expect(decideBaaGate(active)).toEqual({ allowed: true });
    expect(decideBaaGate(expired)).toEqual({
      allowed: false,
      reason: "expired_baa",
      status: "expired",
    });
    expect(decideBaaGate(missing)).toEqual({
      allowed: false,
      reason: "missing_baa",
      status: "missing",
    });
    expect(decideBaaGate(pending)).toEqual({
      allowed: false,
      reason: "pending_baa",
      status: "pending",
    });
  });

  it("fails closed on an unrecognized inactive status", () => {
    expect(decideBaaGate({ isActive: false, status: "weird", expiresOn: null })).toEqual({
      allowed: false,
      reason: "missing_baa",
      status: "weird",
    });
  });

  const asOf = new Date("2026-08-02T00:00:00.000Z");
  function fakeGate(map: Record<string, ExternalInterfaceBaaResult>): ExternalInterfaceBaaGate {
    return {
      async baaStatusBySendingFacility({ sendingFacility }) {
        return map[sendingFacility] ?? missing;
      },
      async baaStatusByMdmEntity({ id }) {
        return map[id] ?? missing;
      },
    };
  }

  it("refuses activation with no BAA contract ref BEFORE any seam round-trip", async () => {
    let calls = 0;
    const gate: ExternalInterfaceBaaGate = {
      async baaStatusBySendingFacility() {
        calls += 1;
        return active;
      },
      async baaStatusByMdmEntity() {
        return active;
      },
    };
    const decision = await evaluateFeedActivationBaaGate({
      gate,
      orgId: "org-1",
      baaContractRef: null,
      sendingFacilityAllowlist: ["FAC_A"],
      asOf,
    });
    expect(decision).toEqual({ allowed: false, reason: "no_baa_contract", status: "missing" });
    expect(calls).toBe(0);
  });

  it("passes activation only when EVERY allowlisted facility has an active BAA", async () => {
    const ok = await evaluateFeedActivationBaaGate({
      gate: fakeGate({ FAC_A: active, FAC_B: active }),
      orgId: "org-1",
      baaContractRef: "baa-1",
      sendingFacilityAllowlist: ["FAC_A", "FAC_B"],
      asOf,
    });
    expect(ok).toEqual({ allowed: true });
  });

  it("short-circuits on the first refusing facility (fail-closed)", async () => {
    const decision = await evaluateFeedActivationBaaGate({
      gate: fakeGate({ FAC_A: active, FAC_B: expired }),
      orgId: "org-1",
      baaContractRef: "baa-1",
      sendingFacilityAllowlist: ["FAC_A", "FAC_B"],
      asOf,
    });
    expect(decision).toEqual({ allowed: false, reason: "expired_baa", status: "expired" });
  });

  it("permits an empty allowlist with a contract ref (per-connection gate still applies)", async () => {
    const decision = await evaluateFeedActivationBaaGate({
      gate: fakeGate({}),
      orgId: "org-1",
      baaContractRef: "baa-1",
      sendingFacilityAllowlist: [],
      asOf,
    });
    expect(decision).toEqual({ allowed: true });
  });
});

describe("credential rotation (§4.11.2)", () => {
  it("only an active credential may be retired", () => {
    expect(canRetireCredential("active")).toBe(true);
    expect(canRetireCredential("retired")).toBe(false);
  });

  it("retires every currently-active row so the single-active invariant self-heals", () => {
    const plan = planCredentialRotation([
      { id: "c1", status: "active" },
      { id: "c2", status: "retired" },
      { id: "c3", status: "active" },
    ]);
    expect(plan.retireIds).toEqual(["c1", "c3"]);
  });

  it("retires nothing when no active row exists (first mint)", () => {
    expect(planCredentialRotation([]).retireIds).toEqual([]);
  });
});
