// apps/backend/__tests__/ai-platform-inject.test.ts — M32-T07 (§4.1) HTTP-layer smoke suite
// (TASK-050A / TEST-001 closure for Module 32, AI Platform).
//
// Module 32 had ZERO Fastify `.inject()` coverage before this file: `ai-platform-routes.test.ts`
// (verified by inspection — it imports the permission-key list, the six §4.7 predicate builders, the
// alert catalog and the outbox catalog and asserts against them directly; it never imports `buildServer`,
// `mountM32Routes` or calls `.inject()`) proves the §4.6 catalog, the §4.7 predicate DECISIONS and the
// masking rule in isolation. `ai-invocation-pipeline.test.ts` / `-governance.test.ts` / `-safety.test.ts`
// / `-schema.test.ts` / `-seams.test.ts` / `-stride.test.ts` / `-prompt-registry.test.ts` /
// `-provenance-eraser.test.ts` / `-workflow-acceptance.test.ts` are all pure-logic or seam-registration
// tests over the same pattern. None of them proves a `requirePermission` key actually matches §4.6's
// catalog, a `requireAbac` predicate name resolves in the REAL registry, or a TypeBox schema has not
// drifted from the body it guards. This file closes that gap the `orders-routes.test.ts` (M11-T06) /
// `fhir-inject.test.ts` (M28) way: `buildServer()` mounts the host, `mountM32Routes()` mounts the seven
// §4.1 route plugins via the module's ONE aggregator, the REAL Authorization Contract gates every route
// on the real §4.6 permission keys, and the REAL `buildAiPlatformAbacPredicates` resolves the six §4.7
// predicates M32 owns into a fresh per-test registry.
//
// ── THIRTY-TWO ROUTES, ONE ACTOR ────────────────────────────────────────────────────────────────────
//
// `ai_safety_owner` (../abac-predicates.ts) passes on the SESSION's role set ALONE — it is the one M32
// predicate that is cross-tenant by design, so a single actor holding the `platform_ops` role clears
// EVERY `ABAC_SAFETY_OWNER`-gated route with no resolver call at all, and `ABAC_IN_ORG`/
// `ABAC_TENANT_CONSENT` pass for the same actor because it is also seeded as an ordinary member of `ORG`.
// So one `SUPER` fixture (`platform_ops` role, every §4.6 key granted, `x-test-step-up` fresh) reaches all
// thirty-two routes; the deny-stub resolver (`denyStubAiPlatformAbacResolver`) is used AS-IS for the four
// predicates no route in §4.1 actually binds (`ai_capability_tenant_opted_in`,
// `ai_capability_clinician_opted_out`, `ai_kill_switch_inactive`, `ai_prohibited_zone_respected` — see
// ../abac-predicates.ts's own header for why). `step_up_recent` is M3's predicate, not M32's; a fresh
// registry starts without it, so it is stubbed locally reading `context.attributes.stepUpRecent === true`
// (the M14/M19/M28 precedent for a composed-but-foreign predicate).
//
// ── THE IN-MEMORY ID GENERATORS ARE NOT UUID-SHAPED, AND EVERY §4.1 ROUTE VALIDATES UUID FORMAT ───────
//
// `createInMemoryAiGovernanceStores` / `createInMemoryAiSafetyStores` mint ids as `<prefix>-000001`
// (../governance/store.ts, ../safety/store.ts) — correct for a Postgres-backed slice test where the id
// never crosses an HTTP boundary, but every §4.1 path/body field that carries one (`capabilityId`,
// `reportId`, `runId`, `invocationId`) is typed `Type.String({format:"uuid"})` in m32-typebox.ts, which
// this module registers into TypeBox's FormatRegistry and enforces on every parse. A capability created
// through R1's own POST therefore CANNOT be used as the `:capabilityId` in a later R3/R4/R5/R7/R10/R18
// call — the non-UUID id fails validation before the handler runs. This is a test-fixture limitation, not
// a production defect: the Drizzle stores mint real `gen_random_uuid()` primary keys, so the mismatch is
// purely an artifact of composing the in-memory constructors with a UUID-validated wire contract that the
// live suites (M32 has none yet — see the module header) do not need to reconcile.
//
// The workaround, used throughout: capabilities, hallucination reports and evaluation runs whose id is
// needed as a LATER request's UUID-formatted field are PRE-SEEDED directly into the store's exposed seed
// arrays (`InMemoryAiGovernanceSeed.capabilities`, `InMemoryAiSafetySeed.reports`/`evaluationRuns` — all
// public constructor options) with a real UUID id. The CREATE routes themselves (R1, R18, R26) are still
// exercised over HTTP and asserted for their own 2xx status; their own non-UUID response id is simply
// never chained into a later call.
//
// ── R16/R17/R21/R22/R31/R32 HAVE NO IN-MEMORY BUILDER, SO THIS FILE HAND-ROLLS ONE ────────────────────
//
// `governance/store.ts`, `invocation/store.ts`, `safety/store.ts` and `prompts/store.ts` each export an
// in-memory constructor; `routes/read-service.ts` (the six-method `M32ReadService` port R16/R17/R21/R22/
// R31/R32 read through) does not, because no command service owns those six surfaces (its own header
// explains why: they are read-only tables with no write path in this module). This file hand-rolls a
// minimal `M32ReadService` directly over local seed arrays — the field-safety-inject.test.ts (M20)
// precedent for a module whose route surface has no matching in-memory backend. `recentDrift` mirrors
// `read-service-drizzle.ts`'s own `Date.now()`-based window (never an injected clock), so the pre-seeded
// `drift_response` evaluation run's `createdAt` (stamped at server-build time) always falls inside it.
import { createHash } from "node:crypto";
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
  type AiBackendRoutingRow,
  type AiCapabilityGovernanceRow,
  type AiEvaluationRunRowProjection,
  type AiGovernanceServiceDeps,
  type AiOptInEvidenceResolver,
  type AiPromptArtifactReader,
  type AiPromptServiceDeps,
  type AiSafetyServiceDeps,
  type M32ReadService,
  type M32RouteServices,
  M32_PERMISSION_KEY_LIST,
  buildAiPlatformAbacPredicates,
  createAiPromptRegistry,
  createInMemoryAiGovernanceStores,
  createInMemoryAiInvocationStores,
  createInMemoryAiPromptTemplateStore,
  createInMemoryAiSafetyStores,
  denyStubAiPlatformAbacResolver,
  maskInvocationForActor,
  mountM32Routes,
} from "../src/modules/32-ai-platform/index";
// The six §4.1 read-surface types (R16/R17/R21/R22/R31/R32) live in `routes/read-service.ts` and are NOT
// re-exported at the module's top-level barrel — only `M32ReadService`/`M32_PAGE_SIZES`/
// `maskInvocationForActor` are (`../src/modules/32-ai-platform/index.ts`'s own selective re-export list).
// Imported from their actual home instead of guessing a re-export path that does not exist.
import {
  type AiDriftFindingView,
  type AiInvocationLedgerPage,
  type AiInvocationLedgerView,
  type AiInvocationSearchFilters,
  type AiPlatformReadActor,
  type AiTokenForecastView,
  type AiTokenLedgerEntryView,
  type AiTokenLedgerFilters,
  type AiTokenLedgerPage,
  clampLimit,
} from "../src/modules/32-ai-platform/routes/read-service";

