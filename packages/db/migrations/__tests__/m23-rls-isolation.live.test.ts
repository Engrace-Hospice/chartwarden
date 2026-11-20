import { randomUUID } from "node:crypto";
/**
 * M23 Billing — Medicare — RLS cross-tenant denial — LIVE Postgres (§3.5 / §9.3).
 *
 * WHY THIS SUITE EXISTS. The M23 persistence covered here includes high-risk claim, beneficiary,
 * notice-rendering, exception-review, operational-issue and notification-outbox records. Those are
 * not incidental tables: a
 * `claim` row carries `patient_id`, the admission and election-period ids, dates of service and the
 * billed level of care; `claim_line` carries the HIPPS/Q-code detail; `eligibility_check` carries the
 * Medicare Part-A response for a named patient. The policies were written in 0077 and the audit
 * triggers in 0079, and nothing ever executed a cross-tenant read against them.
 *
 * Structure mirrors m24-rls-isolation.live.test.ts (M23's near-twin), including the COVERED map that
 * drives the per-table assertions from one list, so adding a table to M23 without adding it here is
 * visible as a gap rather than silently uncovered.
 *
 * NOTE ON SEEDING: only `organization_id` (and `claim_acknowledgment.submission_id`) are enforced FKs
 * — most cross-references are plain uuids because the referenced tables are partitioned. So the seed
 * uses `gen_random_uuid()` for those, which is honest: this suite proves TENANCY, not referential
 * integrity, and inventing a fake M5/M6 chain would test neither.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropLiveRoles } from "./_live-roles";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ISOLATED_RUN = process.env.CHARTWARDEN_M23_RLS_ISOLATED_RUN === "true";
if (ISOLATED_RUN && !DB_URL) {
  throw new Error("M23 isolated runner did not provide CHARTWARDEN_TEST_DATABASE_URL");
}
const MIGRATIONS_DIR = join(__dirname, "..");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

type SeedIds = {
  membership: string;
  pe: string;
  claim: string;
  claimLine: string;
  stateHistory: string;
  submission: string;
  acknowledgment: string;
  eligibility: string;
  perDiemClass: string;
  sia: string;
  validationRun: string;
  validationResult: string;
  validationOverride: string;
  ruleConfig: string;
  noe: string;
  notr: string;
  sequestration: string;
  credential: string;
  lineEvidence: string;
  renderIdentity: string;
  renderArtifact: string;
  medicareRouting: string;
  medicareRoutingIssue: string;
  claimmdRoute: string;
  claimmdEnrollment: string;
  noeExceptionReview: string;
  noeExceptionReviewEvent: string;
  operationalIssue: string;
  operationalIssueEvent: string;
  operationalIssueNotification: string;
  tenantResponseAccount: string;
  tenantResponseCredential: string;
  tenantResponseBatch: string;
  tenantResponseItem: string;
  tenantResponseOutcome: string;
};

/**
 * The org-scoped M23 tables exercised by this suite. `wage_index_factor` is deliberately absent — it
 * carries no organization_id (CMS-published platform reference data) and is asserted separately below.
 */
const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "claim", key: "claim" },
  { table: "claim_line", key: "claimLine" },
  { table: "claim_state_history", key: "stateHistory" },
  { table: "claim_submission", key: "submission" },
  { table: "claim_acknowledgment", key: "acknowledgment" },
  { table: "eligibility_check", key: "eligibility" },
  { table: "per_diem_rate_calculation", key: "perDiemClass" },
  { table: "sia_calculation", key: "sia" },
  { table: "validation_run", key: "validationRun" },
  { table: "validation_result", key: "validationResult" },
  { table: "validation_override", key: "validationOverride" },
  { table: "validation_rule_config", key: "ruleConfig" },
  { table: "noe_record", key: "noe" },
  { table: "notr_record", key: "notr" },
  { table: "sequestration_policy", key: "sequestration" },
  { table: "mac_submitter_credential", key: "credential" },
  { table: "claimmd_submission_line_evidence", key: "lineEvidence" },
  { table: "medicare_notice_render_identity", key: "renderIdentity" },
  { table: "medicare_notice_render_artifact", key: "renderArtifact" },
  { table: "medicare_provider_routing", key: "medicareRouting" },
  { table: "medicare_provider_routing_backfill_issue", key: "medicareRoutingIssue" },
  { table: "claimmd_medicare_payer_route", key: "claimmdRoute" },
  { table: "claimmd_medicare_payer_enrollment", key: "claimmdEnrollment" },
  { table: "noe_exception_review", key: "noeExceptionReview" },
  { table: "noe_exception_review_event", key: "noeExceptionReviewEvent" },
  { table: "medicare_notice_operational_issue", key: "operationalIssue" },
  { table: "medicare_notice_operational_issue_event", key: "operationalIssueEvent" },
  {
    table: "medicare_notice_operational_issue_notification",
    key: "operationalIssueNotification",
  },
  { table: "claimmd_tenant_response_account", key: "tenantResponseAccount" },
  {
    table: "claimmd_tenant_response_account_credential",
    key: "tenantResponseCredential",
  },
  { table: "claimmd_tenant_response_batch", key: "tenantResponseBatch" },
  { table: "claimmd_tenant_response_item", key: "tenantResponseItem" },
  { table: "claimmd_tenant_response_item_outcome", key: "tenantResponseOutcome" },
];

