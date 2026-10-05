// apps/backend/__tests__/m30-close-cosign.test.ts — GAP-088: the two-person closes of a QAPI PIP (R-31) and
// an SRA cycle (R-47) must take the FIRST signer from the authenticated session and validate the SECOND
// signer as a real, distinct, active, role-complementary person (M30 spec D12 line 3576; §4.7 lines
// 2106/2108; WF-08 line 2844 / WF-SRA line 2858; step-up per line 3804). Two layers are proven:
//   - the pure service-layer guard `resolveCloseCosigners` (what the Drizzle service runs inside its tx);
//   - the route layer: `requireAbac(qapiCloseAuthority | sraCloseAuthority)` over the body's co-signer, with
//     break-glass NOT able to substitute, over the REAL predicates + an in-memory resolver.
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  M30_PERMISSION_KEY_LIST,
  type ReadingM30AbacResolver,
  buildM30AbacPredicates,
  mountM30Routes,
} from "../src/modules/30-quality/index";
import { selectActiveMemberRoleKeys } from "../src/modules/30-quality/member-roles";
import {
  PIP_CLOSE_ROLES,
  SRA_CLOSE_ROLES,
  buildCloseAttestation,
  buildPipClosureColumns,
  buildSraClosureColumns,
  resolveCloseCosigners,
} from "../src/modules/30-quality/routes/close-cosign";
import type { M30WriteRouteService } from "../src/modules/30-quality/routes/write-service";

const ORG = "org_a";
const M_QC = "11111111-1111-4111-8111-111111111111";
const M_MD = "22222222-2222-4222-8222-222222222222";
const M_SO = "33333333-3333-4333-8333-333333333333";
const M_CO = "44444444-4444-4444-8444-444444444444";
const M_RANDOM = "55555555-5555-4555-8555-555555555555";
const M_GHOST = "66666666-6666-4666-8666-666666666666";
const PIP_ID = "77777777-7777-4777-8777-777777777777";
const CYCLE_ID = "88888888-8888-4888-8888-888888888888";

// ── persisted closure shape (GAP-088 follow-up: the row must not present the nominee as a signer) ─────────
describe("persisted close columns (nominee-based one-step close)", () => {
  const AT = new Date("2026-10-04T12:00:00.000Z");
  const pipSigners = (callerRole: string, nomineeRole: string, first: string, second: string) => ({
    first,
    second,
    callerRole,
    nomineeRole,
  });

  it("PIP, QAPI Coordinator closer: QC slot stamped, MD slot holds the nominee id with a NULL _at", () => {
    const cols = buildPipClosureColumns(
      pipSigners("qapi_coordinator", "medical_director", M_QC, M_MD),
      AT,
    );
    expect(cols).toEqual({
      cosignQapiCoordinatorMembershipId: M_QC,
      cosignQapiCoordinatorAt: AT,
      cosignMedicalDirectorMembershipId: M_MD,
      cosignMedicalDirectorAt: null,
      closureClosedByMembershipId: M_QC,
      closureNomineeMembershipId: M_MD,
      closureCosignAttested: false,
    });
  });

  it("PIP, Medical Director closer: MD slot stamped, QC slot is the un-attested nominee", () => {
    const cols = buildPipClosureColumns(
      pipSigners("medical_director", "qapi_coordinator", M_MD, M_QC),
      AT,
    );
    expect(cols.cosignMedicalDirectorAt).toEqual(AT);
    expect(cols.cosignQapiCoordinatorAt).toBeNull();
    expect(cols.cosignMedicalDirectorMembershipId).toBe(M_MD);
    expect(cols.cosignQapiCoordinatorMembershipId).toBe(M_QC);
    expect(cols.closureClosedByMembershipId).toBe(M_MD);
    expect(cols.closureNomineeMembershipId).toBe(M_QC);
    expect(cols.closureCosignAttested).toBe(false);
  });

  it("SRA, Security Officer closer: SO slot stamped, CO slot nominee-only", () => {
    const cols = buildSraClosureColumns(
      pipSigners("hipaa_security_officer", "compliance_officer", M_SO, M_CO),
      AT,
    );
    expect(cols).toEqual({
      cosignSecurityOfficerMembershipId: M_SO,
      cosignSecurityOfficerAt: AT,
      cosignComplianceOfficerMembershipId: M_CO,
      cosignComplianceOfficerAt: null,
      closureClosedByMembershipId: M_SO,
      closureNomineeMembershipId: M_CO,
      closureCosignAttested: false,
    });
  });

  it("SRA, Compliance Officer closer: CO slot stamped, SO slot nominee-only", () => {
    const cols = buildSraClosureColumns(
      pipSigners("compliance_officer", "hipaa_security_officer", M_CO, M_SO),
      AT,
    );
    expect(cols.cosignComplianceOfficerAt).toEqual(AT);
    expect(cols.cosignSecurityOfficerAt).toBeNull();
    expect(cols.closureClosedByMembershipId).toBe(M_CO);
    expect(cols.closureNomineeMembershipId).toBe(M_SO);
    expect(cols.closureCosignAttested).toBe(false);
  });
});

