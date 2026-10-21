// WP 3.8 - lifecycle review-queue routes over the route stack and the REAL Authorization Contract, with a fake review
// service (the policy is proven in review/review-service.test.ts, the DB half by m36-lifecycle-review.live.test.ts).
//
//   flag off: both actions 404; the list answers 200 {enabled:false,items:[]} without touching the service
//   guards:   messaging.read + messaging.review + patient.read on every route
//   answers:  typed 422/409, ONE byte-identical 404 for missing / malformed / flag off
//   audit:    the list attributes every disclosed patient; the actions name resourceIdParam and the item's patient
import { readFileSync } from "node:fs";
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  requirePermission,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { NotFoundError, type ReviewItemDto, ChartWardenError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import {
  DISABLED_REVIEW,
  type ReviewRouteDeps,
  registerReviewRoutes,
} from "../src/modules/36-messaging/routes/review-routes";

type Handler = (r: FastifyRequest, p: FastifyReply) => Promise<void>;

const ORG = "org_a";
const R = "cccccccc-cccc-4ccc-8ccc-000000000001";
const MISSING = "cccccccc-cccc-4ccc-8ccc-0000000000ff";
const TARGET = "dddddddd-dddd-4ddd-8ddd-000000000001";
const PATIENT = "eeeeeeee-eeee-4eee-8eee-000000000001";
const TASK = "ffffffff-ffff-4fff-8fff-000000000001";

const KEYS: Record<string, string[]> = {
  supervisor: ["messaging.read", "messaging.review", "patient.read"],
  nopatient: ["messaging.read", "messaging.review"],
  noreview: ["messaging.read", "patient.read"],
  nobody: [],
};

const dto = (over: Partial<ReviewItemDto> = {}): ReviewItemDto => ({
  id: R,
  source: "patient_lifecycle",
  cause: "death",
  state: "open",
  resolution: null,
  resolution_reason: null,
  restricted: false,
  patient_id: PATIENT,
  patient_display_name: "Ann B.",
  mrn_suffix: "1234",
  item_kind: "task",
  item_id: TASK,
  task: null,
  reassigned_to_user_id: null,
  reassigned_to_display_name: null,
  resolved_by_user_id: null,
  resolved_by_display_name: null,
  resolved_at: null,
  created_at: "2026-10-14T12:00:00.000Z",
  allowed_actions: ["reassign", "close"],
  ...over,
});

interface Call {
  readonly method: string;
  readonly args: unknown[];
}
let calls: Call[] = [];
let flag = true;
let failWith: Error | null = null;

const record =
  <T>(method: string, result: () => T) =>
  async (...args: unknown[]): Promise<T> => {
    calls.push({ method, args });
    if (failWith) throw failWith;
    return result();
  };

const service = {
  list: record("list", () => [dto()]),
  reassign: record("reassign", () => dto({ state: "resolved", resolution: "reassigned" })),
  close: record("close", () => dto({ state: "resolved", resolution: "closed" })),
} as unknown as ReviewRouteDeps["service"];

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
}

function makeServer(deps: ReviewRouteDeps = { isEnabled: async () => flag, service }) {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      Object.entries(KEYS).map(([userId, permissionKeys]) => ({
        orgId: ORG,
        userId,
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
      })),
    ).store,
  );
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerReviewRoutes(app, deps, {
    read: requirePermission("messaging.read") as Handler,
    send: requirePermission("messaging.send") as Handler,
  });
  return app;
}
type App = ReturnType<typeof makeServer>;

const send = (
  app: App,
  user: string | null,
  method: "GET" | "POST",
  url: string,
  payload?: Record<string, unknown>,
) =>
  app.inject({
    method,
    url,
    headers: user ? { "x-test-user": user } : {},
    ...(payload ? { payload } : {}),
  });
const BASE = "/api/v1/messaging/review-items";
const code = (res: { json(): { error?: { code?: string }; code?: string } }) =>
  res.json().error?.code ?? res.json().code;
const strip = (b: string) => b.replace(/"(requestId|correlationId)":"[^"]*"/g, "");

beforeEach(() => {
  calls = [];
  flag = true;
  failWith = null;
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("GET /review-items", () => {
  it("lists open items by default and wraps them with enabled:true", async () => {
    const app = makeServer();
    const res = await send(app, "supervisor", "GET", BASE);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, items: [{ id: R }] });
    expect(calls[0]?.args[1]).toEqual({ state: "open", limit: 50 });
    await app.close();
  });

  it("passes state and limit through and rejects bad values", async () => {
    const app = makeServer();
    await send(app, "supervisor", "GET", `${BASE}?state=resolved&limit=7`);
    expect(calls[0]?.args[1]).toEqual({ state: "resolved", limit: 7 });
    expect((await send(app, "supervisor", "GET", `${BASE}?state=mine`)).statusCode).toBe(422);
    expect((await send(app, "supervisor", "GET", `${BASE}?limit=101`)).statusCode).toBe(422);
    await app.close();
  });

  it("answers 200 {enabled:false,items:[]} when the flag is off or its read throws, without the service", async () => {
    flag = false;
    const off = makeServer();
    expect((await send(off, "supervisor", "GET", BASE)).json()).toEqual({
      enabled: false,
      items: [],
    });
    const throwing = makeServer({
      isEnabled: async () => {
        throw new Error("flag store down");
      },
      service,
    });
    expect((await send(throwing, "supervisor", "GET", BASE)).json()).toEqual({
      enabled: false,
      items: [],
    });
    expect(calls).toEqual([]);
    await off.close();
    await throwing.close();
  });

  it("needs messaging.review and patient.read (403), and a session (401)", async () => {
    const app = makeServer();
    expect((await send(app, "noreview", "GET", BASE)).statusCode).toBe(403);
    expect((await send(app, "nopatient", "GET", BASE)).statusCode).toBe(403);
    expect((await send(app, "nobody", "GET", BASE)).statusCode).toBe(403);
    expect((await send(app, null, "GET", BASE)).statusCode).toBe(401);
    expect(calls).toEqual([]);
    await app.close();
  });
});

