// CW-AC-46 — the per-organization enforcement mode of the signer-licence check, through the route stack (no database):
// `GET` / `PUT /api/v1/hope/admin/signer-licence-policy` behind the REAL Authorization Contract. The permission is platform-category
// and never a tenant default, the write needs a fresh step-up (break-glass cannot satisfy it) and refuses an AI principal, shadow needs
// a reason (and enforce takes none), and the organization with no setting enforces. The database, the audit rows, the sign paths and the
// tenant isolation are proven live (`m10-hope-signer-licence.live.test.ts`).
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
  setBreakGlassChecker,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  buildHopeAbacPredicates,
  createInMemoryHopeBackend,
  registerHopeRoutes,
} from "../src/modules/10-hope/index";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const URL = "/api/v1/hope/admin/signer-licence-policy";
const KEY = "hope.admin.signer_licence_policy";
const REASON = "Rollout window: back-filling the clinicians' licences before enforcing";
/** The grants are keyed on the SESSION user id (a uuid: it is what the policy row records as its configurer). */
const SESSION_USER: Record<string, string> = {
  operator_1: "33333333-3333-4333-8333-333333333331",
  tenant_admin_1: "33333333-3333-4333-8333-333333333332",
};

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  // M10's acting id is the membership id; the session user id is a uuid (what the row's `configured_by_user_id` takes).
  request.context.userId = SESSION_USER[user] ?? user;
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = [];
  request.context.providerEntityIds = [];
  request.context.attributes.stepUpRecent = request.headers["x-test-step-up"] === "true";
  const actorKind = request.headers["x-test-actor-kind"];
  if (typeof actorKind === "string") request.context.attributes.actorKind = actorKind;
}

const as = (user: string, over: Record<string, string> = {}) => ({
  "x-test-user": user,
  "x-test-org": ORG,
  "x-test-step-up": "true",
  ...over,
});

