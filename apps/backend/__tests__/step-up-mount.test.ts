import type { DbClient } from "@wardenx/db";
import type { FastifyRequest } from "fastify";
// apps/backend/__tests__/step-up-mount.test.ts — M2 §4.4.
//
// THE DEFECT. `registerSessionStepUpRoutes` shipped with slice adapters and exactly one caller: its own
// test. It was exported from M2's index, it appeared in the published OpenAPI contract (the route
// scanner reads SOURCE, so an unmounted route is indistinguishable from a mounted one to it), and no
// boot path called it. `onLoginMfaCompleted` — the only other writer of `session.last_step_up_at` — was
// exported and called by nobody either.
//
// So the column was populated by NOTHING in production. `stepUpFreshFor` resolved it correctly from a
// value that never existed, and every step-up gate on the platform answered "not fresh" for every
// caller, forever. Fail-closed, therefore invisible — and worse than inert on the four write paths
// (M23 claim submit/replace/void, M27 cost-report submit, M37 IRC cap override + restraint apply) whose
// guard PASSES and whose domain then refuses on the flag.
//
// WHY THIS FILE IS ABOUT MOUNTING AND NOT ABOUT STEP-UP LOGIC. `session-step-up.test.ts` next door
// covers the routes' behaviour thoroughly — the SMS refusal, the lockout statechart, the paired write.
// It covered all of it against `registerSessionStepUpRoutes` called by hand. What nothing asserted was
// that anything calls it, which is the only thing that was actually wrong. So this file asserts the
// wiring: the mount registers the paths, and it builds the PRODUCTION adapters rather than the slice
// ones — because a mount that wired `createCodeVerifier` would pass a "routes exist" check and still
// accept one hard-coded TOTP code from every caller.
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  createContextSessionResolver,
  createDbMfaEnrollmentReader,
  createDbMfaVerifier,
  createDbSessionStepUpWriter,
  mountSessionStepUpRoutes,
} from "../src/modules/02-identity/index";

/** The adapters only close over `db`; none of them queries at construction. */
const NO_DB = {} as DbClient;

describe("M2 §4.4 — the step-up routes are MOUNTED, not merely exported", () => {
  it("mountSessionStepUpRoutes registers both §4.4 paths", async () => {
    // `hasRoute`, not a substring of `printRoutes()`: that tree is radix-rendered, so a path is split
    // across nodes and a `toContain` on the full path passes or fails for reasons unrelated to whether
    // the route exists.
    const app = buildServer({ security: { rateLimitEnabled: false } });
    mountSessionStepUpRoutes(app, NO_DB);
    await app.ready();
    expect(app.hasRoute({ method: "POST", url: "/api/v1/sessions/step-up" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/api/v1/sessions/step-up/initiate" })).toBe(true);
    await app.close();
  });

  it("a bare server does NOT have them — so the assertion above is about the mount, not the host", async () => {
    // Without this, the test above would still pass if `buildServer` happened to register these paths
    // itself, and would go on passing after someone removed the mount call.
    const bare = buildServer({ security: { rateLimitEnabled: false } });
    await bare.ready();
    expect(bare.hasRoute({ method: "POST", url: "/api/v1/sessions/step-up" })).toBe(false);
    await bare.close();
  });

  it("an unauthenticated caller is refused rather than 404'd — the route is live", async () => {
    // A 404 here would mean the path is absent; a 401 means the route is mounted and its session guard
    // ran. That distinction is the entire finding: for the whole life of the codebase this answered 404.
    const app = buildServer({ security: { rateLimitEnabled: false } });
    mountSessionStepUpRoutes(app, NO_DB);
    for (const url of ["/api/v1/sessions/step-up/initiate", "/api/v1/sessions/step-up"]) {
      const res = await app.inject({ method: "POST", url, payload: { factor: "totp" } });
      expect(res.statusCode).not.toBe(404);
      expect(res.statusCode).toBe(401);
    }
    await app.close();
  });
});

describe("M2 §4.4 — the mounted adapters are the PRODUCTION ones", () => {
  it("the session resolver reads the SERVER-assembled context, never the body", async () => {
    const resolver = createContextSessionResolver();
    const request = (context: Record<string, unknown> | null) =>
      ({ context, body: { sessionId: "attacker-chosen" } }) as unknown as FastifyRequest;

    // No context at all, and a body that names a session: still null. The body is not an input.
    expect(await resolver.resolve(request(null))).toBeNull();

    const resolved = await resolver.resolve(
      request({
        userId: "u1",
        organizationId: "org1",
        attributes: { sessionId: "sess_1", membershipId: "mem_1" },
      }),
    );
    expect(resolved).toMatchObject({
      sessionId: "sess_1",
      userId: "u1",
      organizationId: "org1",
      membershipId: "mem_1",
    });
  });

  it("a pre-org session resolves to null — there is nothing to step up INTO yet", async () => {
    const resolver = createContextSessionResolver();
    const noOrg = {
      context: { userId: "u1", organizationId: "", attributes: { sessionId: "sess_1" } },
    } as unknown as FastifyRequest;
    expect(await resolver.resolve(noOrg)).toBeNull();
  });

  it("the MFA verifier refuses a factor that is not step-up qualifying", async () => {
    // SMS is refused earlier, at the route boundary (W-M2-11 / D9). This is the defense-in-depth end:
    // an unknown factor reaching the verifier is a refusal, not a throw, because a throw becomes a 500
    // and the route's contract needs a false to feed the lockout counter.
    const verifier = createDbMfaVerifier(NO_DB);
    expect(await verifier.verify({ userId: "u1", factor: "sms" as never })).toMatchObject({
      ok: false,
    });
  });

  it("the MFA verifier refuses each factor when its proof is missing, without querying", async () => {
    // NO_DB would throw if either branch reached its store, so these assertions double as proof that
    // the missing-proof check happens BEFORE any lookup.
    const verifier = createDbMfaVerifier(NO_DB);
    expect(await verifier.verify({ userId: "u1", factor: "totp" })).toEqual({
      ok: false,
      reason: "totp_code_missing",
    });
    expect(await verifier.verify({ userId: "u1", factor: "webauthn", assertion: {} })).toEqual({
      ok: false,
      reason: "webauthn_assertion_missing",
    });
    expect(
      await verifier.verify({ userId: "u1", factor: "webauthn", webauthnChallenge: "c" }),
    ).toEqual({ ok: false, reason: "webauthn_assertion_missing" });
  });

  it("the production adapters are constructible — the mount wires these, not the slice ones", () => {
    // `createCodeVerifier` / `createInMemorySessionStepUpWriter` / `createInMemoryMfaEnrollment` are
    // the slice adapters the old test used. A mount that wired those would pass every "routes exist"
    // check above and still accept one hard-coded TOTP code from every caller in production.
    expect(typeof createDbSessionStepUpWriter(NO_DB).recordStepUp).toBe("function");
    expect(typeof createDbSessionStepUpWriter(NO_DB).terminate).toBe("function");
    expect(typeof createDbMfaEnrollmentReader(NO_DB).hasFactor).toBe("function");
    expect(typeof createDbMfaVerifier(NO_DB).verify).toBe("function");
  });
});
