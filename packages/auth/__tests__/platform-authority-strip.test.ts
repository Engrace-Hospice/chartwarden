/**
 * CW-AC-22 follow-up — platform authority withheld from a request that came from outside PLATFORM_CONSOLE_ALLOWED_CIDRS.
 *
 * Authorization reads platform authority from two places, and a strip must take it from both:
 *   • `context.roles` (`requireRole`, every ABAC predicate): `stripPlatformAuthority` rewrites it, and flags the request;
 *   • the effective-permission resolver, which re-reads the grants by (org, user): it answers a flagged request without the
 *     platform roles' grants, never from its cache, and never writes what it computed into the cache. A caller that has only
 *     `{ organizationId, userId }` (`resolveActorPermissions`) is judged by the AMBIENT request context, so ids alone are no way around it.
 */
import { runWithRequestContext } from "@chartwarden/tenancy";
import type { HttpRequestContext } from "@chartwarden/types";
import { ForbiddenError } from "@chartwarden/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLATFORM_AUTHORITY_STRIPPED_ATTRIBUTE,
  PLATFORM_GRANTABLE_ROLE_KEYS,
  type RoleGrant,
  SUPERADMIN_ROLE_KEY,
  carriesPlatformAuthority,
  createEffectivePermissionResolver,
  createInMemoryEffectivePermissionStore,
  expandSuperadminRoles,
  platformAuthorityStrippedFor,
  registerEffectivePermissionResolver,
  requirePermission,
  resetRbacEngine,
  resolveActorPermissions,
  stripPlatformAuthority,
  withoutPlatformRoles,
} from "../src/index";

const ORG = "org-1";
const USER = "user-1";
const OTHER_USER = "user-2";

const PLATFORM_GRANT: RoleGrant = {
  roleKey: "platform_ops",
  enabled: true,
  expiresAt: null,
  permissionKeys: ["support_session.start", "org.manage"],
};
const TENANT_GRANT: RoleGrant = {
  roleKey: "compliance_officer",
  enabled: true,
  expiresAt: null,
  permissionKeys: ["audit.read"],
};

function contextFor(roles: string[], userId = USER): HttpRequestContext {
  return {
    correlationId: "corr-1",
    userId,
    organizationId: ORG,
    providerEntityIds: [],
    locationIds: [],
    roles,
    attributes: {},
    ip: "198.51.100.50",
    userAgent: "vitest",
    startTime: 0,
  };
}

afterEach(() => {
  resetRbacEngine();
});

describe("withoutPlatformRoles", () => {
  it("drops every reserved platform key and keeps every other role, in order", () => {
    expect(
      withoutPlatformRoles([
        "platform_ops",
        "org_admin",
        "platform_alert_audience",
        "registered_nurse",
        "ai_safety_owner",
      ]),
    ).toEqual(["org_admin", "registered_nurse"]);
  });

  it("returns an equal list, not a changed one, when there is nothing to drop; and does not change its input", () => {
    const roles = ["org_admin", "registered_nurse"] as const;
    const kept = withoutPlatformRoles(roles);
    expect(kept).toEqual(["org_admin", "registered_nurse"]);
    expect(roles).toEqual(["org_admin", "registered_nurse"]);
  });

  it("takes the administrator and org_admin a superadmin was expanded into, and leaves what it did not supersede", () => {
    const expanded = [...expandSuperadminRoles([SUPERADMIN_ROLE_KEY]), "compliance_officer"];
    expect(expanded).toContain("org_admin");
    expect(expanded).toContain("administrator");
    expect(withoutPlatformRoles(expanded)).toEqual(["compliance_officer"]);
  });

  it("keeps a held org_admin when there is no superadmin to explain it", () => {
    expect(withoutPlatformRoles(["platform_ops", "org_admin", "administrator"])).toEqual([
      "org_admin",
      "administrator",
    ]);
  });

  it("every platform-grantable key is dropped (the list the operator CLI may grant is the list a strip removes)", () => {
    expect(withoutPlatformRoles([...PLATFORM_GRANTABLE_ROLE_KEYS])).toEqual([]);
  });
});