// ── header-auth shim (the M11/M14/M19/M28 precedent), extended with the two facts M32 needs the
//    session to carry that those modules did not: a provider-entity scope (R18's `providerEntityOf`) and
//    a step-up freshness flag (R4/R7/R8/R30's `requireStepUp`).
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
  const pe = request.headers["x-test-pe"];
  if (typeof pe === "string" && pe.length > 0) {
    request.context.providerEntityIds = [pe];
  }
  if (request.headers["x-test-step-up"] === "1") {
    request.context.attributes.stepUpRecent = true;
  }
}

const ORG = "org_a";
const MEMBER_SUPER = "10000000-0000-4000-8000-000000000001";
const MEMBER_NOPERM = "10000000-0000-4000-8000-000000000002";
const PE = "20000000-0000-4000-8000-000000000001";
const CAP_A_ID = "30000000-0000-4000-8000-000000000001";
const CAP_B_ID = "30000000-0000-4000-8000-000000000002";
const REPORT_SEED_ID = "40000000-0000-4000-8000-000000000001";
const RUN_SEED_ID = "40000000-0000-4000-8000-000000000002";
const INVOCATION_SEED_ID = "40000000-0000-4000-8000-000000000003";
const BACKEND_ID = "50000000-0000-4000-8000-000000000001";
const EVIDENCE_RUN_ID = "50000000-0000-4000-8000-000000000002";

const SUPER = {
  "x-test-user": "super_1",
  "x-test-org": ORG,
  "x-test-roles": "platform_ops",
  "x-test-membership": MEMBER_SUPER,
  "x-test-pe": PE,
  "x-test-step-up": "1",
};
const NOPERM = {
  "x-test-user": "noperm_1",
  "x-test-org": ORG,
  "x-test-roles": "none",
  "x-test-membership": MEMBER_NOPERM,
};
/** SUPER plus the `phi.full_read` masking grant — the R16/R17 unmasked read (F-030). */
const PHI_READER = { ...SUPER, "x-test-user": "phi_1" };

function baseCapability(id: string, capabilityKey: string): AiCapabilityGovernanceRow {
  return {
    id,
    capabilityKey,
    displayName: `Test Capability ${capabilityKey}`,
    riskTier: "medium",
    lifecycleState: "PROPOSED",
    defaultBackendKey: "test_backend_local",
    allowedBackendKeys: ["test_backend_local"],
    tenantOptInRequired: true,
    clinicianOptOutSupported: true,
    currentPromptTemplateKey: null,
    firstApprovedAt: null,
    lastReapprovedAt: null,
    nextReapprovalDueAt: null,
  };
}

function registerBody(capabilityKey: string) {
  return {
    capabilityKey,
    displayName: `Test Capability ${capabilityKey}`,
    description: "a smoke-test capability with no real inference behind it",
    riskTier: "medium",
    defaultBackendKey: "test_backend_local",
    allowedBackendKeys: ["test_backend_local"],
    fallbackChainKeys: [],
    tenantOverrideAllowed: true,
    tenantOptInRequired: true,
    clinicianOptOutSupported: true,
    clinicalReviewRequired: false,
    owningRole: "ai_safety_owner",
    actorRole: "ai_safety_owner",
    rationaleText: "registered for the M32 §4.1 HTTP-layer smoke suite",
    currentPromptTemplateKey: null,
  };
}

