// apps/backend/__tests__/billing-medicaid-inject.test.ts — M24 (Billing — Medicaid) HTTP-layer smoke suite
// (TASK-050A / TEST-001).
//
// M24 had ZERO Fastify `.inject()` coverage before this file. Its existing suites (rule-registry, claim
// reducers, etc., per `packages/medicaid-adapters/__tests__` and any `routes/*.test.ts` under this module)
// exercise pure functions and service contracts directly — none of them drives a request through the FULL
// M1 middleware chain (auth → RBAC → ABAC → TypeBox → handler), so a mis-wired guard, a typo'd permission
// key, an ABAC predicate name that does not resolve, or a request schema that silently drifted from the
// route body it guards is invisible to every one of them. This file closes that gap, cloned from
// `orders-routes.test.ts` (the reference implementation) via the `discipline-plans-inject.test.ts` /
// `oncall-inject.test.ts` precedent: `buildServer()` mounts the host, `mountM24Routes()` mounts the six
// §4.1 route plugins (claims/validation/AR · rule-config · eligibility · room-and-board · trading-partner ·
// platform-admin) over a hand-rolled in-memory `{ readService, writeService }` pair — M24 ships no
// `createInMemory*Backend` for the ROUTE surface (`createInMemoryM24ConsumerStore` and
// `createInMemoryMedicaidRedactStore` cover the upstream-consumer and eraser/redaction concerns only, not
// this module's eighteen route-facing service methods), so this file is that backend, scoped to this file
// only. The REAL Authorization Contract gates every route on the real §4.7 permission keys
// (`M24_PERMISSION_KEY_LIST`), and the REAL `buildM24AbacPredicates` resolves the six §4.8 predicates M24
// owns, closed over a resolver reading this same in-memory claim/arrangement/validation-result state — the
// `buildOrderAbacPredicates`-over-`createInMemoryOrderBackend` pattern M11's test established. A permissive
// `step_up_recent` stub is registered alongside them (this file's own fresh predicate registry, never the
// shared boot one) so the submit/replace/void/override/activate/terminate/credential-admin/platform-admin
// routes' `requireStepUp` gate has a real PASSING path here, matching the M15/M19 precedent (asserting 403
// on every step-up route would leave their 2xx path completely unexercised).
//
// The business RULES (the §2.1-§2.3 claim state machine, the §4.6 rule-engine outcomes, the §418.xx R&B
// per-diem math) are NOT this file's job — they belong to the pure `@chartwarden/medicaid-adapters` suites and
// the Drizzle live suite. This file's in-memory service intentionally skips that logic (no state-machine
// validation, no rule execution) so it can focus on what only `inject()` can prove: every one of the
// thirty-nine routes reaches its handler with the RIGHT permission key, the RIGHT ABAC composition, and a
// body that TypeBox actually validates — a 401 with no session, a 403 with no grant, a 422 on a malformed
// body, and one legitimately-authorized 2xx call per route.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { NotFoundError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  M24_PERMISSION_KEY_LIST,
  type ReadingM24AbacResolver,
  buildM24AbacPredicates,
  mountM24Routes,
} from "../src/modules/24-billing-medicaid/index";
import type {
  AcknowledgmentView,
  ArDashboardView,
  ArMetricsView,
  ClaimLineView,
  ClaimView,
  EligibilityCheckView,
  M24ReadService,
  RbArrangementView,
  RbDayView,
  RuleConfigView,
  SubmissionView,
  TradingPartnerCredentialView,
  ValidationOverrideView,
  ValidationResultView,
  ValidationRunView,
} from "../src/modules/24-billing-medicaid/routes/read-service";
import type { M24WriteService } from "../src/modules/24-billing-medicaid/routes/write-service";

// ── the header-auth shim (the M11/M15 precedent), extended with `x-test-pe` (session provider-entity
// scope — M24's §4.8 predicates read `context.providerEntityIds`) and an always-fresh `stepUpRecent` (the
// M15 posture: the step-up routes always have a PASSING path in this file).
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const pe = request.headers["x-test-pe"];
  request.context.providerEntityIds = typeof pe === "string" && pe.length > 0 ? pe.split(",") : [];
  request.context.attributes.stepUpRecent = true;
}

