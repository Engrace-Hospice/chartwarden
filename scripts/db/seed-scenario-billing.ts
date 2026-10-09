/**
 * WardenX — revenue-cycle scenario data: M23 (Billing-Medicare) / M24 (Billing-Medicaid) / M25
 * (Remittance/Denials) / M26 (Cap Management) / M27 (Cost Report) for the flagship patient + org
 * (local dev). NOT for production.
 *
 * Genuine platform gaps hit and worked around/documented (all confirmed by reading the actual route/
 * write-service code, not assumed):
 *
 *   - M23: worse than "stops at DRAFT" — `POST /billing/claims/assemble` itself is unconditionally
 *     unreachable, though LESS unconditionally than this comment used to say (#250 bound four of the
 *     eleven reader seams for real: `patientPayer`, `mdm.resolveProviderEntity`, and two of
 *     `referenceData`'s four methods — see `boot-assembly.ts`'s header for the exact per-seam
 *     accounting). `assemble()`'s SECOND read, `admission.resolveForRange` (M6), still throws
 *     `SEAM_UNBOUND` for every real call — M6's published seam readers are id/single-date-keyed and
 *     none answers "every period for this patient overlapping this range", which needs a real new
 *     read-surface addition to M6's own seam layer, not an M23-side adapter. M23 stays skipped entirely
 *     below — even the validate/eligibility queueName↔event-string mismatch this comment originally
 *     flagged (`M23_SUBMISSION_REQUEST_EVENTS` never contains `"validation-run"`/`"eligibility.refresh"`)
 *     is moot once assemble itself can't run.
 *   - M25: `POST /api/v1/internal/remittance/advices` — the ONLY route that creates a remittance/835
 *     row — was gated on `request.context?.attributes?.systemPrincipal === true`, a field nothing wrote;
 *     that was fixed on `main` at commit `46414c60` (#75/#76, F-030) well before #250 — the guard now
 *     checks the real, stamped `actorKind === "system"` field and `INTERNAL_SERVICE_TOKEN` verification
 *     is production-wired (`apps/backend/src/index.ts` ~line 3267). The route IS reachable and correctly
 *     gated. M25 stays skipped here for the reason #250 confirmed is the true one: no X12-835 sidecar
 *     (`M25_X12_WORKER_URL`) is configured in any environment and the clearinghouse-pull transport that
 *     would stage an 835 for this route to receive is unbuilt — `denials.routes.ts`/`appeals.routes.ts`
 *     have no create routes at all, both spawned by that same unreachable ingest worker. There is no
 *     API-reachable seed for M25 today, but not because of an authz bug.
 *   - M24: two prerequisites `assembleClaim` needs that nothing seeds by default:
 *       (a) `patient_payer` — the M5 row `activeMedicaidCoverage` reads. `GET /patients/:id/payers`
 *           is the only route touching this table; there is NO create route anywhere in M5 (confirmed
 *           by grep of `patient-route-service-db.ts`'s exported methods — `listPayers`, no `create*`).
 *           DB-direct insert, same documented-workaround pattern as this project's other confirmed
 *           no-API-path tables. The existing seeded `payer` row for `kind='medicaid'` is North Carolina
 *           (mismatched with the Oregon adapter), so this also DB-direct-seeds one Oregon Medicaid
 *           `payer` row — `payer` is M40 MDM reference data with no write route at all (RLS grants
 *           `wardenx_app` SELECT only), the same class as `seed-org-structure.ts`'s provider_entity.
 *       (b) `state_medicaid_trading_partner_credential` for the PE/OR — DOES have a real route
 *           (`POST /state-medicaid-trading-partner-credentials`), used here, but it is ALSO
 *           `STEP_UP`-gated, hitting the exact same unreachable-step-up-route gap as `submitClaim`
 *           below — one `stepUpSession()` nudge (lib/step-up.ts) covers both calls.
 *     `submitClaim`'s D12 step-up gate (`STEP_UP("medicaid.claim.submit")`) uses the REAL
 *     `step_up_recent` ABAC predicate, which reads `session.last_step_up_at`/`last_step_up_factor` —
 *     NOT the raw-header trick M14's adjourn route accepts. The step-up verify routes
 *     (`POST /sessions/step-up/initiate` and `/step-up`, `apps/backend/src/modules/02-identity/routes/
 *     session-step-up.ts`) are exported from M2's index but never imported/mounted in
 *     `apps/backend/src/index.ts` — confirmed by grep, same unreachable-mount class as M19's missing
 *     outbox catalog. `stepUpSession()` (lib/step-up.ts) nudges the actor's own `session` row directly (columns
 *     the real step-up flow would have written) rather than fabricating a bypass — same documented
 *     DB-direct-workaround pattern used elsewhere in this project for a confirmed no-API-path gap.
 *   - M26: `POST /cap/periods` 409s `CAP_CONSTANT_UNPUBLISHED` unless a platform cap-year constant was
 *     published first (`POST /platform/cap/constants`), which needs the `platform_admin` role (a
 *     DIFFERENT axis from the tenant `org_admin` role `seed-org-admin.ts` grants) — this script grants
 *     it to `orgadmin@wardenx.local` alongside the PE/location scope M24's pure-scope ABAC needs.
 *   - M27: the entire approver plane (`approve-for-submit` / `submit` / `submit-past-deadline` /
 *     `reopen` / validation-result `override`) is gated by `cost_report_approver_for_provider`, whose
 *     real Drizzle resolver hard-codes `hasElevatedApproval` to `return false` unconditionally
 *     (`abac-predicates.ts` — comment: "NOT a landed column / seam ... denies until that per-tenant
 *     policy lands"). No role or permission bypasses it. This script only drives the EDITOR plane
 *     (create → refresh-inputs → allocate → one worksheet PUT → statistics/refresh → validate-trigger)
 *     and stops there; `validate` itself never resolves without a live BullMQ worker (`REDIS_URL`
 *     unset in bare local dev), which is fine — the report visibly sitting in `validating` is a real,
 *     honest QA state, not a bug.
 *
 * Idempotent: wipes prior M23/M24/M26/M27 rows for Whitfield/the org before recreating (M26's platform
 * constant is left alone — `publishConstant` itself is `onConflictDoNothing`, so re-running is already
 * idempotent without a wipe).
 * Prereqs: bun run db:seed:org-admin, db:seed:staff, db:seed:scenario-admissions, db:seed:org-structure.
 * Run:     bun run db:seed:scenario-billing
 */