/** A minimal, hand-rolled `M32ReadService` — see the file header for why no in-memory builder exists. */
function buildFakeReadService(state: {
  readonly invocations: readonly AiInvocationLedgerView[];
  readonly tokenEntries: readonly (AiTokenLedgerEntryView & { readonly organizationId: string })[];
  readonly backends: readonly AiBackendRoutingRow[];
  readonly evaluationRuns: readonly AiEvaluationRunRowProjection[];
  readonly capabilityKeyOf: (capabilityId: string) => string;
}): M32ReadService {
  return {
    async searchInvocations(
      actor: AiPlatformReadActor,
      filters: AiInvocationSearchFilters,
    ): Promise<AiInvocationLedgerPage> {
      let rows = state.invocations.filter((r) => r.organizationId === actor.organizationId);
      if (filters.capabilityId !== undefined) {
        rows = rows.filter((r) => r.capabilityId === filters.capabilityId);
      }
      if (filters.capabilityKey !== undefined) {
        rows = rows.filter((r) => r.capabilityKey === filters.capabilityKey);
      }
      if (filters.backendKey !== undefined)
        rows = rows.filter((r) => r.backendKey === filters.backendKey);
      if (filters.status !== undefined) rows = rows.filter((r) => r.status === filters.status);
      if (filters.patientId !== undefined)
        rows = rows.filter((r) => r.patientId === filters.patientId);
      if (filters.disclosuresOnly === true) rows = rows.filter((r) => r.disclosedToVendor);
      if (filters.from !== undefined) {
        const from = Date.parse(filters.from);
        rows = rows.filter((r) => Date.parse(r.invokedAt) >= from);
      }
      if (filters.to !== undefined) {
        const to = Date.parse(filters.to);
        rows = rows.filter((r) => Date.parse(r.invokedAt) < to);
      }
      const limit = clampLimit(filters.limit);
      return {
        rows: rows.slice(0, limit).map((r) => maskInvocationForActor(r, actor.phiFullRead)),
        nextInvokedAtBefore: null,
      };
    },

    async getInvocation(
      actor: AiPlatformReadActor,
      invocationId: string,
    ): Promise<AiInvocationLedgerView | null> {
      // SIMPLIFICATION (documented, not hidden): the real Drizzle service scopes by `withOrgContext` +
      // RLS, which still admits the cross-tenant safety owner through the platform credential. Reproducing
      // that org/credential split in-memory would test the fake, not the route — the route's own ABAC
      // guard (`ABAC_INVOCATION_ROW`) already proves the 403-vs-404 boundary in `ai-platform-routes.test.ts`
      // (R16's masking-rule suite). This fake finds by id alone, which is sufficient to prove the route is
      // MOUNTED and returns the documented shape — this file's actual job.
      const row = state.invocations.find((r) => r.invocationId === invocationId);
      return row === undefined ? null : maskInvocationForActor(row, actor.phiFullRead);
    },

    async tokenLedger(
      actor: AiPlatformReadActor,
      filters: AiTokenLedgerFilters,
    ): Promise<AiTokenLedgerPage> {
      let rows = state.tokenEntries.filter((r) => r.organizationId === actor.organizationId);
      if (filters.capabilityId !== undefined)
        rows = rows.filter((r) => r.capabilityId === filters.capabilityId);
      const limit = clampLimit(filters.limit);
      const page = rows.slice(0, limit);
      return {
        entries: page,
        windowInputTokens: page.reduce((sum, r) => sum + r.inputTokens, 0),
        windowOutputTokens: page.reduce((sum, r) => sum + r.outputTokens, 0),
      };
    },

    async tokenForecast(): Promise<readonly AiTokenForecastView[]> {
      // No budget configured for any test capability (§1.1's honest default — see
      // `createUnconfiguredAiTokenBudgetResolver`'s header in ../invocation/store.ts): an empty forecast
      // list is the correct answer, not a stub shortcut.
      return [];
    },

    async recentDrift(_actor: AiPlatformReadActor, withinHours: number) {
      // Mirrors read-service-drizzle.ts's OWN window exactly (real `Date.now()`, never an injected clock)
      // — see the file header on why.
      const since = Date.now() - Math.max(withinHours, 0) * 60 * 60 * 1000;
      return state.evaluationRuns
        .filter((r) => r.stage === "drift_response" && Date.parse(r.createdAt) >= since)
        .map(
          (run): AiDriftFindingView => ({
            run,
            capabilityKey: state.capabilityKeyOf(run.capabilityId),
          }),
        );
    },

    async health(at: string) {
      return {
        status: "ok" as const,
        checkedAt: at,
        backends: state.backends.map((b) => ({
          backendId: b.backendId,
          backendKey: b.backendKey,
          kind: b.kind,
          isActive: b.isActive,
          lastHealthStatus: b.lastHealthStatus,
          zdrStatus: b.zdrStatus,
          modelVersionPin: b.modelVersionPin,
        })),
        // Phase 1 runs with `ai.full` OFF and no backends registered — "no healthy backend" is the
        // EXPECTED state (§4.1's own R32 note; safety-ops.routes.ts's header restates it).
        capabilityShellMode: true,
      };
    },
  };
}

