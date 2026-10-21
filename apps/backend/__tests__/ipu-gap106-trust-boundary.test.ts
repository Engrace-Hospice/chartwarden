// apps/backend/__tests__/ipu-gap106-trust-boundary.test.ts — GAP-106 (M37): body release, GIP attestation
// and the M6 confirm handshake must not trust client-supplied facts.
//
// Two layers, no database (the live proof is the typechecked `m37-gap106-trust-boundary.live.test.ts`):
//   1. the pure, port-driven gates (`routes/ipu-trust-gates.ts`) the Drizzle service composes — driven with
//      fake seam ports, including the DENY-STUB shape (a port that throws), which must read as "not proven".
//   2. the real route table over `.inject()` with the REAL Authorization Contract and the REAL M37 ABAC
//      predicates, so a tenant user calling `/confirm` and a non-MD calling `/gip-criteria` are refused by
//      the guards themselves, before any service code runs.
import { randomUUID } from "node:crypto";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { IpuStateError, transitionBodyRelease } from "@chartwarden/inpatient";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildM37AbacPredicates } from "../src/modules/37-ipu/abac/predicates";
import { M37_CONTRIBUTED_PERMISSIONS, mountM37Routes } from "../src/modules/37-ipu/index";
import {
  type BodyReleaseDocumentReader,
  GIP_ATTESTER_ROLE_KEYS,
  type MdmDirectoryReader,
  evaluateGipAttesterEligibility,
  resolveBodyReleaseEventFacts,
} from "../src/modules/37-ipu/routes/ipu-trust-gates";
import type { IpuRouteService } from "../src/modules/37-ipu/routes/service";
import {
  M37_SYSTEM_MEMBERSHIP_ID,
  bodyReleaseSweepActor,
  isIpuSystemActor,
  m6LcpAckActor,
} from "../src/modules/37-ipu/routes/system-actor";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const PATIENT = randomUUID();
const BODY_RELEASE_ID = randomUUID();
const DOC_ID = randomUUID();
const FH_ID = randomUUID();
const PHYSICIAN_ID = randomUUID();
const BR = { id: BODY_RELEASE_ID, patientId: PATIENT, releaseDocumentId: null };

const goodDigest = {
  documentId: DOC_ID,
  aggregateType: "body_release_authorization",
  aggregateId: BODY_RELEASE_ID,
  patientId: PATIENT,
  status: "active",
  activeVersionId: randomUUID(),
};
const docsReturning = (d: unknown): BodyReleaseDocumentReader => ({
  documentMetadata: async () => d as never,
});
const docsThrowing: BodyReleaseDocumentReader = {
  documentMetadata: () => {
    throw new Error("DocumentReader deny-stub");
  },
};
const mdm = (over: Partial<MdmDirectoryReader> = {}): MdmDirectoryReader => ({
  resolveFuneralHome: async () => ({ id: FH_ID, status: "active" }),
  resolvePhysician: async () => ({ id: PHYSICIAN_ID, status: "active" }),
  ...over,
});