import { Client } from "pg";
import { ScenarioLog, findPatientIdByLastName, signIn } from "./lib/api-session";
import { grantPlatformRole } from "./lib/platform-role";
import { stepUpSession } from "./lib/step-up";
import { seedWageIndex } from "./seed-wage-index";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const PROVIDER_ENTITY_ID = "44444444-0000-4000-8000-000000000001"; // db:seed:org-structure
const LOCATION_MAIN_ID = "55555555-0000-4000-8000-000000000001"; // db:seed:org-structure
// FY2024/FY2025 are pre-published (migration 0091); FY2026 is deliberately seeded with a NULL amount
// ("left unpublished until the CMS FY2026 Final Rule") and ON CONFLICT DO NOTHING would no-op against
// it. FY2027 has no row at all, so `publishConstant` genuinely exercises the insert path.
const CAP_YEAR = "FY2027";
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
const today = new Date();
const daysAgo = (n: number): Date => new Date(today.getTime() - n * 86_400_000);

/**
 * Grants `orgadmin@wardenx.local` (created by `seed-org-admin.ts`) the PE/location scope M24's pure
 * `provider_entity_medicaid_billing_scope` check needs (no `org_admin` bypass exists for M24 — see
 * `abac-predicates.ts`), plus the `platform_admin` ROLE M26's `cap_platform_admin` predicate checks
 * (`context.roles.includes("platform_admin")` — a role-array membership check, same mechanism as every
 * discipline-role predicate in this codebase; granting it here does not touch the permission catalog).
 */
async function grantBillingScope(organizationId: string, membershipId: string): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");
  await db.query(
    `UPDATE membership SET default_provider_entity_id = $2, default_location_ids = $3::jsonb WHERE id = $1`,
    [membershipId, PROVIDER_ENTITY_ID, JSON.stringify([LOCATION_MAIN_ID])],
  );
  // Platform-owned since GAP-003: a tenant `platform_admin` row confers nothing and 0318 refuses it.
  await grantPlatformRole(db, {
    organizationId,
    membershipId,
    key: "platform_admin",
    name: "Platform Administrator (dev seed)",
    description:
      "Grants cap_platform_admin ABAC for the M26 platform cap-constant surface (dev seed only)",
  });
  await db.end();
}