function makeServer() {
  const capA = baseCapability(CAP_A_ID, "m32_test_cap_a");
  const capB = baseCapability(CAP_B_ID, "m32_test_cap_b");

  const governanceStores = createInMemoryAiGovernanceStores({ capabilities: [capA, capB] });

  const nowIso = new Date().toISOString();
  const safetyStores = createInMemoryAiSafetyStores({
    reports: [
      {
        id: REPORT_SEED_ID,
        organizationId: ORG,
        providerEntityId: PE,
        locationId: null,
        invocationId: null,
        capabilityId: capA.id,
        reporterMembershipId: MEMBER_SUPER,
        reporterRole: "registered_nurse",
        severity: "medium",
        hallucinationKind: "other",
        triageStatus: "open",
        triageOwnerMembershipId: null,
        triageDisposition: null,
        mitigationActionRef: null,
        reportedAt: nowIso,
        triagedAt: null,
        closedAt: null,
      },
    ],
    evaluationRuns: [
      {
        id: RUN_SEED_ID,
        capabilityId: capA.id,
        backendId: BACKEND_ID,
        datasetVersionRef: "ds-drift-seed",
        mlflowRunId: "mlflow-drift-seed",
        stage: "drift_response",
        summaryMetrics: {},
        status: "pending",
        decision: "no_decision",
        initiatedByMembershipId: MEMBER_SUPER,
        startedAt: null,
        completedAt: null,
        createdAt: nowIso,
      },
    ],
  });

  const invocationStores = createInMemoryAiInvocationStores({});

  const promptBody = "# smoke-test prompt\nsummarize the visit note.";
  const promptContentHash = createHash("sha256").update(promptBody).digest("hex");
  const promptStore = createInMemoryAiPromptTemplateStore();
  const promptArtifacts: AiPromptArtifactReader = {
    read: async () => ({ body: promptBody, contentHash: promptContentHash }),
  };
  const promptRegistry = createAiPromptRegistry({ store: promptStore, artifacts: promptArtifacts });

  // W4.1's evidence resolver — NOT the fail-closed `createDenyingAiOptInEvidenceResolver()` default.
  // `evaluateAiTenantOptIn` (packages/ai-platform/src/governance/tenant-opt-in.ts) checks
  // `evidence.clinicalReviewerHasSafetyLeadRole` UNCONDITIONALLY (outside the `cloudReachable` branch
  // the BAA/ZDR checks are gated by), so R10's 2xx case needs a resolver that answers it — the deny-stub
  // default would refuse every opt-in with `AI_OPT_IN_CLINICAL_REVIEWER_INVALID` regardless of routing
  // preference. Answering everything `true` is safe here: R10's test uses `prefer_local` routing, which
  // keeps `cloudReachable` false (no `cloud`-kind backend is registered), so the BAA/ZDR arms of this
  // resolver are never actually consulted — only the unconditional clinical-reviewer check is.
  const evidence: AiOptInEvidenceResolver = {
    resolve: async () => ({
      baaResolved: true,
      baaExpiresAt: null,
      zdrContractOnRecord: true,
      clinicalReviewerHasSafetyLeadRole: true,
    }),
  };
  const governance: AiGovernanceServiceDeps = {
    registry: governanceStores.registry,
    consent: governanceStores.consent,
    evidence,
    // `evaluations` deliberately unbound: `transitionAiCapability` then does PRESENCE-only evidence
    // checking (governance/service.ts's own comment), which is what lets R4's EVALUATION→PILOT edge
    // accept any well-formed `linkedEvaluationRunId` without a matching `ai_evaluation_run` row to
    // resolve — the id-generator mismatch this file's header explains.
  };
  const safety: AiSafetyServiceDeps = {
    killSwitches: safetyStores.killSwitches,
    reports: safetyStores.reports,
    evaluations: safetyStores.evaluations,
    registry: governanceStores.registry,
  };
  const prompts: AiPromptServiceDeps = {
    store: promptStore,
    artifacts: promptArtifacts,
    registry: promptRegistry,
  };

  const invocationSeed: AiInvocationLedgerView[] = [
    {
      invocationId: INVOCATION_SEED_ID,
      organizationId: ORG,
      providerEntityId: PE,
      locationId: null,
      capabilityId: capA.id,
      capabilityKey: capA.capabilityKey,
      backendId: BACKEND_ID,
      backendKey: "test_backend_local",
      modelVersionPin: "test-model-v1",
      promptTemplateVersion: null,
      actorMembershipId: MEMBER_SUPER,
      actorRole: "registered_nurse",
      patientId: "patient-smoke-1",
      touchedPatientChart: true,
      consumerCorrelationId: null,
      routingDecision: "primary",
      routingReason: "default",
      inputTokenCount: 120,
      outputTokenCount: 80,
      durationMs: 500,
      status: "completed",
      errorClass: null,
      errorMessage: null,
      hitlOutcome: "pending",
      zdrConfirmed: true,
      invokedAt: nowIso,
      completedAt: nowIso,
      disclosedToVendor: true,
    },
  ];
  const tokenSeed: (AiTokenLedgerEntryView & { readonly organizationId: string })[] = [
    {
      ledgerId: "tok-seed-1",
      organizationId: ORG,
      capabilityId: capA.id,
      backendId: BACKEND_ID,
      inputTokens: 120,
      outputTokens: 80,
      cloudCostUsd: null,
      localComputeAttribution: null,
      accruedAt: nowIso,
    },
  ];

  const read = buildFakeReadService({
    invocations: invocationSeed,
    tokenEntries: tokenSeed,
    backends: [],
    evaluationRuns: safetyStores.evaluationRows,
    capabilityKeyOf: (id) =>
      id === capA.id ? capA.capabilityKey : id === capB.id ? capB.capabilityKey : "unknown",
  });

  const services: M32RouteServices = {
    governance,
    safety,
    prompts,
    read,
    routing: invocationStores.overrides,
    cipher: { encrypt: async () => new Uint8Array([9, 9, 9]) },
    promptRegistry,
  };

  // A FRESH predicate registry per server (the M11-T06/M28 precedent — the shared registry would
  // otherwise persist a predicate closed over a prior test's stores across the file).
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(
    buildAiPlatformAbacPredicates({ resolver: denyStubAiPlatformAbacResolver }),
  )) {
    reg.register(name, predicate);
  }
  // `step_up_recent` is M3's predicate, composed by `requireStepUp` and not owned by M32 — see the file
  // header.
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);

  const grantStore = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "super_1",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: [...M32_PERMISSION_KEY_LIST],
        },
      ],
    },
    {
      orgId: ORG,
      userId: "noperm_1",
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [] }],
    },
    {
      // F-030 — the same M32 keys PLUS the M5-contributed `phi.full_read` masking grant. It could not
      // be granted to anyone before: the key was in no catalog, and M32 asked for it as a ROLE token
      // and as an unwritten context attribute, so R16/R17 masked every caller including the compliance
      // officer the disclosure ledger exists for.
      orgId: ORG,
      userId: "phi_1",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: [...M32_PERMISSION_KEY_LIST, "phi.full_read"],
        },
      ],
    },
  ]);
  registerEffectivePermissionResolver(grantStore.store);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM32Routes(app, services);
  return { app, capA, capB };
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

