// apps/backend/__tests__/authenticate-hook.test.ts — AUTH-T03 (ADR-0033).
// Unit-tests the authenticate hook factory with a stub snapshot reader + stub SessionContextResolver
// (no better-auth / no DB). The real session read + DB-backed resolver are verified in the AUTH-T06
// live-PG lane; the DB-backed SessionContextStore reconciliation lands in AUTH-T05.
import type { ResolvedActor, SessionContextResolver } from "@wardenx/types";
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

const resolverReturning = (actor: ResolvedActor | null): SessionContextResolver => ({
  resolveActor: async () => actor,
  resolveStepUpState: async () => null,
});

describe("createSessionAuthenticate (AUTH-T03)", () => {
  it("populates context for an org-bound session via the resolver", async () => {
    const { req, ctx } = reqWith();
    const hook = createSessionAuthenticate({
      getSnapshot: async () => ({ sessionId: "s1", userId: "u1", activeOrganizationId: "org1" }),
      getResolver: () =>
        resolverReturning({
          userId: "u1",
          membershipId: "m1",
          organizationId: "org1",
          roles: ["rn"],
          providerEntityIds: ["pe-1"],
          locationIds: ["loc-1"],
        }),
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
      attributes: { sessionId: "s1", actorKind: "user", membershipId: "m1" },
    });
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
});