const OREGON_MEDICAID_PAYER_ID = "00000000-0000-0000-0000-0000000000a3"; // fixed dev-seed id, distinct from db:seed's NC row

/**
 * GENUINE GAP (see file header): no route creates a `patient_payer` row, and the only seeded Medicaid
 * `payer` is North Carolina — mismatched with M24's Oregon-only adapter. DB-direct-seeds both, same
 * documented workaround pattern this project uses for other confirmed no-API-path tables.
 */
async function seedMedicaidCoverage(
  organizationId: string,
  providerEntityId: string,
  patientId: string,
): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");
  await db.query(
    `INSERT INTO payer (id, kind, state_code, name) VALUES ($1, 'medicaid', 'OR', 'Oregon Health Plan')
     ON CONFLICT (id) DO NOTHING`,
    [OREGON_MEDICAID_PAYER_ID],
  );
  // rank 1 is already taken by the db:seed:patients Medicare row every demo patient carries.
  await db.query(
    `INSERT INTO patient_payer
       (patient_id, organization_id, provider_entity_id, payer_id, rank, coverage_kind, subscriber_id, effective_from)
     VALUES ($1,$2,$3,$4,2,'medicaid','OHP-DEV-0001', CURRENT_DATE - 90)`,
    [patientId, organizationId, providerEntityId, OREGON_MEDICAID_PAYER_ID],
  );
  await db.end();
}

async function wipePriorBilling(patientId: string, organizationId: string): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");

  // M23 — claim + children (partitioned; DELETE on the parent reaches whichever partition holds it).
  const claims = await db.query<{ id: string }>("SELECT id FROM claim WHERE patient_id = $1", [
    patientId,
  ]);
  const claimIds = claims.rows.map((r) => r.id);
  if (claimIds.length) {
    for (const t of [
      "claim_line",
      "claim_state_history",
      "validation_run",
      "validation_result",
      "claim_acknowledgment",
      "claim_submission",
    ]) {
      await db.query(`DELETE FROM ${t} WHERE claim_id = ANY($1)`, [claimIds]);
    }
    await db.query("DELETE FROM claim WHERE id = ANY($1)", [claimIds]);
  }

  // M24 — medicaid_claim + children (partitioned by provider_entity_id).
  const mClaims = await db.query<{ id: string }>(
    "SELECT id FROM medicaid_claim WHERE patient_id = $1",
    [patientId],
  );
  const mClaimIds = mClaims.rows.map((r) => r.id);
  if (mClaimIds.length) {
    for (const t of ["medicaid_claim_line", "medicaid_claim_state_history"]) {
      await db.query(`DELETE FROM ${t} WHERE medicaid_claim_id = ANY($1)`, [mClaimIds]);
    }
    await db.query("DELETE FROM medicaid_claim WHERE id = ANY($1)", [mClaimIds]);
  }
  await db.query("DELETE FROM patient_payer WHERE patient_id = $1 AND coverage_kind = 'medicaid'", [
    patientId,
  ]);
  await db.query(
    `DELETE FROM state_medicaid_trading_partner_credential WHERE organization_id = $1 AND provider_entity_id = $2 AND service_state = 'OR'`,
    [organizationId, PROVIDER_ENTITY_ID],
  );

  // M26 — this org's cap period for CAP_YEAR + children (the platform constant is left standing —
  // publishConstant is onConflictDoNothing, so re-publishing it is already idempotent).
  const periods = await db.query<{ id: string }>(
    "SELECT id FROM cap_period WHERE organization_id = $1 AND cap_year = $2",
    [organizationId, CAP_YEAR],
  );
  const periodIds = periods.rows.map((r) => r.id);
  if (periodIds.length) {
    for (const t of [
      "cap_beneficiary_accrual",
      "cap_inpatient_accrual",
      "cap_period_methodology_lock",
      "cap_psr_import",
      "cap_psr_reconciliation",
      "cap_settlement",
      "cap_threshold_event",
      "cap_projection_snapshot",
    ]) {
      await db.query(`DELETE FROM ${t} WHERE cap_period_id = ANY($1)`, [periodIds]).catch(() => {});
    }
    await db.query("DELETE FROM cap_period WHERE id = ANY($1)", [periodIds]);
  }

  // M27 — this org's cost report for the PE + fiscal year window used below.
  const reports = await db.query<{ id: string }>(
    `SELECT id FROM cost_report WHERE organization_id = $1 AND provider_entity_id = $2`,
    [organizationId, PROVIDER_ENTITY_ID],
  );
  const reportIds = reports.rows.map((r) => r.id);
  if (reportIds.length) {
    for (const t of [
      "bad_debt_record",
      "cost_report_compliance_window",
      "cost_report_snapshot",
      "cost_report_validation",
      "cost_report_worksheet",
      "ecr_submission",
      "statistic_data",
      "trial_balance_import",
      "wage_data_import",
    ]) {
      await db
        .query(`DELETE FROM ${t} WHERE cost_report_id = ANY($1)`, [reportIds])
        .catch(() => {});
    }
    await db.query("DELETE FROM cost_report WHERE id = ANY($1)", [reportIds]);
  }

  await db.end();
}

