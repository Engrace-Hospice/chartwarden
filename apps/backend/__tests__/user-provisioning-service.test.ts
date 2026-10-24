import type { NewAuditEvent } from "@chartwarden/audit";
import { describe, expect, it, vi } from "vitest";
import {
  type CredentialLifecycleStore,
  createUserProvisioningService,
} from "../src/modules/02-identity/credential-lifecycle";
import {
  createInMemoryMembershipRepository,
  createInMemorySessionWriter,
} from "../src/modules/02-identity/identity-ports";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";
const auditContext = { organizationId: ORG, userId: ACTOR, correlationId: "test" } as const;

function fixture(overrides: Partial<CredentialLifecycleStore> = {}) {
  const memberships = createInMemoryMembershipRepository();
  const sessions = createInMemorySessionWriter();
  const auditRows: NewAuditEvent[] = [];
  const lifecycle: CredentialLifecycleStore = {
    organizationName: vi.fn(async () => "Hospice"),
    validateLocations: vi.fn(async () => true),
    state: vi.fn(async () => ({
      state: "password_change_required" as const,
      reason: "admin_reset",
      version: 4,
    })),
    requirePasswordChange: vi.fn(async () => 4),
    completePasswordChange: vi.fn(async () => true),
    tenantResetEligibility: vi.fn(async () => "eligible" as const),
    ...overrides,
  };
  const credentials = {
    provision: vi.fn(async () => ({ userId: USER })),
    replacePassword: vi.fn(async () => undefined),
    deleteProvisionedIdentity: vi.fn(async () => undefined),
    changeOwnPassword: vi.fn(async () => undefined),
  };
  const roleGuard = { assertProposable: vi.fn(async () => undefined) };
  const roleAttacher = {
    attach: vi.fn(async () => ({ attached: ["clinical_rn"], unresolved: [] as string[] })),
  };
  const service = createUserProvisioningService({
    credentials,
    lifecycle,
    memberships: memberships.repo,
    sessions: sessions.writer,
    roles: { resolveKeys: vi.fn(async () => ["clinical_rn"]) },
    roleGuard,
    roleAttacher,
    audit: {
      insert: () => ({
        values: async (row: NewAuditEvent) => {
          auditRows.push(row);
        },
      }),
    },
  });
  return {
    service,
    credentials,
    lifecycle,
    roleGuard,
    roleAttacher,
    memberships,
    sessions,
    auditRows,
  };
}

describe("direct user provisioning and credential lifecycle", () => {
  it("creates one global credential, tenant membership and ceiling-checked role set with null email", async () => {
    const f = fixture();
    const result = await f.service.provision({
      organizationId: ORG,
      actorUserId: ACTOR,
      name: "Jane Smith",
      username: "jsmith",
      email: null,
      temporaryPassword: "Temporary-Password-123!",
      roleIds: ["role-1"],
      defaultLocationIds: [],
      auditContext,
    });
    expect(result).toMatchObject({
      userId: USER,
      email: null,
      credentialState: "password_change_required",
    });
    expect(f.credentials.provision).toHaveBeenCalledWith(expect.objectContaining({ email: null }));
    expect(f.roleGuard.assertProposable).toHaveBeenCalledBefore(f.roleAttacher.attach);
    expect(f.memberships.all()).toHaveLength(1);
    expect(f.auditRows.at(-1)?.eventType).toBe("m2.user.provisioned");
  });

  it("compensates the membership and identity when role attachment is incomplete", async () => {
    const f = fixture();
    f.roleAttacher.attach.mockResolvedValueOnce({ attached: [], unresolved: ["clinical_rn"] });
    await expect(
      f.service.provision({
        organizationId: ORG,
        actorUserId: ACTOR,
        name: "Jane Smith",
        username: "jsmith",
        email: null,
        temporaryPassword: "Temporary-Password-123!",
        roleIds: ["role-1"],
        defaultLocationIds: [],
        auditContext,
      }),
    ).rejects.toMatchObject({ code: "ROLE_ASSIGNMENT_FAILED" });
    expect(f.memberships.all()).toHaveLength(0);
    expect(f.credentials.deleteProvisionedIdentity).toHaveBeenCalledWith(USER);
  });

  it("rejects a tenant reset for a shared global identity without mutating its password", async () => {
    const f = fixture({ tenantResetEligibility: vi.fn(async () => "shared_identity" as const) });
    await expect(
      f.service.resetPassword({
        organizationId: ORG,
        actorUserId: ACTOR,
        targetUserId: USER,
        temporaryPassword: "Temporary-Password-123!",
        auditContext,
      }),
    ).rejects.toMatchObject({ code: "SHARED_IDENTITY_RESET_RESTRICTED", statusCode: 403 });
    expect(f.credentials.replacePassword).not.toHaveBeenCalled();
  });

  it("fails closed on a concurrent reset and revokes the limited session", async () => {
    const f = fixture({ completePasswordChange: vi.fn(async () => false) });
    await expect(
      f.service.completeRequiredChange({
        userId: USER,
        currentPassword: "Temporary-Password-123!",
        newPassword: "A-New-Long-Password-456!",
        requestHeaders: new Headers(),
        auditContext,
      }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_STATE_CHANGED" });
    expect(f.sessions.revokedUsers()).toEqual([USER]);
  });
});
