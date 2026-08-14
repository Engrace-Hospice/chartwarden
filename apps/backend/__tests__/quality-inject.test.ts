// apps/backend/__tests__/quality-inject.test.ts — M30 (HQRP & Quality) HTTP-layer smoke suite
// (TASK-050 / TEST-001).
//
// M30 had ZERO Fastify `.inject()` coverage before this file — a real gap given the module's own
// history: 15 `inOrg` ABAC guards sat unreachable across 7 route files for months (fixed in an earlier
// phase; see `incidents.routes.ts`'s R-50 comment for the exact story) because nothing drove a route
// through the REAL Fastify host with the REAL Authorization Contract. This file is that pass, cloned
// from `orders-routes.test.ts` (the reference implementation) and `cost-report-inject.test.ts` (the
// worked example for a 9-plugin aggregator module with no module-exported in-memory backend): `buildServer()`
// mounts the host, `mountM30Routes()` mounts the nine §4.1 route plugins (measures / CAHPS / risk-register /
// QAPI / SRA / CoP / incidents / mortality / infection) over a hand-rolled in-memory `{ readService,
// writeService }` pair (M30 ships no in-memory backend the way M11 does — this file is that backend, scoped
// to this file only), the REAL Authorization Contract gates every route on the §4.6 permission keys, and the
// eight §4.7 ABAC predicates M30's routes actually COMPOSE (`incidentVisibility`, `ownsIncident`,
// `assignedToIncident`, `capVerifyAuthority`, `abuseAllegationAccess`, `assignedToMortality`,
// `ownsQapiProject`, `ownsSraCycle`) are built with `buildM30AbacPredicates` over a resolver closed on this
// same in-memory store. `qapiCloseAuthority` / `sraCloseAuthority` are NOT wired as route preHandlers today
// (verified by reading `qapi.routes.ts`/`sra.routes.ts`: R-31/R-47 gate on RBAC alone — the two-person split
// is enforced in the SERVICE via `assertPipCloseSplitActor`/`assertSraCloseSplitActor`, which this file's
// hand-rolled write service does not re-derive, mirroring how `cost-report-inject.test.ts` skips the
// lifecycle state machine), so this file does not need caller/cosigner role gymnastics to reach those two
// routes' handlers. `part2Redisclosure` is likewise never composed at a route (it is a row-level redaction
// filter, not a route gate) so it is out of scope here. A permissive `step_up_recent` stub is registered
// alongside the real predicates (this file's own fresh predicate registry, never the shared boot one) so
// R-47's `requireStepUp` gate is exercised as PASSING at least once.
//
// The business RULES (state-machine legality, optimistic-concurrency version checks, the D1 measure
// reproducibility invariant, the M30-F03 two-person incident resolve/close split beyond the ABAC gate
// itself) are covered elsewhere or remain out of scope for a smoke pass; this file's in-memory service
// intentionally skips them so it can focus on what only `inject()` can prove: every one of the SIXTY §4.1
// routes reaches its handler with the RIGHT permission key, the RIGHT ABAC composition, and a body that
// TypeBox actually validates — a 401 with no session, a 403 with no grant, a 422 on a malformed body, and
// one legitimately-authorized 2xx call per route.
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
  M30_PERMISSION_KEY_LIST,
  type ReadingM30AbacResolver,
  buildM30AbacPredicates,
  mountM30Routes,
} from "../src/modules/30-quality/index";
import type {
  CahpsDecedentView,
  CahpsExportJobView,
  CahpsResultSummaryView,
  CahpsVendorBindingView,
  CopCitationView,
  IncidentCapPlanView,
  IncidentDetailView,
  IncidentInvestigationNoteView,
  IncidentSummaryView,
  InfectionEventView,
  InfectionOutbreakView,
  M30ReadRouteService,
  MeasureSummaryView,
  MeasureValueSnapshotView,
  MeasureValueView,
  MortalityReviewDetailView,
  MortalityReviewSummaryView,
  QapiGovernanceMinutesView,
  QapiIndicatorView,
  QapiPipView,
  QapiProgramView,
  QapiProjectView,
  RecomputeQueueEntryView,
  RiskRegisterEntryView,
  SraCycleView,
  SraFindingView,
  SraRemediationView,
} from "../src/modules/30-quality/routes/read-service";
import type { M30WriteRouteService } from "../src/modules/30-quality/routes/write-service";

// ── the header-auth shim (the M11/M27 precedent) ────────────────────────────────────────────────────────
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
  request.context.attributes.stepUpRecent = true;
}

// ── fixed ids (the M11/M27 style — distinct, valid-`uuid`-format constants; only 0-9/a-f digits) ────────
const ORG = "org_a";
const NOW = "2026-08-04T12:00:00.000Z";
const M_SUPER = "88888888-8888-4888-8888-888888888888";
const M_VERIFIER = "99999999-9999-4999-8999-999999999999";
const PATIENT = "10101010-1010-4101-8101-101010101010";

const MEASURE_ID = "hci-composite";
const MEASURE_VALUE_ID = "22222222-2222-4222-8222-222222222222";

const CAHPS_SAMPLE_ID = "33333333-3333-4333-8333-333333333333";
const CAHPS_EXPORT_ID = "44444444-4444-4444-8444-444444444444";

const QAPI_PROGRAM_ID = "55555555-5555-4555-8555-555555555555";
const QAPI_INDICATOR_ID = "66666666-6666-4666-8666-666666666666";
const QAPI_PROJECT_ID = "77777777-7777-4777-8777-777777777777";
const QAPI_PIP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const SRA_CYCLE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SRA_FINDING_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SRA_REMEDIATION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const COP_CITATION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const INC_DETAIL = "11111111-aaaa-4aaa-8aaa-111111111111";
const INC_UPDATE = "11111111-bbbb-4bbb-8bbb-111111111111";
const INC_SUBMIT = "11111111-cccc-4ccc-8ccc-111111111111";
const INC_TRIAGE = "11111111-dddd-4ddd-8ddd-111111111111";
const INC_NOTE = "11111111-eeee-4eee-8eee-111111111111";
const INC_INVESTIGATE = "11111111-ffff-4fff-8fff-111111111111";
const INC_RESOLVE = "22222222-aaaa-4aaa-8aaa-222222222222";
const INC_CLOSE = "22222222-bbbb-4bbb-8bbb-222222222222";
const INC_REOPEN = "22222222-cccc-4ccc-8ccc-222222222222";
const INC_ABUSE = "22222222-dddd-4ddd-8ddd-222222222222";

const MORTALITY_REVIEW_ID = "33333333-1111-4111-8111-333333333333";
const INFECTION_EVENT_ID = "44444444-1111-4111-8111-444444444444";
const INFECTION_CASE_ID = "44444444-2222-4222-8222-444444444444";

