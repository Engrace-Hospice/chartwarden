// GAP-115 — GET /api/v1/me/session (M2 §4.1, D8): read-only session metadata including the step-up state, so a
// client can open the step-up modal before the gated action fires.
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type AuthenticatedSession,
  createCodeVerifier,
  createFixedSessionResolver,
  createInMemoryAuditExecutor,
  createInMemoryMfaEnrollment,
  createInMemorySessionStepUpWriter,
  createInMemoryStepUpChallengeStore,
  registerSessionStepUpRoutes,
} from "../src/modules/02-identity/index";
import { describeStepUp } from "../src/modules/02-identity/routes/session-step-up";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const base: AuthenticatedSession = {
  sessionId: "sess_1",
  userId: "user_1",
  organizationId: "org_a",
  membershipId: "mem_1",
  lastStepUpAt: null,
  lastStepUpFactor: null,
};

function headerAuth(request: FastifyRequest): void {
  const org = request.headers["x-test-org"];
  if (typeof org === "string" && org.length > 0) {
    request.context.organizationId = org;
    request.context.userId = "user_1";
    request.context.roles = [];
  }
}

function makeServer(session: AuthenticatedSession | null) {
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerSessionStepUpRoutes(app, {
    sessions: createFixedSessionResolver(null), // the step-up routes' own resolver is irrelevant here
    meSessions: createFixedSessionResolver(session),
    writer: createInMemorySessionStepUpWriter().writer,
    enrollment: createInMemoryMfaEnrollment({}),
    verifier: createCodeVerifier("123456"),
    challenges: createInMemoryStepUpChallengeStore(),
    audit: createInMemoryAuditExecutor().executor,
    now: () => NOW,
  });
  return app;
}

describe("describeStepUp (vs the platform floor: 300s)", () => {
  it("none when never stepped up", () => {
    expect(describeStepUp(base, NOW)).toEqual({
      stepUpStatus: "none",
      stepUpExpiresAt: null,
      stepUpSecondsRemaining: 0,
    });
  });

  it("fresh inside the window, with the seconds left", () => {
    const out = describeStepUp(
      { lastStepUpAt: new Date(NOW.getTime() - 100_000), lastStepUpFactor: "totp" },
      NOW,
    );
    expect(out.stepUpStatus).toBe("fresh");
    expect(out.stepUpSecondsRemaining).toBe(200);
  });

  it("expired past the window", () => {
    const out = describeStepUp(
      { lastStepUpAt: new Date(NOW.getTime() - 301_000), lastStepUpFactor: "webauthn" },
      NOW,
    );
    expect(out).toMatchObject({ stepUpStatus: "expired", stepUpSecondsRemaining: 0 });
  });
});

describe("GET /api/v1/me/session", () => {
  it("returns the session and its step-up state", async () => {
    const app = makeServer({
      ...base,
      lastStepUpAt: new Date(NOW.getTime() - 60_000),
      lastStepUpFactor: "webauthn",
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/session",
      headers: { "x-test-org": "org_a" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      sessionId: "sess_1",
      organizationId: "org_a",
      lastStepUpFactor: "webauthn",
      stepUpStatus: "fresh",
      stepUpSecondsRemaining: 240,
    });
    await app.close();
  });

  it("401 without a session, and without a resolvable one", async () => {
    const app = makeServer(null);
    expect((await app.inject({ method: "GET", url: "/api/v1/me/session" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/me/session",
          headers: { "x-test-org": "org_a" },
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
  });
});
