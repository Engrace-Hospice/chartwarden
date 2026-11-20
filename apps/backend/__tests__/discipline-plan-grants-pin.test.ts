// apps/backend/__tests__/discipline-plan-grants-pin.test.ts — M15, the twin of care-plan-grants-pin.test.ts. The default
// `discipline_plan.sign` grants are pinned to the signer roles `signVersion` really accepts (the D11 quorum slots, matched
// by `actorHoldsSignerRole`), not to a copy of them, so a grant to a role that could never sign — plain `rn` — or a signer
// role added to a quorum without a grant fails here. `discipline_plan.author` is pinned to the `discipline_scope` check.
import {
  DISCIPLINE_PLAN_DEFAULT_GRANTS,
  DISCIPLINE_PLAN_GRANTEE_ROLE_KEYS,
} from "@chartwarden/auth";
import { REQUIRED_SIGNERS_BY_KIND } from "@chartwarden/discipline-plans";
import { describe, expect, it } from "vitest";
import {
  actorHoldsSignerRole,
  checkPlanKindAuthoringScope,
} from "../src/modules/15-discipline-care-plans/lifecycle/index";

/** Every non-acknowledgment signer slot of every kind and version kind (the acknowledgment is the aide's CHHA slot). */
const COSIGNER_SLOTS = Object.values(REQUIRED_SIGNERS_BY_KIND)
  .flatMap((byVersionKind) => [...byVersionKind.initial, ...byVersionKind.idg_review])
  .filter((slot) => !slot.isAcknowledgment);

const canSign = (role: string): boolean =>
  COSIGNER_SLOTS.some((slot) => actorHoldsSignerRole([role], slot.role));

describe("DISCIPLINE_PLAN_DEFAULT_GRANTS is pinned to the signer and scope checks (M15)", () => {
  it("discipline_plan.sign is held by exactly the grantee roles a D11 signer slot accepts", () => {
    const holders = DISCIPLINE_PLAN_GRANTEE_ROLE_KEYS.filter((role) =>
      DISCIPLINE_PLAN_DEFAULT_GRANTS[role]?.includes("discipline_plan.sign"),
    );
    const signers = DISCIPLINE_PLAN_GRANTEE_ROLE_KEYS.filter(canSign);
    expect([...holders].sort()).toEqual([...signers].sort());
  });

  it("plain rn fills no signer slot, and the RN case manager fills the Aide POC one", () => {
    expect(canSign("rn")).toBe(false);
    expect(
      REQUIRED_SIGNERS_BY_KIND.aide_poc.initial.some(
        (slot) => !slot.isAcknowledgment && actorHoldsSignerRole(["rn_case_manager"], slot.role),
      ),
    ).toBe(true);
  });

  it("every author grantee passes the Aide POC authoring scope (discipline_scope)", () => {
    for (const role of DISCIPLINE_PLAN_GRANTEE_ROLE_KEYS) {
      expect(DISCIPLINE_PLAN_DEFAULT_GRANTS[role], role).toContain("discipline_plan.author");
      expect(() => checkPlanKindAuthoringScope("aide_poc", [role]), role).not.toThrow();
    }
  });
});