/**
 * Upserts the demo provider entity's MAC submitter credential through the real (step-up) route. The API needs
 * `M24_CREDENTIAL_ENCRYPTION_KEY` to seal the secret (documented in `.env.example`); without it the route answers
 * 503 and this seed fails loudly rather than leaving Medicare assemble at MAC_SUBMITTER_CREDENTIAL_MISSING.
 */
async function seedMacSubmitterCredential(
  admin: Awaited<ReturnType<typeof signIn>>,
): Promise<void> {
  await stepUpSession(admin.userId);
  const res = await admin.client.POST("/api/v1/billing/mac-credentials", {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: {
      providerEntityId: PROVIDER_ENTITY_ID,
      macJurisdiction: "cgs_j15",
      submitterId: "DEV-SUBMITTER-0001",
      tradingPartnerId: "DEV-TP-0001",
      clientId: "wardenx-dev-client",
      clientSecret: "dev-only-not-a-real-secret",
    },
  });
  // An existing credential answers 428 IF_MATCH_REQUIRED — already seeded is fine on a re-run.
  if (res.error && res.response.status !== 428) {
    throw new Error(`MAC submitter credential upsert failed: ${JSON.stringify(res.error)}`);
  }
}

/** The federal fiscal year (Oct 1) an ISO date falls in, as its starting calendar year. */
function fiscalYearStartingOf(isoDate: string): number {
  const year = Number(isoDate.slice(0, 4));
  return Number(isoDate.slice(5, 7)) >= 10 ? year : year - 1;
}

