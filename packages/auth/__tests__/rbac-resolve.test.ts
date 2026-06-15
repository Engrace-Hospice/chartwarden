/**
 * M3-T06 — RBAC engine + scoping (M3 spec §2.2, §7.2).
 *
 * The cached effective-permission resolver `require-role.ts` (M3-T05) deny-stubbed: it folds
 * an actor's active `membership_role → role_permission` grants into an effective permission
 * set and registers itself as the contract's `EffectivePermissionResolver`. These exercise:
 *   • the resolution fold (union of granted keys), and that a DISABLED role grants nothing;
 *   • §7.2 time-bound elevation — an on-call grant with a future `expires_at` grants now and
 *     the SAME resolution denies one minute after the window closes (same role, same RLS);
 *   • caching + §2.5 invalidation (role grant/revoke per actor, permission edit per org), and
 *     that the cache TTL is capped by the soonest expiry so an expired grant is never served;
 *   • end-to-end through `requirePermission`, flipping it from fail-closed to real resolution.
 */
import type { HttpRequestContext } from "@wardenx/types";
import { ForbiddenError } from "@wardenx/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type RoleGrant,
  createEffectivePermissionResolver,
  createInMemoryEffectivePermissionCache,
  createInMemoryEffectivePermissionStore,
  effectivePermissionCacheKey,
  registerEffectivePermissionResolver,
  requirePermission,
  resetRbacEngine,
  resolveEffectivePermissions,
} from "../src/index";

const ORG = "org-1";
const USER = "user-1";

function grant(overrides: Partial<RoleGrant> = {}): RoleGrant {
  return {
    roleKey: "rn_case_manager",
    enabled: true,
    expiresAt: null,
    permissionKeys: ["patient.read"],
    ...overrides,
  };
}

function contextFor(orgId = ORG, userId = USER): HttpRequestContext {
  return {
    correlationId: "corr-1",
    userId,
    organizationId: orgId,
    providerEntityIds: [],
    locationIds: [],
    roles: [],
    attributes: {},
    ip: "127.0.0.1",
    userAgent: "vitest",
    startTime: 0,
  };
}

afterEach(() => {
  resetRbacEngine();
});

describe("resolveEffectivePermissions (the §2.2 fold)", () => {
  it("unions the permission keys of every active grant", () => {
    const { permissions } = resolveEffectivePermissions(
      [
        grant({ permissionKeys: ["patient.read", "encounter.read"] }),
        grant({ roleKey: "scheduler", permissionKeys: ["schedule.manage", "patient.read"] }),
      ],
      0,
    );
    expect([...permissions].sort()).toEqual(["encounter.read", "patient.read", "schedule.manage"]);
  });

  it("a disabled role contributes nothing (§2.3.1)", () => {
    const { permissions } = resolveEffectivePermissions(
      [grant({ enabled: false, permissionKeys: ["role.manage"] })],
      0,
    );
    expect(permissions.size).toBe(0);
  });

  it("reports the soonest still-future expiry, ignoring already-closed grants", () => {
    const { soonestExpiryMs } = resolveEffectivePermissions(
      [
        grant({ expiresAt: new Date(5_000) }),
        grant({ expiresAt: new Date(3_000) }),
        grant({ expiresAt: new Date(1_000) }), // already closed at now=2000 → ignored
      ],
      2_000,
    );
    expect(soonestExpiryMs).toBe(3_000);
  });
});

describe("§7.2 — on-call elevation is time-bound", () => {
  it("grants during the window and denies one minute after it closes (same role, same RLS)", () => {
    const shiftEndMs = 60 * 60 * 1000; // an on-call shift ending at T+1h
    const oncall = grant({
      roleKey: "triage_oncall",
      expiresAt: new Date(shiftEndMs),
      permissionKeys: ["patient.read"],
    });

    const duringShift = resolveEffectivePermissions([oncall], shiftEndMs - 60_000);
    expect(duringShift.permissions.has("patient.read")).toBe(true);

    const afterShift = resolveEffectivePermissions([oncall], shiftEndMs + 60_000);
    expect(afterShift.permissions.has("patient.read")).toBe(false);
  });
});