// ── auth gating — one 401 / one 403 / one 422 across the whole module ──────────────────────────────────
describe("M32-ai-platform-inject — auth gating", () => {
  it("no auth headers at all → 401 (route: GET /api/v1/ai/capabilities)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/ai/capabilities" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("authenticated actor holding NO permissions → 403 (route: POST /api/v1/ai/capabilities, requires ai.capability.create)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/capabilities",
      headers: NOPERM,
      payload: registerBody("m32_test_cap_403"),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("a correctly-permissioned actor with an empty body → 422 VALIDATION_FAILED (route: POST /api/v1/ai/capabilities)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/capabilities",
      headers: SUPER,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
    await app.close();
  });
});

// ── R1-R3 — the capability registry ──────────────────────────────────────────────────────────────────
describe("M32-ai-platform-inject — R1-R3: capability registry", () => {
  it("R1 registers a NEW capability into PROPOSED (201)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/capabilities",
      headers: SUPER,
      payload: registerBody("m32_test_cap_standalone_r1"),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().lifecycleState).toBe("PROPOSED");
    await app.close();
  });

  it("R2 lists capabilities and R3 reads one's governance detail (200/200)", async () => {
    const { app, capA } = makeServer();
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/ai/capabilities",
      headers: SUPER,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().capabilities.map((c: { id: string }) => c.id)).toContain(capA.id);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/ai/capabilities/${capA.id}`,
      headers: SUPER,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().capability.id).toBe(capA.id);
    await app.close();
  });
});

// ── R4 — walk the §2.2 lifecycle (also carries the module's step-up proof) ──────────────────────────────
describe("M32-ai-platform-inject — R4: capability lifecycle transitions", () => {
  it("walks PROPOSED -> DESIGN_REVIEW -> EVALUATION -> PILOT, each 200", async () => {
    const { app, capB } = makeServer();
    const transition = (body: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/api/v1/ai/capabilities/${capB.id}/transitions`,
        headers: SUPER,
        payload: {
          actorRole: "ai_safety_owner",
          rationaleText: "smoke-test transition",
          linkedEvaluationRunId: null,
          ...body,
        },
      });

    const step1 = await transition({ toState: "DESIGN_REVIEW", approvalKind: "stage_1_proposal" });
    expect(step1.statusCode).toBe(200);
    expect(step1.json().capability.lifecycleState).toBe("DESIGN_REVIEW");

    const step2 = await transition({
      toState: "EVALUATION",
      approvalKind: "stage_2_design_review",
    });
    expect(step2.statusCode).toBe(200);

    const step3 = await transition({
      toState: "PILOT",
      approvalKind: "stage_3_evaluation",
      linkedEvaluationRunId: EVIDENCE_RUN_ID,
    });
    expect(step3.statusCode).toBe(200);
    expect(step3.json().capability.lifecycleState).toBe("PILOT");
    await app.close();
  });
});

