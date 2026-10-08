/**
 * M31 invitee sign-in - the PURE decision (31-portal/sign-in) and the routes' unbound / unauthenticated behavior.
 * The end-to-end proof over Postgres is `m31-portal-signin.live.test.ts`; this file pins every branch of the rules.
 */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPortalSignInRoutes } from "../src/modules/31-portal/routes/sign-in.routes";
import {
  type PortalSignInAccount,
  accountRefusal,
  decideSignIn,
  signInSessionClass,
} from "../src/modules/31-portal/sign-in";

const account = (over: Partial<PortalSignInAccount> = {}): PortalSignInAccount => ({
  portalAccountId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  organizationName: "Sunrise Hospice",
  organizationStatus: "active",
  relationship: "family_caregiver",
  accountStatus: "active",
  userEmailVerified: true,
  userStatus: "active",
  liveGrantCount: 1,
  bereavedGrantCount: 0,
  ...over,
});

describe("portal sign-in: session class", () => {
  it("patient-self -> patient_portal, delegate -> caregiver_portal, bereaved -> bereaved_portal", () => {
    expect(signInSessionClass(account({ relationship: "patient_self" }))).toBe("patient_portal");
    expect(signInSessionClass(account({ relationship: "dpoa_healthcare_agent" }))).toBe(
      "caregiver_portal",
    );
    expect(signInSessionClass(account())).toBe("caregiver_portal");
    expect(signInSessionClass(account({ accountStatus: "bereaved" }))).toBe("bereaved_portal");
    expect(signInSessionClass(account({ liveGrantCount: 2, bereavedGrantCount: 2 }))).toBe(
      "bereaved_portal",
    );
  });

  it("a mixed grant set is NOT the bereavement surface (it keeps the care-time class)", () => {
    expect(signInSessionClass(account({ liveGrantCount: 2, bereavedGrantCount: 1 }))).toBe(
      "caregiver_portal",
    );
  });
});

describe("portal sign-in: one account's eligibility", () => {
  it("an eligible account has no refusal", () => {
    expect(accountRefusal(account())).toBeNull();
    expect(accountRefusal(account({ accountStatus: "bereaved" }))).toBeNull();
  });

  it.each([
    [{ accountStatus: "invited" as const }, "SIGN_IN_ACCOUNT_NOT_ACTIVATED"],
    [{ accountStatus: "suspended" as const }, "SIGN_IN_ACCOUNT_NOT_ACTIVE"],
    [{ accountStatus: "revoked" as const }, "SIGN_IN_ACCOUNT_NOT_ACTIVE"],
    [{ userEmailVerified: false }, "SIGN_IN_EMAIL_UNVERIFIED"],
    [{ userStatus: "suspended" }, "SIGN_IN_USER_INACTIVE"],
    [{ userStatus: "deactivated" }, "SIGN_IN_USER_INACTIVE"],
    [{ organizationStatus: "suspended" }, "SIGN_IN_ORGANIZATION_NOT_ACTIVE"],
    [{ organizationStatus: "closed" }, "SIGN_IN_ORGANIZATION_NOT_ACTIVE"],
    [{ liveGrantCount: 0 }, "SIGN_IN_NO_ACTIVE_GRANT"],
  ])("refuses %j with %s", (over, code) => {
    expect(accountRefusal(account(over))?.code).toBe(code);
  });

  it("checks the user and tenant BEFORE the account, so a deactivated user is not told about their invitation", () => {
    expect(
      accountRefusal(account({ userStatus: "deactivated", accountStatus: "invited" }))?.code,
    ).toBe("SIGN_IN_USER_INACTIVE");
  });
});