describe("GAP-106 body release — funeral home resolved through M40, never from the body's say-so", () => {
  it("a random funeral home id that M40 does not know is refused 422", async () => {
    const facts = await resolveBodyReleaseEventFacts({
      action: "identifyFuneralHome",
      organizationId: ORG,
      bodyRelease: BR,
      funeralHomeId: randomUUID(),
      releaseDocumentId: undefined,
      actorIsSweep: false,
      documents: docsReturning(null),
      directory: mdm({ resolveFuneralHome: async () => null }),
    });
    expect(facts).toEqual({ type: "identifyFuneralHome", funeralHomeResolved: false });
    expect(() => transitionBodyRelease("pending", facts)).toThrowError(
      expect.objectContaining({ code: "BODY_RELEASE_FUNERAL_HOME_UNRESOLVED", statusCode: 422 }),
    );
  });

  it("a deactivated funeral home is not a resolved funeral home", async () => {
    const facts = await resolveBodyReleaseEventFacts({
      action: "identifyFuneralHome",
      organizationId: ORG,
      bodyRelease: BR,
      funeralHomeId: FH_ID,
      releaseDocumentId: undefined,
      actorIsSweep: false,
      documents: docsReturning(null),
      directory: mdm({ resolveFuneralHome: async () => ({ id: FH_ID, status: "deactivated" }) }),
    });
    expect(facts).toMatchObject({ funeralHomeResolved: false });
  });

  it("an unbound M40 seam (deny-stub throws) fails closed rather than reading as resolved", async () => {
    const facts = await resolveBodyReleaseEventFacts({
      action: "identifyFuneralHome",
      organizationId: ORG,
      bodyRelease: BR,
      funeralHomeId: FH_ID,
      releaseDocumentId: undefined,
      actorIsSweep: false,
      documents: docsReturning(null),
      directory: mdm({
        resolveFuneralHome: () => {
          throw new Error("MdmEntityProvider deny-stub");
        },
      }),
    });
    expect(facts).toMatchObject({ funeralHomeResolved: false });
  });

  it("an active, M40-resolved funeral home passes", async () => {
    const facts = await resolveBodyReleaseEventFacts({
      action: "identifyFuneralHome",
      organizationId: ORG,
      bodyRelease: BR,
      funeralHomeId: FH_ID,
      releaseDocumentId: undefined,
      actorIsSweep: false,
      documents: docsReturning(null),
      directory: mdm(),
    });
    expect(facts).toEqual({ type: "identifyFuneralHome", funeralHomeResolved: true });
  });
});

describe("GAP-106 body release — the release document is verified against M22, not just present", () => {
  const release = (documents: BodyReleaseDocumentReader, releaseDocumentId: string | undefined) =>
    resolveBodyReleaseEventFacts({
      action: "releaseBody",
      organizationId: ORG,
      bodyRelease: BR,
      funeralHomeId: undefined,
      releaseDocumentId,
      actorIsSweep: false,
      documents,
      directory: mdm(),
    });

  it("a random UUID M22 has never heard of is refused 422 (BODY_RELEASE_DOCUMENT_INVALID)", async () => {
    const facts = await release(docsReturning(null), randomUUID());
    expect(facts).toEqual({
      type: "releaseBody",
      hasReleaseDocument: false,
      documentRejected: true,
    });
    expect(() => transitionBodyRelease("funeral_home_identified", facts)).toThrowError(
      expect.objectContaining({ code: "BODY_RELEASE_DOCUMENT_INVALID", statusCode: 422 }),
    );
  });

  it("no document id at all stays the 412 BODY_RELEASE_DOCUMENT_REQUIRED", async () => {
    const facts = await release(docsReturning(goodDigest), undefined);
    expect(() => transitionBodyRelease("funeral_home_identified", facts)).toThrowError(
      expect.objectContaining({ code: "BODY_RELEASE_DOCUMENT_REQUIRED", statusCode: 412 }),
    );
  });

  it.each([
    ["a different document type", { ...goodDigest, aggregateType: "election_statement" }],
    ["another body release's document", { ...goodDigest, aggregateId: randomUUID() }],
    ["another patient's document", { ...goodDigest, patientId: randomUUID() }],
    ["a superseded document", { ...goodDigest, status: "superseded" }],
    ["a document with no active version", { ...goodDigest, activeVersionId: null }],
  ])("%s is refused", async (_name, digest) => {
    const facts = await release(docsReturning(digest), DOC_ID);
    expect(facts).toMatchObject({ hasReleaseDocument: false, documentRejected: true });
  });

  it("an unbound M22 seam (deny-stub throws) fails closed", async () => {
    const facts = await release(docsThrowing, DOC_ID);
    expect(facts).toMatchObject({ hasReleaseDocument: false, documentRejected: true });
  });

  it("the matching active body_release_authorization document for THIS release passes", async () => {
    const facts = await release(docsReturning(goodDigest), DOC_ID);
    expect(facts).toEqual({ type: "releaseBody", hasReleaseDocument: true });
  });

  it("falls back to the document the row already carries when the body names none", async () => {
    const facts = await resolveBodyReleaseEventFacts({
      action: "releaseBody",
      organizationId: ORG,
      bodyRelease: { ...BR, releaseDocumentId: DOC_ID },
      funeralHomeId: undefined,
      releaseDocumentId: undefined,
      actorIsSweep: false,
      documents: docsReturning(goodDigest),
      directory: mdm(),
    });
    expect(facts).toEqual({ type: "releaseBody", hasReleaseDocument: true });
  });
});

