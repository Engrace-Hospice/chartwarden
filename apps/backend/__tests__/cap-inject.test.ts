// apps/backend/__tests__/cap-inject.test.ts — M26-T0x (§4.1) HTTP-layer smoke suite (TASK-050A / TEST-001).
//
// Module 26 (Cap Management) shipped ZERO Fastify `.inject()` coverage before this file: the three
// `apps/backend/src/modules/26-cap/__tests__/*.test.ts` suites exercise pure logic (the state machine,
// jobs/consumers, request-typebox validation in isolation), and the only top-level suite that touches this
// module — `apps/backend/__tests__/m26-cost-report-cap-seam.live.test.ts` — is a real-Postgres live-RLS
// suite scoped narrowly to the M27 `CapAccrualReader` seam. None of them drives a request through Fastify
// `.inject()`, so the module's 27 route defs across cap.routes.ts / psr.routes.ts / settlement.routes.ts /
// platform.routes.ts had no coverage of a mis-wired guard, a permission key that does not match the §4.6
// catalog, an ABAC predicate name that does not resolve, or a TypeBox schema drifted from the body it
// guards. This file closes that gap the same way `oncall-inject.test.ts` / `discipline-plans-inject.test.ts`
// did: `buildServer()` mounts the M1 host, `mountM26Routes()` mounts the four §4.1 plugins, the REAL
// Authorization Contract gates every route on the real §4.6 permission keys, and the REAL
// `buildM26AbacPredicates` resolves the five §4.7 predicates M26 owns.
//
// M26 ships no `createInMemory*Backend` for the ROUTE surface — `createInMemoryCapRedactStore` and
// `createInMemoryCapConsumerStore` (exported from the module barrel) cover the §3.7 eraser and the §4.4
// upstream-event consumer respectively, neither of which backs `M26ReadService`/`M26WriteService`. So, as
// with M19/M15, the SERVICE half here is a small hand-rolled backend built directly against the real,
// exported `M26ReadService`/`M26WriteService` contracts (`../src/modules/26-cap/routes/index`) so the
// compiler still catches an interface drift; the harness half (header-auth shim, permission/ABAC registry
// wiring, beforeEach/afterEach reset) clones the `orders-routes.test.ts` / `oncall-inject.test.ts` precedent
// exactly.
//
// TWO GENUINE FINDINGS surfaced while grounding this file in the real route/schema source (left as-is per
// the "don't modify any file but this one" constraint — flagged here and in the task report instead):
//
//  1. `m26-typebox.ts` registers NO TypeBox string formats of its own (unlike ~15 sibling *-typebox.ts
//     files — e.g. 09-assessments, 17-scheduling, 20-field-safety, 24-billing-medicaid — which each
//     idempotently `FormatRegistry.Set("uuid", …)` / `FormatRegistry.Set("date", …)`). TypeBox's `Value`
//     checker treats an UNREGISTERED format as a hard failure regardless of the value's content (verified
//     directly: `Value.Check(Type.String({format:"date"}), "2026-08-01")` → `false`, "Unknown format
//     'date'") — not a no-op. In the real composition root this is masked because SOME sibling module's
//     typebox file is always loaded first as part of the full module graph and registers both formats as a
//     side effect (the exact "uuid only validates because M21 imports first" dynamic `m26-typebox.ts`'s own
//     header already documents for `format:"uuid"` — the same gap exists for `format:"date"`, undocumented).
//     This test file mounts ONLY M26's routes, so nothing else registers them; the two formats are
//     registered below, mirroring the sibling-module precedent, so `PsrImportRequest.psrPeriodFrom` /
//     `.psrPeriodTo` (format:"date") validate on content instead of always failing.
//
//  2. `m26-typebox.ts`'s own header comment claims `stepUpAssertionId` is "OMITTED from the two contracts
//     that declare it" (`LockMethodologyRequest`, `FinalizeSettlementRequest`) via `Type.Omit(...)`. A
//     THIRD contract also declares it — `contracts.ReopenCapPeriodRequest` (`{ reason, stepUpAssertionId:
//     Uuid }`, packages/cap-management/src/contracts.ts) — but `m26-typebox.ts`'s runtime
//     `ReopenCapPeriodRequest` (line 103) is `strict(contracts.ReopenCapPeriodRequest.properties)` with NO
//     `Type.Omit`, so the omission was missed for this one route. The result: `PATCH
//     /api/v1/cap/periods/:periodId/reopen` REQUIRES a client-supplied `stepUpAssertionId` (format:"uuid")
//     in the body even though `ReopenInput` (write-service.ts) is `{ reason: string }` and no server code
//     ever reads that field — exactly the "caller asserts its own re-authentication" pattern the header
//     explains WAS removed from the other two routes. The 2xx case for reopen below supplies a syntactically
//     valid UUID to reach the route's real behavior (the field is validated-then-discarded); it is not
//     fabricating a pass — the request genuinely satisfies today's contract. It just should not have to.
import { randomUUID } from "node:crypto";
import { FormatRegistry } from "@sinclair/typebox";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { NotFoundError } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type ReadingM26AbacResolver,
  buildM26AbacPredicates,
} from "../src/modules/26-cap/abac-predicates";
import { M26_PERMISSION_KEY_LIST } from "../src/modules/26-cap/permission-keys";
import { mountM26Routes } from "../src/modules/26-cap/routes/mount";
import type { M26ReadService } from "../src/modules/26-cap/routes/read-service";
// `routes/index.ts` (the module's public barrel) re-exports only `M26ReadService`/`M26WriteService`
// themselves — not the view types their methods traffic in — so those come from the concrete
// read-service.ts/write-service.ts files directly (the same files M26ReadService/M26WriteService are
// declared in), still the real, exported, compiler-checked contract.
import type {
  AccrualLineView,
  DashboardView,
  InpatientAccrualView,
  PatientAccrualView,
  PeriodView,
  PlatformConstantView,
  ProjectionView,
  PsrImportView,
  PsrVarianceView,
  SettlementView,
  ThresholdEventView,
} from "../src/modules/26-cap/routes/read-service";
import type { M26WriteService } from "../src/modules/26-cap/routes/write-service";