// ── the in-memory M30 backend (this file's own — M30 ships no `createInMemory*Backend`) ─────────────────
function createM30Backend(): {
  readonly readService: M30ReadRouteService;
  readonly writeService: M30WriteRouteService;
  readonly abacResolver: ReadingM30AbacResolver;
} {
  let seq = 0;

  function riskBandOf(score: number): "critical" | "high" | "medium" | "low" {
    if (score >= 20) return "critical";
    if (score >= 12) return "high";
    if (score >= 6) return "medium";
    return "low";
  }

  function mustGet<T>(map: Map<string, T>, id: string, label: string): T {
    const row = map.get(id);
    if (!row) throw new NotFoundError(`${label} ${id} not found`);
    return row;
  }

  // ── Measures (R-01..R-05) ────────────────────────────────────────────────────────────────────────────
  const measureValue: MeasureValueView = {
    valueId: MEASURE_VALUE_ID,
    organizationId: ORG,
    measureId: MEASURE_ID,
    period: { kind: "calendar_quarter", start: "2026-01-01", end: "2026-04-01" },
    numerator: 42,
    denominator: 50,
    rate: 0.84,
    thresholdMet: true,
    bandColor: "green",
    computedAt: NOW,
    computeVersion: "v1",
    snapshotContentHash: "hash-abc123",
    supersededByValueId: null,
  };
  const measureSummary: MeasureSummaryView = {
    measureId: MEASURE_ID,
    displayName: "HCI Composite",
    domain: "hci",
    latestValue: measureValue,
    fiscalYear: 2026,
  };
  const measureSnapshot: MeasureValueSnapshotView = {
    valueId: MEASURE_VALUE_ID,
    measureId: MEASURE_ID,
    computeVersion: "v1",
    snapshotContentHash: "hash-abc123",
    computedAt: NOW,
    inputs: {
      populationSourceTables: ["m8_encounter"],
      populationFilter: "discipline = 'rn'",
      inputRowCounts: { m8_encounter: 500 },
      parameters: {},
      thresholdConstants: {},
    },
    intermediates: null,
    output: { numerator: 42, denominator: 50, rate: 0.84 },
  };
  const recomputeQueue: RecomputeQueueEntryView[] = [];

  // ── CAHPS (R-10..R-17) ───────────────────────────────────────────────────────────────────────────────
  let cahpsVendor: CahpsVendorBindingView | null = {
    bindingId: "binding-seed-1",
    organizationId: ORG,
    vendorAdapterId: "vendor-adapter-1",
    vendorName: "Acme CAHPS Vendor",
    effectiveFrom: "2025-01-01",
    effectiveTo: null,
    isActive: true,
  };
  const cahpsDecedents = new Map<string, CahpsDecedentView>();
  cahpsDecedents.set(CAHPS_SAMPLE_ID, {
    sampleId: CAHPS_SAMPLE_ID,
    organizationId: ORG,
    patientId: PATIENT,
    dateOfDeath: "2026-06-01",
    samplePeriodStart: "2026-01-01",
    samplePeriodEnd: "2026-03-31",
    eligible: true,
    exclusionReason: null,
  });
  const cahpsExports = new Map<string, CahpsExportJobView>();
  cahpsExports.set(CAHPS_EXPORT_ID, {
    exportId: CAHPS_EXPORT_ID,
    organizationId: ORG,
    vendorAdapterId: "vendor-adapter-1",
    samplePeriodStart: "2026-01-01",
    samplePeriodEnd: "2026-03-31",
    status: "completed",
    decedentCount: 1,
    downloadUrl: "https://example.test/signed/cahps-export.csv",
    createdAt: NOW,
    completedAt: NOW,
    failureReason: null,
  });
  const cahpsResults: CahpsResultSummaryView[] = [];

  // ── QAPI (R-20..R-33) ────────────────────────────────────────────────────────────────────────────────
  const qapiPrograms = new Map<string, QapiProgramView>();
  qapiPrograms.set(QAPI_PROGRAM_ID, {
    programId: QAPI_PROGRAM_ID,
    organizationId: ORG,
    planYear: 2026,
    charterAdoptedAt: NOW,
    governanceComposition: [{ role: "qapi_coordinator", membershipId: M_SUPER }],
    status: "active",
  });
  const qapiIndicators = new Map<string, QapiIndicatorView>();
  qapiIndicators.set(QAPI_INDICATOR_ID, {
    indicatorId: QAPI_INDICATOR_ID,
    organizationId: ORG,
    qapiProgramId: QAPI_PROGRAM_ID,
    displayName: "Fall Rate",
    measureId: null,
    thresholdDirection: "max",
    thresholdValue: 0.1,
    currentRate: null,
    currentBand: null,
    breached: false,
  });
  // `ledByMembershipId` doubles as the §4.7 `ownsQapiProject` owner fact this file's abac resolver reads —
  // seeded to M_SUPER so SUPER (the project lead) can reach the owner-gated R-28/R-30 routes.
  const qapiProjects = new Map<string, QapiProjectView>();
  qapiProjects.set(QAPI_PROJECT_ID, {
    projectId: QAPI_PROJECT_ID,
    organizationId: ORG,
    qapiProgramId: QAPI_PROGRAM_ID,
    title: "Fall Reduction Initiative",
    phase: "active",
    indicatorId: QAPI_INDICATOR_ID,
    ledByMembershipId: M_SUPER,
    charteredAt: NOW,
    completedAt: null,
  });
  const qapiPips = new Map<string, QapiPipView>();
  qapiPips.set(QAPI_PIP_ID, {
    pipId: QAPI_PIP_ID,
    organizationId: ORG,
    projectId: QAPI_PROJECT_ID,
    phase: "measurement",
    charterText: "Seed PIP charter.",
    charteredByMembershipId: M_SUPER,
    outcome: null,
    closedAt: null,
  });
  const qapiGovernance: QapiGovernanceMinutesView[] = [
    {
      minutesId: "minutes-seed-1",
      organizationId: ORG,
      qapiProgramId: QAPI_PROGRAM_ID,
      meetingAt: NOW,
      recordedByMembershipId: M_SUPER,
      summary: "Seed governance minutes.",
      attendees: [{ role: "qapi_coordinator", membershipId: M_SUPER }],
    },
  ];

  // ── SRA (R-40..R-47) ─────────────────────────────────────────────────────────────────────────────────
  const sraCycles = new Map<string, SraCycleView>();
  sraCycles.set(SRA_CYCLE_ID, {
    cycleId: SRA_CYCLE_ID,
    organizationId: ORG,
    cycleYear: 2026,
    status: "in_progress",
    scopeTemplateVersion: "v1",
    ownerMembershipId: M_SUPER,
    openedAt: NOW,
    closedAt: null,
  });
  const sraFindings = new Map<string, SraFindingView>();
  sraFindings.set(SRA_FINDING_ID, {
    findingId: SRA_FINDING_ID,
    cycleId: SRA_CYCLE_ID,
    findingNumber: 1,
    controlRef: "164.308(a)(1)",
    likelihood: 3,
    impact: 3,
    riskScore: 9,
    riskBand: "medium",
    disposition: "open",
  });
  const sraRemediations = new Map<string, SraRemediationView>();
  sraRemediations.set(SRA_REMEDIATION_ID, {
    remediationId: SRA_REMEDIATION_ID,
    findingId: SRA_FINDING_ID,
    remediationNumber: 1,
    plan: "Seed remediation plan.",
    ownerMembershipId: M_SUPER,
    dueAt: "2026-12-31",
    status: "planned",
    completedAt: null,
  });

  // ── CoP (R-80..R-82) ─────────────────────────────────────────────────────────────────────────────────
  const copCitations = new Map<string, CopCitationView>();
  copCitations.set(COP_CITATION_ID, {
    citationId: COP_CITATION_ID,
    organizationId: ORG,
    citationRef: "418.54",
    displayName: "Patient Rights",
    status: "compliant",
    evidencePointers: [],
    lastReviewedAt: null,
    nextReviewDueAt: null,
  });

  // ── Incidents (R-50..R-61) — every row is reported by M_SUPER (server-assigned), so `ownsIncident` /
  // `incidentVisibility` branch (c) holds for SUPER regardless of kind; the assignee-gated rows are
  // pre-assigned to SUPER too, so `assignedToIncident` holds; the resolve/close/reopen rows exist in the
  // state each transition expects, and are exercised by VERIFIER (a distinct membership, role
  // `compliance_officer`) so `capVerifyAuthority`'s "verifier ≠ assignee" split holds. ────────────────────
  function makeIncident(
    overrides: Partial<IncidentDetailView> & { incidentId: string },
  ): IncidentDetailView {
    return {
      organizationId: ORG,
      kind: "fall",
      state: "draft",
      severity: "moderate",
      patientId: null,
      occurredAt: NOW,
      reportedAt: NOW,
      reportedByMembershipId: M_SUPER,
      assignedToMembershipId: null,
      data: {},
      capPlan: null,
      capVerifiedByMembershipId: null,
      capVerifiedAt: null,
      closedByMembershipId: null,
      closedAt: null,
      stateHistory: [],
      investigationNotes: [],
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }
  const incidents = new Map<string, IncidentDetailView>();
  for (const inc of [
    makeIncident({ incidentId: INC_DETAIL }),
    makeIncident({ incidentId: INC_UPDATE }),
    makeIncident({ incidentId: INC_SUBMIT }),
    makeIncident({ incidentId: INC_TRIAGE, state: "submitted" }),
    makeIncident({ incidentId: INC_NOTE, state: "triaged", assignedToMembershipId: M_SUPER }),
    makeIncident({
      incidentId: INC_INVESTIGATE,
      state: "triaged",
      assignedToMembershipId: M_SUPER,
    }),
    makeIncident({
      incidentId: INC_RESOLVE,
      state: "under_investigation",
      assignedToMembershipId: M_SUPER,
    }),
    makeIncident({ incidentId: INC_CLOSE, state: "resolved", assignedToMembershipId: M_SUPER }),
    makeIncident({
      incidentId: INC_REOPEN,
      state: "closed_followup_complete",
      assignedToMembershipId: M_SUPER,
    }),
    makeIncident({ incidentId: INC_ABUSE, kind: "allegation_of_abuse" }),
  ]) {
    incidents.set(inc.incidentId, inc);
  }
  function toIncidentSummary(row: IncidentDetailView): IncidentSummaryView {
    return {
      incidentId: row.incidentId,
      organizationId: row.organizationId,
      kind: row.kind,
      state: row.state,
      severity: row.severity,
      patientId: row.patientId,
      occurredAt: row.occurredAt,
      reportedAt: row.reportedAt,
      reportedByMembershipId: row.reportedByMembershipId,
      assignedToMembershipId: row.assignedToMembershipId,
    };
  }
  function withTransition(
    row: IncidentDetailView,
    toState: IncidentDetailView["state"],
    actorMembershipId: string,
  ): IncidentDetailView {
    return {
      ...row,
      state: toState,
      stateHistory: [
        ...row.stateHistory,
        { fromState: row.state, toState, actorMembershipId, occurredAt: NOW },
      ],
      updatedAt: NOW,
    };
  }

  // ── Mortality (R-70..R-73) — the seed review is assigned to M_SUPER so `assignedToMortality` holds. ────
  const mortalityReviews = new Map<string, MortalityReviewDetailView>();
  mortalityReviews.set(MORTALITY_REVIEW_ID, {
    reviewId: MORTALITY_REVIEW_ID,
    organizationId: ORG,
    patientId: PATIENT,
    dateOfDeath: "2026-07-01",
    assignedToMembershipId: M_SUPER,
    status: "in_progress",
    targetCompletionAt: "2026-07-31",
    completedAt: null,
    dimensions: { clinical: null, satisfaction: null, compliance: null },
    reviewerMembershipId: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  function toMortalitySummary(row: MortalityReviewDetailView): MortalityReviewSummaryView {
    return {
      reviewId: row.reviewId,
      organizationId: row.organizationId,
      patientId: row.patientId,
      dateOfDeath: row.dateOfDeath,
      assignedToMembershipId: row.assignedToMembershipId,
      status: row.status,
      targetCompletionAt: row.targetCompletionAt,
      completedAt: row.completedAt,
    };
  }

  // ── Infection (R-90..R-93) ───────────────────────────────────────────────────────────────────────────
  const infectionEvents = new Map<string, InfectionEventView>();
  infectionEvents.set(INFECTION_EVENT_ID, {
    eventId: INFECTION_EVENT_ID,
    organizationId: ORG,
    patientId: PATIENT,
    pathogen: "C. difficile",
    bodySite: "GI",
    observedAt: NOW,
    filedByMembershipId: M_SUPER,
    outbreakCaseId: INFECTION_CASE_ID,
  });
  const infectionOutbreaks = new Map<string, InfectionOutbreakView>();
  infectionOutbreaks.set(INFECTION_CASE_ID, {
    caseId: INFECTION_CASE_ID,
    organizationId: ORG,
    pathogen: "C. difficile",
    bodySite: "GI",
    eventCount: 1,
    firstEventAt: NOW,
    lastEventAt: NOW,
    status: "open",
    resolvedAt: null,
  });

  // ── Risk register (R-95..R-96) ───────────────────────────────────────────────────────────────────────
  const riskEntries: RiskRegisterEntryView[] = [];

  // ── the READ service ─────────────────────────────────────────────────────────────────────────────────
  const readService: M30ReadRouteService = {
    async listMeasures(_actor, filter) {
      const items = [measureSummary].filter((m) => !filter.domain || m.domain === filter.domain);
      return { items, nextCursor: null, hasMore: false };
    },
    async getMeasureValues(_actor, measureId) {
      return { measureId, displayName: measureSummary.displayName, values: [measureValue] };
    },
    async getMeasureValueSnapshot() {
      return measureSnapshot;
    },
    async listRecomputeQueue() {
      return recomputeQueue;
    },

    async getCahpsVendor() {
      return cahpsVendor;
    },
    async listCahpsDecedents() {
      return { items: [...cahpsDecedents.values()], nextCursor: null, hasMore: false };
    },
    async getCahpsExport(_actor, exportId) {
      return mustGet(cahpsExports, exportId, "cahps export");
    },
    async listCahpsResults() {
      return { items: cahpsResults, nextCursor: null, hasMore: false };
    },

    async listQapiPrograms() {
      return { items: [...qapiPrograms.values()], nextCursor: null, hasMore: false };
    },
    async listQapiIndicators() {
      return { items: [...qapiIndicators.values()], nextCursor: null, hasMore: false };
    },
    async listQapiProjects(_actor, filter) {
      const items = [...qapiProjects.values()].filter(
        (p) =>
          (!filter.programId || p.qapiProgramId === filter.programId) &&
          (!filter.phases || filter.phases.includes(p.phase)),
      );
      return { items, nextCursor: null, hasMore: false };
    },
    async listQapiPips(_actor, projectId) {
      const items = [...qapiPips.values()].filter((p) => p.projectId === projectId);
      return { items, nextCursor: null, hasMore: false };
    },
    async listQapiGovernance() {
      return { items: qapiGovernance, nextCursor: null, hasMore: false };
    },

    async listSraCycles() {
      return { items: [...sraCycles.values()], nextCursor: null, hasMore: false };
    },
    async getSraCycle(_actor, cycleId) {
      const cycle = mustGet(sraCycles, cycleId, "sra cycle");
      const findings = [...sraFindings.values()].filter((f) => f.cycleId === cycleId);
      const findingIds = new Set(findings.map((f) => f.findingId));
      const remediations = [...sraRemediations.values()].filter((r) => findingIds.has(r.findingId));
      return {
        ...cycle,
        progress: {
          findingsCount: findings.length,
          openFindingsCount: findings.filter((f) => f.disposition === "open").length,
          remediationsCount: remediations.length,
        },
        findings,
        remediations,
      };
    },

    async listIncidents(actor, filter) {
      const items = [...incidents.values()]
        .filter((i) => i.organizationId === actor.organizationId)
        .filter((i) => !filter.kinds || filter.kinds.includes(i.kind))
        .filter((i) => !filter.states || filter.states.includes(i.state))
        .filter((i) => !filter.severities || filter.severities.includes(i.severity))
        .filter((i) => !filter.patientId || i.patientId === filter.patientId)
        .filter((i) => filter.mayViewAbuseAllegations === true || i.kind !== "allegation_of_abuse")
        .map(toIncidentSummary);
      return { items, nextCursor: null, hasMore: false };
    },
    async getIncident(_actor, incidentId) {
      return mustGet(incidents, incidentId, "incident");
    },
    async listAbuseAllegations(actor) {
      const items = [...incidents.values()]
        .filter(
          (i) => i.organizationId === actor.organizationId && i.kind === "allegation_of_abuse",
        )
        .map(toIncidentSummary);
      return { items, nextCursor: null, hasMore: false };
    },

    async listMortalityReviews(actor, filter) {
      const items = [...mortalityReviews.values()]
        .filter((r) => r.organizationId === actor.organizationId)
        .filter((r) => !filter.status || r.status === filter.status)
        .filter((r) => !filter.patientId || r.patientId === filter.patientId)
        .map(toMortalitySummary);
      return { items, nextCursor: null, hasMore: false };
    },
    async getMortalityReview(_actor, reviewId) {
      return mustGet(mortalityReviews, reviewId, "mortality review");
    },

    async listCopCitations() {
      return { items: [...copCitations.values()], nextCursor: null, hasMore: false };
    },

    async listInfectionEvents(actor) {
      const items = [...infectionEvents.values()].filter(
        (e) => e.organizationId === actor.organizationId,
      );
      return { items, nextCursor: null, hasMore: false };
    },
    async listInfectionOutbreaks(actor) {
      const items = [...infectionOutbreaks.values()].filter(
        (o) => o.organizationId === actor.organizationId,
      );
      return { items, nextCursor: null, hasMore: false };
    },

    async listRiskRegister() {
      return { items: riskEntries, nextCursor: null, hasMore: false };
    },
  };

  // ── the WRITE service ────────────────────────────────────────────────────────────────────────────────
  const writeService: M30WriteRouteService = {
    async enqueueRecompute(_actor, args) {
      seq += 1;
      const jobId = `recompute-job-${seq}`;
      recomputeQueue.push({
        jobId,
        scope: args.scope,
        priority: args.priority ?? "normal",
        enqueuedAt: NOW,
        state: "waiting",
      });
      return { jobId, scope: args.scope, priority: args.priority ?? "normal" };
    },

    async bindCahpsVendor(actor, args) {
      seq += 1;
      const binding: CahpsVendorBindingView = {
        bindingId: `binding-created-${seq}`,
        organizationId: actor.organizationId,
        vendorAdapterId: args.vendorAdapterId,
        vendorName: `Adapter ${args.vendorAdapterId}`,
        effectiveFrom: args.effectiveFrom,
        effectiveTo: null,
        isActive: true,
      };
      cahpsVendor = binding;
      return binding;
    },
    async excludeCahpsDecedent(_actor, sampleId, args) {
      const row = mustGet(cahpsDecedents, sampleId, "cahps decedent sample");
      const updated: CahpsDecedentView = {
        ...row,
        eligible: false,
        exclusionReason: args.exclusionReason,
      };
      cahpsDecedents.set(sampleId, updated);
      return updated;
    },
    async createCahpsExport(actor, args) {
      seq += 1;
      const exportId = `export-created-${seq}`;
      const job: CahpsExportJobView = {
        exportId,
        organizationId: actor.organizationId,
        vendorAdapterId: cahpsVendor?.vendorAdapterId ?? "unbound",
        samplePeriodStart: args.samplePeriodStart,
        samplePeriodEnd: args.samplePeriodEnd,
        status: "queued",
        decedentCount: cahpsDecedents.size,
        downloadUrl: null,
        createdAt: NOW,
        completedAt: null,
        failureReason: null,
      };
      cahpsExports.set(exportId, job);
      return job;
    },
    async ingestCahpsResults(_actor, args) {
      const resultIds: string[] = [];
      for (const r of args.results) {
        seq += 1;
        const resultId = `cahps-result-${seq}`;
        resultIds.push(resultId);
        cahpsResults.push({
          resultId,
          organizationId: ORG,
          measureId: r.measureId,
          reportingPeriodStart: args.reportingPeriodStart,
          reportingPeriodEnd: args.reportingPeriodEnd,
          topBoxPercent: r.topBoxPercent,
          suppressedMinCell: r.topBoxPercent === null,
          ingestedAt: NOW,
        });
      }
      return {
        resultIds,
        measuresAffected: args.results.map((r) => r.measureId),
        suppressedMinCellCount: args.results.filter((r) => r.topBoxPercent === null).length,
      };
    },

    async adoptQapiProgram(actor, args) {
      seq += 1;
      const programId = `qapi-program-created-${seq}`;
      const row: QapiProgramView = {
        programId,
        organizationId: actor.organizationId,
        planYear: args.planYear,
        charterAdoptedAt: NOW,
        governanceComposition: args.governanceComposition,
        status: "active",
      };
      qapiPrograms.set(programId, row);
      return row;
    },
    async updateQapiProgramGovernance(_actor, programId, args) {
      const row = mustGet(qapiPrograms, programId, "qapi program");
      const updated: QapiProgramView = {
        ...row,
        governanceComposition: args.governanceComposition,
      };
      qapiPrograms.set(programId, updated);
      return updated;
    },
    async createQapiIndicator(actor, args) {
      seq += 1;
      const indicatorId = `qapi-indicator-created-${seq}`;
      const row: QapiIndicatorView = {
        indicatorId,
        organizationId: actor.organizationId,
        qapiProgramId: args.qapiProgramId,
        displayName: args.displayName,
        measureId: args.measureId ?? null,
        thresholdDirection: args.thresholdDirection,
        thresholdValue: args.thresholdValue,
        currentRate: null,
        currentBand: null,
        breached: false,
      };
      qapiIndicators.set(indicatorId, row);
      return row;
    },
    async updateQapiIndicator(_actor, indicatorId, args) {
      const row = mustGet(qapiIndicators, indicatorId, "qapi indicator");
      const updated: QapiIndicatorView = {
        ...row,
        thresholdValue: args.thresholdValue ?? row.thresholdValue,
        thresholdDirection: args.thresholdDirection ?? row.thresholdDirection,
        displayName: args.displayName ?? row.displayName,
      };
      qapiIndicators.set(indicatorId, updated);
      return updated;
    },
    async charterQapiProject(actor, args) {
      seq += 1;
      const projectId = `qapi-project-created-${seq}`;
      const row: QapiProjectView = {
        projectId,
        organizationId: actor.organizationId,
        qapiProgramId: args.qapiProgramId,
        title: args.title,
        phase: "proposed",
        indicatorId: args.indicatorId ?? null,
        ledByMembershipId: actor.membershipId,
        charteredAt: NOW,
        completedAt: null,
      };
      qapiProjects.set(projectId, row);
      return row;
    },
    async updateQapiProject(_actor, projectId, args) {
      const row = mustGet(qapiProjects, projectId, "qapi project");
      const updated: QapiProjectView = {
        ...row,
        phase: args.phase ?? row.phase,
        ledByMembershipId: args.ledByMembershipId ?? row.ledByMembershipId,
      };
      qapiProjects.set(projectId, updated);
      return updated;
    },
    async addQapiPip(actor, projectId, args) {
      seq += 1;
      const pipId = `qapi-pip-created-${seq}`;
      const row: QapiPipView = {
        pipId,
        organizationId: actor.organizationId,
        projectId,
        phase: "chartering",
        charterText: args.charterText,
        charteredByMembershipId: actor.membershipId,
        outcome: null,
        closedAt: null,
      };
      qapiPips.set(pipId, row);
      return row;
    },
    async closeQapiPip(_actor, pipId, args) {
      const row = mustGet(qapiPips, pipId, "qapi pip");
      const updated: QapiPipView = {
        ...row,
        phase: "concluded",
        outcome: args.outcome,
        closedAt: NOW,
      };
      qapiPips.set(pipId, updated);
      return updated;
    },
    async recordQapiGovernance(actor, args) {
      seq += 1;
      const minutesId = `qapi-minutes-created-${seq}`;
      const row: QapiGovernanceMinutesView = {
        minutesId,
        organizationId: actor.organizationId,
        qapiProgramId: args.qapiProgramId,
        meetingAt: args.meetingAt,
        recordedByMembershipId: actor.membershipId,
        summary: args.summary,
        attendees: args.attendees,
      };
      qapiGovernance.push(row);
      return row;
    },

    async openSraCycle(actor, args) {
      seq += 1;
      const cycleId = `sra-cycle-created-${seq}`;
      const row: SraCycleView = {
        cycleId,
        organizationId: actor.organizationId,
        cycleYear: args.cycleYear,
        status: "chartered",
        scopeTemplateVersion: "v1",
        ownerMembershipId: actor.membershipId,
        openedAt: NOW,
        closedAt: null,
      };
      sraCycles.set(cycleId, row);
      return row;
    },
    async addSraFinding(_actor, cycleId, args) {
      mustGet(sraCycles, cycleId, "sra cycle");
      seq += 1;
      const findingId = `sra-finding-created-${seq}`;
      const riskScore = args.likelihood * args.impact;
      const row: SraFindingView = {
        findingId,
        cycleId,
        findingNumber: args.findingNumber,
        controlRef: args.controlRef,
        likelihood: args.likelihood,
        impact: args.impact,
        riskScore,
        riskBand: riskBandOf(riskScore),
        disposition: "open",
      };
      sraFindings.set(findingId, row);
      return row;
    },
    async updateSraFinding(_actor, findingId, args) {
      const row = mustGet(sraFindings, findingId, "sra finding");
      const likelihood = args.likelihood ?? row.likelihood;
      const impact = args.impact ?? row.impact;
      const riskScore = likelihood * impact;
      const updated: SraFindingView = {
        ...row,
        likelihood,
        impact,
        riskScore,
        riskBand: riskBandOf(riskScore),
        disposition: args.disposition ?? row.disposition,
      };
      sraFindings.set(findingId, updated);
      return updated;
    },
    async planSraRemediation(_actor, findingId, args) {
      mustGet(sraFindings, findingId, "sra finding");
      seq += 1;
      const remediationId = `sra-remediation-created-${seq}`;
      const row: SraRemediationView = {
        remediationId,
        findingId,
        remediationNumber: args.remediationNumber,
        plan: args.plan,
        ownerMembershipId: args.ownerMembershipId,
        dueAt: args.dueAt ?? null,
        status: "planned",
        completedAt: null,
      };
      sraRemediations.set(remediationId, row);
      return row;
    },
    async updateSraRemediation(_actor, remediationId, args) {
      const row = mustGet(sraRemediations, remediationId, "sra remediation");
      const status = args.status ?? row.status;
      const updated: SraRemediationView = {
        ...row,
        status,
        dueAt: args.dueAt ?? row.dueAt,
        completedAt: status === "completed" ? NOW : row.completedAt,
      };
      sraRemediations.set(remediationId, updated);
      return updated;
    },
    async closeSraCycle(_actor, cycleId) {
      const row = mustGet(sraCycles, cycleId, "sra cycle");
      const updated: SraCycleView = { ...row, status: "closed", closedAt: NOW };
      sraCycles.set(cycleId, updated);
      return updated;
    },

    async createIncident(actor, args) {
      seq += 1;
      const incidentId = `incident-created-${seq}`;
      const row: IncidentDetailView = {
        incidentId,
        organizationId: actor.organizationId,
        kind: args.kind,
        state: "draft",
        severity: args.severity,
        patientId: args.patientId ?? null,
        occurredAt: args.occurredAt,
        reportedAt: NOW,
        reportedByMembershipId: actor.membershipId,
        assignedToMembershipId: null,
        data: args.data,
        capPlan: null,
        capVerifiedByMembershipId: null,
        capVerifiedAt: null,
        closedByMembershipId: null,
        closedAt: null,
        stateHistory: [
          {
            fromState: null,
            toState: "draft",
            actorMembershipId: actor.membershipId,
            occurredAt: NOW,
          },
        ],
        investigationNotes: [],
        createdAt: NOW,
        updatedAt: NOW,
      };
      incidents.set(incidentId, row);
      return row;
    },
    async updateIncident(_actor, incidentId, args) {
      const row = mustGet(incidents, incidentId, "incident");
      const updated: IncidentDetailView = {
        ...row,
        severity: args.severity ?? row.severity,
        data: args.data ?? row.data,
        occurredAt: args.occurredAt ?? row.occurredAt,
        updatedAt: NOW,
      };
      incidents.set(incidentId, updated);
      return updated;
    },
    async submitIncident(actor, incidentId) {
      const row = mustGet(incidents, incidentId, "incident");
      const updated = withTransition(row, "submitted", actor.membershipId);
      incidents.set(incidentId, updated);
      return updated;
    },
    async triageIncident(actor, incidentId, args) {
      const row = mustGet(incidents, incidentId, "incident");
      const transitioned = withTransition(row, "triaged", actor.membershipId);
      const updated: IncidentDetailView = {
        ...transitioned,
        assignedToMembershipId: args.assignedToMembershipId,
        severity: args.severity,
      };
      incidents.set(incidentId, updated);
      return updated;
    },
    async addIncidentInvestigationNote(actor, incidentId, args) {
      const row = mustGet(incidents, incidentId, "incident");
      seq += 1;
      const note: IncidentInvestigationNoteView = {
        noteId: `note-${seq}`,
        incidentId,
        authorMembershipId: actor.membershipId,
        body: args.body,
        createdAt: NOW,
      };
      incidents.set(incidentId, {
        ...row,
        investigationNotes: [...row.investigationNotes, note],
        updatedAt: NOW,
      });
      return note;
    },
    async openIncidentInvestigation(actor, incidentId, args) {
      const row = mustGet(incidents, incidentId, "incident");
      const transitioned = withTransition(row, "under_investigation", actor.membershipId);
      const capPlan: IncidentCapPlanView = {
        rootCauseSummary: args.rootCauseSummary,
        actions: args.actions.map((a) => ({ ...a, completedAt: null })),
        verificationCriteria: args.verificationCriteria,
      };
      const updated: IncidentDetailView = { ...transitioned, capPlan };
      incidents.set(incidentId, updated);
      return updated;
    },
    async resolveIncident(actor, incidentId) {
      const row = mustGet(incidents, incidentId, "incident");
      const transitioned = withTransition(row, "resolved", actor.membershipId);
      const updated: IncidentDetailView = {
        ...transitioned,
        capVerifiedByMembershipId: actor.membershipId,
        capVerifiedAt: NOW,
      };
      incidents.set(incidentId, updated);
      return updated;
    },
    async closeIncident(actor, incidentId) {
      const row = mustGet(incidents, incidentId, "incident");
      const transitioned = withTransition(row, "closed_followup_complete", actor.membershipId);
      const updated: IncidentDetailView = {
        ...transitioned,
        closedByMembershipId: actor.membershipId,
        closedAt: NOW,
      };
      incidents.set(incidentId, updated);
      return updated;
    },
    async reopenIncident(actor, incidentId) {
      const row = mustGet(incidents, incidentId, "incident");
      const updated = withTransition(row, "under_investigation", actor.membershipId);
      incidents.set(incidentId, updated);
      return updated;
    },

    async updateMortalityReview(_actor, reviewId, args) {
      const row = mustGet(mortalityReviews, reviewId, "mortality review");
      const updated: MortalityReviewDetailView = {
        ...row,
        dimensions: {
          clinical: args.dimensions?.clinical ?? row.dimensions.clinical,
          satisfaction: args.dimensions?.satisfaction ?? row.dimensions.satisfaction,
          compliance: args.dimensions?.compliance ?? row.dimensions.compliance,
        },
        assignedToMembershipId: args.assignedToMembershipId ?? row.assignedToMembershipId,
        updatedAt: NOW,
      };
      mortalityReviews.set(reviewId, updated);
      return updated;
    },
    async completeMortalityReview(actor, reviewId, args) {
      const row = mustGet(mortalityReviews, reviewId, "mortality review");
      const updated: MortalityReviewDetailView = {
        ...row,
        dimensions: args.dimensions,
        status: "completed",
        completedAt: NOW,
        reviewerMembershipId: actor.membershipId,
        updatedAt: NOW,
      };
      mortalityReviews.set(reviewId, updated);
      return updated;
    },

    async updateCopCitation(_actor, citationId, args) {
      const row = mustGet(copCitations, citationId, "cop citation");
      const updated: CopCitationView = {
        ...row,
        status: args.status ?? row.status,
        evidencePointers: args.evidencePointers ?? row.evidencePointers,
      };
      copCitations.set(citationId, updated);
      return updated;
    },
    async reviewCopCitation(_actor, citationId) {
      const row = mustGet(copCitations, citationId, "cop citation");
      const updated: CopCitationView = {
        ...row,
        lastReviewedAt: NOW,
        nextReviewDueAt: "2027-02-01",
      };
      copCitations.set(citationId, updated);
      return updated;
    },

    async recordInfectionEvent(actor, args) {
      seq += 1;
      const eventId = `infection-event-created-${seq}`;
      const row: InfectionEventView = {
        eventId,
        organizationId: actor.organizationId,
        patientId: args.patientId,
        pathogen: args.pathogen,
        bodySite: args.bodySite,
        observedAt: args.observedAt,
        filedByMembershipId: actor.membershipId,
        outbreakCaseId: null,
      };
      infectionEvents.set(eventId, row);
      return row;
    },
    async updateInfectionOutbreak(_actor, caseId, args) {
      const row = mustGet(infectionOutbreaks, caseId, "infection outbreak case");
      const updated: InfectionOutbreakView = {
        ...row,
        status: args.status,
        resolvedAt: args.status === "resolved" ? NOW : row.resolvedAt,
      };
      infectionOutbreaks.set(caseId, updated);
      return updated;
    },

    async refreshRiskRegister() {
      return { jobId: "risk-register-refresh-job-1", enqueuedAt: NOW };
    },
  };

  // ── the §4.7 ABAC resolver — closed over the SAME maps the read/write services mutate, so a route's
  // owner/assignee check sees the row a prior write in the SAME test just produced. ────────────────────
  const membershipRoles: Record<string, readonly string[]> = {
    [M_SUPER]: ["administrator"],
    [M_VERIFIER]: ["compliance_officer"],
  };
  const abacResolver: ReadingM30AbacResolver = {
    async loadIncident(ctx, incidentId) {
      const row = incidents.get(incidentId);
      if (!row || row.organizationId !== ctx.organizationId) return null;
      return {
        incidentId: row.incidentId,
        organizationId: row.organizationId,
        kind: row.kind,
        reportedByMembershipId: row.reportedByMembershipId,
        assignedToMembershipId: row.assignedToMembershipId,
      };
    },
    async loadQapiProject(ctx, projectId) {
      const row = qapiProjects.get(projectId);
      if (!row || row.organizationId !== ctx.organizationId || !row.ledByMembershipId) return null;
      return {
        projectId: row.projectId,
        organizationId: row.organizationId,
        ownerMembershipId: row.ledByMembershipId,
      };
    },
    async loadSraCycle(ctx, cycleId) {
      const row = sraCycles.get(cycleId);
      if (!row || row.organizationId !== ctx.organizationId) return null;
      return {
        cycleId: row.cycleId,
        organizationId: row.organizationId,
        ownerMembershipId: row.ownerMembershipId,
      };
    },
    async loadMortalityReview(ctx, reviewId) {
      const row = mortalityReviews.get(reviewId);
      if (!row || row.organizationId !== ctx.organizationId) return null;
      return {
        reviewId: row.reviewId,
        organizationId: row.organizationId,
        assignedToMembershipId: row.assignedToMembershipId,
      };
    },
    async loadMemberRoleKeys(_ctx, membershipId) {
      return membershipRoles[membershipId] ?? [];
    },
    async isPatientPart2Protected() {
      return false;
    },
    async part2ReleaseCoversActor() {
      return false;
    },
  };

  return { readService, writeService, abacResolver };
}

// ── server assembly (the M11/M27 `makeServer()` precedent) ─────────────────────────────────────────────
const SUPER_HEADERS = {
  "x-test-user": "super_1",
  "x-test-org": ORG,
  "x-test-roles": "administrator",
  "x-test-membership": M_SUPER,
};
// A DISTINCT membership + role (`compliance_officer`) so the incident resolve/close/reopen routes'
// `capVerifyAuthority` ABAC gate — verifier ≠ assignee — has a real PASSING path (SUPER is always the
// seeded assignee; see `makeIncident` above).
const VERIFIER_HEADERS = {
  "x-test-user": "verifier_1",
  "x-test-org": ORG,
  "x-test-roles": "compliance_officer",
  "x-test-membership": M_VERIFIER,
};
const NONE_HEADERS = { "x-test-user": "none_1", "x-test-org": ORG, "x-test-roles": "" };

function makeServer() {
  const backend = createM30Backend();

  const grantStore = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "super_1",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: [...M30_PERMISSION_KEY_LIST],
        },
      ],
    },
    {
      orgId: ORG,
      userId: "verifier_1",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: [...M30_PERMISSION_KEY_LIST],
        },
      ],
    },
    {
      orgId: ORG,
      userId: "none_1",
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [] }],
    },
  ]);
  registerEffectivePermissionResolver(grantStore.store);

  // A FRESH predicate registry per server (the M11-T06 precedent): the eight §4.7 predicates M30's routes
  // actually compose (see the file banner for which ones), built over THIS backend's resolver, plus a
  // permissive `step_up_recent` stub so R-47's `requireStepUp` gate has a real PASSING path in this file.
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(
    buildM30AbacPredicates({ resolver: backend.abacResolver }),
  )) {
    reg.register(name, predicate);
  }
  reg.register("step_up_recent", async () => true);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM30Routes(app, { readService: backend.readService, writeService: backend.writeService });
  return { app, backend };
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