describe("GAP-106 body release — postClose is the sweep's, never a tenant caller's", () => {
  it("a tenant caller's postClose carries isSystemActor:false and the machine refuses", async () => {
    const facts = await resolveBodyReleaseEventFacts({
      action: "postClose",
      organizationId: ORG,
      bodyRelease: BR,
      funeralHomeId: undefined,
      releaseDocumentId: undefined,
      actorIsSweep: false,
      documents: docsReturning(null),
      directory: mdm(),
    });
    expect(facts).toEqual({ type: "postClose", isSystemActor: false });
    expect(() => transitionBodyRelease("released", facts)).toThrow(IpuStateError);
  });

  it("only the typed sweep actor yields isSystemActor:true", async () => {
    const facts = await resolveBodyReleaseEventFacts({
      action: "postClose",
      organizationId: ORG,
      bodyRelease: BR,
      funeralHomeId: undefined,
      releaseDocumentId: undefined,
      actorIsSweep: true,
      documents: docsReturning(null),
      directory: mdm(),
    });
    expect(facts).toEqual({ type: "postClose", isSystemActor: true });
  });
});

describe("GAP-106 typed system actor — never inferred from a role string", () => {
  it("a tenant write actor, even one holding a 'system' role, is not a system actor", () => {
    expect(
      isIpuSystemActor({
        organizationId: ORG,
        userId: "u",
        roles: ["system", "m6_system"],
        membershipId: randomUUID(),
        stepUpRecent: true,
        stepUpAssertionId: null,
      } as never),
    ).toBe(false);
    expect(isIpuSystemActor({ kind: "system", source: "m6_lcp_ack" } as never)).toBe(false);
  });

  it("the factories mint the only recognised system actors, stamped with the system membership", () => {
    const lcp = m6LcpAckActor(ORG, randomUUID());
    expect(isIpuSystemActor(lcp)).toBe(true);
    expect(lcp.membershipId).toBe(M37_SYSTEM_MEMBERSHIP_ID);
    expect(lcp.source).toBe("m6_lcp_ack");
    expect(isIpuSystemActor(bodyReleaseSweepActor(ORG))).toBe(true);
  });
});

describe("GAP-106 GIP attester eligibility composes the role fact AND the M40 physician fact", () => {
  const evaluate = (roles: readonly string[], directory: MdmDirectoryReader) =>
    evaluateGipAttesterEligibility({
      organizationId: ORG,
      roles,
      attestingPhysicianId: PHYSICIAN_ID,
      directory,
    });

  it("exposes the MD role keys the server derives eligibility from", () => {
    expect([...GIP_ATTESTER_ROLE_KEYS]).toEqual(["medical_director", "hospice_physician"]);
  });

  it("a hospice physician with an active M40 physician is eligible", async () => {
    expect(await evaluate(["hospice_physician"], mdm())).toBe(true);
    expect(await evaluate(["medical_director"], mdm())).toBe(true);
  });

  it.each([["rn"], ["rn_case_manager"], ["nurse_practitioner"], []])(
    "a non-MD (%j) is not eligible, whatever M40 says",
    async (...roles) => {
      expect(await evaluate(roles.flat(), mdm())).toBe(false);
    },
  );

  it("an MD attesting under an unknown / deactivated / unreadable M40 physician is not eligible", async () => {
    expect(await evaluate(["medical_director"], mdm({ resolvePhysician: async () => null }))).toBe(
      false,
    );
    expect(
      await evaluate(
        ["medical_director"],
        mdm({ resolvePhysician: async () => ({ id: PHYSICIAN_ID, status: "deactivated" }) }),
      ),
    ).toBe(false);
    expect(
      await evaluate(
        ["medical_director"],
        mdm({
          resolvePhysician: () => {
            throw new Error("MdmEntityProvider deny-stub");
          },
        }),
      ),
    ).toBe(false);
  });
});

