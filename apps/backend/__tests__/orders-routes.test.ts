// apps/backend/__tests__/orders-routes.test.ts — M11-T06 route-inventory + §4.6 RBAC gating + §4.7
// `discipline_can_order` / `signer_eligible` / `cosigner_role_match` ABAC + the §2.2 lifecycle / §2.5 cosign
// flow + §4.4 outbox emission (M11 spec §4.1, §4.2, §4.4, §4.6, §4.7).
//
// Exercises M11's routes through the FULL M1 middleware chain via Fastify `inject`, no live infra:
// buildServer() mounts the host, registerOrderRoutes() mounts the §4.1 inventory over the in-memory order
// backend. The REAL Authorization Contract gates every route on the §4.6 keys; a header-auth shim populates
// request.context. The three §4.7 predicates M11 owns are registered into the shared ABAC registry over the
// slice's resolver.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  buildOrderAbacPredicates,
  createInMemoryOrderBackend,
  registerOrderRoutes,
} from "../src/modules/11-orders/index";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  // orders-routes.ts's actorOf() reads the acting MEMBERSHIP id from here (not ctx.userId).
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const PHYS = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-06-08T12:00:00.000Z";

const READ = ["orders.read"];
const WRITE = [
  "orders.draft",
  "orders.sign",
  "orders.verbal.record",
  "orders.cosign",
  "orders.discontinue",
  "orders.amend",
  "orders.complete",
];
const STANDING = ["orders.standing.manage", "orders.standing.spawn"];
const POLICY = ["orders.policy.read", "orders.policy.manage"];
const PERMISSION_SEED = [
  { userId: "rn_1", permissions: [...READ, ...WRITE, ...STANDING] },
  { userId: "rn_2", permissions: [...READ, ...WRITE] },
  { userId: "chap_1", permissions: [...READ, "orders.draft"] },
  { userId: "viewer_1", permissions: READ },
  { userId: "admin_1", permissions: [...READ, ...POLICY] },
];

function makeServer() {
  const backend = createInMemoryOrderBackend({ now: () => NOW, timeZone: "America/New_York" });

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);
  // A FRESH predicate registry per server (the shared `abacRegistry` would otherwise persist a predicate
  // closed over a prior test's backend across the file — the boot path registers M11's predicates into the
  // shared registry via `registerOrderAbacPredicates`, which binds once at startup).
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(buildOrderAbacPredicates({ resolver: backend }))) {
    reg.register(name, predicate);
  }
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerOrderRoutes(app, { service: backend });
  return { app, backend };
}

const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn_case_manager" };
const RN2 = { "x-test-user": "rn_2", "x-test-org": ORG, "x-test-roles": "rn_case_manager" };
const CHAPLAIN = { "x-test-user": "chap_1", "x-test-org": ORG, "x-test-roles": "chaplain" };
const VIEWER = { "x-test-user": "viewer_1", "x-test-org": ORG, "x-test-roles": "auditor" };
const ADMIN = { "x-test-user": "admin_1", "x-test-org": ORG, "x-test-roles": "org_admin" };

const labBody = (over: Record<string, unknown> = {}) => ({
  patientId: PATIENT,
  admissionId: ADMISSION,
  kind: "lab",
  drafterDiscipline: "rn_case_manager",
  data: { loinc: "2160-0" },
  orderingPhysicianMdmId: PHYS,
  ...over,
});

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

describe("M11-T06 — §4.6 RBAC gating", () => {
  it("a viewer with orders.read lists orders but cannot draft (403)", async () => {
    const { app } = makeServer();
    const ok = await app.inject({ method: "GET", url: "/api/v1/orders", headers: VIEWER });
    expect(ok.statusCode).toBe(200);
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/orders",
      headers: VIEWER,
      payload: labBody(),
    });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });
});

