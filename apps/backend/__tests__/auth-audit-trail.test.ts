import { M2_ACTION_CATALOG } from "@wardenx/audit";
// apps/backend/__tests__/auth-audit-trail.test.ts — GAP-002 / GAP-004: the M2 §8.1 authentication trail.
//
// Drives the real Fastify <-> Better Auth bridge with a STUB handler and a capturing sink, proving every
// audited auth event reaches the sink with the right shape and that no secret ever rides in a payload.
import {
  type AuthAuditEvent,
  createCredentialThrottle,
  createInMemoryFailedLoginStore,
  registerIdentityAuth,
} from "@wardenx/auth";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

const SESSION = { user: { id: "u-1" }, session: { id: "s-1", activeOrganizationId: "o-1" } };

function build(opts: {
  status: number;
  body?: unknown;
  withThrottle?: boolean;
  failSink?: boolean;
}) {
  const events: AuthAuditEvent[] = [];
  const sinkErrors: unknown[] = [];
  const app = Fastify();
  registerIdentityAuth(
    app,
    {
      async handler() {
        return new Response(JSON.stringify(opts.body ?? {}), {
          status: opts.status,
          headers: { "content-type": "application/json" },
        });
      },
      api: { getSession: async () => SESSION },
    },
    {
      auditSink: async (event) => {
        if (opts.failSink) throw new Error("audit store down");
        events.push(event);
      },
      onAuditError: (err) => sinkErrors.push(err),
      ...(opts.withThrottle
        ? { credentialThrottle: createCredentialThrottle(createInMemoryFailedLoginStore()) }
        : {}),
    },
  );
  return { app, events, sinkErrors };
}

const post = (app: ReturnType<typeof Fastify>, url: string, payload: unknown = {}) =>
  app.inject({
    method: "POST",
    url,
    payload: payload as object,
    remoteAddress: "203.0.113.77",
    headers: { cookie: "better-auth.session_token=x" },
  });

describe("authentication audit trail (M2 §8.1)", () => {
  it("a 200 password sign-in writes login_succeeded with the user and no secrets", async () => {
    const { app, events } = build({ status: 200, body: { user: { id: "u-1" }, token: "SECRET" } });
    await post(app, "/api/auth/sign-in/email", { email: "a@b.test", password: "hunter2hunter2" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "m2.auth.login_succeeded",
      outcome: "success",
      userId: "u-1",
      ipPrefix: "203.0.113.0/24",
    });
    expect(JSON.stringify(events[0])).not.toMatch(/SECRET|hunter2|a@b\.test/);
    await app.close();
  });

  it("a 401 sign-in writes login_failed with an emailHash, never the address", async () => {
    const { app, events } = build({ status: 401 });
    await post(app, "/api/auth/sign-in/email", { email: "a@b.test", password: "wrong-password" });
    expect(events[0]).toMatchObject({ eventType: "m2.auth.login_failed", outcome: "failure" });
    expect(events[0]?.context.emailHash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(events[0])).not.toMatch(/a@b\.test|wrong-password/);
    await app.close();
  });

  it("a 2FA-gated 200 (no session yet) is not a login; a 429 is not a credential verdict", async () => {
    const gated = build({ status: 200, body: { twoFactorRedirect: true } });
    await post(gated.app, "/api/auth/sign-in/email", { email: "a@b.test", password: "x" });
    expect(gated.events).toHaveLength(0);
    const limited = build({ status: 429 });
    await post(limited.app, "/api/auth/sign-in/email", { email: "a@b.test", password: "x" });
    expect(limited.events).toHaveLength(0);
    await gated.app.close();
    await limited.app.close();
  });

  it("the 6th failure inside the window is refused and writes account_locked", async () => {
    const { app, events } = build({ status: 401, withThrottle: true });
    for (let i = 0; i < 6; i += 1)
      await post(app, "/api/auth/sign-in/email", { email: "lock@b.test", password: "nope" });
    const types = events.map((e) => e.eventType);
    expect(types.filter((t) => t === "m2.auth.login_failed")).toHaveLength(5);
    const locked = events.find((e) => e.eventType === "m2.auth.account_locked");
    expect(locked?.severity).toBe("critical");
    expect(typeof locked?.context.until).toBe("string");
    await app.close();
  });

  it.each([
    ["/api/auth/sign-out", "m2.auth.logout"],
    ["/api/auth/two-factor/enable", "m2.auth.2fa_enrolled"],
    ["/api/auth/two-factor/disable", "m2.auth.2fa_disabled"],
    ["/api/auth/passkey/verify-registration", "m2.passkey.registered"],
    ["/api/auth/passkey/delete-passkey", "m2.passkey.removed"],
    ["/api/auth/revoke-session", "m2.session.revoked"],
  ])("%s writes %s attributed to the resolved session", async (url, eventType) => {
    const { app, events } = build({ status: 200 });
    await post(app, url, { id: "pk-1" });
    expect(events[0]).toMatchObject({
      eventType,
      userId: "u-1",
      sessionId: "s-1",
      organizationId: "o-1",
    });
    await app.close();
  });

  it("a backup-code sign-in writes backup_code_used and a wrong TOTP writes login_failed", async () => {
    const ok = build({ status: 200, body: { user: { id: "u-1" } } });
    await post(ok.app, "/api/auth/two-factor/verify-backup-code", { code: "abcd-1234" });
    expect(ok.events[0]).toMatchObject({ eventType: "m2.auth.backup_code_used", userId: "u-1" });
    expect(JSON.stringify(ok.events[0])).not.toContain("abcd-1234");
    const bad = build({ status: 401 });
    await post(bad.app, "/api/auth/two-factor/verify-totp", { code: "000000" });
    expect(bad.events[0]).toMatchObject({ eventType: "m2.auth.login_failed" });
    await ok.app.close();
    await bad.app.close();
  });

  it("a failing sink is reported via onAuditError and never fails the auth request", async () => {
    const { app, sinkErrors } = build({
      status: 200,
      body: { user: { id: "u-1" } },
      failSink: true,
    });
    const res = await post(app, "/api/auth/sign-in/email", { email: "a@b.test", password: "x" });
    expect(res.statusCode).toBe(200);
    expect(sinkErrors).toHaveLength(1);
    await app.close();
  });

  it("every emitted event type is in the M2 action catalog", () => {
    const catalogued = new Set(M2_ACTION_CATALOG.map((a) => a.action));
    for (const type of [
      "m2.auth.login_succeeded",
      "m2.auth.login_failed",
      "m2.auth.account_locked",
      "m2.auth.logout",
      "m2.auth.password_reset",
      "m2.auth.2fa_enrolled",
      "m2.auth.2fa_disabled",
      "m2.auth.backup_code_used",
      "m2.passkey.registered",
      "m2.passkey.removed",
      "m2.session.revoked",
    ])
      expect(catalogued.has(type), type).toBe(true);
  });
});