describe("portal sign-in: the bind decision", () => {
  const a = account({ portalAccountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  const b = account({
    portalAccountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    relationship: "patient_self",
  });

  it("no accounts -> refuse, indistinguishable from naming an account the user does not hold", () => {
    const none = decideSignIn([], undefined);
    const foreign = decideSignIn([a], "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(none.kind).toBe("refuse");
    expect(foreign.kind).toBe("refuse");
    if (none.kind === "refuse" && foreign.kind === "refuse") {
      expect(foreign.error.code).toBe(none.error.code);
      expect(foreign.account).toBeNull();
    }
  });

  it("exactly one eligible account binds automatically, even beside a blocked one", () => {
    const blocked = account({
      portalAccountId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      accountStatus: "suspended",
    });
    const decision = decideSignIn([blocked, a], undefined);
    expect(decision).toMatchObject({ kind: "bind", sessionClass: "caregiver_portal" });
  });

  it("several eligible accounts require a choice; a named eligible account binds", () => {
    expect(decideSignIn([a, b], undefined).kind).toBe("select");
    expect(decideSignIn([a, b], b.portalAccountId)).toMatchObject({
      kind: "bind",
      sessionClass: "patient_portal",
    });
  });

  it("a NAMED account that is blocked is refused with its own reason (no silent fallback to another)", () => {
    const suspended = account({
      portalAccountId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      accountStatus: "suspended",
    });
    const decision = decideSignIn([suspended, a], suspended.portalAccountId);
    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") expect(decision.error.code).toBe("SIGN_IN_ACCOUNT_NOT_ACTIVE");
  });

  it("when none is eligible the first account's reason is surfaced, with its tenant for the audit", () => {
    const decision = decideSignIn([account({ accountStatus: "invited" })], undefined);
    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") {
      expect(decision.error.code).toBe("SIGN_IN_ACCOUNT_NOT_ACTIVATED");
      expect(decision.account?.organizationId).toBe("22222222-2222-4222-8222-222222222222");
    }
  });
});

describe("portal sign-in routes: unauthenticated and unbound", () => {
  async function build(withPort: boolean) {
    const app = Fastify();
    app.decorateRequest("context", null as never);
    app.addHook("onRequest", async (request) => {
      const user = request.headers["x-test-user"];
      (request as unknown as { context: unknown }).context = {
        userId: typeof user === "string" ? user : "",
        organizationId: "",
        attributes: typeof user === "string" ? { sessionId: "s1", actorKind: "user" } : {},
      };
    });
    app.setErrorHandler((err, _req, reply) => {
      const e = err as { code?: string; statusCode?: number };
      void reply.code(e.statusCode ?? 500).send({ error: { code: e.code ?? "ERR" } });
    });
    registerPortalSignInRoutes(app, {
      store: {} as never,
      ...(withPort
        ? {
            signIn: {
              accountsForUser: async () => [],
              bindSession: async () => "refused" as const,
              recordRefusal: async () => undefined,
            },
          }
        : {}),
    });
    await app.ready();
    return app;
  }

  it("401 with no session; 503 SIGN_IN_UNAVAILABLE (never a fake success) when the port is unbound", async () => {
    const unbound = await build(false);
    expect(
      (await unbound.inject({ method: "GET", url: "/api/v1/portal/sign-in/accounts" })).statusCode,
    ).toBe(401);
    const res = await unbound.inject({
      method: "GET",
      url: "/api/v1/portal/sign-in/accounts",
      headers: { "x-test-user": "u1" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("SIGN_IN_UNAVAILABLE");
    const establish = await unbound.inject({
      method: "POST",
      url: "/api/v1/portal/sign-in/establish",
      headers: { "x-test-user": "u1", "idempotency-key": "k1" },
      payload: {},
    });
    expect(establish.statusCode).toBe(503);
  });

  it("establish requires an Idempotency-Key, validates the body, and refuses a user with no portal account (403)", async () => {
    const app = await build(true);
    const headers = { "x-test-user": "u1" };
    const noKey = await app.inject({
      method: "POST",
      url: "/api/v1/portal/sign-in/establish",
      headers,
      payload: {},
    });
    expect(noKey.statusCode).toBe(400);
    const badBody = await app.inject({
      method: "POST",
      url: "/api/v1/portal/sign-in/establish",
      headers: { ...headers, "idempotency-key": "k" },
      payload: { portalAccountId: "not-a-uuid" },
    });
    expect(badBody.statusCode).toBeGreaterThanOrEqual(400);
    const none = await app.inject({
      method: "POST",
      url: "/api/v1/portal/sign-in/establish",
      headers: { ...headers, "idempotency-key": "k2" },
      payload: {},
    });
    expect(none.statusCode).toBe(403);
    expect(none.json().error.code).toBe("SIGN_IN_NO_PORTAL_ACCOUNT");
  });

  it("a non-interactive (system) principal can never sign in to the portal", async () => {
    const app = Fastify();
    app.decorateRequest("context", null as never);
    app.addHook("onRequest", async (request) => {
      (request as unknown as { context: unknown }).context = {
        userId: "system",
        organizationId: "",
        attributes: { sessionId: "s", actorKind: "system" },
      };
    });
    app.setErrorHandler((err, _req, reply) => {
      const e = err as { code?: string; statusCode?: number };
      void reply.code(e.statusCode ?? 500).send({ error: { code: e.code ?? "ERR" } });
    });
    registerPortalSignInRoutes(app, { store: {} as never });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/v1/portal/sign-in/accounts" });
    expect(res.statusCode).toBe(403);
  });
});
