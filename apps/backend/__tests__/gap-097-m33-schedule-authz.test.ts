// GAP-097 — M33 scheduled-report authorization (owner / visibility / org_admin), route + service layer.
// RED-first: before the fix the schedule routes were permission-only and the service checked only the org,
// so a non-owner could create over another user's private view, edit/pause/cancel another user's schedule,
// and list every schedule in the org.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { NotFoundError } from "@wardenx/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  M33_PERMISSION_KEYS,
  type ReportingAbacResolver,
  buildM33AbacPredicates,
  denyStubReportingAbacResolver,
  mountM33WriteRoutes,
} from "../src/modules/33-reporting/index";
import {
  type M33WriteRouteService,
  createInMemoryM33WriteBackend,
} from "../src/modules/33-reporting/routes/index";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string" && membership.length > 0) {
    request.context.attributes.membershipId = membership;
  }
  if (request.headers["x-step-up"] === "fresh") request.context.attributes.stepUpRecent = true;
}

const ORG = "org_a";
const M_OWNER = "10000000-0000-4000-8000-0000000000a1";
const M_OTHER = "10000000-0000-4000-8000-0000000000b2";
const M_RECIP = "10000000-0000-4000-8000-0000000000c3";
const M_ADMIN = "10000000-0000-4000-8000-0000000000d4";
const VIEW_OWNER_PRIVATE = "20000000-0000-4000-8000-0000000000a1";
const VIEW_OWNER_ORG = "20000000-0000-4000-8000-0000000000a2";

const hdr = (user: string, membership: string, roles: string): Record<string, string> => ({
  "x-test-user": user,
  "x-test-org": ORG,
  "x-test-roles": roles,
  "x-test-membership": membership,
});
const OWNER = hdr("owner_1", M_OWNER, "analyst");
const OTHER = hdr("other_1", M_OTHER, "analyst");
const RECIP = hdr("recip_1", M_RECIP, "analyst");
const ADMIN = hdr("admin_1", M_ADMIN, "org_admin");

const ADMIN_ACTOR = {
  organizationId: ORG,
  userId: "resolver",
  roles: ["org_admin"],
  membershipId: "resolver",
};

function buildResolver(service: M33WriteRouteService): ReportingAbacResolver {
  return {
    ...denyStubReportingAbacResolver,
    async loadReportView(organizationId, viewId) {
      try {
        const v = await service.getView({ ...ADMIN_ACTOR, organizationId }, viewId);
        return {
          viewId: v.id,
          organizationId: v.organizationId,
          ownerMembershipId: v.ownerMembershipId,
          shareScope: v.shareScope,
          shareRoleKeys: v.shareRoleKeys ?? [],
        };
      } catch {
        return null;
      }
    },
    async loadReportSchedule(organizationId, scheduleId) {
      try {
        const s = await service.getSchedule({ ...ADMIN_ACTOR, organizationId }, scheduleId);
        return {
          scheduleId: s.id,
          organizationId: s.organizationId,
          ownerMembershipId: s.ownerMembershipId,
          recipientMembershipIds: s.recipientMembershipIds,
        };
      } catch {
        return null;
      }
    },
  };
}

function makeServer() {
  const write = createInMemoryM33WriteBackend({
    views: [
      {
        id: VIEW_OWNER_PRIVATE,
        organizationId: ORG,
        ownerMembershipId: M_OWNER,
        shareScope: "private",
      },
      { id: VIEW_OWNER_ORG, organizationId: ORG, ownerMembershipId: M_OWNER, shareScope: "org" },
    ],
  });
  const users = ["owner_1", "other_1", "recip_1", "admin_1"];
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      users.map((userId) => ({
        orgId: ORG,
        userId,
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: [...M33_PERMISSION_KEYS],
          },
        ],
      })),
    ).store,
  );
  const reg = createPredicateRegistry();
  const resolver = buildResolver(write.service);
  for (const [name, predicate] of Object.entries(buildM33AbacPredicates({ resolver }))) {
    reg.register(name, predicate);
  }
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM33WriteRoutes(app, write.service);
  return { app, write };
}

let n = 0;
const idem = (): string => `gap097-${++n}`;
const SCHEDULE_BODY = (viewId: string, recipients: string[] = [M_RECIP]) => ({
  reportViewId: viewId,
  cronExpression: "0 6 * * *",
  tenantTimezone: "America/New_York",
  format: "csv",
  recipientMembershipIds: recipients,
});

async function createAs(
  app: FastifyInstance,
  headers: Record<string, string>,
  viewId: string,
): Promise<{ status: number; id: string; owner: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/reporting/schedules",
    headers: { ...headers, "idempotency-key": idem() },
    payload: SCHEDULE_BODY(viewId),
  });
  const json = res.json() as { id?: string; ownerMembershipId?: string };
  return { status: res.statusCode, id: json.id ?? "", owner: json.ownerMembershipId ?? "" };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("GAP-097 — create honours view visibility and derives the owner from the session", () => {
  it("refuses (404) a non-owner scheduling another user's PRIVATE view", async () => {
    const { app } = makeServer();
    const res = await createAs(app, OTHER, VIEW_OWNER_PRIVATE);
    expect(res.status).toBe(404);
    await app.close();
  });

  it("allows scheduling an ORG-shared view and stamps the session membership as owner", async () => {
    const { app } = makeServer();
    const res = await createAs(app, OTHER, VIEW_OWNER_ORG);
    expect(res.status).toBe(201);
    expect(res.owner).toBe(M_OTHER);
    await app.close();
  });

  it("allows the view owner to schedule a private view", async () => {
    const { app } = makeServer();
    const res = await createAs(app, OWNER, VIEW_OWNER_PRIVATE);
    expect(res.status).toBe(201);
    expect(res.owner).toBe(M_OWNER);
    await app.close();
  });
});