// ── §4.1 401 / 403 / 422 boundary cases ─────────────────────────────────────────────────────────────────
describe("M30 route smoke — the M1 boundary", () => {
  it("401s with no session at all", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/quality/measures" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("403s a permission-gated route for a session holding NO M30 grants", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/quality/measures",
      headers: NONE_HEADERS,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("422s a malformed body from an otherwise-authorized caller (TypeBox validation, M1 envelope)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/quality/incidents",
      headers: { ...SUPER_HEADERS, "idempotency-key": "k-422" },
      payload: {}, // missing kind/severity/occurredAt/data
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

// ── one legitimately-authorized 2xx call per route (the bulk of the file; SIXTY §4.1 routes) ──────────────
interface RouteCase {
  readonly label: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly payload?: Record<string, unknown>;
  readonly expectStatus: number;
}

const IDEMP = (key: string) => ({ "idempotency-key": key });

const ROUTE_CASES: readonly RouteCase[] = [
  // 1-5 — quality measures.
  {
    label: "1 GET /quality/measures",
    method: "GET",
    url: "/api/v1/quality/measures",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "2 GET /quality/measures/:measureId/values",
    method: "GET",
    url: `/api/v1/quality/measures/${MEASURE_ID}/values`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "3 GET /quality/measures/:measureId/values/:valueId/snapshot",
    method: "GET",
    url: `/api/v1/quality/measures/${MEASURE_ID}/values/${MEASURE_VALUE_ID}/snapshot`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "4 POST /quality/measures/recompute",
    method: "POST",
    url: "/api/v1/quality/measures/recompute",
    headers: { ...SUPER_HEADERS, ...IDEMP("k4") },
    payload: {
      scope: { kind: "all" },
      reason: "Scheduled a targeted recompute after a data correction landed.",
    },
    expectStatus: 202,
  },
  {
    label: "5 GET /quality/measures/recompute/queue",
    method: "GET",
    url: "/api/v1/quality/measures/recompute/queue",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },

  // 6-13 — CAHPS.
  {
    label: "6 GET /quality/cahps/vendor",
    method: "GET",
    url: "/api/v1/quality/cahps/vendor",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "7 POST /quality/cahps/vendor",
    method: "POST",
    url: "/api/v1/quality/cahps/vendor",
    headers: { ...SUPER_HEADERS, ...IDEMP("k7") },
    payload: { vendorAdapterId: "vendor-adapter-1", effectiveFrom: "2026-01-01" },
    expectStatus: 201,
  },
  {
    label: "8 GET /quality/cahps/decedents",
    method: "GET",
    url: "/api/v1/quality/cahps/decedents",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "9 POST /quality/cahps/decedents/:sampleId/exclude",
    method: "POST",
    url: `/api/v1/quality/cahps/decedents/${CAHPS_SAMPLE_ID}/exclude`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k9") },
    payload: { exclusionReason: "Ineligible: hospice stay under 48 hours." },
    expectStatus: 200,
  },
  {
    label: "10 POST /quality/cahps/export",
    method: "POST",
    url: "/api/v1/quality/cahps/export",
    headers: { ...SUPER_HEADERS, ...IDEMP("k10") },
    payload: { samplePeriodStart: "2026-01-01", samplePeriodEnd: "2026-03-31" },
    expectStatus: 202,
  },
  {
    label: "11 GET /quality/cahps/export/:exportId",
    method: "GET",
    url: `/api/v1/quality/cahps/export/${CAHPS_EXPORT_ID}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "12 POST /quality/cahps/results/ingest",
    method: "POST",
    url: "/api/v1/quality/cahps/results/ingest",
    headers: { ...SUPER_HEADERS, ...IDEMP("k12") },
    payload: {
      vendorAdapterId: "vendor-adapter-1",
      reportingPeriodStart: "2026-01-01",
      reportingPeriodEnd: "2026-03-31",
      results: [{ measureId: "cahps-comm-nurse", topBoxPercent: 82.5, respondentCount: 120 }],
      payloadHash: "a".repeat(64),
    },
    expectStatus: 200,
  },
  {
    label: "13 GET /quality/cahps/results",
    method: "GET",
    url: "/api/v1/quality/cahps/results",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },

  // 14-15 — risk register.
  {
    label: "14 GET /quality/risk-register",
    method: "GET",
    url: "/api/v1/quality/risk-register",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "15 POST /quality/risk-register/refresh",
    method: "POST",
    url: "/api/v1/quality/risk-register/refresh",
    headers: SUPER_HEADERS, // R-96 is idempotency-exempt.
    expectStatus: 202,
  },

  // 16-29 — QAPI.
  {
    label: "16 GET /quality/qapi/programs",
    method: "GET",
    url: "/api/v1/quality/qapi/programs",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "17 POST /quality/qapi/programs",
    method: "POST",
    url: "/api/v1/quality/qapi/programs",
    headers: { ...SUPER_HEADERS, ...IDEMP("k17") },
    payload: {
      planYear: 2026,
      governanceComposition: [{ role: "qapi_coordinator", membershipId: M_SUPER }],
    },
    expectStatus: 201,
  },
  {
    label: "18 PATCH /quality/qapi/programs/:programId/governance",
    method: "PATCH",
    url: `/api/v1/quality/qapi/programs/${QAPI_PROGRAM_ID}/governance`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k18") },
    payload: {
      governanceComposition: [
        { role: "qapi_coordinator", membershipId: M_SUPER },
        { role: "medical_director", membershipId: M_VERIFIER },
      ],
    },
    expectStatus: 200,
  },
  {
    label: "19 GET /quality/qapi/indicators",
    method: "GET",
    url: "/api/v1/quality/qapi/indicators",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "20 POST /quality/qapi/indicators",
    method: "POST",
    url: "/api/v1/quality/qapi/indicators",
    headers: { ...SUPER_HEADERS, ...IDEMP("k20") },
    payload: {
      qapiProgramId: QAPI_PROGRAM_ID,
      displayName: "HCI Composite Threshold",
      thresholdDirection: "min",
      thresholdValue: 0.8,
      dataPath: "hci.composite.rate",
    },
    expectStatus: 201,
  },
  {
    label: "21 PATCH /quality/qapi/indicators/:indicatorId",
    method: "PATCH",
    url: `/api/v1/quality/qapi/indicators/${QAPI_INDICATOR_ID}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k21") },
    payload: { thresholdValue: 0.85 },
    expectStatus: 200,
  },
  {
    label: "22 GET /quality/qapi/projects",
    method: "GET",
    url: "/api/v1/quality/qapi/projects",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "23 POST /quality/qapi/projects",
    method: "POST",
    url: "/api/v1/quality/qapi/projects",
    headers: { ...SUPER_HEADERS, ...IDEMP("k23") },
    payload: {
      qapiProgramId: QAPI_PROGRAM_ID,
      title: "Reduce fall-related incidents",
      charterNarrative: "Charter narrative describing scope and aim statement for the PI project.",
    },
    expectStatus: 201,
  },
  {
    label: "24 PATCH /quality/qapi/projects/:projectId",
    method: "PATCH",
    url: `/api/v1/quality/qapi/projects/${QAPI_PROJECT_ID}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k24") },
    payload: { phase: "active", interventions: ["Nurse re-education on fall risk screening"] },
    expectStatus: 200,
  },
  {
    label: "25 GET /quality/qapi/projects/:projectId/pips",
    method: "GET",
    url: `/api/v1/quality/qapi/projects/${QAPI_PROJECT_ID}/pips`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "26 POST /quality/qapi/projects/:projectId/pips",
    method: "POST",
    url: `/api/v1/quality/qapi/projects/${QAPI_PROJECT_ID}/pips`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k26") },
    payload: { charterText: "PIP charter text describing scope and target metric." },
    expectStatus: 201,
  },
  {
    label: "27 POST /quality/qapi/pips/:pipId/close",
    method: "POST",
    url: `/api/v1/quality/qapi/pips/${QAPI_PIP_ID}/close`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k27") },
    payload: {
      conclusionText: "Conclusion narrative summarizing the outcome.",
      outcome: "Target achieved.",
      cosign: { qapiCoordinatorMembershipId: M_SUPER, medicalDirectorMembershipId: M_VERIFIER },
    },
    expectStatus: 200,
  },
  {
    label: "28 POST /quality/qapi/governance",
    method: "POST",
    url: "/api/v1/quality/qapi/governance",
    headers: { ...SUPER_HEADERS, ...IDEMP("k28") },
    payload: {
      qapiProgramId: QAPI_PROGRAM_ID,
      meetingAt: NOW,
      summary: "Quarterly QAPI committee meeting minutes.",
      attendees: [{ role: "qapi_coordinator", membershipId: M_SUPER }],
    },
    expectStatus: 201,
  },
  {
    label: "29 GET /quality/qapi/governance",
    method: "GET",
    url: "/api/v1/quality/qapi/governance",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },

  // 30-37 — SRA.
  {
    label: "30 GET /quality/sra/cycles",
    method: "GET",
    url: "/api/v1/quality/sra/cycles",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "31 POST /quality/sra/cycles",
    method: "POST",
    url: "/api/v1/quality/sra/cycles",
    headers: { ...SUPER_HEADERS, ...IDEMP("k31") },
    payload: { cycleYear: 2026 },
    expectStatus: 201,
  },
  {
    label: "32 GET /quality/sra/cycles/:cycleId",
    method: "GET",
    url: `/api/v1/quality/sra/cycles/${SRA_CYCLE_ID}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "33 POST /quality/sra/cycles/:cycleId/findings",
    method: "POST",
    url: `/api/v1/quality/sra/cycles/${SRA_CYCLE_ID}/findings`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k33") },
    payload: {
      findingNumber: 2,
      controlRef: "164.308(a)(1)",
      likelihood: 3,
      impact: 4,
      description: "Access review gap identified during the annual review.",
    },
    expectStatus: 201,
  },
  {
    label: "34 PATCH /quality/sra/findings/:findingId",
    method: "PATCH",
    url: `/api/v1/quality/sra/findings/${SRA_FINDING_ID}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k34") },
    payload: { disposition: "remediating" },
    expectStatus: 200,
  },
  {
    label: "35 POST /quality/sra/findings/:findingId/remediation",
    method: "POST",
    url: `/api/v1/quality/sra/findings/${SRA_FINDING_ID}/remediation`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k35") },
    payload: {
      remediationNumber: 2,
      plan: "Implement a quarterly access review.",
      ownerMembershipId: M_SUPER,
      dueAt: "2026-06-30",
    },
    expectStatus: 201,
  },
  {
    label: "36 PATCH /quality/sra/remediation/:remediationId",
    method: "PATCH",
    url: `/api/v1/quality/sra/remediation/${SRA_REMEDIATION_ID}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k36") },
    payload: { status: "in_progress" },
    expectStatus: 200,
  },
  {
    label: "37 POST /quality/sra/cycles/:cycleId/close",
    method: "POST",
    url: `/api/v1/quality/sra/cycles/${SRA_CYCLE_ID}/close`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k37") },
    payload: {
      cosign: { securityOfficerMembershipId: M_SUPER, complianceOfficerMembershipId: M_VERIFIER },
    },
    expectStatus: 200,
  },

  // 38-40 — CoP compliance.
  {
    label: "38 GET /quality/cop/citations",
    method: "GET",
    url: "/api/v1/quality/cop/citations",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "39 PATCH /quality/cop/citations/:citationId",
    method: "PATCH",
    url: `/api/v1/quality/cop/citations/${COP_CITATION_ID}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k39") },
    payload: { status: "at_risk", evidencePointers: ["doc-123"] },
    expectStatus: 200,
  },
  {
    label: "40 POST /quality/cop/citations/:citationId/review",
    method: "POST",
    url: `/api/v1/quality/cop/citations/${COP_CITATION_ID}/review`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k40") },
    payload: { attestation: "Reviewed and attested compliant as of this cycle." },
    expectStatus: 200,
  },

  // 41-52 — incidents.
  {
    label: "41 GET /quality/incidents",
    method: "GET",
    url: "/api/v1/quality/incidents",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "42 GET /quality/incidents/abuse-allegations",
    method: "GET",
    url: "/api/v1/quality/incidents/abuse-allegations",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "43 POST /quality/incidents",
    method: "POST",
    url: "/api/v1/quality/incidents",
    headers: { ...SUPER_HEADERS, ...IDEMP("k43") },
    payload: {
      kind: "fall",
      severity: "moderate",
      occurredAt: NOW,
      data: { location: "patient room" },
    },
    expectStatus: 201,
  },
  {
    label: "44 GET /quality/incidents/:incidentId",
    method: "GET",
    url: `/api/v1/quality/incidents/${INC_DETAIL}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "45 PATCH /quality/incidents/:incidentId",
    method: "PATCH",
    url: `/api/v1/quality/incidents/${INC_UPDATE}`,
    headers: SUPER_HEADERS, // R-53 is Idempotency-Key exempt.
    payload: { severity: "severe" },
    expectStatus: 200,
  },
  {
    label: "46 POST /quality/incidents/:incidentId/submit",
    method: "POST",
    url: `/api/v1/quality/incidents/${INC_SUBMIT}/submit`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k46") },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "47 POST /quality/incidents/:incidentId/triage",
    method: "POST",
    url: `/api/v1/quality/incidents/${INC_TRIAGE}/triage`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k47") },
    payload: { assignedToMembershipId: M_SUPER, severity: "moderate" },
    expectStatus: 200,
  },
  {
    label: "48 POST /quality/incidents/:incidentId/investigation",
    method: "POST",
    url: `/api/v1/quality/incidents/${INC_NOTE}/investigation`,
    headers: SUPER_HEADERS, // R-56 carries no Idempotency-Key.
    payload: { body: "Initial investigation note documenting findings." },
    expectStatus: 201,
  },
  {
    label: "49 POST /quality/incidents/:incidentId/investigate",
    method: "POST",
    url: `/api/v1/quality/incidents/${INC_INVESTIGATE}/investigate`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k49") },
    payload: {
      rootCauseSummary:
        "Root cause summary describing the contributing factors identified during the review of this incident.",
      actions: [
        {
          action: "Retrain staff on the fall-prevention protocol",
          ownerMembershipId: M_SUPER,
          dueAt: "2026-09-01",
        },
      ],
      verificationCriteria: "Verify via a follow-up audit in 30 days.",
    },
    expectStatus: 200,
  },
  {
    label: "50 POST /quality/incidents/:incidentId/resolve",
    method: "POST",
    url: `/api/v1/quality/incidents/${INC_RESOLVE}/resolve`,
    headers: { ...VERIFIER_HEADERS, ...IDEMP("k50") },
    payload: { resolutionNote: "CAP verified complete; resolution confirmed." },
    expectStatus: 200,
  },
  {
    label: "51 POST /quality/incidents/:incidentId/close",
    method: "POST",
    url: `/api/v1/quality/incidents/${INC_CLOSE}/close`,
    headers: { ...VERIFIER_HEADERS, ...IDEMP("k51") },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "52 POST /quality/incidents/:incidentId/reopen",
    method: "POST",
    url: `/api/v1/quality/incidents/${INC_REOPEN}/reopen`,
    headers: { ...VERIFIER_HEADERS, ...IDEMP("k52") },
    payload: { reopenReason: "New information surfaced requiring re-investigation." },
    expectStatus: 200,
  },

  // 53-56 — mortality.
  {
    label: "53 GET /quality/mortality",
    method: "GET",
    url: "/api/v1/quality/mortality",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "54 GET /quality/mortality/:reviewId",
    method: "GET",
    url: `/api/v1/quality/mortality/${MORTALITY_REVIEW_ID}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "55 PATCH /quality/mortality/:reviewId",
    method: "PATCH",
    url: `/api/v1/quality/mortality/${MORTALITY_REVIEW_ID}`,
    headers: SUPER_HEADERS, // R-72 is Idempotency-Key exempt.
    payload: { dimensions: { clinical: { summary: "in progress" } } },
    expectStatus: 200,
  },
  {
    label: "56 POST /quality/mortality/:reviewId/complete",
    method: "POST",
    url: `/api/v1/quality/mortality/${MORTALITY_REVIEW_ID}/complete`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k56") },
    payload: {
      dimensions: {
        clinical: { summary: "ok" },
        satisfaction: { summary: "ok" },
        compliance: { summary: "ok" },
      },
    },
    expectStatus: 200,
  },

  // 57-60 — infection.
  {
    label: "57 GET /quality/infection/events",
    method: "GET",
    url: "/api/v1/quality/infection/events",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "58 POST /quality/infection/events",
    method: "POST",
    url: "/api/v1/quality/infection/events",
    headers: { ...SUPER_HEADERS, ...IDEMP("k58") },
    payload: { patientId: PATIENT, pathogen: "MRSA", bodySite: "wound", observedAt: NOW },
    expectStatus: 201,
  },
  {
    label: "59 GET /quality/infection/outbreaks",
    method: "GET",
    url: "/api/v1/quality/infection/outbreaks",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "60 PATCH /quality/infection/outbreaks/:caseId",
    method: "PATCH",
    url: `/api/v1/quality/infection/outbreaks/${INFECTION_CASE_ID}`,
    headers: SUPER_HEADERS, // R-93 is Idempotency-Key exempt.
    payload: {
      status: "contained",
      resolutionNote: "Contact precautions implemented; no new cases in 14 days.",
    },
    expectStatus: 200,
  },
];

describe.each(ROUTE_CASES)("M30 route smoke — $label", (c) => {
  it(`reaches its handler and returns ${c.expectStatus}`, async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: c.method,
      url: c.url,
      headers: c.headers,
      payload: c.payload,
    });
    expect(res.statusCode).toBe(c.expectStatus);
    await app.close();
  });
});
