// apps/backend/__tests__/billing-medicare-inject.test.ts — M23 (Billing — Medicare) HTTP-layer smoke suite
// (TASK-050A / TEST-001).
//
// M23 had ZERO Fastify `.inject()` coverage before this file: every test under
// `apps/backend/src/modules/23-billing-medicare/__tests__/` (`assembly.test.ts`, `cap-projection-adapter
// .test.ts`, `claim-list-provider-scope.test.ts`, `consumer-domain.test.ts`, `override-service.test.ts`,
// `validation-service.test.ts`) exercises pure domain/service logic directly — none of them calls
// `.inject()`, so a mis-wired guard, a typo'd permission key, an ABAC predicate name that does not resolve,
// or a TypeBox schema that drifted from the route body it guards is invisible to every one of them. This
// file closes that gap the way `orders-routes.test.ts` established and `discipline-plans-inject.test.ts` /
// `oncall-inject.test.ts` cloned it for M15/M19: `buildServer()` mounts the host, `mountM23Routes()` mounts
// all ten §4.1 route-plugin groups over a fresh in-memory `{readService, writeService, assemblyService,
// internalSeam}` bundle hand-rolled against the REAL exported service contracts, the REAL Authorization
// Contract gates every route on the real §4.6 permission keys, and the REAL `buildM23AbacPredicates`
// resolves the four §4.7 predicates M23 owns over an in-memory `ReadingM23AbacResolver`.
//
// M23 ships no `createInMemory*Backend` export (grepped the module — only `buildDrizzleM23ReadService` /
// `buildDrizzleM23WriteService`), so this file is that backend, scoped to this file only (the M15/M19
// precedent). `_billing-repo-fakes.ts` (the existing fakes file the domain-service tests share) fakes the
// `@chartwarden/billing` REPOSITORY layer `assembly.test.ts` et al. mock via `vi.mock("@chartwarden/billing")` — a
// layer BELOW the route-service contracts this file mounts over (`M23ReadRouteService` / `M23WriteRouteService`
// / `ClaimAssemblyService`), so it is not a fit here and is not imported; this file hand-rolls its own
// backend directly against the route-service interfaces, per the module's own guidance.
//
// FIXED FINDING (TASK-051) — this file's inject() coverage originally surfaced a real wiring gap in the
// three rule-config MUTATION routes (`POST .../rule-configs/custom`, `PATCH .../rule-configs/:id`,
// `DELETE .../rule-configs/:id`): all three composed `RULE_PROTECTED(...)` with its default `getTarget`
// (`targetRuleConfigId`), which projects the route's `:id` param onto a target keyed `ruleConfigId` — but
// `regulatory_required_rule_protected`'s `resolveRuleKey` only ever read a target's `ruleKey` or
// `validationResultId` field, never `ruleConfigId`, and `ReadingM23AbacResolver` had no `loadRuleConfig`
// method to bridge the two. `resolveRuleKey` always returned `null`, and the predicate's own fail-closed
// rule (`if (!ruleKey) return false`) denied EVERY caller, including an org_admin holding every M23
// permission key — with `notFoundOnDeny: true` that denial surfaced as 404, not the 2xx these three
// mutations are meant to reach. Fixed by (1) adding `loadRuleConfig` to the resolver (loads the overlay
// row's rule key by `:id` under RLS — PATCH/DELETE target an EXISTING row) and (2) giving the CREATE route
// its own target mapper, `targetRuleKeyFromBody` (nothing exists yet to load by id on create, so it
// targets the rule key being created directly). These three cases now assert the real 2xx.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { ClaimAssembleRequest, ClaimAssembleResponse } from "@chartwarden/billing";
import { NotFoundError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type ReadingM23AbacResolver,
  buildM23AbacPredicates,
} from "../src/modules/23-billing-medicare/abac-predicates";
import { M23_PERMISSION_KEY_LIST } from "../src/modules/23-billing-medicare/permission-keys";
import type { M23InternalSeamProvider } from "../src/modules/23-billing-medicare/routes/mount";
import { mountM23Routes } from "../src/modules/23-billing-medicare/routes/mount";
import type {
  ClaimAcknowledgmentView,
  ClaimDetailView,
  ClaimLineView,
  ClaimListFilter,
  ClaimStateHistoryView,
  ClaimSubmissionView,
  EligibilityCheckView,
  M23ReadRouteService,
  MacCredentialView,
  MetricsFilter,
  NoeListFilter,
  NoeView,
  NotrListFilter,
  NotrView,
  RuleConfigListFilter,
  RuleConfigView,
  ValidationRunDetailView,
  ValidationRunView,
} from "../src/modules/23-billing-medicare/routes/read-service";
import type { SequestrationPolicyRouteService } from "../src/modules/23-billing-medicare/routes/sequestration-policy-service";
import type { SequestrationPolicyView } from "../src/modules/23-billing-medicare/routes/sequestration-policy-typebox";
import type { M23WriteRouteService } from "../src/modules/23-billing-medicare/routes/write-service";
import type {
  ClaimAssemblyActor,
  ClaimAssemblyService,
} from "../src/modules/23-billing-medicare/services/claim-assembly";

// ── header-auth shim (the M11/M15/M19 precedent), extended with the extra `request.context.attributes`
// M23's write actor + step-up + internal-seam system-principal lock read. ─────────────────────────────────
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
  if (request.headers["x-test-step-up"] === "1") {
    request.context.attributes.stepUpRecent = true;
  }
  const actorKind = request.headers["x-test-actor-kind"];
  if (typeof actorKind === "string" && actorKind.length > 0) {
    request.context.attributes.actorKind = actorKind;
  }
}