// ── pure service-layer guard ────────────────────────────────────────────────────────────────────────────
describe("resolveCloseCosigners (service-layer, GAP-088)", () => {
  const base = {
    actorMembershipId: M_QC,
    actorRoles: ["qapi_coordinator"],
    cosignerMembershipId: M_MD,
    cosignerRoleKeys: ["medical_director"] as readonly string[] | null,
    recentStepUp: true,
    roles: PIP_CLOSE_ROLES,
  };

  it("maps a QC caller + MD co-signer onto the two role slots", () => {
    const res = resolveCloseCosigners(base);
    expect(res).toEqual({
      first: M_QC,
      second: M_MD,
      callerRole: "qapi_coordinator",
      nomineeRole: "medical_director",
    });
  });

  it("records the closer as the only signer and the other party as an un-attested nominee", () => {
    const record = buildCloseAttestation(resolveCloseCosigners(base));
    expect(record).toEqual({
      closedBy: { membershipId: M_QC, role: "qapi_coordinator" },
      nominatedCosigner: { membershipId: M_MD, role: "medical_director" },
      cosignerAttested: false,
    });
    // nothing implies the nominee signed
    expect(JSON.stringify(record)).not.toMatch(/cosignedBy|signerMembershipId/i);
  });

  it("records an SRA Compliance Officer closer with the Security Officer as nominee", () => {
    const record = buildCloseAttestation(
      resolveCloseCosigners({
        ...base,
        actorMembershipId: M_CO,
        actorRoles: ["compliance_officer"],
        cosignerMembershipId: M_SO,
        cosignerRoleKeys: ["hipaa_security_officer"],
        roles: SRA_CLOSE_ROLES,
      }),
    );
    expect(record.closedBy).toEqual({ membershipId: M_CO, role: "compliance_officer" });
    expect(record.nominatedCosigner).toEqual({
      membershipId: M_SO,
      role: "hipaa_security_officer",
    });
    expect(record.cosignerAttested).toBe(false);
  });

  it("maps an MD caller + QC co-signer (either order is legal)", () => {
    const res = resolveCloseCosigners({
      ...base,
      actorMembershipId: M_MD,
      actorRoles: ["medical_director"],
      cosignerMembershipId: M_QC,
      cosignerRoleKeys: ["qapi_coordinator"],
    });
    expect(res.first).toBe(M_MD);
    expect(res.second).toBe(M_QC);
  });

  it("refuses a stale step-up", () => {
    expect(() => resolveCloseCosigners({ ...base, recentStepUp: false })).toThrow(
      /re-authentication/i,
    );
  });

  it("refuses a self co-sign", () => {
    expect(() =>
      resolveCloseCosigners({
        ...base,
        cosignerMembershipId: M_QC,
        cosignerRoleKeys: ["medical_director"],
      }),
    ).toThrow(/distinct/i);
  });

  it("refuses a co-signer who is not an active member of the org (null)", () => {
    expect(() => resolveCloseCosigners({ ...base, cosignerRoleKeys: null })).toThrow(/active/i);
  });

  it("refuses a co-signer without the complementary role", () => {
    expect(() =>
      resolveCloseCosigners({ ...base, cosignerRoleKeys: ["nurse", "qapi_coordinator"] }),
    ).toThrow(/complementary|role/i);
  });

  it("refuses a caller who holds neither close role", () => {
    expect(() => resolveCloseCosigners({ ...base, actorRoles: ["administrator"] })).toThrow(
      /QAPI Coordinator|Medical Director|role/i,
    );
  });

  it("refuses a caller with no membership id", () => {
    expect(() => resolveCloseCosigners({ ...base, actorMembershipId: "" })).toThrow();
  });

  it("applies to the SRA pair (SO + CO) and rejects a QC/MD pair there", () => {
    const ok = resolveCloseCosigners({
      ...base,
      actorMembershipId: M_SO,
      actorRoles: ["hipaa_security_officer"],
      cosignerMembershipId: M_CO,
      cosignerRoleKeys: ["compliance_officer"],
      roles: SRA_CLOSE_ROLES,
    });
    expect(ok.first).toBe(M_SO);
    expect(ok.second).toBe(M_CO);
    expect(() => resolveCloseCosigners({ ...base, roles: SRA_CLOSE_ROLES })).toThrow();
  });
});