describe("GAP-097 — non-owner, non-admin callers are refused on every :id route", () => {
  const MUTATIONS: ReadonlyArray<{
    label: string;
    method: "PATCH" | "POST";
    path: string;
    payload?: object;
  }> = [
    { label: "update", method: "PATCH", path: "", payload: { tenantTimezone: "America/Chicago" } },
    { label: "pause", method: "POST", path: "/pause" },
    { label: "resume", method: "POST", path: "/resume" },
    { label: "cancel", method: "POST", path: "/cancel" },
  ];

  it.each(MUTATIONS)("$label by a stranger → 404", async ({ method, path, payload }) => {
    const { app } = makeServer();
    const created = await createAs(app, OWNER, VIEW_OWNER_ORG);
    const res = await app.inject({
      method,
      url: `/api/v1/reporting/schedules/${created.id}${path}`,
      headers: { ...OTHER, "idempotency-key": idem() },
      ...(payload ? { payload } : {}),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it.each(["", "/runs"])("read %s by a stranger → 404", async (path) => {
    const { app } = makeServer();
    const created = await createAs(app, OWNER, VIEW_OWNER_ORG);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reporting/schedules/${created.id}${path}`,
      headers: OTHER,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("delete_all_runs is org_admin only — the owner (non-admin) gets 404, admin 200", async () => {
    const { app } = makeServer();
    const created = await createAs(app, OWNER, VIEW_OWNER_ORG);
    const asOwner = await app.inject({
      method: "POST",
      url: `/api/v1/reporting/schedules/${created.id}/delete_all_runs`,
      headers: { ...OWNER, "x-step-up": "fresh", "idempotency-key": idem() },
    });
    expect(asOwner.statusCode).toBe(404);
    const asAdmin = await app.inject({
      method: "POST",
      url: `/api/v1/reporting/schedules/${created.id}/delete_all_runs`,
      headers: { ...ADMIN, "x-step-up": "fresh", "idempotency-key": idem() },
    });
    expect(asAdmin.statusCode).toBe(200);
    await app.close();
  });

  it("the service layer refuses a stranger even when the route guard is bypassed", async () => {
    const { write } = makeServer();
    const owner = {
      organizationId: ORG,
      userId: "owner_1",
      roles: ["analyst"],
      membershipId: M_OWNER,
    };
    const other = {
      organizationId: ORG,
      userId: "other_1",
      roles: ["analyst"],
      membershipId: M_OTHER,
    };
    const s = await write.service.createSchedule(owner, {
      reportViewId: VIEW_OWNER_ORG,
      cronExpression: "0 6 * * *",
      tenantTimezone: "America/New_York",
      format: "csv",
      recipientMembershipIds: [],
    });
    await expect(write.service.pauseSchedule(other, s.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(write.service.getSchedule(other, s.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      write.service.createSchedule(other, {
        reportViewId: VIEW_OWNER_PRIVATE,
        cronExpression: "0 6 * * *",
        tenantTimezone: "America/New_York",
        format: "csv",
        recipientMembershipIds: [],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("GAP-097 — owner, org_admin and recipients keep their legitimate access", () => {
  it("owner and org_admin can pause; a recipient can read but not mutate", async () => {
    const { app } = makeServer();
    const created = await createAs(app, OWNER, VIEW_OWNER_ORG);
    const url = `/api/v1/reporting/schedules/${created.id}`;
    const ownerPause = await app.inject({
      method: "POST",
      url: `${url}/pause`,
      headers: { ...OWNER, "idempotency-key": idem() },
    });
    expect(ownerPause.statusCode).toBe(201);
    const adminResume = await app.inject({
      method: "POST",
      url: `${url}/resume`,
      headers: { ...ADMIN, "idempotency-key": idem() },
    });
    expect(adminResume.statusCode).toBe(201);
    const recipRead = await app.inject({ method: "GET", url, headers: RECIP });
    expect(recipRead.statusCode).toBe(200);
    const recipPause = await app.inject({
      method: "POST",
      url: `${url}/pause`,
      headers: { ...RECIP, "idempotency-key": idem() },
    });
    expect(recipPause.statusCode).toBe(404);
    await app.close();
  });
});

describe("GAP-097 — list filters by owner / recipient / admin and honours the status filter", () => {
  it("each caller sees only the schedules they own or receive; admin sees all", async () => {
    const { app } = makeServer();
    const mine = await createAs(app, OWNER, VIEW_OWNER_ORG); // recipient: M_RECIP
    const theirs = await createAs(app, OTHER, VIEW_OWNER_ORG); // recipient: M_RECIP
    const ids = async (headers: Record<string, string>, q = ""): Promise<string[]> => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reporting/schedules${q}`,
        headers,
      });
      return (res.json().items as { id: string }[]).map((i) => i.id).sort();
    };
    expect(await ids(OWNER)).toEqual([mine.id]);
    expect(await ids(OTHER)).toEqual([theirs.id]);
    expect(await ids(RECIP)).toEqual([mine.id, theirs.id].sort());
    expect(await ids(ADMIN)).toEqual([mine.id, theirs.id].sort());
    await app.inject({
      method: "POST",
      url: `/api/v1/reporting/schedules/${mine.id}/pause`,
      headers: { ...OWNER, "idempotency-key": idem() },
    });
    expect(await ids(OWNER, "?status=paused")).toEqual([mine.id]);
    expect(await ids(OWNER, "?status=active")).toEqual([]);
    await app.close();
  });
});
