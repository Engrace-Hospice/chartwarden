import { createHmac } from "node:crypto";
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetRbacEngine,
} from "@chartwarden/auth";
// apps/backend/__tests__/device-attestation-routes.test.ts — ADR-0023 D2 / SecHardening §12.2/§12.4.
//
// The ceremony end to end, through the FULL M1 middleware chain (request context + error envelope +
// security) via Fastify `inject`, with an in-memory store standing in for Drizzle.
//
// WHY A ROUTE TEST AND NOT ONLY THE UNIT ONES. The verifier and the resolver are each covered next door
// in `device-attestation.test.ts`. What neither can show is the JOIN between them: that the challenge
// the server minted is the one the assertion is checked against, that the session binding comes off
// `request.context` rather than the body, and that a spent challenge is spent. Every F-030 defect in
// this repo lived in exactly that gap — each end worked, and nothing ran the wire between them.
//
// The header-auth shim mirrors api.test.ts. Note what it does NOT do: it never stamps a device fact.
// The suites that hid the original F-030 keys all supplied the missing attribute in their own shim,
// which is how they demonstrated the shim instead of the gate.
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type {
  DeviceAttestationChallenge,
  DeviceAttestationRecord,
  DeviceAttestationStore,
} from "../src/modules/02-identity/device-attestation-ports";
import {
  attestationMacPayload,
  createInMemoryAuditExecutor,
  createInMemoryDeviceAttestationChallengeStore,
  createManagedEnrollmentVerifier,
  orgEnrollmentKey,
  registerDeviceAttestationRoutes,
} from "../src/modules/02-identity/index";

const SECRET = "platform-enrollment-secret";
const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "sess_1";

const HEADERS = { "x-test-org": ORG, "x-test-session": SESSION_ID };
const GOOD_POSTURE = {
  osVersion: "17.4.1",
  jailbrokenOrRooted: false,
  biometricAvailable: true,
  screenLockEnabled: true,
  emulator: false,
};

/** Populate `request.context` the way the real authenticate hook does. NEVER a device fact. */
function headerAuth(request: FastifyRequest): void {
  const org = request.headers["x-test-org"];
  if (typeof org !== "string" || org.length === 0) return;
  request.context.organizationId = org;
  request.context.userId = "user_1";
  request.context.roles = ["org_admin"];
  request.context.attributes.membershipId = MEMBERSHIP;
  const session = request.headers["x-test-session"];
  if (typeof session === "string" && session.length > 0) {
    request.context.attributes.sessionId = session;
  }
}

/** An in-memory `DeviceAttestationStore` that records what the routes asked it to do. */
function makeStore() {
  const rows: DeviceAttestationRecord[] = [];
  const boundSessions: string[] = [];
  let seq = 0;
  const record = (over: Partial<DeviceAttestationRecord>): DeviceAttestationRecord => ({
    id: `att-${++seq}`,
    organizationId: ORG,
    membershipId: MEMBERSHIP,
    deviceKeyFingerprint: "fp-1",
    platform: "ios",
    provider: "managed_enrollment",
    verdict: "attested",
    verifiedAt: "2026-08-26T12:00:00.000Z",
    expiresAt: "2026-09-25T12:00:00.000Z",
    revokedAt: null,
    ...over,
  });
  const store: DeviceAttestationStore = {
    async recordAttested(input) {
      boundSessions.push(input.sessionId);
      const row = record({
        organizationId: input.organizationId,
        membershipId: input.membershipId,
        deviceKeyFingerprint: input.deviceKeyFingerprint,
      });
      rows.push(row);
      return row;
    },
    async recordFailed(input) {
      const row = record({ verdict: "failed", deviceKeyFingerprint: input.deviceKeyFingerprint });
      rows.push(row);
      return row;
    },
    async revoke(input) {
      const row = rows.find((r) => r.id === input.attestationId && r.verdict === "attested");
      if (!row) return null;
      const revoked = {
        ...row,
        verdict: "revoked" as const,
        revokedAt: "2026-08-26T13:00:00.000Z",
      };
      rows[rows.indexOf(row)] = revoked;
      return revoked;
    },
    async listForMembership() {
      return rows;
    },
  };
  return { store, rows, boundSessions };
}

let harness: ReturnType<typeof makeStore>;
let auditSink: ReturnType<typeof createInMemoryAuditExecutor>;

/** `secret` is passed through verbatim. `""` is the UNCONFIGURED deployment — deliberately not
 *  `undefined`, which `createManagedEnrollmentVerifier` reads as "use the ambient env var" and would
 *  make this suite pass or fail depending on the developer's shell. */
function makeServer(secret: string = SECRET) {
  harness = makeStore();
  auditSink = createInMemoryAuditExecutor();
  // The revoke route is permission-gated. Granting it to the ONE test user means a 403 anywhere below
  // is the route's own decision rather than an unseeded harness.
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "user_1",
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["device_attestation.read", "device_attestation.revoke"],
          },
        ],
      },
    ]).store,
  );
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerDeviceAttestationRoutes(app, {
    challenges: createInMemoryDeviceAttestationChallengeStore(),
    verifier: createManagedEnrollmentVerifier(secret),
    store: harness.store,
    audit: auditSink.executor,
  });
  return app;
}