// ── route layer ─────────────────────────────────────────────────────────────────────────────────────────
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string") request.context.attributes.membershipId = membership;
}

const MEMBER_ROLES: Record<string, readonly string[]> = {
  [M_QC]: ["qapi_coordinator"],
  [M_MD]: ["medical_director"],
  [M_SO]: ["hipaa_security_officer"],
  [M_CO]: ["compliance_officer"],
  [M_RANDOM]: ["nurse"],
  // M_GHOST: not an active member -> resolver returns [] (inactive/unknown)
};

function makeServer(opts: { stepUp: boolean }) {
  const closeQapiPip = vi.fn(async () => ({ id: PIP_ID }));
  const closeSraCycle = vi.fn(async () => ({ id: CYCLE_ID }));
  const writeService = { closeQapiPip, closeSraCycle } as unknown as M30WriteRouteService;
  const resolver = {
    async loadMemberRoleKeys(_c: unknown, membershipId: string) {
      return MEMBER_ROLES[membershipId] ?? [];
    },
  } as unknown as ReadingM30AbacResolver;

  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      ["u_qc", "u_md", "u_so", "u_co", "u_admin"].map((userId) => ({
        orgId: ORG,
        userId,
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: [...M30_PERMISSION_KEY_LIST],
          },
        ],
      })),
    ).store,
  );
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(buildM30AbacPredicates({ resolver }))) {
    reg.register(name, predicate);
  }
  reg.register("step_up_recent", async () => opts.stepUp);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM30Routes(app, {
    readService: {} as never,
    writeService,
  });
  return { app, closeQapiPip, closeSraCycle };
}

