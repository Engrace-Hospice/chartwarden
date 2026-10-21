// apps/backend/__tests__/mfa-enrolment-matrix.test.ts — GAP-003 / GAP-005: the server-side MFA matrix (M2 §2.3).
//
// Unit-level proof of the three enforcement points over stub ports (the live lane, m2-auth-hardening.live,
// proves the same against real Better Auth + Postgres): the pure matrix, the gate, `select-organization`, the
// authenticate-stage hold, and the `two-factor/disable` guard.
import {
  evaluateMfa,
  mfaRequirementFor,
  registerIdentityAuth,
  resolveMfaEnforcement,
  sessionClassRequiresMfa,
} from "@chartwarden/auth";
import { type ResolvedActor, STEP_UP_POLICY, type SessionContextResolver } from "@chartwarden/types";
import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { createSessionAuthenticate } from "../src/bootstrap/index";
import { createMfaEnrolmentGate } from "../src/modules/02-identity/mfa-enrolment-gate";

const NONE = { totp: false, passkey: false };

describe("the MFA matrix (pure)", () => {
  it("requires a second factor of any staff role, a passkey of org_admin / platform_ops, nothing of no role", () => {
    expect(mfaRequirementFor([])).toBe("none");
    expect(mfaRequirementFor(["rn", "social_worker"])).toBe("second_factor");
    expect(mfaRequirementFor(["rn", "org_admin"])).toBe("passkey");
    expect(mfaRequirementFor(["platform_ops"])).toBe("passkey");
  });

  it("a TOTP satisfies a second-factor requirement but never a passkey requirement", () => {
    expect(evaluateMfa(["rn"], { totp: true, passkey: false }).satisfied).toBe(true);
    expect(evaluateMfa(["rn"], { totp: false, passkey: true }).satisfied).toBe(true);
    expect(evaluateMfa(["rn"], NONE).satisfied).toBe(false);
    expect(evaluateMfa(["org_admin"], { totp: true, passkey: false }).satisfied).toBe(false);
    expect(evaluateMfa(["org_admin"], { totp: false, passkey: true }).satisfied).toBe(true);
  });

  it("governs staff sessions only", () => {
    expect(sessionClassRequiresMfa("staff")).toBe(true);
    for (const c of ["auditor", "external_collaborator", "funeral_home", "portal_patient"])
      expect(sessionClassRequiresMfa(c)).toBe(false);
  });

  it("is opt-in: a production deploy never locks staff out before the enrolment UI exists", () => {
    expect(resolveMfaEnforcement({ NODE_ENV: "production" })).toBe(false);
    expect(resolveMfaEnforcement({ NODE_ENV: "development" })).toBe(false);
    expect(
      resolveMfaEnforcement({ NODE_ENV: "production", WARDENX_MFA_ENFORCEMENT: "false" }),
    ).toBe(false);
    expect(resolveMfaEnforcement({ NODE_ENV: "production", WARDENX_MFA_ENFORCEMENT: "true" })).toBe(
      true,
    );
    expect(resolveMfaEnforcement({ NODE_ENV: "test", WARDENX_MFA_ENFORCEMENT: "true" })).toBe(true);
  });
});

function gateWith(opts: {
  enforced?: boolean;
  totp?: boolean;
  passkey?: boolean;
  roles?: readonly string[];
  /** The factor the session proved at sign-in; defaults to a TOTP when TOTP-enrolled, else a passkey. */
  proved?: string | null;
}) {
  let factorReads = 0;
  const gate = createMfaEnrolmentGate({
    enforced: opts.enforced ?? true,
    factors: {
      hasFactor: ({ factor }) => {
        factorReads += 1;
        return factor === "totp" ? (opts.totp ?? false) : (opts.passkey ?? false);
      },
    },
    sessionProvedFactor: async () =>
      opts.proved !== undefined
        ? opts.proved
        : opts.passkey
          ? "webauthn"
          : opts.totp
            ? "totp"
            : null,
    roleKeysForMembership: async () => opts.roles ?? ["rn"],
    activeMembershipsOf: async () => [{ organizationId: "o1", membershipId: "m1" }],
  });
  return { gate, reads: () => factorReads };
}