// ── FINDING 1 — see the file header. Mirrors the sibling *-typebox.ts precedent exactly. ───────────────
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set(
    "uuid",
    (v) =>
      typeof v === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  );
}
if (!FormatRegistry.Has("date")) {
  FormatRegistry.Set("date", (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
}

// ── fixed test ids ───────────────────────────────────────────────────────────────────────────────────
const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-01T12:00:00.000Z";

// ── in-memory row shapes (supersets of the published view types; the extra `organizationId` bookkeeping
//    field is fine — these routes never declare a Fastify response schema, so nothing strips it) ─────────
interface PeriodRow extends PeriodView {
  readonly organizationId: string;
}
interface ProjectionRow extends ProjectionView {
  readonly organizationId: string;
}
interface ThresholdEventRow extends ThresholdEventView {
  readonly organizationId: string;
}
interface PsrImportRow extends PsrImportView {
  readonly organizationId: string;
}
interface PsrVarianceRow extends PsrVarianceView {
  readonly organizationId: string;
  readonly importId: string;
}
interface SettlementRow extends SettlementView {
  readonly organizationId: string;
}
interface PatientAccrualRow extends PatientAccrualView {
  readonly organizationId: string;
}
interface InpatientAccrualRow extends InpatientAccrualView {
  readonly organizationId: string;
}

/** Build the in-memory `M26ReadService`/`M26WriteService`/ABAC-resolver triple this file exercises over HTTP. */
function createCapTestBackend() {
  const periods = new Map<string, PeriodRow>();
  const projections = new Map<string, ProjectionRow>(); // keyed "<periodId>:<slot>"
  const thresholdEvents = new Map<string, ThresholdEventRow>();
  const psrImports = new Map<string, PsrImportRow>();
  const psrVariances = new Map<string, PsrVarianceRow>();
  const settlements = new Map<string, SettlementRow>(); // keyed by periodId (one settlement per period)
  const platformConstants = new Map<string, PlatformConstantView>(); // keyed by capYear
  const patientAccruals = new Map<string, PatientAccrualRow>(); // keyed "<periodId>:<patientId>"
  const accrualLines = new Map<string, AccrualLineView[]>(); // keyed "<periodId>:<patientId>"
  const inpatientAccruals = new Map<string, InpatientAccrualRow>(); // keyed periodId

  function requirePeriod(orgId: string, periodId: string): PeriodRow {
    const row = periods.get(periodId);
    if (!row || row.organizationId !== orgId) throw new NotFoundError("cap_period", periodId);
    return row;
  }
  function requireEvent(orgId: string, eventId: string): ThresholdEventRow {
    const row = thresholdEvents.get(eventId);
    if (!row || row.organizationId !== orgId)
      throw new NotFoundError("cap_threshold_event", eventId);
    return row;
  }
  function requireVariance(orgId: string, lineId: string): PsrVarianceRow {
    const row = psrVariances.get(lineId);
    if (!row || row.organizationId !== orgId)
      throw new NotFoundError("cap_psr_reconciliation", lineId);
    return row;
  }
  function requireSettlement(orgId: string, periodId: string): SettlementRow {
    const row = settlements.get(periodId);
    if (!row || row.organizationId !== orgId) throw new NotFoundError("cap_settlement", periodId);
    return row;
  }
  function requireConstant(capYear: string): PlatformConstantView {
    const row = platformConstants.get(capYear);
    if (!row) throw new NotFoundError("cap_period_platform_constant", capYear);
    return row;
  }

  /** Open a period seeds a threshold event + a patient/inpatient accrual — in production these arrive via
   *  the §4.4 upstream-event consumers (M25/M23/M5/M6), which this HTTP-boundary smoke test does not
   *  re-implement; seeding them here keeps the pure-GET accrual/threshold routes reachable without a
   *  parallel write surface this module does not itself expose. */
  function seedFixturesFor(orgId: string, periodId: string): void {
    const eventId = randomUUID();
    thresholdEvents.set(eventId, {
      organizationId: orgId,
      id: eventId,
      capPeriodId: periodId,
      scope: "agency_aggregate",
      patientId: null,
      priorBand: "green",
      currentBand: "yellow",
      raisedAt: NOW,
      acknowledgedAt: null,
      resolvedAt: null,
    });
    const key = `${periodId}:${PATIENT}`;
    patientAccruals.set(key, {
      organizationId: orgId,
      patientId: PATIENT,
      capPeriodId: periodId,
      paidCents: 90_000,
      outstandingBilledCents: 5_000,
      firstElectionInPeriod: "2025-10-05",
      lastPaidThrough: "2026-07-01",
    });
    accrualLines.set(key, [
      {
        id: randomUUID(),
        sourceKind: "claim_line",
        sourceId: randomUUID(),
        amountCents: 5_000,
        serviceFrom: "2026-07-01",
        serviceTo: "2026-07-01",
        postedAt: NOW,
      },
    ]);
    inpatientAccruals.set(periodId, {
      organizationId: orgId,
      capPeriodId: periodId,
      gipDays: 2,
      ircDays: 1,
      totalPatientDays: 3,
      inpatientPct: 0.05,
    });
  }

  const readService: M26ReadService = {
    async listPeriods(actor) {
      return [...periods.values()].filter((r) => r.organizationId === actor.organizationId);
    },
    async getPeriod(actor, periodId) {
      const row = periods.get(periodId);
      return row && row.organizationId === actor.organizationId ? row : null;
    },
    async listProjections(actor, periodId) {
      return [...projections.values()].filter(
        (p) => p.organizationId === actor.organizationId && p.capPeriodId === periodId,
      );
    },
    async getAgencyProjection(actor, periodId) {
      const row = projections.get(`${periodId}:agency`);
      return row && row.organizationId === actor.organizationId ? row : null;
    },
    async getPatientProjection(actor, periodId, patientId) {
      const row = projections.get(`${periodId}:patient:${patientId}`);
      return row && row.organizationId === actor.organizationId ? row : null;
    },
    async getInpatientProjection(actor, periodId) {
      const row = projections.get(`${periodId}:inpatient`);
      return row && row.organizationId === actor.organizationId ? row : null;
    },
    async getPatientAccrual(actor, periodId, patientId) {
      const row = patientAccruals.get(`${periodId}:${patientId}`);
      return row && row.organizationId === actor.organizationId ? row : null;
    },
    async listAccrualLines(actor, periodId, patientId) {
      void actor;
      const items = accrualLines.get(`${periodId}:${patientId}`) ?? [];
      return { items, nextCursor: null };
    },
    async getInpatientAccrual(actor, periodId) {
      const row = inpatientAccruals.get(periodId);
      return row && row.organizationId === actor.organizationId ? row : null;
    },
    async listThresholdEvents(actor, filters) {
      return [...thresholdEvents.values()].filter((e) => {
        if (e.organizationId !== actor.organizationId) return false;
        if (filters.capPeriodId && e.capPeriodId !== filters.capPeriodId) return false;
        if (filters.unacknowledgedOnly && e.acknowledgedAt) return false;
        return true;
      });
    },
    async getPsrImport(actor, importId) {
      const row = psrImports.get(importId);
      return row && row.organizationId === actor.organizationId ? row : null;
    },
    async listPsrReconciliation(actor, importId) {
      return [...psrVariances.values()].filter(
        (v) => v.organizationId === actor.organizationId && v.importId === importId,
      );
    },
    async getSettlement(actor, periodId) {
      const row = settlements.get(periodId);
      return row && row.organizationId === actor.organizationId ? row : null;
    },
    async getDashboard(actor) {
      const period =
        [...periods.values()].find((r) => r.organizationId === actor.organizationId) ?? null;
      const agency = period ? (projections.get(`${period.id}:agency`) ?? null) : null;
      const inpatient = period ? (projections.get(`${period.id}:inpatient`) ?? null) : null;
      const recentEvents = [...thresholdEvents.values()].filter(
        (e) => e.organizationId === actor.organizationId,
      );
      const view: DashboardView = {
        period,
        agency,
        inpatient,
        topPatients: [],
        recentEvents,
        openVarianceCount: [...psrVariances.values()].filter(
          (v) => v.organizationId === actor.organizationId && v.status === "open",
        ).length,
      };
      return view;
    },
    async listPlatformConstants() {
      return [...platformConstants.values()];
    },
  };

  const writeService: M26WriteService = {
    async openPeriod(actor, input) {
      const id = randomUUID();
      const row: PeriodRow = {
        organizationId: actor.organizationId,
        id,
        capYear: input.capYear,
        ccn: "010001",
        startDate: "2025-10-01",
        endDate: "2026-09-30",
        status: "open",
        methodology: input.methodology ?? null,
        methodologyLockedAt: null,
        graceWindowDays: input.graceWindowDays ?? 30,
        aggregateCapAmountCents: 500_000_000,
        inpatientCapPct: 0.2,
        openedAt: NOW,
      };
      periods.set(id, row);
      seedFixturesFor(actor.organizationId, id);
      return row;
    },
    async lockMethodology(actor, periodId, input) {
      const row = requirePeriod(actor.organizationId, periodId);
      const updated: PeriodRow = {
        ...row,
        methodology: input.methodology,
        methodologyLockedAt: NOW,
      };
      periods.set(periodId, updated);
      return updated;
    },
    async closePeriod(actor, periodId) {
      const row = requirePeriod(actor.organizationId, periodId);
      const updated: PeriodRow = { ...row, status: "in_settlement" };
      periods.set(periodId, updated);
      return updated;
    },
    async reopenPeriod(actor, periodId, _input) {
      void _input;
      const row = requirePeriod(actor.organizationId, periodId);
      const updated: PeriodRow = { ...row, status: "reopened" };
      periods.set(periodId, updated);
      return updated;
    },
    async recompute(actor, periodId) {
      const period = requirePeriod(actor.organizationId, periodId);
      const base: Omit<
        ProjectionRow,
        | "id"
        | "scope"
        | "patientId"
        | "capAmountCents"
        | "inpatientDaysYtd"
        | "inpatientPctYtd"
        | "beneficiaryCount"
      > = {
        organizationId: actor.organizationId,
        capPeriodId: periodId,
        methodology: period.methodology ?? "streamlined",
        paidYtdCents: 500_000,
        outstandingBilledCents: 20_000,
        projectedYearEndCents: 700_000,
        pctOfCap: 0.14,
        alertBand: "green",
        computedAt: NOW,
        computedBy: "manual_recompute",
      };
      const agency: ProjectionRow = {
        ...base,
        id: randomUUID(),
        scope: "agency_aggregate",
        patientId: null,
        capAmountCents: period.aggregateCapAmountCents,
        inpatientDaysYtd: null,
        inpatientPctYtd: null,
        beneficiaryCount: 42,
      };
      const inpatient: ProjectionRow = {
        ...base,
        id: randomUUID(),
        scope: "inpatient",
        patientId: null,
        capAmountCents: null,
        inpatientDaysYtd: 3,
        inpatientPctYtd: 0.05,
        beneficiaryCount: null,
      };
      const patient: ProjectionRow = {
        ...base,
        id: randomUUID(),
        scope: "patient_aggregate",
        patientId: PATIENT,
        capAmountCents: null,
        inpatientDaysYtd: null,
        inpatientPctYtd: null,
        beneficiaryCount: null,
      };
      projections.set(`${periodId}:agency`, agency);
      projections.set(`${periodId}:inpatient`, inpatient);
      projections.set(`${periodId}:patient:${PATIENT}`, patient);
      return [agency, inpatient, patient];
    },
    async acknowledgeEvent(actor, eventId, input) {
      const row = requireEvent(actor.organizationId, eventId);
      void input;
      thresholdEvents.set(eventId, { ...row, acknowledgedAt: NOW });
    },
    async importPsr(actor, periodId, input) {
      const importId = randomUUID();
      psrImports.set(importId, {
        organizationId: actor.organizationId,
        id: importId,
        capPeriodId: periodId,
        macRegion: input.macRegion,
        psrPeriodFrom: input.psrPeriodFrom,
        psrPeriodTo: input.psrPeriodTo,
        parseStatus: "parsed",
        parseError: null,
        beneficiaryCountPsr: 10,
        paidTotalCentsPsr: 100_000,
        importedAt: NOW,
      });
      const lineId = randomUUID();
      psrVariances.set(lineId, {
        organizationId: actor.organizationId,
        importId,
        id: lineId,
        scope: "patient_aggregate",
        patientId: PATIENT,
        m26AccrualCents: 90_000,
        psrAmountCents: 100_000,
        varianceCents: 10_000,
        varianceReason: null,
        status: "open",
      });
      return { importId };
    },
    async resolveVariance(actor, lineId, input) {
      const row = requireVariance(actor.organizationId, lineId);
      psrVariances.set(lineId, {
        ...row,
        status: "resolved",
        varianceReason: input.varianceReason,
      });
    },
    async proposeSettlement(actor, periodId) {
      const period = requirePeriod(actor.organizationId, periodId);
      const row: SettlementRow = {
        organizationId: actor.organizationId,
        id: randomUUID(),
        capPeriodId: periodId,
        status: "proposed",
        paidTotalCents: 100_000,
        beneficiaryCount: 10,
        aggregateCapAmountCents: period.aggregateCapAmountCents,
        aggregateOverageCents: 0,
        inpatientTotalDays: 3,
        inpatientOverageDays: 0,
        inpatientOverageCents: 0,
        proposedAt: NOW,
        finalizedAt: null,
      };
      settlements.set(periodId, row);
      return row;
    },
    async finalizeSettlement(actor, periodId, input) {
      void input;
      const settlement = requireSettlement(actor.organizationId, periodId);
      const updated: SettlementRow = { ...settlement, status: "final", finalizedAt: NOW };
      settlements.set(periodId, updated);
      const period = requirePeriod(actor.organizationId, periodId);
      periods.set(periodId, { ...period, status: "settled" });
      return updated;
    },
    async publishConstant(_actor, input) {
      platformConstants.set(input.capYear, {
        capYear: input.capYear,
        aggregateCapAmountCents: input.aggregateCapAmountCents,
        inpatientCapPct: input.inpatientCapPct ?? 0.2,
        sourceUrl: input.sourceUrl ?? null,
        firstTenantUseAt: null,
        recordedAt: NOW,
      });
    },
    async amendConstant(_actor, capYear, input) {
      const row = requireConstant(capYear);
      platformConstants.set(capYear, {
        ...row,
        aggregateCapAmountCents: input.aggregateCapAmountCents,
        sourceUrl: input.sourceUrl ?? row.sourceUrl,
      });
    },
  };

  const resolver: ReadingM26AbacResolver = {
    async loadPeriod(ctx, capPeriodId) {
      const row = periods.get(capPeriodId);
      if (!row || row.organizationId !== ctx.organizationId) return null;
      return { status: row.status, methodology: row.methodology };
    },
    async loadSettlementStatus(ctx, capPeriodId) {
      const row = settlements.get(capPeriodId);
      if (!row || row.organizationId !== ctx.organizationId) return null;
      return row.status;
    },
  };

  return { readService, writeService, resolver };
}

// ── the M11/M15/M19/M21/M24/M26 header-auth shim, extended with the M19-precedent step-up attribute
//    header for the two §D12 STEP_UP routes (methodology-lock / settlement-finalize / period-reopen) ───────
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  if (request.headers["x-test-step-up"] === "1") {
    request.context.attributes.stepUpRecent = true;
  }
}

const PERMISSION_SEED = [
  { userId: "super_1", permissions: [...M26_PERMISSION_KEY_LIST] as string[] },
  { userId: "nobody_1", permissions: [] as string[] },
];

function makeServer() {
  const backend = createCapTestBackend();

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);

  // A FRESH predicate registry per server, seeded with M3's intrinsics (createPredicateRegistry()'s
  // default) plus M26's real five §4.7 predicates, plus the test-local stand-in for `step_up_recent` — the
  // M3 predicate the two STEP_UP-gated routes compose on but M26 does not own (the oncall-inject.test.ts
  // precedent for a cross-module predicate this file's job is not to test).
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(
    buildM26AbacPredicates({ resolver: backend.resolver }),
  )) {
    reg.register(name, predicate);
  }
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM26Routes(app, { readService: backend.readService, writeService: backend.writeService });
  return { app, backend };
}

