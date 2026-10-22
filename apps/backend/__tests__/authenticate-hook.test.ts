// apps/backend/__tests__/authenticate-hook.test.ts — AUTH-T03 (ADR-0033).
// Unit-tests the authenticate hook factory with a stub snapshot reader + stub SessionContextResolver
// (no better-auth / no DB). The real session read + DB-backed resolver are verified in the AUTH-T06
// live-PG lane; the DB-backed SessionContextStore reconciliation lands in AUTH-T05.
import { type ResolvedActor, STEP_UP_POLICY, type SessionContextResolver } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { createSessionAuthenticate } from "../src/bootstrap/index";

interface Ctx {
  userId: string;
  organizationId: string;
  roles: string[];
  providerEntityIds: string[];
  locationIds: string[];
  attributes: Record<string, unknown>;
}
const reqWith = (headers: Record<string, string> = {}): { req: FastifyRequest; ctx: Ctx } => {
  const ctx: Ctx = {
    userId: "",
    organizationId: "",
    roles: [],
    providerEntityIds: [],
    locationIds: [],
    attributes: {},
  };
  return { req: { context: ctx, headers } as unknown as FastifyRequest, ctx };
};

/**
 * `stepUpAgoSec` drives the F-029 step-up stamp: `null` means the session never stepped up, a number
 * means it did, that many seconds ago, with TOTP. The hook calls BOTH `resolveStepUpState` and
 * `resolveStepUpPolicy` now — before F-029 it called neither, which is precisely why
 * `context.attributes.stepUpRecent` was never written and fifteen modules read a permanently-false
 * flag off it.
 */
const resolverReturning = (
  actor: ResolvedActor | null,
  stepUpAgoSec: number | null = null,
): SessionContextResolver => ({
  resolveActor: async () => actor,
  resolveStepUpState: async () =>
    stepUpAgoSec === null
      ? null
      : { lastStepUpAt: new Date(Date.now() - stepUpAgoSec * 1000), lastStepUpFactor: "totp" },
  resolveStepUpPolicy: async () => ({
    qualifyingFactors: STEP_UP_POLICY.qualifyingFactors,
    maxAgeSec: STEP_UP_POLICY.defaultMaxAgeSec,
  }),
});

const ORG_BOUND_ACTOR: ResolvedActor = {
  sessionClass: "staff",
  portalAccountId: null,
  sessionPatientId: null,
  deviceAttestation: null,
  externalActorId: null,
  userId: "u1",
  membershipId: "m1",
  organizationId: "org1",
  roles: ["rn"],
  providerEntityIds: ["pe-1"],
  locationIds: ["loc-1"],
};

