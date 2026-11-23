// M24 payer-readiness routes (program assignments + enrollment evidence): the full M1 chain — session, RBAC,
// provider-entity and patient ABAC, step-up, AI-actor refusal, idempotency key, body/param validation — in front
// of a recording write service. The service's own decisions are tested in m24-payer-readiness-write-service.test.ts.
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  M24_PERMISSION_KEY_LIST,
  buildM24AbacPredicates,
  denyStubM24AbacResolver,
  mountM24Routes,
} from "../src/modules/24-billing-medicaid/index";
import type { M24ReadService } from "../src/modules/24-billing-medicaid/routes/read-service";
import type { M24WriteService } from "../src/modules/24-billing-medicaid/routes/write-service";

const ORG = "org_a";
const MEMBERSHIP = "c1000000-0000-4000-8000-000000000001";
const PE = "c2000000-0000-4000-8000-000000000001";
const OTHER_PE = "c2000000-0000-4000-8000-000000000009";
const PATIENT = "c3000000-0000-4000-8000-000000000001";
const OTHER_PATIENT = "c3000000-0000-4000-8000-000000000009";
const PAYER = "c4000000-0000-4000-8000-000000000001";
const ROW = "c5000000-0000-4000-8000-000000000001";
const EVIDENCE_REF = "doc:synthetic-evidence-1";

