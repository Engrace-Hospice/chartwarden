// M34 (GAP-098) — the Drizzle TenantPlatformAbacResolver, unit-tested over injected runners/readers (no DB):
// the real §4.6 predicates run over the resolver so the matrix proves platform_ops + a valid grant passes and
// everything else (absent/expired/revoked grant, same actor, wrong tenant, reader error) stays denied.
import type { AbacContext } from "@wardenx/auth";
import { describe, expect, it } from "vitest";
import { buildTenantPlatformAbacPredicates } from "./abac-predicates";
import {
  type PlatformFactsReader,
  createDrizzleTenantPlatformAbacResolver,
} from "./abac-resolver-drizzle";

const NOW = new Date("2026-10-05T12:00:00Z");
const HOUR = 3_600_000;
const PLATFORM_ORG = "00000000-0000-4000-8000-000000000001";
const TENANT = "00000000-0000-4000-8000-0000000000aa";
const GRANT = "00000000-0000-4000-8000-0000000000b1";
const GRANTOR = "00000000-0000-4000-8000-0000000000c1";
const OPERATOR = "00000000-0000-4000-8000-0000000000d1";

const grantRow = (
  over: Partial<{ revokedAt: Date | null; expiresAt: Date; tenantAccountId: string }> = {},
) => ({
  id: GRANT,
  tenantAccountId: TENANT,
  grantorMembershipId: GRANTOR,
  revokedAt: null,
  expiresAt: new Date(NOW.getTime() + HOUR),
  ...over,
});

function build(
  overrides: Partial<PlatformFactsReader> = {},
  flagRows = [] as { organizationId: string | null }[],
) {
  const reader: PlatformFactsReader = {
    findGrant: async (id) => (id === GRANT ? grantRow() : null),
    listOpenSessions: async () => [
      {
        id: "s1",
        supportConsentGrantId: GRANT,
        actorMembershipId: OPERATOR,
        expiresAt: new Date(NOW.getTime() + HOUR),
      },
    ],
    findOnboardingTask: async () => null,
    organizationHasTenantAccount: async () => false,
    ...overrides,
  };
  const resolver = createDrizzleTenantPlatformAbacResolver({
    runPlatform: (_reason, fn) => fn({} as never),
    runOrg: (_org, fn) => fn({} as never),
    reader: () => reader,
    loadFlagRows: async () => flagRows,
    now: () => NOW,
  });
  const predicates = buildTenantPlatformAbacPredicates({ resolver });
  return { resolver, predicates };
}

const ctx = (roles: string[], membershipId: string | null = OPERATOR): AbacContext =>
  ({
    organizationId: PLATFORM_ORG,
    userId: "u1",
    roles,
    attributes: membershipId ? { membershipId } : {},
  }) as unknown as AbacContext;

