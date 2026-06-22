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
      attributes: { sessionId: "s1" },
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
      attributes: { sessionId: "s1" },
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
      attributes: { sessionId: "s1" },
    });
  });
});