/** Run the challenge half, then MAC the given payload against the nonce the SERVER minted. */
async function attestBody(
  app: ReturnType<typeof makeServer>,
  over: Record<string, unknown> = {},
  secret = SECRET,
) {
  const challengeRes = await app.inject({
    method: "POST",
    url: "/api/v1/devices/attestation/challenge",
    headers: HEADERS,
    payload: {},
  });
  const { challengeId, nonce } = challengeRes.json();
  const base = {
    deviceKeyFingerprint: "fp-1",
    platform: "ios" as const,
    provider: "managed_enrollment" as const,
    posture: GOOD_POSTURE,
    assertion: "",
    ...over,
  };
  const challenge: DeviceAttestationChallenge = {
    sessionId: SESSION_ID,
    membershipId: MEMBERSHIP,
    organizationId: ORG,
    nonce,
    createdAt: "2026-08-26T12:00:00.000Z",
  };
  const mac = createHmac("sha256", orgEnrollmentKey(secret, ORG))
    .update(attestationMacPayload(challenge, base))
    .digest("base64");
  return { challengeId, body: { challengeId, ...base, assertion: mac } };
}

describe("device attestation — the ceremony", () => {
  beforeEach(() => {
    harness = makeStore();
  });
  afterEach(() => {
    resetRbacEngine();
  });

  it("an unauthenticated caller cannot mint a challenge", async () => {
    const app = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/devices/attestation/challenge",
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("challenge → attest records the device and binds THIS session", async () => {
    const app = makeServer();
    const { body } = await attestBody(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/devices/attestation",
      headers: HEADERS,
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ verdict: "attested" });
    // The org and membership came off the SESSION, not the body — the body never carried them.
    expect(harness.rows[0]).toMatchObject({ organizationId: ORG, membershipId: MEMBERSHIP });
    expect(harness.boundSessions).toEqual([SESSION_ID]);
    await app.close();
  });

  it("a challenge is single-use — the identical request replayed is refused", async () => {
    // The replay case, at the route rather than at the store. A captured assertion is worthless the
    // moment the server has seen it once, which is what a nonce is for.
    const app = makeServer();
    const { body } = await attestBody(app);
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/devices/attestation",
      headers: HEADERS,
      payload: body,
    });
    expect(first.statusCode).toBe(201);
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/devices/attestation",
      headers: HEADERS,
      payload: body,
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error.code).toBe("CHALLENGE_EXPIRED_OR_INVALID");
    expect(harness.rows).toHaveLength(1);
    await app.close();
  });

  it("a challenge minted for another session cannot be spent here", async () => {
    // Bound at mint. Without this check a caller could mint on their own session and spend on someone
    // else's, which would let them attest a device onto an account they do not hold.
    const app = makeServer();
    const { body } = await attestBody(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/devices/attestation",
      headers: { ...HEADERS, "x-test-session": "sess_someone_else" },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("CHALLENGE_SESSION_MISMATCH");
    expect(harness.rows).toHaveLength(0);
    await app.close();
  });

  it("a jailbroken device is REFUSED and the failure is RECORDED", async () => {
    // §12.4 names the server-side audit as the complement to on-device detection. A handset that keeps
    // failing is the pattern it asks to surface, so the row is written before the 401 goes out.
    const app = makeServer();
    const { body } = await attestBody(app, {
      posture: { ...GOOD_POSTURE, jailbrokenOrRooted: true },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/devices/attestation",
      headers: HEADERS,
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.details[0].message).toBe("device_compromised");
    expect(harness.rows).toHaveLength(1);
    expect(harness.rows[0]?.verdict).toBe("failed");
    // And it never bound the session — a failed check does not put a device behind a request.
    expect(harness.boundSessions).toEqual([]);
    await app.close();
  });

  it("a forged assertion is refused", async () => {
    const app = makeServer();
    const { body } = await attestBody(app, {}, "the-wrong-secret");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/devices/attestation",
      headers: HEADERS,
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.details[0].message).toBe("assertion_signature_invalid");
    await app.close();
  });

  it("an unconfigured deployment answers 501 and records NOTHING", async () => {
    // "This deployment does not do device enrolment" must not look like "your fleet is compromised".
    const app = makeServer("");
    const { body } = await attestBody(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/devices/attestation",
      headers: HEADERS,
      payload: body,
    });
    expect(res.statusCode).toBe(501);
    expect(harness.rows).toHaveLength(0);
    await app.close();
  });

  it("rejects a malformed body without reaching the verifier", async () => {
    const app = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/devices/attestation",
      headers: HEADERS,
      payload: { challengeId: "c1", platform: "windows", provider: "nope" },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("revoking requires a reason and answers 404 for an id this org cannot see", async () => {
    const app = makeServer();
    const short = await app.inject({
      method: "POST",
      url: "/api/v1/devices/attestation/att-1/revoke",
      headers: HEADERS,
      payload: { reason: "lost" },
    });
    expect(short.statusCode).toBe(422);
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/devices/attestation/att-999/revoke",
      headers: HEADERS,
      payload: { reason: "handset reported lost by the clinician" },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("revoking an attested device flips it to revoked", async () => {
    const app = makeServer();
    const { body } = await attestBody(app);
    await app.inject({
      method: "POST",
      url: "/api/v1/devices/attestation",
      headers: HEADERS,
      payload: body,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/devices/attestation/${harness.rows[0]?.id}/revoke`,
      headers: HEADERS,
      payload: { reason: "handset reported lost by the clinician" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().verdict).toBe("revoked");
    await app.close();
  });
});