async function main(): Promise<void> {
  const admin = await signIn("orgadmin@wardenx.local");
  const log = new ScenarioLog("billing (Whitfield / org-wide)");

  // The census AND the chart's election/certification read are patient-scoped (F-096; `election.read` is
  // `caseload_or_scope`), and `org_admin` is a tenant administrator, not an org-wide patient reader, so both
  // are done as the admin persona the admissions scenario uses (attending on the demo caseload). The billing
  // writes below stay with `orgadmin`, who holds the billing permissions and the PE/location scope.
  const chartReader = await signIn("admin@wardenx.local");
  const patientId = await findPatientIdByLastName(chartReader, "Whitfield");
  const cert = await chartReader.client.GET("/api/v1/patients/{patientId}/election-certification", {
    params: { path: { patientId } },
  });
  const admissionId = (cert.data as unknown as { admission?: { id?: string } } | undefined)
    ?.admission?.id;
  if (!admissionId)
    throw new Error("Whitfield has no admission — run db:seed:scenario-admissions first");

  console.log("wiping any prior billing data for a clean re-run...");
  await wipePriorBilling(patientId, admin.organizationId);

  const authCtx = await admin.client.GET("/api/v1/auth/context", {});
  const membershipId = (authCtx.data as unknown as { membershipId?: string } | undefined)
    ?.membershipId;
  if (!membershipId)
    throw new Error("could not resolve orgadmin's membershipId from /auth/context");
  await grantBillingScope(admin.organizationId, membershipId);

  // Whitfield's M6 level-of-care period starts the day the admission scenario script ran (today), not
  // 30 days ago — a window ending yesterday overlaps no LOC period at all (confirmed live:
  // MEDICAID_NO_BILLABLE_LOC_DAYS). serviceTo must include today.
  const serviceFrom = isoDate(daysAgo(7));
  const serviceTo = isoDate(today);

  // ── M23 — Billing Medicare: the provider entity's MAC submitter credential ─────────────────────────
  // Claim assembly resolves the provider entity's MAC jurisdiction from this credential; without one every
  // Medicare assemble for the demo org fails (it used to surface as PROVIDER_ENTITY_UNRESOLVED, now as
  // MAC_SUBMITTER_CREDENTIAL_MISSING). Oregon's home health & hospice MAC is CGS (J15). Dev credential
  // only — no clearinghouse is configured locally, so nothing is ever submitted with it.
  await seedMacSubmitterCredential(admin);
  // The demo provider (CCN 381588, Pendleton OR, ZIP 97801) wage index, taken from the CMS hospice geography
  // (migration 1058) instead of keyed by hand: the provider's ZIP is placed in its CBSA / rural area.
  const fiscalYear = fiscalYearStartingOf(serviceFrom);
  const demoWageIndex = await seedWageIndex(admin, {
    ccn: "381588",
    zip: "97801",
    fiscalYears: [fiscalYear - 1, fiscalYear],
  });
  log.dup(`Medicare (M23): demo provider wage index seeded — ${demoWageIndex.join("; ")}`);
  log.dup(
    "Medicare (M23): MAC submitter credential seeded; rate tables / sequestration are tenant-entered (assemble names whichever is missing)",
  );

  // ── M24 — Billing Medicaid (full lifecycle: assemble → validate → submit) ──────────────────────────
  try {
    await seedMedicaidCoverage(admin.organizationId, PROVIDER_ENTITY_ID, patientId);

    await stepUpSession(admin.userId);
    const credential = await admin.client.POST(
      "/api/v1/state-medicaid-trading-partner-credentials",
      {
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: {
          providerEntityId: PROVIDER_ENTITY_ID,
          serviceState: "OR",
          channel: "direct_mmis",
          tradingPartnerId: "OHP-DEV-TP-0001",
          activeFrom: serviceFrom,
        },
      },
    );
    if (credential.error)
      throw new Error(
        `trading-partner credential upsert failed: ${JSON.stringify(credential.error)}`,
      );

    const claim = await admin.client.POST("/api/v1/medicaid-claims", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: {
        patientId,
        admissionId,
        providerEntityId: PROVIDER_ENTITY_ID,
        serviceFrom,
        serviceTo,
        kind: "hospice_only",
      },
    });
    const claimData = claim.data as unknown as { id: string; version: number } | undefined;
    if (claim.error || !claimData)
      throw new Error(`medicaid claim assemble failed: ${JSON.stringify(claim.error)}`);

    const validate = await admin.client.POST("/api/v1/medicaid-claims/{id}/validate", {
      params: { path: { id: claimData.id } },
      headers: { "Idempotency-Key": crypto.randomUUID(), "If-Match": String(claimData.version) },
    });
    const validateData = validate.data as unknown as { version: number } | undefined;
    if (validate.error || !validateData)
      throw new Error(`medicaid claim validate failed: ${JSON.stringify(validate.error)}`);

    await stepUpSession(admin.userId);
    const submit = await admin.client.POST("/api/v1/medicaid-claims/{id}/submit", {
      params: { path: { id: claimData.id } },
      headers: { "Idempotency-Key": crypto.randomUUID(), "If-Match": String(validateData.version) },
      body: { channelHint: "direct_mmis" },
    });
    if (submit.error)
      throw new Error(`medicaid claim submit failed: ${JSON.stringify(submit.error)}`);

    log.ok("Medicaid (M24): 1 claim assembled, validated, and submitted (Oregon adapter)");
  } catch (err) {
    log.fail(`M24 Medicaid: ${String(err)}`);
  }

  // ── M25 — Remittance/Denials: SKIPPED, no API-reachable creation route (see file header) ───────────
  log.dup(
    "Remittance/Denials (M25): skipped — the create route is correctly gated and reachable; no X12-835 sidecar/clearinghouse-pull transport stages an 835 to receive",
  );

  // ── M26 — Cap Management (publish constant → open period → recompute) ──────────────────────────────
  try {
    const publish = await admin.client.POST("/api/v1/platform/cap/constants", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: {
        capYear: CAP_YEAR,
        aggregateCapAmountCents: 3_400_000_00,
        sourceUrl: "https://www.cms.gov/",
      },
    });
    if (publish.error)
      throw new Error(`publish cap constant failed: ${JSON.stringify(publish.error)}`);

    const period = await admin.client.POST("/api/v1/cap/periods", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: { capYear: CAP_YEAR },
    });
    const periodData = period.data as unknown as { id: string } | undefined;
    if (period.error || !periodData)
      throw new Error(`open cap period failed: ${JSON.stringify(period.error)}`);

    const recompute = await admin.client.POST("/api/v1/cap/projections/{periodId}/recompute", {
      params: { path: { periodId: periodData.id } },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    if (recompute.error)
      throw new Error(`cap recompute failed: ${JSON.stringify(recompute.error)}`);

    log.ok(
      `Cap Management (M26): ${CAP_YEAR} constant published, period opened, projection recomputed`,
    );
  } catch (err) {
    log.fail(`M26 Cap Management: ${String(err)}`);
  }

  // ── M27 — Cost Report (editor plane only — approver plane is unreachable, see file header) ─────────
  try {
    const fyStart = isoDate(new Date(today.getFullYear() - 1, 9, 1)); // Oct 1 last year
    const fyEnd = isoDate(new Date(today.getFullYear(), 8, 30)); // Sep 30 this year

    const report = await admin.client.POST("/api/v1/cost-reports", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: {
        providerEntityId: PROVIDER_ENTITY_ID,
        fiscalYearStartDate: fyStart,
        fiscalYearEndDate: fyEnd,
      },
    });
    const reportData = report.data as unknown as { costReportId: string } | undefined;
    if (report.error || !reportData)
      throw new Error(`cost report create failed: ${JSON.stringify(report.error)}`);
    const id = reportData.costReportId;

    const refresh = await admin.client.POST("/api/v1/cost-reports/{id}/refresh-inputs", {
      params: { path: { id } },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    if (refresh.error) throw new Error(`refresh-inputs failed: ${JSON.stringify(refresh.error)}`);

    const allocate = await admin.client.POST("/api/v1/cost-reports/{id}/allocate", {
      params: { path: { id } },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    if (allocate.error) throw new Error(`allocate failed: ${JSON.stringify(allocate.error)}`);

    // GET lazy-reads worksheet "S" (schema-valid empty default when unpersisted) then PUTs it straight
    // back — round-tripping a schema the write path already validated is real coverage of the write
    // path without needing to hand-author a CMS-1984-14 worksheet body.
    const ws = await admin.client.GET("/api/v1/cost-reports/{id}/worksheets/{code}", {
      params: { path: { id, code: "S" } },
    });
    const wsData = ws.data as unknown as { data: unknown } | undefined;
    if (ws.error || !wsData)
      throw new Error(`worksheet S read failed: ${JSON.stringify(ws.error)}`);
    const putWs = await admin.client.PUT("/api/v1/cost-reports/{id}/worksheets/{code}", {
      params: { path: { id, code: "S" } },
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: { expectedVersion: 1, data: wsData.data },
    });
    if (putWs.error) throw new Error(`worksheet S write failed: ${JSON.stringify(putWs.error)}`);

    const stats = await admin.client.POST("/api/v1/cost-reports/{id}/statistics/refresh", {
      params: { path: { id } },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    if (stats.error) throw new Error(`statistics refresh failed: ${JSON.stringify(stats.error)}`);

    const validate = await admin.client.POST("/api/v1/cost-reports/{id}/validate", {
      params: { path: { id } },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    if (validate.error)
      throw new Error(`validate-trigger failed: ${JSON.stringify(validate.error)}`);

    log.ok(
      "Cost Report (M27): created, inputs refreshed, allocated, worksheet S round-tripped, statistics refreshed, validation triggered (stays 'validating' — no live worker, see file header)",
    );
  } catch (err) {
    log.fail(`M27 Cost Report: ${String(err)}`);
  }

  log.summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