describe("stripPlatformAuthority", () => {
  it("removes the platform roles, flags the request and returns the keys that were held", () => {
    const context = contextFor(["platform_ops", "org_admin"]);
    expect(stripPlatformAuthority(context)).toEqual(["platform_ops"]);
    expect(context.roles).toEqual(["org_admin"]);
    expect(context.attributes[PLATFORM_AUTHORITY_STRIPPED_ATTRIBUTE]).toBe(true);
    expect(platformAuthorityStrippedFor(context)).toBe(true);
  });

  it("does nothing to a caller with no platform role: not rewritten, not flagged", () => {
    const context = contextFor(["org_admin", "registered_nurse"]);
    const rolesBefore = context.roles;
    expect(stripPlatformAuthority(context)).toEqual([]);
    expect(context.roles).toBe(rolesBefore);
    expect(context.attributes).toEqual({});
    expect(platformAuthorityStrippedFor(context)).toBe(false);
  });
});

describe("carriesPlatformAuthority (for a check that DENIES on platform authority)", () => {
  it("is true while the platform role is on the request, and STILL true after the strip took it off", () => {
    const context = contextFor(["platform_ops", "administrator"]);
    expect(carriesPlatformAuthority(context)).toBe(true);
    stripPlatformAuthority(context);
    expect(context.roles).toEqual(["administrator"]);
    expect(carriesPlatformAuthority(context)).toBe(true); // the bare roles check would now say false and admit
  });

  it("is false for a tenant user, stripped network or not", () => {
    expect(carriesPlatformAuthority(contextFor(["administrator", "registered_nurse"]))).toBe(false);
  });

  it("sees the strip of the same user's ambient request when handed only roles and a user id", () => {
    const context = contextFor(["platform_ops", "administrator"]);
    stripPlatformAuthority(context);
    const idsOnly = { roles: context.roles, userId: USER };
    expect(runWithRequestContext(context, () => carriesPlatformAuthority(idsOnly))).toBe(true);
    expect(carriesPlatformAuthority(idsOnly)).toBe(false); // no ambient request: nothing says it was stripped
  });
});

describe("the effective-permission resolver for a stripped request", () => {
  const setup = () => {
    const { store } = createInMemoryEffectivePermissionStore([
      { orgId: ORG, userId: USER, grants: [PLATFORM_GRANT, TENANT_GRANT] },
      { orgId: ORG, userId: OTHER_USER, grants: [PLATFORM_GRANT] },
    ]);
    return createEffectivePermissionResolver(store);
  };

  it("answers without the platform roles' grants and keeps the tenant roles'", async () => {
    const { resolver } = setup();
    const context = contextFor(["platform_ops", "compliance_officer"]);
    stripPlatformAuthority(context);
    expect([...(await resolver(context))]).toEqual(["audit.read"]);
  });

  it("does not answer from the cache (which holds the full set) and does not write its answer there", async () => {
    const { resolver } = setup();
    const plain = contextFor(["platform_ops", "compliance_officer"]);
    // Warm the cache with the FULL set, as the operator's own (allowlisted) requests do.
    expect([...(await resolver(plain))].sort()).toEqual([
      "audit.read",
      "org.manage",
      "support_session.start",
    ]);

    const stripped = contextFor(["platform_ops", "compliance_officer"]);
    stripPlatformAuthority(stripped);
    expect([...(await resolver(stripped))]).toEqual(["audit.read"]);

    // The stripped answer was not cached: the next unstripped request still gets the full set from the cache.
    expect([...(await resolver(contextFor([])))].sort()).toEqual([
      "audit.read",
      "org.manage",
      "support_session.start",
    ]);
  });

  it("a first stripped request does not poison the cache for the same actor's next request from the allowlist", async () => {
    const { resolver } = setup();
    const stripped = contextFor(["platform_ops"]);
    stripPlatformAuthority(stripped);
    await resolver(stripped);
    expect((await resolver(contextFor([]))).has("org.manage")).toBe(true);
  });

  it("an actor whose only grant is a platform role holds nothing once stripped", async () => {
    const { resolver } = setup();
    const context = contextFor(["platform_ops"], OTHER_USER);
    stripPlatformAuthority(context);
    expect((await resolver(context)).size).toBe(0);
  });

  it("drops a superadmin grant (answered from the catalog) whole, and keeps a tenant role's keys beside it", async () => {
    const { store } = createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: USER,
        grants: [
          {
            roleKey: SUPERADMIN_ROLE_KEY,
            enabled: true,
            expiresAt: null,
            permissionKeys: ["org.manage", "report.admin.lag_read", "audit.read"],
          },
          TENANT_GRANT,
        ],
      },
    ]);
    const { resolver } = createEffectivePermissionResolver(store);
    const context = contextFor([...expandSuperadminRoles([SUPERADMIN_ROLE_KEY])]);
    stripPlatformAuthority(context);
    expect([...(await resolver(context))]).toEqual(["audit.read"]);
  });

  it("flows through requirePermission: the platform key is refused, the tenant key is allowed", async () => {
    const { store } = createInMemoryEffectivePermissionStore([
      { orgId: ORG, userId: USER, grants: [PLATFORM_GRANT, TENANT_GRANT] },
    ]);
    registerEffectivePermissionResolver(store);
    const context = contextFor(["platform_ops", "compliance_officer"]);
    await expect(requirePermission("org.manage")({ context })).resolves.toBeUndefined();
    stripPlatformAuthority(context);
    await expect(requirePermission("org.manage")({ context })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(requirePermission("audit.read")({ context })).resolves.toBeUndefined();
  });
});

