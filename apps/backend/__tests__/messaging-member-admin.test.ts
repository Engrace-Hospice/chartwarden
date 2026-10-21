/**
 * GAP-103 — M36 member add/remove: the location ABAC (`channel_member_admin`, spec §4.5
 * `messaging.manage_members` = org_admin, clinical_lead limited to their location channels) at the
 * route AND service layer, plus the real audit actor on the writes. No live infra.
 */
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import {
  type MemberAdminActor,
  type MessagingRouteService,
  createInMemoryMessagingService,
  mayManageChannelMembers,
  mayManageChannelMembersResolved,
} from "@chartwarden/messaging";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const txHolder: { tx: unknown; ctx: Array<{ organizationId: string; userId: string }> } = {
  tx: undefined,
  ctx: [],
};
vi.mock("@chartwarden/tenancy", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  withOrgContext: async (
    _db: unknown,
    ctx: { organizationId: string; userId: string },
    fn: (tx: unknown) => unknown,
  ) => {
    txHolder.ctx.push(ctx);
    return fn(txHolder.tx);
  },
}));

import { buildServer, getSeam } from "../src/bootstrap/index";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import {
  CHANNEL_MEMBER_ADMIN_PREDICATE,
  CHANNEL_VISIBILITY_PREDICATE,
  registerMessagingRoutes,
} from "../src/modules/36-messaging/index";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { channelMemberAdminPredicate } from "../src/modules/36-messaging/routes/messaging-routes";

const ORG = "11111111-1111-4111-8111-111111111111";
const LOC_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOC_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CH_LOC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CH_CT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CH_CT_B = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
const CH_CT_MULTI = "dddddddd-dddd-4ddd-8ddd-ddddddddddd3";
const CH_CT_NONE = "dddddddd-dddd-4ddd-8ddd-ddddddddddd4";
const CH_CT_BOOM = "dddddddd-dddd-4ddd-8ddd-ddddddddddd5";
const CH_ONCALL = "dddddddd-dddd-4ddd-8ddd-ddddddddddd6";

/** patient id -> sited location ids; "pt_boom" simulates an unbound/throwing seam. */
const SITING: Record<string, readonly string[]> = {
  pt_1: [LOC_A],
  pt_b: [LOC_B],
  pt_multi: [LOC_B, LOC_A],
  pt_none: [],
};
function registerFakeSiting(calls: Array<{ organizationId: string; patientId: string }> = []) {
  registerSeam("PatientSitingReader", {
    async getPatientLocationIds(input) {
      calls.push(input);
      if (input.patientId === "pt_boom") throw new Error("NotImplementedError: seam unbound");
      return SITING[input.patientId] ?? [];
    },
  });
}
const sitingResolver = (organizationId: string, patientId: string) =>
  getSeam("PatientSitingReader").getPatientLocationIds({ organizationId, patientId });

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const locs = request.headers["x-test-locs"];
  request.context.locationIds = typeof locs === "string" && locs.length > 0 ? locs.split(",") : [];
}

const LEAD_A = { "x-test-user": "lead_a", "x-test-roles": "clinical_lead", "x-test-locs": LOC_A };
const LEAD_B = { "x-test-user": "lead_b", "x-test-roles": "clinical_lead", "x-test-locs": LOC_B };
const ADMIN = { "x-test-user": "admin_1", "x-test-roles": "org_admin", "x-test-locs": "" };