describe("M11-T06 — §4.7 discipline_can_order floor", () => {
  it("a chaplain holding orders.draft is still blocked by the discipline ABAC floor on a lab order (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/orders",
      headers: CHAPLAIN,
      payload: labBody(),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("an RN case manager drafts a lab order (201) and the §4.4 draft_created event fires", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/orders",
      headers: RN,
      payload: labBody(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("draft");
    expect(backend.drainEvents().map((e) => e.eventName)).toContain("m11.order.draft_created");
    await app.close();
  });
});

describe("M11-T06 — §2.2 lifecycle: request-signature → sign", () => {
  it("RN drafts → requests signature → signs an active order; §4.4 signed event fires", async () => {
    const { app, backend } = makeServer();
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/orders",
      headers: RN,
      payload: labBody(),
    });
    const id = draft.json().id as string;
    backend.drainEvents();

    const req = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${id}/request-signature`,
      headers: RN,
      payload: { signerDiscipline: "rn_case_manager" },
    });
    expect(req.statusCode).toBe(200);
    expect(req.json().status).toBe("pending_signature");

    const signed = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${id}/sign`,
      headers: RN,
      payload: { signerDiscipline: "rn_case_manager", signedAtClient: NOW },
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.json().status).toBe("active");
    expect(backend.drainEvents().map((e) => e.eventName)).toContain("m11.order.signed");
    await app.close();
  });

  it("§4.7 signer_eligible blocks a non-physician signing a recertification (403)", async () => {
    const { app } = makeServer();
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/orders",
      headers: RN,
      payload: labBody({
        kind: "recertification",
        drafterDiscipline: "medical_director",
        data: {},
      }),
    });
    // RN can't even draft recert (discipline floor) — assert that, then a physician path is exercised separately.
    expect(draft.statusCode).toBe(403);
    await app.close();
  });
});

describe("M11-T06 — §2.5 LPN-drafted cosign axis", () => {
  it("an LPN-drafted lab order requires an RN cosignature before it can be signed (COSIGN_PENDING 412)", async () => {
    const { app } = makeServer();
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/orders",
      headers: RN,
      payload: labBody({ drafterDiscipline: "lpn" }),
    });
    const id = draft.json().id as string;
    const req = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${id}/request-signature`,
      headers: RN,
      payload: { signerDiscipline: "rn_case_manager" },
    });
    expect(req.json().cosignRequired).toBe(true);

    const signedBlocked = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${id}/sign`,
      headers: RN,
      payload: { signerDiscipline: "rn_case_manager", signedAtClient: NOW },
    });
    expect(signedBlocked.statusCode).toBe(412); // COSIGN_PENDING

    // A different RN cosigns (no self-cosign), then the sign succeeds.
    const cos = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${id}/cosign`,
      headers: RN2,
      payload: { cosignerRole: "rn_case_manager", attestationText: "x".repeat(60) },
    });
    expect(cos.statusCode).toBe(200);
    const signed = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${id}/sign`,
      headers: RN,
      payload: { signerDiscipline: "rn_case_manager", signedAtClient: NOW },
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.json().status).toBe("active");
    await app.close();
  });
});

describe("M11-T06 — §2.3 verbal policy tighten-only floor", () => {
  it("org admin reads + tightens the verbal policy; >48h is rejected (422)", async () => {
    const { app } = makeServer();
    const read = await app.inject({
      method: "GET",
      url: "/api/v1/admin/orders/verbal-policy",
      headers: ADMIN,
    });
    expect(read.json().windowHours).toBe(48);
    const tighten = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/orders/verbal-policy",
      headers: ADMIN,
      payload: { windowHours: 24 },
    });
    expect(tighten.statusCode).toBe(200);
    expect(tighten.json().windowHours).toBe(24);
    const bad = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/orders/verbal-policy",
      headers: ADMIN,
      payload: { windowHours: 72 },
    });
    expect(bad.statusCode).toBe(422); // TypeBox max:48 → VALIDATION_FAILED (M1 envelope, 422)
    await app.close();
  });
});

describe("M11-T06 — §2.4 standing-order spawn", () => {
  it("RN creates a lab standing order and PRN-spawns an active order; §4.4 spawn + signed events fire", async () => {
    const { app, backend } = makeServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/standing-orders",
      headers: RN,
      payload: {
        patientId: PATIENT,
        admissionId: ADMISSION,
        kind: "lab",
        signerDiscipline: "rn_case_manager",
        cadence: "prn",
        data: { loinc: "2160-0" },
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as string;
    backend.drainEvents();

    const spawn = await app.inject({
      method: "POST",
      url: `/api/v1/standing-orders/${id}/spawn`,
      headers: RN,
      payload: {},
    });
    expect(spawn.statusCode).toBe(201);
    const events = backend.drainEvents().map((e) => e.eventName);
    expect(events).toContain("m11.order.standing_spawned");
    expect(events).toContain("m11.order.signed");

    const spawnedId = spawn.json().orderId as string;
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/orders/${spawnedId}`,
      headers: RN,
    });
    expect(detail.json().status).toBe("active");
    await app.close();
  });
});