function headerAuth(request: FastifyRequest): void {
  const header = (name: string): string | undefined => {
    const value = request.headers[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const user = header("x-test-user");
  if (!user) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = (header("x-test-roles") ?? "").split(",").filter(Boolean);
  request.context.providerEntityIds = (header("x-test-pe") ?? "").split(",").filter(Boolean);
  request.context.attributes.membershipId = MEMBERSHIP;
  request.context.attributes.stepUpRecent = header("x-test-step-up") !== "stale";
  const actorKind = header("x-test-actor-kind");
  if (actorKind) request.context.attributes.actorKind = actorKind;
}

const ADMIN = {
  "x-test-user": "admin_1",
  "x-test-roles": "billing_manager",
  "x-test-pe": PE,
  "idempotency-key": "k-1",
};

const recordAssignment = {
  patientId: PATIENT,
  patientPayerId: "c6000000-0000-4000-8000-000000000001",
  admissionId: "c7000000-0000-4000-8000-000000000001",
  providerEntityId: PE,
  serviceState: "OR",
  programKind: "ffs_open_card",
  canonicalPayerId: PAYER,
  effectiveFrom: "2026-01-01",
  effectiveTo: "2026-12-31",
  sourceKind: "payer_document",
  evidenceReference: EVIDENCE_REF,
};
const recordEvidence = {
  providerEntityId: PE,
  serviceState: "OR",
  canonicalPayerId: PAYER,
  evidenceKind: "mco_participation",
  effectiveFrom: "2026-01-01",
  effectiveTo: "2026-12-31",
};
const verifyAssignment = {
  expectedVersion: 1,
  verificationSource: "state_portal",
  evidenceReference: EVIDENCE_REF,
  providerEntityId: PE,
  patientId: PATIENT,
};
const verifyEvidence = {
  expectedVersion: 1,
  verificationSource: "payer_written_confirmation",
  evidenceReference: EVIDENCE_REF,
  providerEntityId: PE,
};
const revokeAssignment = {
  expectedVersion: 2,
  reasonCode: "other",
  providerEntityId: PE,
  patientId: PATIENT,
};
const revokeEvidence = { expectedVersion: 2, reasonCode: "other", providerEntityId: PE };

interface RouteCase {
  readonly label: string;
  readonly method: keyof Pick<
    M24WriteService,
    | "recordProgramAssignment"
    | "recordEnrollmentEvidence"
    | "verifyProgramAssignment"
    | "verifyEnrollmentEvidence"
    | "revokeProgramAssignment"
    | "revokeEnrollmentEvidence"
  >;
  readonly url: string;
  readonly payload: Record<string, unknown>;
  readonly status: number;
  readonly result: Record<string, unknown>;
  /** True when the route also gates on the patient caseload (the body names a patient). */
  readonly patientScoped: boolean;
  readonly hasId: boolean;
}

const ROUTES: readonly RouteCase[] = [
  {
    label: "POST /medicaid-program-assignments",
    method: "recordProgramAssignment",
    url: "/api/v1/medicaid-program-assignments",
    payload: recordAssignment,
    status: 201,
    result: { id: ROW, status: "pending" },
    patientScoped: true,
    hasId: false,
  },
  {
    label: "POST /medicaid-enrollment-evidence",
    method: "recordEnrollmentEvidence",
    url: "/api/v1/medicaid-enrollment-evidence",
    payload: recordEvidence,
    status: 201,
    result: { id: ROW, status: "pending" },
    patientScoped: false,
    hasId: false,
  },
  {
    label: "POST /medicaid-program-assignments/:id/verify",
    method: "verifyProgramAssignment",
    url: `/api/v1/medicaid-program-assignments/${ROW}/verify`,
    payload: verifyAssignment,
    status: 200,
    result: { status: "verified", version: 2 },
    patientScoped: true,
    hasId: true,
  },
  {
    label: "POST /medicaid-enrollment-evidence/:id/verify",
    method: "verifyEnrollmentEvidence",
    url: `/api/v1/medicaid-enrollment-evidence/${ROW}/verify`,
    payload: verifyEvidence,
    status: 200,
    result: { status: "verified", version: 2 },
    patientScoped: false,
    hasId: true,
  },
  {
    label: "POST /medicaid-program-assignments/:id/revoke",
    method: "revokeProgramAssignment",
    url: `/api/v1/medicaid-program-assignments/${ROW}/revoke`,
    payload: revokeAssignment,
    status: 200,
    result: { status: "revoked", version: 3 },
    patientScoped: true,
    hasId: true,
  },
  {
    label: "POST /medicaid-enrollment-evidence/:id/revoke",
    method: "revokeEnrollmentEvidence",
    url: `/api/v1/medicaid-enrollment-evidence/${ROW}/revoke`,
    payload: revokeEvidence,
    status: 200,
    result: { status: "revoked", version: 3 },
    patientScoped: false,
    hasId: true,
  },
];

function makeServer(): {
  app: ReturnType<typeof buildServer>;
  service: Record<string, ReturnType<typeof vi.fn>>;
} {
  const service: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const route of ROUTES) service[route.method] = vi.fn(async () => route.result);

  const grants = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "admin_1",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: [...M24_PERMISSION_KEY_LIST],
        },
      ],
    },
    {
      orgId: ORG,
      userId: "none_1",
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [] }],
    },
  ]);
  registerEffectivePermissionResolver(grants.store);

  const registry = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(
    buildM24AbacPredicates({ resolver: denyStubM24AbacResolver }),
  )) {
    registry.register(name, predicate);
  }
  registry.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  // M5's caseload predicate: only PATIENT is on this user's caseload.
  registry.register("caseload_or_scope", async (_context, target) => target.patientId === PATIENT);
  registerAbacRegistry(registry);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM24Routes(app, {
    readService: {} as unknown as M24ReadService,
    writeService: service as unknown as M24WriteService,
  });
  return { app, service };
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

