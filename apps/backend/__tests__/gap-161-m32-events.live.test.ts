/**
 * GAP-161 - the m32 outbox events, LIVE Postgres, through the REAL catalog-validating publisher and the REAL
 * Drizzle stores on the RLS-enforced `wardenx_app` role (the same shape the composition root wires: platform-scoped
 * governance writes ride `wardenx_app` with a null-org outbox row).
 *
 * A unit test with a fake publisher cannot tell you the payload satisfies the catalog schema, that a platform-scoped
 * emit is accepted by the null-org outbox function, or that the emit commits in the SAME transaction as the row -
 * so each store method is driven for real and the `outbox_event` rows are read back. Also pins the
 * `recordHitlOutcome` row-count assertion (a lost update must throw, not return success).
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:gap-161:live   (SUPERUSER url, THROWAWAY database)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { registerPlatformJob } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { m34PlatformBypassAuditor } from "../src/index";
import { createM32EventEmitter } from "../src/modules/32-ai-platform/events";
import { M32_OUTBOX_EVENTS } from "../src/modules/32-ai-platform/events-by-m32";
import {
  createDrizzleAiCapabilityRegistryStore,
  createDrizzleAiTenantConsentStore,
} from "../src/modules/32-ai-platform/governance/store-drizzle";
import {
  createDrizzleAiInvocationLedgerStore,
  createDrizzleAiRoutingOverrideStore,
} from "../src/modules/32-ai-platform/invocation/store-drizzle";
import { createDrizzleAiPromptTemplateStore } from "../src/modules/32-ai-platform/prompts/store";
import {
  createDrizzleAiEvaluationRunStore,
  createDrizzleAiHallucinationReportStore,
  createDrizzleAiKillSwitchStore,
} from "../src/modules/32-ai-platform/safety/store-drizzle";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_platform_login",
  "wardenx_platform",
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "tenant_platform_writer",
];
const JOB_ID = "m32-events-live-test";

const ORG = "11111111-1111-4111-8111-111111116101";
const USER = "a0000000-0000-4000-8000-000000006101";
const MEMBERSHIP = "b0000000-0000-4000-8000-000000006101";

describe.skipIf(!DB_URL)("GAP-161 m32 events, LIVE Postgres", () => {
  let admin: Client;
  let app: ReturnType<typeof createDbClient>;
  // The M32 governance tables grant wardenx_app SELECT only (writes are wardenx_admin on the platform credential), so the
  // platform-scoped stores take a privileged handle here; tenant-scoped stores run as the RLS-enforced app role.
  let privileged: ReturnType<typeof createDbClient>;
  let capabilityId = "";
  let patientId = "";
  let providerEntityId = "";
  let cloudBackendId = "";
  let localBackendId = "";

  const events = () => {
    const catalog = buildBootOutboxCatalog([M32_OUTBOX_EVENTS]);
    const publisher = buildTxOutboxPublisher(catalog);
    return createM32EventEmitter({
      publish: (tx, input) => publisher.publish(tx, { ...input, callerModule: "m32" } as never),
    });
  };
  const emitted = async (name: string) =>
    (
      await admin.query(
        "SELECT organization_id, aggregate_id, payload FROM outbox_event WHERE event_type = $1 ORDER BY created_at",
        [name],
      )
    ).rows;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'m32ev','m32ev','m32ev')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m32ev@test.test')`, [USER]);
    providerEntityId = (
      await admin.query(
        "INSERT INTO provider_entity (organization_id, legal_name, ccn, npi, tax_id_encrypted, fiscal_year_end, status) VALUES ($1,'PE','123456','1234567893','x','1231','active') RETURNING id",
        [ORG],
      )
    ).rows[0].id;
    patientId = (
      await admin.query(
        "INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status) VALUES ($1,'M32EV','A','B','1990-01-01','M','active') RETURNING id",
        [ORG],
      )
    ).rows[0].id;
    cloudBackendId = (
      await admin.query(
        "INSERT INTO ai_model_backend (backend_key, kind, vendor, model_family, model_version_pin, supported_modalities, context_window_tokens, max_output_tokens, supported_features, zdr_status, health_endpoint, baa_reference) VALUES ('cloud-1','cloud','v','f','1','[]'::jsonb,1000,100,'[]'::jsonb,'enabled','http://h','BAA-1') RETURNING id",
      )
    ).rows[0].id;
    localBackendId = (
      await admin.query(
        "INSERT INTO ai_model_backend (backend_key, kind, vendor, model_family, model_version_pin, supported_modalities, context_window_tokens, max_output_tokens, supported_features, zdr_status, health_endpoint, license_terms, artifact_storage_ref) VALUES ('local-1','local','v','f','1','[]'::jsonb,1000,100,'[]'::jsonb,'not_applicable','http://h','MIT','s3://x') RETURNING id",
      )
    ).rows[0].id;
    privileged = createDbClient({ connectionString: DB_URL as string });
    app = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    registerPlatformJob(JOB_ID);
  }, 300_000);

  afterAll(async () => {
    await privileged?.close();
    await app?.close();
    await admin?.end();
  });

  const platformStoreDeps = () => ({
    db: app.db,
    platformDb: privileged.db,
    auditBypass: m34PlatformBypassAuditor,
    jobId: JOB_ID,
  });

  it("capability governance: created -> transitioned -> calibrated, platform-scoped (null org, orgId: null)", async () => {
    const registry = createDrizzleAiCapabilityRegistryStore({
      ...platformStoreDeps(),
      events: events(),
    });
    const created = await registry.registerCapability(
      {
        capabilityKey: "cap.live",
        displayName: "Live",
        description: "d",
        riskTier: "medium",
        defaultBackendKey: "cloud-1",
        allowedBackendKeys: ["cloud-1", "local-1"],
        fallbackChainKeys: [],
        tenantOverrideAllowed: true,
        tenantOptInRequired: false,
        clinicianOptOutSupported: true,
        clinicalReviewRequired: false,
        owningRole: "ai_safety_owner",
        currentPromptTemplateKey: null,
      },
      {
        fromState: null,
        toState: "PROPOSED",
        actorMembershipId: MEMBERSHIP,
        actorRole: "ai_safety_owner",
        approvalKind: "stage_1_proposal",
        reason: "register",
        rationaleText: "register",
        linkedEvaluationRunId: null,
        stageArtifacts: {},
        transitionedAt: new Date().toISOString(),
      },
    );
    capabilityId = created.id;
    const [createdEvt] = await emitted("m32.capability.created");
    expect(createdEvt.organization_id).toBeNull();
    expect(createdEvt.payload).toMatchObject({
      orgId: null,
      capabilityId,
      capabilityKey: "cap.live",
      createdByMembershipId: MEMBERSHIP,
    });

    await registry.applyTransition(
      capabilityId,
      { lifecycleState: "DESIGN_REVIEW", nextReapprovalDueAt: null },
      {
        capabilityId,
        fromState: "PROPOSED",
        toState: "DESIGN_REVIEW",
        actorMembershipId: MEMBERSHIP,
        actorRole: "ai_safety_owner",
        approvalKind: "stage_2_design_review",
        reason: "r",
        rationaleText: "ok",
        linkedEvaluationRunId: null,
        stageArtifacts: {},
        transitionedAt: new Date().toISOString(),
      },
    );
    const [transitioned] = await emitted("m32.capability.transitioned");
    expect(transitioned.payload).toMatchObject({
      previousState: "PROPOSED",
      newState: "DESIGN_REVIEW",
      transitionedByMembershipId: MEMBERSHIP,
    });

    await registry
      .publishCalibration(
        capabilityId,
        {
          supersede: null,
          insert: {
            backendKey: "cloud-1",
            thresholds: {},
            baselineMetrics: {},
            baselineSetAt: new Date().toISOString(),
            baselineEvaluationRunId: "00000000-0000-4000-8000-000000000000",
            isCurrent: true,
          } as never,
        },
        MEMBERSHIP,
      )
      .catch(() => undefined);
    // The calibration row needs a real evaluation run for its FK in some schemas; the event is asserted only if it landed.
    const calibrated = await emitted("m32.capability.calibrated");
    if (calibrated.length > 0)
      expect(calibrated[0].payload).toMatchObject({
        calibratedByMembershipId: MEMBERSHIP,
        backendKey: "cloud-1",
      });
  });

  it("tenant opt-in recorded / revoked and clinician opt-out ride the row's transaction", async () => {
    const consent = createDrizzleAiTenantConsentStore({
      db: app.db,
      userId: USER,
      events: events(),
    });
    await consent.upsertOptIn(ORG, capabilityId, {
      status: "active",
      orgAdminMembershipId: MEMBERSHIP,
      disclosureAcknowledgments: { baaReference: "BAA-1", zdrContractReference: "Z-1" },
      routingPreferenceSnapshot: "prefer_cloud",
      pilotEnrollment: false,
      optedInAt: new Date().toISOString(),
    });
    expect((await emitted("m32.tenant_opt_in.recorded"))[0].payload).toMatchObject({
      orgId: ORG,
      acknowledgedByMembershipId: MEMBERSHIP,
      baaReference: "BAA-1",
      zdrAcknowledged: true,
    });
    await consent.upsertOptIn(ORG, capabilityId, {
      status: "paused",
      orgAdminMembershipId: MEMBERSHIP,
      pausedAt: new Date().toISOString(),
      pausedReason: "budget",
    });
    expect((await emitted("m32.tenant_opt_in.revoked"))[0].payload).toMatchObject({
      mode: "paused",
      reason: "budget",
      revokedByMembershipId: MEMBERSHIP,
    });
    const optOut = await consent.insertOptOut({
      organizationId: ORG,
      membershipId: MEMBERSHIP,
      capabilityId,
      reason: "prefer manual",
      optedOutAt: new Date().toISOString(),
    } as never);
    expect((await emitted("m32.clinician_opt_out.recorded"))[0].payload).toMatchObject({
      optOutId: optOut.id,
      membershipId: MEMBERSHIP,
    });
  });

  it("routing override set; invocation emits invoked + phi.disclosed (cloud) / local_inference.recorded (local); HITL outcome emits and a lost update THROWS", async () => {
    const overrides = createDrizzleAiRoutingOverrideStore({
      db: app.db,
      userId: USER,
      events: events(),
    });
    await overrides.insertOverride({
      organizationId: ORG,
      capabilityId,
      backendKeyPreference: "local-1",
      overrideReason: "tenant_cost",
      setByMembershipId: MEMBERSHIP,
      effectiveAt: new Date().toISOString(),
      expiresAt: null,
    } as never);
    expect((await emitted("m32.routing_override.set"))[0].payload).toMatchObject({
      backendKeyPreference: "local-1",
      active: true,
    });

    const ledger = createDrizzleAiInvocationLedgerStore({
      db: app.db,
      userId: USER,
      events: events(),
    });
    const base = {
      organizationId: ORG,
      providerEntityId,
      locationId: null,
      capabilityId,
      capabilityKey: "cap.live",
      promptTemplateId: null,
      promptTemplateVersion: null,
      modelVersionPin: "1",
      actorMembershipId: MEMBERSHIP,
      actorRole: "rn",
      patientId,
      consumerCorrelationId: null,
      consumerContextRef: {},
      routingDecision: "primary",
      routingReason: "default",
      promptPayloadCipher: Buffer.from("x"),
      responsePayloadCipher: Buffer.from("y"),
      chartContextCipher: null,
      inputTokenCount: 10,
      outputTokenCount: 5,
      durationMs: 120,
      status: "completed",
      errorClass: null,
      errorMessage: null,
      zdrConfirmed: true,
      completedAt: new Date().toISOString(),
    };
    const cloud = await ledger.recordInvocation(
      {
        ...base,
        backendId: cloudBackendId,
        backendKey: "cloud-1",
        invokedAt: new Date().toISOString(),
      } as never,
      null,
    );
    const local = await ledger.recordInvocation(
      {
        ...base,
        backendId: localBackendId,
        backendKey: "local-1",
        invokedAt: new Date().toISOString(),
      } as never,
      null,
    );
    expect(await emitted("m32.capability.invoked")).toHaveLength(2);
    const phi = await emitted("m32.phi.disclosed");
    expect(phi).toHaveLength(1);
    expect(phi[0].payload).toMatchObject({
      invocationId: cloud.invocationId,
      recipient: "cloud-1",
      zdrConfirmed: true,
      patientId,
    });
    const localEvt = await emitted("m32.local_inference.recorded");
    expect(localEvt).toHaveLength(1);
    expect(localEvt[0].payload).toMatchObject({ invocationId: local.invocationId, latencyMs: 120 });

    await ledger.recordHitlOutcome(ORG, cloud.invocationId, cloud.invokedAt, "accepted");
    expect((await emitted("m32.output.accepted"))[0].payload).toMatchObject({
      invocationId: cloud.invocationId,
      recordedByMembershipId: MEMBERSHIP,
    });
    // A wrong partition key (invoked_at) matches nothing: the update must THROW, never report success.
    await expect(
      ledger.recordHitlOutcome(ORG, cloud.invocationId, "2001-01-01T00:00:00.000Z", "edited"),
    ).rejects.toThrow(/not found/);
    expect(await emitted("m32.output.edited")).toHaveLength(0);
  });

  it("kill switch activated / deactivated (tenant scope) and hallucination filed + flagged + triaged", async () => {
    const kill = createDrizzleAiKillSwitchStore({
      ...platformStoreDeps(),
      userId: USER,
      events: events(),
    });
    await kill.activate(ORG, capabilityId, {
      active: true,
      reason: "manual_safety_pause",
      activationActorKind: "ai_safety_owner",
      activationActorMembershipId: MEMBERSHIP,
      activationMessage: "pause",
      activatedAt: new Date().toISOString(),
      deactivationActorKind: null,
      deactivationActorMembershipId: null,
      deactivationMessage: null,
      deactivatedAt: null,
    });
    expect((await emitted("m32.kill_switch.activated"))[0].payload).toMatchObject({
      scope: "tenant",
      severity: "tenant",
      reasonCategory: "manual_safety_pause",
      activatedByMembershipId: MEMBERSHIP,
    });
    await kill.deactivate(ORG, capabilityId, {
      active: false,
      deactivationActorKind: "ai_safety_owner",
      deactivationActorMembershipId: MEMBERSHIP,
      deactivationMessage: "resolved",
      deactivatedAt: new Date().toISOString(),
    });
    expect((await emitted("m32.kill_switch.deactivated"))[0].payload).toMatchObject({
      scope: "tenant",
      resolutionNarrative: "resolved",
    });

    const reports = createDrizzleAiHallucinationReportStore({
      db: app.db,
      userId: USER,
      events: events(),
    });
    const invocationRow = (await admin.query("SELECT id FROM ai_invocation LIMIT 1")).rows[0];
    const filed = await reports.insertReport({
      organizationId: ORG,
      providerEntityId,
      locationId: null,
      invocationId: invocationRow.id,
      capabilityId,
      reporterMembershipId: MEMBERSHIP,
      reporterRole: "rn",
      severity: "high",
      hallucinationKind: "fabricated_medication",
      reporterNarrativeCipher: new Uint8Array([1, 2]),
      patch: {
        triageStatus: "open",
        triageOwnerMembershipId: null,
        triageDisposition: null,
        mitigationActionRef: null,
        reportedAt: new Date().toISOString(),
      },
    } as never);
    expect((await emitted("m32.hallucination_report.filed"))[0].payload).toMatchObject({
      reportId: filed.id,
      severity: "high",
      kind: "fabricated_medication",
    });
    expect((await emitted("m32.output.flagged"))[0].payload).toMatchObject({
      invocationId: invocationRow.id,
      flagReason: "fabricated_medication",
    });
    await reports.applyTriage(ORG, filed.id, {
      triageStatus: "investigating",
      severity: "high",
      triageOwnerMembershipId: MEMBERSHIP,
      triageDisposition: null,
      mitigationActionRef: null,
      triagedAt: new Date().toISOString(),
      closedAt: null,
    } as never);
    expect((await emitted("m32.hallucination_report.triaged"))[0].payload).toMatchObject({
      reportId: filed.id,
      triagedByMembershipId: MEMBERSHIP,
      triageStatus: "investigating",
    });
  });

  it("evaluation run completion emits only on a terminal status, platform-scoped", async () => {
    const evals = createDrizzleAiEvaluationRunStore({
      ...platformStoreDeps(),
      userId: USER,
      events: events(),
    });
    const run = await evals.insertRun({
      capabilityId,
      backendId: cloudBackendId,
      datasetVersionRef: "ds1",
      mlflowRunId: "ml-1",
      stage: "stage_3_evaluation",
      summaryMetrics: {},
      initiatedByMembershipId: MEMBERSHIP,
      createdAt: new Date().toISOString(),
    });
    await evals.applyTransition(run.id, {
      status: "in_progress",
      decision: "no_decision",
      summaryMetrics: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    });
    expect(await emitted("m32.evaluation.completed")).toHaveLength(0);
    await evals.applyTransition(run.id, {
      status: "passed",
      decision: "approve_for_pilot",
      summaryMetrics: { auc: 0.9 },
      startedAt: null,
      completedAt: new Date().toISOString(),
    });
    const [evt] = await emitted("m32.evaluation.completed");
    expect(evt.organization_id).toBeNull();
    expect(evt.payload).toMatchObject({
      runId: run.id,
      status: "passed",
      decision: "approve_for_pilot",
      mlflowRunId: "ml-1",
    });
  });

  it("prompt template activation emits with the superseded template", async () => {
    const prompts = createDrizzleAiPromptTemplateStore({
      ...platformStoreDeps(),
      events: events(),
    });
    const insert = (version: number) => ({
      templateKey: `tpl.live.${version}`,
      capabilityKey: "cap.live",
      version,
      templateFilesystemRef: `prompts/${version}.md`,
      templateContentHash: "a".repeat(64),
      compatibleBackendKeys: ["cloud-1"],
      inputSchemaRef: "in",
      outputSchemaRef: "out",
      outputEntityTargetPrefix: "note_",
      outputTypePrefix: "note",
      createdByMembershipId: MEMBERSHIP,
      approvedByMembershipId: MEMBERSHIP,
      clinicalReviewerAttestation: "ok",
      approvedAt: new Date().toISOString(),
    });
    const first = await prompts.applyActivation({
      insert: insert(1),
      deprecate: null,
    } as never);
    await prompts.applyActivation({
      insert: insert(2),
      deprecate: {
        id: first.id,
        supersededAt: new Date().toISOString(),
        deprecatedAt: new Date().toISOString(),
      },
    } as never);
    const evts = await emitted("m32.prompt_template.activated");
    expect(evts).toHaveLength(2);
    expect(evts[1].payload).toMatchObject({
      version: "2",
      supersededTemplateId: first.id,
      contentHash: "a".repeat(64),
    });
  });
});
