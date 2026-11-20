// apps/backend/__tests__/discipline-plan-grants-pin.test.ts — M15, the twin of care-plan-grants-pin.test.ts. The default
// `discipline_plan.sign` grants are pinned to the signer roles `signVersion` really accepts (every D11 quorum slot, the aide's
// CHHA acknowledgment included, matched by `actorHoldsSignerRole`, per plan kind), not to a copy of them, so a grant to a
// role that could never sign or a signer role added to a quorum without a grant fails here. `discipline_plan.author` is
// pinned to the `discipline_scope` check.
import {
  DISCIPLINE_PLAN_DEFAULT_GRANTS,
  DISCIPLINE_PLAN_GRANTEE_ROLE_KEYS,
} from "@chartwarden/auth";
import { REQUIRED_SIGNERS_BY_KIND } from "@chartwarden/discipline-plans";
import type { DisciplinePlanKind } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  actorHoldsSignerRole,
  checkPlanKindAuthoringScope,
} from "../src/modules/15-discipline-care-plans/lifecycle/index";

/** Every signer slot of every kind and version kind; the aide's CHHA slot is the acknowledgment, the rest are cosignatures. */
const SIGNER_SLOTS = Object.entries(REQUIRED_SIGNERS_BY_KIND).flatMap(([kind, byVersionKind]) =>
  [...byVersionKind.initial, ...byVersionKind.idg_review].map((slot) => ({
    kind: kind as DisciplinePlanKind,
    role: slot.role,
    isAcknowledgment: slot.isAcknowledgment,
  })),
);
const COSIGNER_SLOTS = SIGNER_SLOTS.filter((slot) => !slot.isAcknowledgment);

const canSign = (role: string): boolean =>
  SIGNER_SLOTS.some((slot) => actorHoldsSignerRole([role], slot.role, slot.kind));

describe("DISCIPLINE_PLAN_DEFAULT_GRANTS is pinned to the signer and scope checks (M15)", () => {
  it("discipline_plan.sign is held by exactly the grantee roles a D11 signer slot accepts", () => {
    const holders = DISCIPLINE_PLAN_GRANTEE_ROLE_KEYS.filter((role) =>
      DISCIPLINE_PLAN_DEFAULT_GRANTS[role]?.includes("discipline_plan.sign"),
    );
    const signers = DISCIPLINE_PLAN_GRANTEE_ROLE_KEYS.filter(canSign);
    expect([...holders].sort()).toEqual([...signers].sort());
  });

  it("plain rn fills the Aide POC RN slot and no other kind's, and the RN case manager fills every RN slot", () => {
    expect(actorHoldsSignerRole(["rn"], "rn_case_manager", "aide_poc")).toBe(true);
    const rnSlotKinds = COSIGNER_SLOTS.filter((slot) => slot.role === "rn_case_manager").map(
      (slot) => slot.kind,
    );
    expect(rnSlotKinds).toContain("aide_poc");
    for (const kind of rnSlotKinds) {
      expect(actorHoldsSignerRole(["rn_case_manager"], "rn_case_manager", kind), kind).toBe(true);
      expect(actorHoldsSignerRole(["rn"], "rn_case_manager", kind), kind).toBe(kind === "aide_poc");
    }
  });

  it("the aide fills the CHHA acknowledgment slot only, never a cosigner slot", () => {
    const acknowledgmentKinds = SIGNER_SLOTS.filter((slot) => slot.isAcknowledgment);
    expect(acknowledgmentKinds.length).toBeGreaterThan(0);
    for (const slot of acknowledgmentKinds)
      expect(actorHoldsSignerRole(["chha"], slot.role, slot.kind), slot.kind).toBe(true);
    for (const slot of COSIGNER_SLOTS)
      expect(
        actorHoldsSignerRole(["chha"], slot.role, slot.kind),
        `${slot.kind}/${slot.role}`,
      ).toBe(false);
  });

  it("every author grantee passes the Aide POC authoring scope (discipline_scope)", () => {
    const authors = DISCIPLINE_PLAN_GRANTEE_ROLE_KEYS.filter((role) =>
      DISCIPLINE_PLAN_DEFAULT_GRANTS[role]?.includes("discipline_plan.author"),
    );
    expect([...authors].sort()).toEqual(["rn", "rn_case_manager"]);
    for (const role of authors)
      expect(() => checkPlanKindAuthoringScope("aide_poc", [role]), role).not.toThrow();
  });
});
