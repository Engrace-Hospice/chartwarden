import {
  COMMERCIAL_ELIGIBILITY_ERROR,
  COMMERCIAL_SEND_REFUSAL,
  ChartWardenError,
  IdempotencyConflictError,
  NotFoundError,
  type PatientCoverage,
} from "@chartwarden/types";
import {
  CH,
  type ClearinghouseContext,
  type ClearinghouseEligibilityRequest,
  type ClearinghouseTransport,
  degraded,
} from "@chartwarden/x12-837-client";
import { describe, expect, it } from "vitest";
import { createEligibilityService } from "./service";
import type {
  EligibilityStore,
  NewEligibilityCheck,
  PlanRef,
  StoredEligibilityCheck,
} from "./store";

const ORG = "00000000-0000-4000-8000-000000000041";
const PE = "00000000-0000-4000-8000-0000000000e1";
const PATIENT = "00000000-0000-4000-8000-0000000000a1";
const PLAN = "00000000-0000-4000-8000-0000000000b1";
const PAYER = "00000000-0000-4000-8000-0000000000c1";
const COVERAGE = "00000000-0000-4000-8000-0000000000d1";
const USER = "00000000-0000-4000-8000-0000000000f1";
const MEMBER_ID = "SYNTH-MEMBER-8675309";
const NOW = new Date("2026-10-25T12:00:00.000Z");

const PLAN_REF: PlanRef = {
  id: PLAN,
  payerId: PAYER,
  eligibilityStalenessPolicy: "warn",
  eligibilityMaxAgeDays: 30,
};

class FakeStore implements EligibilityStore {
  checks: StoredEligibilityCheck[] = [];
  plan: PlanRef | null = PLAN_REF;
  routes = [{ clearinghousePayerId: "CH-PAYER-9", effectiveFrom: "2026-01-01", effectiveTo: null }];
  enrollments = [{ status: "enrolled" as const, effectiveFrom: "2026-01-01", effectiveTo: null }];
  async loadPlan() {
    return this.plan;
  }
  async routesFor() {
    return this.routes;
  }
  async enrollmentsFor() {
    return this.enrollments;
  }
  async findCheckByIdempotencyKey(_s: unknown, pe: string, key: string) {
    return this.checks.find((c) => c.providerEntityId === pe && c.idempotencyKey === key) ?? null;
  }
  async insertCheck(scope: { organizationId: string }, row: NewEligibilityCheck) {
    const stored: StoredEligibilityCheck = {
      ...row,
      organizationId: scope.organizationId,
      id: `chk-${this.checks.length + 1}`,
      checkedAt: NOW.toISOString(),
    };
    this.checks = [...this.checks, stored];
    return { row: stored, replayed: false };
  }
  async listChecks() {
    return [...this.checks].reverse();
  }
  async setPlanEligibilityPolicy(_s: unknown, _id: string, policy: "warn" | "block", maxAge: number) {
    this.plan = this.plan ? { ...this.plan, eligibilityStalenessPolicy: policy, eligibilityMaxAgeDays: maxAge } : null;
    return this.plan;
  }
  async listEnrollments() {
    return [];
  }
  async createEnrollment(): Promise<never> {
    throw new Error("unused");
  }
  async patchEnrollment(): Promise<never> {
    throw new Error("unused");
  }
}

function coverage(over: Partial<PatientCoverage> = {}): PatientCoverage {
  return {
    id: COVERAGE,
    patientId: PATIENT,
    payerId: PAYER,
    rank: 1,
    coverageKind: "commercial",
    subscriberId: MEMBER_ID,
    groupNumber: null,
    current: true,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    ...over,
  } as PatientCoverage;
}

interface Harness {
  readonly store: FakeStore;
  readonly calls: { ctx: ClearinghouseContext; req: ClearinghouseEligibilityRequest }[];
  readonly logs: unknown[];
  readonly service: ReturnType<typeof createEligibilityService>;
}