describe("POST /review-items/:reviewItemId/reassign", () => {
  it("passes the actor from the context and the target, and wraps the item", async () => {
    const app = makeServer();
    const res = await send(app, "supervisor", "POST", `${BASE}/${R}/reassign`, {
      to_user_id: TARGET,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ item: { resolution: "reassigned" } });
    expect(calls[0]?.args).toEqual([{ orgId: ORG, userId: "supervisor" }, R, TARGET]);
    await app.close();
  });

  it("rejects free text and a non-uuid target before the service", async () => {
    const app = makeServer();
    for (const body of [{ to_user_id: TARGET, note: "x" }, { to_user_id: "nope" }, {}]) {
      expect(
        (await send(app, "supervisor", "POST", `${BASE}/${R}/reassign`, body)).statusCode,
      ).toBe(422);
    }
    expect(calls).toEqual([]);
    await app.close();
  });

  it("maps the service codes onto the envelope", async () => {
    const app = makeServer();
    for (const [status, errCode] of [
      [422, "REVIEW_ASSIGNEE_INVALID"],
      [409, "REVIEW_ITEM_STATE_CONFLICT"],
    ] as const) {
      failWith = new ChartWardenError(errCode, "x", status);
      const res = await send(app, "supervisor", "POST", `${BASE}/${R}/reassign`, {
        to_user_id: TARGET,
      });
      expect({ s: res.statusCode, c: code(res) }).toEqual({ s: status, c: errCode });
    }
    await app.close();
  });
});

describe("POST /review-items/:reviewItemId/close", () => {
  it("passes the reason code and wraps the item", async () => {
    const app = makeServer();
    const res = await send(app, "supervisor", "POST", `${BASE}/${R}/close`, {
      reason: "no_action_needed",
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]?.args).toEqual([{ orgId: ORG, userId: "supervisor" }, R, "no_action_needed"]);
    await app.close();
  });

  it("requires a recognised reason and refuses free text", async () => {
    const app = makeServer();
    for (const body of [{}, { reason: "because" }, { reason: "duplicate", note: "x" }]) {
      expect((await send(app, "supervisor", "POST", `${BASE}/${R}/close`, body)).statusCode).toBe(
        422,
      );
    }
    expect(calls).toEqual([]);
    await app.close();
  });
});

describe("actions: guards and the uniform 404", () => {
  it("need messaging.review and patient.read (403), service never reached", async () => {
    const app = makeServer();
    for (const user of ["noreview", "nopatient", "nobody"]) {
      expect(
        (await send(app, user, "POST", `${BASE}/${R}/close`, { reason: "duplicate" })).statusCode,
      ).toBe(403);
    }
    expect(calls).toEqual([]);
    await app.close();
  });

  it("answers missing, malformed and flag-off with ONE identical 404", async () => {
    const app = makeServer();
    const body = { reason: "duplicate" };
    failWith = new NotFoundError("messaging_review_item");
    const viaService = await send(app, "supervisor", "POST", `${BASE}/${MISSING}/close`, body);
    failWith = null;
    const malformed = await send(app, "supervisor", "POST", `${BASE}/not-a-uuid/close`, body);
    flag = false;
    const flagOff = await send(app, "supervisor", "POST", `${BASE}/${R}/close`, body);
    expect(viaService.statusCode).toBe(404);
    expect(strip(malformed.body)).toBe(strip(viaService.body));
    expect(strip(flagOff.body)).toBe(strip(viaService.body));
    await app.close();
  });
});

describe("unbound default and static guarantees", () => {
  const routesSrc = () =>
    readFileSync(
      new URL("../src/modules/36-messaging/routes/review-routes.ts", import.meta.url),
      "utf8",
    );

  it("DISABLED_REVIEW reads off", async () => {
    expect(await DISABLED_REVIEW.isEnabled("any")).toBe(false);
  });

  it("review routes never read request headers", () => {
    expect(routesSrc()).not.toMatch(/request\.headers|headers\[/);
  });

  it("every route declares auditRead: the actions name resourceIdParam, the list attributes every patient", () => {
    const src = routesSrc();
    expect(src.match(/auditRead:/g)).toHaveLength(2);
    expect(src.match(/config: actionAudit/g)).toHaveLength(2);
    expect(src).toContain('resourceIdParam: "reviewItemId"');
    expect(src).toContain('patientIdPayloadPath: "item.patient_id"');
    expect(src).toContain('patientIdsPayload: { path: "items", key: "patient_id" }');
    expect(src).not.toMatch(/list: true/);
  });

  it("the event catalog accepts the review source on a reassignment and rejects an unknown one", () => {
    const entry = M36_OUTBOX_EVENTS.find((e) => e.eventName === "m36.task.reassigned");
    const literals = JSON.stringify(entry?.payloadSchema);
    expect(literals).toContain('"const":"review"');
    expect(literals).not.toContain('"const":"handoff"');
  });
});
