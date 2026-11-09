// The server-assembled acting admin of the DoseSpot tenant routes. A request with no session at all is unauthenticated (401); a
// signed-in session that holds no organization membership is authenticated but cannot act (403). The web shell maps any 401 to
// /expired, so answering 401 for the second case signed a live session out instead of denying it (the same rule M2 and M7 follow).
import { ForbiddenError, UnauthorizedError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { clinicActorOf } from "./route-guards";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP = "33333333-3333-4333-8333-333333333333";

const requestWith = (context: Record<string, unknown> | undefined): FastifyRequest =>
  ({ id: "req-1", context }) as unknown as FastifyRequest;

describe("clinicActorOf", () => {
  it("assembles the actor from the session's own membership", () => {
    const actor = clinicActorOf(
      requestWith({ organizationId: ORG, userId: USER, attributes: { membershipId: MEMBERSHIP } }),
    );
    expect(actor).toMatchObject({ organizationId: ORG, userId: USER, membershipId: MEMBERSHIP });
  });

  it("answers 403 (not 401) for a signed-in session that has no membership", () => {
    for (const attributes of [{}, { membershipId: "" }, { membershipId: 7 }]) {
      const attempt = () =>
        clinicActorOf(requestWith({ organizationId: ORG, userId: USER, attributes }));
      expect(attempt).toThrow(ForbiddenError);
      try {
        attempt();
      } catch (error) {
        expect(error).toMatchObject({ statusCode: 403 });
      }
    }
  });

  it("still answers 401 for a request with no session", () => {
    expect(() => clinicActorOf(requestWith(undefined))).toThrow(UnauthorizedError);
    expect(() => clinicActorOf(requestWith({ attributes: {} }))).toThrow(UnauthorizedError);
    expect(() =>
      clinicActorOf(requestWith({ organizationId: ORG, attributes: { membershipId: MEMBERSHIP } })),
    ).toThrow(UnauthorizedError);
  });
});
