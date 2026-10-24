// WP 6.9 (ADR-0098) - death board routes over the route stack and the REAL Authorization Contract, with a fake service (the policy is proven
// in death-board/death-board-service.test.ts, the database half by m36-death-board.live.test.ts).
//
//   flag FIRST: off => the list is 200 {enabled:false,boards:[]} and every other route ONE 404, before a bad query, id or body can answer 422
//   guards:     messaging.read + patient.read on every route (403); a session (401)
//   supervisor: messaging.review decides the actor's `supervisor` flag; it is NOT required
//   answers:    ONE byte-identical 404 for missing / malformed / flag off; typed 403/409/422 from the service pass through
import { readFileSync } from "node:fs";
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type DeathBoardRouteDeps,
  registerDeathBoardRoutes,
} from "../src/modules/36-messaging/routes/death-board-routes";

const ORG = "org_a";
const B = "cccccccc-cccc-4ccc-8ccc-000000000001";
const I = "cccccccc-cccc-4ccc-8ccc-000000000002";
const MISSING = "cccccccc-cccc-4ccc-8ccc-0000000000ff";
const TARGET = "dddddddd-dddd-4ddd-8ddd-000000000001";

const KEYS: Record<string, string[]> = {
  nurse: ["messaging.read", "patient.read"],
  supervisor: ["messaging.read", "patient.read", "messaging.review"],
  nopatient: ["messaging.read"],
  nomessaging: ["patient.read"],
};

const item = {
  id: I,
  item_key: "pronouncement",
  label: "Pronouncement of death recorded",
  status: "open",
  owner_user_id: TARGET,
  owner_display_name: null,
  needs_owner: false,
  due_at: "2026-10-14T14:00:00.000Z",
  overdue: false,
  completed_at: null,
  completed_by_user_id: null,
  actions: ["complete", "reassign"],
};
const board = {
  id: B,
  patient_id: "eeeeeeee-eeee-4eee-8eee-000000000001",
  patient_display_name: "Ann B.",
  mrn_suffix: "1234",
  created_at: "2026-10-14T12:00:00.000Z",
  open_count: 1,
  items: [item],
};

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
  createForDeath: record("createForDeath", () => ({ created: true, boardId: B })),
  list: record("list", () => [board]),
  get: record("get", () => board),
  history: record("history", () => []),
  complete: record("complete", () => ({ ...item, status: "done" })),
  reassign: record("reassign", () => item),
  reassignForLeaver: record("reassignForLeaver", () => ({ reassigned: 0, flaggedNeedsOwner: 0 })),
} as unknown as DeathBoardRouteDeps["service"];

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
}

function makeServer(deps: DeathBoardRouteDeps = { isEnabled: async () => flag, service }) {
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
  registerDeathBoardRoutes(app, deps);
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
const BOARDS = "/api/v1/messaging/death-boards";
const ITEMS = "/api/v1/messaging/death-board-items";
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

describe("flag first", () => {
  it("the list answers enabled:false before the query is parsed, and never reaches the service", async () => {
    flag = false;
    const app = makeServer();
    const res = await send(app, "nurse", "GET", `${BOARDS}?limit=9999`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, boards: [] });
    expect(calls).toEqual([]);
    await app.close();
  });

  it("a flag read that throws reads as off", async () => {
    const app = makeServer({
      isEnabled: async () => {
        throw new Error("flag store down");
      },
      service,
    });
    expect((await send(app, "nurse", "GET", BOARDS)).json()).toEqual({
      enabled: false,
      boards: [],
    });
    expect((await send(app, "nurse", "GET", `${BOARDS}/${B}`)).statusCode).toBe(404);
    await app.close();
  });

  it("every other route is the same 404 as a missing board, even with a bad id or body", async () => {
    const app = makeServer();
    failWith = new NotFoundError("death_board");
    const viaService = await send(app, "nurse", "GET", `${BOARDS}/${MISSING}`);
    failWith = null;
    flag = false;
    const off = [
      await send(app, "nurse", "GET", `${BOARDS}/${B}`),
      await send(app, "nurse", "GET", `${ITEMS}/${I}/history`),
      await send(app, "nurse", "POST", `${ITEMS}/${I}/complete`),
      await send(app, "nurse", "POST", `${ITEMS}/${I}/reassign`, { nope: 1 }),
    ];
    for (const r of off) expect(strip(r.body)).toBe(strip(viaService.body));
    expect(viaService.statusCode).toBe(404);
    expect(calls).toEqual([{ method: "get", args: expect.anything() }]);
    await app.close();
  });

  it("a malformed id is the same 404 (never a 422 or a uuid-cast 500)", async () => {
    const app = makeServer();
    const res = await send(app, "nurse", "GET", `${BOARDS}/not-a-uuid`);
    expect(res.statusCode).toBe(404);
    expect(calls).toEqual([]);
    await app.close();
  });
});

