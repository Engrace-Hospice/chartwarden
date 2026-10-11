import type { ApiClient } from "@wardenx/ui";
import { describe, expect, it, vi } from "vitest";
import { provisionUser, resetUserPassword } from "../user-management-api";

describe("user management API integration", () => {
  it("provisions through the organization-scoped endpoint without a synthetic email", async () => {
    const post = vi.fn(async () => ({
      data: {
        userId: "user-1",
        membershipId: "membership-1",
        name: "Jordan Smith",
        username: "jsmith",
        email: null,
        credentialState: "password_change_required",
        roleIds: ["role-1"],
        defaultLocationIds: [],
        temporaryPassword: "generated-once",
      },
      error: undefined,
      response: { status: 201 },
    }));
    const client = { POST: post } as unknown as ApiClient;
    const result = await provisionUser(client, "org-1", {
      name: "Jordan Smith",
      username: "jsmith",
      roleIds: ["role-1"],
      generateTemporaryPassword: true,
    });
    expect(result.ok).toBe(true);
    expect(post).toHaveBeenCalledWith("/api/v1/orgs/{orgId}/users", {
      params: { path: { orgId: "org-1" } },
      body: {
        name: "Jordan Smith",
        username: "jsmith",
        roleIds: ["role-1"],
        generateTemporaryPassword: true,
      },
    });
  });

  it("surfaces shared-identity reset restrictions without cross-tenant details", async () => {
    const client = {
      POST: vi.fn(async () => ({
        data: undefined,
        error: {
          error: {
            code: "SHARED_IDENTITY_RESET_RESTRICTED",
            message: "this global identity requires a platform-authorized reset",
          },
        },
        response: { status: 403 },
      })),
    } as unknown as ApiClient;
    const result = await resetUserPassword(client, "org-1", "user-1", {
      generateTemporaryPassword: true,
    });
    expect(result).toEqual({
      ok: false,
      failure: {
        status: 403,
        code: "SHARED_IDENTITY_RESET_RESTRICTED",
        message: "this global identity requires a platform-authorized reset",
      },
    });
  });
});
