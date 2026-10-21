// M30 D19 — R-70 / R-71 carry the patient display name + MRN suffix (from M5's org-explicit display seam,
// injected as a port) ONLY for a caller holding `mortality.read_with_patient`; otherwise the id-only shape.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { M30_PERMISSION_KEY_LIST, mountM30Routes } from "../src/modules/30-quality/index";
import type {
  M30ReadRouteService,
  MortalityReviewDetailView,
  MortalityReviewSummaryView,
} from "../src/modules/30-quality/routes/read-service";
import type { M30WriteRouteService } from "../src/modules/30-quality/routes/write-service";

const ORG = "org_a";
const REVIEW = "33333333-1111-4111-8111-333333333333";
const P_KNOWN = "10101010-1010-4101-8101-101010101010";
const P_UNKNOWN = "20202020-2020-4202-8202-202020202020";
const NOW = "2026-08-04T12:00:00.000Z";
const HEADERS = {
  "x-test-user": "md_1",
  "x-test-org": ORG,
  "x-test-roles": "medical_director",
  "x-test-membership": "88888888-8888-4888-8888-888888888888",
};
const WITH_PATIENT = "mortality.read_with_patient";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string") return;
  request.context.userId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? "");
  request.context.roles = String(request.headers["x-test-roles"] ?? "").split(",");
  request.context.attributes.membershipId = String(request.headers["x-test-membership"] ?? "");
}

const summary = (patientId: string): MortalityReviewSummaryView => ({
  reviewId: REVIEW,
  organizationId: ORG,
  patientId,
  dateOfDeath: NOW,
  assignedToMembershipId: null,
  status: "created",
  targetCompletionAt: NOW,
  completedAt: null,
});
const detail = (patientId: string): MortalityReviewDetailView => ({
  ...summary(patientId),
  dimensions: { clinical: null, satisfaction: null, compliance: null },
  reviewerMembershipId: null,
  createdAt: NOW,
  updatedAt: NOW,
});

function makeServer(opts: { granted: boolean; port: boolean }) {
  const portCalls: { organizationId: string; patientIds: readonly string[] }[] = [];
  const readService: Pick<M30ReadRouteService, "listMortalityReviews" | "getMortalityReview"> = {
    async listMortalityReviews() {
      return {
        items: [summary(P_KNOWN), summary(P_UNKNOWN)],
        nextCursor: null,
        hasMore: false,
      };
    },
    async getMortalityReview() {
      return detail(P_KNOWN);
    },
  };
  const keys = M30_PERMISSION_KEY_LIST.filter((k) => opts.granted || k !== WITH_PATIENT);
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "md_1",
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [...keys] }],
      },
    ]).store,
  );
  registerAbacRegistry(createPredicateRegistry());
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM30Routes(app, {
    readService: readService as M30ReadRouteService,
    writeService: {} as M30WriteRouteService,
    resolveScope: async () => ({ kind: "org" }),
    ...(opts.port
      ? {
          patientDisplay: {
            async displayForPatients(organizationId: string, patientIds: readonly string[]) {
              portCalls.push({ organizationId, patientIds });
              return new Map([[P_KNOWN, { displayName: "Ada L.", mrnSuffix: "4821" }]]);
            },
          },
        }
      : {}),
  });
  return { app, portCalls };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("M30 D19 — mortality patient display is gated by mortality.read_with_patient", () => {
  it("list: holder gets name + MRN suffix (one batched M5 read, the actor's org); an unresolved id stays id-only", async () => {
    const { app, portCalls } = makeServer({ granted: true, port: true });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/quality/mortality",
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const [known, unknown] = res.json().items;
    expect(known).toMatchObject({ patientDisplayName: "Ada L.", patientMrnSuffix: "4821" });
    expect(unknown.patientDisplayName).toBeUndefined();
    expect(portCalls).toEqual([{ organizationId: ORG, patientIds: [P_KNOWN, P_UNKNOWN] }]);
    await app.close();
  });

  it("list: without the permission the response carries no name and M5 is never read", async () => {
    const { app, portCalls } = makeServer({ granted: false, port: true });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/quality/mortality",
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    for (const item of res.json().items) {
      expect(item.patientDisplayName).toBeUndefined();
      expect(item.patientMrnSuffix).toBeUndefined();
    }
    expect(portCalls).toEqual([]);
    await app.close();
  });

  it("detail: holder gets name + MRN suffix; non-holder gets the id-only shape", async () => {
    const url = `/api/v1/quality/mortality/${REVIEW}`;
    const yes = makeServer({ granted: true, port: true });
    const withName = await yes.app.inject({ method: "GET", url, headers: HEADERS });
    expect(withName.json()).toMatchObject({
      patientDisplayName: "Ada L.",
      patientMrnSuffix: "4821",
    });
    await yes.app.close();

    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    const no = makeServer({ granted: false, port: true });
    const without = await no.app.inject({ method: "GET", url, headers: HEADERS });
    expect(without.statusCode).toBe(200);
    expect(without.json().patientDisplayName).toBeUndefined();
    expect(without.json().patientId).toBe(P_KNOWN);
    await no.app.close();
  });

  it("holder with no display port bound still gets the id-only shape (fail-soft)", async () => {
    const { app } = makeServer({ granted: true, port: false });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/quality/mortality",
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].patientDisplayName).toBeUndefined();
    await app.close();
  });
});
