// WP 5.7 (ADR-0089) - the restricted-export routes over the route stack and the REAL Authorization Contract, with a fake service (the policy is
// proven in export/export-service.test.ts, the SQL half by the live suite).
//
//   guards:  request = messaging.export.request + fresh step-up + the tenant flag (off = the uniform 404, before the step-up)
//            approve / reject = messaging.export.approve + fresh step-up; download = messaging.export.download + fresh step-up
//   answers: 201 on request, 404 for a malformed id, 409/429 envelopes from the service, the artefact streamed as an attachment, never cached
//   audit:   every GET declares auditRead
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { ExportService } from "../src/modules/36-messaging/export/export-service";
import { registerExportRoutes } from "../src/modules/36-messaging/routes/export-routes";

const ORG = "org_a";
const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const CH = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
const JUSTIFICATION = "Subject access request from the patient's representative";

const KEYS: Record<string, string[]> = {
  officer: ["messaging.export.request", "messaging.export.approve", "messaging.export.download"],
  requesterOnly: ["messaging.export.request", "messaging.export.download"],
  approverOnly: ["messaging.export.approve"],
  nurse: ["messaging.read", "messaging.send"],
};

const summary = {
  id: JOB,
  status: "pending_approval",
  requestedBy: "cccccccc-cccc-4ccc-8ccc-000000000001",
  requestedByName: null,
  requestedAt: "2026-10-21T10:00:00.000Z",
  scope: { scopeKind: "channel", channelId: CH, patientId: null, dateFrom: null, dateTo: null },
  decidedBy: null,
  decidedAt: null,
  readyAt: null,
  expiresAt: null,
  messageCount: null,
  heldExcluded: null,
  part2Excluded: null,
  downloadCount: 0,
  failureCode: null,
};
const detail = {
  ...summary,
  justification: JUSTIFICATION,
  decisionNote: null,
  buildingAt: null,
  artefactBytes: null,
  artefactSha256: null,
  downloadable: false,
  // a field the schema does not list must never reach the wire
  wrappedDek: "SECRET-KEY",
  artefactKey: "SECRET-OBJECT-KEY",
};

interface Call {
  readonly method: string;
  readonly args: unknown[];
}
let calls: Call[] = [];
let flagOn = true;
let failWith: Error | null = null;

const record =
  (method: string, result: () => unknown) =>
  async (...args: unknown[]) => {
    calls.push({ method, args });
    if (failWith) throw failWith;
    return result();
  };

const service: ExportService = {
  isEnabled: async () => flagOn,
  create: record("create", () => detail) as never,
  decide: record("decide", () => ({ ...detail, status: "approved" })) as never,
  cancel: record("cancel", () => ({ ...detail, status: "cancelled" })) as never,
  listMine: record("listMine", () => [summary]) as never,
  listPending: record("listPending", () => [summary]) as never,
  get: record("get", () => detail) as never,
  download: record("download", () => ({
    jobId: JOB,
    filename: `messaging-export-${JOB}.json`,
    bytes: Buffer.from('{"messages":[]}'),
  })) as never,
};

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
  if (request.headers["x-fresh"] === "1") request.context.attributes.stepUpRecent = true;
}

let stepUpAsked: string[] = [];

function makeServer() {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      Object.entries(KEYS).map(([userId, permissionKeys]) => ({
        orgId: ORG,
        userId,
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
      })),
    ).store,
  );
  const registry = createPredicateRegistry();
  registry.register("step_up_recent", async (ctx, target) => {
    stepUpAsked.push(String((target as { operationKey?: unknown }).operationKey));
    return ctx.attributes.stepUpRecent === true;
  });
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerExportRoutes(app, { service });
  return app;
}
type App = ReturnType<typeof makeServer>;

const send = (
  app: App,
  method: "GET" | "POST",
  user: string | null,
  url: string,
  opts: { fresh?: boolean; payload?: Record<string, unknown> } = {},
) =>
  app.inject({
    method,
    url,
    headers: {
      ...(user ? { "x-test-user": user } : {}),
      ...(opts.fresh === false ? {} : { "x-fresh": "1" }),
    },
    ...(method === "POST" ? { payload: opts.payload ?? {} } : {}),
  });
const code = (res: { json(): { error?: { code?: string } } }) => res.json().error?.code;

const BASE = "/api/v1/messaging/export";
const createBody = (over: Record<string, unknown> = {}) => ({
  scopeKind: "channel",
  channelId: CH,
  justification: JUSTIFICATION,
  ...over,
});