// ── the real route table ──────────────────────────────────────────────────────────────────────────────
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string" && membership.length > 0) {
    request.context.attributes.membershipId = membership;
  }
  const session = request.headers["x-test-session"];
  if (typeof session === "string" && session.length > 0) {
    request.context.attributes.sessionId = session;
  }
  if (request.headers["x-test-step-up"] === "1") request.context.attributes.stepUpRecent = true;
}

const MEMBERSHIP = "11111111-1111-4111-8111-111111111111";
const ALL_KEYS = Object.keys(M37_CONTRIBUTED_PERMISSIONS);

describe("GAP-106 route table", () => {
  const service = {
    confirm: vi.fn(),
    attestGip: vi.fn(async () => ({ id: randomUUID() })),
    advanceBodyRelease: vi.fn(),
  };

  beforeEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    for (const fn of Object.values(service)) fn.mockClear();
    const store = createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "any_role_user",
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ALL_KEYS }],
      },
    ]);
    registerEffectivePermissionResolver(store.store);
    const registry = createPredicateRegistry();
    for (const [name, predicate] of Object.entries(buildM37AbacPredicates())) {
      registry.register(name, predicate);
    }
    registry.register("step_up_recent", async (c) => c.attributes.stepUpRecent === true);
    registerAbacRegistry(registry);
  });
  afterEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
  });

  async function app() {
    const server = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    mountM37Routes(server, { service: service as unknown as IpuRouteService });
    return server;
  }
  const headers = (roles: string, extra: Record<string, string> = {}) => ({
    "x-test-user": "any_role_user",
    "x-test-org": ORG,
    "x-test-roles": roles,
    "x-test-membership": MEMBERSHIP,
    ...extra,
  });

  it("a tenant user holding the create permission is REFUSED on the system-internal /confirm", async () => {
    const server = await app();
    const res = await server.inject({
      method: "POST",
      url: `/api/v1/ipu-admissions/${randomUUID()}/confirm`,
      headers: headers("admissions_team,org_admin,system"),
      payload: { forceFlag: true },
    });
    expect(res.statusCode).toBe(403);
    expect(service.confirm).not.toHaveBeenCalled();
    await server.close();
  });

  it("a non-MD attester is refused 403 at the route, before the service runs", async () => {
    const server = await app();
    const res = await server.inject({
      method: "POST",
      url: `/api/v1/ipu-admissions/${randomUUID()}/gip-criteria`,
      headers: headers("rn", { "x-test-step-up": "1", "x-test-session": randomUUID() }),
      payload: { attestingPhysicianId: randomUUID(), data: {} },
    });
    expect(res.statusCode).toBe(403);
    expect(service.attestGip).not.toHaveBeenCalled();
    await server.close();
  });

  it("an MD passes the route guards and reaches the service (which re-asserts the M40 fact)", async () => {
    const server = await app();
    const res = await server.inject({
      method: "POST",
      url: `/api/v1/ipu-admissions/${randomUUID()}/gip-criteria`,
      headers: headers("hospice_physician", {
        "x-test-step-up": "1",
        "x-test-session": randomUUID(),
      }),
      payload: {
        attestingPhysicianId: randomUUID(),
        data: {
          criterion_kind: "imminent_death_terminal_care",
          clinical_estimate_days_to_death: 3,
          signs_of_imminent_death: ["mottling"],
          rationale_for_inpatient_setting: "x".repeat(110),
          home_environment_assessment_text: "y".repeat(60),
        },
      },
    });
    expect(res.statusCode).not.toBe(403);
    expect(service.attestGip).toHaveBeenCalledTimes(1);
    await server.close();
  });
});
