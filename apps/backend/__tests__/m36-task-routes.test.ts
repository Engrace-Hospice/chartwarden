// WP 3.4 - communication-task routes over the route stack and the REAL Authorization Contract, with a fake task service
// (the policy is proven in tasks/task-service.test.ts, the DB half by m36-tasks.live.test.ts).
//
//   flag off: every route 404s except the list, which answers 200 {enabled:false,tasks:[]}
//   guards:   messaging.read for reads, messaging.send (+ channel_visibility on :id) for writes
//   answers:  201 created vs 200 replay, typed 422/409/403, ONE byte-identical 404, no Idempotency-Key needed
//   audit:    both reads declare auditRead; the single read names resourceIdParam
import { readFileSync } from "node:fs";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  requireAbac,
  requirePermission,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { ForbiddenError, NotFoundError, type TaskDto, WardenXError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import {
  DISABLED_TASKS,
  type TaskRouteDeps,
  registerTaskRoutes,
} from "../src/modules/36-messaging/routes/task-routes";
import type { TaskService } from "../src/modules/36-messaging/tasks/task-service";

type Handler = (r: FastifyRequest, p: FastifyReply) => Promise<void>;

const ORG = "org_a";
const CH = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const HIDDEN_CH = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const MSG = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
const TASK = "cccccccc-cccc-4ccc-8ccc-000000000001";
const OTHER = "cccccccc-cccc-4ccc-8ccc-000000000002";
const MISSING = "cccccccc-cccc-4ccc-8ccc-0000000000ff";
const ASSIGNEE = "dddddddd-dddd-4ddd-8ddd-000000000001";

const KEYS: Record<string, string[]> = {
  nurse: ["messaging.read", "messaging.send"],
  reader: ["messaging.read"],
  outsider: ["messaging.read", "messaging.send"], // keys, but not in the channel
  nobody: [],
};

const dto = (over: Partial<TaskDto> = {}): TaskDto => ({
  id: TASK,
  message_id: MSG,
  channel_id: CH,
  patient_id: null,
  created_by: "nurse",
  assignee_id: ASSIGNEE,
  assignee_display_name: "Alex",
  created_by_display_name: "Nurse",
  due_at: null,
  status: "open",
  clinical_concern: false,
  source_kind: "message",
  closed_reason: null,
  needs_owner: false,
  overdue: false,
  created_at: "2026-10-14T12:00:00.000Z",
  updated_at: "2026-10-14T12:00:00.000Z",
  allowed_actions: ["accept"],
  ...over,
});

interface Call {
  readonly method: string;
  readonly args: unknown[];
}
let calls: Call[] = [];
let flag = true;
let convertCreated = true;
let failWith: Error | null = null;

const record =
  <T>(method: string, result: () => T) =>
  async (...args: unknown[]): Promise<T> => {
    calls.push({ method, args });
    if (failWith) throw failWith;
    return result();
  };

const service: TaskService = {
  convert: record("convert", () => ({ task: dto(), created: convertCreated })),
  get: record("get", () => ({ task: dto(), events: [] })),
  list: record("list", () => [dto()]),
  accept: record("accept", () => dto({ status: "accepted", allowed_actions: ["complete"] })),
  complete: record("complete", () => dto({ status: "done", allowed_actions: [] })),
  cancel: record("cancel", () => dto({ status: "cancelled", allowed_actions: [] })),
  reassign: record("reassign", () => dto()),
  openTaskCount: async () => 0,
} as TaskService;

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
}

