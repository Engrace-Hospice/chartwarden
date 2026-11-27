/**
 * M24 Billing — Medicaid — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / §8.1 / ADR-0010).
 *
 * The pure unit suites (apps/backend/.../24-billing-medicaid, packages/medicaid-adapters) exercise the domain
 * but never touch a database, so they cannot catch a wrong RLS predicate, a missing WITH CHECK, or a base-table
 * grant that leaks across tenants. This test applies the actual migrations to a real Postgres and exercises the
 * policies as the unprivileged `chartwarden_app` role (no BYPASSRLS), proving cross-tenant denial for real on
 * all org-scoped M24 tables under the canonical `organization_id = current_setting('app.org_id')` ONE-SHAPE
 * policy (ADR-0010 D3 — no second PERMISSIVE provider_entity policy; PE narrowing is the M3 ABAC at the
 * handler) — including the six LIST-partitioned tables (the parent policy propagates to every partition incl.
 * DEFAULT, PG11+).
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live` (SUPERUSER to a THROWAWAY db;
 *     for a local PG without pgvector, set CHARTWARDEN_TEST_NO_PGVECTOR=1).
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropLiveRoles } from "./_live-roles";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PATIENT = "44444444-4444-4444-4444-444444444444";
/** Membership sentinels: the recorder of every row, and a second person who may verify it (four-eyes). */
const RECORDER = "00000000-0000-0000-0000-000000000000";
const REVIEWER = "00000000-0000-0000-0000-0000000000aa";

type SeedIds = {
  pe: string;
  claim: string;
  claimLine: string;
  lineEncounter: string;
  stateHistory: string;
  submission: string;
  acknowledgment: string;
  validationRun: string;
  validationResult: string;
  validationOverride: string;
  ruleConfig: string;
  eligibility: string;
  rbArrangement: string;
  rbDay: string;
  credential: string;
  programAssignment: string;
  enrollmentEvidence: string;
  payerAuthorizationEvent: string;
  payerRatePolicy: string;
  hospiceBillingEvidence: string;
  pricedClaim: string;
  pricedLine: string;
  pricingSnapshot: string;
  chcPreparation: string;
};

const COVERED: { table: string; key: keyof SeedIds; idCol?: string }[] = [
  { table: "medicaid_claim", key: "claim" },
  { table: "medicaid_claim_line", key: "claimLine" },
  { table: "medicaid_claim_line_encounter", key: "lineEncounter", idCol: "medicaid_claim_line_id" },
  { table: "medicaid_claim_state_history", key: "stateHistory" },
  { table: "medicaid_submission", key: "submission" },
  { table: "medicaid_acknowledgment", key: "acknowledgment" },
  { table: "medicaid_validation_run", key: "validationRun" },
  { table: "medicaid_validation_result", key: "validationResult" },
  { table: "medicaid_validation_override", key: "validationOverride" },
  { table: "medicaid_validation_rule_config", key: "ruleConfig" },
  { table: "medicaid_eligibility_check", key: "eligibility" },
  { table: "rb_arrangement", key: "rbArrangement" },
  { table: "rb_day", key: "rbDay" },
  { table: "state_medicaid_trading_partner_credential", key: "credential" },
  { table: "medicaid_program_assignment", key: "programAssignment" },
  { table: "medicaid_enrollment_evidence", key: "enrollmentEvidence" },
  { table: "medicaid_payer_authorization_event", key: "payerAuthorizationEvent" },
  { table: "medicaid_payer_rate_policy", key: "payerRatePolicy" },
  { table: "medicaid_hospice_billing_evidence", key: "hospiceBillingEvidence" },
  { table: "medicaid_claim_line_pricing_snapshot", key: "pricingSnapshot" },
  { table: "medicaid_chc_pricing_preparation", key: "chcPreparation" },
];

/**
 * The four tables 1535/1538/1539 add, each with ONE valid INSERT ($1 org, $2 provider entity, $3 patient,
 * $4 recorder) and the name of its BEFORE INSERT provider-entity guard. The statement satisfies every CHECK,
 * so the only things that can refuse it are the grant, RLS and that guard trigger.
 */
const NEW_TABLES = [
  {
    table: "medicaid_program_assignment",
    guard: "trg_medicaid_program_assignment_provider_entity",
    insert: `INSERT INTO medicaid_program_assignment
      (organization_id, provider_entity_id, recorded_by_membership_id, patient_id, patient_payer_id, admission_id,
       service_state, program_kind, canonical_payer_id, status, effective_from, source_kind)
      VALUES ($1,$2,$3,$4,gen_random_uuid(),gen_random_uuid(),'OR','managed_care',gen_random_uuid(),
              'pending','2026-01-01','manual_candidate')`,
  },
  {
    table: "medicaid_enrollment_evidence",
    guard: "trg_medicaid_enrollment_evidence_provider_entity",
    insert: `INSERT INTO medicaid_enrollment_evidence
      (organization_id, provider_entity_id, recorded_by_membership_id, service_state, transaction_type,
       evidence_kind, status, effective_from)
      VALUES ($1,$2,$3,'OR','837I','837i_enrollment','pending','2026-01-01')`,
  },
  {
    table: "medicaid_payer_authorization_event",
    guard: "trg_medicaid_payer_authorization_evidence_status",
    insert: `INSERT INTO medicaid_payer_authorization_event
      (organization_id, provider_entity_id, recorded_by_membership_id, patient_id, patient_payer_id, admission_id,
       canonical_payer_id, service_state, service_from, service_to, event_kind, evidence_status, evidence_source)
      VALUES ($1,$2,$3,$4,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'OR','2026-01-01','2026-01-31',
              'authorization_pending','unverified','operator_record')`,
  },
  {
    table: "medicaid_payer_rate_policy",
    guard: "trg_medicaid_payer_rate_policy_status",
    insert: `INSERT INTO medicaid_payer_rate_policy
      (organization_id, provider_entity_id, recorded_by_membership_id, canonical_payer_id, program_kind,
       service_state, locality_code, service_category, unit_basis, rate_cents, source_kind, effective_from)
      VALUES ($1,$2,$3,gen_random_uuid(),'managed_care','OR','CBSA-TEST','RHC','per_day',10000,'cco_contract',
              '2026-01-01')`,
  },
] as const;

/** Bind exactly the parameters a statement mentions (pg refuses a bound parameter it never sees). */
const bindsFor = (insert: string, org: string, pe: string): string[] =>
  [org, pe, RECORDER, PATIENT].slice(
    0,
    Math.max(...[...insert.matchAll(/\$(\d)/g)].map((m) => Number(m[1]))),
  );

