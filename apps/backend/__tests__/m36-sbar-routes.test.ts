// WP 3.3 - SBAR over the route stack and the REAL Authorization Contract, in-memory twin for the messaging service and
// a map for the policy store (the DB half - FORCE RLS, audit scrub, floor on read - is m36-sbar.live.test.ts).
//
//   policy:  GET needs messaging.send and is 404 while the flag is off; PUT/DELETE need messaging.template.manage;
//            a value below the floor is 422 SBAR_POLICY_FLOOR_VIOLATION; a PHI-shaped hint is 422 and never echoed.
//   write:   flag off -> SBAR_NOT_AVAILABLE; announcement/bereavement -> SBAR_NOT_ALLOWED_IN_CHANNEL; tenant "patient
//            channel only" -> the same code outside care_team; too short / too long -> SBAR_INVALID with field details
//            and no message text; the edit route is held to the same rules.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import {
  type StoredSbarPolicy,
  createInMemoryMessagingService,
  prepareSbarPolicy,
} from "@wardenx/messaging";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  CHANNEL_VISIBILITY_PREDICATE,
  registerMessagingRoutes,
} from "../src/modules/36-messaging/index";
import type { SbarPolicyStore } from "../src/modules/36-messaging/sbar/sbar-policy-store-db";

const ORG = "org_a";
const CHANNELS = {
  location: "ch_location",
  care_team: "ch_care_team",
  announcement: "ch_announcement",
  bereavement: "ch_bereavement",
} as const;
const KEYS: Record<string, string[]> = {
  nurse: ["messaging.read", "messaging.send"],
  admin: ["messaging.read", "messaging.send", "messaging.template.manage"],
  announcer: ["messaging.read", "messaging.send", "messaging.announce"],
  reader: ["messaging.read"],
};

const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (value: string) => ({ type: "text", text: value });
const sbarDoc = (sections: Partial<Record<string, string>> = {}, urgencyHint = "routine") => ({
  schemaVersion: 1,
  doc: {
    type: "doc",
    content: [
      {
        type: "sbar",
        urgencyHint,
        situation: [para(text(sections.situation ?? "Fever overnight"))],
        background: [para(text(sections.background ?? "Day 3 on service"))],
        assessment: [para(text(sections.assessment ?? "Likely infection"))],
        recommendation: [para(text(sections.recommendation ?? "Call the provider today"))],
      },
    ],
  },
});
const plainDoc = { schemaVersion: 1, doc: { type: "doc", content: [para(text("hello"))] } };

let flag = true;
let stored: StoredSbarPolicy | null = null;
const store: SbarPolicyStore = {
  read: async () => stored,
  put: async (_org, _user, policy) => {
    stored = policy;
  },
  remove: async () => {
    stored = null;
  },
};

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
}

function server(sbarPolicy: StoredSbarPolicy | null = null) {
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
  registry.register(CHANNEL_VISIBILITY_PREDICATE, async () => true);
  registerAbacRegistry(registry);
  const members = Object.keys(KEYS).map((userId) => ({ userId, role: "member" as const }));
  const service = createInMemoryMessagingService({
    now: () => new Date("2026-10-14T12:00:00Z"),
    sbarPolicy,
    seed: {
      eligibleStaff: Object.keys(KEYS).map((userId) => ({
        orgId: ORG,
        userId,
        displayName: userId,
        roles: ["Registered Nurse"],
      })),
      careTeamPatients: [],
      channels: (Object.keys(CHANNELS) as Array<keyof typeof CHANNELS>).map((kind) => ({
        channelId: CHANNELS[kind],
        orgId: ORG,
        kind,
        title: kind,
        subjectId: null,
        members,
      })),
      alerts: [],
    },
  });
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerMessagingRoutes(app, {
    service,
    announcements: service,
    sbar: { isEnabled: async () => flag, store },
  });
  return app;
}
type App = ReturnType<typeof server>;

