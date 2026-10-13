// M36 WP 2.8 - message template routes through the full M1 chain over the in-memory TemplateService: permission gates
// (sender vs template manager), the idempotency requirement on creates, the PHI-lint and platform-floor 422s (field and
// code, never the text), and owner-only personal replies. The Drizzle service is proved live
// (m36-message-templates.live.test.ts).
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { PLATFORM_MESSAGE_TEMPLATES, createInMemoryTemplateService } from "@wardenx/messaging";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { registerTemplateRoutes } from "../src/modules/36-messaging/routes/template-routes";

const ORG = "org_a";
const emergency = PLATFORM_MESSAGE_TEMPLATES.find((t) => t.requiredPhrases.length > 0)!;

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
}

const GRANTS = [
  { userId: "rn_1", permissions: ["messaging.send"] },
  { userId: "rn_2", permissions: ["messaging.send"] },
  { userId: "admin_1", permissions: ["messaging.send", "messaging.template.manage"] },
  { userId: "reader_1", permissions: ["messaging.read"] },
];

function makeServer() {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      GRANTS.map((g) => ({
        orgId: ORG,
        userId: g.userId,
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: g.permissions },
        ],
      })),
    ).store,
  );
  registerAbacRegistry(createPredicateRegistry());
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerTemplateRoutes(app, { service: createInMemoryTemplateService() });
  return app;
}

const as = (userId: string) => ({ "x-test-user": userId, "x-test-org": ORG });
const keyed = (userId: string) => ({ ...as(userId), "idempotency-key": crypto.randomUUID() });
const reply = {
  title: "Running late",
  body: "I am running a few minutes behind.",
  category: "scheduling",
};

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

describe("permission gates", () => {
  it("unauthenticated is 401, a reader without messaging.send is 403", async () => {
    const app = makeServer();
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/messaging/templates" })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/messaging/templates",
          headers: as("reader_1"),
        })
      ).statusCode,
    ).toBe(403);
    await app.close();
  });

  it("a sender cannot reach administration or write a shared template or an overlay", async () => {
    const app = makeServer();
    for (const [method, url, payload] of [
      ["GET", "/api/v1/messaging/template-admin", undefined],
      ["POST", "/api/v1/messaging/template-admin/shared", reply],
      ["PATCH", "/api/v1/messaging/template-admin/shared/x", { title: "y" }],
      ["DELETE", "/api/v1/messaging/template-admin/shared/x", undefined],
      [
        "PUT",
        `/api/v1/messaging/template-admin/platform/${emergency.id}/overlay`,
        { title: null, body: null, isEnabled: false },
      ],
      ["DELETE", `/api/v1/messaging/template-admin/platform/${emergency.id}/overlay`, undefined],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: keyed("rn_1"),
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    await app.close();
  });
});