function makeServer(deps: TaskRouteDeps = { isEnabled: async () => flag, service }) {
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
  registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) =>
    ctx.userId !== "outsider" ? target.id === CH : false,
  );
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerTaskRoutes(app, deps, {
    read: requirePermission("messaging.read") as Handler,
    send: requirePermission("messaging.send") as Handler,
    sendToChannel: requireAbac("messaging.send", CHANNEL_VISIBILITY_PREDICATE) as Handler,
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
const convertUrl = (channel = CH, message = MSG) =>
  `/api/v1/messaging/channels/${channel}/messages/${message}/tasks`;
const taskUrl = (id: string, action = "") => `/api/v1/messaging/tasks/${id}${action}`;
const sig = (res: { statusCode: number; body: string }) => ({ s: res.statusCode, b: res.body });

beforeEach(() => {
  calls = [];
  flag = true;
  convertCreated = true;
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

describe("POST /channels/:id/messages/:messageId/tasks", () => {
  it("answers 201 with created:true and passes only server-derived actor fields plus the body", async () => {
    const app = makeServer();
    const res = await send(app, "nurse", "POST", convertUrl(), {
      assignee_user_id: ASSIGNEE,
      due_at: "2026-10-20T17:00:00.000Z",
      clinical_concern: true,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ created: true, task: { id: TASK } });
    expect(calls[0]?.args).toEqual([
      { orgId: ORG, userId: "nurse" },
      {
        channelId: CH,
        messageId: MSG,
        assigneeUserId: ASSIGNEE,
        dueAt: new Date("2026-10-20T17:00:00.000Z"),
        clinicalConcern: true,
      },
    ]);
    await app.close();
  });

  it("answers an idempotent replay with 200 and created:false, needing no Idempotency-Key", async () => {
    convertCreated = false;
    const app = makeServer();
    const res = await send(app, "nurse", "POST", convertUrl(), { assignee_user_id: ASSIGNEE });
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(false);
    await app.close();
  });

  it("ignores any patient id in the body (rejected: the schema is closed)", async () => {
    const app = makeServer();
    const res = await send(app, "nurse", "POST", convertUrl(), {
      assignee_user_id: ASSIGNEE,
      patient_id: MSG,
    });
    expect(res.statusCode).toBe(422);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("is 422 for a non-uuid assignee and TASK_DUE_INVALID for an unparseable due date", async () => {
    const app = makeServer();
    const bad = await send(app, "nurse", "POST", convertUrl(), { assignee_user_id: "nope" });
    expect(bad.statusCode).toBe(422);
    const due = await send(app, "nurse", "POST", convertUrl(), {
      assignee_user_id: ASSIGNEE,
      due_at: "tomorrow-ish",
    });
    expect(due.statusCode).toBe(422);
    expect(due.json().error?.code ?? due.json().code).toBe("TASK_DUE_INVALID");
    expect(calls).toEqual([]);
    await app.close();
  });

  it("maps the service's typed 422 and 409 errors onto the envelope", async () => {
    const app = makeServer();
    for (const [status, code] of [
      [422, "TASK_ASSIGNEE_INVALID"],
      [409, "TASK_STATE_CONFLICT"],
      [409, "TASK_ASSIGNEE_ALREADY_HAS_ACTIVE"],
    ] as const) {
      failWith = new WardenXError(code, "x", status);
      const res = await send(app, "nurse", "POST", convertUrl(), { assignee_user_id: ASSIGNEE });
      expect(res.statusCode).toBe(status);
      expect(res.json().error?.code ?? res.json().code).toBe(code);
      expect(res.json().task).toBeUndefined();
    }
    await app.close();
  });

  it("denies a reader (no messaging.send), an outsider (channel_visibility) and anonymous", async () => {
    const app = makeServer();
    const body = { assignee_user_id: ASSIGNEE };
    expect((await send(app, "reader", "POST", convertUrl(), body)).statusCode).toBe(403);
    expect((await send(app, "outsider", "POST", convertUrl(), body)).statusCode).not.toBe(201);
    expect((await send(app, "nurse", "POST", convertUrl(HIDDEN_CH), body)).statusCode).not.toBe(
      201,
    );
    expect((await send(app, null, "POST", convertUrl(), body)).statusCode).toBe(401);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("is 404 when the tenant flag is off and never reaches the service", async () => {
    flag = false;
    const app = makeServer();
    const res = await send(app, "nurse", "POST", convertUrl(), { assignee_user_id: ASSIGNEE });
    expect(res.statusCode).toBe(404);
    expect(calls).toEqual([]);
    await app.close();
  });
});

describe("GET /tasks", () => {
  it("lists with the documented defaults and wraps the rows with enabled:true", async () => {
    const app = makeServer();
    const res = await send(app, "nurse", "GET", "/api/v1/messaging/tasks");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, tasks: [{ id: TASK }] });
    expect(calls[0]?.args[1]).toEqual({ scope: "assigned", state: "active", limit: 50 });
    await app.close();
  });

  it("passes scope, state and limit through", async () => {
    const app = makeServer();
    await send(app, "nurse", "GET", "/api/v1/messaging/tasks?scope=created&state=all&limit=7");
    expect(calls[0]?.args[1]).toEqual({ scope: "created", state: "all", limit: 7 });
    await app.close();
  });

  it("is 422 for an unknown scope or a limit above 100", async () => {
    const app = makeServer();
    expect((await send(app, "nurse", "GET", "/api/v1/messaging/tasks?scope=all")).statusCode).toBe(
      422,
    );
    expect((await send(app, "nurse", "GET", "/api/v1/messaging/tasks?limit=101")).statusCode).toBe(
      422,
    );
    await app.close();
  });

  it("answers 200 {enabled:false,tasks:[]} when the flag is off, without calling the service", async () => {
    flag = false;
    const app = makeServer();
    const res = await send(app, "nurse", "GET", "/api/v1/messaging/tasks");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, tasks: [] });
    expect(calls).toEqual([]);
    await app.close();
  });

  it("answers disabled when the flag read throws (fail closed) and for the unbound default", async () => {
    const throwing = makeServer({
      isEnabled: async () => {
        throw new Error("flag store down");
      },
      service,
    });
    expect((await send(throwing, "nurse", "GET", "/api/v1/messaging/tasks")).json()).toEqual({
      enabled: false,
      tasks: [],
    });
    await throwing.close();
  });

  it("is 403 without messaging.read and 401 anonymous", async () => {
    const app = makeServer();
    expect((await send(app, "nobody", "GET", "/api/v1/messaging/tasks")).statusCode).toBe(403);
    expect((await send(app, null, "GET", "/api/v1/messaging/tasks")).statusCode).toBe(401);
    await app.close();
  });
});

describe("GET /tasks/:taskId", () => {
  it("returns the task and its events", async () => {
    const app = makeServer();
    const res = await send(app, "nurse", "GET", taskUrl(TASK));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ task: { id: TASK }, events: [] });
    expect(calls[0]?.args).toEqual([{ orgId: ORG, userId: "nurse" }, TASK]);
    await app.close();
  });

  it("answers missing, not-a-participant, hidden-channel, malformed and flag-off with ONE identical 404", async () => {
    const app = makeServer();
    failWith = new NotFoundError("communication_task");
    const viaService = await send(app, "nurse", "GET", taskUrl(MISSING));
    failWith = null;
    const malformed = await send(app, "nurse", "GET", taskUrl("not-a-uuid"));
    flag = false;
    const flagOff = await send(app, "nurse", "GET", taskUrl(TASK));
    expect(viaService.statusCode).toBe(404);
    const strip = (b: string) => b.replace(/"(requestId|correlationId)":"[^"]*"/g, "");
    expect(strip(malformed.body)).toBe(strip(viaService.body));
    expect(strip(flagOff.body)).toBe(strip(viaService.body));
    expect(malformed.statusCode).toBe(404);
    expect(flagOff.statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /tasks/:taskId/{accept,complete,cancel,reassign}", () => {
  it("accept returns the updated task", async () => {
    const app = makeServer();
    const res = await send(app, "nurse", "POST", taskUrl(TASK, "/accept"));
    expect(res.statusCode).toBe(200);
    expect(res.json().task.status).toBe("accepted");
    await app.close();
  });

  it("complete and cancel pass the reason code (or null) to the service", async () => {
    const app = makeServer();
    await send(app, "nurse", "POST", taskUrl(TASK, "/complete"), { reason: "action_taken" });
    await send(app, "nurse", "POST", taskUrl(TASK, "/cancel"));
    expect(calls.map((c) => [c.method, c.args[2]])).toEqual([
      ["complete", "action_taken"],
      ["cancel", undefined],
    ]);
    await app.close();
  });

  it("rejects free text beyond the reason field (closed body)", async () => {
    const app = makeServer();
    const res = await send(app, "nurse", "POST", taskUrl(TASK, "/complete"), { note: "free text" });
    expect(res.statusCode).toBe(422);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("reassign passes the new assignee", async () => {
    const app = makeServer();
    await send(app, "nurse", "POST", taskUrl(TASK, "/reassign"), { assignee_user_id: ASSIGNEE });
    expect(calls[0]).toEqual({
      method: "reassign",
      args: [{ orgId: ORG, userId: "nurse" }, TASK, ASSIGNEE],
    });
    await app.close();
  });

  it("surfaces the service's 403, 409 and 422 codes", async () => {
    const app = makeServer();
    failWith = new ForbiddenError("not permitted");
    expect((await send(app, "nurse", "POST", taskUrl(TASK, "/accept"))).statusCode).toBe(403);
    for (const [status, code, action] of [
      [409, "TASK_STATE_CONFLICT", "/accept"],
      [409, "TASK_ASSIGNEE_ALREADY_HAS_ACTIVE", "/reassign"],
      [422, "TASK_CLOSE_REASON_REQUIRED", "/complete"],
      [422, "TASK_CLOSE_REASON_INVALID", "/cancel"],
    ] as const) {
      failWith = new WardenXError(code, "x", status);
      const res = await send(
        app,
        "nurse",
        "POST",
        taskUrl(TASK, action),
        action === "/reassign" ? { assignee_user_id: ASSIGNEE } : undefined,
      );
      expect({ s: res.statusCode, code: res.json().error?.code ?? res.json().code }).toEqual({
        s: status,
        code,
      });
    }
    await app.close();
  });

  it("needs messaging.send (reader 403), and a malformed id is the uniform 404", async () => {
    const app = makeServer();
    expect((await send(app, "reader", "POST", taskUrl(TASK, "/accept"))).statusCode).toBe(403);
    expect((await send(app, "nurse", "POST", taskUrl("zzz", "/accept"))).statusCode).toBe(404);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("is 404 for every action while the flag is off", async () => {
    flag = false;
    const app = makeServer();
    for (const action of ["/accept", "/complete", "/cancel", "/reassign"]) {
      const res = await send(app, "nurse", "POST", taskUrl(TASK, action), {
        assignee_user_id: ASSIGNEE,
      });
      expect({ action, s: res.statusCode }).toEqual({ action, s: 404 });
    }
    expect(calls).toEqual([]);
    await app.close();
  });
});

describe("unbound default and static guarantees", () => {
  it("DISABLED_TASKS reads off", async () => {
    expect(await DISABLED_TASKS.isEnabled("any")).toBe(false);
    expect(await DISABLED_TASKS.service.openTaskCount("o", "p", "u")).toBe(0);
  });

  it("task routes never read request headers (no Idempotency-Key, no header-derived authorization)", () => {
    const src = readFileSync(
      new URL("../src/modules/36-messaging/routes/task-routes.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/request\.headers|headers\[/);
  });

  it("both read routes declare auditRead, and the single read names resourceIdParam and the patient path", () => {
    const src = readFileSync(
      new URL("../src/modules/36-messaging/routes/task-routes.ts", import.meta.url),
      "utf8",
    );
    expect(src.match(/auditRead:/g)).toHaveLength(2);
    expect(src).toContain('resourceIdParam: "taskId"');
    expect(src).toContain('patientIdPayloadPath: "task.patient_id"');
    expect(src).toContain("list: true");
  });
});
