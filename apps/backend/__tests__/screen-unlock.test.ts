// apps/backend/__tests__/screen-unlock.test.ts — #589: the screen-lock "Unlock" must resume the SAME session.
//
// The web lock overlay used to call Better Auth's sign-in, which mints a brand-new session with no active org
// (the org is bound only by select-organization), so the next org-scoped call 401'd and the user landed on
// /expired with their drafts wiped. `POST /api/v1/auth/unlock` instead verifies the password for the CURRENT
// session's user and mints nothing. Slice test through the full M1 chain; the live proof is m2-screen-unlock.live.
import { type FailedLoginStore, createInMemoryFailedLoginStore } from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type Actor,
  type IdentityRouteDeps,
  createFixedActorResolver,
  createInMemoryAuditExecutor,
  createInMemoryCollaboratorLinkStore,
  createInMemoryInvitationStore,
  createInMemoryMembershipRepository,
  createInMemorySessionWriter,
  createInMemoryUserDirectory,
  registerIdentityRoutes,
} from "../src/modules/02-identity/index";
import { createUnlockGuard } from "../src/modules/02-identity/unlock-guard";

const ACTOR: Actor = {
  userId: "user_rn",
  sessionId: "sess_1",
  organizationId: "org_a",
  membershipId: "m_a",
  roles: ["clinician"],
};
const GOOD_PASSWORD = "correct horse battery staple";

function headerAuth(request: FastifyRequest): void {
  request.context.userId = ACTOR.userId;
  request.context.organizationId = ACTOR.organizationId ?? "";
}

/** A counter store that is down - unlock must fail CLOSED rather than lose its budget. */
const downStore: FailedLoginStore = {
  async recordFailure() {
    throw new Error("valkey unreachable");
  },
  async failureCount() {
    throw new Error("valkey unreachable");
  },
  async clear() {
    throw new Error("valkey unreachable");
  },
};

function makeServer(
  opts: {
    verifier?: IdentityRouteDeps["passwordVerifier"] | null;
    store?: FailedLoginStore;
    actor?: Actor | null;
  } = {},
) {
  const memberships = createInMemoryMembershipRepository([]);
  const sessions = createInMemorySessionWriter();
  const auditSink = createInMemoryAuditExecutor();
  const auditFault = { armed: false };
  const audit: typeof auditSink.executor = {
    insert: (table) => ({
      values: async (row) => {
        if (auditFault.armed) {
          auditFault.armed = false;
          throw new Error("audit store unavailable");
        }
        await auditSink.executor.insert(table).values(row);
      },
    }),
  };
  const published: Array<{ eventName: string; payload: Record<string, unknown> }> = [];
  const verifyCalls: Array<{ userId: string; password: string }> = [];
  const verifier: NonNullable<IdentityRouteDeps["passwordVerifier"]> = {
    async verify(input) {
      verifyCalls.push(input);
      return input.password === GOOD_PASSWORD;
    },
  };
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerIdentityRoutes(app, {
    actors: createFixedActorResolver(opts.actor === undefined ? ACTOR : opts.actor),
    memberships: memberships.repo,
    sessions: sessions.writer,
    invitations: createInMemoryInvitationStore().store,
    collaborators: createInMemoryCollaboratorLinkStore().store,
    users: createInMemoryUserDirectory(memberships.repo).directory,
    audit,
    outbox: { publish: async (e) => void published.push({ eventName: e.eventName, payload: e.payload }) },
    unlockGuard: createUnlockGuard(opts.store ?? createInMemoryFailedLoginStore()),
    ...(opts.verifier === null ? {} : { passwordVerifier: opts.verifier ?? verifier }),
  });
  return { app, auditSink, auditFault, published, verifyCalls, sessions };
}

const unlock = (app: ReturnType<typeof makeServer>["app"], payload: unknown) =>
  app.inject({ method: "POST", url: "/api/v1/auth/unlock", payload: payload as object });

