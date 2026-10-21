// WP 2.5 — draft routes over the in-memory draft service: auth, channel gate, owner isolation, conflicts, read audit.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import { createInMemoryDraftService, createInMemoryMessagingService } from "@chartwarden/messaging";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { registerDraftRoutes } from "../src/modules/36-messaging/routes/draft-routes";

const ORG = "org_a";
const CH = "aaaaaaaa-aaaa-4aaa-8aaa-00000000c4c4";
const ROOT = "bbbbbbbb-bbbb-4bbb-8bbb-00000000d0d0";

interface CapturedRow {
  eventType: string;
  resourceKind: string;
  resourceId?: string;
}
let captured: CapturedRow[] = [];
const fakeTx = {
  execute: async () => undefined,
  insert: () => ({
    values: async (row: CapturedRow) => {
      captured.push(row);
    },
  }),
};
const fakeDb = {
  transaction: async (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx),
} as unknown as DbClient;

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = ["clinical_rn"];
  request.context.locationIds = [];
}

function makeServer() {
  const messaging = createInMemoryMessagingService({
    seed: {
      eligibleStaff: ["rn_1", "rn_2", "rn_3"].map((userId) => ({
        orgId: ORG,
        userId,
        displayName: userId,
        roles: ["clinical_rn"],
      })),
      channels: [
        {
          channelId: CH,
          orgId: ORG,
          kind: "location" as const,
          subjectId: "loc_1",
          members: [{ userId: "rn_1" }, { userId: "rn_2" }],
        },
      ],
    },
  });
  const grants = createInMemoryEffectivePermissionStore(
    ["rn_1", "rn_2", "rn_3"].map((userId) => ({
      orgId: ORG,
      userId,
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: ["messaging.read", "messaging.send"],
        },
      ],
    })),
  );
  registerEffectivePermissionResolver(grants.store);
  const registry = createPredicateRegistry();
  registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) =>
    typeof target.id === "string" && ctx.organizationId && ctx.userId
      ? messaging.canViewChannel(ctx.organizationId, ctx.userId, target.id)
      : false,
  );
  registerAbacRegistry(registry);
  const app = buildServer({
    db: fakeDb,
    authenticate: headerAuth,
    security: { rateLimitEnabled: false },
  });
  registerDraftRoutes(app, { service: createInMemoryDraftService() });
  return app;
}

const as = (user: string) => ({ "x-test-user": user });
const url = (suffix = "") => `/api/v1/messaging/channels/${CH}/draft${suffix}`;
const put = (app: ReturnType<typeof makeServer>, user: string, payload: object) =>
  app.inject({ method: "PUT", url: url(), headers: as(user), payload });
const save = { body: "hello", deviceId: "dev_a", baseRevision: 0 };