function harness(
  opts: {
    vendor?: string | null;
    coverages?: PatientCoverage[];
    transportResult?: Awaited<ReturnType<ClearinghouseTransport["checkEligibility"]>>;
    transportThrows?: Error;
    npi?: string | null;
  } = {},
): Harness {
  const store = new FakeStore();
  const calls: Harness["calls"] = [];
  const logs: unknown[] = [];
  const transport = {
    vendor: "in_memory",
    async checkEligibility(ctx: ClearinghouseContext, req: ClearinghouseEligibilityRequest) {
      calls.push({ ctx, req });
      if (opts.transportThrows) throw opts.transportThrows;
      return opts.transportResult ?? { ok: true as const, data: { outcome: "active" as const, asOfDate: "2026-10-25" } };
    },
  } as unknown as ClearinghouseTransport;
  const service = createEligibilityService({
    store,
    coverage: { coveragesForPatient: async () => opts.coverages ?? [coverage()] },
    binding: { vendor: opts.vendor === undefined ? "in_memory" : opts.vendor, transport },
    contexts: {
      contextFor: async (organizationId, providerEntityId, payerId) =>
        opts.npi === null
          ? null
          : {
              organizationId,
              providerEntityId,
              payerId,
              correlationId: "00000000-0000-4000-8000-0000000000aa",
              usage: "test",
              billingNpi: "1234567893",
            },
    },
    now: () => NOW,
    newRequestId: () => "00000000-0000-4000-8000-0000000000aa",
    log: (event) => logs.push(event),
  });
  return { store, calls, logs, service };
}

const ACTOR = { organizationId: ORG, userId: USER };
const ARGS = {
  providerEntityId: PE,
  patientId: PATIENT,
  planId: PLAN,
  serviceDate: "2026-10-25",
  idempotencyKey: "idem-1",
};

async function refusal(p: Promise<unknown>): Promise<ChartWardenError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ChartWardenError);
    return e as ChartWardenError;
  }
  throw new Error("expected a refusal");
}

