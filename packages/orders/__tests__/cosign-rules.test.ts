// @chartwarden/orders — §2.5 cosignature rules — M11-T03.
import { describe, expect, it } from "vitest";
import {
  type CosignAttest,
  DEFAULT_COSIGN_POLICY,
  escalationJumpCosignRequired,
  lpnCosignRequired,
  npCosignRequired,
  planCosignAttest,
  resolveCosignRequirement,
} from "../src/lifecycle/cosign-rules";

describe("§2.5 axis 1 — LPN-cosign-by-RN", () => {
  it("an LPN draft of a clinical kind requires RN cosign (default policy)", () => {
    for (const kind of DEFAULT_COSIGN_POLICY.lpnCosignRequiredKinds) {
      expect(lpnCosignRequired("lpn", kind)).toBe(true);
    }
  });

  it("a non-LPN drafter never triggers axis 1", () => {
    expect(lpnCosignRequired("rn_case_manager", "lab")).toBe(false);
    expect(lpnCosignRequired("np", "supply")).toBe(false);
  });

  it("respects a tenant policy that omits a kind", () => {
    expect(
      lpnCosignRequired("lpn", "lab", {
        lpnCosignRequiredKinds: ["dme"],
        npCosignRequiredKinds: [],
      }),
    ).toBe(false);
  });
});

describe("§2.5 axis 2 — NP-cosign-by-MD", () => {
  it("defaults to never (empty policy)", () => {
    expect(npCosignRequired("np", "lab")).toBe(false);
  });

  it("fires only for an NP signer when the policy lists the kind", () => {
    const policy = { lpnCosignRequiredKinds: [], npCosignRequiredKinds: ["dme"] as const };
    expect(npCosignRequired("np", "dme", policy)).toBe(true);
    expect(npCosignRequired("medical_director", "dme", policy)).toBe(false);
  });
});

describe("§2.5 axis 3 — for-cause escalation jump", () => {
  it("rhc → gip skipping chc/irc requires MD cosign for a hospice_physician / np signer", () => {
    expect(escalationJumpCosignRequired("rhc", "gip", "hospice_physician")).toBe(true);
    expect(escalationJumpCosignRequired("rhc", "gip", "np")).toBe(true);
  });

  it("a medical_director signer self-satisfies", () => {
    expect(escalationJumpCosignRequired("rhc", "gip", "medical_director")).toBe(false);
  });

  it("a non-jump transition never triggers axis 3", () => {
    expect(escalationJumpCosignRequired("rhc", "chc", "hospice_physician")).toBe(false);
    expect(escalationJumpCosignRequired("chc", "gip", "np")).toBe(false);
  });
});

describe("§2.5 resolveCosignRequirement (axis precedence)", () => {
  it("LPN-cosign wins first and demands an RN", () => {
    const r = resolveCosignRequirement({
      kind: "lab",
      drafterDiscipline: "lpn",
      signerDiscipline: "np",
    });
    expect(r).toEqual({ axis: "lpn_cosign", cosignerRoleNeeded: "rn_case_manager" });
  });

  it("an escalation-jump LCC demands a medical_director", () => {
    const r = resolveCosignRequirement({
      kind: "level_of_care_change",
      drafterDiscipline: "hospice_physician",
      signerDiscipline: "hospice_physician",
      levelChange: { fromLevel: "rhc", toLevel: "gip" },
    });
    expect(r).toEqual({ axis: "escalation_jump", cosignerRoleNeeded: "medical_director" });
  });

  it("returns null when no axis fires (the order signs directly)", () => {
    expect(
      resolveCosignRequirement({
        kind: "lab",
        drafterDiscipline: "rn_case_manager",
        signerDiscipline: "medical_director",
      }),
    ).toBeNull();
  });
});

describe("§2.5 / §7.3 planCosignAttest", () => {
  const base: CosignAttest = {
    orderId: "o1",
    cosignRequired: true,
    alreadyCosigned: false,
    cosignerRole: "rn_case_manager",
    cosignerRoleNeeded: "rn_case_manager",
    cosignerIsAuthor: false,
  };

  it("either RN role satisfies an RN demand → emits cosigned", () => {
    expect(planCosignAttest(base)).toEqual({ orderId: "o1", emitsCosigned: true });
    expect(planCosignAttest({ ...base, cosignerRole: "clinical_supervisor" }).emitsCosigned).toBe(
      true,
    );
  });

  it("refuses cosign on an order that does not require it (422 COSIGN_NOT_REQUIRED)", () => {
    expect(() => planCosignAttest({ ...base, cosignRequired: false })).toThrowError(
      expect.objectContaining({ code: "COSIGN_NOT_REQUIRED", statusCode: 422 }),
    );
  });

  it("refuses a double cosign (409 ALREADY_COSIGNED)", () => {
    expect(() => planCosignAttest({ ...base, alreadyCosigned: true })).toThrowError(
      expect.objectContaining({ code: "ALREADY_COSIGNED", statusCode: 409 }),
    );
  });

  it("refuses a role that does not satisfy the demand (403 COSIGNER_NOT_ELIGIBLE)", () => {
    expect(() =>
      planCosignAttest({
        ...base,
        cosignerRole: "rn_case_manager",
        cosignerRoleNeeded: "medical_director",
      }),
    ).toThrowError(expect.objectContaining({ code: "COSIGNER_NOT_ELIGIBLE", statusCode: 403 }));
  });

  it("refuses a self-cosign by the order's author (403 COSIGNER_NOT_ELIGIBLE)", () => {
    expect(() => planCosignAttest({ ...base, cosignerIsAuthor: true })).toThrowError(
      expect.objectContaining({ code: "COSIGNER_NOT_ELIGIBLE", statusCode: 403 }),
    );
  });
});