describe("the gate", () => {
  it("denies a password-only clinician and admits one with a TOTP", async () => {
    const denied = await gateWith({}).gate.forMembership({
      userId: "u1",
      sessionId: "s1",
      organizationId: "o1",
      membershipId: "m1",
    });
    expect(denied).toEqual({
      requirement: "second_factor",
      satisfied: false,
      reason: "not_enrolled",
    });
    const admitted = await gateWith({ totp: true }).gate.forRoles({
      userId: "u1",
      sessionId: "s1",
      roleKeys: ["rn"],
    });
    expect(admitted.satisfied).toBe(true);
  });

  it("an org_admin with only a TOTP is still refused (passkey required)", async () => {
    const verdict = await gateWith({ totp: true, roles: ["org_admin"] }).gate.forMembership({
      userId: "u1",
      sessionId: "s1",
      organizationId: "o1",
      membershipId: "m1",
    });
    expect(verdict).toEqual({ requirement: "passkey", satisfied: false, reason: "not_enrolled" });
  });

  it("a passkey-only org_admin on a password-only session is refused until the session proves the passkey", async () => {
    const input = { userId: "u1", sessionId: "s1", roleKeys: ["org_admin"] };
    const unproven = await gateWith({ passkey: true, proved: null }).gate.forRoles(input);
    expect(unproven).toEqual({ requirement: "passkey", satisfied: false, reason: "not_verified" });
    const totpProof = await gateWith({ passkey: true, proved: "totp" }).gate.forRoles(input);
    expect(totpProof.satisfied).toBe(false);
    const proven = await gateWith({ passkey: true, proved: "webauthn" }).gate.forRoles(input);
    expect(proven.satisfied).toBe(true);
  });

  it("a TOTP-enrolled clinician on an unproven session is refused; any proved factor admits", async () => {
    const input = { userId: "u1", sessionId: "s1", roleKeys: ["rn"] };
    expect((await gateWith({ totp: true, proved: null }).gate.forRoles(input)).reason).toBe(
      "not_verified",
    );
    expect((await gateWith({ totp: true, proved: "sms" }).gate.forRoles(input)).satisfied).toBe(
      false,
    );
    expect((await gateWith({ totp: true, proved: "totp" }).gate.forRoles(input)).satisfied).toBe(
      true,
    );
  });

  it("reads nothing and admits everyone when not enforced", async () => {
    const { gate, reads } = gateWith({ enforced: false });
    expect(
      (await gate.forRoles({ userId: "u1", sessionId: "s1", roleKeys: ["org_admin"] })).satisfied,
    ).toBe(true);
    expect(reads()).toBe(0);
  });

  it("removing the only TOTP of a required role is refused; with a passkey it is allowed", async () => {
    expect((await gateWith({ totp: true }).gate.forUserWithoutTotp("u1")).satisfied).toBe(false);
    expect(
      (await gateWith({ totp: true, passkey: true }).gate.forUserWithoutTotp("u1")).satisfied,
    ).toBe(true);
  });
});

const ACTOR: ResolvedActor = {
  sessionClass: "staff",
  portalAccountId: null,
  sessionPatientId: null,
  deviceAttestation: null,
  externalActorId: null,
  userId: "u1",
  membershipId: "m1",
  organizationId: "org1",
  roles: ["rn"],
  providerEntityIds: [],
  locationIds: [],
};
const resolver = (actor: ResolvedActor): SessionContextResolver => ({
  resolveActor: async () => actor,
  resolveStepUpState: async () => null,
  resolveStepUpPolicy: async () => ({
    qualifyingFactors: STEP_UP_POLICY.qualifyingFactors,
    maxAgeSec: STEP_UP_POLICY.defaultMaxAgeSec,
  }),
});
const requestAt = (url: string) =>
  ({
    url,
    method: "GET",
    headers: {},
    context: {
      userId: "",
      organizationId: "",
      roles: [],
      providerEntityIds: [],
      locationIds: [],
      attributes: {},
    },
  }) as unknown as FastifyRequest;

describe("the authenticate-stage hold (GAP-003)", () => {
  const hookFor = (actor: ResolvedActor, satisfied: boolean) =>
    createSessionAuthenticate({
      getSnapshot: async () => ({ sessionId: "s1", userId: "u1", activeOrganizationId: "org1" }),
      getResolver: () => resolver(actor),
      mfaEnrolment: { check: async () => ({ satisfied, requirement: "second_factor" }) },
    });

  it("a clinical route is refused 403 MFA_ENROLMENT_REQUIRED while the factor is missing", async () => {
    await expect(hookFor(ACTOR, false)(requestAt("/api/v1/patients"))).rejects.toMatchObject({
      code: "MFA_ENROLMENT_REQUIRED",
      statusCode: 403,
    });
  });

  it("Better Auth enrolment and the pre-org account routes stay reachable", async () => {
    for (const url of ["/api/auth/two-factor/enable", "/api/v1/auth/memberships"])
      await expect(hookFor(ACTOR, false)(requestAt(url))).resolves.toBeUndefined();
  });

  it("once the factor exists the request proceeds", async () => {
    const req = requestAt("/api/v1/patients");
    await hookFor(ACTOR, true)(req);
    expect(req.context.organizationId).toBe("org1");
  });

  it("a non-staff session class is not held (auditor has its own stage)", async () => {
    const req = requestAt("/api/v1/patients");
    await hookFor({ ...ACTOR, sessionClass: "funeral_home" }, false)(req);
    expect(req.context.organizationId).toBe("org1");
  });
});