function makeServer() {
  const backend = createInMemoryHopeBackend({});
  const store = createInMemoryEffectivePermissionStore(
    [
      // The platform operator holds the key; a tenant administrator (every non-platform key) does not.
      { userId: "operator_1", permissions: [KEY] },
      { userId: "tenant_admin_1", permissions: ["hope.submission.manage", "hope.dashboard.read"] },
    ].map((s) => ({
      orgId: ORG,
      userId: SESSION_USER[s.userId] as string,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(store.store);
  const registry = createPredicateRegistry();
  for (const [name, fn] of Object.entries(buildHopeAbacPredicates({ resolver: backend }))) {
    registry.register(name, fn);
  }
  registry.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerHopeRoutes(app, { service: backend, sfvCompletionRateLimit: async () => undefined });
  return { app, backend };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  setBreakGlassChecker(() => null);
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("GET /api/v1/hope/admin/signer-licence-policy", () => {
  it("answers enforce, never configured, for an organization that set nothing", async () => {
    const { app } = makeServer();

    const res = await app.inject({ method: "GET", url: URL, headers: as("operator_1") });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: "enforce", reason: null, configuredAt: null });
    await app.close();
  });

  it("is a platform operator's: a tenant administrator without the key is refused", async () => {
    const { app } = makeServer();

    const res = await app.inject({ method: "GET", url: URL, headers: as("tenant_admin_1") });

    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("PUT /api/v1/hope/admin/signer-licence-policy", () => {
  it("sets shadow with a reason, trims it and reads it back; another organization's session holds no grant for it", async () => {
    const { app } = makeServer();

    const set = await app.inject({
      method: "PUT",
      url: URL,
      headers: as("operator_1"),
      payload: { mode: "shadow", reason: `  ${REASON}  ` },
    });

    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ mode: "shadow", reason: REASON });
    const read = await app.inject({ method: "GET", url: URL, headers: as("operator_1") });
    expect(read.json()).toMatchObject({ mode: "shadow", reason: REASON });
    const other = await app.inject({
      method: "GET",
      url: URL,
      headers: { ...as("operator_1"), "x-test-org": OTHER_ORG },
    });
    expect(other.statusCode).toBe(403);
    await app.close();
  });

  it("returns to enforce, which clears the reason", async () => {
    const { app } = makeServer();
    await app.inject({
      method: "PUT",
      url: URL,
      headers: as("operator_1"),
      payload: { mode: "shadow", reason: REASON },
    });

    const back = await app.inject({
      method: "PUT",
      url: URL,
      headers: as("operator_1"),
      payload: { mode: "enforce" },
    });

    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ mode: "enforce", reason: null });
    await app.close();
  });

  it.each([
    ["shadow without a reason", { mode: "shadow" }],
    ["shadow with a blank reason", { mode: "shadow", reason: "                    " }],
    ["shadow with a reason that is too short", { mode: "shadow", reason: "x".repeat(19) }],
    ["shadow with a reason that is too long", { mode: "shadow", reason: "x".repeat(201) }],
    ["enforce carrying a reason", { mode: "enforce", reason: REASON }],
    ["a mode that is neither", { mode: "off" }],
    ["an unexpected property", { mode: "enforce", extra: true }],
  ])("refuses %s (422) and changes nothing", async (_name, payload) => {
    const { app } = makeServer();

    const res = await app.inject({ method: "PUT", url: URL, headers: as("operator_1"), payload });

    expect(res.statusCode).toBe(422);
    const read = await app.inject({ method: "GET", url: URL, headers: as("operator_1") });
    expect(read.json()).toEqual({ mode: "enforce", reason: null, configuredAt: null });
    await app.close();
  });

  it("is refused without the platform permission (403), whatever else the caller holds", async () => {
    const { app } = makeServer();

    const res = await app.inject({
      method: "PUT",
      url: URL,
      headers: as("tenant_admin_1"),
      payload: { mode: "shadow", reason: REASON },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).not.toBe("STEP_UP_REQUIRED"); // a caller the permission refuses is never told to step up
    await app.close();
  });

  it("needs a FRESH step-up (403 STEP_UP_REQUIRED), which an active break-glass grant does not satisfy", async () => {
    const { app } = makeServer();
    const stale = as("operator_1", { "x-test-step-up": "false" });

    const res = await app.inject({
      method: "PUT",
      url: URL,
      headers: stale,
      payload: { mode: "shadow", reason: REASON },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("STEP_UP_REQUIRED");

    setBreakGlassChecker(() => ({ eventId: "bg-1" }));
    const withBreakGlass = await app.inject({
      method: "PUT",
      url: URL,
      headers: stale,
      payload: { mode: "shadow", reason: REASON },
    });
    expect(withBreakGlass.statusCode).toBe(403);
    expect(withBreakGlass.json().error.code).toBe("STEP_UP_REQUIRED");
    const read = await app.inject({ method: "GET", url: URL, headers: as("operator_1") });
    expect(read.json().mode).toBe("enforce");
    await app.close();
  });

  it("accepts `reason: null` for enforce (the shape the GET answers) and still refuses it for shadow", async () => {
    const { app } = makeServer();

    const enforce = await app.inject({
      method: "PUT",
      url: URL,
      headers: as("operator_1"),
      payload: { mode: "enforce", reason: null },
    });
    const shadow = await app.inject({
      method: "PUT",
      url: URL,
      headers: as("operator_1"),
      payload: { mode: "shadow", reason: null },
    });

    expect(enforce.statusCode).toBe(200);
    expect(shadow.statusCode).toBe(422);
    await app.close();
  });

  it("refuses an AI principal BEFORE it is asked to step up: an AI with a stale step-up is told it is an AI principal", async () => {
    const { app } = makeServer();

    const res = await app.inject({
      method: "PUT",
      url: URL,
      headers: as("operator_1", { "x-test-actor-kind": "ai_agent", "x-test-step-up": "false" }),
      payload: { mode: "shadow", reason: REASON },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain("AI principals");
    expect(res.json().error.code).not.toBe("STEP_UP_REQUIRED");
    await app.close();
  });

  it("refuses an AI principal that holds the permission (403) and changes nothing", async () => {
    const { app } = makeServer();

    const res = await app.inject({
      method: "PUT",
      url: URL,
      headers: as("operator_1", { "x-test-actor-kind": "ai_agent" }),
      payload: { mode: "shadow", reason: REASON },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain("AI principals");
    const read = await app.inject({ method: "GET", url: URL, headers: as("operator_1") });
    expect(read.json().mode).toBe("enforce");
    await app.close();
  });
});