describe("picker", () => {
  it("lists platform templates, then a shared one the admin authors, to every sender", async () => {
    const app = makeServer();
    const before = await app.inject({
      method: "GET",
      url: "/api/v1/messaging/templates",
      headers: as("rn_1"),
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().items).toHaveLength(PLATFORM_MESSAGE_TEMPLATES.length);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/messaging/template-admin/shared",
      headers: keyed("admin_1"),
      payload: { ...reply, title: "Org reply" },
    });
    expect(created.statusCode).toBe(201);
    const after = await app.inject({
      method: "GET",
      url: "/api/v1/messaging/templates",
      headers: as("rn_2"),
    });
    expect(after.json().items.map((i: { title: string }) => i.title)).toContain("Org reply");
    await app.close();
  });

  it("GET by id returns the template; an unknown or non-uuid id is 404", async () => {
    const app = makeServer();
    const ok = await app.inject({
      method: "GET",
      url: `/api/v1/messaging/templates/${emergency.id}`,
      headers: as("rn_1"),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: emergency.id, scope: "platform", body: emergency.body });
    for (const id of ["no-such-id", crypto.randomUUID()]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/messaging/templates/${id}`,
        headers: as("rn_1"),
      });
      expect(res.statusCode).toBe(404);
    }
    await app.close();
  });
});

describe("personal saved replies", () => {
  it("require an Idempotency-Key on create", async () => {
    const app = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/messaging/templates/personal",
      headers: as("rn_1"),
      payload: reply,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    await app.close();
  });

  it("are private to their owner end to end", async () => {
    const app = makeServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/messaging/templates/personal",
      headers: keyed("rn_1"),
      payload: reply,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const seenByOther = await app.inject({
      method: "GET",
      url: "/api/v1/messaging/templates",
      headers: as("rn_2"),
    });
    expect(seenByOther.json().items.map((i: { id: string }) => i.id)).not.toContain(id);
    const patchByOther = await app.inject({
      method: "PATCH",
      url: `/api/v1/messaging/templates/personal/${id}`,
      headers: as("rn_2"),
      payload: { body: "hijack" },
    });
    expect(patchByOther.statusCode).toBe(404);
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/messaging/templates/personal/${id}`,
      headers: as("rn_1"),
      payload: { body: "Back in ten minutes." },
    });
    expect(patched.json().body).toBe("Back in ten minutes.");
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/messaging/templates/personal/${id}`,
      headers: as("rn_1"),
    });
    expect(del.statusCode).toBe(204);
    await app.close();
  });

  it("refuse PHI with a 422 that names the field and the reason code but never echoes the text", async () => {
    const app = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/messaging/templates/personal",
      headers: keyed("rn_1"),
      payload: { ...reply, body: "Her SSN is 123-45-6789" },
    });
    expect(res.statusCode).toBe(422);
    const error = res.json().error;
    expect(error.code).toBe("TEMPLATE_PHI_DETECTED");
    expect(error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "body", code: "PHI_SSN" })]),
    );
    expect(res.body).not.toContain("123-45-6789");
    await app.close();
  });

  it("reject an unknown category and an unknown field as VALIDATION_FAILED", async () => {
    const app = makeServer();
    for (const payload of [
      { ...reply, category: "sbar" },
      { ...reply, extra: true },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/messaging/templates/personal",
        headers: keyed("rn_1"),
        payload,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("VALIDATION_FAILED");
    }
    await app.close();
  });
});

describe("platform overlay (admin)", () => {
  const overlayUrl = `/api/v1/messaging/template-admin/platform/${emergency.id}/overlay`;

  it("an overlay that keeps the required wording is applied; one that drops it is a 422 TEMPLATE_FLOOR_VIOLATION", async () => {
    const app = makeServer();
    const bad = await app.inject({
      method: "PUT",
      url: overlayUrl,
      headers: as("admin_1"),
      payload: { title: null, body: "Reply when you can.", isEnabled: true },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe("TEMPLATE_FLOOR_VIOLATION");
    const good = await app.inject({
      method: "PUT",
      url: overlayUrl,
      headers: as("admin_1"),
      payload: {
        title: "Ours",
        body: "Emergency? call 911. Otherwise the on-call line.",
        isEnabled: true,
      },
    });
    expect(good.statusCode).toBe(204);
    const picked = await app.inject({
      method: "GET",
      url: `/api/v1/messaging/templates/${emergency.id}`,
      headers: as("rn_1"),
    });
    expect(picked.json()).toMatchObject({ title: "Ours", customized: true });
    const admin = await app.inject({
      method: "GET",
      url: "/api/v1/messaging/template-admin",
      headers: as("admin_1"),
    });
    const row = admin.json().platform.find((p: { id: string }) => p.id === emergency.id);
    expect(row.overlay).toMatchObject({ title: "Ours", isEnabled: true });
    expect(row.requiredPhrases).toEqual(emergency.requiredPhrases);
    const dropped = await app.inject({ method: "DELETE", url: overlayUrl, headers: as("admin_1") });
    expect(dropped.statusCode).toBe(204);
    await app.close();
  });

  it("disabling hides the template from the picker", async () => {
    const app = makeServer();
    await app.inject({
      method: "PUT",
      url: overlayUrl,
      headers: as("admin_1"),
      payload: { title: null, body: null, isEnabled: false },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/messaging/templates",
      headers: as("rn_1"),
    });
    expect(res.json().items.map((i: { id: string }) => i.id)).not.toContain(emergency.id);
    await app.close();
  });
});
