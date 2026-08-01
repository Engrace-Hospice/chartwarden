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
  attributes: Record<string, unknown>;
}
const reqWith = (): { req: FastifyRequest; ctx: Ctx } => {
  const ctx: Ctx = { userId: "", organizationId: "", roles: [], attributes: {} };
  return { req: { context: ctx } as unknown as FastifyRequest, ctx };
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
        }),
    });
    await hook(req);
    expect(ctx).toEqual({
      userId: "u1",
      organizationId: "org1",
      roles: ["rn"],
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
    expect(ctx).toEqual({ userId: "", organizationId: "", roles: [], attributes: {} });
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
      // `actorKind` is stamped as soon as the principal is known — BEFORE the org binding — because
      // it describes WHO is calling, not what they are scoped to. A pre-org session is still a user.
      attributes: { sessionId: "s1", actorKind: "user" },
    });
  });
});