describe("guards", () => {
  it("need messaging.read and patient.read (403) and a session (401); the service is never reached", async () => {
    const app = makeServer();
    for (const user of ["nopatient", "nomessaging"]) {
      expect((await send(app, user, "GET", BOARDS)).statusCode).toBe(403);
      expect((await send(app, user, "POST", `${ITEMS}/${I}/complete`)).statusCode).toBe(403);
    }
    expect((await send(app, null, "GET", BOARDS)).statusCode).toBe(401);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("messaging.review is not required, and decides the supervisor flag handed to the service", async () => {
    const app = makeServer();
    expect((await send(app, "nurse", "GET", BOARDS)).statusCode).toBe(200);
    expect((await send(app, "supervisor", "GET", BOARDS)).statusCode).toBe(200);
    expect(calls[0]?.args[0]).toEqual({ orgId: ORG, userId: "nurse", supervisor: false });
    expect(calls[1]?.args[0]).toEqual({ orgId: ORG, userId: "supervisor", supervisor: true });
    await app.close();
  });
});

describe("requests", () => {
  it("the list defaults the limit and rejects an out-of-range one", async () => {
    const app = makeServer();
    expect((await send(app, "nurse", "GET", BOARDS)).json()).toMatchObject({
      enabled: true,
      boards: [{ id: B }],
    });
    expect(calls[0]?.args[1]).toBe(25);
    expect((await send(app, "nurse", "GET", `${BOARDS}?limit=51`)).statusCode).toBe(422);
    await app.close();
  });

  it("reassign passes the actor and target, and refuses free text or a non-uuid target", async () => {
    const app = makeServer();
    const ok = await send(app, "nurse", "POST", `${ITEMS}/${I}/reassign`, { to_user_id: TARGET });
    expect(ok.statusCode).toBe(200);
    expect(calls[0]?.args).toEqual([{ orgId: ORG, userId: "nurse", supervisor: false }, I, TARGET]);
    for (const body of [{ to_user_id: TARGET, note: "x" }, { to_user_id: "nope" }, {}]) {
      expect((await send(app, "nurse", "POST", `${ITEMS}/${I}/reassign`, body)).statusCode).toBe(
        422,
      );
    }
    expect(calls).toHaveLength(1);
    await app.close();
  });

  it("complete takes no body and wraps the item", async () => {
    const app = makeServer();
    const res = await send(app, "nurse", "POST", `${ITEMS}/${I}/complete`);
    expect(res.json()).toMatchObject({ item: { status: "done" } });
    await app.close();
  });

  it("maps the service codes onto the envelope", async () => {
    const app = makeServer();
    for (const [status, errCode] of [
      [403, "DEATH_BOARD_NOT_OWNER"],
      [409, "DEATH_BOARD_ITEM_STATE_CONFLICT"],
      [422, "DEATH_BOARD_OWNER_INVALID"],
    ] as const) {
      failWith = new ChartWardenError(errCode, "x", status);
      const res = await send(app, "nurse", "POST", `${ITEMS}/${I}/reassign`, {
        to_user_id: TARGET,
      });
      expect({ s: res.statusCode, c: code(res) }).toEqual({ s: status, c: errCode });
    }
    await app.close();
  });
});

describe("static guarantees", () => {
  const src = () =>
    readFileSync(
      new URL("../src/modules/36-messaging/routes/death-board-routes.ts", import.meta.url),
      "utf8",
    );

  it("never reads request headers", () => {
    expect(src()).not.toMatch(/request\.headers|headers\[/);
  });

  it("the list and the board read attribute every patient they disclose", () => {
    const s = src();
    expect(s).toContain('patientIdsPayload: { path: "boards", key: "patient_id" }');
    expect(s).toContain('patientIdPayloadPath: "board.patient_id"');
    expect(s).not.toMatch(/list: true/);
  });
});