// ── fixed ids (the M11/M15 style — distinct, valid-`uuid`-format constants) ──────────────────────────────
const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "22222222-2222-4222-8222-222222222222";
const PE = "33333333-3333-4333-8333-333333333333";
const MCO = "44444444-4444-4444-8444-444444444444";
const CLAIM = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";
const RESULT = "77777777-7777-4777-8777-777777777777";
const NF_FACILITY = "88888888-8888-4888-8888-888888888888";
const ARR = "99999999-9999-4999-8999-999999999999";
const DAY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CRED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PAYER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LINE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SUBMISSION = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ACK = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const NOW = "2026-07-30T12:00:00.000Z";
const CUSTOM_RULE_KEY = "custom_test_rule";
/** medicaid_eligibility_active carries `overrideRoleRequired: "billing_manager"` — the one platform-default
 * rule this file needs a name for (the §4.8 `medicaid_override_role_eligible` predicate's real dispatch). */
const OVERRIDE_ELIGIBLE_RULE_KEY = "medicaid_eligibility_active";
const REASON =
  "This is a documented business justification that exceeds the forty-character CHECK floor.";

// ── the in-memory M24 backend (this file's own — M24 ships no route-facing `createInMemory*Backend`) ─────
function createM24Backend(): {
  readonly readService: M24ReadService;
  readonly writeService: M24WriteService;
  readonly abacResolver: ReadingM24AbacResolver;
} {
  const claims = new Map<string, ClaimView>();
  const claimLines = new Map<string, ClaimLineView[]>();
  const submissions = new Map<string, SubmissionView[]>();
  const acknowledgments = new Map<string, AcknowledgmentView[]>();
  const validationRuns = new Map<string, ValidationRunView>();
  const validationResults = new Map<string, ValidationResultView & { medicaidClaimId: string }>();
  const overrides: ValidationOverrideView[] = [];
  const ruleConfigs = new Map<string, RuleConfigView>();
  const eligibilityChecks: EligibilityCheckView[] = [];
  const arrangements = new Map<string, RbArrangementView>();
  const rbDays = new Map<string, RbDayView>();
  const credentials = new Map<string, TradingPartnerCredentialView>();
  let seq = 0;
  const newId = (prefix: string): string => `${prefix}-${++seq}`;

  claims.set(CLAIM, {
    id: CLAIM,
    providerEntityId: PE,
    patientId: PATIENT,
    admissionId: ADMISSION,
    serviceState: "OR",
    kind: "combined_hospice_rb",
    tob: "811",
    serviceFrom: "2026-07-01",
    serviceTo: "2026-07-31",
    mcoId: null,
    medicareClaimId: null,
    rbArrangementId: null,
    medicaidClaimControlNumber: "MCN-0001",
    state: "DRAFT",
    version: 1,
    validationRunIdLatest: RUN,
    eligibilityOutcomeSnapshot: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

  claimLines.set(CLAIM, [
    {
      id: LINE,
      medicaidClaimId: CLAIM,
      lineNumber: 1,
      serviceDate: "2026-07-01",
      revenueCode: "0651",
      qCode: "Q5001",
      levelOfCare: "RHC",
      units: 1,
      rateAtAssemblyCents: 15000,
      chargesCents: 15000,
      cobPaidCents: null,
      isRb: false,
      rbDayId: null,
    },
  ]);

  submissions.set(CLAIM, [
    {
      id: SUBMISSION,
      medicaidClaimId: CLAIM,
      serviceState: "OR",
      channel: "direct_mmis",
      medicaidClaimControlNumber: "MCN-0001",
      attemptIndex: 1,
      adapterVendor: "test-adapter",
      adapterVersion: "1.0.0",
      result: "accepted_sync",
      errorCode: null,
      nextPollAt: null,
      submittedAt: NOW,
      createdAt: NOW,
    },
  ]);

  acknowledgments.set(CLAIM, [
    {
      id: ACK,
      medicaidClaimId: CLAIM,
      medicaidSubmissionId: SUBMISSION,
      kind: "sync_999",
      outcome: "accepted",
      payerClaimControlNumber: "PCN-1",
      acceptedLineNumbers: [1],
      rejectedLineNumbers: [],
      errorCodes: [],
      receivedAt: NOW,
    },
  ]);

  validationRuns.set(RUN, {
    id: RUN,
    medicaidClaimId: CLAIM,
    ruleRegistryVersion: "1",
    triggeredBy: "manual",
    claimStateAtTrigger: "DRAFT",
    at: NOW,
    completedAt: NOW,
    totalResults: 1,
    failedResults: 1,
    warnedResults: 0,
    results: [
      {
        id: RESULT,
        medicaidValidationRunId: RUN,
        ruleKey: OVERRIDE_ELIGIBLE_RULE_KEY,
        ruleVersion: 1,
        outcome: "fail",
        remediationSummary: null,
        remediationFixAction: null,
        at: NOW,
      },
    ],
  });

  validationResults.set(RESULT, {
    id: RESULT,
    medicaidValidationRunId: RUN,
    ruleKey: OVERRIDE_ELIGIBLE_RULE_KEY,
    ruleVersion: 1,
    outcome: "fail",
    remediationSummary: null,
    remediationFixAction: null,
    at: NOW,
    medicaidClaimId: CLAIM,
  });

  ruleConfigs.set(CUSTOM_RULE_KEY, {
    ruleKey: CUSTOM_RULE_KEY,
    enabled: true,
    isCustom: true,
    customSeverity: "warn",
    customOverrideRole: null,
    regulatoryRequired: false,
    parametersOverlay: {},
    version: 1,
  });

  eligibilityChecks.push({
    id: newId("elig"),
    patientId: PATIENT,
    patientPayerId: PAYER,
    serviceState: "OR",
    asOfServiceDate: "2026-07-01",
    outcome: "active",
    mcoId: null,
    recipientIdMaskedAtCheck: "****1234",
    checkedAt: NOW,
    staleAt: NOW,
    errorMessage: null,
  });

  arrangements.set(ARR, {
    id: ARR,
    patientId: PATIENT,
    providerEntityId: PE,
    nfFacilityMdmId: NF_FACILITY,
    nfFacilityNameSnapshot: "Test NF",
    effectiveFrom: "2026-07-01",
    effectiveTo: null,
    nfPerDiemRoutineCents: 15000,
    nfPerDiemRespCents: 20000,
    nfPerDiemGipCents: 30000,
    passThroughPct: 95,
    retentionPct: 5,
    state: "DRAFT",
    version: 1,
    createdAt: NOW,
  });

  rbDays.set(DAY, {
    id: DAY,
    rbArrangementId: ARR,
    patientId: PATIENT,
    serviceDate: "2026-07-05",
    locOfDay: "NF_RB",
    perDiemCentsSnapshot: 15000,
    status: "pending",
    exclusionReason: null,
    medicaidClaimLineId: null,
    version: 1,
  });

  credentials.set(CRED, {
    id: CRED,
    providerEntityId: PE,
    serviceState: "OR",
    channel: "direct_mmis",
    mcoId: null,
    tradingPartnerId: "TP-1",
    clientId: null,
    sftpHost: null,
    portalUrl: null,
    activeFrom: "2026-01-01",
    activeTo: null,
    lastSandboxTestAt: null,
    lastSandboxTestResult: null,
    version: 1,
    hasClientSecret: false,
    hasSftpKey: false,
  });

  const readService: M24ReadService = {
    async listClaims() {
      return { items: [...claims.values()], nextCursor: null };
    },
    async getClaim(_actor, claimId) {
      return claims.get(claimId) ?? null;
    },
    async listClaimLines(_actor, claimId) {
      return claimLines.get(claimId) ?? [];
    },
    async listSubmissions(_actor, claimId) {
      return submissions.get(claimId) ?? [];
    },
    async listAcknowledgments(_actor, claimId) {
      return acknowledgments.get(claimId) ?? [];
    },
    async getValidationRun(_actor, runId) {
      return validationRuns.get(runId) ?? null;
    },
    async listValidationRuns(_actor, claimId) {
      return [...validationRuns.values()].filter((r) => r.medicaidClaimId === claimId);
    },
    async listOverrides() {
      return overrides;
    },
    async validationWorklist() {
      return { groups: [], blockedClaimCount: 0, unattributedClaimCount: 0, truncated: false };
    },
    async listRuleConfig() {
      return [...ruleConfigs.values()];
    },
    async listEligibilityChecks() {
      return eligibilityChecks;
    },
    async listRbArrangements() {
      return [...arrangements.values()];
    },
    async getRbArrangement(_actor, arrangementId) {
      const row = arrangements.get(arrangementId);
      if (!row) return null;
      return {
        ...row,
        days: [...rbDays.values()].filter((d) => d.rbArrangementId === arrangementId),
      };
    },
    async listRbDays() {
      return [...rbDays.values()];
    },
    async listTradingPartnerCredentials() {
      return [...credentials.values()];
    },
    async arDashboard(): Promise<ArDashboardView> {
      return { totalOpen: 0, buckets: [], byState: [] };
    },
    async arMetrics(): Promise<ArMetricsView> {
      return { denialRate: 0, openCount: 0, byMco: [], aging: [] };
    },
  };

  const writeService: M24WriteService = {
    async assembleClaim(_actor, input) {
      const id = newId("claim");
      const row: ClaimView = {
        id,
        providerEntityId: input.providerEntityId,
        patientId: input.patientId,
        admissionId: input.admissionId,
        serviceState: "OR",
        kind: input.kind,
        tob: "811",
        serviceFrom: input.serviceFrom,
        serviceTo: input.serviceTo,
        mcoId: null,
        medicareClaimId: input.medicareClaimId ?? null,
        rbArrangementId: input.rbArrangementId ?? null,
        medicaidClaimControlNumber: `MCN-${id}`,
        state: "DRAFT",
        version: 1,
        validationRunIdLatest: null,
        eligibilityOutcomeSnapshot: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      claims.set(id, row);
      return row;
    },
    async updateDraftClaim(_actor, claimId, input) {
      const row = claims.get(claimId);
      if (!row) throw new NotFoundError("claim not found");
      const updated: ClaimView = {
        ...row,
        mcoId: input.mcoId ?? row.mcoId,
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
      const runId = newId("run");
      validationRuns.set(runId, {
        id: runId,
        medicaidClaimId: claimId,
        ruleRegistryVersion: "1",
        triggeredBy: "manual",
        claimStateAtTrigger: "DRAFT",
        at: NOW,
        completedAt: NOW,
        totalResults: 0,
        failedResults: 0,
        warnedResults: 0,
      });
      return { validationRunId: runId };
    },
    async submitClaim(_actor, claimId) {
      const row = claims.get(claimId);
      if (!row) throw new NotFoundError("claim not found");
      const updated: ClaimView = {
        ...row,
        state: "SUBMITTED",
        version: row.version + 1,
        updatedAt: NOW,
      };
      claims.set(claimId, updated);
      return updated;
    },
    async replaceClaim(_actor, claimId) {
      const row = claims.get(claimId);
      if (!row) throw new NotFoundError("claim not found");
      const id = newId("claim-replace");
      const replacement: ClaimView = {
        ...row,
        id,
        tob: "817",
        state: "DRAFT",
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      claims.set(id, replacement);
      return replacement;
    },
    async voidClaim(_actor, claimId) {
      const row = claims.get(claimId);
      if (!row) throw new NotFoundError("claim not found");
      const id = newId("claim-void");
      const voided: ClaimView = {
        ...row,
        id,
        tob: "818",
        state: "VOIDED",
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      claims.set(id, voided);
      return voided;
    },
    async abandonClaim(_actor, claimId) {
      const row = claims.get(claimId);
      if (!row) throw new NotFoundError("claim not found");
      const updated: ClaimView = {
        ...row,
        state: "ABANDONED",
        version: row.version + 1,
        updatedAt: NOW,
      };
      claims.set(claimId, updated);
      return updated;
    },
    async applyOverride(actor, resultId, input) {
      const result = validationResults.get(resultId);
      if (!result) throw new NotFoundError("validation result not found");
      const overrideId = newId("override");
      overrides.push({
        id: overrideId,
        medicaidValidationResultId: resultId,
        medicaidClaimId: result.medicaidClaimId,
        ruleKey: result.ruleKey,
        overrideRoleApplied: input.overrideRoleClaimed,
        reason: input.reason,
        actorMembershipId: actor.userId,
        at: NOW,
      });
      return { overrideId };
    },
    async editRuleConfig(_actor, ruleKey, input) {
      const row = ruleConfigs.get(ruleKey);
      if (!row) throw new NotFoundError("rule config not found");
      ruleConfigs.set(ruleKey, {
        ...row,
        enabled: input.enabled ?? row.enabled,
        parametersOverlay: input.parametersOverlay ?? row.parametersOverlay,
        version: (row.version ?? 0) + 1,
      });
    },
    async createCustomRule(_actor, input) {
      ruleConfigs.set(input.ruleKey, {
        ruleKey: input.ruleKey,
        enabled: true,
        isCustom: true,
        customSeverity: input.customSeverity,
        customOverrideRole: input.customOverrideRole ?? null,
        regulatoryRequired: false,
        parametersOverlay: input.customPredicateDsl,
        version: 1,
      });
      return { ruleKey: input.ruleKey };
    },
    async deleteCustomRule(_actor, ruleKey) {
      ruleConfigs.delete(ruleKey);
    },
    async refreshEligibility(_actor, input) {
      const checkId = newId("elig");
      eligibilityChecks.push({
        id: checkId,
        patientId: input.patientId,
        patientPayerId: input.patientPayerId,
        serviceState: "OR",
        asOfServiceDate: input.asOfServiceDate,
        outcome: "active",
        mcoId: null,
        recipientIdMaskedAtCheck: "****1234",
        checkedAt: NOW,
        staleAt: NOW,
        errorMessage: null,
      });
      return { checkId, outcome: "active" };
    },
    async createRbArrangement(_actor, input) {
      const id = newId("rb");
      const row: RbArrangementView = {
        id,
        patientId: input.patientId,
        providerEntityId: input.providerEntityId,
        nfFacilityMdmId: input.nfFacilityMdmId,
        nfFacilityNameSnapshot: "Test NF",
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        nfPerDiemRoutineCents: input.nfPerDiemRoutineCents,
        nfPerDiemRespCents: input.nfPerDiemRespCents,
        nfPerDiemGipCents: input.nfPerDiemGipCents,
        passThroughPct: input.passThroughPct,
        retentionPct: input.retentionPct,
        state: "DRAFT",
        version: 1,
        createdAt: NOW,
      };
      arrangements.set(id, row);
      return row;
    },
    async editRbArrangement(_actor, arrangementId, input) {
      const row = arrangements.get(arrangementId);
      if (!row) throw new NotFoundError("R&B arrangement not found");
      const updated: RbArrangementView = {
        ...row,
        effectiveTo: input.effectiveTo ?? row.effectiveTo,
        nfPerDiemRoutineCents: input.nfPerDiemRoutineCents ?? row.nfPerDiemRoutineCents,
        nfPerDiemRespCents: input.nfPerDiemRespCents ?? row.nfPerDiemRespCents,
        nfPerDiemGipCents: input.nfPerDiemGipCents ?? row.nfPerDiemGipCents,
        version: row.version + 1,
      };
      arrangements.set(arrangementId, updated);
      return updated;
    },
    async activateRbArrangement(_actor, arrangementId) {
      const row = arrangements.get(arrangementId);
      if (!row) throw new NotFoundError("R&B arrangement not found");
      const updated: RbArrangementView = { ...row, state: "ACTIVE", version: row.version + 1 };
      arrangements.set(arrangementId, updated);
      return updated;
    },
    async terminateRbArrangement(_actor, arrangementId) {
      const row = arrangements.get(arrangementId);
      if (!row) throw new NotFoundError("R&B arrangement not found");
      const updated: RbArrangementView = { ...row, state: "TERMINATED", version: row.version + 1 };
      arrangements.set(arrangementId, updated);
      return updated;
    },
    async overrideRbDay(_actor, rbDayId, input) {
      const row = rbDays.get(rbDayId);
      if (!row) throw new NotFoundError("rb day not found");
      rbDays.set(rbDayId, {
        ...row,
        status: input.status,
        exclusionReason: input.exclusionReason ?? row.exclusionReason,
        version: row.version + 1,
      });
    },
    async upsertCredential(_actor, input) {
      const id = newId("cred");
      credentials.set(id, {
        id,
        providerEntityId: input.providerEntityId,
        serviceState: input.serviceState,
        channel: input.channel,
        mcoId: input.mcoId ?? null,
        tradingPartnerId: input.tradingPartnerId,
        clientId: input.clientId ?? null,
        sftpHost: input.sftpHost ?? null,
        portalUrl: input.portalUrl ?? null,
        activeFrom: input.activeFrom,
        activeTo: input.activeTo ?? null,
        lastSandboxTestAt: null,
        lastSandboxTestResult: null,
        version: 1,
        hasClientSecret: !!input.clientSecret,
        hasSftpKey: !!input.sftpKey,
      });
      return { id };
    },
    async testCredential(_actor, credentialId) {
      const row = credentials.get(credentialId);
      if (!row) throw new NotFoundError("credential not found");
      return { ok: true };
    },
    async registerPlatformRule() {
      // no-op — the FROZEN code-defined registry posture (M24 admin.routes.ts banner).
    },
    async loadRateSchedule() {
      return { queued: true };
    },
  };

  const abacResolver: ReadingM24AbacResolver = {
    async loadClaim(_ctx, claimId) {
      const row = claims.get(claimId);
      return row ? { providerEntityId: row.providerEntityId, patientId: row.patientId } : null;
    },
    async loadArrangementPe(_ctx, arrangementId) {
      return arrangements.get(arrangementId)?.providerEntityId ?? null;
    },
    async loadRbDayPe(_ctx, rbDayId) {
      const day = rbDays.get(rbDayId);
      return day ? (arrangements.get(day.rbArrangementId)?.providerEntityId ?? null) : null;
    },
    async loadResultRuleKey(_ctx, resultId) {
      return validationResults.get(resultId)?.ruleKey ?? null;
    },
  };

  return { readService, writeService, abacResolver };
}

// ── server assembly (the M11 `makeServer()` precedent) ──────────────────────────────────────────────────
const SUPER_HEADERS = {
  "x-test-user": "super_1",
  "x-test-org": ORG,
  "x-test-roles": "billing_manager,org_admin,compliance_officer,medical_director",
  "x-test-pe": PE,
};
const NONE_HEADERS = {
  "x-test-user": "none_1",
  "x-test-org": ORG,
  "x-test-roles": "",
  "x-test-pe": PE,
};

function makeServer() {
  const backend = createM24Backend();

  const grantStore = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "super_1",
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
  registerEffectivePermissionResolver(grantStore.store);

  // A FRESH predicate registry per server (the M11-T06 precedent): the six §4.8 predicates M24 owns, built
  // over THIS backend's resolver, plus a permissive `step_up_recent` stub so the submit/replace/void/
  // override/activate/terminate/credential-admin/platform-admin routes' `requireStepUp` gate has a real
  // PASSING path in this file (see the file banner).
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(
    buildM24AbacPredicates({ resolver: backend.abacResolver }),
  )) {
    reg.register(name, predicate);
  }
  reg.register("step_up_recent", async () => true);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM24Routes(app, { readService: backend.readService, writeService: backend.writeService });
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
describe("M24 route smoke — the M1 boundary", () => {
  it("401s with no session at all", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/medicaid-claims" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("403s a permission-gated route for a session holding NO M24 grants", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/medicaid-claims",
      headers: NONE_HEADERS,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("422s a malformed body from an otherwise-authorized caller (TypeBox validation, M1 envelope)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/medicaid-rule-config/custom",
      headers: { ...SUPER_HEADERS, "idempotency-key": "k-422" },
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

const ROUTE_CASES: readonly RouteCase[] = [
  // ── claims.routes.ts (routes 1-17, 35, 36, 39) ────────────────────────────────────────────────────────
  {
    label: "1 POST /medicaid-claims (assemble)",
    method: "POST",
    url: "/api/v1/medicaid-claims",
    headers: { ...SUPER_HEADERS, ...IDEMP("k1") },
    payload: {
      patientId: PATIENT,
      admissionId: ADMISSION,
      providerEntityId: PE,
      serviceFrom: "2026-07-01",
      serviceTo: "2026-07-31",
      kind: "combined_hospice_rb",
    },
    expectStatus: 201,
  },
  {
    label: "2 GET /medicaid-claims (list)",
    method: "GET",
    url: "/api/v1/medicaid-claims",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "3 GET /medicaid-claims/:id",
    method: "GET",
    url: `/api/v1/medicaid-claims/${CLAIM}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "4 PATCH /medicaid-claims/:id",
    method: "PATCH",
    url: `/api/v1/medicaid-claims/${CLAIM}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k4") },
    payload: { mcoId: MCO },
    expectStatus: 200,
  },
  {
    label: "5 DELETE /medicaid-claims/:id",
    method: "DELETE",
    url: `/api/v1/medicaid-claims/${CLAIM}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k5") },
    expectStatus: 204,
  },
  {
    label: "6 POST /medicaid-claims/:id/validate",
    method: "POST",
    url: `/api/v1/medicaid-claims/${CLAIM}/validate`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k6") },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "7 POST /medicaid-claims/:id/submit",
    method: "POST",
    url: `/api/v1/medicaid-claims/${CLAIM}/submit`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k7") },
    payload: { channelHint: "direct_mmis" },
    expectStatus: 200,
  },
  {
    label: "8 POST /medicaid-claims/:id/replace",
    method: "POST",
    url: `/api/v1/medicaid-claims/${CLAIM}/replace`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k8") },
    payload: { reason: REASON },
    expectStatus: 201,
  },
  {
    label: "9 POST /medicaid-claims/:id/void",
    method: "POST",
    url: `/api/v1/medicaid-claims/${CLAIM}/void`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k9") },
    payload: { reason: REASON },
    expectStatus: 201,
  },
  {
    label: "10 POST /medicaid-claims/:id/abandon",
    method: "POST",
    url: `/api/v1/medicaid-claims/${CLAIM}/abandon`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k10") },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "11 GET /medicaid-claims/:id/lines",
    method: "GET",
    url: `/api/v1/medicaid-claims/${CLAIM}/lines`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "12 GET /medicaid-claims/:id/submissions",
    method: "GET",
    url: `/api/v1/medicaid-claims/${CLAIM}/submissions`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "13 GET /medicaid-claims/:id/acknowledgments",
    method: "GET",
    url: `/api/v1/medicaid-claims/${CLAIM}/acknowledgments`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "14 GET /medicaid-validation-runs/:id",
    method: "GET",
    url: `/api/v1/medicaid-validation-runs/${RUN}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "15 GET /medicaid-claims/:id/validation-runs",
    method: "GET",
    url: `/api/v1/medicaid-claims/${CLAIM}/validation-runs`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "16 POST /medicaid-validation-results/:id/override",
    method: "POST",
    url: `/api/v1/medicaid-validation-results/${RESULT}/override`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k16") },
    payload: { reason: REASON, overrideRoleClaimed: "billing_manager" },
    expectStatus: 201,
  },
  {
    label: "17 GET /medicaid-validation-overrides",
    method: "GET",
    url: "/api/v1/medicaid-validation-overrides",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "35 GET /medicaid-ar-dashboard",
    method: "GET",
    url: "/api/v1/medicaid-ar-dashboard",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "36 GET /medicaid-ar-dashboard/metrics",
    method: "GET",
    url: "/api/v1/medicaid-ar-dashboard/metrics",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "39 GET /medicaid-validation-worklist",
    method: "GET",
    url: "/api/v1/medicaid-validation-worklist",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },

  // ── rule-config.routes.ts (routes 18-21) ──────────────────────────────────────────────────────────────
  {
    label: "18 GET /medicaid-rule-config",
    method: "GET",
    url: "/api/v1/medicaid-rule-config",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "19 PATCH /medicaid-rule-config/:ruleKey",
    method: "PATCH",
    url: `/api/v1/medicaid-rule-config/${CUSTOM_RULE_KEY}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k19"), ...IFM },
    payload: { enabled: false },
    expectStatus: 204,
  },
  {
    label: "20 POST /medicaid-rule-config/custom",
    method: "POST",
    url: "/api/v1/medicaid-rule-config/custom",
    headers: { ...SUPER_HEADERS, ...IDEMP("k20") },
    payload: {
      ruleKey: "custom_rule_created_1",
      customPredicateDsl: { op: "always_pass" },
      customSeverity: "warn",
    },
    expectStatus: 201,
  },
  {
    label: "21 DELETE /medicaid-rule-config/:ruleKey",
    method: "DELETE",
    url: `/api/v1/medicaid-rule-config/${CUSTOM_RULE_KEY}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k21"), ...IFM },
    expectStatus: 204,
  },

  // ── eligibility.routes.ts (routes 22-23) ──────────────────────────────────────────────────────────────
  {
    label: "22 POST /medicaid-eligibility-checks",
    method: "POST",
    url: "/api/v1/medicaid-eligibility-checks",
    headers: { ...SUPER_HEADERS, ...IDEMP("k22") },
    payload: {
      patientId: PATIENT,
      patientPayerId: PAYER,
      asOfServiceDate: "2026-07-01",
      providerEntityId: PE,
    },
    expectStatus: 202,
  },
  {
    label: "23 GET /medicaid-eligibility-checks",
    method: "GET",
    url: "/api/v1/medicaid-eligibility-checks",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },

  // ── rb.routes.ts (routes 24-31) ───────────────────────────────────────────────────────────────────────
  {
    label: "24 POST /rb-arrangements",
    method: "POST",
    url: "/api/v1/rb-arrangements",
    headers: { ...SUPER_HEADERS, ...IDEMP("k24") },
    payload: {
      patientId: PATIENT,
      providerEntityId: PE,
      nfFacilityMdmId: NF_FACILITY,
      effectiveFrom: "2026-07-01",
      nfPerDiemRoutineCents: 15000,
      nfPerDiemRespCents: 20000,
      nfPerDiemGipCents: 30000,
      passThroughPct: 95,
      retentionPct: 5,
    },
    expectStatus: 201,
  },
  {
    label: "25 GET /rb-arrangements",
    method: "GET",
    url: "/api/v1/rb-arrangements",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "26 GET /rb-arrangements/:id",
    method: "GET",
    url: `/api/v1/rb-arrangements/${ARR}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "27 PATCH /rb-arrangements/:id",
    method: "PATCH",
    url: `/api/v1/rb-arrangements/${ARR}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k27"), ...IFM },
    payload: { nfPerDiemRoutineCents: 16000 },
    expectStatus: 200,
  },
  {
    label: "28 POST /rb-arrangements/:id/activate",
    method: "POST",
    url: `/api/v1/rb-arrangements/${ARR}/activate`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k28"), ...IFM },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "29 POST /rb-arrangements/:id/terminate",
    method: "POST",
    url: `/api/v1/rb-arrangements/${ARR}/terminate`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k29"), ...IFM },
    payload: { reason: REASON },
    expectStatus: 200,
  },
  {
    label: "30 GET /rb-days",
    method: "GET",
    url: "/api/v1/rb-days",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "31 PATCH /rb-days/:id",
    method: "PATCH",
    url: `/api/v1/rb-days/${DAY}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k31"), ...IFM },
    payload: { status: "excluded", exclusionReason: "Test exclusion reason for smoke coverage." },
    expectStatus: 204,
  },

  // ── trading-partner.routes.ts (routes 32-34) ──────────────────────────────────────────────────────────
  {
    label: "32 GET /state-medicaid-trading-partner-credentials",
    method: "GET",
    url: "/api/v1/state-medicaid-trading-partner-credentials",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "33 POST /state-medicaid-trading-partner-credentials",
    method: "POST",
    url: "/api/v1/state-medicaid-trading-partner-credentials",
    headers: { ...SUPER_HEADERS, ...IDEMP("k33") },
    payload: {
      providerEntityId: PE,
      serviceState: "OR",
      channel: "direct_mmis",
      tradingPartnerId: "TP-SMOKE-1",
      activeFrom: "2026-01-01",
    },
    expectStatus: 201,
  },
  {
    label: "34 POST /state-medicaid-trading-partner-credentials/:id/test",
    method: "POST",
    url: `/api/v1/state-medicaid-trading-partner-credentials/${CRED}/test`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k34") },
    payload: {},
    expectStatus: 200,
  },

  // ── admin.routes.ts (routes 37-38) ────────────────────────────────────────────────────────────────────
  {
    label: "37 POST /admin/platform-medicaid-rules",
    method: "POST",
    url: "/api/v1/admin/platform-medicaid-rules",
    headers: { ...SUPER_HEADERS, ...IDEMP("k37") },
    payload: {
      ruleKey: "platform_test_rule",
      title: "Test Rule",
      category: "eligibility",
      severity: "warn",
    },
    expectStatus: 202,
  },
  {
    label: "38 POST /admin/state-rate-schedule-load",
    method: "POST",
    url: "/api/v1/admin/state-rate-schedule-load",
    headers: { ...SUPER_HEADERS, ...IDEMP("k38") },
    payload: { serviceState: "OR", effectiveYear: 2026 },
    expectStatus: 202,
  },
];

describe.each(ROUTE_CASES)("M24 route smoke — $label", (c) => {
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

// GAP-145 — provider-entity scoping: an actor scoped to another provider entity cannot reach this PE's claim
// or R&B day, even though RBAC passes and the row is in the same org.
describe("GAP-145 — M24 claim / R&B authorization is provider-entity scoped", () => {
  const OTHER_PE_HEADERS = {
    ...SUPER_HEADERS,
    "x-test-pe": "99999999-9999-4999-8999-999999999999",
  };

  it("a claim of another provider entity is a non-leaking 404 (RBAC passes, ABAC denies)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/medicaid-claims/${CLAIM}`,
      headers: OTHER_PE_HEADERS,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("the actor's own provider entity still reads the claim", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/medicaid-claims/${CLAIM}`,
      headers: SUPER_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("PATCH /rb-days/:id on another provider entity's day is a 404 and never reaches the handler", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/rb-days/${DAY}`,
      headers: { ...OTHER_PE_HEADERS, ...IDEMP("g145-rb") },
      payload: { status: "excluded", exclusionReason: "x", reason: "x" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