describe("createEffectivePermissionResolver — caching + invalidation (§2.5)", () => {
  it("caches the first resolution and re-reads from cache (store hit once)", async () => {
    let loads = 0;
    const handle = createEffectivePermissionResolver(
      {
        loadGrants: () => {
          loads += 1;
          return [grant({ permissionKeys: ["role.read"] })];
        },
      },
      { clock: () => 0 },
    );
    await handle.resolver(contextFor());
    await handle.resolver(contextFor());
    expect(loads).toBe(1);
  });

  it("invalidateActor drops only that actor's entry (role granted/revoked, §2.5)", async () => {
    let loads = 0;
    const handle = createEffectivePermissionResolver(
      {
        loadGrants: () => {
          loads += 1;
          return [grant()];
        },
      },
      { clock: () => 0 },
    );
    await handle.resolver(contextFor());
    handle.invalidateActor(ORG, USER);
    await handle.resolver(contextFor());
    expect(loads).toBe(2);
  });

  it("invalidateOrg drops every entry for the org (permission set edited, §2.5)", async () => {
    const loads = new Map<string, number>();
    const handle = createEffectivePermissionResolver(
      {
        loadGrants: (orgId, userId) => {
          const key = effectivePermissionCacheKey(orgId, userId);
          loads.set(key, (loads.get(key) ?? 0) + 1);
          return [grant()];
        },
      },
      { clock: () => 0 },
    );
    await handle.resolver(contextFor(ORG, "user-a"));
    await handle.resolver(contextFor(ORG, "user-b"));
    handle.invalidateOrg(ORG);
    await handle.resolver(contextFor(ORG, "user-a"));
    await handle.resolver(contextFor(ORG, "user-b"));
    expect(loads.get(effectivePermissionCacheKey(ORG, "user-a"))).toBe(2);
    expect(loads.get(effectivePermissionCacheKey(ORG, "user-b"))).toBe(2);
  });

  it("caps the cache TTL by the soonest expiry so an expired on-call grant is not served", async () => {
    let nowMs = 0;
    const expiresAt = new Date(10_000);
    const handle = createEffectivePermissionResolver(
      { loadGrants: () => [grant({ expiresAt, permissionKeys: ["patient.read"] })] },
      { clock: () => nowMs, defaultTtlMs: 60 * 60 * 1000 }, // 1h default — would outlive the grant
    );
    const before = await handle.resolver(contextFor());
    expect(before.has("patient.read")).toBe(true);

    nowMs = 11_000; // past the grant's expiry but well inside the default TTL
    const after = await handle.resolver(contextFor());
    expect(after.has("patient.read")).toBe(false); // re-resolved, grant now excluded
  });
});

describe("registerEffectivePermissionResolver — through the contract", () => {
  beforeEach(() => {
    resetRbacEngine();
  });

  it("flips requirePermission from fail-closed to real resolution", async () => {
    // Fail closed before registration (M3-T05 default).
    await expect(requirePermission("role.read")({ context: contextFor() })).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    const { store } = createInMemoryEffectivePermissionStore([
      { orgId: ORG, userId: USER, grants: [grant({ permissionKeys: ["role.read"] })] },
    ]);
    registerEffectivePermissionResolver(store, {
      cache: createInMemoryEffectivePermissionCache({ clock: () => 0 }),
      clock: () => 0,
    });

    await expect(
      requirePermission("role.read")({ context: contextFor() }),
    ).resolves.toBeUndefined();
    await expect(
      requirePermission("role.manage")({ context: contextFor() }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("scopes resolution to the actor's active org (no cross-tenant grant leak)", async () => {
    const { store } = createInMemoryEffectivePermissionStore([
      { orgId: ORG, userId: USER, grants: [grant({ permissionKeys: ["role.read"] })] },
    ]);
    registerEffectivePermissionResolver(store, { clock: () => 0 });

    // Same user id, a different org → no grants → deny.
    await expect(
      requirePermission("role.read")({ context: contextFor("org-2", USER) }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