describe("the two-factor/disable guard (GAP-005)", () => {
  const build = (totpOnly: boolean) => {
    const app = Fastify();
    const { gate } = gateWith({ totp: true, passkey: !totpOnly });
    registerIdentityAuth(
      app,
      {
        handler: async () => new Response("{}", { status: 200 }),
        api: { getSession: async () => ({ user: { id: "u1" }, session: { id: "s1" } }) },
      },
      {
        guard: async ({ relativePath, actor }) => {
          if (relativePath !== "/two-factor/disable" || !actor) return;
          if (!(await gate.forUserWithoutTotp(actor.userId)).satisfied)
            throw Object.assign(new Error("MFA_REQUIRED_FOR_ROLE"), { statusCode: 403 });
        },
      },
    );
    return app;
  };

  it("is refused for a clinician whose only factor is the TOTP, allowed once a passkey exists", async () => {
    const blocked = await build(true).inject({
      method: "POST",
      url: "/api/auth/two-factor/disable",
    });
    expect(blocked.statusCode).toBe(403);
    const allowed = await build(false).inject({
      method: "POST",
      url: "/api/auth/two-factor/disable",
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("never touches other endpoints", async () => {
    const res = await build(true).inject({ method: "POST", url: "/api/auth/sign-out" });
    expect(res.statusCode).toBe(200);
  });
});

describe("recording the proved second factor (GAP-003/005)", () => {
  const build = (status = 200) => {
    const recorded: { sessionId: string; userId: string; factor: string }[] = [];
    const seenCookies: string[] = [];
    const app = Fastify();
    registerIdentityAuth(
      app,
      {
        handler: async () =>
          new Response("{}", { status, headers: { "set-cookie": "session=new-token; Path=/" } }),
        api: {
          getSession: async ({ headers }: { headers: Headers }) => {
            seenCookies.push(headers.get("cookie") ?? "");
            return { user: { id: "u1" }, session: { id: "s-new" } };
          },
        },
      },
      {
        onSecondFactorVerified: async (input) => {
          recorded.push(input);
        },
      },
    );
    return { app, recorded, seenCookies };
  };

  it("records webauthn for a passkey sign-in, resolving the session the response minted", async () => {
    const { app, recorded, seenCookies } = build();
    await app.inject({
      method: "POST",
      url: "/api/auth/passkey/verify-authentication",
      headers: { cookie: "session=old; other=1" },
      payload: {},
    });
    expect(recorded).toEqual([{ sessionId: "s-new", userId: "u1", factor: "webauthn" }]);
    expect(seenCookies[0]).toBe("session=new-token; other=1");
  });

  it("records totp for a TOTP verify and for a backup code", async () => {
    const { app, recorded } = build();
    for (const path of ["/two-factor/verify-totp", "/two-factor/verify-backup-code"])
      await app.inject({ method: "POST", url: `/api/auth${path}`, payload: {} });
    expect(recorded.map((r) => r.factor)).toEqual(["totp", "totp"]);
  });

  it("records nothing for a failed ceremony or a password sign-in", async () => {
    const failed = build(401);
    await failed.app.inject({
      method: "POST",
      url: "/api/auth/two-factor/verify-totp",
      payload: {},
    });
    const password = build();
    await password.app.inject({ method: "POST", url: "/api/auth/sign-in/email", payload: {} });
    expect(failed.recorded).toEqual([]);
    expect(password.recorded).toEqual([]);
  });

  it("a failing write never fails the sign-in and is reported", async () => {
    const errors: unknown[] = [];
    const app = Fastify();
    registerIdentityAuth(
      app,
      {
        handler: async () => new Response("{}", { status: 200 }),
        api: { getSession: async () => ({ user: { id: "u1" }, session: { id: "s1" } }) },
      },
      {
        onSecondFactorVerified: async () => {
          throw new Error("db down");
        },
        onSecondFactorError: (err) => errors.push(err),
      },
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/two-factor/verify-totp",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(errors).toHaveLength(1);
  });
});
