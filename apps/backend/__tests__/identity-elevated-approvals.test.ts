// apps/backend/__tests__/identity-elevated-approvals.test.ts — M2 §3.7 the per-membership NAMED
// APPROVAL AUTHORITY register (GAP-043), over the in-memory store.
//
// The pure decision surface: one live grant per (membership, kind), a re-grant is a 409 rather than a
// silent no-op, a revoke of nothing is a 404 rather than a cheerful 200, the revoked row stays as history,
// and the reader answers `false` for an unknown kind instead of throwing (its only consumer is a
// fail-closed ABAC predicate). The DB-backed half — RLS, the partial unique index, the CHECK floors, and
// M27's predicate reading the seam — is `gap-043-m27-elevated-approval.live.test.ts`.
import { ConflictError, NotFoundError } from "@chartwarden/types";
import { beforeEach, describe, expect, it } from "vitest";
import {
  COST_REPORT_APPROVAL_KIND,
  type ElevatedApprovalService,
  type ElevatedApprovalStore,
  createElevatedApprovalReader,
  createElevatedApprovalService,
  createInMemoryElevatedApprovalStore,
} from "../src/modules/02-identity/index";

const ORG = "org-1";
const MEMBER = "mem-1";
const OTHER = "mem-2";
const ADMIN = "mem-admin";

describe("M2 §3.7 elevated-approval register (GAP-043)", () => {
  let store: ElevatedApprovalStore;
  let service: ElevatedApprovalService;

  beforeEach(() => {
    store = createInMemoryElevatedApprovalStore().store;
    service = createElevatedApprovalService(store);
  });

  const grant = (membershipId = MEMBER) =>
    service.grant({
      organizationId: ORG,
      membershipId,
      kind: COST_REPORT_APPROVAL_KIND,
      grantedByMembershipId: ADMIN,
      grantReason: "CFO, per board resolution 2026-04",
    });

  const revoke = (membershipId = MEMBER) =>
    service.revoke({
      organizationId: ORG,
      membershipId,
      kind: COST_REPORT_APPROVAL_KIND,
      revokedByMembershipId: ADMIN,
      revokedReason: "departed the organization 2026-08-01",
    });

  it("a granted designation reads back as live, and only for that membership", async () => {
    await grant();
    const reader = createElevatedApprovalReader(store);
    expect(
      await reader.hasElevatedApproval({
        organizationId: ORG,
        membershipId: MEMBER,
        kind: COST_REPORT_APPROVAL_KIND,
      }),
    ).toBe(true);
    expect(
      await reader.hasElevatedApproval({
        organizationId: ORG,
        membershipId: OTHER,
        kind: COST_REPORT_APPROVAL_KIND,
      }),
    ).toBe(false);
  });

  it("refuses a duplicate live grant with a 409 rather than silently re-granting", async () => {
    await grant();
    // Quietly returning the existing row would hide that the second granter's REASON was never recorded —
    // and the reason is the whole point of the register.
    await expect(grant()).rejects.toBeInstanceOf(ConflictError);
  });

  it("revoking clears the authority but keeps the row as history", async () => {
    await grant();
    const revoked = await revoke();
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.revokedReason).toContain("departed");

    const reader = createElevatedApprovalReader(store);
    expect(
      await reader.hasElevatedApproval({
        organizationId: ORG,
        membershipId: MEMBER,
        kind: COST_REPORT_APPROVAL_KIND,
      }),
    ).toBe(false);
    // The designation still appears in the register — a surveyor asks who held it WHEN, not just now.
    const history = await service.list(ORG, MEMBER);
    expect(history).toHaveLength(1);
    expect(history[0]?.revokedAt).not.toBeNull();
  });

  it("revoking nothing is a 404, not a cheerful no-op", async () => {
    await expect(revoke()).rejects.toBeInstanceOf(NotFoundError);
  });

  it("re-granting after a revoke inserts a NEW row (a sequence of designations, not one mutated flag)", async () => {
    await grant();
    await revoke();
    await grant();
    const history = await service.list(ORG, MEMBER);
    expect(history).toHaveLength(2);
    expect(history.filter((g) => g.revokedAt === null)).toHaveLength(1);
  });

  it("an unknown kind resolves false, never throws (the consumer is a fail-closed predicate)", async () => {
    await grant();
    const reader = createElevatedApprovalReader(store);
    // A throw here would surface as an opaque 500 from an ABAC guard whose contract is to deny.
    expect(
      await reader.hasElevatedApproval({
        organizationId: ORG,
        membershipId: MEMBER,
        kind: "not_a_real_authority",
      }),
    ).toBe(false);
  });

  it("does not leak a designation across tenants", async () => {
    await grant();
    const reader = createElevatedApprovalReader(store);
    expect(
      await reader.hasElevatedApproval({
        organizationId: "org-2",
        membershipId: MEMBER,
        kind: COST_REPORT_APPROVAL_KIND,
      }),
    ).toBe(false);
  });
});