const SUPER = {
  "x-test-user": "super_1",
  "x-test-org": ORG,
  "x-test-roles": "administrator,platform_admin",
  "x-test-step-up": "1",
};
const NOBODY = { "x-test-user": "nobody_1", "x-test-org": ORG };
/** A FRESH Idempotency-Key per mutating call (the M19-precedent — the M1 idempotency store keys on
 *  `(orgId, key)` and would 409 a replay of the same key against a different body). */
const idemp = () => ({ "idempotency-key": randomUUID() });

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

// ── auth/schema boundary: 401 / 403 / 422 ────────────────────────────────────────────────────────────

describe("M26-T0x auth + schema boundary", () => {
  it("no auth headers at all → 401", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/cap/periods" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("an authenticated actor holding NO permissions → 403", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/cap/periods", headers: NOBODY });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("a correctly-permissioned actor posting an empty body → 422 (TypeBox VALIDATION_FAILED)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cap/periods",
      headers: { ...SUPER, ...idemp() },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

// ── routes 1-6, 22-24 — the cap-period + settlement lifecycle over one period ───────────────────────────

describe("M26-T0x §2.2 cap-period lifecycle (routes 1-6, 22-24)", () => {
  it("opens, methodology-locks, closes, proposes + finalizes settlement, then reopens one period", async () => {
    const { app } = makeServer();

    // 2 — open
    const opened = await app.inject({
      method: "POST",
      url: "/api/v1/cap/periods",
      headers: { ...SUPER, ...idemp() },
      payload: { capYear: "FY2026", methodology: undefined, graceWindowDays: 30 },
    });
    expect(opened.statusCode).toBe(201);
    const periodId = opened.json().id as string;
    expect(opened.json().status).toBe("open");

    // 1 — list
    const list = await app.inject({ method: "GET", url: "/api/v1/cap/periods", headers: SUPER });
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.json())).toBe(true);

    // 3 — get one
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/cap/periods/${periodId}`,
      headers: SUPER,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().id).toBe(periodId);

    // 6 — lock methodology (§4.7 cap_period_methodology_unlocked, step-up)
    const locked = await app.inject({
      method: "POST",
      url: `/api/v1/cap/periods/${periodId}/methodology`,
      headers: { ...SUPER, ...idemp() },
      payload: {
        methodology: "streamlined",
        reason: "Electing the streamlined methodology for FY2026.",
      },
    });
    expect(locked.statusCode).toBe(200);
    expect(locked.json().methodology).toBe("streamlined");

    // 4 — close (§4.7 cap_period_open)
    const closed = await app.inject({
      method: "PATCH",
      url: `/api/v1/cap/periods/${periodId}/close`,
      headers: { ...SUPER, ...idemp() },
      payload: { reason: "FY2026 cap year has ended." },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe("in_settlement");

    // 23 — propose settlement (§4.7 cap_period_in_settlement)
    const proposed = await app.inject({
      method: "POST",
      url: `/api/v1/cap/settlements/${periodId}/propose`,
      headers: { ...SUPER, ...idemp() },
      payload: {},
    });
    expect(proposed.statusCode).toBe(201);
    expect(proposed.json().status).toBe("proposed");

    // 22 — read the settlement
    const settlementRead = await app.inject({
      method: "GET",
      url: `/api/v1/cap/settlements/${periodId}`,
      headers: SUPER,
    });
    expect(settlementRead.statusCode).toBe(200);
    expect(settlementRead.json().capPeriodId).toBe(periodId);

    // 24 — finalize (§4.7 cap_period_in_settlement, step-up)
    const finalized = await app.inject({
      method: "PATCH",
      url: `/api/v1/cap/settlements/${periodId}/finalize`,
      headers: { ...SUPER, ...idemp() },
      payload: {
        attestation: "I attest this cap settlement is accurate to the best of my knowledge.",
      },
    });
    expect(finalized.statusCode).toBe(200);
    expect(finalized.json().status).toBe("final");

    // 5 — reopen (§4.7 cap_period_settled, step-up). GAP-079 closed FINDING 2: the body no longer demands a
    // caller-supplied `stepUpAssertionId` (step-up is a server fact), so `{ reason }` alone reaches the 200.
    const reopened = await app.inject({
      method: "PATCH",
      url: `/api/v1/cap/periods/${periodId}/reopen`,
      headers: { ...SUPER, ...idemp() },
      payload: {
        reason: "Reopening FY2026 to correct a PS&R-driven variance discovered after settlement.",
      },
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().status).toBe("reopened");

    await app.close();
  });
});

// ── routes 7-11, 17 — projections + manual recompute + the dashboard composite ──────────────────────────

describe("M26-T0x §4.1 projections + recompute + dashboard (routes 7-11, 17)", () => {
  it("recomputes a freshly-opened period and reads every projection shape + the dashboard", async () => {
    const { app } = makeServer();
    const opened = await app.inject({
      method: "POST",
      url: "/api/v1/cap/periods",
      headers: { ...SUPER, ...idemp() },
      payload: { capYear: "FY2027" },
    });
    const periodId = opened.json().id as string;

    // 11 — recompute (§4.7 cap_period_open)
    const recomputed = await app.inject({
      method: "POST",
      url: `/api/v1/cap/projections/${periodId}/recompute`,
      headers: { ...SUPER, ...idemp() },
      payload: {},
    });
    expect(recomputed.statusCode).toBe(200);
    expect(Array.isArray(recomputed.json())).toBe(true);
    expect((recomputed.json() as unknown[]).length).toBe(3);

    // 7 — list
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/cap/projections?periodId=${periodId}`,
      headers: SUPER,
    });
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.json())).toBe(true);

    // 8 — agency
    const agency = await app.inject({
      method: "GET",
      url: `/api/v1/cap/projections/agency/${periodId}`,
      headers: SUPER,
    });
    expect(agency.statusCode).toBe(200);
    expect(agency.json().scope).toBe("agency_aggregate");

    // 9 — patient
    const patient = await app.inject({
      method: "GET",
      url: `/api/v1/cap/projections/patient/${periodId}/${PATIENT}`,
      headers: SUPER,
    });
    expect(patient.statusCode).toBe(200);
    expect(patient.json().patientId).toBe(PATIENT);

    // 10 — inpatient
    const inpatient = await app.inject({
      method: "GET",
      url: `/api/v1/cap/projections/inpatient/${periodId}`,
      headers: SUPER,
    });
    expect(inpatient.statusCode).toBe(200);
    expect(inpatient.json().scope).toBe("inpatient");

    // 17 — dashboard
    const dashboard = await app.inject({
      method: "GET",
      url: "/api/v1/cap/dashboard",
      headers: SUPER,
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().period.id).toBe(periodId);

    await app.close();
  });
});