describe("a caller that passes only { organizationId, userId } (the ambient request context decides)", () => {
  const register = () => {
    const { store } = createInMemoryEffectivePermissionStore([
      { orgId: ORG, userId: USER, grants: [PLATFORM_GRANT, TENANT_GRANT] },
      { orgId: ORG, userId: OTHER_USER, grants: [PLATFORM_GRANT] },
    ]);
    registerEffectivePermissionResolver(store);
  };
  const idsOnly = (userId: string) => ({ organizationId: ORG, userId });

  it("is stripped inside the request of the same user", async () => {
    register();
    const context = contextFor(["platform_ops", "compliance_officer"]);
    stripPlatformAuthority(context);
    const seen = await runWithRequestContext(context, async () => [
      ...(await resolveActorPermissions(idsOnly(USER))),
    ]);
    expect(seen).toEqual(["audit.read"]);
  });

  it("sees the strip even when it is made AFTER the ambient context was opened (the same object)", async () => {
    register();
    const context = contextFor(["platform_ops", "compliance_officer"]);
    const seen = await runWithRequestContext(context, async () => {
      stripPlatformAuthority(context); // the guard runs after the context hook opened the ambient scope
      return [...(await resolveActorPermissions(idsOnly(USER)))];
    });
    expect(seen).toEqual(["audit.read"]);
  });

  it("is not stripped for ANOTHER user checked inside the request (the strip is about the caller)", async () => {
    register();
    const context = contextFor(["platform_ops", "compliance_officer"]);
    stripPlatformAuthority(context);
    const other = await runWithRequestContext(context, async () => [
      ...(await resolveActorPermissions(idsOnly(OTHER_USER))),
    ]);
    expect(other.sort()).toEqual(["org.manage", "support_session.start"]);
  });

  it("is not stripped outside a request (a job, a script: there is no ambient context), nor in a request that was not stripped", async () => {
    register();
    expect((await resolveActorPermissions(idsOnly(USER))).has("org.manage")).toBe(true);
    const unstripped = contextFor(["platform_ops", "compliance_officer"], USER);
    const seen = await runWithRequestContext(unstripped, async () =>
      resolveActorPermissions(idsOnly(USER)),
    );
    expect(seen.has("org.manage")).toBe(true);
  });
});