function makeServer() {
  const service: MessagingRouteService = createInMemoryMessagingService({
    seed: {
      eligibleStaff: [
        { orgId: ORG, userId: "rn_9", displayName: "Nurse Nine", roles: ["Registered Nurse"] },
        { orgId: ORG, userId: "lead_a", displayName: "Lead A", roles: ["Clinical Lead"] },
        { orgId: ORG, userId: "lead_b", displayName: "Lead B", roles: ["Clinical Lead"] },
      ],
      channels: [
        { channelId: CH_LOC, orgId: ORG, kind: "location", subjectId: LOC_A, members: [] },
        { channelId: CH_CT, orgId: ORG, kind: "care_team", subjectId: "pt_1", members: [] },
        { channelId: CH_CT_B, orgId: ORG, kind: "care_team", subjectId: "pt_b", members: [] },
        {
          channelId: CH_CT_MULTI,
          orgId: ORG,
          kind: "care_team",
          subjectId: "pt_multi",
          members: [],
        },
        { channelId: CH_CT_NONE, orgId: ORG, kind: "care_team", subjectId: "pt_none", members: [] },
        { channelId: CH_CT_BOOM, orgId: ORG, kind: "care_team", subjectId: "pt_boom", members: [] },
        { channelId: CH_ONCALL, orgId: ORG, kind: "on_call", subjectId: LOC_A, members: [] },
      ],
    },
    resolvePatientLocationIds: sitingResolver,
  });
  const store = createInMemoryEffectivePermissionStore(
    ["lead_a", "lead_b", "admin_1"].map((userId) => ({
      orgId: ORG,
      userId,
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: ["messaging.read", "messaging.manage_members"],
        },
      ],
    })),
  );
  registerEffectivePermissionResolver(store.store);
  const registry = createPredicateRegistry();
  registry.register(CHANNEL_VISIBILITY_PREDICATE, () => true);
  registry.register(CHANNEL_MEMBER_ADMIN_PREDICATE, channelMemberAdminPredicate(service));
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerMessagingRoutes(app, { service, announcements: service as never });
  return { app, service };
}

