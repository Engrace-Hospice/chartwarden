// apps/backend/__tests__/care-plan-grants-pin.test.ts — CW-AC-44. The default `care_plan.sign` grants are pinned to
// the list `signer_role_match` itself uses (not a copy of it) and that list to the `care_plan_signer_role` enum, so a
// signer role added to the predicate without a grant (or a grant to a role the predicate would never accept) fails here.
import { CARE_PLAN_DEFAULT_GRANTS, CARE_PLAN_GRANTEE_ROLE_KEYS } from "@chartwarden/auth";
import { carePlanSignerRole } from "@chartwarden/db/schema";
import { describe, expect, it } from "vitest";
import { SIGNER_ROLE_KEYS } from "../src/modules/07-care-plan/abac-predicates";

describe("CARE_PLAN_DEFAULT_GRANTS is pinned to the signer predicate (CW-AC-44)", () => {
  it("care_plan.sign is held by exactly the roles signer_role_match accepts", () => {
    const signers = CARE_PLAN_GRANTEE_ROLE_KEYS.filter((role) =>
      CARE_PLAN_DEFAULT_GRANTS[role]?.includes("care_plan.sign"),
    );
    expect([...signers].sort()).toEqual([...SIGNER_ROLE_KEYS].sort());
  });

  it("the predicate's signer list equals the care_plan_signer_role enum", () => {
    expect([...SIGNER_ROLE_KEYS].sort()).toEqual([...carePlanSignerRole.enumValues].sort());
  });
});