describe.skipIf(!ISOLATED_RUN)(
  "M23 Billing — Medicare — RLS cross-tenant denial — LIVE Postgres (§3.5)",
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

    async function resetSchema() {
      await db.query("DROP SCHEMA IF EXISTS public CASCADE");
      await db.query("CREATE SCHEMA public");
      await dropLiveRoles(db);
    }

    async function applyMigrations() {
      const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const f of files) {
        await db.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      }
    }

    /** Seed one full M23 chain for `org` as superuser (RLS + grants bypassed). `n` distinguishes rows. */
    async function seedOrg(org: string, n: number): Promise<SeedIds> {
      const from = "2026-01-01";
      const to = "2026-01-31";
      const patient = `44444444-4444-4444-4444-44444444444${n}`;
      const one = async (sql: string, params: unknown[]): Promise<string> =>
        (await db.query(sql, params)).rows[0].id as string;
      const user = await one(
        `INSERT INTO "user" (email,email_verified,name,status)
         VALUES ($1,true,$2,'active') RETURNING id`,
        [`m23-rls-${n}@example.test`, `M23 RLS Operator ${n}`],
      );
      const membership = await one(
        `INSERT INTO membership (user_id,organization_id,status)
         VALUES ($1,$2,'active') RETURNING id`,
        [user, org],
      );
      const m = membership;
      const ccn = `00000${n}`;

      const pe = await one(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,$2,'PE',$3,'enc','0930') RETURNING id`,
        [org, ccn, `123456789${n}`],
      );

      // `claim` partitions BY LIST (provider_entity_id); the other three BY LIST (organization_id).
      // Calling the helpers (rather than relying on the DEFAULT partition) is what production does, and
      // it also exercises 0118's event trigger, which must secure each new leaf at creation.
      await db.query("SELECT create_claim_partition($1)", [pe]);
      for (const fn of [
        "create_claim_state_history_partition",
        "create_validation_run_partition",
        "create_validation_result_partition",
      ]) {
        await db.query(`SELECT ${fn}($1)`, [org]);
      }

      // `sequestration_policy_forward_only`: CHECK (effective_from > CURRENT_DATE OR effective_to IS NOT
      // NULL) — a policy is either scheduled ahead or already closed, never retroactively opened. Seed a
      // future effective date rather than weakening the constraint.
      const sequestration = await one(
        `INSERT INTO sequestration_policy (organization_id, provider_entity_id, percentage, effective_from, set_by_membership_id)
       VALUES ($1,$2,'2.0',CURRENT_DATE + interval '30 days',$3) RETURNING id`,
        [org, pe, m],
      );
      const claim = await one(
        `INSERT INTO claim (organization_id, provider_entity_id, patient_id, admission_id,
         election_period_id_from, election_period_id_to, patient_payer_id, tob, service_from, service_to,
         claim_control_number, mac_jurisdiction, sequestration_applied_pct, sequestration_policy_id,
         created_by_membership_id)
       VALUES ($1,$2,$3,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),
         '813',$4,$5,$6,'palmetto_jm','2.0',$7,$8) RETURNING id`,
        [org, pe, patient, from, to, `CCN${n}-260101-0001`, sequestration, m],
      );
      const claimLine = await one(
        `INSERT INTO claim_line (organization_id, claim_id, line_number, revenue_code, q_code, level_of_care,
         service_date_from, service_date_to, unit_count, unit_rate_cents, line_charge_cents, level_of_care_period_id)
       VALUES ($1,$2,1,'0651','Q5001','RHC',$3,$4,1,10000,10000,gen_random_uuid()) RETURNING id`,
        [org, claim, from, to],
      );
      const stateHistory = await one(
        `INSERT INTO claim_state_history (organization_id, claim_id, to_state, actor_kind)
       VALUES ($1,$2,'DRAFT','user') RETURNING id`,
        [org, claim],
      );
      // `claim_submission_exactly_one_subject`: CHECK (claim_id + noe_id + notr_id = 1) — a submission
      // envelope carries exactly one subject, so an 837I names the claim and nothing else.
      const submission = await one(
        `INSERT INTO claim_submission (organization_id, provider_entity_id, claim_id, kind,
         claim_control_number, attempt_index)
       VALUES ($1,$2,$3,'claim_837i',$4,1) RETURNING id`,
        [org, pe, claim, `CCN${n}-260101-0001`],
      );
      const acknowledgment = await one(
        `INSERT INTO claim_acknowledgment (organization_id, submission_id, kind, mac_jurisdiction,
         ack_file_uri, ack_received_at, parsed_payload, outcome_status)
       VALUES ($1,$2,'ack_277ca','palmetto_jm',$3,now(),'{}'::jsonb,'accepted') RETURNING id`,
        [org, submission, `s3://ack/${n}`],
      );
      const eligibility = await one(
        `INSERT INTO eligibility_check (organization_id, provider_entity_id, patient_id, as_of_service_date,
         outcome, parsed_payload, stale_at)
       VALUES ($1,$2,$3,$4,'active_part_a','{}'::jsonb, now() + interval '1 day') RETURNING id`,
        [org, pe, patient, from],
      );
      const perDiemClass = await one(
        `INSERT INTO per_diem_rate_calculation (organization_id, claim_id, per_diem_class_code, per_diem_rate_cents,
         wage_index_ccn, wage_index_fiscal_year, wage_index_factor, segments)
       VALUES ($1,$2,'R1000',10000,$3,2026,'1.0','[]'::jsonb) RETURNING id`,
        [org, claim, ccn],
      );
      const sia = await one(
        `INSERT INTO sia_calculation (organization_id, claim_id, patient_deceased_date, window_start,
         qualifying_visits, total_qualifying_minutes, sia_add_on_cents)
       VALUES ($1,$2,$3,$4,'[]'::jsonb,60,5000) RETURNING id`,
        [org, claim, to, from],
      );
      const validationRun = await one(
        `INSERT INTO validation_run (organization_id, claim_id, trigger, outcome, run_input_hash,
         rules_executed, rules_passed, rules_failed, rules_warn, rules_info, completed_at, duration_ms)
       VALUES ($1,$2,'initial_assembly','all_pass','hash',1,1,0,0,0,now(),5) RETURNING id`,
        [org, claim],
      );
      const validationResult = await one(
        `INSERT INTO validation_result (organization_id, validation_run_id, rule_key, rule_version, severity, outcome)
       VALUES ($1,$2,'rule.a',1,'error','fail') RETURNING id`,
        [org, validationRun],
      );
      const validationOverride = await one(
        `INSERT INTO validation_override (organization_id, result_id, override_membership_id,
         override_role_applied, reason, m4_audit_event_id)
       VALUES ($1,$2,$3,'billing_manager','documented clinical justification for this override',gen_random_uuid()) RETURNING id`,
        [org, validationResult, m],
      );
      const ruleConfig = await one(
        `INSERT INTO validation_rule_config (organization_id, rule_key, severity, set_by_membership_id)
       VALUES ($1,'rule.a','warn',$2) RETURNING id`,
        [org, m],
      );
      const noe = await one(
        `INSERT INTO noe_record (organization_id, provider_entity_id, patient_id, admission_id,
         election_period_id, election_effective_date, window_target_at, noe_control_number)
       VALUES ($1,$2,$3,gen_random_uuid(),gen_random_uuid(),$4,$4,$5) RETURNING id`,
        [org, pe, patient, from, `NOE${n}-0001`],
      );
      const noticeSubmission = await one(
        `INSERT INTO claim_submission (organization_id, provider_entity_id, noe_id, kind,
         claim_control_number, attempt_index)
       VALUES ($1,$2,$3,'noe',$4,0) RETURNING id`,
        [org, pe, noe, `NOE${n}-0001`],
      );
      const renderIdentity = await one(
        `INSERT INTO medicare_notice_render_identity
         (organization_id,notice_id,submission_id,notice_kind,related_source_id,provider_entity_id,
          jurisdiction,vendor,account_reference,usage,route_fingerprint,source_version,mapper_version,
          control_number,fingerprint,isa13,rendered_at)
       VALUES ($1,$2,$3,'noe',$2,$4,'palmetto_jm','direct_mac',$5,'test',$6,$7,'m23-notice-v1',
          $8,$9,$10,now()) RETURNING id`,
        [
          org,
          noe,
          noticeSubmission,
          pe,
          `direct-mac:${n}`,
          `route-${n}`,
          `source-${n}`,
          `NOE${n}-0001`,
          `fingerprint-${n}`,
          String(n).padStart(9, "0"),
        ],
      );
      const renderArtifact = await one(
        `INSERT INTO medicare_notice_render_artifact
         (organization_id,render_identity_id,ciphertext,content_sha256,plaintext_byte_length,
          encryption_key_version)
       VALUES ($1,$2,decode($3,'hex'),$4,128,'v1') RETURNING id`,
        [org, renderIdentity, "ab".repeat(32), "a".repeat(64)],
      );
      const exceptionReview = await one(
        `INSERT INTO noe_exception_review
         (organization_id,noe_id,category,justification_document_id,status,
          created_by_membership_id,updated_by_membership_id)
         VALUES ($1,$2,'operations_disruption',gen_random_uuid(),'draft',$3,$3)
         RETURNING id`,
        [org, noe, membership],
      );
      const exceptionReviewEvent = await one(
        `INSERT INTO noe_exception_review_event
         (organization_id,review_id,event_type,to_status,actor_membership_id)
         VALUES ($1,$2,'created','draft',$3) RETURNING id`,
        [org, exceptionReview, membership],
      );
      const operationalIssue = await one(
        `INSERT INTO medicare_notice_operational_issue
         (organization_id,notice_type,notice_id,issue_code,occurrence_key,severity,responsible_area)
         VALUES ($1,'noe',$2,'deadline_approaching',$3,'warning','billing') RETURNING id`,
        [org, noe, `deadline-approaching-${n}`],
      );
      const operationalIssueEvent = await one(
        `INSERT INTO medicare_notice_operational_issue_event
         (organization_id,issue_id,event_key,event_type,reason_code,next_state)
         VALUES ($1,$2,$3,'detected','deadline_approaching','active') RETURNING id`,
        [org, operationalIssue, `issue-detected-${n}`],
      );
      const operationalIssueNotification = await one(
        `INSERT INTO medicare_notice_operational_issue_notification
         (organization_id,issue_event_id) VALUES ($1,$2) RETURNING id`,
        [org, operationalIssueEvent],
      );
      // `notr_one_event_kind`: CHECK (revocation + transfer + discharge event ids = 1) — the NOTR names
      // the ONE M6 event that ended the benefit period, and `trigger_kind` must agree with which id is set.
      const notr = await one(
        `INSERT INTO notr_record (organization_id, provider_entity_id, patient_id, admission_id,
         trigger_kind, discharge_event_id, effective_end_date, window_target_at, notr_control_number)
       VALUES ($1,$2,$3,gen_random_uuid(),'discharge',gen_random_uuid(),$4,$4,$5) RETURNING id`,
        [org, pe, patient, to, `NOTR${n}-0001`],
      );
      const credential = await one(
        `INSERT INTO mac_submitter_credential (organization_id, provider_entity_id, mac_jurisdiction,
         submitter_id, trading_partner_id, client_id, client_secret_cipher, client_secret_dek_version,
         set_by_membership_id)
       VALUES ($1,$2,'palmetto_jm',$3,'TP','CID','cipher',1,$4) RETURNING id`,
        [org, pe, `SUB${n}`, m],
      );
      const medicareRouting = await one(
        `INSERT INTO medicare_provider_routing
         (organization_id, provider_entity_id, mac_jurisdiction, effective_from, provenance,
          set_by_membership_id, set_reason)
         VALUES ($1,$2,'palmetto_jm',$3,'manual',$4,'provider_documentation') RETURNING id`,
        [org, pe, from, m],
      );
      const medicareRoutingIssue = await one(
        `INSERT INTO medicare_provider_routing_backfill_issue
         (organization_id, provider_entity_id, legacy_credential_id, reason_code, candidate_jurisdictions)
         VALUES ($1,$2,$3,'canonical_route_exists',ARRAY['palmetto_jm']) RETURNING id`,
        [org, pe, randomUUID()],
      );
      const payerId = randomUUID();
      const claimmdRoute = await one(
        `INSERT INTO claimmd_medicare_payer_route
         (organization_id,provider_entity_id,payer_id,mac_jurisdiction,account_reference,usage,
          external_payer_id,transaction_type,effective_from,status,provenance,created_by_membership_id)
         VALUES ($1,$2,$3,'palmetto_jm',$4,'test',$5,'837i',$6,'active','manual_configuration',$7)
         RETURNING id`,
        [org, pe, payerId, `account-${n}`, `PAYER${n}`, from, m],
      );
      const claimmdEnrollment = await one(
        `INSERT INTO claimmd_medicare_payer_enrollment
         (organization_id,provider_entity_id,payer_id,account_reference,usage,transaction_type,status,
          effective_from)
         VALUES ($1,$2,$3,$4,'test','837i','pending',$5) RETURNING id`,
        [org, pe, payerId, `account-${n}`, from],
      );
      const justificationDocumentId = randomUUID();
      const noeExceptionReview = await one(
        `INSERT INTO noe_exception_review
         (organization_id,noe_id,category,justification_document_id,status,created_by_membership_id,
          updated_by_membership_id)
         VALUES ($1,$2,'operations_disruption',$3,'evidence_required',$4,$4) RETURNING id`,
        [org, noe, justificationDocumentId, m],
      );
      const noeExceptionReviewEvent = await one(
        `INSERT INTO noe_exception_review_event
         (organization_id,review_id,event_type,to_status,actor_membership_id,evidence_document_ids)
         VALUES ($1,$2,'created','evidence_required',$3,ARRAY[$4]::uuid[]) RETURNING id`,
        [org, noeExceptionReview, m, justificationDocumentId],
      );

      const evidenceId = randomUUID();
      const payloadSha256 = "a".repeat(64);
      await db.query(
        `INSERT INTO claimmd_submission_evidence
         (id,organization_id,provider_entity_id,claim_id,billing_module,submission_id,attempt_key,vendor,
          account_reference,usage,billing_npi,billing_tin_ciphertext,payer_id,claim_type,pcn,isa13,gs06,st02,
          service_from,service_to,payload_sha256,payload_format,outbound_reference,reserved_at)
         VALUES ($1,$2,$3,$4,'M23',$5,$6,'claimmd','test-account','test','1234567890',
          '0123456789abcdef0123456789abcdef','payer-test','institutional','PCN1','000000001','1','0001',
          '20260101','20260131',$7,'x12','outbound-test',now())`,
        [evidenceId, org, pe, claim, submission, `attempt-${n}`, payloadSha256],
      );
      const lineEvidence = await one(
        `INSERT INTO claimmd_submission_line_evidence
         (evidence_id,organization_id,provider_entity_id,claim_id,submission_id,attempt_key,internal_claim_line_id,
          line_position,line_item_control_number,revenue_code,procedure_code,service_from,service_to,units,
          charge_cents,payload_sha256,account_reference,usage)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,'REF-1','0651','Q5001','20260101','20260131','1',10000,$8,
          'test-account','test') RETURNING id`,
        [evidenceId, org, pe, claim, submission, `attempt-${n}`, claimLine, payloadSha256],
      );

      const tenantConfig = await one(
        `INSERT INTO tenant_clearinghouse_config
         (organization_id,vendor,mode,status,secret_cipher,secret_dek_version,
          credential_fingerprint,credential_fingerprint_key_id,verification_kind,verification_evidence,
          verified_at,verified_by_membership_id,activated_at,activated_by_membership_id,
          baa_vendor,baa_effective_date,baa_document_ref,baa_recorded_at,baa_recorded_by_membership_id,
          baa_verified_at,baa_verified_by_membership_id,set_by_membership_id)
         VALUES ($1,'claimmd','test','active','synthetic-encrypted-credential',1,$2,$3,
          'attested','synthetic account verification',now(),$4,now(),$4,'claimmd','2026-01-01',
          'ticket-m23-test',now(),$4,now(),$4,$4) RETURNING id`,
        [org, String(n).repeat(64), "a".repeat(16), membership],
      );
      const tenantResponseAccount = await one(
        `INSERT INTO claimmd_tenant_response_account
         (organization_id,tenant_config_id,usage,state,verified_by_membership_id,
          verification_reference,verified_at,coverage_started_at)
         VALUES ($1,$2,'test','verified',$3,$4,now(),now()) RETURNING id`,
        [org, tenantConfig, membership, `m23-test-account-${n}`],
      );
      const tenantResponseCredential = await one(
        `INSERT INTO claimmd_tenant_response_account_credential
         (organization_id,account_id,usage,credential_fingerprint,fingerprint_key_id,
          verified_by_membership_id,verification_reference,verified_at)
         VALUES ($1,$2,'test',$3,$4,$5,$6,now()) RETURNING id`,
        [
          org,
          tenantResponseAccount,
          String(n).repeat(64),
          "a".repeat(16),
          membership,
          `m23-test-key-${n}`,
        ],
      );
      const tenantResponseBatch = await one(
        `INSERT INTO claimmd_tenant_response_batch
         (organization_id,account_id,usage,after_cursor,next_cursor,source_format,key_version,
          payload_cipher,payload_digest,parent_count,item_count,capture_id)
         VALUES ($1,$2,'test','0','1','json','tenant-test-v1',decode(repeat('ab',32),'hex'),
          $3,1,1,gen_random_uuid()) RETURNING id`,
        [org, tenantResponseAccount, "b".repeat(64)],
      );
      const tenantResponseItem = await one(
        `INSERT INTO claimmd_tenant_response_item
         (organization_id,account_id,batch_id,response_id,source_cursor,parent_index,message_index,
          payload_digest,capture_state)
         VALUES ($1,$2,$3,$4,'0',0,0,$5,'captured') RETURNING id`,
        [org, tenantResponseAccount, tenantResponseBatch, String(n), "c".repeat(64)],
      );
      const tenantResponseOutcome = await one(
        `INSERT INTO claimmd_tenant_response_item_outcome
         (organization_id,account_id,item_id,consumer_key,idempotency_key,outcome)
         VALUES ($1,$2,$3,'test.ack','seed-outcome','processed') RETURNING id`,
        [org, tenantResponseAccount, tenantResponseItem],
      );

      return {
        membership,
        pe,
        claim,
        claimLine,
        stateHistory,
        submission,
        acknowledgment,
        eligibility,
        perDiemClass,
        sia,
        validationRun,
        validationResult,
        validationOverride,
        ruleConfig,
        noe,
        notr,
        sequestration,
        credential,
        lineEvidence,
        renderIdentity,
        renderArtifact,
        medicareRouting,
        medicareRoutingIssue,
        claimmdRoute,
        claimmdEnrollment,
        noeExceptionReview,
        noeExceptionReviewEvent,
        operationalIssue,
        operationalIssueEvent,
        operationalIssueNotification,
        tenantResponseAccount,
        tenantResponseCredential,
        tenantResponseBatch,
        tenantResponseItem,
        tenantResponseOutcome,
      };
    }

    beforeAll(async () => {
      db = new Client({ connectionString: DB_URL });
      await db.connect();
      // This must execute before resetSchema(): an accidental shared/incorrect target must not get
      // destructive DDL. The isolated runner passes these values directly into Vitest's env.
      const identity = await db.query<{
        database_name: string;
        cluster_name: string;
        system_identifier: string;
        is_superuser: boolean;
      }>(`
        SELECT current_database() AS database_name,
               current_setting('cluster_name') AS cluster_name,
               (pg_control_system()).system_identifier::text AS system_identifier,
               (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser
      `);
      expect(identity.rows).toHaveLength(1);
      expect(identity.rows[0]).toMatchObject({
        database_name: expect.stringMatching(/^m23_[a-f0-9]{32}$/),
        cluster_name: process.env.CHARTWARDEN_TEST_CLUSTER_ID,
        system_identifier: process.env.CHARTWARDEN_TEST_CLUSTER_SYSTEM_IDENTIFIER,
        is_superuser: true,
      });
      expect(process.env.CHARTWARDEN_TEST_CLUSTER_ID).toMatch(/^chartwarden-m23-[a-f0-9]{32}$/);
      expect(process.env.CHARTWARDEN_TEST_CLUSTER_SYSTEM_IDENTIFIER).toMatch(/^\d+$/);
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

    it("chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
      const { rows } = await db.query<{ rolbypassrls: boolean }>(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].rolbypassrls).toBe(false);
    });

    it("every M23 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", () => {
      const rls = readFileSync(join(MIGRATIONS_DIR, "0077_billing_m23_rls.sql"), "utf8");
      const blocks = rls.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
      expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks) {
        // A policy that reaches into another table, or keys on a role, is not tenancy — it is a
        // second authorization system that RLS cannot reason about (ADR-0010 D2/D3).
        expect(b, `policy uses a subquery: ${b.slice(0, 80)}`).not.toMatch(/SELECT\s+.*\s+FROM/i);
        expect(b, `policy keys on a role: ${b.slice(0, 80)}`).not.toMatch(/pg_has_role/i);
        if (/current_setting/.test(b)) {
          expect(b, `policy keys on a non-canonical setting: ${b.slice(0, 80)}`).toMatch(
            /current_setting\('app\.org_id'/,
          );
        }
      }
    });

    it("org B sees NONE of org A's rows, on every org-scoped M23 table", async () => {
      for (const { table, key } of COVERED) {
        const seen = await withOrg(ORG_B, () =>
          db.query(`SELECT id FROM ${table} WHERE id = $1`, [a[key]]),
        );
        expect(seen.rowCount, `${table}: org B could read an org-A row`).toBe(0);

        // and the same row IS visible to its owner — otherwise a table that denies everyone would
        // pass the case above while being broken.
        const own = await withOrg(ORG_A, () =>
          db.query(`SELECT id FROM ${table} WHERE id = $1`, [a[key]]),
        );
        expect(own.rowCount, `${table}: org A cannot read its OWN row`).toBe(1);
      }
    });

    it("a WITH CHECK refuses an INSERT carrying another tenant's organization_id", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO validation_rule_config (organization_id, rule_key, severity, set_by_membership_id)
           VALUES ($1,'rule.evil','error','00000000-0000-0000-0000-000000000000')`,
            [ORG_A],
          ),
        ),
      ).rejects.toThrow();
    });

    it("new M23 routing and exception tables reject forged cross-tenant writes", async () => {
      const membership = "00000000-0000-0000-0000-000000000000";
      const attempts: Array<{ sql: string; params: unknown[] }> = [
        {
          sql: `INSERT INTO medicare_provider_routing
            (organization_id,provider_entity_id,mac_jurisdiction,effective_from,provenance,set_by_membership_id,set_reason)
            VALUES ($1,$2,'palmetto_jm','2027-01-01','manual',$3,'provider_documentation')`,
          params: [ORG_A, randomUUID(), membership],
        },
        {
          sql: `INSERT INTO claimmd_medicare_payer_route
            (organization_id,provider_entity_id,payer_id,mac_jurisdiction,account_reference,usage,
             external_payer_id,transaction_type,effective_from,status,provenance,created_by_membership_id)
            VALUES ($1,$2,$3,'palmetto_jm','forged','test','FORGED','837i','2027-01-01','active',
             'manual_configuration',$4)`,
          params: [ORG_A, randomUUID(), randomUUID(), membership],
        },
        {
          sql: `INSERT INTO claimmd_medicare_payer_enrollment
            (organization_id,provider_entity_id,payer_id,account_reference,usage,transaction_type,status,effective_from)
            VALUES ($1,$2,$3,'forged','test','837i','pending','2027-01-01')`,
          params: [ORG_A, randomUUID(), randomUUID()],
        },
        {
          sql: `INSERT INTO noe_exception_review_event
            (organization_id,review_id,event_type,to_status,actor_membership_id)
            VALUES ($1,$2,'created','evidence_required',$3)`,
          params: [ORG_A, a.noeExceptionReview, membership],
        },
      ];
      for (const attempt of attempts) {
        await expect(withOrg(ORG_B, () => db.query(attempt.sql, attempt.params))).rejects.toThrow(
          /row-level security policy/,
        );
      }

      // The review's BEFORE trigger resolves its NOE under the caller's tenant context before
      // PostgreSQL evaluates WITH CHECK. Org B therefore cannot see org A's NOE and the layered
      // same-org guard fails closed first; COVERED above separately proves the row is RLS-hidden.
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO noe_exception_review
              (organization_id,noe_id,category,justification_document_id,status,created_by_membership_id,
               updated_by_membership_id)
              VALUES ($1,$2,'operations_disruption',$3,'evidence_required',$4,$4)`,
            [ORG_A, a.noe, randomUUID(), membership],
          ),
        ),
      ).rejects.toThrow(/must reference a NOE in the same organization/);
    });

    it("a cross-tenant UPDATE matches no rows (the USING clause covers writes too)", async () => {
      const upd = await withOrg(ORG_B, () =>
        db.query("UPDATE validation_rule_config SET severity = 'info' WHERE id = $1", [
          a.ruleConfig,
        ]),
      );
      expect(upd.rowCount, "org B updated an org-A rule config").toBe(0);
    });

    it("enforces exception-review and operational-issue tenant ownership with append-only histories", async () => {
      const foreignIssue = await withOrg(ORG_B, () =>
        db.query("SELECT id FROM medicare_notice_operational_issue WHERE id=$1", [
          a.operationalIssue,
        ]),
      );
      expect(foreignIssue.rowCount).toBe(0);

      const foreignReview = await withOrg(ORG_B, () =>
        db.query("SELECT id FROM noe_exception_review WHERE id=$1", [a.noeExceptionReview]),
      );
      expect(foreignReview.rowCount).toBe(0);

      await expect(
        withOrg(ORG_A, () =>
          db.query(
            "UPDATE medicare_notice_operational_issue SET assigned_membership_id=$2 WHERE id=$1",
            [a.operationalIssue, b.membership],
          ),
        ),
      ).rejects.toThrow(/active same-organization membership/);

      await expect(
        db.query(
          "UPDATE medicare_notice_operational_issue_event SET reason_code='changed' WHERE id=$1",
          [a.operationalIssueEvent],
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        db.query("DELETE FROM noe_exception_review_event WHERE id=$1", [a.noeExceptionReviewEvent]),
      ).rejects.toThrow(/append-only/);
    });

    it("tenant Claim.MD inbox is org-scoped and captured evidence and credential bindings are immutable", async () => {
      for (const [table, id] of [
        ["claimmd_tenant_response_account", a.tenantResponseAccount],
        ["claimmd_tenant_response_account_credential", a.tenantResponseCredential],
        ["claimmd_tenant_response_batch", a.tenantResponseBatch],
        ["claimmd_tenant_response_item", a.tenantResponseItem],
        ["claimmd_tenant_response_item_outcome", a.tenantResponseOutcome],
      ] as const) {
        await expect(
          withOrg(ORG_A, () => db.query(`DELETE FROM ${table} WHERE id=$1`, [id])),
        ).rejects.toThrow();
      }
      const foreignUpdate = await withOrg(ORG_B, () =>
        db.query("UPDATE claimmd_tenant_response_batch SET captured_at=now() WHERE id=$1", [
          a.tenantResponseBatch,
        ]),
      );
      expect(foreignUpdate.rowCount).toBe(0);
      const wrongTenantRead = await withOrg(ORG_B, () =>
        db.query("SELECT id FROM claimmd_tenant_response_item WHERE id=$1", [a.tenantResponseItem]),
      );
      expect(wrongTenantRead.rowCount).toBe(0);
      const wrongTenantOutcomeRead = await withOrg(ORG_B, () =>
        db.query("SELECT id FROM claimmd_tenant_response_item_outcome WHERE id=$1", [
          a.tenantResponseOutcome,
        ]),
      );
      expect(wrongTenantOutcomeRead.rowCount).toBe(0);
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            "UPDATE claimmd_tenant_response_item_outcome SET outcome='quarantined' WHERE id=$1",
            [a.tenantResponseOutcome],
          ),
        ),
      ).rejects.toThrow();
      const ownedInsert = await withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO claimmd_tenant_response_batch
             (organization_id,account_id,usage,after_cursor,next_cursor,source_format,key_version,
              payload_cipher,payload_digest,parent_count,item_count,capture_id)
             VALUES ($1,$2,'test','10','11','json','tenant-test-v1',decode(repeat('cd',32),'hex'),
              $3,0,0,gen_random_uuid()) RETURNING id`,
          [ORG_A, a.tenantResponseAccount, "d".repeat(64)],
        ),
      );
      expect(ownedInsert.rowCount).toBe(1);
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO claimmd_tenant_response_batch
               (organization_id,account_id,usage,after_cursor,next_cursor,source_format,key_version,
                payload_cipher,payload_digest,parent_count,item_count,capture_id)
               VALUES ($1,$2,'test','10','11','json','tenant-test-v1',decode(repeat('cd',32),'hex'),
                $3,0,0,gen_random_uuid())`,
            [ORG_A, a.tenantResponseAccount, "d".repeat(64)],
          ),
        ),
      ).rejects.toThrow();
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            "UPDATE claimmd_tenant_response_account_credential SET verification_reference='changed' WHERE id=$1",
            [a.tenantResponseCredential],
          ),
        ),
      ).rejects.toThrow();
    });

    it("deduplicates active issues and keeps issue event plus notification intent transactional", async () => {
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO medicare_notice_operational_issue
             (organization_id,notice_type,notice_id,issue_code,occurrence_key,severity,responsible_area)
             VALUES ($1,'noe',$2,'deadline_approaching','duplicate-occurrence','critical','billing')`,
            [ORG_A, a.noe],
          ),
        ),
      ).rejects.toThrow(/duplicate key|med_notice_issue_open_occurrence_uq/);

      const rolledBackEventKey = `rollback-${randomUUID()}`;
      await withOrg(ORG_A, async () => {
        await db.query("BEGIN");
        try {
          const issue = await db.query<{ id: string }>(
            `INSERT INTO medicare_notice_operational_issue
             (organization_id,notice_type,notice_id,issue_code,occurrence_key,severity,responsible_area)
             VALUES ($1,'noe',$2,'notification_delivery_gap',$3,'warning','platform_integration')
             RETURNING id`,
            [ORG_A, a.noe, rolledBackEventKey],
          );
          const event = await db.query<{ id: string }>(
            `INSERT INTO medicare_notice_operational_issue_event
             (organization_id,issue_id,event_key,event_type,reason_code,next_state)
             VALUES ($1,$2,$3,'detected','notification_delivery_gap','active') RETURNING id`,
            [ORG_A, issue.rows[0]?.id, rolledBackEventKey],
          );
          await db.query(
            `INSERT INTO medicare_notice_operational_issue_notification
             (organization_id,issue_event_id) VALUES ($1,$2)`,
            [ORG_A, event.rows[0]?.id],
          );
        } finally {
          await db.query("ROLLBACK");
        }
      });
      const persisted = await db.query(
        "SELECT id FROM medicare_notice_operational_issue_event WHERE event_key=$1",
        [rolledBackEventKey],
      );
      expect(persisted.rowCount).toBe(0);
    });

    it("fences notification publication and preserves cross-tenant outbox isolation", async () => {
      const published = await withOrg(ORG_A, () =>
        db.query(
          `UPDATE medicare_notice_operational_issue_notification
              SET state='published',attempts=attempts+1,last_attempt_at=now(),published_at=now()
            WHERE id=$1 AND state='pending' RETURNING id`,
          [a.operationalIssueNotification],
        ),
      );
      expect(published.rowCount).toBe(1);
      const duplicate = await withOrg(ORG_A, () =>
        db.query(
          `UPDATE medicare_notice_operational_issue_notification
              SET attempts=attempts+1 WHERE id=$1 AND state='pending' RETURNING id`,
          [a.operationalIssueNotification],
        ),
      );
      expect(duplicate.rowCount).toBe(0);
      const foreign = await withOrg(ORG_B, () =>
        db.query("SELECT id FROM medicare_notice_operational_issue_notification WHERE id=$1", [
          a.operationalIssueNotification,
        ]),
      );
      expect(foreign.rowCount).toBe(0);
    });

    it("line evidence is append-only for its owner and invisible to another tenant", async () => {
      const foreign = await withOrg(ORG_B, () =>
        db.query("SELECT id FROM claimmd_submission_line_evidence WHERE id=$1", [a.lineEvidence]),
      );
      expect(foreign.rowCount).toBe(0);
      await expect(
        withOrg(ORG_A, () =>
          db.query("UPDATE claimmd_submission_line_evidence SET charge_cents=1 WHERE id=$1", [
            a.lineEvidence,
          ]),
        ),
      ).rejects.toThrow(
        /permission denied for table claimmd_submission_line_evidence|CLAIMMD_SUBMISSION_EVIDENCE_IMMUTABLE/,
      );
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO claimmd_submission_line_evidence
           (evidence_id,organization_id,provider_entity_id,claim_id,submission_id,attempt_key,internal_claim_line_id,
            line_position,revenue_code,charge_cents,payload_sha256,account_reference,usage)
           SELECT evidence_id,organization_id,$2,claim_id,submission_id,attempt_key,internal_claim_line_id,
            2,revenue_code,charge_cents,payload_sha256,account_reference,usage
           FROM claimmd_submission_line_evidence WHERE id=$1`,
            [a.lineEvidence, randomUUID()],
          ),
        ),
      ).rejects.toThrow();
      const own = await withOrg(ORG_A, () =>
        db.query(
          "SELECT payload_sha256,internal_claim_line_id FROM claimmd_submission_line_evidence WHERE id=$1",
          [a.lineEvidence],
        ),
      );
      expect(own.rows).toEqual([
        { payload_sha256: "a".repeat(64), internal_claim_line_id: a.claimLine },
      ]);
      const audit = await db.query<{ billing_module: string }>(
        `SELECT context->>'billing_module' AS billing_module FROM audit_event
         WHERE resource_kind='claimmd_submission_line_evidence' AND resource_id=$1
         ORDER BY created_at DESC LIMIT 1`,
        [a.lineEvidence],
      );
      expect(audit.rows[0]?.billing_module).toBe("submission_line_evidence");
    });

    it("only the DRAFT-claim subtree grants DELETE to the runtime role, each behind a draft-only trigger", async () => {
      // The billing ledger is append-and-amend. Migration 1061 grants DELETE on EXACTLY the eight tables a DRAFT claim
      // owns (discard an unbilled draft; re-assembly rewrites the lines), and each is guarded in the database so a
      // claim past DRAFT cannot lose a row (m23-draft-claim-delete.live.test.ts proves the behaviour). Any other
      // table gaining DELETE has to argue with this test.
      const DRAFT_SUBTREE = [
        "claim",
        "claim_line",
        "claim_state_history",
        "per_diem_rate_calculation",
        "sia_calculation",
        "validation_override",
        "validation_result",
        "validation_run",
      ];
      const r = await db.query<{ table_name: string }>(
        `SELECT DISTINCT table_name
         FROM information_schema.role_table_grants
        WHERE grantee = 'chartwarden_app'
          AND privilege_type = 'DELETE'
          AND table_name IN (${COVERED.map((c) => `'${c.table}'`).join(",")})
        ORDER BY table_name`,
      );
      expect(
        r.rows.map((x) => x.table_name),
        "M23 table(s) deletable by the app role",
      ).toEqual(DRAFT_SUBTREE);
      const guarded = await db.query<{ relname: string }>(
        `SELECT DISTINCT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal AND c.relname = ANY($1)
            AND t.tgname IN ('trg_claim_delete_guard','trg_claim_line_delete_guard')
             OR (NOT t.tgisinternal AND c.relname = ANY($1) AND t.tgname LIKE 'trg_append_only_%')
          ORDER BY c.relname`,
        [DRAFT_SUBTREE],
      );
      expect(guarded.rows.map((x) => x.relname)).toEqual(DRAFT_SUBTREE);
    });

    it("reserves and terminalizes a queued claim submission exactly once and rejects deletion", async () => {
      const dispatchToken = randomUUID();
      const reserved = await withOrg(ORG_A, () =>
        db.query(
          `UPDATE claim_submission
              SET dispatch_state = 'sending', dispatch_token = $2, dispatch_started_at = now()
            WHERE id = $1
        RETURNING dispatch_state`,
          [a.submission, dispatchToken],
        ),
      );
      expect(reserved.rows[0]?.dispatch_state).toBe("sending");

      const updated = await withOrg(ORG_A, () =>
        db.query(
          `UPDATE claim_submission
              SET outcome = 'submitted', dispatch_state = 'finished',
                  generated_file_uri = 's3://claims/submitted.x12',
                  submitted_at = now(), worker_correlation_id = 'corr-1'
            WHERE id = $1
        RETURNING outcome`,
          [a.submission],
        ),
      );
      expect(updated.rows[0]?.outcome).toBe("submitted");

      await expect(
        withOrg(ORG_A, () =>
          db.query(
            `UPDATE claim_submission SET outcome = 'failed_portal', dispatch_state = 'finished',
                outcome_reason = 'late rewrite'
              WHERE id = $1`,
            [a.submission],
          ),
        ),
      ).rejects.toThrow(/authorized dispatch lifecycle transition/);

      await expect(
        db.query("DELETE FROM claim_submission WHERE id = $1", [a.submission]),
      ).rejects.toThrow(/cannot be deleted/);
    });

    it("the CLAIM chain is org-invisible end to end — not just the claim root", async () => {
      // The root being scoped is not enough: a leak through claim_line, a HIPPS/SIA calculation or a
      // validation result would expose the same claim's money and clinical detail by another door.
      const counts = await withOrg(ORG_B, async () => ({
        lines: (await db.query("SELECT 1 FROM claim_line WHERE claim_id = $1", [a.claim])).rowCount,
        perDiemClass: (
          await db.query("SELECT 1 FROM per_diem_rate_calculation WHERE claim_id = $1", [a.claim])
        ).rowCount,
        sia: (await db.query("SELECT 1 FROM sia_calculation WHERE claim_id = $1", [a.claim]))
          .rowCount,
        runs: (await db.query("SELECT 1 FROM validation_run WHERE claim_id = $1", [a.claim]))
          .rowCount,
        history: (
          await db.query("SELECT 1 FROM claim_state_history WHERE claim_id = $1", [a.claim])
        ).rowCount,
      }));
      expect(counts).toEqual({ lines: 0, perDiemClass: 0, sia: 0, runs: 0, history: 0 });
    });

    it("a patient's Medicare eligibility response is not readable across tenants", async () => {
      // eligibility_check holds the HETS Part-A answer for a NAMED patient — the most directly
      // identifying row M23 owns.
      const seen = await withOrg(ORG_B, () =>
        db.query("SELECT id FROM eligibility_check WHERE patient_id = $1", [
          "44444444-4444-4444-4444-444444444441",
        ]),
      );
      expect(seen.rowCount).toBe(0);
    });

    it("MAC submitter credentials never cross tenants (they are a submission identity)", async () => {
      const seen = await withOrg(ORG_B, () =>
        db.query("SELECT client_secret_cipher FROM mac_submitter_credential WHERE id = $1", [
          a.credential,
        ]),
      );
      expect(seen.rowCount, "org B could read another tenant's MAC credential").toBe(0);
    });

    it("wage_index_factor is PLATFORM reference data — shared, and not writable by a tenant", async () => {
      // CMS-published, carries no organization_id, and is deliberately NOT in COVERED. Both tenants
      // must see the same rows: a per-tenant copy of the wage index would let two tenants price the
      // same CCN differently.
      await db.query(
        `INSERT INTO wage_index_factor (ccn, fiscal_year_starting, factor_decimal, load_source_ref)
       VALUES ('999999',2026,'1.2345','cms-2026') ON CONFLICT DO NOTHING`,
      );
      for (const org of [ORG_A, ORG_B]) {
        const seen = await withOrg(org, () =>
          db.query("SELECT factor_decimal FROM wage_index_factor WHERE ccn = '999999'"),
        );
        expect(seen.rowCount, "a tenant cannot read platform wage-index reference data").toBe(1);
      }
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO wage_index_factor (ccn, fiscal_year_starting, factor_decimal, load_source_ref)
           VALUES ('888888',2026,'9.9999','forged')`,
          ),
        ),
      ).rejects.toThrow();
    });

    it("⚠ `claim_ack_file_uq` is NOT org-scoped — a cross-tenant write oracle", async () => {
      // FINDING, recorded rather than silently worked around. Every other unique index on M23's
      // org-scoped tables keys on `provider_entity_id` or `claim_id`, both of which are themselves
      // org-scoped, so they are transitively per-tenant. This one is (mac_jurisdiction, ack_file_uri) —
      // neither column is tenant-bound.
      //
      // RLS hides org A's ROW from org B, but a unique index is enforced BENEATH row security: org B's
      // insert fails with a duplicate-key error it cannot see the cause of. That turns the index into an
      // existence oracle — org B can learn whether org A has already ingested a given ack file URI.
      // Low severity (the attacker must know or guess the URI, and learns one bit), but it is a real
      // cross-tenant signal and the asymmetry is worth knowing about before someone treats ack_file_uri
      // as attacker-influenced input.
      //
      // Asserted, not fixed: adding organization_id to the index is a deliberate product call — the
      // current shape also prevents the SAME CMS ack file being ingested twice platform-wide, which may
      // well be the intent. This case documents which of the two behaviours is in force.
      const uri = "s3://ack/shared-across-tenants";
      await db.query(
        `INSERT INTO claim_acknowledgment (organization_id, submission_id, kind, mac_jurisdiction,
         ack_file_uri, ack_received_at, parsed_payload, outcome_status)
       VALUES ($1,$2,'ack_277ca','palmetto_jm',$3,now(),'{}'::jsonb,'accepted')`,
        [ORG_A, a.submission, uri],
      );
      // Org B cannot SEE the row...
      const seen = await withOrg(ORG_B, () =>
        db.query("SELECT id FROM claim_acknowledgment WHERE ack_file_uri = $1", [uri]),
      );
      expect(seen.rowCount, "org B could read org A's acknowledgment").toBe(0);
      // ...but it can DETECT it, because the unique index spans tenants.
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO claim_acknowledgment (organization_id, submission_id, kind, mac_jurisdiction,
             ack_file_uri, ack_received_at, parsed_payload, outcome_status)
           VALUES ($1,$2,'ack_277ca','palmetto_jm',$3,now(),'{}'::jsonb,'accepted')`,
            // Use org B's own submission so this assertion isolates the global unique-index signal
            // rather than relying on a cross-organization submission FK reference.
            [ORG_B, b.submission, uri],
          ),
        ),
        "if this stops throwing, the index became org-scoped — update this case",
      ).rejects.toThrow(/duplicate key|claim_ack_file_uq/);
    });

    it("every partition leaf minted for M23 is born with forced RLS (0118 event trigger)", async () => {
      // `claim` partitions by provider_entity_id and three tables by organization_id, so seeding above
      // created leaves at runtime — exactly the path that used to produce unprotected partitions.
      const r = await db.query<{ relname: string }>(
        `SELECT c.relname
         FROM pg_class c
         JOIN pg_inherits i ON i.inhrelid = c.oid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname IN ('claim','claim_state_history','validation_run','validation_result')
          AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)`,
      );
      expect(
        r.rows.map((x) => x.relname),
        "M23 partition leaf without forced RLS",
      ).toEqual([]);
    });
  },
);