const send = (app: App, channel: string, bodyDoc: unknown, user = "nurse") =>
  app.inject({
    method: "POST",
    url: `/api/v1/messaging/channels/${channel}/messages`,
    headers: { "x-test-user": user, "idempotency-key": crypto.randomUUID() },
    payload: { bodyDoc } as object,
  });
const edit = (app: App, messageId: string, bodyDoc: unknown) =>
  app.inject({
    method: "PATCH",
    url: `/api/v1/messaging/messages/${messageId}`,
    headers: { "x-test-user": "nurse" },
    payload: { bodyDoc } as object,
  });
const code = (res: { json(): { error?: { code?: string }; code?: string } }) =>
  res.json().error?.code ?? res.json().code;

beforeEach(() => {
  flag = true;
  stored = null;
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("SBAR policy routes", () => {
  const get = (app: App, user: string | null) =>
    app.inject({
      method: "GET",
      url: "/api/v1/messaging/sbar/policy",
      headers: user ? { "x-test-user": user } : {},
    });
  const put = (app: App, user: string, payload: unknown) =>
    app.inject({
      method: "PUT",
      url: "/api/v1/messaging/template-admin/sbar-policy",
      headers: { "x-test-user": user },
      payload: payload as object,
    });

  it("returns the platform defaults to a sender when the tenant has no policy", async () => {
    const res = await get(server(), "nurse");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      minChars: { situation: 1, background: 1, assessment: 1, recommendation: 1 },
      maxChars: 2000,
      requirePatientChannel: false,
      customized: false,
    });
    expect(res.json().hints.situation).toEqual(expect.any(String));
  });

  it("is 404 while the flag is off, 403 without messaging.send and 401 anonymous", async () => {
    const app = server();
    flag = false;
    expect((await get(app, "nurse")).statusCode).toBe(404);
    flag = true;
    expect((await get(app, "reader")).statusCode).toBe(403);
    expect((await get(app, null)).statusCode).toBe(401);
  });

  it("lets only messaging.template.manage replace and clear the policy", async () => {
    const app = server();
    const body = { minChars: { situation: 40 }, requirePatientChannel: true };
    expect((await put(app, "nurse", body)).statusCode).toBe(403);
    expect(stored).toBeNull();

    const saved = await put(app, "admin", body);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ customized: true, requirePatientChannel: true });
    expect(saved.json().minChars).toEqual({
      situation: 40,
      background: 1,
      assessment: 1,
      recommendation: 1,
    });
    expect((await get(app, "nurse")).json().minChars.situation).toBe(40);

    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/v1/messaging/template-admin/sbar-policy",
          headers: { "x-test-user": "nurse" },
        })
      ).statusCode,
    ).toBe(403);
    const cleared = await app.inject({
      method: "DELETE",
      url: "/api/v1/messaging/template-admin/sbar-policy",
      headers: { "x-test-user": "admin" },
    });
    expect(cleared.statusCode).toBe(204);
    expect(stored).toBeNull();
  });

  it("refuses a minimum below the platform floor with SBAR_POLICY_FLOOR_VIOLATION", async () => {
    const res = await put(server(), "admin", { minChars: { background: 0 } });
    expect(res.statusCode).toBe(422);
    expect(code(res)).toBe("SBAR_POLICY_FLOOR_VIOLATION");
    expect(JSON.stringify(res.json())).toContain("minChars.background");
    expect(stored).toBeNull();
  });

  it("refuses an over-ceiling minimum, an unknown key and a PHI-shaped hint, never echoing the hint", async () => {
    const app = server();
    expect((await put(app, "admin", { minChars: { situation: 501 } })).statusCode).toBe(422);
    expect((await put(app, "admin", { surprise: true })).statusCode).toBe(422);
    const phi = await put(app, "admin", {
      hints: { situation: "Call 555-123-4567 for MRN: 99887" },
    });
    expect(phi.statusCode).toBe(422);
    expect(code(phi)).toBe("SBAR_HINT_PHI_DETECTED");
    expect(phi.body).not.toContain("555-123-4567");
    expect(stored).toBeNull();
  });

  it("stores a clean hint and serves it back", async () => {
    const app = server();
    await put(app, "admin", { hints: { assessment: "  Your clinical read  " } });
    expect((await get(app, "nurse")).json().hints.assessment).toBe("Your clinical read");
  });
});