// ── R5/R6 — calibration ──────────────────────────────────────────────────────────────────────────────
describe("M32-ai-platform-inject — R5/R6: calibration publication + history", () => {
  it("publishes a calibration (201) and reads its history (200)", async () => {
    const { app, capA } = makeServer();
    const publish = await app.inject({
      method: "POST",
      url: `/api/v1/ai/capabilities/${capA.id}/calibration`,
      headers: SUPER,
      payload: {
        backendKey: "test_backend_local",
        thresholds: { confidence: 0.8 },
        baselineMetrics: { accuracy: 0.9 },
        baselineSetAt: new Date().toISOString(),
        baselineEvaluationRunId: EVIDENCE_RUN_ID,
        supersededReason: null,
      },
    });
    expect(publish.statusCode).toBe(201);

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/ai/capabilities/${capA.id}/calibration/history`,
      headers: SUPER,
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().calibrations.length).toBeGreaterThan(0);
    await app.close();
  });
});

// ── R7-R9 — the kill switch (also carries a second step-up proof: R7 AND R8 both require it) ───────────
describe("M32-ai-platform-inject — R7-R9: kill switch", () => {
  it("activates (201), lists active (200), then deactivates (200) — tenant scope", async () => {
    const { app, capA } = makeServer();
    const activate = await app.inject({
      method: "POST",
      url: `/api/v1/ai/capabilities/${capA.id}/kill-switch`,
      headers: SUPER,
      payload: {
        scope: "tenant",
        reason: "manual_safety_pause",
        actorKind: "ai_safety_owner",
        activationMessage: "pausing for the M32 smoke suite",
      },
    });
    expect(activate.statusCode).toBe(201);
    expect(activate.json().row.active).toBe(true);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/ai/kill-switches",
      headers: SUPER,
    });
    expect(list.statusCode).toBe(200);
    expect(
      list.json().killSwitches.some((k: { capabilityId: string }) => k.capabilityId === capA.id),
    ).toBe(true);

    const deactivate = await app.inject({
      method: "DELETE",
      url: `/api/v1/ai/capabilities/${capA.id}/kill-switch`,
      headers: SUPER,
      payload: {
        scope: "tenant",
        actorKind: "ai_safety_owner",
        resolutionNarrative: "resolved for the M32 smoke suite",
      },
    });
    expect(deactivate.statusCode).toBe(200);
    expect(deactivate.json().row.active).toBe(false);
    await app.close();
  });
});

describe("GAP-096 — a platform-scope kill switch from a tenant-side actor is 403", () => {
  // The `platform` row stops a capability for EVERY agency, so only the safety-owner arm may satisfy it.
  // A tenant clinical_safety_lead (a key any tenant admin can mint) is the safety owner only on a
  // single-tenant deployment; on the default multi-tenant one it holds every §4.6 key and is still refused.
  const TENANT_LEAD = { ...SUPER, "x-test-roles": "clinical_safety_lead,org_admin" };
  const body = {
    scope: "platform",
    reason: "manual_safety_pause",
    actorKind: "ai_safety_owner",
    activationMessage: "tenant attempting a platform-wide stop",
  };

  it("refuses the tenant designee (403) and still admits the platform operator (201)", async () => {
    const { app, capA } = makeServer();
    const url = `/api/v1/ai/capabilities/${capA.id}/kill-switch`;
    const tenant = await app.inject({ method: "POST", url, headers: TENANT_LEAD, payload: body });
    expect(tenant.statusCode).toBe(403);
    const platform = await app.inject({ method: "POST", url, headers: SUPER, payload: body });
    expect(platform.statusCode).toBe(201);
    await app.close();
  });
});

// ── R10-R12 — the tenant opt-in (needs a PILOT capability — capB, walked by R4 above in a fresh server) ─
describe("M32-ai-platform-inject — R10-R12: tenant opt-in", () => {
  async function walkToPilot(
    app: ReturnType<typeof makeServer>["app"],
    capabilityId: string,
  ): Promise<void> {
    const transition = (body: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/api/v1/ai/capabilities/${capabilityId}/transitions`,
        headers: SUPER,
        payload: {
          actorRole: "ai_safety_owner",
          rationaleText: "walk to PILOT for opt-in smoke test",
          linkedEvaluationRunId: null,
          ...body,
        },
      });
    await transition({ toState: "DESIGN_REVIEW", approvalKind: "stage_1_proposal" });
    await transition({ toState: "EVALUATION", approvalKind: "stage_2_design_review" });
    await transition({
      toState: "PILOT",
      approvalKind: "stage_3_evaluation",
      linkedEvaluationRunId: EVIDENCE_RUN_ID,
    });
  }

  it("records an opt-in (201), lists it (200), then withdraws it (200)", async () => {
    const { app, capB } = makeServer();
    await walkToPilot(app, capB.id);

    const record = await app.inject({
      method: "POST",
      url: "/api/v1/ai/tenant-opt-in",
      headers: SUPER,
      payload: {
        capabilityId: capB.id,
        // `prefer_local` keeps this cloud-UNREACHABLE (no backend is registered as `cloud` in this
        // server), which skips the BAA/ZDR evidence gate the deny-stub resolver would otherwise refuse.
        routingMode: "prefer_local",
        pilotEnrollment: true,
        acknowledgments: {
          baaReference: null,
          zdrContractReference: null,
          clinicalReviewerMembershipId: MEMBER_SUPER,
          clinicalReviewerAttestationText:
            "reviewed the local-routing trade-offs for this smoke test",
          disclosureAccountingAcknowledged: true,
          calibrationTradeOffAcknowledged: "acknowledged the local-routing calibration trade-off",
        },
        orgRoutingPreference: "prefer_cloud",
      },
    });
    expect(record.statusCode).toBe(201);
    expect(record.json().status).toBe("active");

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/ai/tenant-opt-in",
      headers: SUPER,
    });
    expect(list.statusCode).toBe(200);
    expect(
      list.json().optIns.some((o: { capabilityId: string }) => o.capabilityId === capB.id),
    ).toBe(true);

    const withdraw = await app.inject({
      method: "DELETE",
      url: `/api/v1/ai/tenant-opt-in/${capB.id}`,
      headers: SUPER,
    });
    expect(withdraw.statusCode).toBe(200);
    expect(withdraw.json().status).toBe("opted_out");
    await app.close();
  });
});