beforeEach(() => {
  captured = [];
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("draft routes", () => {
  it("saves, reads back and deletes the caller's own draft", async () => {
    const app = makeServer();
    const saved = await put(app, "rn_1", save);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().draft.revision).toBe(1);
    expect(saved.headers["cache-control"]).toBe("no-store");
    const read = await app.inject({ method: "GET", url: url(), headers: as("rn_1") });
    expect(read.json().draft.body).toBe("hello");
    const del = await app.inject({ method: "DELETE", url: url(), headers: as("rn_1") });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({ method: "GET", url: url(), headers: as("rn_1") });
    expect(after.json()).toEqual({ draft: null });
    await app.close();
  });

  it("never shows a draft to another member of the same channel", async () => {
    const app = makeServer();
    await put(app, "rn_1", save);
    const other = await app.inject({ method: "GET", url: url(), headers: as("rn_2") });
    expect(other.statusCode).toBe(200);
    expect(other.json()).toEqual({ draft: null });
    await app.close();
  });

  it("refuses a user who cannot see the channel to read or write; deleting their own draft is always allowed (B12)", async () => {
    const app = makeServer();
    for (const method of ["GET", "PUT"] as const) {
      const res = await app.inject({
        method,
        url: url(),
        headers: as("rn_3"),
        payload: method === "PUT" ? save : undefined,
      });
      expect(res.statusCode).toBe(403);
    }
    const del = await app.inject({ method: "DELETE", url: url(), headers: as("rn_3") });
    expect(del.statusCode).toBe(204);
    await app.close();
  });

  it("is 401 without a session", async () => {
    const app = makeServer();
    const res = await app.inject({ method: "GET", url: url() });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("answers a cross-device save from a stale revision with 409 DRAFT_CONFLICT", async () => {
    const app = makeServer();
    await put(app, "rn_1", save);
    const res = await put(app, "rn_1", { ...save, deviceId: "dev_b" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe("DRAFT_CONFLICT");
    await app.close();
  });

  it("422s a body past the limit and a malformed save", async () => {
    const app = makeServer();
    expect((await put(app, "rn_1", { ...save, body: "x".repeat(8001) })).statusCode).toBe(422);
    expect((await put(app, "rn_1", { body: "x" })).statusCode).toBe(422);
    await app.close();
  });

  it("keeps a thread-root draft apart from the channel draft", async () => {
    const app = makeServer();
    await put(app, "rn_1", save);
    await put(app, "rn_1", { ...save, parentMessageId: ROOT, body: "reply" });
    const channel = await app.inject({ method: "GET", url: url(), headers: as("rn_1") });
    const thread = await app.inject({
      method: "GET",
      url: url(`?parentMessageId=${ROOT}`),
      headers: as("rn_1"),
    });
    expect(channel.json().draft.body).toBe("hello");
    expect(thread.json().draft.body).toBe("reply");
    await app.close();
  });

  it("read-audits a draft read against the channel id (resource id present, no body in the row)", async () => {
    const app = makeServer();
    await put(app, "rn_1", save);
    await app.inject({ method: "GET", url: url(), headers: as("rn_1") });
    const row = captured.find((r) => r.resourceKind === "message_draft");
    expect(row?.resourceId).toBe(CH);
    expect(JSON.stringify(captured)).not.toContain("hello");
    await app.close();
  });

  describe("sbar field", () => {
    const sbar = {
      urgencyHint: "urgent",
      sections: { situation: "s", background: "b", assessment: "", recommendation: "" },
    };

    it("keeps an sbar-only draft (not deleted) and returns it on read", async () => {
      const app = makeServer();
      const saved = await put(app, "rn_1", { ...save, body: "", sbar });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().draft.sbar).toEqual(sbar);
      const read = await app.inject({ method: "GET", url: url(), headers: as("rn_1") });
      expect(read.json().draft).toMatchObject({ body: "", sbar });
    });

    it("treats an all-blank sbar with a blank body as a discard", async () => {
      const app = makeServer();
      await put(app, "rn_1", { ...save, sbar });
      const blank = {
        urgencyHint: "routine",
        sections: { situation: " ", background: "", assessment: "", recommendation: "" },
      };
      const gone = await put(app, "rn_1", {
        ...save,
        body: "",
        sbar: blank,
        baseRevision: 1,
      });
      expect(gone.json().draft).toBeNull();
    });

    it("422s an over-long section, an unknown hint and extra keys", async () => {
      const app = makeServer();
      const tooLong = { ...sbar, sections: { ...sbar.sections, situation: "x".repeat(2001) } };
      expect((await put(app, "rn_1", { ...save, sbar: tooLong })).statusCode).toBe(422);
      expect(
        (await put(app, "rn_1", { ...save, sbar: { ...sbar, urgencyHint: "panic" } })).statusCode,
      ).toBe(422);
      expect((await put(app, "rn_1", { ...save, sbar: { ...sbar, extra: 1 } })).statusCode).toBe(
        422,
      );
      const missing = { urgencyHint: "routine", sections: { situation: "s" } };
      expect((await put(app, "rn_1", { ...save, sbar: missing })).statusCode).toBe(422);
    });

    it("still conflicts across devices when only the sbar differs", async () => {
      const app = makeServer();
      await put(app, "rn_1", { ...save, sbar });
      const stale = await put(app, "rn_1", { ...save, deviceId: "dev_b", sbar });
      expect(stale.statusCode).toBe(409);
    });
  });
});