// ── routes 12-14 — the beneficiary/inpatient accrual ledger reads ───────────────────────────────────────

describe("M26-T0x §4.1 accrual ledger reads (routes 12-14)", () => {
  it("reads the patient accrual, its lines, and the inpatient accrual for a freshly-opened period", async () => {
    const { app } = makeServer();
    const opened = await app.inject({
      method: "POST",
      url: "/api/v1/cap/periods",
      headers: { ...SUPER, ...idemp() },
      payload: { capYear: "FY2028" },
    });
    const periodId = opened.json().id as string;

    // 12
    const patientAccrual = await app.inject({
      method: "GET",
      url: `/api/v1/cap/accruals/patient/${periodId}/${PATIENT}`,
      headers: SUPER,
    });
    expect(patientAccrual.statusCode).toBe(200);
    expect(patientAccrual.json().patientId).toBe(PATIENT);

    // 13
    const lines = await app.inject({
      method: "GET",
      url: `/api/v1/cap/accruals/patient/${periodId}/${PATIENT}/lines`,
      headers: SUPER,
    });
    expect(lines.statusCode).toBe(200);
    expect(Array.isArray(lines.json().items)).toBe(true);
    expect(lines.json().items.length).toBeGreaterThan(0);

    // 14
    const inpatientAccrual = await app.inject({
      method: "GET",
      url: `/api/v1/cap/accruals/inpatient/${periodId}`,
      headers: SUPER,
    });
    expect(inpatientAccrual.statusCode).toBe(200);
    expect(inpatientAccrual.json().capPeriodId).toBe(periodId);

    await app.close();
  });
});

