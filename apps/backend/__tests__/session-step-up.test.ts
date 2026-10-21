// apps/backend/__tests__/session-step-up.test.ts — M2-T05 step-up route integration tests
// (M2 spec §4.4; W-M2-09 explicit step-up, W-M2-11 SMS refusal, the lockout statechart).
//
// Exercises the routes through the FULL M1 middleware chain (request-context + error envelope
// + security) via Fastify `inject` with no live infra: buildServer() mounts the foundation
// host, then registerSessionStepUpRoutes() mounts the M2 routes with in-memory adapters. The
// header-auth shim sets request.context so the M1 `requireSession` context guard passes; the
// concrete session comes from the injected fixed resolver.
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type AuthenticatedSession,
  type StepUpRouteDeps,
  createCodeVerifier,
  createFixedSessionResolver,
  createInMemoryAuditExecutor,
  createInMemoryMfaEnrollment,
  createInMemorySessionStepUpWriter,
  createInMemoryStepUpChallengeStore,
  registerSessionStepUpRoutes,
} from "../src/modules/02-identity/index";

const ORG = "org_a";
const SESSION: AuthenticatedSession = {
  sessionId: "sess_1",
  userId: "user_1",
  organizationId: ORG,
  membershipId: "mem_1",
  lastStepUpAt: null,
  lastStepUpFactor: null,
};
const AUTH_HEADERS = { "x-test-org": ORG };

/** Test-only auth shim mirroring api.test.ts: populate request.context from headers. */
function headerAuth(request: FastifyRequest): void {
  const org = request.headers["x-test-org"];
  if (typeof org === "string" && org.length > 0) {
    request.context.organizationId = org;
    request.context.userId = SESSION.userId;
    request.context.roles = [];
  }
}

let writer: ReturnType<typeof createInMemorySessionStepUpWriter>;
let auditSink: ReturnType<typeof createInMemoryAuditExecutor>;

/** Build the foundation host + mount the step-up routes with in-memory deps. */
function makeServer(overrides: Partial<StepUpRouteDeps> = {}) {
  writer = createInMemorySessionStepUpWriter();
  auditSink = createInMemoryAuditExecutor();
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerSessionStepUpRoutes(app, {
    sessions: createFixedSessionResolver(SESSION),
    writer: writer.writer,
    enrollment: createInMemoryMfaEnrollment({ user_1: ["webauthn", "totp"] }),
    verifier: createCodeVerifier("123456"),
    challenges: createInMemoryStepUpChallengeStore(),
    audit: auditSink.executor,
    webauthnRpId: "chartwarden.test",
    ...overrides,
  });
  return app;
}

