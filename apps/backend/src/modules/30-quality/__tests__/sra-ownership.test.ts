// GAP-156 — SRA finding/remediation mutations enforce ownsSraCycle (owner OR sra.admin-bearing role) in the service.
import { ForbiddenError } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import type { M30WriteActor } from "../routes/actor";
import { assertSraCycleAccess } from "../routes/sra-ownership";

const ORG = "11111111-1111-4111-8111-111111111111";
const OWNER = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const actor = (membershipId: string, roles: readonly string[]): M30WriteActor => ({
  organizationId: ORG,
  userId: "u",
  roles,
  membershipId,
});
const cycle = { openedByMembershipId: OWNER };

describe("assertSraCycleAccess", () => {
  it("allows the cycle owner", () => {
    expect(() => assertSraCycleAccess(actor(OWNER, ["rn"]), cycle)).not.toThrow();
  });
  it("allows an sra.admin-bearing role that is not the owner", () => {
    expect(() => assertSraCycleAccess(actor(OTHER, ["compliance_officer"]), cycle)).not.toThrow();
    expect(() => assertSraCycleAccess(actor(OTHER, ["org_admin"]), cycle)).not.toThrow();
  });
  it("refuses a non-owner without an admin role", () => {
    expect(() => assertSraCycleAccess(actor(OTHER, ["rn"]), cycle)).toThrow(ForbiddenError);
  });
});