beforeEach(() => {
  calls = [];
  flagOn = true;
  failWith = null;
  stepUpAsked = [];
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("POST /export", () => {
  it("answers 201 uncached, hands the service the server-derived actor and strips unlisted fields", async () => {
    const app = makeServer();
    const res = await send(app, "POST", "officer", BASE, { payload: createBody() });
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toMatchObject({ id: JOB, status: "pending_approval", downloadable: false });
    expect(res.body).not.toContain("SECRET");
    expect(calls[0]?.args[0]).toEqual({ organizationId: ORG, userId: "officer" });
    expect(stepUpAsked).toEqual(["messaging.export.request"]);
    await app.close();
  });

  it("refuses a role without the permission (403) and an anonymous caller (401) before the service", async () => {
    const app = makeServer();
    expect((await send(app, "POST", "nurse", BASE, { payload: createBody() })).statusCode).toBe(
      403,
    );
    expect((await send(app, "POST", null, BASE, { payload: createBody() })).statusCode).toBe(401);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("asks for the step-up (403 STEP_UP_REQUIRED) when the session is not fresh", async () => {
    const app = makeServer();
    const res = await send(app, "POST", "officer", BASE, { fresh: false, payload: createBody() });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe("STEP_UP_REQUIRED");
    expect(calls).toEqual([]);
    await app.close();
  });

  it("flag off is a 404 BEFORE the step-up is asked for, identical to the service's own refusal", async () => {
    flagOn = false;
    const app = makeServer();
    const off = await send(app, "POST", "officer", BASE, { fresh: false, payload: createBody() });
    expect(off.statusCode).toBe(404);
    expect(stepUpAsked).toEqual([]);
    flagOn = true;
    failWith = new NotFoundError("export scope");
    const refused = await send(app, "POST", "officer", BASE, { payload: createBody() });
    expect(refused.statusCode).toBe(404);
    expect(refused.json().error.message).toBe(off.json().error.message);
    await app.close();
  });

  it("rejects a malformed body with 422 and never reaches the service", async () => {
    const app = makeServer();
    for (const bad of [
      createBody({ channelId: "nope" }),
      createBody({ scopeKind: "everything" }),
      createBody({ justification: "short" }),
      createBody({ dateFrom: "01/02/2026" }),
      createBody({ extra: 1 }),
      { scopeKind: "channel" },
    ]) {
      expect((await send(app, "POST", "officer", BASE, { payload: bad })).statusCode).toBe(422);
    }
    expect(calls).toEqual([]);
    await app.close();
  });

  it("maps EXPORT_LIMIT to 429", async () => {
    failWith = new ChartWardenError("EXPORT_LIMIT", "too many", 429);
    const app = makeServer();
    const res = await send(app, "POST", "officer", BASE, { payload: createBody() });
    expect(res.statusCode).toBe(429);
    expect(code(res)).toBe("EXPORT_LIMIT");
    await app.close();
  });
});

describe("approve and reject", () => {
  for (const verb of ["approve", "reject"] as const) {
    it(`${verb}: approve key + approve step-up, 200, and the service gets the verb and the note`, async () => {
      const app = makeServer();
      const res = await send(app, "POST", "approverOnly", `${BASE}/${JOB}/${verb}`, {
        payload: { note: "looks right" },
      });
      expect(res.statusCode).toBe(200);
      expect(stepUpAsked).toEqual(["messaging.export.approve"]);
      expect(calls[0]?.args.slice(1)).toEqual([JOB, verb, { note: "looks right" }]);
      await app.close();
    });

    it(`${verb}: refused without the approve key, without a fresh step-up, and for a malformed id`, async () => {
      const app = makeServer();
      expect((await send(app, "POST", "requesterOnly", `${BASE}/${JOB}/${verb}`)).statusCode).toBe(
        403,
      );
      const stale = await send(app, "POST", "approverOnly", `${BASE}/${JOB}/${verb}`, {
        fresh: false,
      });
      expect(code(stale)).toBe("STEP_UP_REQUIRED");
      expect(
        (await send(app, "POST", "approverOnly", `${BASE}/not-a-uuid/${verb}`)).statusCode,
      ).toBe(404);
      expect(calls).toEqual([]);
      await app.close();
    });

    it(`${verb}: 409 EXPORT_ALREADY_DECIDED and 403 for the requester's own job come through the envelope`, async () => {
      const app = makeServer();
      failWith = new ChartWardenError("EXPORT_ALREADY_DECIDED", "decided", 409);
      const res = await send(app, "POST", "approverOnly", `${BASE}/${JOB}/${verb}`);
      expect(res.statusCode).toBe(409);
      expect(code(res)).toBe("EXPORT_ALREADY_DECIDED");
      await app.close();
    });
  }

  it("works while the request flag is off", async () => {
    flagOn = false;
    const app = makeServer();
    expect((await send(app, "POST", "approverOnly", `${BASE}/${JOB}/approve`)).statusCode).toBe(
      200,
    );
    await app.close();
  });
});

describe("cancel, lists and detail", () => {
  it("cancel needs the request key", async () => {
    const app = makeServer();
    expect((await send(app, "POST", "requesterOnly", `${BASE}/${JOB}/cancel`)).statusCode).toBe(
      200,
    );
    expect((await send(app, "POST", "approverOnly", `${BASE}/${JOB}/cancel`)).statusCode).toBe(403);
    await app.close();
  });

  it("GET /mine needs the request key, GET /pending the approve key; neither is cached", async () => {
    const app = makeServer();
    const mine = await send(app, "GET", "requesterOnly", `${BASE}/mine`);
    expect(mine.statusCode).toBe(200);
    expect(mine.headers["cache-control"]).toBe("no-store");
    expect(mine.json().jobs).toHaveLength(1);
    expect((await send(app, "GET", "approverOnly", `${BASE}/mine`)).statusCode).toBe(403);
    expect((await send(app, "GET", "approverOnly", `${BASE}/pending`)).statusCode).toBe(200);
    expect((await send(app, "GET", "requesterOnly", `${BASE}/pending`)).statusCode).toBe(403);
    await app.close();
  });

  it("GET /:id is open to either key (the service scopes the row), refused to anyone else, and tells the service whether the caller approves", async () => {
    const app = makeServer();
    expect((await send(app, "GET", "requesterOnly", `${BASE}/${JOB}`)).statusCode).toBe(200);
    expect(calls[0]?.args[2]).toEqual({ canApprove: false });
    expect((await send(app, "GET", "approverOnly", `${BASE}/${JOB}`)).statusCode).toBe(200);
    expect(calls[1]?.args[2]).toEqual({ canApprove: true });
    expect((await send(app, "GET", "nurse", `${BASE}/${JOB}`)).statusCode).toBe(403);
    expect((await send(app, "GET", "officer", `${BASE}/not-a-uuid`)).statusCode).toBe(404);
    await app.close();
  });

  it("does not let /mine or /pending be shadowed by /:id", async () => {
    const app = makeServer();
    await send(app, "GET", "requesterOnly", `${BASE}/mine`);
    expect(calls[0]?.method).toBe("listMine");
    await app.close();
  });
});

describe("GET /:id/download", () => {
  it("streams the document as an uncached attachment after the download step-up", async () => {
    const app = makeServer();
    const res = await send(app, "GET", "requesterOnly", `${BASE}/${JOB}/download`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="messaging-export-${JOB}.json"`,
    );
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.body).toBe('{"messages":[]}');
    expect(stepUpAsked).toEqual(["messaging.export.download"]);
    await app.close();
  });

  it("is refused without the download key (an approver) or a fresh step-up, and for a malformed id", async () => {
    const app = makeServer();
    expect((await send(app, "GET", "approverOnly", `${BASE}/${JOB}/download`)).statusCode).toBe(
      403,
    );
    const stale = await send(app, "GET", "requesterOnly", `${BASE}/${JOB}/download`, {
      fresh: false,
    });
    expect(code(stale)).toBe("STEP_UP_REQUIRED");
    expect((await send(app, "GET", "requesterOnly", `${BASE}/zzz/download`)).statusCode).toBe(404);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("answers the service's 409 EXPORT_NOT_READY / EXPORT_EXPIRED and its 404 as envelopes, with no body bytes", async () => {
    const app = makeServer();
    for (const [err, status] of [
      [new ChartWardenError("EXPORT_NOT_READY", "not ready", 409), 409],
      [new ChartWardenError("EXPORT_EXPIRED", "expired", 409), 409],
      [new NotFoundError("export", JOB), 404],
    ] as const) {
      failWith = err;
      const res = await send(app, "GET", "requesterOnly", `${BASE}/${JOB}/download`);
      expect(res.statusCode).toBe(status);
      expect(res.headers["content-disposition"]).toBeUndefined();
      expect(res.body).not.toContain("messages");
    }
    await app.close();
  });
});