// ── R13-R15 — the clinician opt-out ──────────────────────────────────────────────────────────────────
describe("M32-ai-platform-inject — R13-R15: clinician opt-out", () => {
  it("opts out (201), lists the history (200), then reverts (200)", async () => {
    const { app, capA } = makeServer();
    const optOut = await app.inject({
      method: "POST",
      url: "/api/v1/ai/clinician-opt-out",
      headers: SUPER,
      payload: { capabilityId: capA.id, reason: "smoke-test opt-out" },
    });
    expect(optOut.statusCode).toBe(201);
    expect(optOut.json().optedOut).toBe(true);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/ai/clinician-opt-out",
      headers: SUPER,
    });
    expect(list.statusCode).toBe(200);
    expect(
      list.json().optOuts.some((o: { capabilityId: string }) => o.capabilityId === capA.id),
    ).toBe(true);

    const revert = await app.inject({
      method: "DELETE",
      url: `/api/v1/ai/clinician-opt-out/${capA.id}`,
      headers: SUPER,
    });
    expect(revert.statusCode).toBe(200);
    expect(revert.json().revertedAt).not.toBeNull();
    await app.close();
  });
});

// ── R16-R17 — the §164.528 disclosure ledger ─────────────────────────────────────────────────────────
describe("M32-ai-platform-inject — R16-R17: invocation ledger", () => {
  it("searches the ledger (200) and reads one row (200)", async () => {
    const { app } = makeServer();
    const search = await app.inject({
      method: "GET",
      url: "/api/v1/ai/invocations",
      headers: SUPER,
    });
    expect(search.statusCode).toBe(200);
    expect(
      search
        .json()
        .rows.some((r: { invocationId: string }) => r.invocationId === INVOCATION_SEED_ID),
    ).toBe(true);
    // SUPER holds no `phi.full_read` grant — the row is present but masked, which is the documented rule
    // (read-service.ts's header), not a gap in this row.
    expect(search.json().phiMasked).toBe(true);

    const one = await app.inject({
      method: "GET",
      url: `/api/v1/ai/invocations/${INVOCATION_SEED_ID}`,
      headers: SUPER,
    });
    expect(one.statusCode).toBe(200);
    expect(one.json().invocationId).toBe(INVOCATION_SEED_ID);
    expect(one.json().patientId).toBeNull();
    await app.close();
  });

  it("F-030 — `phi.full_read` UNMASKS the ledger; without it the same rows stay masked", async () => {
    // The direction that had no coverage. Both arms of the old check were dead — a `resource.action`
    // permission key looked up in the list of ROLE keys, and a context attribute nothing ever wrote —
    // so this route masked for everyone, always. Masking fails SAFE, which is exactly why a permanently
    // masked ledger and a correctly masked one were indistinguishable.
    const { app } = makeServer();

    const search = await app.inject({
      method: "GET",
      url: "/api/v1/ai/invocations",
      headers: PHI_READER,
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().phiMasked).toBe(false);

    const one = await app.inject({
      method: "GET",
      url: `/api/v1/ai/invocations/${INVOCATION_SEED_ID}`,
      headers: PHI_READER,
    });
    expect(one.statusCode).toBe(200);
    expect(one.json().patientId).toBe("patient-smoke-1");
    expect(one.json().phiMasked).toBe(false);

    // The control still binds: the identical request from an actor without the grant is masked, and
    // `touchedPatientChart` — the fact the §164.528 accounting turns on — survives the masking.
    const masked = await app.inject({
      method: "GET",
      url: `/api/v1/ai/invocations/${INVOCATION_SEED_ID}`,
      headers: SUPER,
    });
    expect(masked.json().patientId).toBeNull();
    expect(masked.json().touchedPatientChart).toBe(true);
    await app.close();
  });
});

// ── R18-R20 — hallucination reporting + triage ───────────────────────────────────────────────────────
describe("M32-ai-platform-inject — R18-R20: hallucination reports", () => {
  it("files a report (201), lists the queue (200), and triages the pre-seeded one (200)", async () => {
    const { app, capA } = makeServer();
    const file = await app.inject({
      method: "POST",
      url: "/api/v1/ai/hallucination-reports",
      headers: SUPER,
      payload: {
        capabilityId: capA.id,
        invocationId: null,
        severity: "medium",
        hallucinationKind: "other",
        reporterNarrative: "the assistant fabricated a medication name during the smoke test",
      },
    });
    expect(file.statusCode).toBe(201);
    expect(file.json().report.triageStatus).toBe("open");

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/ai/hallucination-reports",
      headers: SUPER,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().reports.some((r: { id: string }) => r.id === REPORT_SEED_ID)).toBe(true);

    const triage = await app.inject({
      method: "POST",
      url: `/api/v1/ai/hallucination-reports/${REPORT_SEED_ID}/triage`,
      headers: SUPER,
      payload: {
        toStatus: "investigating",
        disposition: null,
        mitigationActionRef: null,
        severity: "medium",
      },
    });
    expect(triage.statusCode).toBe(200);
    expect(triage.json().report.triageStatus).toBe("investigating");
    await app.close();
  });
});