// ── fixed ids. ORG is UUID-shaped because the two internal-seam routes (#39/#40) carry `organizationId` as
// a `Uuid`-formatted query param the route re-validates against `request.context.organizationId` (§4.1
// `tenantOf`) — every other M23 schema treats the org id as an opaque server-bound string. ───────────────
const ORG = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const CLAIM = "11111111-1111-4111-8111-111111111111";
const VALIDATION_RUN = "22222222-2222-4222-8222-222222222222";
const VALIDATION_RESULT = "33333333-3333-4333-8333-333333333333";
const NOE = "44444444-4444-4444-8444-444444444444";
const NOTR = "55555555-5555-4555-8555-555555555555";
const RULE_CONFIG = "66666666-6666-4666-8666-666666666666";
const PROVIDER_ENTITY = "77777777-7777-4777-8777-777777777777";
const PATIENT = "88888888-8888-4888-8888-888888888888";
const ADMISSION = "99999999-9999-4999-8999-999999999999";
const LOC_PERIOD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBERSHIP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = "2026-08-01T12:00:00.000Z";

function page<T>(items: readonly T[]): {
  items: readonly T[];
  nextCursor: string | null;
  hasMore: boolean;
} {
  return { items, nextCursor: null, hasMore: false };
}

/** Build the in-memory M23 backend this file exercises over HTTP (M23 ships no `createInMemory*Backend`). */
function createM23TestBackend(): {
  readonly readService: M23ReadRouteService;
  readonly writeService: M23WriteRouteService;
  readonly assemblyService: ClaimAssemblyService;
  readonly internalSeam: M23InternalSeamProvider;
  readonly sequestrationService: SequestrationPolicyRouteService;
  readonly abacResolver: ReadingM23AbacResolver;
} {
  let ruleConfigSeq = 1;
  let policySeq = 1;
  let credentialSeq = 1;

  const claims = new Map<string, ClaimDetailView>();
  const claimLines: ClaimLineView[] = [
    {
      claimLineId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      claimId: CLAIM,
      lineNumber: 1,
      revenueCode: "0651",
      qCode: "Q5001",
      levelOfCare: "routine_home_care",
      hcpcsCode: null,
      serviceDateFrom: "2026-01-01",
      serviceDateTo: "2026-01-10",
      unitCount: 10,
      unitRateCents: 10000,
      lineChargeCents: 100000,
      levelOfCarePeriodId: LOC_PERIOD,
      modifiers: [],
      icdPointerPositions: [],
      backingEncounterIds: [],
    },
  ];
  const stateHistory: ClaimStateHistoryView[] = [
    {
      historyId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      claimId: CLAIM,
      fromState: null,
      toState: "draft",
      at: NOW,
      actorMembershipId: MEMBERSHIP,
      actorKind: "user",
      reason: null,
      validationRunId: VALIDATION_RUN,
      submissionId: null,
      acknowledgmentId: null,
      remittanceAdviceId: null,
    },
  ];
  const submissions: ClaimSubmissionView[] = [
    {
      submissionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      providerEntityId: PROVIDER_ENTITY,
      kind: "claim_837i",
      claimId: CLAIM,
      noeId: null,
      notrId: null,
      transferNoticeId: null,
      claimControlNumber: "CCN0000001",
      attemptIndex: 1,
      outcome: "queued",
      outcomeReason: null,
      generatedFileUri: null,
      submittedAt: null,
      createdAt: NOW,
    },
  ];
  const acknowledgments: ClaimAcknowledgmentView[] = [
    {
      acknowledgmentId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      submissionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      claimId: CLAIM,
      kind: "ack_999",
      macJurisdiction: "ngs_j6",
      ackReceivedAt: NOW,
      parsedAt: NOW,
      outcomeStatus: "accepted",
      parsedPayload: {},
      createdAt: NOW,
    },
  ];

  claims.set(CLAIM, {
    claimId: CLAIM,
    organizationId: ORG,
    providerEntityId: PROVIDER_ENTITY,
    patientId: PATIENT,
    admissionId: ADMISSION,
    tob: "811",
    state: "draft",
    serviceFrom: "2026-01-01",
    serviceTo: "2026-01-10",
    claimControlNumber: "CCN0000001",
    payerClaimControlNumber: null,
    macJurisdiction: "ngs_j6",
    totalChargeCents: 100000,
    totalExpectedPaymentCents: 98000,
    version: 1,
    electionPeriodIdFrom: "10101010-1010-4101-8101-101010101010",
    electionPeriodIdTo: "10101010-1010-4101-8101-101010101011",
    patientPayerId: "20202020-2020-4202-8202-202020202020",
    sequestrationAppliedPct: "2.00",
    sequestrationPolicyId: "30303030-3030-4303-8303-303030303030",
    replacesClaimId: null,
    replacedByClaimId: null,
    replacementReason: null,
    latestValidationRunId: VALIDATION_RUN,
    latestSubmissionId: null,
    acknowledgmentDocumentId: null,
    latestValidation: null,
    pricing: { perDiemClass: null, sia: null },
    dischargeCodes: { patientStatusCode: "30", conditionCodes: [], occurrenceCodes: [] },
    createdAt: NOW,
    updatedAt: NOW,
  });

  const validationResult = {
    resultId: VALIDATION_RESULT,
    validationRunId: VALIDATION_RUN,
    ruleKey: "duplicate_billing_check",
    ruleVersion: 1,
    severity: "error" as const,
    outcome: "fail" as const,
    remediation: {},
    overridden: false,
    override: null,
    recordedAt: NOW,
  };
  const validationRunDetail: ValidationRunDetailView = {
    validationRunId: VALIDATION_RUN,
    claimId: CLAIM,
    trigger: "initial_assembly",
    outcome: "failures_present",
    rulesExecuted: 1,
    rulesPassed: 0,
    rulesFailed: 1,
    rulesWarn: 0,
    rulesInfo: 0,
    startedAt: NOW,
    completedAt: NOW,
    durationMs: 5,
    initiatedByMembershipId: MEMBERSHIP,
    results: [validationResult],
  };

  const noes = new Map<string, NoeView>([
    [
      NOE,
      {
        noeId: NOE,
        organizationId: ORG,
        providerEntityId: PROVIDER_ENTITY,
        patientId: PATIENT,
        admissionId: ADMISSION,
        electionPeriodId: "10101010-1010-4101-8101-101010101010",
        state: "ready",
        electionEffectiveDate: "2026-01-01",
        windowTargetAt: NOW,
        windowBreachedAt: null,
        noeControlNumber: "NOE0000001",
        payerNoeControlNumber: null,
        acceptedAt: null,
        clearinghouseAcceptedAt: null,
        rejectedAt: null,
        rejectionStage: null,
        rejectionCodes: [],
        payerStatusDate: null,
        payerStatusDateSource: null,
        correctsNoticeId: null,
        correctionReason: null,
        correctedBy: null,
        latestSubmissionId: null,
        latestAcknowledgmentId: null,
        confirmationDocumentId: null,
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  ]);

  const notrs = new Map<string, NotrView>([
    [
      NOTR,
      {
        notrId: NOTR,
        organizationId: ORG,
        providerEntityId: PROVIDER_ENTITY,
        patientId: PATIENT,
        admissionId: ADMISSION,
        triggerKind: "discharge",
        revocationEventId: null,
        transferEventId: null,
        dischargeEventId: "40404040-4040-4404-8404-404040404040",
        effectiveEndDate: "2026-02-01",
        windowTargetAt: NOW,
        windowBreachedAt: null,
        state: "ready",
        notrControlNumber: "NOTR0000001",
        payerNotrControlNumber: null,
        acceptedAt: null,
        clearinghouseAcceptedAt: null,
        rejectedAt: null,
        rejectionStage: null,
        rejectionCodes: [],
        payerStatusDate: null,
        payerStatusDateSource: null,
        correctsNoticeId: null,
        correctionReason: null,
        correctedBy: null,
        latestSubmissionId: null,
        latestAcknowledgmentId: null,
        confirmationDocumentId: null,
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  ]);

  const eligibilityByPatient = new Map<string, EligibilityCheckView[]>([
    [
      PATIENT,
      [
        {
          checkId: "50505050-5050-4505-8505-505050505050",
          providerEntityId: PROVIDER_ENTITY,
          patientId: PATIENT,
          asOfServiceDate: "2026-01-01",
          outcome: "active_part_a",
          parsedPayload: {},
          checkedAt: NOW,
          staleAt: NOW,
        },
      ],
    ],
  ]);

  const ruleConfigs = new Map<string, RuleConfigView>([
    [
      RULE_CONFIG,
      {
        ruleConfigId: RULE_CONFIG,
        organizationId: ORG,
        ruleKey: "custom_rule_seed",
        ruleVersion: 1,
        isCustom: true,
        enabled: true,
        severity: "warn",
        overrideRoleRequired: null,
        parameters: {},
        regulatoryRequiredSnapshot: false,
        predicateDsl: null,
        setByMembershipId: MEMBERSHIP,
        setReason: null,
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  ]);

  const sequestrationPolicies = new Map<string, SequestrationPolicyView[]>([
    [
      PROVIDER_ENTITY,
      [
        {
          policyId: "60606060-6060-4606-8606-606060606060",
          organizationId: ORG,
          providerEntityId: PROVIDER_ENTITY,
          percentage: "2.00",
          effectiveFrom: "2020-01-01",
          effectiveTo: null,
          setByMembershipId: MEMBERSHIP,
          setReason: null,
          supersededAt: null,
          supersededById: null,
          createdAt: NOW,
        },
      ],
    ],
  ]);

  const sequestrationService: SequestrationPolicyRouteService = {
    async listPolicies(_actor, providerEntityId) {
      return sequestrationPolicies.get(providerEntityId) ?? [];
    },
    async activePolicy(_actor, providerEntityId) {
      return (sequestrationPolicies.get(providerEntityId) ?? [])[0] ?? null;
    },
    async effectivePolicy(_actor, providerEntityId) {
      return (sequestrationPolicies.get(providerEntityId) ?? [])[0] ?? null;
    },
    async getPolicy(_actor, providerEntityId, id) {
      const row = (sequestrationPolicies.get(providerEntityId) ?? []).find(
        (r) => r.policyId === id,
      );
      if (!row) throw new NotFoundError("sequestration policy", id);
      return row;
    },
    async createPolicy(actor, body) {
      policySeq += 1;
      const row: SequestrationPolicyView = {
        policyId: `policy-${policySeq}`,
        organizationId: ORG,
        providerEntityId: body.providerEntityId,
        percentage: body.percentage,
        effectiveFrom: body.effectiveFrom,
        effectiveTo: body.effectiveTo ?? null,
        setByMembershipId: actor.membershipId,
        setReason: body.setReason ?? null,
        supersededAt: null,
        supersededById: null,
        createdAt: NOW,
      };
      const existing = sequestrationPolicies.get(body.providerEntityId) ?? [];
      sequestrationPolicies.set(body.providerEntityId, [...existing, row]);
      return row;
    },
    async supersedePolicy(actor, _id, body) {
      return this.createPolicy(actor, body);
    },
  };

  const macCredentials = new Map<string, MacCredentialView>([
    [
      PROVIDER_ENTITY,
      {
        credentialId: "70707070-7070-4707-8707-707070707070",
        organizationId: ORG,
        providerEntityId: PROVIDER_ENTITY,
        macJurisdiction: "ngs_j6",
        submitterId: "SUB1",
        tradingPartnerId: "TP1",
        clientId: "CID1",
        hasSecret: true,
        baaRecordRef: null,
        credentialExpiresAt: null,
        lastSandboxTestAt: null,
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  ]);

  const toRunView = (run: ValidationRunDetailView): ValidationRunView => {
    const { results: _results, ...rest } = run;
    void _results;
    return rest;
  };

  const readService: M23ReadRouteService = {
    async listValidationOverrides(_actor, filter, _cursor, _limit) {
      const items = validationRunDetail.results
        .filter((r) => r.override !== null)
        .map((r) => ({
          ...(r.override as NonNullable<typeof r.override>),
          claimId: CLAIM,
          ruleKey: r.ruleKey,
          m4AuditEventId: "audit-1",
        }))
        .filter((o) => filter.ruleKey === undefined || o.ruleKey === filter.ruleKey);
      return page(items);
    },
    async listClaims(_actor, _filter: ClaimListFilter) {
      return page([...claims.values()]);
    },
    async getClaim(_actor, claimId) {
      const row = claims.get(claimId);
      if (!row) throw new NotFoundError("claim", claimId);
      return row;
    },
    async listClaimLines(_actor, claimId) {
      return claimLines.filter((l) => l.claimId === claimId);
    },
    async listClaimStateHistory(_actor, claimId) {
      return page(stateHistory.filter((h) => h.claimId === claimId));
    },
    async listClaimSubmissions(_actor, claimId) {
      return submissions.filter((s) => s.claimId === claimId);
    },
    async listClaimAcknowledgments(_actor, claimId) {
      return acknowledgments.filter((a) => a.claimId === claimId);
    },
    async listValidationRuns(_actor, claimId) {
      return claimId === CLAIM ? [toRunView(validationRunDetail)] : [];
    },
    async getValidationRun(_actor, _claimId, validationRunId) {
      if (validationRunId !== VALIDATION_RUN)
        throw new NotFoundError("validation_run", validationRunId);
      return validationRunDetail;
    },
    async listNoes(_actor, _filter: NoeListFilter) {
      return page([...noes.values()]);
    },
    async getNoe(_actor, noeId) {
      const row = noes.get(noeId);
      if (!row) throw new NotFoundError("noe_record", noeId);
      return row;
    },
    async listNotrs(_actor, _filter: NotrListFilter) {
      return page([...notrs.values()]);
    },
    async getNotr(_actor, notrId) {
      const row = notrs.get(notrId);
      if (!row) throw new NotFoundError("notr_record", notrId);
      return row;
    },
    async listEligibilityChecks(_actor, patientId) {
      return eligibilityByPatient.get(patientId) ?? [];
    },
    async getLatestEligibility(_actor, patientId) {
      const rows = eligibilityByPatient.get(patientId) ?? [];
      return rows[0] ?? null;
    },
    async getHospicePeriods(_actor, patientId) {
      return {
        status: "hets_not_configured",
        hetsConfigured: false,
        patientId,
        checkId: null,
        asOfServiceDate: null,
        outcome: null,
        checkedAt: null,
        staleAt: null,
        stale: null,
        synthetic: false,
        hospiceHistoryReturned: false,
        hospiceElectionOpen: null,
        hospiceHistoryTruncated: null,
        hospicePeriods: [],
        nextPeriodNumber: null,
        nextPeriodBasis: null,
        lastAttempt: null,
        rhcCarryOver: null,
      };
    },
    async listRuleConfigs(_actor, _filter: RuleConfigListFilter) {
      return page([...ruleConfigs.values()]);
    },
    async getRuleConfig(_actor, ruleConfigId) {
      const row = ruleConfigs.get(ruleConfigId);
      if (!row) throw new NotFoundError("rule_config", ruleConfigId);
      return row;
    },
    async listMacCredentials() {
      return page([...macCredentials.values()]);
    },
    async getMacCredential(_actor, providerEntityId) {
      return macCredentials.get(providerEntityId) ?? null;
    },
    async getClaimMetrics(_actor, _filter: MetricsFilter) {
      return [{ key: "submitted", count: 1, amountCents: 100000 }];
    },
    async getClaimValidationOverview() {
      return {
        totalClaims: 1,
        neverValidated: 1,
        byOutcome: {
          all_pass: 0,
          failures_present: 0,
          overrides_required: 0,
          ready_for_submission: 0,
        },
        oldestLatestRunAt: null,
      };
    },
    async getArAging(_actor, _filter: MetricsFilter) {
      return {
        bucket0to30Cents: 100000,
        bucket31to60Cents: 0,
        bucket61to90Cents: 0,
        bucket90PlusCents: 0,
      };
    },
  };

  const writeService: M23WriteRouteService = {
    async assembleClaim(_actor, _args) {
      // Never invoked by the mounted routes (route #1 calls `assemblyService.assemble` instead) — kept only
      // to satisfy the M23WriteRouteService contract.
      const row = claims.get(CLAIM);
      if (!row) throw new NotFoundError("claim", CLAIM);
      return row;
    },
    async updateDraftClaim(_actor, claimId, args) {
      const row = claims.get(claimId);
      if (!row) throw new NotFoundError("claim", claimId);
      const updated: ClaimDetailView = {
        ...row,
        totalChargeCents: args.totalChargeCents ?? row.totalChargeCents,
        totalExpectedPaymentCents: args.totalExpectedPaymentCents ?? row.totalExpectedPaymentCents,
        version: row.version + 1,
        updatedAt: NOW,
      };
      claims.set(claimId, updated);
      return updated;
    },
    async deleteDraftClaim(_actor, claimId) {
      claims.delete(claimId);
    },
    async validateClaim(_actor, claimId) {
      return { claimId, validationRunId: VALIDATION_RUN, jobId: "job-validate-1" };
    },
    async submitClaim(_actor, claimId) {
      const row = claims.get(claimId);
      return {
        submissionId: "submission-1",
        jobId: "job-submit-1",
        attemptIndex: 1,
        claimControlNumber: row?.claimControlNumber ?? "CCN0000001",
      };
    },
    async replaceClaim(_actor, claimId, args) {
      const row = claims.get(claimId);
      if (!row) throw new NotFoundError("claim", claimId);
      void args;
      return { ...row, tob: "817", state: "draft" };
    },
    async voidClaim(_actor, claimId, args) {
      const row = claims.get(claimId);
      if (!row) throw new NotFoundError("claim", claimId);
      void args;
      return { ...row, tob: "818", state: "draft" };
    },
    async overrideValidationResult(actor, _claimId, args) {
      return {
        overrideId: "override-1",
        resultId: args.validationResultId,
        overrideMembershipId: actor.membershipId,
        overrideRoleApplied: args.overrideRole,
        reason: args.reason,
        appliedAt: NOW,
      };
    },
    async createRuleConfig(actor, args) {
      ruleConfigSeq += 1;
      const row: RuleConfigView = {
        ruleConfigId: `rule-config-${ruleConfigSeq}`,
        organizationId: ORG,
        ruleKey: args.ruleKey,
        ruleVersion: args.ruleVersion ?? 1,
        isCustom: args.isCustom ?? true,
        enabled: args.enabled ?? true,
        severity: args.severity,
        overrideRoleRequired: args.overrideRoleRequired ?? null,
        parameters: args.parameters ?? {},
        regulatoryRequiredSnapshot: false,
        predicateDsl: args.predicateDsl ?? null,
        setByMembershipId: actor.membershipId,
        setReason: args.setReason ?? null,
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      ruleConfigs.set(row.ruleConfigId, row);
      return row;
    },
    async updateRuleConfig(_actor, ruleConfigId, args) {
      const row = ruleConfigs.get(ruleConfigId);
      if (!row) throw new NotFoundError("rule_config", ruleConfigId);
      const updated: RuleConfigView = {
        ...row,
        enabled: args.enabled ?? row.enabled,
        severity: args.severity ?? row.severity,
        overrideRoleRequired: args.overrideRoleRequired ?? row.overrideRoleRequired,
        parameters: args.parameters ?? row.parameters,
        setReason: args.setReason ?? row.setReason,
        version: row.version + 1,
        updatedAt: NOW,
      };
      ruleConfigs.set(ruleConfigId, updated);
      return updated;
    },
    async deleteRuleConfig(_actor, ruleConfigId) {
      ruleConfigs.delete(ruleConfigId);
    },
    async submitNoe() {
      return { submissionId: "noe-submission-1", jobId: "job-noe-1", kind: "noe" };
    },
    async cancelNoe(_actor, noeId) {
      const row = noes.get(noeId);
      if (!row) throw new NotFoundError("noe_record", noeId);
      const updated: NoeView = { ...row, state: "cancelled", version: row.version + 1 };
      noes.set(noeId, updated);
      return updated;
    },
    async correctNoe(_actor, noeId, args) {
      const row = noes.get(noeId);
      if (!row) throw new NotFoundError("noe_record", noeId);
      return {
        created: true,
        notice: { ...row, state: "draft", correctsNoticeId: noeId, correctionReason: args.reason },
      };
    },
    async submitNotr() {
      return { submissionId: "notr-submission-1", jobId: "job-notr-1", kind: "notr" };
    },
    async cancelNotr(_actor, notrId) {
      const row = notrs.get(notrId);
      if (!row) throw new NotFoundError("notr_record", notrId);
      const updated: NotrView = { ...row, state: "cancelled", version: row.version + 1 };
      notrs.set(notrId, updated);
      return updated;
    },
    async correctNotr(_actor, notrId, args) {
      const row = notrs.get(notrId);
      if (!row) throw new NotFoundError("notr_record", notrId);
      return {
        created: true,
        notice: { ...row, state: "draft", correctsNoticeId: notrId, correctionReason: args.reason },
      };
    },
    async checkEligibility(_actor, args) {
      return {
        jobId: "job-eligibility-1",
        patientId: args.patientId,
        asOfServiceDate: args.asOfServiceDate,
      };
    },
    async testMacCredential(_actor, providerEntityId) {
      const existing = macCredentials.get(providerEntityId);
      if (!existing) throw new NotFoundError("mac credential");
      const at = NOW;
      macCredentials.set(providerEntityId, { ...existing, lastSandboxTestAt: at });
      return {
        providerEntityId,
        macJurisdiction: existing.macJurisdiction,
        ok: true,
        method: "portal_health_probe" as const,
        detail: "MAC portal reachable",
        checkedAt: at,
        lastSandboxTestAt: at,
      };
    },
    async upsertMacCredential(_actor, args) {
      credentialSeq += 1;
      const existing = macCredentials.get(args.providerEntityId);
      const row: MacCredentialView = {
        credentialId: existing?.credentialId ?? `mac-credential-${credentialSeq}`,
        organizationId: ORG,
        providerEntityId: args.providerEntityId,
        macJurisdiction: args.macJurisdiction,
        submitterId: args.submitterId,
        tradingPartnerId: args.tradingPartnerId,
        clientId: args.clientId,
        hasSecret: true,
        baaRecordRef: args.baaRecordRef ?? null,
        credentialExpiresAt: args.credentialExpiresAt ?? null,
        lastSandboxTestAt: null,
        version: (existing?.version ?? 0) + 1,
        createdAt: existing?.createdAt ?? NOW,
        updatedAt: NOW,
      };
      macCredentials.set(args.providerEntityId, row);
      return row;
    },
  };

  const assemblyService: ClaimAssemblyService = {
    async assemble(
      _actor: ClaimAssemblyActor,
      _input: ClaimAssembleRequest,
    ): Promise<ClaimAssembleResponse> {
      return {
        claimId: "80808080-8080-4808-8808-808080808080",
        state: "DRAFT",
        totalChargeCents: 100000,
        perDiemClassCode: "1AA21",
        perDiemRateCents: 10000,
        lineCount: 1,
        initialValidationRunId: "90909090-9090-4909-8909-909090909090",
        initialValidationOutcome: "all_pass",
      };
    },
  };

  const internalSeam: M23InternalSeamProvider = {
    async claimDayProjection(_ctx, query) {
      return {
        providerEntityId: query.providerEntityId ?? PROVIDER_ENTITY,
        fyEnd: query.fyEnd ?? "2026-09-30",
        totalDays: 10,
        unduplicatedPatientCount: 1,
      };
    },
    async acceptedSubmissionsInWindow() {
      return {
        submissions: [
          {
            submissionId: "submission-1",
            claimId: CLAIM,
            claimControlNumber: "CCN0000001",
            acceptedAt: NOW,
            payerClaimControlNumber: null,
          },
        ],
      };
    },
  };

  const abacResolver: ReadingM23AbacResolver = {
    async loadClaim(ctx, claimId) {
      if (ctx.organizationId !== ORG) return null;
      const row = claims.get(claimId);
      if (!row) return null;
      return {
        entityId: row.claimId,
        organizationId: ORG,
        providerEntityId: row.providerEntityId,
        patientId: row.patientId,
        state: row.state,
      };
    },
    async loadNoe(ctx, noeId) {
      if (ctx.organizationId !== ORG) return null;
      const row = noes.get(noeId);
      if (!row) return null;
      return {
        entityId: row.noeId,
        organizationId: ORG,
        providerEntityId: row.providerEntityId,
        patientId: row.patientId,
        state: null,
      };
    },
    async loadNotr(ctx, notrId) {
      if (ctx.organizationId !== ORG) return null;
      const row = notrs.get(notrId);
      if (!row) return null;
      return {
        entityId: row.notrId,
        organizationId: ORG,
        providerEntityId: row.providerEntityId,
        patientId: row.patientId,
        state: null,
      };
    },
    async loadValidationResult(ctx, validationResultId) {
      if (ctx.organizationId !== ORG) return null;
      if (validationResultId !== VALIDATION_RESULT) return null;
      // `duplicate_billing_check` is a real DEFAULT_BILLING_RULES entry with
      // `overrideRoleRequired: "billing_manager"` — the SUPER actor below holds that role, so
      // `override_role_eligible` genuinely evaluates true rather than being stubbed out.
      return { validationResultId, organizationId: ORG, ruleKey: "duplicate_billing_check" };
    },
    async loadRuleConfig(ctx, ruleConfigId) {
      if (ctx.organizationId !== ORG) return null;
      const row = ruleConfigs.get(ruleConfigId);
      if (!row) return null;
      return { ruleConfigId: row.ruleConfigId, organizationId: ORG, ruleKey: row.ruleKey };
    },
  };

  return {
    readService,
    writeService,
    assemblyService,
    internalSeam,
    sequestrationService,
    abacResolver,
  };
}

// ── server assembly (the M11/M15/M19 `makeServer()` precedent) ──────────────────────────────────────────
const SUPER_HEADERS = {
  "x-test-user": "super_1",
  "x-test-org": ORG,
  "x-test-roles": "org_admin,billing_manager",
  "x-test-membership": MEMBERSHIP,
  "x-test-step-up": "1",
};
const SYSTEM_HEADERS = { ...SUPER_HEADERS, "x-test-actor-kind": "system" };
const NONE_HEADERS = { "x-test-user": "none_1", "x-test-org": ORG, "x-test-roles": "" };

function makeServer() {
  const backend = createM23TestBackend();

  const grantStore = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "super_1",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: [...M23_PERMISSION_KEY_LIST],
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

  // A FRESH predicate registry per server (the M11-T06 precedent): the real four §4.7 predicates M23 owns,
  // built over THIS backend's resolver, plus test-local stand-ins for the two predicates M23 composes on
  // but does not own: `caseload_or_scope` (M5) and `step_up_recent` (M3, boot-registered from a real M2
  // session-context store in production) — the M19-inject precedent for a predicate outside this module.
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(
    buildM23AbacPredicates({ resolver: backend.abacResolver, isInCaseload: async () => true }),
  )) {
    reg.register(name, predicate);
  }
  reg.register("caseload_or_scope", async (context) => Boolean(context.organizationId));
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM23Routes(app, {
    readService: backend.readService,
    writeService: backend.writeService,
    assemblyService: backend.assemblyService,
    internalSeam: backend.internalSeam,
    sequestrationService: backend.sequestrationService,
  });
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

// ── §4.1 401 / 403 / 422 boundary cases ──────────────────────────────────────────────────────────────────
describe("M23 route smoke — the M1 boundary", () => {
  it("401s with no session at all", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/billing/claims" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("403s a permission-gated route for a session holding NO M23 grants", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/billing/claims",
      headers: NONE_HEADERS,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("422s a malformed body from an otherwise-authorized caller (TypeBox validation, M1 envelope)", async () => {
    const { app } = makeServer();
    // PATCH /claims/:id on the seeded, in-scope claim so the §4.7 CLAIM_CASELOAD gate passes (org_admin
    // bypass + a resolvable claim) and the request reaches the handler's `parse(ClaimPatchDraftBodySchema)`
    // — an empty body is missing the required `lines` array.
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/billing/claims/${CLAIM}`,
      headers: { ...SUPER_HEADERS, "idempotency-key": "m1-boundary-422", "if-match": "1" },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

// ── one legitimately-authorized 2xx call per route (the bulk of the file) ──────────────────────────────
interface RouteCase {
  readonly label: string;
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly payload?: Record<string, unknown>;
  readonly expectStatus: number;
}

const IDEMP = (key: string) => ({ "idempotency-key": key });
const IFM = { "if-match": "1" };
const REASON_40 = "a documented, sufficiently long billing rationale";

const ROUTE_CASES: readonly RouteCase[] = [
  // ── claims core (routes #1-13) ──────────────────────────────────────────────────────────────────────
  {
    label: "1 POST /billing/claims/assemble",
    method: "POST",
    url: "/api/v1/billing/claims/assemble",
    headers: { ...SUPER_HEADERS, ...IDEMP("r01") },
    payload: {
      providerEntityId: PROVIDER_ENTITY,
      patientId: PATIENT,
      serviceFrom: "2026-01-01",
      serviceTo: "2026-01-10",
      tob: "811",
    },
    expectStatus: 201,
  },
  {
    label: "2 GET /billing/claims",
    method: "GET",
    url: "/api/v1/billing/claims",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "2b GET /billing/claim-validation-summary",
    method: "GET",
    url: "/api/v1/billing/claim-validation-summary",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "3 GET /billing/claims/:id",
    method: "GET",
    url: `/api/v1/billing/claims/${CLAIM}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "4 PATCH /billing/claims/:id",
    method: "PATCH",
    url: `/api/v1/billing/claims/${CLAIM}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("r04"), ...IFM },
    payload: { lines: [] },
    expectStatus: 200,
  },
  {
    label: "5 DELETE /billing/claims/:id",
    method: "DELETE",
    url: `/api/v1/billing/claims/${CLAIM}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("r05") },
    expectStatus: 204,
  },
  {
    label: "6 POST /billing/claims/:id/validate",
    method: "POST",
    url: `/api/v1/billing/claims/${CLAIM}/validate`,
    headers: { ...SUPER_HEADERS, ...IDEMP("r06") },
    payload: {},
    expectStatus: 202,
  },
  {
    label: "7 POST /billing/claims/:id/submit",
    method: "POST",
    url: `/api/v1/billing/claims/${CLAIM}/submit`,
    headers: { ...SUPER_HEADERS, ...IDEMP("r07"), ...IFM },
    payload: {},
    expectStatus: 202,
  },
  {
    label: "8 POST /billing/claims/:id/replace",
    method: "POST",
    url: `/api/v1/billing/claims/${CLAIM}/replace`,
    headers: { ...SUPER_HEADERS, ...IDEMP("r08"), ...IFM },
    payload: { ifVersion: 1, reason: REASON_40 },
    expectStatus: 201,
  },
  {
    label: "9 POST /billing/claims/:id/void",
    method: "POST",
    url: `/api/v1/billing/claims/${CLAIM}/void`,
    headers: { ...SUPER_HEADERS, ...IDEMP("r09"), ...IFM },
    payload: { ifVersion: 1, reason: REASON_40 },
    expectStatus: 201,
  },
  {
    label: "10 GET /billing/claims/:id/lines",
    method: "GET",
    url: `/api/v1/billing/claims/${CLAIM}/lines`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "11 GET /billing/claims/:id/state-history",
    method: "GET",
    url: `/api/v1/billing/claims/${CLAIM}/state-history`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "12 GET /billing/claims/:id/submissions",
    method: "GET",
    url: `/api/v1/billing/claims/${CLAIM}/submissions`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "13 GET /billing/claims/:id/acknowledgments",
    method: "GET",
    url: `/api/v1/billing/claims/${CLAIM}/acknowledgments`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },

  // ── validation plane (validation.routes.ts) ─────────────────────────────────────────────────────────
  {
    label: "14 GET /claims/:id/validation-runs",
    method: "GET",
    url: `/api/v1/claims/${CLAIM}/validation-runs`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "15 GET /claims/:id/validation-runs/:runId",
    method: "GET",
    url: `/api/v1/claims/${CLAIM}/validation-runs/${VALIDATION_RUN}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "16 POST /claims/:id/validate (validation.routes.ts's own registration of route #6)",
    method: "POST",
    url: `/api/v1/claims/${CLAIM}/validate`,
    headers: { ...SUPER_HEADERS, ...IDEMP("r16") },
    payload: {},
    expectStatus: 202,
  },
  {
    label: "17 POST .../validation-runs/:runId/results/:resultId/override",
    method: "POST",
    url: `/api/v1/claims/${CLAIM}/validation-runs/${VALIDATION_RUN}/results/${VALIDATION_RESULT}/override`,
    headers: { ...SUPER_HEADERS, ...IDEMP("r17") },
    payload: { reason: REASON_40, overrideRole: "billing_manager" },
    expectStatus: 201,
  },

  // ── rule-config overlay (routes #18-21) — TASK-051: the 3 mutations now genuinely resolve the
  // regulatory_required_rule_protected target and reach the write service (see the file banner). ──────
  {
    label: "18 GET /billing/rule-configs",
    method: "GET",
    url: "/api/v1/billing/rule-configs",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "19 GET /billing/rule-configs/:id",
    method: "GET",
    url: `/api/v1/billing/rule-configs/${RULE_CONFIG}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "20 POST /billing/rule-configs/custom",
    method: "POST",
    url: "/api/v1/billing/rule-configs/custom",
    headers: { ...SUPER_HEADERS, ...IDEMP("r20") },
    payload: {
      ruleKey: "custom_rule_new",
      severity: "warn",
      setReason: "a sufficiently long setup reason for this custom rule",
    },
    expectStatus: 201,
  },
  {
    label: "21 PATCH /billing/rule-configs/:id",
    method: "PATCH",
    url: `/api/v1/billing/rule-configs/${RULE_CONFIG}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("r21"), ...IFM },
    payload: {
      enabled: false,
      setReason: "a sufficiently long reason to disable this overlay row",
    },
    expectStatus: 200,
  },
  {
    label: "22 DELETE /billing/rule-configs/:id",
    method: "DELETE",
    url: `/api/v1/billing/rule-configs/${RULE_CONFIG}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("r22"), ...IFM },
    expectStatus: 204,
  },

  // ── NOE fast path (routes #24-27, numbered per the module header) ──────────────────────────────────
  {
    label: "23 GET /noe-records",
    method: "GET",
    url: "/api/v1/noe-records",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "24 GET /noe-records/:id",
    method: "GET",
    url: `/api/v1/noe-records/${NOE}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "25 POST /noe-records/:id/submit",
    method: "POST",
    url: `/api/v1/noe-records/${NOE}/submit`,
    headers: { ...SUPER_HEADERS, ...IDEMP("r25") },
    payload: {},
    expectStatus: 202,
  },
  {
    label: "26 POST /noe-records/:id/cancel",
    method: "POST",
    url: `/api/v1/noe-records/${NOE}/cancel`,
    headers: { ...SUPER_HEADERS, ...IDEMP("r26") },
    payload: { electionReversed: true },
    expectStatus: 200,
  },
  {
    label: "26a POST /noe-records/:id/correct",
    method: "POST",
    url: `/api/v1/noe-records/${NOE}/correct`,
    headers: { ...SUPER_HEADERS, ...IDEMP("r26a") },
    payload: { reason: "MAC rejected the NOE: MBI corrected from HETS, refiling." },
    expectStatus: 201,
  },

  // ── NOTR fast path (routes #28-31) ──────────────────────────────────────────────────────────────────
  {
    label: "27 GET /notr-records",
    method: "GET",
    url: "/api/v1/notr-records",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "28 GET /notr-records/:id",
    method: "GET",
    url: `/api/v1/notr-records/${NOTR}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "29 POST /notr-records/:id/submit",
    method: "POST",
    url: `/api/v1/notr-records/${NOTR}/submit`,
    headers: { ...SUPER_HEADERS, ...IDEMP("r29") },
    payload: {},
    expectStatus: 202,
  },
  {
    label: "30 POST /notr-records/:id/cancel",
    method: "POST",
    url: `/api/v1/notr-records/${NOTR}/cancel`,
    headers: { ...SUPER_HEADERS, ...IDEMP("r30") },
    payload: { terminatingEventReversed: true },
    expectStatus: 200,
  },
  {
    label: "30a POST /notr-records/:id/correct",
    method: "POST",
    url: `/api/v1/notr-records/${NOTR}/correct`,
    headers: { ...SUPER_HEADERS, ...IDEMP("r30a") },
    payload: {
      reason: "The 999 rejected the NOTR file; refiling with the corrected date.",
      correctedDate: "2026-01-31",
    },
    expectStatus: 201,
  },

  // ── eligibility plane (routes #22-23 per the module header + the latest-read convenience) ─────────────
  {
    label: "31 POST /billing/eligibility/check",
    method: "POST",
    url: "/api/v1/billing/eligibility/check",
    headers: { ...SUPER_HEADERS, ...IDEMP("r31") },
    payload: {
      patientId: PATIENT,
      providerEntityId: PROVIDER_ENTITY,
      asOfServiceDate: "2026-01-01",
    },
    expectStatus: 202,
  },
  {
    label: "32 GET /billing/eligibility",
    method: "GET",
    url: `/api/v1/billing/eligibility?patientId=${PATIENT}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "33b GET /billing/eligibility/hospice-periods",
    method: "GET",
    url: `/api/v1/billing/eligibility/hospice-periods?patientId=${PATIENT}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "33 GET /billing/eligibility/latest",
    method: "GET",
    url: `/api/v1/billing/eligibility/latest?patientId=${PATIENT}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },

  // ── sequestration-policy plane (routes #32-33 + the active-on-now convenience) ─────────────────────────
  {
    label: "34 GET /billing/sequestration-policies",
    method: "GET",
    url: `/api/v1/billing/sequestration-policies?providerEntityId=${PROVIDER_ENTITY}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "35 GET /billing/sequestration-policies/active",
    method: "GET",
    url: `/api/v1/billing/sequestration-policies/active?providerEntityId=${PROVIDER_ENTITY}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "36 POST /billing/sequestration-policies",
    method: "POST",
    url: "/api/v1/billing/sequestration-policies",
    headers: { ...SUPER_HEADERS, ...IDEMP("r36") },
    payload: {
      providerEntityId: PROVIDER_ENTITY,
      percentage: "2.00",
      effectiveFrom: "2030-01-01",
      setReason: "forward-dated test policy row",
    },
    expectStatus: 201,
  },

  // ── MAC-credential admin (routes #34-35) ────────────────────────────────────────────────────────────
  {
    label: "37 GET /billing/mac-credentials",
    method: "GET",
    url: "/api/v1/billing/mac-credentials",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "38 GET /billing/mac-credentials/:providerEntityId",
    method: "GET",
    url: `/api/v1/billing/mac-credentials/${PROVIDER_ENTITY}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "39 POST /billing/mac-credentials",
    method: "POST",
    url: "/api/v1/billing/mac-credentials",
    headers: { ...SUPER_HEADERS, ...IDEMP("r39") },
    payload: {
      providerEntityId: PROVIDER_ENTITY,
      macJurisdiction: "ngs_j6",
      submitterId: "SUB1",
      tradingPartnerId: "TP1",
      clientId: "CID1",
      clientSecret: "a-write-only-secret-value",
    },
    expectStatus: 201,
  },

  // ── GAP-144: override audit view (#17) + MAC credential sandbox test (#36) ─────────────────────────
  {
    label: "17 GET /billing/validation-overrides",
    method: "GET",
    url: `/api/v1/billing/validation-overrides?providerEntityId=${PROVIDER_ENTITY}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "17b GET /billing/validation-overrides without billing.validation.read_override is 403",
    method: "GET",
    url: `/api/v1/billing/validation-overrides?providerEntityId=${PROVIDER_ENTITY}`,
    headers: NONE_HEADERS,
    expectStatus: 403,
  },
  {
    label: "36 POST /billing/mac-credentials/:providerEntityId/test",
    method: "POST",
    url: `/api/v1/billing/mac-credentials/${PROVIDER_ENTITY}/test`,
    headers: { ...SUPER_HEADERS, ...IDEMP("r36") },
    expectStatus: 200,
  },

  // ── dashboards / metrics (routes #37-38) ────────────────────────────────────────────────────────────
  {
    label: "40 GET /billing/ar-dashboard",
    method: "GET",
    url: "/api/v1/billing/ar-dashboard",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "41 GET /billing/metrics",
    method: "GET",
    url: "/api/v1/billing/metrics",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },

  // ── internal service-to-service seam (routes #39-40; SYSTEM principal only) ────────────────────────────
  {
    label: "42 GET /internal/billing/claim-day-projection",
    method: "GET",
    url: `/api/v1/internal/billing/claim-day-projection?organizationId=${ORG}&mode=org_fiscal_year&providerEntityId=${PROVIDER_ENTITY}&fyEnd=2026-09-30`,
    headers: SYSTEM_HEADERS,
    expectStatus: 200,
  },
  {
    label: "43 GET /internal/billing/submissions",
    method: "GET",
    url: `/api/v1/internal/billing/submissions?organizationId=${ORG}&providerEntityId=${PROVIDER_ENTITY}&from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z`,
    headers: SYSTEM_HEADERS,
    expectStatus: 200,
  },
];

describe.each(ROUTE_CASES)("M23 route smoke — $label", (c) => {
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

// ── the internal seam's SYSTEM-principal lock — a non-system session is refused even holding every M23
// permission key (`requireSystemPrincipal()` is the second, independent lock on top of RBAC). ────────────
describe("M23 route smoke — the /internal seam's system-principal lock", () => {
  it("403s a staff session (no `system` actorKind) even with every M23 grant", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/internal/billing/submissions?organizationId=${ORG}&providerEntityId=${PROVIDER_ENTITY}&from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z`,
      headers: SUPER_HEADERS, // holds every M23 permission key, but carries no system actorKind
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

// DB-005's forward-only write-time validation lives in buildDrizzleM23WriteService
// (write-service-drizzle.ts), NOT in this file's hand-rolled fake writeService — this file is a
// WIRING smoke test over the fake (see the file banner), so it cannot exercise real business-rule
// enforcement. See write-service-drizzle.test.ts for the actual proof.