describe("M2-T05 step-up route", () => {
  describe("context guard (routes behind requireSession)", () => {
    it("unauthenticated POST /sessions/step-up/initiate → 401 envelope", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/sessions/step-up/initiate",
        payload: { factor: "totp" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
      await app.close();
    });

    it("authenticated context but no resolvable session → 401", async () => {
      const app = makeServer({ sessions: createFixedSessionResolver(null) });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/sessions/step-up/initiate",
        headers: AUTH_HEADERS,
        payload: { factor: "totp" },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });

  describe("W-M2-09: explicit step-up updates the session", () => {
    it("WebAuthn: initiate → verify → 200, paired-writes the session + audits completed", async () => {
      const app = makeServer();
      const initiate = await app.inject({
        method: "POST",
        url: "/api/v1/sessions/step-up/initiate",
        headers: AUTH_HEADERS,
        payload: { factor: "webauthn" },
      });
      expect(initiate.statusCode).toBe(200);
      const { challengeId, webauthnChallenge } = initiate.json();
      expect(typeof challengeId).toBe("string");
      expect(webauthnChallenge.rpId).toBe("chartwarden.test");
      expect(typeof webauthnChallenge.challenge).toBe("string");

      const verify = await app.inject({
        method: "POST",
        url: "/api/v1/sessions/step-up",
        headers: AUTH_HEADERS,
        payload: {
          challengeId,
          factor: "webauthn",
          assertion: {
            credentialId: "c",
            authenticatorData: "a",
            clientDataJSON: "d",
            signature: "s",
          },
        },
      });
      expect(verify.statusCode).toBe(200);
      expect(verify.json().lastStepUpFactor).toBe("webauthn");
      expect(typeof verify.json().lastStepUpAt).toBe("string");

      expect(writer.stateOf("sess_1")?.lastStepUpFactor).toBe("webauthn");
      const completed = auditSink.rows.find((r) => r.eventType === "m2.session.step_up.completed");
      expect(completed?.retentionClass).toBe("compliance");
      expect(completed?.context).toMatchObject({ factor: "webauthn", source: "explicit_route" });
      await app.close();
    });

    it("TOTP: initiate → verify with the correct code → 200", async () => {
      const app = makeServer();
      const initiate = await app.inject({
        method: "POST",
        url: "/api/v1/sessions/step-up/initiate",
        headers: AUTH_HEADERS,
        payload: { factor: "totp" },
      });
      const { challengeId } = initiate.json();
      const verify = await app.inject({
        method: "POST",
        url: "/api/v1/sessions/step-up",
        headers: AUTH_HEADERS,
        payload: { challengeId, factor: "totp", totpCode: "123456" },
      });
      expect(verify.statusCode).toBe(200);
      expect(writer.stateOf("sess_1")?.lastStepUpFactor).toBe("totp");
      await app.close();
    });

    it("initiate for a non-enrolled factor → 400 *_not_enrolled", async () => {
      const app = makeServer({ enrollment: createInMemoryMfaEnrollment({ user_1: ["webauthn"] }) });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/sessions/step-up/initiate",
        headers: AUTH_HEADERS,
        payload: { factor: "totp" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("TOTP_NOT_ENROLLED");
      await app.close();
    });

    it("verify with an unknown/expired challenge → 400 challenge_expired_or_invalid", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/sessions/step-up",
        headers: AUTH_HEADERS,
        payload: { challengeId: "does-not-exist", factor: "totp", totpCode: "123456" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("CHALLENGE_EXPIRED_OR_INVALID");
      await app.close();
    });
  });

  describe("W-M2-11: SMS does not qualify as step-up", () => {
    it("initiate with factor=sms → 400 sms_not_step_up_qualifying", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/sessions/step-up/initiate",
        headers: AUTH_HEADERS,
        payload: { factor: "sms" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("SMS_NOT_STEP_UP_QUALIFYING");
      expect(auditSink.rows).toHaveLength(0); // no attempt started
      await app.close();
    });

    it("verify directly with factor=sms → 400 sms_not_step_up_qualifying", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/sessions/step-up",
        headers: AUTH_HEADERS,
        payload: { challengeId: "x", factor: "sms", totpCode: "123456" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("SMS_NOT_STEP_UP_QUALIFYING");
      await app.close();
    });

    it("a wholly unknown factor → 422 VALIDATION_FAILED envelope", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/sessions/step-up/initiate",
        headers: AUTH_HEADERS,
        payload: { factor: "email" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("VALIDATION_FAILED");
      await app.close();
    });
  });

  describe("lockout (statechart: 3 consecutive failures in the window)", () => {
    it("two failures → 401 step_up_failed; the third terminates the session → 423", async () => {
      const app = makeServer();
      const initiate = await app.inject({
        method: "POST",
        url: "/api/v1/sessions/step-up/initiate",
        headers: AUTH_HEADERS,
        payload: { factor: "totp" },
      });
      const { challengeId } = initiate.json();
      const verifyBad = () =>
        app.inject({
          method: "POST",
          url: "/api/v1/sessions/step-up",
          headers: AUTH_HEADERS,
          payload: { challengeId, factor: "totp", totpCode: "000000" },
        });

      expect((await verifyBad()).statusCode).toBe(401);
      expect((await verifyBad()).statusCode).toBe(401);
      const third = await verifyBad();
      expect(third.statusCode).toBe(423);
      expect(third.json().error).toMatchObject({
        code: "SESSION_LOCKED",
        details: [{ code: "STEP_UP_LOCKOUT" }],
      });

      expect(writer.isTerminated("sess_1")).toBe(true);
      expect(
        auditSink.rows.filter((r) => r.eventType === "m2.session.step_up.failed"),
      ).toHaveLength(3);
      expect(
        auditSink.rows.filter((r) => r.eventType === "m2.session.terminated_step_up_lockout"),
      ).toHaveLength(1);
      await app.close();
    });
  });
  describe("ADR-0049 D6: the tenant host is the WebAuthn origin in subdomain mode", () => {
    const ASSERTION = { credentialId: "c", authenticatorData: "a", clientDataJSON: "d", signature: "s" };

    async function verifyOnHost(hostOrgHeader: string | undefined) {
      const seen: Array<string | undefined> = [];
      const app = buildServer({
        authenticate: (request) => {
          headerAuth(request);
          const hostOrg = request.headers["x-test-host-org"];
          if (typeof hostOrg === "string") request.context.attributes.tenantHostOrgId = hostOrg;
        },
        security: { rateLimitEnabled: false },
      });
      registerSessionStepUpRoutes(app, {
        sessions: createFixedSessionResolver(SESSION),
        writer: createInMemorySessionStepUpWriter().writer,
        enrollment: createInMemoryMfaEnrollment({ user_1: ["webauthn"] }),
        verifier: {
          verify: (input) => {
            seen.push(input.requestOrigin);
            return { ok: true };
          },
        },
        challenges: createInMemoryStepUpChallengeStore(),
        audit: createInMemoryAuditExecutor().executor,
        webauthnRpId: "chartwarden.test",
      });
      const headers: Record<string, string> = { ...AUTH_HEADERS, host: "sunrise.chartwarden.com" };
      if (hostOrgHeader) headers["x-test-host-org"] = hostOrgHeader;
      const initiate = await app.inject({
        method: "POST",
        url: "/api/v1/sessions/step-up/initiate",
        headers,
        payload: { factor: "webauthn" },
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/sessions/step-up",
        headers,
        payload: { challengeId: initiate.json().challengeId, factor: "webauthn", assertion: ASSERTION },
      });
      await app.close();
      return seen;
    }

    it("passes https://<host> to the verifier when the tenant-host guard stamped the request", async () => {
      expect(await verifyOnHost(ORG)).toEqual(["https://sunrise.chartwarden.com"]);
    });

    it("passes nothing in single-host mode", async () => {
      expect(await verifyOnHost(undefined)).toEqual([undefined]);
    });
  });
});
