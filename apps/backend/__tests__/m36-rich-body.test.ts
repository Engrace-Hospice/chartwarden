// apps/backend/__tests__/m36-rich-body.test.ts - M36 WP 2.1: the structured ("rich") message body over the full M1
// middleware chain and the REAL Authorization Contract, with the in-memory route service (no live infra). The DB
// half (encryption, hash_verify, revisions, mentions under RLS) is proven by the live suites.
//
// Proves: the body is additive (a plain string still works); the server sanitises and projects; `body` on the wire
// is ALWAYS the plain-text projection (never JSON, never a link target); previews carry the projection only; hostile
// input is rejected without being echoed; legacy plain/markdown rows are returned byte-for-byte as before.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createInMemoryMessagingService } from "@chartwarden/messaging";
import { XSS_CORPUS } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  CHANNEL_VISIBILITY_PREDICATE,
  registerMessagingRoutes,
} from "../src/modules/36-messaging/index";

const ORG = "org_a";
const CH = "ch_dm";
const RN1 = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "clinical_rn" };

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.locationIds = [];
}

function makeServer() {
  const service = createInMemoryMessagingService({
    now: () => new Date("2026-06-15T12:00:00Z"),
    seed: {
      eligibleStaff: [
        { orgId: ORG, userId: "rn_1", displayName: "Nurse One", roles: ["Registered Nurse"] },
      ],
      careTeamPatients: [],
      channels: [
        {
          channelId: CH,
          orgId: ORG,
          kind: "location",
          title: "Unit",
          subjectId: null,
          members: [{ userId: "rn_1", role: "owner" }],
        },
      ],
      alerts: [],
    },
  });
  const store = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "rn_1",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: ["messaging.read", "messaging.send"],
        },
      ],
    },
  ]);
  registerEffectivePermissionResolver(store.store);
  const registry = createPredicateRegistry();
  registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
    const channelId = typeof target.id === "string" ? target.id : null;
    if (!channelId || !ctx.organizationId || !ctx.userId) return false;
    return service.canViewChannel(ctx.organizationId, ctx.userId, channelId);
  });
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerMessagingRoutes(app, { service, announcements: service });
  return app;
}

type App = ReturnType<typeof makeServer>;
const key = () => ({ ...RN1, "idempotency-key": crypto.randomUUID() });
const doc = (...content: unknown[]) => ({ schemaVersion: 1, doc: { type: "doc", content } });
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (value: string, ...marks: unknown[]) =>
  marks.length ? { type: "text", text: value, marks } : { type: "text", text: value };

async function send(app: App, payload: unknown) {
  return app.inject({
    method: "POST",
    url: `/api/v1/messaging/channels/${CH}/messages`,
    headers: key(),
    payload: payload as object,
  });
}
async function list(app: App) {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/messaging/channels/${CH}/messages`,
    headers: RN1,
  });
  expect(res.statusCode).toBe(200);
  return res.json().messages as Array<Record<string, unknown>>;
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

describe("M36 WP 2.1 rich body over the route stack", () => {
  it("stores a structured body and returns the projection as `body` plus the sanitised bodyDoc", async () => {
    const app = makeServer();
    const res = await send(app, {
      bodyDoc: doc(
        para(text("Hello "), text("team", { type: "bold" })),
        para(text("docs", { type: "link", href: "https://example.com/guide?x=1" })),
      ),
    });
    expect(res.statusCode).toBe(201);
    const [message] = await list(app);
    expect(message).toMatchObject({ bodyKind: "rich", body: "Hello team\ndocs" });
    expect(JSON.stringify(message.body)).not.toContain("example.com");
    expect(message.bodyDoc).toMatchObject({ schemaVersion: 1 });
    await app.close();
  });

  it("keeps a plain string body working exactly as before (additive contract)", async () => {
    const app = makeServer();
    expect((await send(app, { body: "**not bold** <b>x</b>" })).statusCode).toBe(201);
    expect((await send(app, { body: "# md", bodyKind: "markdown" })).statusCode).toBe(201);
    const messages = await list(app);
    expect(messages.map((m) => [m.bodyKind, m.body, m.bodyDoc])).toEqual([
      ["plain", "**not bold** <b>x</b>", undefined],
      ["markdown", "# md", undefined],
    ]);
    await app.close();
  });

  it("refuses a request that carries both a body and a bodyDoc", async () => {
    const app = makeServer();
    const res = await send(app, { body: "x", bodyDoc: doc(para(text("y"))) });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("sanitises on the server: unsafe link targets are rejected, not stored", async () => {
    const app = makeServer();
    const res = await send(app, {
      bodyDoc: doc(para(text("x", { type: "link", href: "javascript:window.__xss=1" }))),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("INVALID_RICH_BODY");
    expect(await list(app)).toEqual([]);
    await app.close();
  });

  it("previews are the projection: no link target, no markup", async () => {
    const app = makeServer();
    await send(app, {
      bodyDoc: doc(para(text("read this", { type: "link", href: "https://hidden.example/p" }))),
    });
    const channels = await app.inject({
      method: "GET",
      url: "/api/v1/messaging/channels",
      headers: RN1,
    });
    const preview = channels.json().channels[0].lastMessage.preview as string;
    expect(preview).toBe("read this");
    await app.close();
  });

  describe.each(XSS_CORPUS)("corpus $id", ({ payload }) => {
    it("stored: the payload is accepted only as inert text and never as a link target or JSON on the wire", async () => {
      const app = makeServer();
      const asText = await send(app, { bodyDoc: doc(para(text(payload))) });
      const asLink = await send(app, {
        bodyDoc: doc(para(text("go", { type: "link", href: payload }))),
      });
      const asCode = await send(app, { bodyDoc: doc({ type: "codeBlock", text: payload }) });
      expect([201, 422]).toContain(asText.statusCode);
      expect([201, 422]).toContain(asCode.statusCode);
      for (const message of await list(app)) {
        expect(String(message.body)).not.toContain('"schemaVersion"');
        const links = JSON.stringify(message.bodyDoc).match(/"href":"([^"]*)"/g) ?? [];
        for (const href of links) expect(href).toMatch(/"href":"(https:|mailto:)/);
      }
      if (asLink.statusCode === 201) {
        const hrefs = JSON.stringify((await list(app)).map((m) => m.bodyDoc)).match(
          /"href":"[^"]*"/g,
        );
        for (const href of hrefs ?? []) expect(href).toMatch(/^"href":"(https:\/\/|mailto:)/);
      }
      await app.close();
    });

    it("reflected: a rejected body's error never echoes the payload", async () => {
      const app = makeServer();
      const res = await send(app, {
        bodyDoc: doc(
          { type: "html", html: payload },
          para(text("x", { type: "mark", href: payload })),
        ),
      });
      expect(res.statusCode).toBe(422);
      const raw = res.body;
      if (payload.length > 3) expect(raw).not.toContain(payload);
      await app.close();
    });
  });
});