beforeEach(() => {
  __resetSeamsForTest();
  registerFakeSiting();
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
  txHolder.ctx = [];
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

const add = (url: string, headers: Record<string, string>, userId = "rn_9") =>
  ({
    method: "POST",
    url: `/api/v1/messaging/channels/${url}/members`,
    headers,
    payload: { userId },
  }) as const;

describe("route layer: channel_member_admin ABAC", () => {
  it("clinical_lead may add to a location channel in their own location", async () => {
    const { app } = makeServer();
    expect((await app.inject(add(CH_LOC, LEAD_A))).statusCode).toBe(204);
    await app.close();
  });

  it("clinical_lead is denied on a location channel outside their location (403)", async () => {
    const { app } = makeServer();
    expect((await app.inject(add(CH_LOC, LEAD_B))).statusCode).toBe(403);
    await app.close();
  });

  it("clinical_lead may manage a care_team channel of a patient sited at their location (204)", async () => {
    const { app } = makeServer();
    expect((await app.inject(add(CH_CT, LEAD_A))).statusCode).toBe(204);
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/messaging/channels/${CH_CT}/members/rn_9`,
      headers: LEAD_A,
    });
    expect(del.statusCode).toBe(204);
    await app.close();
  });

  it("clinical_lead is denied on a care_team channel of a patient sited elsewhere (403)", async () => {
    const { app } = makeServer();
    expect((await app.inject(add(CH_CT_B, LEAD_A, "lead_a"))).statusCode).toBe(403);
    expect((await app.inject(add(CH_CT, LEAD_B, "lead_b"))).statusCode).toBe(403);
    await app.close();
  });

  it("a patient with several active admissions: one matching location is enough (204)", async () => {
    const { app } = makeServer();
    expect((await app.inject(add(CH_CT_MULTI, LEAD_A))).statusCode).toBe(204);
    await app.close();
  });

  it("denies (403) when the patient is unsited or the siting seam throws", async () => {
    const { app } = makeServer();
    expect((await app.inject(add(CH_CT_NONE, LEAD_A))).statusCode).toBe(403);
    expect((await app.inject(add(CH_CT_BOOM, LEAD_A))).statusCode).toBe(403);
    __resetSeamsForTest(); // seam unbound entirely -> resolver throws -> deny
    expect((await app.inject(add(CH_CT, LEAD_A))).statusCode).toBe(403);
    await app.close();
  });

  it("clinical_lead stays denied on other channel kinds (on_call)", async () => {
    const { app } = makeServer();
    expect((await app.inject(add(CH_ONCALL, LEAD_A))).statusCode).toBe(403);
    await app.close();
  });

  it("the siting seam is queried org-explicitly, and not for org_admin", async () => {
    const calls: Array<{ organizationId: string; patientId: string }> = [];
    registerFakeSiting(calls);
    const { app } = makeServer();
    await app.inject(add(CH_CT, ADMIN));
    expect(calls).toHaveLength(0);
    await app.inject(add(CH_CT, LEAD_A));
    expect(calls[0]).toEqual({ organizationId: ORG, patientId: "pt_1" });
    await app.close();
  });

  it("org_admin may add anywhere and remove; unknown channel is denied, not 204", async () => {
    const { app } = makeServer();
    expect((await app.inject(add(CH_CT, ADMIN))).statusCode).toBe(204);
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/messaging/channels/${CH_CT}/members/rn_9`,
      headers: ADMIN,
    });
    expect(del.statusCode).toBe(204);
    const missing = await app.inject(add("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", ADMIN));
    expect(missing.statusCode).toBeGreaterThanOrEqual(403);
    await app.close();
  });

  it("DELETE is gated by the same predicate", async () => {
    const { app } = makeServer();
    expect((await app.inject(add(CH_LOC, LEAD_A))).statusCode).toBe(204);
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/messaging/channels/${CH_LOC}/members/rn_9`,
      headers: LEAD_B,
    });
    expect(del.statusCode).toBe(403);
    await app.close();
  });
});

describe("pure rule: care_team siting", () => {
  const lead: MemberAdminActor = {
    kind: "user",
    userId: "l",
    roles: ["clinical_lead"],
    locationIds: [LOC_A],
  };
  const ct = { kind: "care_team", subjectId: "pt_1" } as const;
  it("passes only on an intersecting resolved location", () => {
    expect(mayManageChannelMembers(lead, ct, [LOC_B, LOC_A])).toBe(true);
    expect(mayManageChannelMembers(lead, ct, [LOC_B])).toBe(false);
    expect(mayManageChannelMembers(lead, ct, [])).toBe(false);
    expect(mayManageChannelMembers(lead, ct)).toBe(false);
    expect(mayManageChannelMembers(lead, { kind: "on_call", subjectId: "pt_1" }, [LOC_A])).toBe(
      false,
    );
    expect(mayManageChannelMembers(lead, { kind: "care_team", subjectId: null }, [LOC_A])).toBe(
      false,
    );
  });
  it("the resolved variant treats a throwing resolver as deny and skips it for org_admin", async () => {
    const boom = async () => {
      throw new Error("x");
    };
    expect(await mayManageChannelMembersResolved(lead, ct, boom)).toBe(false);
    const admin: MemberAdminActor = {
      kind: "user",
      userId: "a",
      roles: ["org_admin"],
      locationIds: [],
    };
    expect(await mayManageChannelMembersResolved(admin, ct, boom)).toBe(true);
    expect(await mayManageChannelMembersResolved(lead, ct, async () => [LOC_A])).toBe(true);
    expect(await mayManageChannelMembersResolved(lead, ct, undefined)).toBe(false);
  });
});

describe("service layer: enforces independently of the route", () => {
  it("in-memory addMember allows a lead on a patient sited at their location, not elsewhere", async () => {
    const { service } = makeServer();
    const leadA = {
      kind: "user",
      userId: "lead_a",
      roles: ["clinical_lead"],
      locationIds: [LOC_A],
    } as const;
    await expect(
      service.addMember(ORG, { channelId: CH_CT, userId: "rn_9", actor: leadA }),
    ).resolves.toBeUndefined();
    await expect(
      service.addMember(ORG, { channelId: CH_CT_B, userId: "rn_9", actor: leadA }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  const leadB = {
    kind: "user",
    userId: "lead_b",
    roles: ["clinical_lead"],
    locationIds: [LOC_B],
  } as const;

  it("in-memory addMember rejects an out-of-scope user actor", async () => {
    const { service } = makeServer();
    await expect(
      service.addMember(ORG, { channelId: CH_LOC, userId: "rn_9", actor: leadB }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("in-memory addMember allows the explicit system actor", async () => {
    const { service } = makeServer();
    await expect(
      service.addMember(ORG, { channelId: CH_CT, userId: "rn_9", actor: { kind: "system" } }),
    ).resolves.toBeUndefined();
  });

  it("a role string alone does not make a system actor (no location scope, care_team)", async () => {
    const { service } = makeServer();
    await expect(
      service.removeMember(ORG, {
        channelId: CH_CT,
        userId: "rn_9",
        actor: { kind: "user", userId: "x", roles: ["system"], locationIds: [] },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

function fakeTx(selects: unknown[][], captured: { insert?: unknown; update?: unknown }) {
  let n = 0;
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.innerJoin = () => c;
    c.where = () => c;
    c.limit = async () => rows;
    return c;
  };
  return {
    select: () => chain(selects[n++] ?? []),
    // member-category-gate reads the excluded-category holders with selectDistinct(...).from().innerJoin()...where().
    selectDistinct: () => {
      const c: Record<string, unknown> = {};
      c.from = () => c;
      c.innerJoin = () => c;
      c.where = async () => [];
      return c;
    },
    insert: () => ({
      values: async (v: unknown) => {
        captured.insert = v;
      },
    }),
    update: () => ({
      set: (v: unknown) => {
        captured.update = v;
        return { where: () => ({ returning: async () => [{ id: "cm_1" }] }) };
      },
    }),
  };
}

describe("DB service: authorizes and records the real actor", () => {
  const channelLoc = { id: CH_LOC, kind: "location", isArchived: false, subjectId: LOC_A };
  const leadA = {
    kind: "user",
    userId: "lead_a",
    roles: ["clinical_lead"],
    locationIds: [LOC_A],
  } as const;
  const leadB = {
    kind: "user",
    userId: "lead_b",
    roles: ["clinical_lead"],
    locationIds: [LOC_B],
  } as const;

  it("addMember passes the actor userId (not empty) into withOrgContext", async () => {
    const captured: { insert?: unknown } = {};
    txHolder.tx = fakeTx([[channelLoc], [{ id: "membership-rn-9" }], []], captured);
    const svc = createDbMessagingRouteService({} as never);
    await svc.addMember(ORG, { channelId: CH_LOC, userId: "rn_9", actor: leadA });
    expect(txHolder.ctx[0]?.userId).toBe("lead_a");
    expect(captured.insert).toBeDefined();
  });

  it("removeMember passes the actor userId into withOrgContext", async () => {
    txHolder.tx = fakeTx([[channelLoc]], {});
    const svc = createDbMessagingRouteService({} as never);
    await svc.removeMember(ORG, { channelId: CH_LOC, userId: "rn_9", actor: leadA });
    expect(txHolder.ctx[0]?.userId).toBe("lead_a");
  });

  it("addMember rejects an out-of-scope actor before any write", async () => {
    const captured: { insert?: unknown } = {};
    txHolder.tx = fakeTx([[channelLoc], []], captured);
    const svc = createDbMessagingRouteService({} as never);
    await expect(
      svc.addMember(ORG, { channelId: CH_LOC, userId: "rn_9", actor: leadB }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(captured.insert).toBeUndefined();
  });

  const channelCt = (subjectId: string) => ({
    id: CH_CT,
    kind: "care_team",
    isArchived: false,
    subjectId,
  });

  it("addMember on a care_team channel passes for a patient sited at the lead's location", async () => {
    const captured: { insert?: unknown } = {};
    txHolder.tx = fakeTx([[channelCt("pt_1")], [{ id: "membership-rn-9" }], []], captured);
    const svc = createDbMessagingRouteService({} as never);
    await svc.addMember(ORG, { channelId: CH_CT, userId: "rn_9", actor: leadA });
    expect(captured.insert).toBeDefined();
  });

  it("addMember on a care_team channel is rejected for a patient sited elsewhere / unsited / seam throw", async () => {
    for (const patient of ["pt_b", "pt_none", "pt_boom"]) {
      const captured: { insert?: unknown } = {};
      txHolder.tx = fakeTx([[channelCt(patient)], []], captured);
      const svc = createDbMessagingRouteService({} as never);
      await expect(
        svc.addMember(ORG, { channelId: CH_CT, userId: "rn_9", actor: leadA }),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(captured.insert).toBeUndefined();
    }
  });

  it("canManageMembers resolves siting for a care_team channel and fails closed when unbound", async () => {
    txHolder.tx = fakeTx([[channelCt("pt_multi")]], {});
    const svc = createDbMessagingRouteService({} as never);
    expect(await svc.canManageMembers(ORG, leadA, CH_CT)).toBe(true);
    __resetSeamsForTest();
    txHolder.tx = fakeTx([[channelCt("pt_multi")]], {});
    expect(await svc.canManageMembers(ORG, leadA, CH_CT)).toBe(false);
  });

  it("canManageMembers fails closed on an unknown channel", async () => {
    txHolder.tx = fakeTx([[]], {});
    const svc = createDbMessagingRouteService({} as never);
    expect(await svc.canManageMembers(ORG, leadA, CH_LOC)).toBe(false);
  });
});