describe.skipIf(!DB_URL)(
  "M24 Billing — Medicaid — RLS cross-tenant denial — LIVE Postgres (§3.5)",
  () => {
    let db: Client;
    let a: SeedIds;
    let b: SeedIds;

    async function withOrg<T>(org: string, fn: () => Promise<T>): Promise<T> {
      await db.query("SET ROLE chartwarden_app");
      await db.query("SELECT set_config('app.org_id', $1, false)", [org]);
      try {
        return await fn();
      } finally {
        await db.query("RESET ROLE");
      }
    }

    /** Run `fn` with one trigger switched off (superuser connection), then switch it back on. */
    async function withTriggerOff<T>(
      table: string,
      trigger: string,
      fn: () => Promise<T>,
    ): Promise<T> {
      await db.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      try {
        return await fn();
      } finally {
        await db.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
      }
    }

    /** INSERT one row from a column->value map on the superuser connection (grants, RLS and CHECK-only guards). */
    async function insertRow(table: string, row: Record<string, unknown>): Promise<string> {
      const cols = Object.keys(row);
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
        Object.values(row),
      );
      return rows[0].id;
    }

    const assignmentRow = (over: Record<string, unknown> = {}) => ({
      organization_id: ORG_A,
      provider_entity_id: a.pe,
      patient_id: PATIENT,
      patient_payer_id: randomUUID(),
      admission_id: randomUUID(),
      service_state: "OR",
      program_kind: "managed_care",
      canonical_payer_id: randomUUID(),
      status: "pending",
      effective_from: "2026-01-01",
      source_kind: "manual_candidate",
      recorded_by_membership_id: RECORDER,
      ...over,
    });
    const assignmentVerification = {
      verified_at: "2026-02-01T00:00:00Z",
      verified_by_membership_id: REVIEWER,
      evidence_reference: "doc:synthetic-assignment-evidence",
    };
    const evidenceRow = (over: Record<string, unknown> = {}) => ({
      organization_id: ORG_A,
      provider_entity_id: a.pe,
      service_state: "OR",
      transaction_type: "837I",
      evidence_kind: "837i_enrollment",
      status: "pending",
      effective_from: "2026-01-01",
      recorded_by_membership_id: RECORDER,
      ...over,
    });
    const evidenceVerification = {
      verified_at: "2026-02-01T00:00:00Z",
      verified_by_membership_id: REVIEWER,
      verification_source: "state_registry",
      evidence_reference: "doc:synthetic-enrollment-evidence",
    };

    async function resetSchema() {
      await db.query("DROP SCHEMA IF EXISTS public CASCADE");
      await db.query("CREATE SCHEMA public");
      await dropLiveRoles(db);
    }

    async function applyMigrations() {
      const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
      const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const f of files) {
        let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        if (stripVector) {
          sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
        }
        try {
          await db.query(sql);
        } catch (cause) {
          throw new Error(
            `migration ${f} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
    }

    /** A source-verified RHC billing-evidence row (verified at the fixed past instant below). */
    const hospiceEvidenceRow = (org: string, pe: string, over: Record<string, unknown> = {}) => ({
      organization_id: org,
      provider_entity_id: pe,
      patient_id: PATIENT,
      admission_id: randomUUID(),
      admission_version: 0,
      canonical_payer_id: randomUUID(),
      program_kind: "managed_care",
      service_state: "OR",
      locality_code: "CBSA-FIX",
      locality_evidence_reference: "evidence:synthetic-test/locality",
      locality_evidence_version: 1,
      quality_reporting_applicability: "not_required",
      quality_reporting_status: "not_applicable",
      quality_evidence_reference: "evidence:synthetic-test/quality",
      quality_evidence_version: 1,
      service_category: "RHC",
      quantity_policy: "active_rhc_loc_calendar_day",
      quantity_evidence_owner: "m6_level_of_care_period",
      billing_unit: "daily",
      revenue_code: "0651",
      hcpcs_code: "Q5001",
      coding_profile: "local_draft_only",
      coding_evidence_reference: "evidence:synthetic-test/coding",
      coding_evidence_version: 1,
      billed_charge_cents_per_unit: 10000,
      charge_evidence_reference: "evidence:synthetic-test/charge",
      charge_evidence_version: 1,
      verification_status: "verified",
      effective_from: "2026-01-01",
      effective_to: "2026-01-31",
      source_document_reference: "doc:synthetic-test/billing-profile",
      verified_at: "2026-01-15T00:00:00Z",
      verified_by_membership_id: REVIEWER,
      recorded_by_membership_id: RECORDER,
      ...over,
    });
    /** A verified per-day managed-care RHC rate that agrees with `hospiceEvidenceRow` on payer and locality. */
    const verifiedRateRow = (org: string, pe: string, over: Record<string, unknown> = {}) => ({
      organization_id: org,
      provider_entity_id: pe,
      canonical_payer_id: randomUUID(),
      program_kind: "managed_care",
      service_state: "OR",
      locality_code: "CBSA-FIX",
      service_category: "RHC",
      unit_basis: "per_day",
      rate_cents: 12000,
      pricing_method: "per_day",
      quantity_conversion_method: "daily_units",
      minimum_duration_method: "not_applicable",
      methodology_version: 1,
      rounding_mode: "exact_only",
      rounding_boundary: "service_day",
      charge_ceiling_method: "none",
      charge_ceiling_boundary: "not_applicable",
      quality_reporting_applicability: "not_required",
      quality_reporting_status: "not_applicable",
      source_kind: "cco_contract",
      verification_status: "verified",
      effective_from: "2026-01-01",
      source_document_ref: "doc:synthetic-test/rate",
      verified_at: "2026-01-15T00:00:00Z",
      verified_by_membership_id: REVIEWER,
      recorded_by_membership_id: RECORDER,
      ...over,
    });

    type PricedChain = {
      org: string;
      pe: string;
      payer: string;
      admission: string;
      claim: string;
      rate: string;
      rateVersion: number;
      evidence: string;
      evidenceVersion: number;
    };

    /** One claim, one verified evidence row and one verified rate that all name the same payer and admission. */
    async function seedPricedChain(
      org: string,
      pe: string,
      over: { rate?: Record<string, unknown>; evidence?: Record<string, unknown> } = {},
    ): Promise<PricedChain> {
      const payer = randomUUID();
      const admission = randomUUID();
      const evidence = await insertRow(
        "medicaid_hospice_billing_evidence",
        hospiceEvidenceRow(org, pe, {
          canonical_payer_id: payer,
          admission_id: admission,
          ...over.evidence,
        }),
      );
      const rate = await insertRow(
        "medicaid_payer_rate_policy",
        verifiedRateRow(org, pe, { canonical_payer_id: payer, ...over.rate }),
      );
      const claim = await insertRow("medicaid_claim", {
        organization_id: org,
        provider_entity_id: pe,
        patient_id: PATIENT,
        patient_payer_id: randomUUID(),
        admission_id: admission,
        service_state: "OR",
        kind: "hospice_only",
        tob: "0813",
        service_from: "2026-01-01T00:00:00Z",
        service_to: "2026-01-31T00:00:00Z",
        state_plan_code_id: randomUUID(),
        state_plan_code_snapshot: "OHP",
        medicaid_claim_control_number: `T-${randomUUID().slice(0, 24)}`,
        created_by_membership_id: RECORDER,
        updated_by_membership_id: RECORDER,
        medicaid_program_kind: "managed_care",
        canonical_payer_id: payer,
      });
      return {
        org,
        pe,
        payer,
        admission,
        claim,
        rate,
        rateVersion: 1,
        evidence,
        evidenceVersion: 1,
      };
    }

    /** A database-clock instant `offset` from now, as the millisecond ISO string the application writes. */
    async function dbInstant(offset: string): Promise<string> {
      const { rows } = await db.query<{ t: string }>(
        `SELECT to_char((clock_timestamp() + $1::interval) AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`,
        [offset],
      );
      return rows[0].t;
    }

    /** The snapshot JSON the application would write for the two-day line `insertPricedLineStatements` inserts. */
    const snapshotFor = (
      chain: PricedChain,
      lineId: string,
      assessedAt: string,
      over: Record<string, unknown>,
    ) => ({
      schemaVersion: 1,
      postingAuthorized: false,
      medicaidClaimId: chain.claim,
      claimLineId: lineId,
      payerRatePolicyId: chain.rate,
      billingEvidenceId: chain.evidence,
      billingEvidenceVersion: chain.evidenceVersion,
      rateVersion: chain.rateVersion,
      rateCents: 12000,
      billedChargeCentsPerUnit: 10000,
      billedChargeCents: 20000,
      quantity: { basis: "per_day", units: 2 },
      levelOfCare: "RHC",
      revenueCode: "0651",
      hcpcsCode: "Q5001",
      codingProfile: "local_draft_only",
      codingEvidenceVersion: 1,
      chargeEvidenceVersion: 1,
      serviceFrom: "2026-01-01",
      serviceTo: "2026-01-02",
      // Migration 1554's supported-profile guard: a v1 snapshot is the home RHC profile, so it names its residence.
      serviceLocation: {
        patientAddressId: "00000000-0000-4000-8000-0000000000a1",
        kind: "home",
        facilityId: null,
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-01-02",
      },
      locality: {
        code: "CBSA-FIX",
        evidenceReference: "evidence:synthetic-test/locality",
        evidenceVersion: 1,
      },
      qualityReporting: {
        applicability: "not_required",
        status: "not_applicable",
        evidenceReference: "evidence:synthetic-test/quality",
        evidenceVersion: 1,
      },
      // the methodology of verifiedRateRow's defaults: the insert guard binds these to the rate row
      pricingMethod: "per_day",
      methodologyVersion: 1,
      quantityConversionMethod: "daily_units",
      roundingMode: "exact_only",
      roundingBoundary: "service_day",
      chargeCeilingMethod: "none",
      chargeCeilingBoundary: "not_applicable",
      assessmentTimestamp: assessedAt,
      ...over,
    });

    type PricedLineOptions = {
      /** The instant written to BOTH assessed_at and the JSON (default: one second ahead of the database clock). */
      assessedAt?: string;
      /** Written to assessed_at instead of `assessedAt`, to prove the two must agree. */
      assessedAtColumn?: string;
      snapshot?: Record<string, unknown>;
      /** The line's service_date_to (default 2026-01-02, the snapshot's serviceTo); null leaves it unset. */
      lineServiceDateTo?: string | null;
    };

    /** Line numbers are unique per claim, and one chain's claim takes several lines. */
    let pricedLineNumber = 0;

    /** Insert a payer-priced line and its snapshot (the deferred trigger needs both in one transaction). */
    async function insertPricedLineStatements(
      chain: PricedChain,
      options: PricedLineOptions = {},
    ): Promise<{ line: string; snapshot: string }> {
      const assessedAt = options.assessedAt ?? (await dbInstant("1 second"));
      const line = randomUUID();
      pricedLineNumber += 1;
      const lineNumber = pricedLineNumber;
      await db.query(
        `INSERT INTO medicaid_claim_line
           (id, organization_id, provider_entity_id, medicaid_claim_id, line_number, service_date,
            service_date_to, revenue_code, q_code, level_of_care, loc_period_id, units,
            rate_at_assembly_cents, state_rate_schedule_id_snapshot, payer_rate_policy_id_snapshot,
            charges_cents, is_rb)
         VALUES ($1,$2,$3,$4,$6,'2026-01-01T00:00:00Z',$7::timestamptz,'0651','Q5001','RHC',
                 gen_random_uuid(),2,12000,NULL,$5,20000,false)`,
        [
          line,
          chain.org,
          chain.pe,
          chain.claim,
          chain.rate,
          lineNumber,
          options.lineServiceDateTo === undefined
            ? "2026-01-02T00:00:00Z"
            : options.lineServiceDateTo,
        ],
      );
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO medicaid_claim_line_pricing_snapshot
           (organization_id, provider_entity_id, medicaid_claim_id, medicaid_claim_line_id,
            payer_rate_policy_id, billing_evidence_id, snapshot_schema_version, assessed_at,
            fingerprint, snapshot, created_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7::timestamptz,
                 encode(digest(($8::jsonb - 'assessmentTimestamp')::text, 'sha256'), 'hex'),
                 $8::jsonb,$9)
         RETURNING id`,
        [
          chain.org,
          chain.pe,
          chain.claim,
          line,
          chain.rate,
          chain.evidence,
          options.assessedAtColumn ?? assessedAt,
          JSON.stringify(snapshotFor(chain, line, assessedAt, options.snapshot ?? {})),
          RECORDER,
        ],
      );
      return { line, snapshot: rows[0].id };
    }

    /** `insertPricedLineStatements` in its own transaction, optionally under another session TimeZone. */
    async function insertPricedLine(
      chain: PricedChain,
      options: PricedLineOptions & { timeZone?: string } = {},
    ): Promise<{ line: string; snapshot: string }> {
      await db.query("BEGIN");
      try {
        if (options.timeZone) await db.query(`SET LOCAL TIME ZONE '${options.timeZone}'`);
        const inserted = await insertPricedLineStatements(chain, options);
        await db.query("COMMIT");
        return inserted;
      } catch (cause) {
        await db.query("ROLLBACK");
        throw cause;
      }
    }

    /** Seed one full M24 chain for `org` as superuser (RLS + grants bypassed). `n` distinguishes the rows. */
    // ── 1557 — the local home-CHC hourly preparation: one hourly evidence row, one per-hour rate that agree on payer
    // and locality, and the snapshot the application would write for one 540-minute service day.
    const CHC_DAY = "2026-01-05";
    type ChcChain = {
      org: string;
      pe: string;
      payer: string;
      admission: string;
      evidence: string;
      rate: string;
    };

    async function seedChcChain(
      org: string,
      pe: string,
      over: { rate?: Record<string, unknown>; evidence?: Record<string, unknown> } = {},
    ): Promise<ChcChain> {
      const payer = randomUUID();
      const admission = randomUUID();
      const evidence = await insertRow(
        "medicaid_hospice_billing_evidence",
        hospiceEvidenceRow(org, pe, {
          canonical_payer_id: payer,
          admission_id: admission,
          service_category: "CHC",
          quantity_policy: "m6_symptom_crisis_plus_signed_m8_rn_intervals_v1",
          quantity_evidence_owner: "m6_loc_m8_encounter",
          billing_unit: "hourly",
          revenue_code: null,
          hcpcs_code: null,
          billed_charge_cents_per_unit: 7000,
          ...over.evidence,
        }),
      );
      const rate = await insertRow(
        "medicaid_payer_rate_policy",
        verifiedRateRow(org, pe, {
          canonical_payer_id: payer,
          service_category: "CHC",
          unit_basis: "per_hour",
          rate_cents: 5000,
          pricing_method: "per_hour",
          quantity_conversion_method: "hourly_prorated_minutes",
          minimum_duration_method: "minimum_minutes",
          minimum_clinical_minutes: 480,
          maximum_clinical_minutes: 600,
          ...over.rate,
        }),
      );
      return { org, pe, payer, admission, evidence, rate };
    }

    const chcSnapshot = (
      chain: ChcChain,
      preparationId: string,
      version: number,
      assessedAt: string,
      over: Record<string, unknown>,
    ) => ({
      schemaVersion: 1,
      profile: "home_chc_hourly_local_v1",
      preparationId,
      preparationVersion: version,
      organizationId: chain.org,
      providerEntityId: chain.pe,
      patientId: PATIENT,
      admissionId: chain.admission,
      serviceDate: CHC_DAY,
      serviceTimeZone: "America/Los_Angeles",
      canonicalPayerId: chain.payer,
      programKind: "managed_care",
      serviceState: "OR",
      programAssignment: { id: randomUUID() },
      payerProgramClassification: { id: randomUUID() },
      locReason: "symptom_crisis",
      clinicalMethod: "m6_symptom_crisis_plus_signed_m8_rn_intervals_v1",
      encounterSources: [{ encounterId: randomUUID() }],
      observedMinutes: 540,
      qualifiedMinutes: 540,
      quantityConversionMethod: "hourly_prorated_minutes",
      minimumClinicalMinutes: 480,
      maximumClinicalMinutes: 600,
      ratePolicyId: chain.rate,
      ratePolicyVersion: 1,
      rateSourceReference: "doc:synthetic-test/rate",
      rateCentsPerHour: 5000,
      billingEvidenceId: chain.evidence,
      billingEvidenceVersion: 1,
      codingProfile: "local_draft_only",
      codingEvidenceReference: "evidence:synthetic-test/coding",
      codingEvidenceVersion: 1,
      localityCode: "CBSA-FIX",
      localityEvidenceReference: "evidence:synthetic-test/locality",
      localityEvidenceVersion: 1,
      qualityApplicability: "not_required",
      qualityStatus: "not_applicable",
      qualityEvidenceReference: "evidence:synthetic-test/quality",
      qualityEvidenceVersion: 1,
      billedChargeEvidenceReference: "evidence:synthetic-test/charge",
      billedChargeEvidenceVersion: 1,
      billedChargeCentsPerHour: 7000,
      estimatedReimbursementCents: 45000,
      billedChargeCents: 63000,
      institutionalUnits: "unqualified",
      institutionalFormatQualified: false,
      postingAuthorized: false,
      assessedAt,
      integrityFingerprint: "a".repeat(64),
      ...over,
    });

    /** One preparation row; `drop` removes snapshot keys, `snapshot` overrides them, `column` overrides a column. */
    async function insertChcPreparation(
      chain: ChcChain,
      options: {
        preparationId?: string;
        version?: number;
        assessedAt?: string;
        snapshot?: Record<string, unknown>;
        drop?: string[];
        column?: Record<string, unknown>;
      } = {},
    ): Promise<string> {
      const preparationId = options.preparationId ?? randomUUID();
      const version = options.version ?? 1;
      // One second ahead of the database clock: the rate and the evidence were recorded a moment ago.
      const assessedAt = options.assessedAt ?? (await dbInstant("2 seconds"));
      const snapshot: Record<string, unknown> = chcSnapshot(
        chain,
        preparationId,
        version,
        assessedAt,
        {
          ...options.snapshot,
        },
      );
      for (const key of options.drop ?? []) delete snapshot[key];
      return insertRow("medicaid_chc_pricing_preparation", {
        preparation_id: preparationId,
        organization_id: chain.org,
        provider_entity_id: chain.pe,
        patient_id: PATIENT,
        admission_id: chain.admission,
        service_date: CHC_DAY,
        version,
        rate_policy_id: chain.rate,
        billing_evidence_id: chain.evidence,
        assessed_at: assessedAt,
        fingerprint: "a".repeat(64),
        snapshot,
        created_by_membership_id: RECORDER,
        ...options.column,
      });
    }

    async function seedOrg(org: string, n: number): Promise<SeedIds> {
      const st = "OR";
      const from = "2026-01-01";
      const to = "2026-01-31";
      const patient = "44444444-4444-4444-4444-444444444444";
      const m = "00000000-0000-0000-0000-000000000000"; // membership sentinel
      const pe = (
        await db.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'00000${n}','PE','123456789${n}','enc','0930') RETURNING id`,
          [org],
        )
      ).rows[0].id as string;
      const programAssignment = (
        await db.query(
          `INSERT INTO medicaid_program_assignment
           (organization_id, patient_id, patient_payer_id, admission_id, provider_entity_id, service_state,
            program_kind, canonical_payer_id, status, effective_from, source_kind, recorded_by_membership_id)
           VALUES ($1,$2,gen_random_uuid(),gen_random_uuid(),$3,'OR','managed_care',gen_random_uuid(),
            'pending',$4,'manual_candidate',$5) RETURNING id`,
          [org, patient, pe, from, m],
        )
      ).rows[0].id as string;
      const enrollmentEvidence = (
        await db.query(
          `INSERT INTO medicaid_enrollment_evidence
           (organization_id, provider_entity_id, service_state, transaction_type, evidence_kind, status, effective_from, recorded_by_membership_id)
           VALUES ($1,$2,'OR','837I','837i_enrollment','pending',$3,$4) RETURNING id`,
          [org, pe, from, m],
        )
      ).rows[0].id as string;
      const payerAuthorizationEvent = (
        await db.query(
          `INSERT INTO medicaid_payer_authorization_event
             (organization_id, provider_entity_id, patient_id, patient_payer_id, admission_id,
              canonical_payer_id, service_state, service_from, service_to, event_kind,
              evidence_status, evidence_source, evidence_reference, recorded_by_membership_id,
              clinical_document_id, encrypted_authorization_reference)
           VALUES ($1,$2,$3,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),$4,$5,$6,
                   'authorization_pending','unverified','operator_record','payer-response:synthetic-test',$7,
                   '55555555-5555-4555-8555-555555555555','synthetic-encrypted-authorization-reference')
           RETURNING id`,
          [org, pe, patient, st, from, to, m],
        )
      ).rows[0].id as string;
      const payerRatePolicy = (
        await db.query(
          `INSERT INTO medicaid_payer_rate_policy
             (organization_id, provider_entity_id, canonical_payer_id, program_kind, service_state,
              locality_code, service_category, unit_basis, bucket_from, bucket_to, rate_cents,
              source_kind, effective_from, recorded_by_membership_id, source_document_ref)
           VALUES ($1,$2,gen_random_uuid(),'managed_care','OR','CBSA-TEST','RHC','per_day',1,60,
                   10000,'cco_contract',$3,$4,'doc:synthetic-rate-source') RETURNING id`,
          [org, pe, from, m],
        )
      ).rows[0].id as string;
      const hospiceBillingEvidence = (
        await db.query(
          `INSERT INTO medicaid_hospice_billing_evidence
             (organization_id,provider_entity_id,patient_id,admission_id,admission_version,
              canonical_payer_id,program_kind,service_state,locality_code,locality_evidence_reference,
              locality_evidence_version,quality_reporting_applicability,quality_reporting_status,
              quality_evidence_reference,quality_evidence_version,service_category,quantity_policy,
              quantity_evidence_owner,billing_unit,revenue_code,hcpcs_code,coding_profile,
              coding_evidence_reference,coding_evidence_version,billed_charge_cents_per_unit,
              charge_evidence_reference,charge_evidence_version,verification_status,effective_from,
              effective_to,source_document_reference,verified_at,verified_by_membership_id,
              recorded_by_membership_id)
           VALUES ($1,$2,$3,gen_random_uuid(),0,gen_random_uuid(),'managed_care','OR','CBSA-TEST',
                   'evidence:synthetic-test/locality',1,'not_required','not_applicable',
                   'evidence:synthetic-test/quality',1,'RHC','active_rhc_loc_calendar_day',
                   'm6_level_of_care_period','daily','0651','Q5001','local_draft_only',
                   'evidence:synthetic-test/coding',1,10000,'evidence:synthetic-test/charge',1,
                   'verified',$4,$5,'doc:synthetic-test/billing-profile',now(),$6,$7)
           RETURNING id`,
          [org, pe, patient, from, to, REVIEWER, m],
        )
      ).rows[0].id as string;
      const claim = (
        await db.query(
          `INSERT INTO medicaid_claim (organization_id, provider_entity_id, patient_id, patient_payer_id, admission_id,
           service_state, kind, tob, service_from, service_to, state_plan_code_id, state_plan_code_snapshot,
           medicaid_claim_control_number, created_by_membership_id, updated_by_membership_id)
         VALUES ($1,$2,$3,gen_random_uuid(),gen_random_uuid(),$4,'hospice_only','0813',$5,$6,gen_random_uuid(),
           'OHP', $7, $8, $8) RETURNING id`,
          [org, pe, patient, st, from, to, `000000-OR-260101-0000${n}-00`, m],
        )
      ).rows[0].id as string;
      const claimLine = (
        await db.query(
          `INSERT INTO medicaid_claim_line (organization_id, provider_entity_id, medicaid_claim_id, line_number,
           service_date, revenue_code, q_code, level_of_care, loc_period_id, units, rate_at_assembly_cents,
           state_rate_schedule_id_snapshot, charges_cents)
         VALUES ($1,$2,$3,1,$4,'0651','Q5001','RHC',gen_random_uuid(),1,10000,gen_random_uuid(),10000) RETURNING id`,
          [org, pe, claim, from],
        )
      ).rows[0].id as string;
      const lineEncounter = (
        await db.query(
          `INSERT INTO medicaid_claim_line_encounter (medicaid_claim_line_id, encounter_id, organization_id)
         VALUES ($1,gen_random_uuid(),$2) RETURNING medicaid_claim_line_id AS id`,
          [claimLine, org],
        )
      ).rows[0].id as string;
      const stateHistory = (
        await db.query(
          `INSERT INTO medicaid_claim_state_history (organization_id, medicaid_claim_id, to_state, trigger_source)
         VALUES ($1,$2,'DRAFT','user') RETURNING id`,
          [org, claim],
        )
      ).rows[0].id as string;
      const submission = (
        await db.query(
          `INSERT INTO medicaid_submission (organization_id, medicaid_claim_id, provider_entity_id, service_state,
           channel, medicaid_claim_control_number, adapter_vendor, adapter_version)
         VALUES ($1,$2,$3,$4,'direct_mmis',$5,'deferred','0') RETURNING id`,
          [org, claim, pe, st, `000000-OR-260101-0000${n}-00`],
        )
      ).rows[0].id as string;
      const acknowledgment = (
        await db.query(
          `INSERT INTO medicaid_acknowledgment (organization_id, medicaid_claim_id, medicaid_submission_id, kind, outcome)
         VALUES ($1,$2,$3,'sync_277ca','accepted') RETURNING id`,
          [org, claim, submission],
        )
      ).rows[0].id as string;
      const validationRun = (
        await db.query(
          `INSERT INTO medicaid_validation_run (organization_id, medicaid_claim_id, rule_registry_version, triggered_by,
           claim_state_at_trigger, idempotency_key)
         VALUES ($1,$2,'1','manual','DRAFT',$3) RETURNING id`,
          [org, claim, `idem-${n}`],
        )
      ).rows[0].id as string;
      const validationResult = (
        await db.query(
          `INSERT INTO medicaid_validation_result (organization_id, medicaid_validation_run_id, rule_key, rule_version, outcome)
         VALUES ($1,$2,'medicaid.eligibility.active',1,'pass') RETURNING id`,
          [org, validationRun],
        )
      ).rows[0].id as string;
      const validationOverride = (
        await db.query(
          `INSERT INTO medicaid_validation_override (organization_id, medicaid_validation_result_id, medicaid_claim_id,
           rule_key, override_role_applied, reason, step_up_auth_token_at, actor_membership_id)
         VALUES ($1,$2,$3,'medicaid.eligibility.active','billing_manager',
           'a deliberate override reason that exceeds forty chars', now(), gen_random_uuid()) RETURNING id`,
          [org, validationResult, claim],
        )
      ).rows[0].id as string;
      const ruleConfig = (
        await db.query(
          `INSERT INTO medicaid_validation_rule_config (organization_id, rule_key, regulatory_required_snapshot, updated_by_membership_id)
         VALUES ($1,$2,false,$3) RETURNING id`,
          [org, `custom.rule.${n}`, m],
        )
      ).rows[0].id as string;
      const eligibility = (
        await db.query(
          `INSERT INTO medicaid_eligibility_check (organization_id, patient_id, patient_payer_id, service_state,
           as_of_service_date, outcome, stale_at)
         VALUES ($1,$2,gen_random_uuid(),$3,$4,'active', now() + interval '30 days') RETURNING id`,
          [org, patient, st, from],
        )
      ).rows[0].id as string;
      const rbArrangement = (
        await db.query(
          `INSERT INTO rb_arrangement (organization_id, patient_id, provider_entity_id, nf_facility_mdm_id,
           nf_facility_name_snapshot, effective_from, nf_per_diem_routine_cents, nf_per_diem_resp_cents,
           nf_per_diem_gip_cents, pass_through_pct, retention_pct, created_by_membership_id, updated_by_membership_id)
         VALUES ($1,$2,$3,gen_random_uuid(),'NF',$4,20000,25000,80000,95,5,$5,$5) RETURNING id`,
          [org, patient, pe, from, m],
        )
      ).rows[0].id as string;
      const rbDay = (
        await db.query(
          `INSERT INTO rb_day (organization_id, provider_entity_id, patient_id, rb_arrangement_id, service_date,
           loc_of_day, loc_period_id_snapshot, per_diem_cents_snapshot)
         VALUES ($1,$2,$3,$4,$5,'NF_RB',gen_random_uuid(),20000) RETURNING id`,
          [org, pe, patient, rbArrangement, from],
        )
      ).rows[0].id as string;
      const credential = (
        await db.query(
          `INSERT INTO state_medicaid_trading_partner_credential (organization_id, provider_entity_id, service_state,
           channel, trading_partner_id, active_from, created_by_membership_id, updated_by_membership_id)
         VALUES ($1,$2,$3,'direct_mmis','TP1',$4,$5,$5) RETURNING id`,
          [org, pe, st, from, m],
        )
      ).rows[0].id as string;
      const pricedChain = await seedPricedChain(org, pe);
      const priced = await insertPricedLine(pricedChain);
      const chcPreparation = await insertChcPreparation(await seedChcChain(org, pe));
      return {
        pe,
        claim,
        claimLine,
        lineEncounter,
        stateHistory,
        submission,
        acknowledgment,
        validationRun,
        validationResult,
        validationOverride,
        ruleConfig,
        eligibility,
        rbArrangement,
        rbDay,
        credential,
        programAssignment,
        enrollmentEvidence,
        payerAuthorizationEvent,
        payerRatePolicy,
        hospiceBillingEvidence,
        pricedClaim: pricedChain.claim,
        pricedLine: priced.line,
        pricingSnapshot: priced.snapshot,
        chcPreparation,
      };
    }

    beforeAll(async () => {
      db = new Client({ connectionString: DB_URL });
      await db.connect();
      await resetSchema();
      await applyMigrations();
      await db.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
        [ORG_A, ORG_B],
      );
      a = await seedOrg(ORG_A, 1);
      b = await seedOrg(ORG_B, 2);
    }, 120_000);

    afterAll(async () => {
      if (db) await db.end();
    });

    // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
    // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
    // scripts/db/migrate.ts grants exactly that behind CHARTWARDEN_DEV_BYPASSRLS=1, so this is reachable,
    // not theoretical. Six of fifteen suites asserted this and NONE of the four suites CI runs did.
    it("chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
      const { rows } = await db.query<{ rolbypassrls: boolean }>(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].rolbypassrls).toBe(false);
    });

    it("every M24 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
      const rls = readFileSync(join(MIGRATIONS_DIR, "0096_billing_medicaid_m24_rls.sql"), "utf8");
      const policyBlocks = rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? [];
      expect(policyBlocks.length).toBe(14);
      for (const block of policyBlocks) {
        const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((mm) => mm[1]);
        expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
        expect(block).not.toMatch(/pg_has_role/i);
        expect(block).not.toMatch(/IS NULL/i);
      }
      // The later migrations that add tenant tables: 1535 and 1551 (two each), 1538, 1539 and 1557 (one each).
      const laterMigrations = [
        ["1535_m24_payer_program_readiness.sql", 2],
        ["1538_m24_payer_authorization_evidence.sql", 1],
        ["1539_m24_payer_rate_policy_evidence.sql", 1],
        ["1551_m24_immutable_hospice_pricing_snapshots.sql", 2],
        ["1557_m24_chc_local_pricing_preparations.sql", 1],
      ] as const;
      for (const [file, expected] of laterMigrations) {
        const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
        const policies = sql.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? [];
        expect(policies, file).toHaveLength(expected);
        for (const block of policies) {
          const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((mm) => mm[1]);
          expect(new Set(vars), file).toEqual(new Set(["app.org_id"]));
          expect(block, file).not.toMatch(/pg_has_role/i);
          expect(block, file).not.toMatch(/IS NULL/i);
        }
      }
    });

    it.each(NEW_TABLES)(
      "$table: the live catalog holds exactly one org-keyed policy, RLS enabled and FORCEd",
      async ({ table }) => {
        const { rows: flags } = await db.query(
          "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass",
          [table],
        );
        expect(flags[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
        const { rows: policies } = await db.query<{
          cmd: string;
          roles: string;
          qual: string;
          with_check: string;
        }>(
          "SELECT cmd, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename=$1",
          [table],
        );
        expect(policies).toHaveLength(1);
        expect(policies[0].cmd).toBe("ALL");
        expect(policies[0].roles).toBe("{chartwarden_app}");
        for (const expression of [policies[0].qual, policies[0].with_check]) {
          expect(expression).toContain("app.org_id");
          expect(expression).not.toMatch(/select|pg_has_role|is null/i);
        }
      },
    );

    it.each(COVERED)(
      "$table: org A sees its row, org B cannot (cross-tenant denial)",
      async ({ table, key, idCol }) => {
        const id = a[key];
        const col = idCol ?? "id";
        const seenByA = await withOrg(ORG_A, () =>
          db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col}=$1`, [id]),
        );
        expect(seenByA.rows[0].n).toBe(1); // isolation is not "deny everything"
        const seenByB = await withOrg(ORG_B, () =>
          db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col}=$1`, [id]),
        );
        expect(seenByB.rows[0].n).toBe(0); // org B cannot read org A's row
      },
    );

    it("a WITH CHECK refuses an INSERT into another tenant's scope", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO medicaid_validation_rule_config (organization_id, rule_key, regulatory_required_snapshot, updated_by_membership_id)
           VALUES ($1,'cross.tenant.rule',false,'00000000-0000-0000-0000-000000000000')`,
            [ORG_A], // B tries to write a row scoped to A
          ),
        ),
      ).rejects.toThrow(/new row violates row-level security policy/);
    });

    it.each(NEW_TABLES)(
      "$table: org A can write its own row, and the WITH CHECK alone refuses org B writing into org A's scope",
      async ({ table, guard, insert }) => {
        // Control: the identical statement is valid for the owning tenant, so the refusal below cannot be a
        // CHECK, a missing grant or a typo.
        const own = await withOrg(ORG_A, () => db.query(insert, bindsFor(insert, ORG_A, a.pe)));
        expect(own.rowCount).toBe(1);
        // The provider-entity guard refuses a cross-tenant row first (the writer cannot see org A's provider
        // entity, and org B's would not match the row's organization), so only that guard is switched off:
        // what stands between org B and the insert is then the policy, and nothing else.
        await withTriggerOff(table, guard, async () => {
          await expect(
            withOrg(ORG_B, () => db.query(insert, bindsFor(insert, ORG_A, a.pe))),
          ).rejects.toThrow(/new row violates row-level security policy/);
        });
      },
    );

    it.each(
      COVERED.filter((t) =>
        ["medicaid_program_assignment", "medicaid_enrollment_evidence"].includes(t.table),
      ),
    )("$table: org B cannot UPDATE org A's row (USING covers writes)", async ({ table, key }) => {
      const res = await withOrg(ORG_B, () =>
        db.query(`UPDATE ${table} SET version = version + 1 WHERE id=$1`, [a[key]]),
      );
      expect(res.rowCount).toBe(0);
      const own = await withOrg(ORG_A, () =>
        db.query(`UPDATE ${table} SET version = version WHERE id=$1`, [a[key]]),
      );
      expect(own.rowCount).toBe(1);
    });

    it.each(NEW_TABLES)(
      "$table: a provider entity from another organization is refused by the guard (the row itself is valid for its tenant)",
      async ({ insert }) => {
        await expect(
          withOrg(ORG_A, () => db.query(insert, bindsFor(insert, ORG_A, b.pe))),
        ).rejects.toThrow(/provider entity must belong/);
      },
    );

    const APPEND_ONLY = [
      { table: "medicaid_payer_authorization_event", key: "payerAuthorizationEvent" },
      { table: "medicaid_payer_rate_policy", key: "payerRatePolicy" },
      { table: "medicaid_hospice_billing_evidence", key: "hospiceBillingEvidence" },
      { table: "medicaid_claim_line_pricing_snapshot", key: "pricingSnapshot" },
      { table: "medicaid_chc_pricing_preparation", key: "chcPreparation" },
    ] as const;

    it.each(APPEND_ONLY)(
      "$table: the append-only trigger refuses UPDATE and DELETE even on a superuser connection",
      async ({ table, key }) => {
        // A superuser holds every grant and skips RLS, so only the trigger can answer here.
        await expect(
          db.query(`UPDATE ${table} SET created_at = created_at WHERE id=$1`, [a[key]]),
        ).rejects.toThrow(/append-only/);
        await expect(db.query(`DELETE FROM ${table} WHERE id=$1`, [a[key]])).rejects.toThrow(
          /append-only/,
        );
      },
    );

    it.each(APPEND_ONLY)(
      "$table: the application role holds no UPDATE or DELETE grant",
      async ({ table, key }) => {
        await expect(
          withOrg(ORG_A, () =>
            db.query(`UPDATE ${table} SET created_at = created_at WHERE id=$1`, [a[key]]),
          ),
        ).rejects.toThrow(/permission denied for table/);
        await expect(
          withOrg(ORG_A, () => db.query(`DELETE FROM ${table} WHERE id=$1`, [a[key]])),
        ).rejects.toThrow(/permission denied for table/);
      },
    );

    it("authorization evidence cannot be inserted as verified by the application role", async () => {
      const verified = `INSERT INTO medicaid_payer_authorization_event
               (organization_id, provider_entity_id, patient_id, patient_payer_id, admission_id,
                canonical_payer_id, service_state, service_from, service_to, event_kind,
                evidence_status, evidence_source, evidence_reference, verified_at,
                verified_by_membership_id, recorded_by_membership_id)
             VALUES ($1,$2,$3,gen_random_uuid(),gen_random_uuid(),
                     gen_random_uuid(),'OR','2026-01-01','2026-01-31','authorization_approved',
                     'verified','payer_response','payer-response:test-review',now(),
                     gen_random_uuid(),gen_random_uuid())`;
      // Control: the same row is valid (every CHECK, RLS, grants); only a non-application role may write it.
      expect((await db.query(verified, [ORG_A, a.pe, PATIENT])).rowCount).toBe(1);
      await expect(
        withOrg(ORG_A, () => db.query(verified, [ORG_A, a.pe, PATIENT])),
      ).rejects.toThrow(/separate reviewer path/);
    });

    it("verified 835 enrollment requires a separately recorded freshness bound", async () => {
      await expect(
        db.query(
          `INSERT INTO medicaid_enrollment_evidence (organization_id, provider_entity_id, service_state,
           program_kind, canonical_payer_id, clearinghouse, vendor_account_ref, source_environment,
           vendor_payer_id, transaction_type, evidence_kind, status, effective_from, effective_to,
           verification_source, evidence_reference, verified_at, verified_by_membership_id,
           recorded_by_membership_id)
           VALUES ($1,$2,'OR','managed_care',gen_random_uuid(),'claimmd','synthetic-account','test',
           'synthetic-payer','835','835_era_enrollment','verified','2026-01-01','2026-12-31',
           'payer_confirmation','approval:synthetic-era',now(),gen_random_uuid(),gen_random_uuid())`,
          [ORG_A, a.pe],
        ),
      ).rejects.toThrow(/medicaid_enrollment_835_source_identity_ck/);
    });

    it("authorization event audit records omit patient and evidence references", async () => {
      const audit = await db.query<{ after: unknown }>(
        `SELECT after FROM audit_event
         WHERE resource_kind='medicaid_payer_authorization_event' AND resource_id=$1
         ORDER BY created_at DESC LIMIT 1`,
        [a.payerAuthorizationEvent],
      );
      expect(audit.rows).toHaveLength(1);
      const after = audit.rows[0].after as Record<string, unknown>;
      const payload = JSON.stringify(after);
      expect(payload).not.toContain("44444444-4444-4444-4444-444444444444");
      expect(payload).not.toContain("payer-response:synthetic-test");
      // The seed sets every scrubbed column, so each one reads "<changed>" (not an absent or NULL field).
      expect(payload).not.toContain("55555555-5555-4555-8555-555555555555");
      expect(payload).not.toContain("synthetic-encrypted-authorization-reference");
      for (const column of [
        "patient_id",
        "evidence_reference",
        "clinical_document_id",
        "encrypted_authorization_reference",
      ])
        expect(after[column]).toBe("<changed>");
    });

    it("payer rate policy: application inserts cannot assert verification, and the locality CHECK holds", async () => {
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO medicaid_payer_rate_policy
               (organization_id, provider_entity_id, canonical_payer_id, program_kind, service_state,
                locality_code, service_category, unit_basis, rate_cents, source_kind, effective_from,
                recorded_by_membership_id)
             VALUES ($1,$2,gen_random_uuid(),'managed_care','OR','   ','RHC','per_day',
                     10000,'cco_contract','2026-01-01','00000000-0000-0000-0000-000000000000')`,
            [ORG_A, a.pe],
          ),
        ),
      ).rejects.toThrow(/medicaid_payer_rate_policy_locality_valid/);
      const verified = `INSERT INTO medicaid_payer_rate_policy
               (organization_id, provider_entity_id, canonical_payer_id, program_kind, service_state,
                locality_code, service_category, unit_basis, bucket_from, bucket_to, rate_cents,
                source_kind, verification_status, effective_from, source_document_ref, verified_at,
                pricing_method, quantity_conversion_method, minimum_duration_method, minimum_clinical_minutes,
                methodology_version, rounding_mode, rounding_boundary,
                charge_ceiling_method, charge_ceiling_boundary, quality_reporting_applicability,
                quality_reporting_status,
                verified_by_membership_id, recorded_by_membership_id)
             VALUES ($1,$2,gen_random_uuid(),'managed_care','OR','CBSA-TEST','RHC','per_day',NULL,NULL,
                     10000,'cco_contract','verified','2026-01-01','doc:synthetic',now(),
                     'per_day','daily_units','not_applicable',NULL,1,'not_applicable','not_applicable',
                     'none','not_applicable','required','meets',
                     gen_random_uuid(),gen_random_uuid())`;
      // Control: the same row satisfies every CHECK, so the refusal is the verification guard.
      expect((await db.query(verified, [ORG_A, a.pe])).rowCount).toBe(1);
      await expect(
        db.query(verified.replace("'RHC'", "'IN_HOME_RESPITE'"), [ORG_A, a.pe]),
      ).rejects.toThrow(/medicaid_payer_rate_policy_verified_methodology/);
      await expect(withOrg(ORG_A, () => db.query(verified, [ORG_A, a.pe]))).rejects.toThrow(
        /separate reviewer path/,
      );
    });

    it("payer rate policy audit omits source document references", async () => {
      const audit = await db.query<{ after: unknown }>(
        `SELECT after FROM audit_event
         WHERE resource_kind='medicaid_payer_rate_policy' AND resource_id=$1
         ORDER BY created_at DESC LIMIT 1`,
        [a.payerRatePolicy],
      );
      expect(audit.rows).toHaveLength(1);
      const after = audit.rows[0].after as Record<string, unknown>;
      expect(JSON.stringify(after)).not.toContain("doc:synthetic");
      // The seed sets source_document_ref, so a missing scrub would leave the value here.
      expect(after.source_document_ref).toBe("<changed>");
    });

    it("hospice billing evidence audit records land with the patient, admission and every reference scrubbed", async () => {
      const audit = await db.query<{
        event_type: string;
        resource_kind: string;
        after: Record<string, unknown>;
      }>(
        `SELECT event_type, resource_kind, after FROM audit_event
         WHERE resource_kind='medicaid_hospice_billing_evidence' AND resource_id=$1
         ORDER BY created_at DESC LIMIT 1`,
        [a.hospiceBillingEvidence],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        event_type: "medicaid_hospice_billing_evidence.insert",
        resource_kind: "medicaid_hospice_billing_evidence",
      });
      const { after } = audit.rows[0];
      const payload = JSON.stringify(after);
      expect(payload).not.toContain(PATIENT);
      expect(payload).not.toContain("synthetic-test/");
      // The seed sets every scrubbed column, so each reads "<changed>" (not an absent or NULL field), while an
      // unscrubbed column stays readable: the payload is a real row, not an empty object.
      for (const column of [
        "patient_id",
        "admission_id",
        "locality_evidence_reference",
        "quality_evidence_reference",
        "coding_evidence_reference",
        "charge_evidence_reference",
        "source_document_reference",
      ])
        expect(after[column], column).toBe("<changed>");
      expect(after.locality_code).toBe("CBSA-TEST");
    });

    it("pricing snapshot audit records carry identities and the fingerprint, never the snapshot JSON", async () => {
      const audit = await db.query<{
        event_type: string;
        resource_kind: string;
        organization_id: string;
        after: Record<string, unknown>;
      }>(
        `SELECT event_type, resource_kind, organization_id, after FROM audit_event
         WHERE resource_kind='medicaid_claim_line_pricing_snapshot' AND resource_id=$1`,
        [a.pricingSnapshot],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        event_type: "medicaid_claim_line_pricing_snapshot.insert",
        resource_kind: "medicaid_claim_line_pricing_snapshot",
        organization_id: ORG_A,
      });
      const stored = await db.query<{ fingerprint: string }>(
        "SELECT fingerprint FROM medicaid_claim_line_pricing_snapshot WHERE id=$1",
        [a.pricingSnapshot],
      );
      expect(audit.rows[0].after).toEqual({
        medicaid_claim_id: a.pricedClaim,
        medicaid_claim_line_id: a.pricedLine,
        fingerprint: stored.rows[0].fingerprint,
        snapshot_schema_version: 1,
        posting_authorized: false,
      });
      expect(JSON.stringify(audit.rows[0].after)).not.toContain(PATIENT);
    });

    it("program assignment and enrollment evidence audit records land, attributed and scrubbed", async () => {
      const assignmentAudit = await db.query<{ after: Record<string, unknown> }>(
        `SELECT after FROM audit_event
         WHERE resource_kind='medicaid_program_assignment' AND resource_id=$1
         ORDER BY created_at DESC LIMIT 1`,
        [a.programAssignment],
      );
      expect(assignmentAudit.rows).toHaveLength(1);
      expect(assignmentAudit.rows[0].after.patient_id).toBe("<changed>");
      expect(JSON.stringify(assignmentAudit.rows[0].after)).not.toContain(PATIENT);
      // A verification UPDATE through the application role is audited with the acting user.
      const user = randomUUID();
      await db.query(`INSERT INTO "user" (id, email) VALUES ($1, 'm24-audit-actor@x.test')`, [
        user,
      ]);
      const evidence = await insertRow("medicaid_enrollment_evidence", evidenceRow());
      await db.query("SELECT set_config('app.user_id', $1, false)", [user]);
      try {
        await withOrg(ORG_A, () =>
          db.query(
            `UPDATE medicaid_enrollment_evidence SET status='verified', verification_source='state_registry',
               evidence_reference='doc:synthetic-audit-evidence', verified_at=now(),
               verified_by_membership_id=$2, version=version+1 WHERE id=$1`,
            [evidence, REVIEWER],
          ),
        );
      } finally {
        await db.query("SELECT set_config('app.user_id', '', false)");
      }
      const updateAudit = await db.query<{
        actor_kind: string;
        actor_user_id: string | null;
        after: Record<string, unknown>;
      }>(
        `SELECT actor_kind, actor_user_id, after FROM audit_event
         WHERE resource_kind='medicaid_enrollment_evidence' AND resource_id=$1
           AND event_type='medicaid_enrollment_evidence.update'`,
        [evidence],
      );
      expect(updateAudit.rows).toHaveLength(1);
      expect(updateAudit.rows[0]).toMatchObject({ actor_kind: "user", actor_user_id: user });
      expect(updateAudit.rows[0].after.evidence_reference).toBe("<changed>");
    });

    it("the 1542 account, environment and freshness columns are frozen identity, for every role", async () => {
      const era = await insertRow("medicaid_enrollment_evidence", {
        ...evidenceRow({
          evidence_kind: "835_era_enrollment",
          transaction_type: "835",
          status: "verified",
          program_kind: "managed_care",
          canonical_payer_id: randomUUID(),
          clearinghouse: "claimmd",
          vendor_account_ref: "synthetic-account",
          source_environment: "test",
          vendor_payer_id: "synthetic-payer",
          effective_to: "2026-12-31",
          evidence_fresh_until: "2026-12-31",
        }),
        ...evidenceVerification,
        verification_source: "payer_written_confirmation",
      });
      // Control: a column outside the identity set still updates on the superuser connection.
      await db.query(
        "UPDATE medicaid_enrollment_evidence SET version = version + 1 WHERE id = $1",
        [era],
      );
      for (const [column, value] of [
        ["source_environment", "production"],
        ["vendor_account_ref", "other-account"],
        ["evidence_fresh_until", "2027-06-30"],
      ] as const)
        await expect(
          db.query(`UPDATE medicaid_enrollment_evidence SET ${column} = $2 WHERE id = $1`, [
            era,
            value,
          ]),
        ).rejects.toThrow(/identity of an evidence row cannot be changed/);
    });

    it("a TEMP table named provider_entity cannot defeat the tenant guards of 1538 and 1539", async () => {
      // chartwarden_app may create temporary tables; without a pinned search_path the guards would read this one.
      const authorization = (pe: string) =>
        db.query(
          `INSERT INTO medicaid_payer_authorization_event
             (organization_id, provider_entity_id, patient_id, patient_payer_id, admission_id,
              canonical_payer_id, service_state, service_from, service_to, event_kind,
              evidence_source, recorded_by_membership_id)
           VALUES ($1,$2,$3,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'OR',
                   '2026-01-01','2026-01-31','authorization_pending','operator_record',$4)`,
          [ORG_A, pe, PATIENT, RECORDER],
        );
      const ratePolicy = (pe: string) =>
        db.query(
          `INSERT INTO medicaid_payer_rate_policy
             (organization_id, provider_entity_id, canonical_payer_id, program_kind, service_state,
              locality_code, service_category, unit_basis, rate_cents, source_kind, effective_from,
              recorded_by_membership_id)
           VALUES ($1,$2,gen_random_uuid(),'managed_care','OR','CBSA-SHADOW','RHC','per_day',
                   10000,'cco_contract','2026-01-01',$3)`,
          [ORG_A, pe, RECORDER],
        );
      await withOrg(ORG_A, async () => {
        await db.query("CREATE TEMP TABLE provider_entity (id uuid, organization_id uuid)");
        try {
          await db.query("INSERT INTO pg_temp.provider_entity VALUES ($1, $2)", [b.pe, ORG_A]);
          await expect(authorization(b.pe)).rejects.toThrow(
            /provider entity must belong to the evidence organization/,
          );
          await expect(ratePolicy(b.pe)).rejects.toThrow(
            /provider entity must belong to the rate organization/,
          );
        } finally {
          await db.query("DROP TABLE IF EXISTS pg_temp.provider_entity");
        }
      });
    });

    it("a verified assignment or enrollment row cannot carry an unresolved or ambiguous program kind", async () => {
      for (const kind of ["unresolved", "ambiguous"])
        await expect(
          insertRow(
            "medicaid_program_assignment",
            assignmentRow({
              status: "verified",
              program_kind: kind,
              ...assignmentVerification,
            }),
          ),
        ).rejects.toThrow(/medicaid_program_assignment_verified_program_kind/);
      // Control: the same row with a concrete kind is valid, and an open row may still carry the sentinel.
      expect(
        await insertRow(
          "medicaid_program_assignment",
          assignmentRow({ status: "verified", ...assignmentVerification }),
        ),
      ).toBeTruthy();
      expect(
        await insertRow(
          "medicaid_program_assignment",
          assignmentRow({ program_kind: "unresolved" }),
        ),
      ).toBeTruthy();
      await expect(
        insertRow(
          "medicaid_enrollment_evidence",
          evidenceRow({ status: "verified", program_kind: "ambiguous", ...evidenceVerification }),
        ),
      ).rejects.toThrow(/medicaid_enrollment_verified_program_kind/);
    });

    it("a successor must name a row of the same organization (no dangling or foreign supersedes_id)", async () => {
      await expect(
        insertRow("medicaid_program_assignment", assignmentRow({ supersedes_id: randomUUID() })),
      ).rejects.toThrow(/medicaid_program_assignment_supersedes_org_fk/);
      await expect(
        insertRow(
          "medicaid_program_assignment",
          assignmentRow({ supersedes_id: b.programAssignment }),
        ),
      ).rejects.toThrow(/medicaid_program_assignment_supersedes_org_fk/);
      await expect(
        insertRow(
          "medicaid_enrollment_evidence",
          evidenceRow({ supersedes_id: b.enrollmentEvidence }),
        ),
      ).rejects.toThrow(/medicaid_enrollment_evidence_supersedes_org_fk/);
      // Control: the organization's own row is a valid predecessor.
      expect(
        await insertRow(
          "medicaid_enrollment_evidence",
          evidenceRow({ supersedes_id: a.enrollmentEvidence }),
        ),
      ).toBeTruthy();
    });

    it("payer rate policy: a correcting row cannot name an unrelated row as its predecessor", async () => {
      const other = await insertRow("medicaid_payer_rate_policy", {
        organization_id: ORG_A,
        provider_entity_id: a.pe,
        canonical_payer_id: randomUUID(),
        program_kind: "managed_care",
        service_state: "OR",
        locality_code: "CBSA-OTHER",
        service_category: "RHC",
        unit_basis: "per_day",
        rate_cents: 10000,
        source_kind: "cco_contract",
        effective_from: "2026-01-01",
        recorded_by_membership_id: RECORDER,
      });
      // Same identity and date as a.payerRatePolicy, but naming `other` instead of the row it repeats.
      await expect(
        db.query(
          `INSERT INTO medicaid_payer_rate_policy
             (organization_id, provider_entity_id, canonical_payer_id, program_kind, service_state,
              locality_code, service_category, unit_basis, bucket_from, bucket_to, rate_cents,
              source_kind, effective_from, recorded_by_membership_id, supersedes_id)
           SELECT organization_id, provider_entity_id, canonical_payer_id, program_kind, service_state,
              locality_code, service_category, unit_basis, bucket_from, bucket_to, 9000,
              source_kind, effective_from, recorded_by_membership_id, $2::uuid
           FROM medicaid_payer_rate_policy WHERE id = $1`,
          [a.payerRatePolicy, other],
        ),
      ).rejects.toThrow(
        /correcting row must replace a row of the same identity and effective date/,
      );
    });

    // ── A2 — siting: the patient-keyed 1535/1538 tables carry the same nullable location_id as every older M24
    // patient table (a location FK is RESTRICT-on-delete, like the rest of M24).
    describe.each([
      {
        table: "medicaid_program_assignment",
        insertWith: (location_id: string) =>
          insertRow("medicaid_program_assignment", assignmentRow({ location_id })),
      },
      {
        table: "medicaid_payer_authorization_event",
        insertWith: (location_id: string) =>
          insertRow("medicaid_payer_authorization_event", {
            organization_id: ORG_A,
            provider_entity_id: a.pe,
            patient_id: PATIENT,
            patient_payer_id: randomUUID(),
            admission_id: randomUUID(),
            canonical_payer_id: randomUUID(),
            service_state: "OR",
            service_from: "2026-01-01",
            service_to: "2026-01-31",
            event_kind: "authorization_pending",
            evidence_source: "operator_record",
            recorded_by_membership_id: RECORDER,
            location_id,
          }),
      },
    ])("$table siting", ({ table, insertWith }) => {
      it("has a nullable location_id referencing location(id) ON DELETE RESTRICT", async () => {
        const col = await db.query(
          "SELECT is_nullable, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='location_id'",
          [table],
        );
        expect(col.rows).toEqual([{ is_nullable: "YES", data_type: "uuid" }]);
        const fk = await db.query(
          `SELECT confrelid::regclass::text AS parent, confdeltype FROM pg_constraint
           WHERE conrelid = $1::regclass AND contype = 'f'
             AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attname = 'location_id')]`,
          [table],
        );
        expect(fk.rows).toEqual([{ parent: "location", confdeltype: "r" }]);
      });

      it("stores a real location and refuses an unknown one", async () => {
        const location = (
          await db.query(
            `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
             VALUES ($1,'Loc A','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
            [a.pe],
          )
        ).rows[0].id as string;
        expect(await insertWith(location)).toBeTruthy();
        // An unknown id is refused by the location guard (it fires before the foreign key is checked).
        await expect(insertWith(randomUUID())).rejects.toThrow(
          /location must belong to the record provider entity/,
        );
      });

      it("refuses another tenant's location (the foreign key alone would accept it)", async () => {
        const foreignLocation = (
          await db.query(
            `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
             VALUES ($1,'Loc B','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
            [b.pe],
          )
        ).rows[0].id as string;
        await expect(insertWith(foreignLocation)).rejects.toThrow(
          /location must belong to the record provider entity/,
        );
      });
    });

    // ── A3 — the 1535 mutable evidence tables: four-eyes CHECK, column-limited UPDATE, identity guard and a
    // status-transition guard (the 1532 / WF09 precedent), each reachable only by the control under test.
    const VERIFY_COLUMNS =
      "status='verified', verification_source='state_registry', evidence_reference='doc:synthetic-evidence', verified_at=now(), verified_by_membership_id=$2, version=version+1, updated_at=now()";
    const MUTABLE = [
      {
        table: "medicaid_program_assignment",
        seedKey: "programAssignment" as const,
        row: assignmentRow,
        verification: assignmentVerification,
        fourEyes: "medicaid_program_assignment_four_eyes",
        updatable: [
          "canonical_payer_classification_id",
          "evidence_reference",
          "revocation_reason",
          "status",
          "updated_at",
          "verification_source",
          "verified_at",
          "verified_by_membership_id",
          "version",
        ],
        verifySet: `${VERIFY_COLUMNS}, canonical_payer_classification_id=gen_random_uuid()`,
        identityChanges: () => ({
          organization_id: ORG_B,
          patient_id: randomUUID(),
          patient_payer_id: randomUUID(),
          admission_id: randomUUID(),
          provider_entity_id: randomUUID(),
          location_id: randomUUID(),
          service_state: "WA",
          program_kind: "unsupported",
          canonical_payer_id: randomUUID(),
          payer_snapshot: JSON.stringify({ label: "changed" }),
          effective_from: "2026-03-01",
          effective_to: "2026-12-31",
          source_kind: "other",
          recorded_by_membership_id: REVIEWER,
          supersedes_id: randomUUID(),
          created_at: "2020-01-01T00:00:00Z",
        }),
        terminal: ["rejected", "revoked", "superseded"],
        afterVerified: ["revoked", "superseded"],
        open: ["candidate", "pending"],
        frozenEvidence: {
          canonical_payer_classification_id: () => randomUUID(),
          evidence_reference: () => "doc:rewritten",
          verification_source: () => "payer_confirmation",
          verified_at: () => "2026-03-01T00:00:00Z",
          verified_by_membership_id: () => "00000000-0000-0000-0000-0000000000bb",
        },
      },
      {
        table: "medicaid_enrollment_evidence",
        seedKey: "enrollmentEvidence" as const,
        row: evidenceRow,
        verification: evidenceVerification,
        fourEyes: "medicaid_enrollment_evidence_four_eyes",
        updatable: [
          "evidence_reference",
          "revocation_reason",
          "status",
          "updated_at",
          "verification_source",
          "verified_at",
          "verified_by_membership_id",
          "version",
        ],
        verifySet: VERIFY_COLUMNS,
        identityChanges: () => ({
          organization_id: ORG_B,
          provider_entity_id: randomUUID(),
          service_state: "WA",
          program_kind: "unsupported",
          canonical_payer_id: randomUUID(),
          clearinghouse: "other-house",
          vendor_payer_id: "OTHER-VENDOR",
          transaction_type: "835",
          evidence_kind: "835_era_enrollment",
          effective_from: "2026-03-01",
          effective_to: "2026-12-31",
          recorded_by_membership_id: REVIEWER,
          supersedes_id: randomUUID(),
          created_at: "2020-01-01T00:00:00Z",
        }),
        terminal: ["rejected", "expired", "revoked", "superseded"],
        afterVerified: ["revoked", "expired", "superseded"],
        open: ["pending"],
        frozenEvidence: {
          evidence_reference: () => "doc:rewritten",
          verification_source: () => "payer_confirmation",
          verified_at: () => "2026-03-01T00:00:00Z",
          verified_by_membership_id: () => "00000000-0000-0000-0000-0000000000bb",
        },
      },
    ];

    describe.each(MUTABLE)("$table mutation guards", (cfg) => {
      const { table } = cfg;
      /** A fresh row at `status` (inserted on the superuser connection, which bypasses grants, RLS and the update guard). */
      const rowAt = (status: string) =>
        insertRow(
          table,
          cfg.row({
            status,
            ...(status === "verified" ? cfg.verification : {}),
            ...(status === "revoked" ? { revocation_reason: "other" } : {}),
          }),
        );

      it("four-eyes: the verifier cannot be the person who recorded the row", async () => {
        await expect(
          insertRow(
            table,
            cfg.row({
              status: "verified",
              ...cfg.verification,
              verified_by_membership_id: RECORDER,
            }),
          ),
        ).rejects.toThrow(new RegExp(cfg.fourEyes));
        // Control: the same row with a different verifier is valid.
        expect(await rowAt("verified")).toBeTruthy();
      });

      it("the application role may update exactly the columns the verify and revoke paths write", async () => {
        const granted = await db.query<{ attname: string }>(
          `SELECT attname FROM pg_attribute
           WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped
             AND has_column_privilege('chartwarden_app', attrelid, attnum, 'UPDATE')
           ORDER BY attname`,
          [table],
        );
        expect(granted.rows.map((r) => r.attname).sort()).toEqual([...cfg.updatable].sort());
        const all = await db.query<{ attname: string }>(
          "SELECT attname FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped",
          [table],
        );
        for (const { attname } of all.rows.filter((r) => !cfg.updatable.includes(r.attname))) {
          await expect(
            withOrg(ORG_A, () =>
              db.query(`UPDATE ${table} SET ${attname} = ${attname} WHERE id=$1`, [a[cfg.seedKey]]),
            ),
          ).rejects.toThrow(/permission denied for table/);
        }
      });

      it("the application role can record, verify and revoke a row (the paths the service uses)", async () => {
        const entry = NEW_TABLES.find((t) => t.table === table);
        if (!entry) throw new Error(`${table} missing from NEW_TABLES`);
        const id = (
          await withOrg(ORG_A, () =>
            db.query<{ id: string }>(
              `${entry.insert} RETURNING id`,
              bindsFor(entry.insert, ORG_A, a.pe),
            ),
          )
        ).rows[0].id;
        const verified = await withOrg(ORG_A, () =>
          db.query(`UPDATE ${table} SET ${cfg.verifySet} WHERE id=$1`, [id, REVIEWER]),
        );
        expect(verified.rowCount).toBe(1);
        const revoked = await withOrg(ORG_A, () =>
          db.query(
            `UPDATE ${table} SET status='revoked', revocation_reason='other', version=version+1, updated_at=now() WHERE id=$1`,
            [id],
          ),
        );
        expect(revoked.rowCount).toBe(1);
      });

      it("identity: no column that says what the row IS can change, for any role", async () => {
        // The superuser holds every grant and skips RLS, so only the guard trigger can answer.
        const changes = Object.entries(cfg.identityChanges());
        expect(changes.length).toBeGreaterThan(10);
        for (const [column, value] of changes) {
          const id = await rowAt("pending");
          await expect(
            db.query(`UPDATE ${table} SET ${column} = $2 WHERE id=$1`, [id, value]),
            column,
          ).rejects.toThrow(/cannot be changed/);
        }
        // Control: a value column still updates.
        const id = await rowAt("pending");
        expect(
          (await db.query(`UPDATE ${table} SET version = version + 1 WHERE id=$1`, [id])).rowCount,
        ).toBe(1);
      });

      it("status: a row verifies only from an open status, a verified row can only be revoked or superseded, a closed row is final", async () => {
        const everyStatus = [...cfg.open, "verified", ...cfg.terminal];
        const legal = (from: string, to: string) =>
          cfg.open.includes(from) || (from === "verified" && cfg.afterVerified.includes(to));
        for (const from of everyStatus) {
          for (const to of everyStatus.filter((s) => s !== from)) {
            const id = await rowAt(from);
            const attempt =
              to === "verified"
                ? db.query(`UPDATE ${table} SET ${cfg.verifySet} WHERE id=$1`, [id, REVIEWER])
                : db.query(`UPDATE ${table} SET status=$2 WHERE id=$1`, [id, to]);
            if (legal(from, to)) {
              expect((await attempt).rowCount, `${from} -> ${to}`).toBe(1);
            } else {
              await expect(attempt, `${from} -> ${to}`).rejects.toThrow(/is final|can only be/);
            }
          }
        }
      });

      it("insert: the application role records only an open row, so a one-statement verified or closed insert is refused and a later UPDATE to verified still works", async () => {
        // The verified and closed rows satisfy every CHECK (the four-eyes CHECK compares two values the same caller
        // supplies), so only the BEFORE INSERT status guard can refuse them. The control is the identical row written
        // outside the application role. This refuses a ONE-statement insert only; the known-limit test below pins
        // what it does not stop.
        const forgedStatuses = ["verified", ...cfg.terminal];
        for (const status of forgedStatuses) {
          const forged = cfg.row({
            status,
            ...(status === "verified" ? cfg.verification : {}),
            ...(status === "revoked" ? { revocation_reason: "other" } : {}),
          });
          expect(
            await insertRow(table, forged),
            `control: ${status} outside the app role`,
          ).toBeTruthy();
          await expect(
            withOrg(ORG_A, () => insertRow(table, forged)),
            status,
          ).rejects.toThrow(/requires a separate reviewer path/);
        }
        // The legitimate path: an open row is recorded by the application role and verified by another member.
        for (const status of cfg.open) {
          const id = await withOrg(ORG_A, () => insertRow(table, cfg.row({ status })));
          const verified = await withOrg(ORG_A, () =>
            db.query(`UPDATE ${table} SET ${cfg.verifySet} WHERE id=$1`, [id, REVIEWER]),
          );
          expect(verified.rowCount, `verify a row recorded as ${status}`).toBe(1);
        }
      });

      // PINS A KNOWN LIMIT so nobody re-claims more than the database does. The database cannot tell the verify route
      // from other application SQL (a trigger has no caller-bound identity), so the insert guard above does not make
      // verification route-only: the application role can insert an open row and verify it in a second statement,
      // naming any verifier. Verification itself (the M40 classification match, the source allow-list, step-up) is
      // enforced by the verify service. What the database does guarantee is the four-eyes arithmetic (the verifier
      // column differs from the recorder column), the identity and evidence freeze after verification and the
      // transition table (all proved by the tests above), not WHO the verifier is.
      it("known limit: the application role can insert an open row and then verify it, naming any verifier, except the recorder", async () => {
        const id = await withOrg(ORG_A, () => insertRow(table, cfg.row({ status: "pending" })));
        const asRecorder = withOrg(ORG_A, () =>
          db.query(`UPDATE ${table} SET ${cfg.verifySet} WHERE id=$1`, [id, RECORDER]),
        );
        await expect(asRecorder, "the recorder as verifier").rejects.toThrow(
          new RegExp(cfg.fourEyes),
        );
        const chosenVerifier = randomUUID();
        const verified = await withOrg(ORG_A, () =>
          db.query(`UPDATE ${table} SET ${cfg.verifySet} WHERE id=$1`, [id, chosenVerifier]),
        );
        expect(verified.rowCount).toBe(1);
        const { rows } = await db.query<{ status: string; verified_by_membership_id: string }>(
          `SELECT status, verified_by_membership_id FROM ${table} WHERE id=$1`,
          [id],
        );
        expect(rows[0]).toEqual({ status: "verified", verified_by_membership_id: chosenVerifier });
      });

      it("evidence: once a row leaves its open status the verification evidence cannot be rewritten", async () => {
        for (const [column, value] of Object.entries(cfg.frozenEvidence)) {
          const id = await rowAt("verified");
          await expect(
            db.query(`UPDATE ${table} SET ${column} = $2 WHERE id=$1`, [id, value()]),
            column,
          ).rejects.toThrow(/verification evidence cannot change/);
        }
        // Control: the same columns are written freely while the row is still open (that is the verify step).
        const id = await rowAt(cfg.open[cfg.open.length - 1]);
        expect(
          (
            await db.query(
              `UPDATE ${table} SET evidence_reference='doc:first', verification_source='state_registry' WHERE id=$1`,
              [id],
            )
          ).rowCount,
        ).toBe(1);
      });
    });

    // ── A4 — the 1539 identity key is per chain head: a correction names its predecessor and may reuse the
    // effective date; a second correction of the same predecessor (a fork) and a second head are still refused.
    it("payer rate policy: a correcting row may repeat the identity and effective date, once per predecessor", async () => {
      const correction = (supersedes: string | null) =>
        withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO medicaid_payer_rate_policy
               (organization_id, provider_entity_id, canonical_payer_id, program_kind, service_state,
                locality_code, service_category, unit_basis, bucket_from, bucket_to, rate_cents,
                source_kind, effective_from, recorded_by_membership_id, supersedes_id)
             SELECT organization_id, provider_entity_id, canonical_payer_id, program_kind, service_state,
                locality_code, service_category, unit_basis, bucket_from, bucket_to, 9000,
                source_kind, effective_from, recorded_by_membership_id, $2::uuid
             FROM medicaid_payer_rate_policy WHERE id = $1`,
            [a.payerRatePolicy, supersedes],
          ),
        );
      // A second head with the same identity (no predecessor) is a duplicate.
      await expect(correction(null)).rejects.toThrow(/medicaid_payer_rate_policy_identity_uq/);
      // The correction names the row it replaces.
      expect((await correction(a.payerRatePolicy)).rowCount).toBe(1);
      // Two corrections of the same predecessor would fork the chain.
      await expect(correction(a.payerRatePolicy)).rejects.toThrow(
        /medicaid_payer_rate_policy_identity_uq/,
      );
    });

    // ── 1550 — the verified-methodology CHECK closes every group before the next AND, so the OHA FFS rules bind
    // per_day and per_hour rows too (a mis-closed parenthesis once made them an OR branch of the pricing group).
    const ohaRateRow = (over: Record<string, unknown> = {}) =>
      verifiedRateRow(ORG_A, a.pe, {
        program_kind: "oregon_ffs",
        source_kind: "oha_ffs_schedule",
        locality_code: "OHA-STATEWIDE",
        charge_ceiling_method: "lower_of_rate_and_usual_charge",
        charge_ceiling_boundary: "service_day",
        quality_reporting_applicability: "required",
        quality_reporting_status: "meets",
        ...over,
      });
    const ohaChcRow = (over: Record<string, unknown> = {}) =>
      ohaRateRow({
        service_category: "CHC",
        unit_basis: "per_hour",
        pricing_method: "per_hour",
        quantity_conversion_method: "hourly_each_hour_or_part",
        minimum_duration_method: "minimum_minutes",
        minimum_clinical_minutes: 480,
        rounding_mode: "not_applicable",
        rounding_boundary: "not_applicable",
        ...over,
      });

    it("verified methodology: an OHA FFS row must carry the OHA ceiling, quality and CHC rules, whatever its pricing method", async () => {
      const refused = (row: Record<string, unknown>) =>
        expect(insertRow("medicaid_payer_rate_policy", row)).rejects.toMatchObject({
          code: "23514",
          constraint: "medicaid_payer_rate_policy_verified_methodology",
        });
      // Control: a valid OHA per-day row and a valid OHA CHC row are accepted, so each refusal below is one rule.
      expect(await insertRow("medicaid_payer_rate_policy", ohaRateRow())).toBeTruthy();
      expect(await insertRow("medicaid_payer_rate_policy", ohaChcRow())).toBeTruthy();
      // The per_day branch: it satisfies the pricing group, so only the OHA rules can refuse these.
      await refused(
        ohaRateRow({ charge_ceiling_method: "none", charge_ceiling_boundary: "not_applicable" }),
      );
      await refused(
        ohaRateRow({
          quality_reporting_applicability: "not_required",
          quality_reporting_status: "not_applicable",
        }),
      );
      // The per_hour branch.
      await refused(
        ohaRateRow({
          unit_basis: "per_hour",
          pricing_method: "per_hour",
          quantity_conversion_method: "hourly_prorated_minutes",
          minimum_duration_method: "not_required",
          rounding_mode: "half_up",
          charge_ceiling_method: "none",
          charge_ceiling_boundary: "not_applicable",
        }),
      );
      // CHC: the eight-hour minimum is part of the OHA rule.
      await refused(ohaChcRow({ minimum_clinical_minutes: 240 }));
      await refused(
        ohaChcRow({ minimum_duration_method: "not_required", minimum_clinical_minutes: null }),
      );
      // A minimum_minutes method with NULL minutes is not a minimum at all: the CHECK would otherwise see NULL > 0
      // and NULL = 480 as unknown and let a verified CHC row, or any verified hourly row, omit the minimum.
      const noMinutes = {
        code: "23514",
        constraint: "medicaid_payer_rate_policy_minimum_duration_valid",
      };
      await expect(
        insertRow("medicaid_payer_rate_policy", ohaChcRow({ minimum_clinical_minutes: null })),
      ).rejects.toMatchObject(noMinutes);
      await expect(
        insertRow(
          "medicaid_payer_rate_policy",
          verifiedRateRow(ORG_A, a.pe, {
            unit_basis: "per_hour",
            pricing_method: "per_hour",
            quantity_conversion_method: "hourly_each_hour_or_part",
            minimum_duration_method: "minimum_minutes",
            minimum_clinical_minutes: null,
          }),
        ),
      ).rejects.toMatchObject(noMinutes);
    });

    // ── 1551 — billing evidence: a revoked or superseded row closes its predecessor, so it carries its instant.
    it("billing evidence: a revoked or superseded row must carry the instant it was decided", async () => {
      const closed = (status: string, verifiedAt: string | null) =>
        insertRow(
          "medicaid_hospice_billing_evidence",
          hospiceEvidenceRow(ORG_A, a.pe, {
            verification_status: status,
            verified_at: verifiedAt,
            verified_by_membership_id: null,
          }),
        );
      for (const status of ["revoked", "superseded"]) {
        // Control: the same row with its instant is valid.
        expect(await closed(status, "2026-02-01T00:00:00Z"), status).toBeTruthy();
        await expect(closed(status, null), status).rejects.toMatchObject({
          code: "23514",
          constraint: "medicaid_hospice_billing_evidence_closed_provenance",
        });
      }
      // An open row still has no verification instant.
      expect(await closed("pending", null)).toBeTruthy();
    });

    // ── 1551 — the pricing-snapshot insert guard. Each refusal changes ONE fact of a snapshot that is otherwise valid,
    // and the same chain accepts the unchanged snapshot, so only the check under test can have refused it.
    describe("pricing snapshot insert guard (1551)", () => {
      const refusal = (message: RegExp) => ({
        code: "23514",
        message: expect.stringMatching(message),
      });
      const NOT_CURRENT_RATE = /rate evidence is not current verified evidence/;
      const NOT_CURRENT_EVIDENCE = /billing evidence is not current verified evidence/;
      const NOT_MATCHING = /payer, service, range or integrity evidence does not match/;

      it("assessed_at must equal the instant the snapshot records and cannot lie in the future", async () => {
        const chain = await seedPricedChain(ORG_A, a.pe);
        // Control: the application clock may run a few minutes ahead of the database clock.
        expect(
          (await insertPricedLine(chain, { assessedAt: await dbInstant("4 minutes") })).line,
        ).toBeTruthy();
        await expect(
          insertPricedLine(chain, { assessedAtColumn: await dbInstant("2 seconds") }),
        ).rejects.toMatchObject(refusal(/assessed_at must equal its assessmentTimestamp/));
        await expect(
          insertPricedLine(chain, { assessedAt: await dbInstant("10 minutes") }),
        ).rejects.toMatchObject(refusal(/cannot be in the future/));
        // A snapshot assessed before the rate was recorded is refused.
        await expect(
          insertPricedLine(chain, { assessedAt: await dbInstant("-1 hour") }),
        ).rejects.toMatchObject(refusal(NOT_CURRENT_RATE));
      });

      it("a snapshot cannot be assessed before the rate or the evidence was verified", async () => {
        const verifiedLater = await dbInstant("2 minutes");
        const lateRate = await seedPricedChain(ORG_A, a.pe, {
          rate: { verified_at: verifiedLater },
        });
        const lateEvidence = await seedPricedChain(ORG_A, a.pe, {
          evidence: { verified_at: verifiedLater },
        });
        // Control: assessed after both verifications, the same chains price.
        const later = await dbInstant("4 minutes");
        expect((await insertPricedLine(lateRate, { assessedAt: later })).line).toBeTruthy();
        expect((await insertPricedLine(lateEvidence, { assessedAt: later })).line).toBeTruthy();
        await expect(insertPricedLine(lateRate)).rejects.toMatchObject(refusal(NOT_CURRENT_RATE));
        await expect(insertPricedLine(lateEvidence)).rejects.toMatchObject(
          refusal(/cannot predate its billing evidence verification/),
        );
      });

      it("the rate and the evidence must agree on quality reporting, and the rate must be a per-day method", async () => {
        const required = {
          quality_reporting_applicability: "required",
          quality_reporting_status: "meets",
        };
        // The snapshot records the variant of the evidence row it names.
        const requiredQuality = {
          qualityReporting: {
            applicability: "required",
            status: "meets",
            evidenceReference: "evidence:synthetic-test/quality",
            evidenceVersion: 1,
          },
        };
        // Control: the two agree (both required and meeting), and the snapshot records the same.
        const agreeing = await seedPricedChain(ORG_A, a.pe, { rate: required, evidence: required });
        expect((await insertPricedLine(agreeing, { snapshot: requiredQuality })).line).toBeTruthy();
        // Applicability differs.
        const applicability = await seedPricedChain(ORG_A, a.pe, { rate: required });
        await expect(insertPricedLine(applicability)).rejects.toMatchObject(refusal(NOT_MATCHING));
        // Only the provider status differs.
        const status = await seedPricedChain(ORG_A, a.pe, {
          rate: { ...required, quality_reporting_status: "does_not_meet" },
          evidence: required,
        });
        await expect(insertPricedLine(status, { snapshot: requiredQuality })).rejects.toMatchObject(
          refusal(NOT_MATCHING),
        );
        // A fixed per-day contract unit is a per-day method the daily snapshot supports.
        const fixed = await seedPricedChain(ORG_A, a.pe, {
          rate: { pricing_method: "fixed_contract_unit" },
        });
        expect(
          (await insertPricedLine(fixed, { snapshot: { pricingMethod: "fixed_contract_unit" } }))
            .line,
        ).toBeTruthy();
      });

      it("the snapshot must record the methodology and quality variant of the rows it names", async () => {
        const chain = await seedPricedChain(ORG_A, a.pe);
        // Control: the default snapshot records exactly the default rows.
        expect((await insertPricedLine(chain)).line).toBeTruthy();
        // Each field differs on its own, from an otherwise agreeing snapshot.
        for (const snapshot of [
          { pricingMethod: "per_hour" },
          { methodologyVersion: 2 },
          { quantityConversionMethod: "hourly_prorated_minutes" },
          { roundingMode: "half_up" },
          { roundingBoundary: "line" },
          { chargeCeilingMethod: "contract_maximum" },
          { chargeCeilingBoundary: "service_day" },
        ]) {
          await expect(insertPricedLine(chain, { snapshot })).rejects.toMatchObject(
            refusal(NOT_CURRENT_RATE),
          );
        }
        const quality = {
          evidenceReference: "evidence:synthetic-test/quality",
          evidenceVersion: 1,
        };
        await expect(
          insertPricedLine(chain, {
            snapshot: {
              qualityReporting: { applicability: "required", status: "not_applicable", ...quality },
            },
          }),
        ).rejects.toMatchObject(refusal(NOT_CURRENT_EVIDENCE));
        await expect(
          insertPricedLine(chain, {
            snapshot: {
              qualityReporting: { applicability: "not_required", status: "meets", ...quality },
            },
          }),
        ).rejects.toMatchObject(refusal(NOT_CURRENT_EVIDENCE));
      });

      it("a priced line without a service end date cannot skip the range checks", async () => {
        // The line's service_date_to is nullable; a NULL end and a snapshot that omits serviceTo would compare
        // NULL to NULL and skip every effective_to check.
        const chain = await seedPricedChain(ORG_A, a.pe);
        await expect(
          insertPricedLine(chain, { lineServiceDateTo: null, snapshot: { serviceTo: undefined } }),
        ).rejects.toMatchObject(refusal(/identity or amounts do not match its claim line/));
        // Control: the same chain prices with the end date set.
        expect((await insertPricedLine(chain)).line).toBeTruthy();
      });

      it("a legacy verified rate that never qualified its methodology cannot be snapshotted", async () => {
        // Pre-1550 verified rows carry the 'unqualified' defaults: the verified-methodology CHECK is NOT VALID, so
        // it guards new rows only. Rebuild such a row inside a transaction that is rolled back with its DDL.
        const withLegacyShapeAllowed = async (fn: () => Promise<void>) => {
          await db.query("BEGIN");
          try {
            await db.query(
              "ALTER TABLE medicaid_payer_rate_policy DROP CONSTRAINT medicaid_payer_rate_policy_verified_methodology",
            );
            await fn();
          } finally {
            await db.query("ROLLBACK");
          }
        };
        await withLegacyShapeAllowed(async () => {
          const qualified = await seedPricedChain(ORG_A, a.pe);
          expect((await insertPricedLineStatements(qualified)).line).toBeTruthy();
        });
        for (const rate of [
          { pricing_method: "unqualified" },
          { quantity_conversion_method: "unqualified" },
        ])
          await withLegacyShapeAllowed(async () => {
            const legacy = await seedPricedChain(ORG_A, a.pe, { rate });
            await expect(insertPricedLineStatements(legacy)).rejects.toMatchObject(
              refusal(NOT_CURRENT_RATE),
            );
          });
      });

      it("a rate or an evidence row that has a successor is no longer current", async () => {
        // A rejected draft correction never supersedes the active head (the pricing engine skips it too).
        const withRejectedDraft = await seedPricedChain(ORG_A, a.pe);
        await insertRow(
          "medicaid_payer_rate_policy",
          verifiedRateRow(ORG_A, a.pe, {
            canonical_payer_id: withRejectedDraft.payer,
            supersedes_id: withRejectedDraft.rate,
            version: 2,
            verification_status: "rejected",
            verified_at: null,
            verified_by_membership_id: null,
          }),
        );
        expect((await insertPricedLine(withRejectedDraft)).line).toBeTruthy();
        const chain = await seedPricedChain(ORG_A, a.pe);
        expect((await insertPricedLine(chain)).line).toBeTruthy(); // control: both rows are heads
        const rateHead = await insertRow(
          "medicaid_payer_rate_policy",
          verifiedRateRow(ORG_A, a.pe, {
            canonical_payer_id: chain.payer,
            supersedes_id: chain.rate,
            version: 2,
          }),
        );
        const withRateHead = { ...chain, rate: rateHead, rateVersion: 2 };
        await expect(insertPricedLine(chain)).rejects.toMatchObject(refusal(NOT_CURRENT_RATE));
        expect((await insertPricedLine(withRateHead)).line).toBeTruthy();
        const evidenceHead = await insertRow(
          "medicaid_hospice_billing_evidence",
          hospiceEvidenceRow(ORG_A, a.pe, {
            canonical_payer_id: chain.payer,
            admission_id: chain.admission,
            supersedes_id: chain.evidence,
            version: 2,
          }),
        );
        await expect(insertPricedLine(withRateHead)).rejects.toMatchObject(
          refusal(NOT_CURRENT_EVIDENCE),
        );
        expect(
          (await insertPricedLine({ ...withRateHead, evidence: evidenceHead, evidenceVersion: 2 }))
            .line,
        ).toBeTruthy();
      });

      it("service dates are compared as UTC calendar days whatever the session TimeZone", async () => {
        const chain = await seedPricedChain(ORG_A, a.pe);
        // The line is stored at 00:00 UTC, which is the previous evening in Los Angeles.
        for (const timeZone of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati"])
          expect((await insertPricedLine(chain, { timeZone })).line, timeZone).toBeTruthy();
        // The comparison is unchanged: a JSON date that is one day off is refused under UTC, and under the zone
        // whose local date for the stored instant is exactly that wrong day.
        for (const timeZone of ["UTC", "America/Los_Angeles"]) {
          await expect(
            insertPricedLine(chain, { timeZone, snapshot: { serviceFrom: "2025-12-31" } }),
            timeZone,
          ).rejects.toMatchObject(refusal(/identity or amounts do not match its claim line/));
          await expect(
            insertPricedLine(chain, { timeZone, snapshot: { serviceTo: "2026-01-01" } }),
            timeZone,
          ).rejects.toMatchObject(refusal(/identity or amounts do not match its claim line/));
        }
      });
    });

    it("a payer-rate-priced claim line cannot be deleted or edited, by the application role or the owner", async () => {
      const unpriced = await insertRow("medicaid_claim_line", {
        organization_id: ORG_A,
        provider_entity_id: a.pe,
        medicaid_claim_id: a.claim,
        line_number: 7,
        service_date: "2026-01-05T00:00:00Z",
        revenue_code: "0651",
        q_code: "Q5001",
        level_of_care: "RHC",
        loc_period_id: randomUUID(),
        units: 1,
        rate_at_assembly_cents: 10000,
        state_rate_schedule_id_snapshot: randomUUID(),
        charges_cents: 10000,
      });
      // Control: the application role holds DELETE and may remove a line no payer rate priced.
      const removed = await withOrg(ORG_A, () =>
        db.query("DELETE FROM medicaid_claim_line WHERE id=$1", [unpriced]),
      );
      expect(removed.rowCount).toBe(1);
      const remove = "DELETE FROM medicaid_claim_line WHERE id=$1";
      await expect(db.query(remove, [a.pricedLine])).rejects.toThrow(
        /priced claim lines are immutable/,
      );
      await expect(withOrg(ORG_A, () => db.query(remove, [a.pricedLine]))).rejects.toThrow(
        /priced claim lines are immutable/,
      );
      await expect(
        db.query("UPDATE medicaid_claim_line SET charges_cents = charges_cents + 1 WHERE id=$1", [
          a.pricedLine,
        ]),
      ).rejects.toThrow(/priced claim lines are immutable/);
      const survivors = await db.query<{ lines: number; snapshots: number }>(
        `SELECT (SELECT count(*)::int FROM medicaid_claim_line WHERE id=$1) AS lines,
                (SELECT count(*)::int FROM medicaid_claim_line_pricing_snapshot
                  WHERE medicaid_claim_line_id=$1) AS snapshots`,
        [a.pricedLine],
      );
      expect(survivors.rows[0]).toEqual({ lines: 1, snapshots: 1 });
    });

    // ── WX-PR-011 — `medicaid_state_plan_code` is PLATFORM-SHARED (no organization_id), unlike the
    // tenant-scoped tables above — read-all for every tenant, write-only via `medicaid_platform_loader`
    // (the wage_index_factor precedent). Proves 0177's seed row is real + readable, and that chartwarden_app
    // truly cannot write it (not just "the app never happens to").
    it("medicaid_state_plan_code: every org reads the platform seed row (no organization_id)", async () => {
      const seenByA = await withOrg(ORG_A, () =>
        db.query(
          "SELECT count(*)::int AS n FROM medicaid_state_plan_code WHERE state_code='OR' AND plan_code='OHP-PLUS'",
        ),
      );
      expect(seenByA.rows[0].n).toBe(1);
      const seenByB = await withOrg(ORG_B, () =>
        db.query(
          "SELECT count(*)::int AS n FROM medicaid_state_plan_code WHERE state_code='OR' AND plan_code='OHP-PLUS'",
        ),
      );
      expect(seenByB.rows[0].n).toBe(1); // platform-shared — org B reads it too, not just org A
    });

    it("medicaid_state_plan_code: chartwarden_app cannot INSERT (platform-loader-only write)", async () => {
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO medicaid_state_plan_code (state_code, plan_code, plan_name, effective_from, load_source_ref)
           VALUES ('OR','SNEAK-IN','nope', now(), 'test')`,
          ),
        ),
      ).rejects.toThrow();
    });

    // ── WX-PR-011 line-assembly follow-up — `medicaid_state_rate_schedule` is PLATFORM-SHARED, same
    // posture as `medicaid_state_plan_code` above. Proves 0182's four Oregon LOC seed rows are real +
    // readable, and that chartwarden_app cannot write it.
    it("medicaid_state_rate_schedule: every org reads all four Oregon LOC seed rows", async () => {
      const seenByA = await withOrg(ORG_A, () =>
        db.query(
          "SELECT count(*)::int AS n FROM medicaid_state_rate_schedule WHERE state_code='OR'",
        ),
      );
      expect(seenByA.rows[0].n).toBe(4);
      const seenByB = await withOrg(ORG_B, () =>
        db.query(
          "SELECT count(*)::int AS n FROM medicaid_state_rate_schedule WHERE state_code='OR'",
        ),
      );
      expect(seenByB.rows[0].n).toBe(4);
    });

    it("medicaid_state_rate_schedule: chartwarden_app cannot INSERT (platform-loader-only write)", async () => {
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO medicaid_state_rate_schedule (state_code, level_of_care, rate_cents, effective_from, load_source_ref)
           VALUES ('OR','RHC',1,now(),'test')`,
          ),
        ),
      ).rejects.toThrow();
    });

    it("medicaid_state_rate_schedule: the NF_RB CHECK forbids a schedule row for Room & Board", async () => {
      await expect(
        db.query(
          `INSERT INTO medicaid_state_rate_schedule (state_code, level_of_care, rate_cents, effective_from, load_source_ref)
         VALUES ('OR','NF_RB',1,now(),'test')`,
        ),
      ).rejects.toThrow(/medicaid_state_rate_schedule_no_rb/);
    });

    // ── 1557 — the CHC preparation rests on the same append-only lineage as the RHC snapshot, and its own guard is the
    // backstop for a writer that holds INSERT. Each refusal changes ONE fact of a chain that is otherwise valid
    // (the seeded preparations are the control), and a refusal is a 23514, never a cast error or a silent pass.
    describe("CHC preparation guard (1557)", () => {
      const refusedBy = (message: RegExp) => ({
        code: "23514",
        message: expect.stringMatching(message),
      });
      const RATE_IDENTITY = /rate evidence identity mismatch/;
      const EVIDENCE_IDENTITY = /billing evidence identity mismatch/;
      const SHAPE = {
        code: "23514",
        constraint: "medicaid_chc_pricing_preparation_snapshot_shape",
      };

      it("an RHC evidence row without its code pair is refused: the CHECK must not accept NULL", async () => {
        const rhc = (over: Record<string, unknown>) =>
          insertRow("medicaid_hospice_billing_evidence", hospiceEvidenceRow(ORG_A, a.pe, over));
        // Control: the full pair is valid.
        expect(await rhc({})).toBeTruthy();
        for (const over of [
          { revenue_code: null, hcpcs_code: null },
          { revenue_code: "0651", hcpcs_code: null },
          { revenue_code: null, hcpcs_code: "Q5001" },
        ]) {
          await expect(rhc(over)).rejects.toMatchObject({
            code: "23514",
            constraint: "medicaid_hospice_billing_evidence_pricing_facts",
          });
        }
      });

      it("a consecutive version of the same identity is accepted; a gap, a fork across days or a reused identity is not", async () => {
        const chain = await seedChcChain(ORG_A, a.pe);
        const preparationId = randomUUID();
        expect(await insertChcPreparation(chain, { preparationId, version: 1 })).toBeTruthy();
        expect(await insertChcPreparation(chain, { preparationId, version: 2 })).toBeTruthy();
        await expect(
          insertChcPreparation(chain, { preparationId, version: 4 }),
        ).rejects.toMatchObject(refusedBy(/consecutive/));
        // A different identity cannot continue the same service day.
        await expect(insertChcPreparation(chain, { version: 3 })).rejects.toMatchObject(
          refusedBy(/consecutive/),
        );
        // An identity belongs to one service day: another chain cannot reuse it.
        const other = await seedChcChain(ORG_A, a.pe);
        await expect(insertChcPreparation(other, { preparationId })).rejects.toMatchObject(
          refusedBy(/consecutive/),
        );
        // A first row of a new scope starts at version 1.
        await expect(insertChcPreparation(other, { version: 7 })).rejects.toMatchObject(
          refusedBy(/consecutive/),
        );
      });

      it("a snapshot that omits a fact is refused: the shape CHECK and the guard are not NULL-hollow", async () => {
        const chain = await seedChcChain(ORG_A, a.pe);
        // Absent postingAuthorized alone used to pass; only an explicit `true` was refused.
        await expect(
          insertChcPreparation(chain, { drop: ["postingAuthorized"] }),
        ).rejects.toMatchObject(SHAPE);
        await expect(
          insertChcPreparation(chain, { snapshot: { postingAuthorized: true } }),
        ).rejects.toMatchObject(SHAPE);
        for (const key of [
          "schemaVersion",
          "profile",
          "institutionalFormatQualified",
          "institutionalUnits",
          "observedMinutes",
          "qualifiedMinutes",
          "estimatedReimbursementCents",
          "billedChargeCents",
          "programAssignment",
          "encounterSources",
          "integrityFingerprint",
        ]) {
          await expect(insertChcPreparation(chain, { drop: [key] }), key).rejects.toMatchObject({
            code: "23514",
          });
        }
        // Facts only the guard compares: an absent one is a mismatch, not an unknown.
        for (const key of [
          "ratePolicyVersion",
          "rateCentsPerHour",
          "quantityConversionMethod",
          "billingEvidenceVersion",
          "localityEvidenceVersion",
          "qualityEvidenceVersion",
          "billedChargeEvidenceVersion",
          "codingEvidenceVersion",
          "billedChargeCentsPerHour",
          "maximumClinicalMinutes",
        ]) {
          await expect(insertChcPreparation(chain, { drop: [key] }), key).rejects.toMatchObject({
            code: "23514",
          });
        }
      });

      it("a malformed number or timestamp is a 23514 refusal, not a cast error", async () => {
        const chain = await seedChcChain(ORG_A, a.pe);
        for (const snapshot of [
          { observedMinutes: "abc" },
          { ratePolicyVersion: 1.5 },
          { qualifiedMinutes: 99_999_999_999 },
          { assessedAt: "zzz" },
        ]) {
          await expect(
            insertChcPreparation(chain, { snapshot }),
            JSON.stringify(snapshot),
          ).rejects.toMatchObject({
            code: "23514",
          });
        }
      });

      it("a rate or evidence row that has a successor, or an unbound cap, cannot back a preparation", async () => {
        const supersede = (table: string, id: string) =>
          db.query(
            table === "medicaid_payer_rate_policy"
              ? `INSERT INTO medicaid_payer_rate_policy
                   (organization_id, provider_entity_id, canonical_payer_id, program_kind, service_state,
                    locality_code, service_category, unit_basis, bucket_from, bucket_to, rate_cents,
                    quality_reporting_applicability, quality_reporting_status,
                    source_kind, effective_from, recorded_by_membership_id, supersedes_id)
                 SELECT organization_id, provider_entity_id, canonical_payer_id, program_kind, service_state,
                    locality_code, service_category, unit_basis, bucket_from, bucket_to, 9000,
                    quality_reporting_applicability, quality_reporting_status,
                    source_kind, effective_from, recorded_by_membership_id, id
                   FROM medicaid_payer_rate_policy WHERE id = $1`
              : `INSERT INTO medicaid_hospice_billing_evidence
                   (organization_id,provider_entity_id,patient_id,admission_id,admission_version,
                    canonical_payer_id,program_kind,service_state,locality_code,locality_evidence_reference,
                    locality_evidence_version,quality_reporting_applicability,quality_reporting_status,
                    quality_evidence_reference,quality_evidence_version,service_category,quantity_policy,
                    quantity_evidence_owner,billing_unit,revenue_code,hcpcs_code,coding_profile,
                    coding_evidence_reference,coding_evidence_version,billed_charge_cents_per_unit,
                    charge_evidence_reference,charge_evidence_version,verification_status,effective_from,
                    effective_to,source_document_reference,verified_at,verified_by_membership_id,
                    recorded_by_membership_id,supersedes_id,version)
                 SELECT organization_id,provider_entity_id,patient_id,admission_id,admission_version,
                    canonical_payer_id,program_kind,service_state,locality_code,locality_evidence_reference,
                    locality_evidence_version,quality_reporting_applicability,quality_reporting_status,
                    quality_evidence_reference,quality_evidence_version,service_category,quantity_policy,
                    quantity_evidence_owner,billing_unit,revenue_code,hcpcs_code,coding_profile,
                    coding_evidence_reference,coding_evidence_version,billed_charge_cents_per_unit,
                    charge_evidence_reference,charge_evidence_version,verification_status,effective_from,
                    effective_to,source_document_reference,verified_at,verified_by_membership_id,
                    recorded_by_membership_id,id,version+1
                   FROM medicaid_hospice_billing_evidence WHERE id = $1`,
            [id],
          );
        const supersededRate = await seedChcChain(ORG_A, a.pe);
        const preparationId = randomUUID();
        // control: while it was current it backed version 1; once it has a successor version 2 cannot rest on it
        expect(await insertChcPreparation(supersededRate, { preparationId })).toBeTruthy();
        await supersede("medicaid_payer_rate_policy", supersededRate.rate);
        await expect(
          insertChcPreparation(supersededRate, { preparationId, version: 2 }),
        ).rejects.toMatchObject(refusedBy(RATE_IDENTITY));
        const supersededEvidence = await seedChcChain(ORG_A, a.pe);
        await supersede("medicaid_hospice_billing_evidence", supersededEvidence.evidence);
        await expect(insertChcPreparation(supersededEvidence)).rejects.toMatchObject(
          refusedBy(EVIDENCE_IDENTITY),
        );
        // The cap is mandatory: a rate with no maximum cannot back a preparation, whatever the snapshot says.
        const uncapped = await seedChcChain(ORG_A, a.pe, {
          rate: { maximum_clinical_minutes: null },
        });
        await expect(insertChcPreparation(uncapped)).rejects.toMatchObject(
          refusedBy(RATE_IDENTITY),
        );
        // The snapshot records the rate's own minimum.
        const minimum = await seedChcChain(ORG_A, a.pe);
        await expect(
          insertChcPreparation(minimum, { snapshot: { minimumClinicalMinutes: null } }),
        ).rejects.toMatchObject(refusedBy(RATE_IDENTITY));
      });

      it("the rate and the evidence must describe the same locality and quality-reporting variant", async () => {
        const locality = await seedChcChain(ORG_A, a.pe, {
          evidence: { locality_code: "CBSA-OTHER" },
        });
        await expect(
          insertChcPreparation(locality, { snapshot: { localityCode: "CBSA-OTHER" } }),
        ).rejects.toMatchObject(refusedBy(EVIDENCE_IDENTITY));
        const quality = await seedChcChain(ORG_A, a.pe, {
          rate: { quality_reporting_applicability: "required", quality_reporting_status: "meets" },
        });
        await expect(
          insertChcPreparation(quality, {
            snapshot: { qualityApplicability: "required", qualityStatus: "meets" },
          }),
        ).rejects.toMatchObject(refusedBy(EVIDENCE_IDENTITY));
      });

      it("a preparation cannot be assessed in the future or before its sources were recorded", async () => {
        const chain = await seedChcChain(ORG_A, a.pe);
        await expect(
          insertChcPreparation(chain, { assessedAt: await dbInstant("10 minutes") }),
        ).rejects.toMatchObject(refusedBy(/assessment timestamp mismatch/));
        await expect(
          insertChcPreparation(chain, { assessedAt: await dbInstant("-1 hour") }),
        ).rejects.toMatchObject(refusedBy(RATE_IDENTITY));
        // Control: a few minutes of application clock skew are tolerated.
        expect(
          await insertChcPreparation(chain, { assessedAt: await dbInstant("4 minutes") }),
        ).toBeTruthy();
      });

      it("a rate's clinical-minute maximum belongs to a per-hour rate, within the engine's day, above its minimum", async () => {
        const capped = (over: Record<string, unknown>) =>
          insertRow(
            "medicaid_payer_rate_policy",
            verifiedRateRow(ORG_A, a.pe, {
              service_category: "CHC",
              unit_basis: "per_hour",
              pricing_method: "per_hour",
              quantity_conversion_method: "hourly_prorated_minutes",
              minimum_duration_method: "minimum_minutes",
              minimum_clinical_minutes: 480,
              maximum_clinical_minutes: 600,
              ...over,
            }),
          );
        expect(await capped({})).toBeTruthy(); // control
        const refused = {
          code: "23514",
          constraint: "medicaid_payer_rate_policy_maximum_clinical_minutes_valid",
        };
        await expect(capped({ maximum_clinical_minutes: 1441 })).rejects.toMatchObject(refused);
        await expect(capped({ maximum_clinical_minutes: 0 })).rejects.toMatchObject(refused);
        await expect(capped({ maximum_clinical_minutes: 300 })).rejects.toMatchObject(refused);
        await expect(
          insertRow(
            "medicaid_payer_rate_policy",
            verifiedRateRow(ORG_A, a.pe, { maximum_clinical_minutes: 600 }),
          ),
        ).rejects.toMatchObject(refused);
      });
    });
  },
);