// ── R21-R22 — token ledger + forecast ────────────────────────────────────────────────────────────────
describe("M32-ai-platform-inject — R21-R22: token ledger + forecast", () => {
  it("reads the ledger (200) and the forecast (200)", async () => {
    const { app } = makeServer();
    const ledger = await app.inject({
      method: "GET",
      url: "/api/v1/ai/tokens/ledger",
      headers: SUPER,
    });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json().windowInputTokens).toBe(120);

    const forecast = await app.inject({
      method: "GET",
      url: "/api/v1/ai/tokens/forecast",
      headers: SUPER,
    });
    expect(forecast.statusCode).toBe(200);
    expect(Array.isArray(forecast.json().forecasts)).toBe(true);
    await app.close();
  });
});

// ── R23-R25 — routing overrides ──────────────────────────────────────────────────────────────────────
describe("M32-ai-platform-inject — R23-R25: routing overrides", () => {
  it("sets an override (201), lists it (200), then removes it by closing its window (200)", async () => {
    const { app, capA } = makeServer();
    const set = await app.inject({
      method: "POST",
      url: "/api/v1/ai/routing-overrides",
      headers: SUPER,
      payload: {
        capabilityId: capA.id,
        backendKeyPreference: "test_backend_local",
        overrideReason: "tenant_sovereignty",
      },
    });
    expect(set.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/ai/routing-overrides",
      headers: SUPER,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().overrides.length).toBeGreaterThan(0);

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/v1/ai/routing-overrides/${capA.id}`,
      headers: SUPER,
    });
    expect(remove.statusCode).toBe(200);
    expect(remove.json().removed).toBe(true);
    await app.close();
  });
});

// ── R26-R28 — evaluation runs ─────────────────────────────────────────────────────────────────────────
describe("M32-ai-platform-inject — R26-R28: evaluation runs", () => {
  it("queues a run (201), lists runs (200), and reads the pre-seeded one by id (200)", async () => {
    const { app, capA } = makeServer();
    const queue = await app.inject({
      method: "POST",
      url: "/api/v1/ai/evaluations",
      headers: SUPER,
      payload: {
        capabilityId: capA.id,
        backendId: BACKEND_ID,
        datasetVersionRef: "ds-smoke-1",
        mlflowRunId: "mlflow-smoke-1",
        stage: "stage_3_evaluation",
        summaryMetrics: {},
      },
    });
    expect(queue.statusCode).toBe(201);
    expect(queue.json().status).toBe("pending");

    const list = await app.inject({ method: "GET", url: "/api/v1/ai/evaluations", headers: SUPER });
    expect(list.statusCode).toBe(200);
    expect(list.json().runs.some((r: { id: string }) => r.id === RUN_SEED_ID)).toBe(true);

    const one = await app.inject({
      method: "GET",
      url: `/api/v1/ai/evaluations/${RUN_SEED_ID}`,
      headers: SUPER,
    });
    expect(one.statusCode).toBe(200);
    expect(one.json().id).toBe(RUN_SEED_ID);
    await app.close();
  });
});

// ── R29-R30 — the prompt registry ────────────────────────────────────────────────────────────────────
describe("M32-ai-platform-inject — R29-R30: prompt template activation + read", () => {
  it("activates a template (201), then reads its active metadata (200)", async () => {
    const { app } = makeServer();
    const capabilityKey = "m32_smoke_prompt_capability";
    const promptContentHash = createHash("sha256")
      .update("# smoke-test prompt\nsummarize the visit note.")
      .digest("hex");

    const activate = await app.inject({
      method: "POST",
      url: `/api/v1/ai/prompts/${capabilityKey}/activate`,
      headers: SUPER,
      payload: {
        templateKey: "layer2_note_summary",
        version: 1,
        templateFilesystemRef: "packages/prompts/test/layer2.md",
        templateContentHash: promptContentHash,
        compatibleBackendKeys: ["test_backend_local"],
        inputSchemaRef: "schema://input/v1",
        outputSchemaRef: "schema://output/v1",
        outputEntityTargetPrefix: "note_",
        outputTypePrefix: "summary_",
        approvedByMembershipId: MEMBER_SUPER,
        clinicalReviewerAttestation:
          "reviewed and approved for the M32 smoke suite; meets the clinical bar.",
      },
    });
    expect(activate.statusCode).toBe(201);
    expect(activate.json().status).toBe("active");

    const active = await app.inject({
      method: "GET",
      url: `/api/v1/ai/prompts/${capabilityKey}/active`,
      headers: SUPER,
    });
    expect(active.statusCode).toBe(200);
    expect(active.json().templateKey).toBe("layer2_note_summary");
    expect(active.json().version).toBe(1);
    await app.close();
  });
});

// ── R31 — drift ───────────────────────────────────────────────────────────────────────────────────────
describe("M32-ai-platform-inject — R31: drift", () => {
  it("reads recent drift findings, including the pre-seeded drift_response run (200)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/ai/drift/recent", headers: SUPER });
    expect(res.statusCode).toBe(200);
    expect(res.json().findings.some((f: { run: { id: string } }) => f.run.id === RUN_SEED_ID)).toBe(
      true,
    );
    await app.close();
  });
});

// ── R32 — backend health ─────────────────────────────────────────────────────────────────────────────
describe("M32-ai-platform-inject — R32: backend health", () => {
  it("reads the health board (200)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/ai/health", headers: SUPER });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    expect(res.json().capabilityShellMode).toBe(true);
    await app.close();
  });
});