// ── routes 15-16 — the threshold-event queue + acknowledge ──────────────────────────────────────────────

describe("M26-T0x §4.1 threshold-event queue (routes 15-16)", () => {
  it("lists the threshold-event queue and acknowledges the seeded event", async () => {
    const { app } = makeServer();
    const opened = await app.inject({
      method: "POST",
      url: "/api/v1/cap/periods",
      headers: { ...SUPER, ...idemp() },
      payload: { capYear: "FY2029" },
    });
    const periodId = opened.json().id as string;

    // 15
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/cap/threshold-events?periodId=${periodId}`,
      headers: SUPER,
    });
    expect(list.statusCode).toBe(200);
    const events = list.json() as ReadonlyArray<{ id: string }>;
    expect(events.length).toBeGreaterThan(0);
    const eventId = events[0]?.id as string;

    // 16
    const ack = await app.inject({
      method: "PATCH",
      url: `/api/v1/cap/threshold-events/${eventId}/acknowledge`,
      headers: { ...SUPER, ...idemp() },
      payload: { notes: "Reviewed with the billing supervisor." },
    });
    expect(ack.statusCode).toBe(204);

    await app.close();
  });
});

// ── routes 18-21 — PS&R import + reconciliation ──────────────────────────────────────────────────────────

describe("M26-T0x §4.1 PS&R reconciliation (routes 18-21)", () => {
  it("imports a PS&R file, reads it back, lists the variance queue, and resolves the seeded line", async () => {
    const { app } = makeServer();
    const opened = await app.inject({
      method: "POST",
      url: "/api/v1/cap/periods",
      headers: { ...SUPER, ...idemp() },
      payload: { capYear: "FY2030" },
    });
    const periodId = opened.json().id as string;

    // 18 — import (format:"date" — FINDING 1, file header)
    const imported = await app.inject({
      method: "POST",
      url: `/api/v1/cap/periods/${periodId}/psr-imports`,
      headers: { ...SUPER, ...idemp() },
      payload: {
        macRegion: "ngs",
        psrPeriodFrom: "2025-10-01",
        psrPeriodTo: "2026-03-31",
        fileBase64: "UFNSIGZpeGVsdHVyZSBkYXRh",
      },
    });
    expect(imported.statusCode).toBe(202);
    const importId = imported.json().importId as string;
    expect(imported.json().status).toBe("queued");

    // 19
    const got = await app.inject({
      method: "GET",
      url: `/api/v1/cap/psr-imports/${importId}`,
      headers: SUPER,
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().id).toBe(importId);

    // 20
    const reconciliation = await app.inject({
      method: "GET",
      url: `/api/v1/cap/psr-imports/${importId}/reconciliation`,
      headers: SUPER,
    });
    expect(reconciliation.statusCode).toBe(200);
    const variances = reconciliation.json() as ReadonlyArray<{ id: string }>;
    expect(variances.length).toBeGreaterThan(0);
    const lineId = variances[0]?.id as string;

    // 21
    const resolved = await app.inject({
      method: "PATCH",
      url: `/api/v1/cap/psr-imports/${importId}/reconciliation/${lineId}/resolve`,
      headers: { ...SUPER, ...idemp() },
      payload: {
        varianceReason: "timing",
        resolutionNotes: "Confirmed a timing difference against the 835.",
      },
    });
    expect(resolved.statusCode).toBe(204);

    await app.close();
  });
});

// ── routes 25-27 — the platform-admin cap-constant surface ──────────────────────────────────────────────

describe("M26-T0x §4.1 platform cap constants (routes 25-27)", () => {
  it("lists, publishes, and amends a platform-published cap-year constant (cap_platform_admin)", async () => {
    const { app } = makeServer();

    // 25
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/platform/cap/constants",
      headers: SUPER,
    });
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.json())).toBe(true);

    // 26
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/platform/cap/constants",
      headers: { ...SUPER, ...idemp() },
      payload: { capYear: "FY2031", aggregateCapAmountCents: 3_450_000_00, inpatientCapPct: 0.2 },
    });
    expect(published.statusCode).toBe(201);
    expect(published.json().capYear).toBe("FY2031");

    // 27
    const amended = await app.inject({
      method: "PATCH",
      url: "/api/v1/platform/cap/constants/FY2031",
      headers: { ...SUPER, ...idemp() },
      payload: { aggregateCapAmountCents: 3_500_000_00, sourceUrl: "https://cms.gov/cap-fy2031" },
    });
    expect(amended.statusCode).toBe(204);

    await app.close();
  });

  it("a non-platform-admin actor holding the permission key is still blocked by cap_platform_admin (403)", async () => {
    const { app } = makeServer();
    // NOBODY holds none of the required permission keys either, so this also proves the RBAC gate runs
    // first; the ABAC axis is exercised structurally by SUPER's role composition in the test above (SUPER
    // without the `platform_admin` role would 403 identically — the registered predicate reads
    // `context.roles`, which this harness's header-auth shim sets verbatim from `x-test-roles`).
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/cap/constants",
      headers: NOBODY,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