describe("M34 Drizzle ABAC resolver (GAP-098)", () => {
  it("start: platform_ops operator distinct from the grantor with an active grant passes", async () => {
    const { predicates } = build();
    const ok = await predicates.support_session_actor_distinct_from_grantor!(
      ctx(["platform_ops"]),
      {
        supportConsentGrantId: GRANT,
      },
    );
    expect(ok).toBe(true);
  });

  it("start: denies when the actor is the grantor, grant absent, revoked or expired", async () => {
    const target = { supportConsentGrantId: GRANT };
    expect(
      await build().predicates.support_session_actor_distinct_from_grantor!(
        ctx(["platform_ops"], GRANTOR),
        target,
      ),
    ).toBe(false);
    expect(
      await build({ findGrant: async () => null }).predicates
        .support_session_actor_distinct_from_grantor!(ctx(["platform_ops"]), target),
    ).toBe(false);
    expect(
      await build({ findGrant: async () => grantRow({ revokedAt: NOW }) }).predicates
        .support_session_actor_distinct_from_grantor!(ctx(["platform_ops"]), target),
    ).toBe(false);
    expect(
      await build({ findGrant: async () => grantRow({ expiresAt: new Date(NOW.getTime() - 1) }) })
        .predicates.support_session_actor_distinct_from_grantor!(ctx(["platform_ops"]), target),
    ).toBe(false);
  });

  it("elevate: open session of this actor on an active grant for the tenant passes", async () => {
    const { predicates } = build();
    expect(
      await predicates.tenant_consented_support_active!(ctx(["platform_ops"]), {
        tenantAccountId: TENANT,
      }),
    ).toBe(true);
  });

  it("elevate: denies another actor, an expired session, a revoked grant or a different tenant's grant", async () => {
    const target = { tenantAccountId: TENANT };
    expect(
      await build().predicates.tenant_consented_support_active!(
        ctx(["platform_ops"], "other"),
        target,
      ),
    ).toBe(false);
    expect(
      await build({
        listOpenSessions: async () => [
          {
            id: "s1",
            supportConsentGrantId: GRANT,
            actorMembershipId: OPERATOR,
            expiresAt: new Date(NOW.getTime() - 1),
          },
        ],
      }).predicates.tenant_consented_support_active!(ctx(["platform_ops"]), target),
    ).toBe(false);
    expect(
      await build({ findGrant: async () => grantRow({ revokedAt: NOW }) }).predicates
        .tenant_consented_support_active!(ctx(["platform_ops"]), target),
    ).toBe(false);
    expect(
      await build({ findGrant: async () => grantRow({ tenantAccountId: "other-tenant" }) })
        .predicates.tenant_consented_support_active!(ctx(["platform_ops"]), target),
    ).toBe(false);
  });

  describe("feature_flag_write_authority matrix", () => {
    const FOREIGN_ORG = TENANT;
    const decide = (
      roles: string[],
      target: Record<string, unknown>,
      flagRows: { organizationId: string | null }[],
      reader: Partial<PlatformFactsReader> = {},
    ) => build(reader, flagRows).predicates.feature_flag_write_authority!(ctx(roles), target);
    const tenantKnown = { organizationHasTenantAccount: async () => true };

    it("platform_ops may write an existing global flag; org_admin and others may not", async () => {
      const rows = [{ organizationId: null }];
      expect(await decide(["platform_ops"], { flagKey: "k" }, rows)).toBe(true);
      expect(await decide(["platform_ops"], { flagKey: "k", organizationId: null }, rows)).toBe(
        true,
      );
      expect(await decide(["org_admin"], { flagKey: "k" }, rows)).toBe(false);
      expect(await decide(["nurse"], { flagKey: "k" }, rows)).toBe(false);
    });

    it("platform_ops may CREATE an absent global key; every other role is still denied", async () => {
      expect(await decide(["platform_ops"], { flagKey: "new" }, [])).toBe(true);
      expect(await decide(["org_admin"], { flagKey: "new" }, [])).toBe(false);
      expect(await decide(["nurse"], { flagKey: "new" }, [])).toBe(false);
      expect(await decide([], { flagKey: "new" }, [])).toBe(false);
    });

    it("an absent key in a per-tenant scope is creatable by platform_ops only, and only for a real tenant", async () => {
      const target = { flagKey: "new", organizationId: FOREIGN_ORG };
      expect(await decide(["platform_ops"], target, [], tenantKnown)).toBe(true);
      expect(
        await decide(["platform_ops"], target, [], {
          organizationHasTenantAccount: async () => false,
        }),
      ).toBe(false);
      expect(await decide(["org_admin"], target, [], tenantKnown)).toBe(false);
      // own org, absent: org_admin still cannot create
      expect(
        await decide(
          ["org_admin"],
          { flagKey: "new", organizationId: PLATFORM_ORG },
          [],
          tenantKnown,
        ),
      ).toBe(false);
    });

    it("platform_ops resolves a per-tenant flag in ANOTHER org through the body's organizationId", async () => {
      const rows = [{ organizationId: FOREIGN_ORG }];
      expect(
        await decide(["platform_ops"], { flagKey: "k", organizationId: FOREIGN_ORG }, rows),
      ).toBe(true);
      // no organizationId => global scope, where that key is absent: create path, still platform_ops only
      expect(await decide(["org_admin"], { flagKey: "k" }, rows)).toBe(false);
    });

    it("a same-key GLOBAL row never shadows the org's own row (and vice versa)", async () => {
      const both = [{ organizationId: null }, { organizationId: PLATFORM_ORG }];
      // org_admin targets its OWN row: allowed despite the global row of the same key
      expect(
        await decide(["org_admin"], { flagKey: "k", organizationId: PLATFORM_ORG }, both),
      ).toBe(true);
      // org_admin targeting global scope: denied
      expect(await decide(["org_admin"], { flagKey: "k" }, both)).toBe(false);
      // a global row alone does not make a tenant-scope target "exist" for org_admin
      expect(
        await decide(
          ["org_admin"],
          { flagKey: "k", organizationId: PLATFORM_ORG },
          [{ organizationId: null }],
          tenantKnown,
        ),
      ).toBe(false);
    });

    it("org_admin may write only its OWN org's existing flag, never another org's", async () => {
      expect(
        await decide(["org_admin"], { flagKey: "k", organizationId: PLATFORM_ORG }, [
          { organizationId: PLATFORM_ORG },
        ]),
      ).toBe(true);
      expect(
        await decide(["org_admin"], { flagKey: "k", organizationId: FOREIGN_ORG }, [
          { organizationId: FOREIGN_ORG },
        ]),
      ).toBe(false);
    });

    it("denies a missing, empty or malformed flagKey / organizationId", async () => {
      const rows = [{ organizationId: null }];
      expect(await decide(["platform_ops"], {}, rows)).toBe(false);
      expect(await decide(["platform_ops"], { flagKey: "" }, rows)).toBe(false);
      expect(await decide(["platform_ops"], { flagKey: "k", organizationId: 7 }, rows)).toBe(false);
      expect(await decide(["platform_ops"], { flagKey: "k", organizationId: "" }, rows)).toBe(
        false,
      );
    });

    it("denies when the flag loader or the tenant lookup throws", async () => {
      const throwingLoader = buildTenantPlatformAbacPredicates({
        resolver: createDrizzleTenantPlatformAbacResolver({
          runPlatform: (_r, fn) => fn({} as never),
          runOrg: (_o, fn) => fn({} as never),
          loadFlagRows: async () => {
            throw new Error("db down");
          },
          now: () => NOW,
        }),
      });
      expect(
        await throwingLoader.feature_flag_write_authority!(ctx(["platform_ops"]), { flagKey: "k" }),
      ).toBe(false);
      expect(
        await decide(["platform_ops"], { flagKey: "k", organizationId: FOREIGN_ORG }, [], {
          organizationHasTenantAccount: async () => {
            throw new Error("db down");
          },
        }),
      ).toBe(false);
    });

    it("a predicate-level throw denies (resolver that rejects outright)", async () => {
      const predicates = buildTenantPlatformAbacPredicates({
        resolver: {
          hasActiveConsentedSupportSession: async () => false,
          loadConsentGrant: async () => null,
          loadFeatureFlag: async () => {
            throw new Error("boom");
          },
          loadOnboardingTask: async () => null,
        },
      });
      expect(
        await predicates.feature_flag_write_authority!(ctx(["platform_ops"]), { flagKey: "k" }),
      ).toBe(false);
    });
  });

  it("onboarding task: only the assignee (resolved in the caller's org) passes", async () => {
    const task = { taskId: "t1", organizationId: PLATFORM_ORG, assignedToMembershipId: OPERATOR };
    const { predicates } = build({ findOnboardingTask: async () => task });
    expect(
      await predicates.onboarding_task_assignee_or_owner!(ctx(["nurse"]), { taskId: "t1" }),
    ).toBe(true);
    expect(
      await predicates.onboarding_task_assignee_or_owner!(ctx(["nurse"], "someone"), {
        taskId: "t1",
      }),
    ).toBe(false);
    const cross = build({ findOnboardingTask: async () => ({ ...task, organizationId: TENANT }) });
    expect(
      await cross.predicates.onboarding_task_assignee_or_owner!(ctx(["nurse"]), { taskId: "t1" }),
    ).toBe(false);
  });

  it("every reader/runner error denies (never throws out of the predicate)", async () => {
    const boom = async () => {
      throw new Error("db down");
    };
    const { predicates } = build({
      findGrant: boom,
      listOpenSessions: boom,
      findOnboardingTask: boom,
    });
    expect(
      await predicates.support_session_actor_distinct_from_grantor!(ctx(["platform_ops"]), {
        supportConsentGrantId: GRANT,
      }),
    ).toBe(false);
    expect(
      await predicates.tenant_consented_support_active!(ctx(["platform_ops"]), {
        tenantAccountId: TENANT,
      }),
    ).toBe(false);
    expect(
      await predicates.onboarding_task_assignee_or_owner!(ctx(["nurse"]), { taskId: "t1" }),
    ).toBe(false);
  });
});