describe("#589 POST /api/v1/auth/unlock", () => {
  it("accepts the right password, keeps the same session and org, and records the unlock", async () => {
    const h = makeServer();
    const res = await unlock(h.app, { password: GOOD_PASSWORD });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: "sess_1", activeOrganizationId: "org_a" });
    expect(h.verifyCalls).toEqual([{ userId: "user_rn", password: GOOD_PASSWORD }]);
    // Nothing was re-bound: the org binding is untouched (select-organization is one-time).
    expect(h.sessions.boundOrg("sess_1")).toBeUndefined();
    expect(h.published).toEqual([
      { eventName: "m2.session.unlocked", payload: { sessionId: "sess_1", userId: "user_rn", organizationId: "org_a" } },
    ]);
    expect(h.auditSink.rows.map((r) => r.eventType)).toEqual(["m2.session.unlocked"]);
    await h.app.close();
  });

  it("refuses a wrong password with 401 INVALID_CREDENTIALS and audits it; the session survives", async () => {
    const h = makeServer();
    const res = await unlock(h.app, { password: "nope" });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_CREDENTIALS");
    expect(h.published).toEqual([]);
    expect(h.auditSink.rows.map((r) => r.eventType)).toEqual(["m2.session.unlock_failed"]);
    expect(h.sessions.revokedSessions()).toEqual([]);
    await h.app.close();
  });

  it("the 5th wrong password ends the session (423) and audits both the failure and the lockout", async () => {
    const h = makeServer();
    for (let i = 0; i < 4; i += 1) expect((await unlock(h.app, { password: "nope" })).statusCode).toBe(401);
    expect(h.sessions.revokedSessions()).toEqual([]);

    const fifth = await unlock(h.app, { password: "nope" });

    expect(fifth.statusCode).toBe(423);
    expect(fifth.json().error.code).toBe("UNLOCK_LOCKED_OUT");
    expect(h.sessions.revokedSessions()).toEqual(["sess_1"]);
    expect(h.auditSink.rows.map((r) => r.eventType).slice(-2)).toEqual([
      "m2.session.unlock_failed",
      "m2.session.terminated_unlock_lockout",
    ]);

    await h.app.close();
  });

  it("Retry-After is the window's remaining time, not the full window (#602)", async () => {
    let t = 1_000_000;
    const h = makeServer({ store: createInMemoryFailedLoginStore(() => t) });
    for (let i = 0; i < 5; i += 1) await unlock(h.app, { password: "nope" });
    t += 4 * 60_000; // 4 of the 10 minutes have passed

    const next = await unlock(h.app, { password: GOOD_PASSWORD });

    expect(next.statusCode).toBe(429);
    expect(next.headers["retry-after"]).toBe("360");
    await h.app.close();
  });

  it("a lockout does NOT refund the budget, so requests already in flight cannot reserve fresh attempts", async () => {
    const h = makeServer();
    for (let i = 0; i < 5; i += 1) await unlock(h.app, { password: "nope" });
    const hashed = h.verifyCalls.length;

    const next = await unlock(h.app, { password: GOOD_PASSWORD }); // right password, budget still spent

    expect(next.statusCode).toBe(429);
    expect(next.headers["retry-after"]).toBe("600");
    expect(h.verifyCalls.length).toBe(hashed); // refused BEFORE the password was hashed
    await h.app.close();
  });

  it("audits the first throttled attempt of a window, not every one", async () => {
    const h = makeServer();
    for (let i = 0; i < 5; i += 1) await unlock(h.app, { password: "nope" });
    for (let i = 0; i < 4; i += 1) await unlock(h.app, { password: "nope" });

    const throttled = h.auditSink.rows.filter((r) => r.eventType === "m2.session.unlock_throttled");
    expect(throttled).toHaveLength(1);
    await h.app.close();
  });

  it("still ends the session when the audit write fails on the final attempt", async () => {
    const h = makeServer();
    for (let i = 0; i < 4; i += 1) await unlock(h.app, { password: "nope" });
    h.auditFault.armed = true; // the audit insert for this attempt throws

    const fifth = await unlock(h.app, { password: "nope" });

    expect(fifth.statusCode).toBe(423);
    expect(h.sessions.revokedSessions()).toEqual(["sess_1"]);
    await h.app.close();
  });

  it("a burst of parallel guesses cannot overdraw the budget: at most 5 are ever hashed", async () => {
    const h = makeServer();
    const burst = await Promise.all(Array.from({ length: 20 }, () => unlock(h.app, { password: "nope" })));

    expect(h.verifyCalls.length).toBe(5);
    expect(burst.filter((r) => r.statusCode === 429)).toHaveLength(15);
    await h.app.close();
  });

  it("a correct password refunds the budget", async () => {
    const h = makeServer();
    for (let i = 0; i < 4; i += 1) await unlock(h.app, { password: "nope" });
    expect((await unlock(h.app, { password: GOOD_PASSWORD })).statusCode).toBe(200);

    // The 4 earlier failures were forgotten: 4 more are tolerated before the session ends.
    for (let i = 0; i < 4; i += 1) expect((await unlock(h.app, { password: "nope" })).statusCode).toBe(401);
    expect(h.sessions.revokedSessions()).toEqual([]);
    await h.app.close();
  });

  it("fails CLOSED with 503 when the counter store is down, without hashing the password", async () => {
    const h = makeServer({ store: downStore });
    const res = await unlock(h.app, { password: GOOD_PASSWORD });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("UNLOCK_UNAVAILABLE");
    expect(h.verifyCalls).toEqual([]);
    await h.app.close();
  });

  it("an org-less session still verifies, but writes no audit row and no event (it has no tenant)", async () => {
    const h = makeServer({ actor: { ...ACTOR, organizationId: null, membershipId: null } });
    const res = await unlock(h.app, { password: GOOD_PASSWORD });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: "sess_1", activeOrganizationId: null });
    expect(h.auditSink.rows).toEqual([]);
    expect(h.published).toEqual([]);
    await h.app.close();
  });

  it("is 401 with no session", async () => {
    const h = makeServer({ actor: null });
    const res = await unlock(h.app, { password: GOOD_PASSWORD });

    expect(res.statusCode).toBe(401);
    expect(h.verifyCalls).toEqual([]);
    await h.app.close();
  });

  it("is 422 without a password", async () => {
    const h = makeServer();
    const res = await unlock(h.app, {});

    expect(res.statusCode).toBe(422);
    expect(h.verifyCalls).toEqual([]);
    await h.app.close();
  });

  it("is 422 for an absurdly long password, without hashing it or counting a failure", async () => {
    const h = makeServer();
    const res = await unlock(h.app, { password: "x".repeat(257) });

    expect(res.statusCode).toBe(422);
    expect(h.verifyCalls).toEqual([]);
    await h.app.close();
  });

  it("fails closed with 503 when no verifier is bound", async () => {
    const h = makeServer({ verifier: null });
    const res = await unlock(h.app, { password: GOOD_PASSWORD });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("UNLOCK_UNAVAILABLE");
    await h.app.close();
  });
});