describe("SBAR on the send route", () => {
  it("refuses an sbar body with SBAR_NOT_AVAILABLE while the flag is off, but sends plain text", async () => {
    const app = server();
    flag = false;
    const res = await send(app, CHANNELS.location, sbarDoc());
    expect(res.statusCode).toBe(422);
    expect(code(res)).toBe("SBAR_NOT_AVAILABLE");
    expect((await send(app, CHANNELS.location, plainDoc)).statusCode).toBe(201);
  });

  it("sends a valid SBAR message in an allowed channel", async () => {
    const app = server();
    expect((await send(app, CHANNELS.location, sbarDoc())).statusCode).toBe(201);
    expect((await send(app, CHANNELS.care_team, sbarDoc({}, "urgent"))).statusCode).toBe(201);
  });

  it.each(["announcement", "bereavement"] as const)(
    "refuses SBAR in a %s channel",
    async (kind) => {
      // An announcement channel is also org_admin-only on the generic send route; this proves SBAR is refused even for them.
      const res = await send(server(), CHANNELS[kind], sbarDoc(), "announcer");
      expect(res.statusCode).toBe(422);
      expect(code(res)).toBe("SBAR_NOT_ALLOWED_IN_CHANNEL");
    },
  );

  it("holds a tenant that requires a patient channel to care_team", async () => {
    const policy = prepareSbarPolicy({ requirePatientChannel: true });
    const app = server(policy);
    const refused = await send(app, CHANNELS.location, sbarDoc());
    expect(refused.statusCode).toBe(422);
    expect(code(refused)).toBe("SBAR_NOT_ALLOWED_IN_CHANNEL");
    expect((await send(app, CHANNELS.care_team, sbarDoc())).statusCode).toBe(201);
  });

  it("answers SBAR_INVALID with field-level details and never echoes the text", async () => {
    const app = server(prepareSbarPolicy({ minChars: { situation: 40, recommendation: 30 } }));
    const res = await send(app, CHANNELS.location, sbarDoc({ situation: "Short secret text" }));
    expect(res.statusCode).toBe(422);
    expect(code(res)).toBe("SBAR_INVALID");
    const details = res.json().error?.details ?? res.json().details;
    expect(details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "sbar.situation", code: "TOO_SHORT" }),
      ]),
    );
    expect(res.body).not.toContain("secret");
  });

  it("refuses a section over 2000 characters", async () => {
    const res = await send(server(), CHANNELS.location, sbarDoc({ background: "x".repeat(2001) }));
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).toContain("TOO_LONG");
  });

  it("refuses a section that is missing or blank as a structural error", async () => {
    const res = await send(server(), CHANNELS.location, sbarDoc({ assessment: "   " }));
    expect(res.statusCode).toBe(422);
    expect(code(res)).not.toBe("SBAR_NOT_AVAILABLE");
  });
});

describe("SBAR on the edit route", () => {
  it("applies the same checks to an edit", async () => {
    const app = server(prepareSbarPolicy({ minChars: { situation: 40 } }));
    const sent = await send(app, CHANNELS.location, plainDoc);
    const messageId = sent.json().messageId;
    const tooShort = await edit(app, messageId, sbarDoc({ situation: "short" }));
    expect(tooShort.statusCode).toBe(422);
    expect(code(tooShort)).toBe("SBAR_INVALID");
    const ok = await edit(
      app,
      messageId,
      sbarDoc({ situation: "A sufficiently long situation statement for the policy" }),
    );
    expect(ok.statusCode).toBe(200);
    flag = false;
    const off = await edit(app, messageId, sbarDoc({ situation: "x".repeat(60) }));
    expect(code(off)).toBe("SBAR_NOT_AVAILABLE");
  });
});