describe("createSessionAuthenticate (AUTH-T03)", () => {
  it("populates context for an org-bound session via the resolver", async () => {
    const { req, ctx } = reqWith();
    const hook = createSessionAuthenticate({
      getSnapshot: async () => ({ sessionId: "s1", userId: "u1", activeOrganizationId: "org1" }),
      getResolver: () => resolverReturning(ORG_BOUND_ACTOR),
    });
    await hook(req);
    expect(ctx).toEqual({
      userId: "u1",
      organizationId: "org1",
      roles: ["rn"],
      // ARCH-008/009 — `providerEntityIds`/`locationIds` are the actor's PE/location ABAC scope. The
      // hook used to leave these permanently `[]`, so `provider_entity_scope`/`location_scope` and
      // every module's own PE/location predicate denied unconditionally — this pins the fix in place.
      providerEntityIds: ["pe-1"],
      locationIds: ["loc-1"],
      // `membershipId` is the fact the §4.x ownership predicates in M15/M16/M20/M21/M30/M33/M34 read
      // off `context.attributes`. The hook used to drop it even though the resolver returns it here,
      // so every one of those predicates saw null and denied — this assertion pinned that bug in place.
      // `stepUpRecent` is the §4.2.1 step-up freshness fact fifteen modules lift off
      // `context.attributes` into their route actor. NOTHING used to write it, so every one of them
      // read `false` for every request (F-029) — and four routes were worse than merely inert:
      // M37's IRC cap override and restraint apply, M23's claim submit and M27's cost-report submit
      // mount `requireStepUp(...)`, which passes, then hand the always-false flag to a service or a
      // pure machine that refuses. The guard allowed and the domain refused, always. `false` here is
      // correct for THIS case (the stub session never stepped up); the two cases below pin the fix.
      attributes: {
        sessionId: "s1",
        actorKind: "user",
        membershipId: "m1",
        stepUpRecent: false,
        // The §2.2.4 class the hook stamps off the resolved actor. It appears here now only because
        // the fixture above stopped omitting it: the resolver returned `undefined`, so the hook wrote
        // nothing and the portal/bereavement predicates that gate on it never saw a value (F-030).
        sessionClass: "staff",
      },
    });
  });

  it("stamps stepUpRecent TRUE for a session that stepped up inside the policy window (F-029)", async () => {
    const { req, ctx } = reqWith();
    const hook = createSessionAuthenticate({
      getSnapshot: async () => ({ sessionId: "s1", userId: "u1", activeOrganizationId: "org1" }),
      getResolver: () => resolverReturning(ORG_BOUND_ACTOR, 30), // 30s ago, floor allows 300s
    });
    await hook(req);
    expect(ctx.attributes.stepUpRecent).toBe(true);
  });

  it("stamps stepUpRecent FALSE for a step-up outside the window — the fact is resolved, not assumed", async () => {
    const { req, ctx } = reqWith();
    const hook = createSessionAuthenticate({
      getSnapshot: async () => ({ sessionId: "s1", userId: "u1", activeOrganizationId: "org1" }),
      getResolver: () => resolverReturning(ORG_BOUND_ACTOR, 86_400), // a day ago
    });
    await hook(req);
    expect(ctx.attributes.stepUpRecent).toBe(false);
  });

  it("resolves step-up through the INJECTED resolver, not the global seam registry", async () => {
    // The hook is constructed with a resolver and must not acquire a second, differently-wired path
    // to the same fact. No seam is registered in this suite; if the stamp went through `getSeam`
    // it would fail closed to `false` and this case would not be able to tell the difference from
    // the stale case above — hence a resolver that ONLY this hook can see, answering `true`.
    const { req, ctx } = reqWith();
    let calls = 0;
    const hook = createSessionAuthenticate({
      getSnapshot: async () => ({ sessionId: "s1", userId: "u1", activeOrganizationId: "org1" }),
      getResolver: () => {
        calls++;
        return resolverReturning(ORG_BOUND_ACTOR, 10);
      },
    });
    await hook(req);
    expect(ctx.attributes.stepUpRecent).toBe(true);
    expect(calls).toBeGreaterThan(0);
  });

  it("leaves context anonymous when there is no session", async () => {
    const { req, ctx } = reqWith();
    const hook = createSessionAuthenticate({
      getSnapshot: async () => null,
      getResolver: () => resolverReturning(null),
    });
    await hook(req);
    expect(ctx).toEqual({
      userId: "",
      organizationId: "",
      roles: [],
      providerEntityIds: [],
      locationIds: [],
      attributes: {},
    });
  });

  it("sets userId only for a pre-org session (no org binding yet)", async () => {
    const { req, ctx } = reqWith();
    const hook = createSessionAuthenticate({
      getSnapshot: async () => ({ sessionId: "s1", userId: "u1", activeOrganizationId: null }),
      getResolver: () => resolverReturning(null),
    });
    await hook(req);
    expect(ctx).toEqual({
      userId: "u1",
      organizationId: "",
      roles: [],
      providerEntityIds: [],
      locationIds: [],
      // `actorKind` is stamped as soon as the principal is known — BEFORE the org binding — because
      // it describes WHO is calling, not what they are scoped to. A pre-org session is still a user.
      attributes: { sessionId: "s1", actorKind: "user" },
    });
  });

  it("drops the org binding when the resolver returns null (session/org mismatch)", async () => {
    const { req, ctx } = reqWith();
    const hook = createSessionAuthenticate({
      getSnapshot: async () => ({ sessionId: "s1", userId: "u1", activeOrganizationId: "orgX" }),
      getResolver: () => resolverReturning(null),
    });
    await hook(req);
    expect(ctx).toEqual({
      userId: "u1",
      organizationId: "",
      roles: [],
      providerEntityIds: [],
      locationIds: [],
      // `actorKind` is stamped as soon as the principal is known — BEFORE the org binding — because
      // it describes WHO is calling, not what they are scoped to. A pre-org session is still a user.
      attributes: { sessionId: "s1", actorKind: "user" },
    });
  });

  // TASK-013 — the M23 #39/#40 / M15 `/internal/...` `requireSystemPrincipal()` routes' only path to
  // reachability: a shared secret presented over a header, verified independently of any session.
  describe("machine-credential path (internal seam routes)", () => {
    it("stamps actorKind=system + the org header when the shared secret matches", async () => {
      const { req, ctx } = reqWith({
        "x-internal-service-token": "s3cret-internal-token-value-32chars!!",
        "x-internal-org-id": "org-9",
      });
      const hook = createSessionAuthenticate({
        getSnapshot: async () => {
          throw new Error("must not read the interactive session on the machine-credential path");
        },
        getResolver: () => resolverReturning(null),
        systemCredential: { token: "s3cret-internal-token-value-32chars!!" },
      });
      await hook(req);
      expect(ctx).toEqual({
        userId: "system",
        organizationId: "org-9",
        roles: [],
        providerEntityIds: [],
        locationIds: [],
        attributes: { actorKind: "system" },
      });
    });

    it("falls through to the interactive path when no shared secret is configured", async () => {
      const { req, ctx } = reqWith({ "x-internal-service-token": "anything" });
      const hook = createSessionAuthenticate({
        getSnapshot: async () => null,
        getResolver: () => resolverReturning(null),
        // systemCredential intentionally omitted — the header alone must never authenticate.
      });
      await hook(req);
      expect(ctx.attributes.actorKind).toBeUndefined();
    });

    it("falls through to the interactive path when the presented secret is wrong", async () => {
      const { req, ctx } = reqWith({
        "x-internal-service-token": "wrong-token",
        "x-internal-org-id": "org-9",
      });
      const hook = createSessionAuthenticate({
        getSnapshot: async () => null,
        getResolver: () => resolverReturning(null),
        systemCredential: { token: "s3cret-internal-token-value-32chars!!" },
      });
      await hook(req);
      expect(ctx).toEqual({
        userId: "",
        organizationId: "",
        roles: [],
        providerEntityIds: [],
        locationIds: [],
        attributes: {},
      });
    });

    it("never grants system status without the header, even when configured", async () => {
      const { req, ctx } = reqWith();
      const hook = createSessionAuthenticate({
        getSnapshot: async () => null,
        getResolver: () => resolverReturning(null),
        systemCredential: { token: "s3cret-internal-token-value-32chars!!" },
      });
      await hook(req);
      expect(ctx.attributes.actorKind).toBeUndefined();
    });
  });

  describe("GAP-002 server-side session timeout", () => {
    const snapshot = async () => ({ sessionId: "s1", userId: "u1", activeOrganizationId: "org1" });

    it.each(["expired_idle", "expired_absolute"] as const)(
      "%s → the request stays anonymous and carries the expiry reason",
      async (state) => {
        const { req, ctx } = reqWith();
        const enforced: string[] = [];
        const hook = createSessionAuthenticate({
          getSnapshot: snapshot,
          getResolver: () => resolverReturning(ORG_BOUND_ACTOR),
          sessionTimeout: {
            enforce: async (sessionId) => {
              enforced.push(sessionId);
              return state;
            },
          },
        });
        await hook(req);
        expect(enforced).toEqual(["s1"]);
        expect(ctx.userId).toBe("");
        expect(ctx.organizationId).toBe("");
        expect(ctx.roles).toEqual([]);
        expect(ctx.attributes.sessionExpired).toBe(state);
      },
    );

    it("a background poll is checked for timeout but not recorded as activity", async () => {
      const calls: unknown[] = [];
      const hook = createSessionAuthenticate({
        getSnapshot: snapshot,
        getResolver: () => resolverReturning(ORG_BOUND_ACTOR),
        sessionTimeout: {
          enforce: async (_id, opts) => {
            calls.push(opts?.recordActivity);
            return "active";
          },
        },
      });
      await hook(reqWith({ "x-chartwarden-background": "1" }).req);
      await hook(reqWith().req);
      await hook(reqWith({ "x-wardenx-background": "1" }).req); // the retired alias no longer suppresses it
      expect(calls).toEqual([false, true, true]);
    });

    it("an active session resolves exactly as before", async () => {
      const { req, ctx } = reqWith();
      const hook = createSessionAuthenticate({
        getSnapshot: snapshot,
        getResolver: () => resolverReturning(ORG_BOUND_ACTOR),
        sessionTimeout: { enforce: async () => "active" },
      });
      await hook(req);
      expect(ctx.organizationId).toBe("org1");
      expect(ctx.attributes.sessionExpired).toBeUndefined();
    });
  });
});