describe("EligibilityService.check", () => {
  it("asks the bound clearinghouse with the routed payer id and the transient member id, then stores outcome and as-of date only", async () => {
    const h = harness();
    const view = await h.service.check(ACTOR, ARGS);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.ctx.payerId).toBe("CH-PAYER-9");
    expect(h.calls[0]?.req).toEqual({ memberId: MEMBER_ID, serviceDate: "2026-10-25" });
    expect(view).toMatchObject({ outcome: "active", asOfDate: "2026-10-25", replayed: false, clearinghouseKey: "in_memory" });
    expect(view.freshness.severity).toBe("pass");
    expect(h.store.checks).toHaveLength(1);
    expect(h.store.checks[0]).toMatchObject({ patientPayerId: COVERAGE, clearinghousePayerId: "CH-PAYER-9", checkedByUserId: USER });
    expect(JSON.stringify([view, h.store.checks, h.logs])).not.toContain(MEMBER_ID);
  });

  it("answers CH_NOT_WIRED and sends nothing when no clearinghouse is bound", async () => {
    const h = harness({ vendor: null });
    const e = await refusal(h.service.check(ACTOR, ARGS));
    expect(e.code).toBe(COMMERCIAL_SEND_REFUSAL.NOT_WIRED);
    expect(e.statusCode).toBe(503);
    expect(h.calls).toHaveLength(0);
    expect(h.store.checks).toHaveLength(0);
  });

  it("refuses a payer the active clearinghouse does not route, and sends nothing", async () => {
    const h = harness();
    h.store.routes = [];
    const e = await refusal(h.service.check(ACTOR, ARGS));
    expect(e.code).toBe(COMMERCIAL_SEND_REFUSAL.PAYER_NOT_ROUTED);
    expect(e.statusCode).toBe(409);
    expect(h.calls).toHaveLength(0);
    expect(h.store.checks).toHaveLength(0);
  });

  it("refuses an unenrolled provider entity, and sends nothing", async () => {
    const h = harness();
    h.store.enrollments = [{ status: "pending" as never, effectiveFrom: "2026-01-01", effectiveTo: null }];
    const e = await refusal(h.service.check(ACTOR, ARGS));
    expect(e.code).toBe(COMMERCIAL_SEND_REFUSAL.PROVIDER_NOT_ENROLLED);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses when the patient has no coverage naming the plan's payer in force on the service date", async () => {
    for (const coverages of [
      [],
      [coverage({ payerId: "00000000-0000-4000-8000-0000000000c2" })],
      [coverage({ effectiveFrom: "2026-11-01" })],
      [coverage({ effectiveTo: "2026-10-01" })],
      [coverage({ subscriberId: "   " })],
    ]) {
      const h = harness({ coverages });
      const e = await refusal(h.service.check(ACTOR, ARGS));
      expect(e.code).toBe(COMMERCIAL_ELIGIBILITY_ERROR.COVERAGE_NOT_FOUND);
      expect(h.calls).toHaveLength(0);
    }
  });

  it("picks the highest-ranked matching coverage", async () => {
    const h = harness({
      coverages: [
        coverage({ id: "00000000-0000-4000-8000-0000000000d2", rank: 2, subscriberId: "SECOND-MEMBER" }),
        coverage({ rank: 1 }),
      ],
    });
    await h.service.check(ACTOR, ARGS);
    expect(h.calls[0]?.req).toMatchObject({ memberId: MEMBER_ID });
    expect(h.store.checks[0]?.patientPayerId).toBe(COVERAGE);
  });

  it("answers 404 for an unknown plan", async () => {
    const h = harness();
    h.store.plan = null;
    const e = await refusal(h.service.check(ACTOR, ARGS));
    expect(e).toBeInstanceOf(NotFoundError);
  });

  it("refuses when the provider entity has no NPI on file, and sends nothing", async () => {
    const h = harness({ npi: null });
    const e = await refusal(h.service.check(ACTOR, ARGS));
    expect(e.code).toBe("COMMERCIAL_PROVIDER_NPI_MISSING");
    expect(h.calls).toHaveLength(0);
  });

  it("sends and stores the same request id so a vendor log joins to our audit trail", async () => {
    const h = harness();
    await h.service.check(ACTOR, ARGS);
    expect(h.calls[0]?.ctx.correlationId).toBe(h.store.checks[0]?.requestId);
  });

  it("latest with a service date ignores checks made for another date of service", async () => {
    const h = harness();
    await h.service.check(ACTOR, ARGS);
    const same = await h.service.latest(ACTOR, { providerEntityId: PE, patientId: PATIENT, planId: PLAN, serviceDate: "2026-10-25" });
    expect(same.freshness.severity).toBe("pass");
    const other = await h.service.latest(ACTOR, { providerEntityId: PE, patientId: PATIENT, planId: PLAN, serviceDate: "2026-11-30" });
    expect(other.latest).toBeNull();
    expect(other.freshness.status).toBe("missing");
  });

  it("a concurrent request that lost the insert race for a different request is a conflict, not a replay", async () => {
    const h = harness();
    const winner = { patientId: "00000000-0000-4000-8000-0000000000a2" };
    h.store.insertCheck = async (scope, row) => ({
      row: { ...row, ...winner, organizationId: scope.organizationId, id: "chk-x", checkedAt: NOW.toISOString() },
      replayed: true,
    });
    await expect(h.service.check(ACTOR, ARGS)).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("replays the stored answer for the same idempotency key without a second send", async () => {
    const h = harness();
    const first = await h.service.check(ACTOR, ARGS);
    const second = await h.service.check(ACTOR, ARGS);
    expect(h.calls).toHaveLength(1);
    expect(second).toMatchObject({ id: first.id, replayed: true, outcome: "active" });
    expect(h.store.checks).toHaveLength(1);
  });

  it("refuses the same idempotency key reused for a different request", async () => {
    const h = harness();
    await h.service.check(ACTOR, ARGS);
    const other = h.service.check(ACTOR, { ...ARGS, serviceDate: "2026-10-24" });
    await expect(other).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(h.calls).toHaveLength(1);
  });

  it.each([
    [CH.UNAVAILABLE, 503, COMMERCIAL_ELIGIBILITY_ERROR.CLEARINGHOUSE_UNAVAILABLE],
    [CH.NOT_WIRED, 503, COMMERCIAL_SEND_REFUSAL.NOT_WIRED],
    [CH.NOT_PROVISIONED, 503, COMMERCIAL_ELIGIBILITY_ERROR.CLEARINGHOUSE_UNAVAILABLE],
    [CH.NOT_ENROLLED, 409, COMMERCIAL_SEND_REFUSAL.PROVIDER_NOT_ENROLLED],
    [CH.INVALID_REQUEST, 422, COMMERCIAL_ELIGIBILITY_ERROR.CLEARINGHOUSE_REJECTED],
  ])("maps the transport code %s to %i %s, stores nothing, and never echoes the member id", async (code, status, mapped) => {
    const h = harness({ transportResult: degraded(code, `vendor said no about ${MEMBER_ID}`) });
    const e = await refusal(h.service.check(ACTOR, ARGS));
    expect(e.code).toBe(mapped);
    expect(e.statusCode).toBe(status);
    expect(e.message).not.toContain(MEMBER_ID);
    expect(JSON.stringify(h.logs)).not.toContain(MEMBER_ID);
    expect(h.store.checks).toHaveLength(0);
  });

  it("a transport that throws becomes a 503 whose message and logs never contain the member id", async () => {
    const h = harness({ transportThrows: new Error(`socket reset while sending ${MEMBER_ID}`) });
    const e = await refusal(h.service.check(ACTOR, ARGS));
    expect(e.code).toBe(COMMERCIAL_ELIGIBILITY_ERROR.CLEARINGHOUSE_UNAVAILABLE);
    expect(e.message).not.toContain(MEMBER_ID);
    expect(JSON.stringify([e, h.logs])).not.toContain(MEMBER_ID);
    expect(h.store.checks).toHaveLength(0);
  });

  it("an answer outside active/inactive/unknown or a bad as-of date is unavailable, never stored", async () => {
    for (const data of [
      { outcome: "maybe", asOfDate: "2026-10-25" },
      { outcome: "active", asOfDate: "10/25/2026" },
    ]) {
      const h = harness({ transportResult: { ok: true, data } as never });
      const e = await refusal(h.service.check(ACTOR, ARGS));
      expect(e.code).toBe(COMMERCIAL_ELIGIBILITY_ERROR.CLEARINGHOUSE_UNAVAILABLE);
      expect(h.store.checks).toHaveLength(0);
    }
  });

  it("rejects a malformed service date before any lookup", async () => {
    const h = harness();
    const e = await refusal(h.service.check(ACTOR, { ...ARGS, serviceDate: "10/25/2026" }));
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(h.calls).toHaveLength(0);
  });
});

describe("EligibilityService.latest", () => {
  it("reports missing under the plan policy when the patient was never checked", async () => {
    const h = harness();
    const r = await h.service.latest(ACTOR, { providerEntityId: PE, patientId: PATIENT, planId: PLAN });
    expect(r.latest).toBeNull();
    expect(r.freshness).toMatchObject({ status: "missing", severity: "warning" });
  });

  it("reports the policy 'block' for a plan that opted in", async () => {
    const h = harness();
    h.store.plan = { ...PLAN_REF, eligibilityStalenessPolicy: "block" };
    const r = await h.service.latest(ACTOR, { providerEntityId: PE, patientId: PATIENT, planId: PLAN });
    expect(r.freshness.severity).toBe("block");
  });

  it("reports fresh after a check", async () => {
    const h = harness();
    await h.service.check(ACTOR, ARGS);
    const r = await h.service.latest(ACTOR, { providerEntityId: PE, patientId: PATIENT, planId: PLAN });
    expect(r.latest?.outcome).toBe("active");
    expect(r.freshness.severity).toBe("pass");
  });
});