const QC = { "x-test-user": "u_qc", "x-test-roles": "qapi_coordinator", "x-test-membership": M_QC };
const MD = { "x-test-user": "u_md", "x-test-roles": "medical_director", "x-test-membership": M_MD };
const SO = {
  "x-test-user": "u_so",
  "x-test-roles": "hipaa_security_officer",
  "x-test-membership": M_SO,
};
const ADMIN = {
  "x-test-user": "u_admin",
  "x-test-roles": "administrator",
  "x-test-membership": M_RANDOM,
};
const IDEMP = (k: string) => ({ "idempotency-key": k });
const PIP_URL = `/api/v1/quality/qapi/pips/${PIP_ID}/close`;
const SRA_URL = `/api/v1/quality/sra/cycles/${CYCLE_ID}/close`;
const pipBody = (cosignerMembershipId: string) => ({
  conclusionText: "Conclusion narrative summarizing the outcome.",
  outcome: "Target achieved.",
  cosignerMembershipId,
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

describe("R-31 PIP close — GAP-088", () => {
  it("rejects the old body shape that named BOTH signers (fail-closed, service untouched)", async () => {
    const { app, closeQapiPip } = makeServer({ stepUp: true });
    const res = await app.inject({
      method: "POST",
      url: PIP_URL,
      headers: { ...ADMIN, ...IDEMP("p1") },
      payload: {
        conclusionText: "Conclusion narrative.",
        outcome: "ok",
        cosign: { qapiCoordinatorMembershipId: M_RANDOM, medicalDirectorMembershipId: M_GHOST },
      },
    });
    expect([403, 422]).toContain(res.statusCode); // ABAC fails closed before body validation
    expect(closeQapiPip).not.toHaveBeenCalled();
    await app.close();
  });

  it("403s a caller who is neither QAPI Coordinator nor Medical Director", async () => {
    const { app, closeQapiPip } = makeServer({ stepUp: true });
    const res = await app.inject({
      method: "POST",
      url: PIP_URL,
      headers: { ...ADMIN, ...IDEMP("p2") },
      payload: pipBody(M_MD),
    });
    expect(res.statusCode).toBe(403);
    expect(closeQapiPip).not.toHaveBeenCalled();
    await app.close();
  });

  it("403s a self co-sign", async () => {
    const { app, closeQapiPip } = makeServer({ stepUp: true });
    const res = await app.inject({
      method: "POST",
      url: PIP_URL,
      headers: { ...QC, ...IDEMP("p3") },
      payload: pipBody(M_QC),
    });
    expect(res.statusCode).toBe(403);
    expect(closeQapiPip).not.toHaveBeenCalled();
    await app.close();
  });

  it("403s a co-signer without the complementary role, and an unknown/inactive co-signer", async () => {
    const { app, closeQapiPip } = makeServer({ stepUp: true });
    for (const [i, id] of [M_RANDOM, M_GHOST, M_SO].entries()) {
      const res = await app.inject({
        method: "POST",
        url: PIP_URL,
        headers: { ...QC, ...IDEMP(`p4-${i}`) },
        payload: pipBody(id),
      });
      expect(res.statusCode).toBe(403);
    }
    expect(closeQapiPip).not.toHaveBeenCalled();
    await app.close();
  });

  it("403s when the session has no fresh step-up", async () => {
    const { app, closeQapiPip } = makeServer({ stepUp: false });
    const res = await app.inject({
      method: "POST",
      url: PIP_URL,
      headers: { ...QC, ...IDEMP("p5") },
      payload: pipBody(M_MD),
    });
    expect(res.statusCode).toBe(403);
    expect(closeQapiPip).not.toHaveBeenCalled();
    await app.close();
  });

  it("passes the session membership as caller and ONLY the co-signer id from the body", async () => {
    const { app, closeQapiPip } = makeServer({ stepUp: true });
    const res = await app.inject({
      method: "POST",
      url: PIP_URL,
      headers: { ...QC, ...IDEMP("p6") },
      payload: pipBody(M_MD),
    });
    expect(res.statusCode).toBe(200);
    expect(closeQapiPip).toHaveBeenCalledTimes(1);
    const [actor, pipId, args] = closeQapiPip.mock.calls[0] as unknown as [
      { membershipId: string },
      string,
      { cosignerMembershipId: string; cosign?: unknown },
    ];
    expect(actor.membershipId).toBe(M_QC);
    expect(pipId).toBe(PIP_ID);
    expect(args.cosignerMembershipId).toBe(M_MD);
    expect(args.cosign).toBeUndefined();
    await app.close();
  });

  it("also lets the Medical Director close with the QAPI Coordinator", async () => {
    const { app, closeQapiPip } = makeServer({ stepUp: true });
    const res = await app.inject({
      method: "POST",
      url: PIP_URL,
      headers: { ...MD, ...IDEMP("p7") },
      payload: pipBody(M_QC),
    });
    expect(res.statusCode).toBe(200);
    expect(closeQapiPip).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe("R-47 SRA close — GAP-088", () => {
  const sraBody = (cosignerMembershipId: string) => ({ cosignerMembershipId });

  it("rejects the old two-id body (fail-closed)", async () => {
    const { app, closeSraCycle } = makeServer({ stepUp: true });
    const res = await app.inject({
      method: "POST",
      url: SRA_URL,
      headers: { ...SO, ...IDEMP("s1") },
      payload: {
        cosign: { securityOfficerMembershipId: M_RANDOM, complianceOfficerMembershipId: M_GHOST },
      },
    });
    expect([403, 422]).toContain(res.statusCode);
    expect(closeSraCycle).not.toHaveBeenCalled();
    await app.close();
  });

  it("403s unrelated, wrong-role, self and non-SO/CO callers", async () => {
    const { app, closeSraCycle } = makeServer({ stepUp: true });
    const cases: Array<[Record<string, string>, string]> = [
      [SO, M_RANDOM],
      [SO, M_GHOST],
      [SO, M_SO],
      [SO, M_QC],
      [ADMIN, M_CO],
    ];
    for (const [i, [headers, id]] of cases.entries()) {
      const res = await app.inject({
        method: "POST",
        url: SRA_URL,
        headers: { ...headers, ...IDEMP(`s2-${i}`) },
        payload: sraBody(id),
      });
      expect(res.statusCode).toBe(403);
    }
    expect(closeSraCycle).not.toHaveBeenCalled();
    await app.close();
  });

  it("closes with the session caller + a real Compliance Officer co-signer", async () => {
    const { app, closeSraCycle } = makeServer({ stepUp: true });
    const res = await app.inject({
      method: "POST",
      url: SRA_URL,
      headers: { ...SO, ...IDEMP("s3") },
      payload: sraBody(M_CO),
    });
    expect(res.statusCode).toBe(200);
    const [actor, , args] = closeSraCycle.mock.calls[0] as unknown as [
      { membershipId: string },
      string,
      { cosignerMembershipId: string },
    ];
    expect(actor.membershipId).toBe(M_SO);
    expect(args.cosignerMembershipId).toBe(M_CO);
    await app.close();
  });

  it("403s without a fresh step-up", async () => {
    const { app, closeSraCycle } = makeServer({ stepUp: false });
    const res = await app.inject({
      method: "POST",
      url: SRA_URL,
      headers: { ...SO, ...IDEMP("s4") },
      payload: sraBody(M_CO),
    });
    expect(res.statusCode).toBe(403);
    expect(closeSraCycle).not.toHaveBeenCalled();
    await app.close();
  });
});

// ── selectActiveMemberRoleKeys: the live-role filters (fake tx, no DB) ─────────────────────────────────────
type RoleRow = {
  key: string;
  category: string;
  organizationId: string | null;
  enabled: boolean;
};

function fakeRoleTx(roleRows: readonly RoleRow[]) {
  let call = 0;
  return {
    select: () => {
      const isMembershipQuery = call++ === 0;
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      chain.where = () =>
        isMembershipQuery ? chain : Promise.resolve(roleRows.map((r) => ({ ...r })));
      chain.limit = async () => [{ status: "active" }];
      return chain;
    },
  } as never;
}

describe("selectActiveMemberRoleKeys honours enabled + roleConfersKey (same authority as request.context.roles)", () => {
  const platformMd: RoleRow = {
    key: "medical_director",
    category: "clinical_leadership",
    organizationId: null,
    enabled: true,
  };

  it("keeps an enabled platform role and an enabled non-reserved tenant role", async () => {
    const keys = await selectActiveMemberRoleKeys(
      fakeRoleTx([platformMd, { ...platformMd, key: "tenant_custom", organizationId: ORG }]),
      ORG,
      M_MD,
    );
    expect(keys).toEqual(["medical_director", "tenant_custom"]);
  });

  it("drops a DISABLED role", async () => {
    const keys = await selectActiveMemberRoleKeys(
      fakeRoleTx([{ ...platformMd, enabled: false }]),
      ORG,
      M_MD,
    );
    expect(keys).toEqual([]);
  });

  it("drops a tenant-owned role carrying a reserved platform key or category", async () => {
    const keys = await selectActiveMemberRoleKeys(
      fakeRoleTx([
        { ...platformMd, key: "platform_admin", organizationId: ORG },
        { ...platformMd, key: "ai_safety_owner", organizationId: ORG },
        { ...platformMd, key: "sneaky", category: "platform_staff", organizationId: ORG },
      ]),
      ORG,
      M_MD,
    );
    expect(keys).toEqual([]);
  });
});