describe.each(ROUTES)("$label", (route) => {
  const call = async (
    headers: Record<string, string> | null,
    payload: Record<string, unknown> = route.payload,
    url = route.url,
  ) => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "POST",
      url,
      ...(headers ? { headers } : {}),
      payload,
    });
    await app.close();
    return { res, calls: service[route.method]! };
  };

  it("runs the service once with the session actor, the path id and the validated body", async () => {
    const { res, calls } = await call(ADMIN);
    expect(res.statusCode).toBe(route.status);
    expect(res.json()).toEqual(route.result);
    expect(calls).toHaveBeenCalledTimes(1);
    const args = calls.mock.calls[0] as unknown[];
    expect(args[0]).toMatchObject({
      organizationId: ORG,
      userId: "admin_1",
      membershipId: MEMBERSHIP,
    });
    if (route.hasId) {
      expect(args[1]).toBe(ROW);
      expect(args[2]).toEqual(route.payload);
    } else {
      expect(args[1]).toEqual(route.payload);
    }
  });

  it("401s without a session", async () => {
    const { res, calls } = await call(null);
    expect(res.statusCode).toBe(401);
    expect(calls).not.toHaveBeenCalled();
  });

  it("403s a session without the trading-partner admin permission", async () => {
    const { res, calls } = await call({ ...ADMIN, "x-test-user": "none_1" });
    expect(res.statusCode).toBe(403);
    expect(calls).not.toHaveBeenCalled();
  });

  it("403s without a recent step-up, with the step-up code", async () => {
    const { res, calls } = await call({ ...ADMIN, "x-test-step-up": "stale" });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.json())).toContain("STEP_UP_REQUIRED");
    expect(calls).not.toHaveBeenCalled();
  });

  it("403s an AI principal", async () => {
    const { res, calls } = await call({ ...ADMIN, "x-test-actor-kind": "ai_agent" });
    expect(res.statusCode).toBe(403);
    expect(calls).not.toHaveBeenCalled();
  });

  it("403s a provider entity outside the actor's scope", async () => {
    const { res, calls } = await call({ ...ADMIN, "x-test-pe": OTHER_PE });
    expect(res.statusCode).toBe(403);
    expect(calls).not.toHaveBeenCalled();
  });

  it("403s an actor who is neither billing manager nor org admin", async () => {
    const { res, calls } = await call({ ...ADMIN, "x-test-roles": "clinician" });
    expect(res.statusCode).toBe(403);
    expect(calls).not.toHaveBeenCalled();
  });

  it("requires an Idempotency-Key", async () => {
    const { "idempotency-key": _omitted, ...withoutKey } = ADMIN;
    const { res, calls } = await call(withoutKey);
    expect(res.statusCode).toBe(400);
    expect(calls).not.toHaveBeenCalled();
  });

  it("422s an unknown body field", async () => {
    const { res, calls } = await call(ADMIN, { ...route.payload, organizationId: "org_b" });
    expect(res.statusCode).toBe(422);
    expect(calls).not.toHaveBeenCalled();
  });

  if (route.patientScoped) {
    it("404s a patient outside the actor's caseload", async () => {
      const { res, calls } = await call(ADMIN, { ...route.payload, patientId: OTHER_PATIENT });
      expect(res.statusCode).toBe(404);
      expect(calls).not.toHaveBeenCalled();
    });
  }

  if (route.hasId) {
    it("422s a path id that is not a uuid, before the service runs", async () => {
      const { res, calls } = await call(ADMIN, route.payload, route.url.replace(ROW, "not-a-uuid"));
      expect(res.statusCode).toBe(422);
      expect(calls).not.toHaveBeenCalled();
    });
  }

  if ("effectiveFrom" in route.payload) {
    it("422s an effectiveTo earlier than effectiveFrom, before the service runs", async () => {
      const { res, calls } = await call(ADMIN, {
        ...route.payload,
        effectiveFrom: "2026-06-01",
        effectiveTo: "2026-05-31",
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.stringify(res.json())).toContain("effectiveTo");
      expect(calls).not.toHaveBeenCalled();
    });

    it("accepts a one-day window and an open-ended one", async () => {
      const oneDay = await call(ADMIN, {
        ...route.payload,
        effectiveFrom: "2026-06-01",
        effectiveTo: "2026-06-01",
      });
      expect(oneDay.res.statusCode).toBe(route.status);
      const { effectiveTo: _open, ...openEnded } = route.payload;
      const open = await call(ADMIN, openEnded);
      expect(open.res.statusCode).toBe(route.status);
    });
  }
});
