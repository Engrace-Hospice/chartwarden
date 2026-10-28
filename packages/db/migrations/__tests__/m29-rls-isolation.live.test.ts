/**
 * M29 External Interfaces — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / ADR-0010).
 *
 * The pure unit suites (apps/backend/.../29-external-interfaces, packages/*) exercise the domain but never
 * touch a database, so they cannot catch a wrong RLS predicate, a missing WITH CHECK, or a base-table grant
 * that leaks across tenants. This test applies the actual migrations to a real Postgres and exercises the
 * policies as the unprivileged `chartwarden_app` role (no BYPASSRLS), proving cross-tenant denial for real on
 * the NINE org-scoped M29 tables under the canonical `organization_id = current_setting('app.org_id')`
 * predicate — including the five FOR VALUES-partitioned tables (hl7_message_inbound, hl7_message_outbound,
 * hl7_inbound_proposal, lab_observation, lab_observation_value): the policy on the parent propagates to
 * every partition incl. DEFAULT (PG11+). `nppes_provider` and `nppes_sync_run` carry NO organization_id BY
 * DESIGN — the CMS NPPES directory is the same for every tenant (0148's own §1 comment) — so, mirroring the
 * m26 precedent for `cap_period_platform_constant`, they are intentionally NOT in the per-tenant isolation
 * loop; they get a read-all assertion instead.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m29` (SUPERUSER to a THROWAWAY db;
 *     for a local PG without pgvector, set CHARTWARDEN_TEST_NO_PGVECTOR=1).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropLiveRoles } from "../../../../apps/backend/__tests__/_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

type SeedIds = {
  feedId: string;
  feedCredentialId: string;
  hl7InboundId: string;
  hl7OutboundId: string;
  hl7ProposalId: string;
  labObservationId: string;
  labObservationValueId: string;
  labInboundLinkId: string;
};

const COVERED: { table: string; key: keyof SeedIds; idCol?: string }[] = [
  { table: "external_feed", key: "feedId" },
  { table: "external_feed_credential", key: "feedCredentialId" },
  { table: "external_feed_health", key: "feedId", idCol: "feed_id" },
  { table: "lab_observation_inbound_link", key: "labInboundLinkId" },
  { table: "hl7_message_inbound", key: "hl7InboundId" },
  { table: "hl7_message_outbound", key: "hl7OutboundId" },
  { table: "hl7_inbound_proposal", key: "hl7ProposalId" },
  { table: "lab_observation", key: "labObservationId" },
  { table: "lab_observation_value", key: "labObservationValueId" },
];

describe.skipIf(!DB_URL)(
  "M29 External Interfaces — RLS cross-tenant denial — LIVE Postgres (§3.5)",
  () => {
    let db: Client;
    let a: SeedIds;

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
      const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
      const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const f of files) {
        let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        if (stripVector) {
          sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
        }
        await db.query(sql);
      }
    }

    /** Seed one full M29 feed/HL7/lab chain for `org` as superuser (RLS + grants bypassed). `n` distinguishes rows. */
    async function seedOrg(org: string, n: number): Promise<SeedIds> {
      const port = 6660 + n;
      const feedId = (
        await db.query(
          `INSERT INTO external_feed (organization_id, kind, display_name, port, protocol, status, proposed_by_membership_id)
         VALUES ($1,'adt_inbound',$2,$3,'mllp_tls','active',gen_random_uuid()) RETURNING id`,
          [org, `Feed ${n}`, port],
        )
      ).rows[0].id as string;
      const feedCredentialId = (
        await db.query(
          `INSERT INTO external_feed_credential (feed_id, organization_id, kind, secret_cipher, fingerprint)
         VALUES ($1,$2,'mllp_client_cert','cipher-blob',$3) RETURNING id`,
          [feedId, org, `fp-${n}`],
        )
      ).rows[0].id as string;
      await db.query(
        `INSERT INTO external_feed_health (feed_id, hour_bucket, organization_id)
       VALUES ($1, date_trunc('hour', now()), $2)`,
        [feedId, org],
      );
      const hl7InboundId = (
        await db.query(
          `INSERT INTO hl7_message_inbound (organization_id, feed_id, message_type, message_control_id,
           payload_cipher, payload_sha256, segments_summary, sending_facility_raw_id, idempotency_key)
         VALUES ($1,$2,'ADT^A01',$3,'cipher-blob',repeat('a',64),'{}'::jsonb,'FAC1',$4) RETURNING id`,
          [org, feedId, `MSG-IN-${n}`, `idem-in-${n}`],
        )
      ).rows[0].id as string;
      const hl7OutboundId = (
        await db.query(
          `INSERT INTO hl7_message_outbound (organization_id, feed_id, message_type, message_control_id,
           payload_cipher, payload_sha256, segments_summary, source_aggregate_kind, source_aggregate_id, idempotency_key)
         VALUES ($1,$2,'ORM^O01',$3,'cipher-blob',repeat('a',64),'{}'::jsonb,'m6_admission',gen_random_uuid(),$4) RETURNING id`,
          [org, feedId, `MSG-OUT-${n}`, `idem-out-${n}`],
        )
      ).rows[0].id as string;
      const hl7ProposalId = (
        await db.query(
          `INSERT INTO hl7_inbound_proposal (organization_id, source_message_id, resource_kind,
           proposed_patient_candidate, match_outcome, expires_at)
         VALUES ($1,$2,'new_patient','{}'::jsonb,'no_match', now() + interval '1 day') RETURNING id`,
          [org, hl7InboundId],
        )
      ).rows[0].id as string;
      const labObservationId = (
        await db.query(
          `INSERT INTO lab_observation (organization_id, provider_entity_id, source_message_id, patient_id,
           observation_date, result_status, loinc_code, loinc_display_text, terminology_validation, abnormal_summary)
         VALUES ($1,gen_random_uuid(),$2,gen_random_uuid(),now(),'final','2345-7','Glucose','valid','no_flags') RETURNING id`,
          [org, hl7InboundId],
        )
      ).rows[0].id as string;
      const labObservationValueId = (
        await db.query(
          `INSERT INTO lab_observation_value (organization_id, observation_id, obx_set_id, loinc_code,
           loinc_display_text, terminology_validation, value_type)
         VALUES ($1,$2,1,'2345-7','Glucose','valid','NM') RETURNING id`,
          [org, labObservationId],
        )
      ).rows[0].id as string;
      const labInboundLinkId = (
        await db.query(
          `INSERT INTO lab_observation_inbound_link (organization_id, observation_id, source_message_id, match_method)
         VALUES ($1,$2,$3,'manual') RETURNING id`,
          [org, labObservationId, hl7InboundId],
        )
      ).rows[0].id as string;
      return {
        feedId,
        feedCredentialId,
        hl7InboundId,
        hl7OutboundId,
        hl7ProposalId,
        labObservationId,
        labObservationValueId,
        labInboundLinkId,
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
      await seedOrg(ORG_B, 2);
      // Platform-shared NPPES rows: seeded ONCE, org-less by design (0148 §1).
      await db.query(
        `INSERT INTO nppes_provider (npi, enumeration_type, status, basic)
       VALUES ('1234567890','NPI-1','active','{"name":"Test Provider"}'::jsonb)`,
      );
      await db.query(
        `INSERT INTO nppes_sync_run (kind, triggered_by, status)
       VALUES ('daily_incremental','platform_cron','completed')`,
      );
    }, 120_000);

    afterAll(async () => {
      if (db) await db.end();
    });

    // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
    // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
    // scripts/db/migrate.ts grants exactly that behind CHARTWARDEN_DEV_BYPASSRLS=1, so this is reachable,
    // not theoretical.
    it("chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
      const { rows } = await db.query<{ rolbypassrls: boolean }>(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].rolbypassrls).toBe(false);
    });

    it("every M29 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
      const rls = readFileSync(
        join(MIGRATIONS_DIR, "0148_external_interfaces_m29_rls_audit_triggers.sql"),
        "utf8",
      );
      // Scope to the tenant-scoped section only — the PLATFORM-SHARED section below it (nppes_provider /
      // nppes_sync_run) has its own two-policy (read-all / admin-write) shape asserted separately below, and
      // a whole-file regex would otherwise merge across the WITH-CHECK-less SELECT policy into the next block.
      const tenantSection = rls.split("-- PLATFORM-SHARED")[0];
      const policyBlocks = tenantSection.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? [];
      expect(policyBlocks.length).toBe(9);
      for (const block of policyBlocks) {
        const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((m) => m[1]);
        expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
        expect(block).not.toMatch(/pg_has_role/i);
        expect(block).not.toMatch(/IS NULL/i);
      }
    });

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

    it("nppes_provider is read-all (every tenant sees the cached CMS directory row)", async () => {
      const seenByA = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM nppes_provider WHERE npi='1234567890'"),
      );
      expect(seenByA.rows[0].n).toBe(1);
      const seenByB = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM nppes_provider WHERE npi='1234567890'"),
      );
      expect(seenByB.rows[0].n).toBe(1);
    });

    it("nppes_sync_run is read-all (every tenant sees the platform sync log)", async () => {
      const seenByA = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM nppes_sync_run WHERE kind='daily_incremental'"),
      );
      expect(seenByA.rows[0].n).toBe(1);
      const seenByB = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM nppes_sync_run WHERE kind='daily_incremental'"),
      );
      expect(seenByB.rows[0].n).toBe(1);
    });

    it("chartwarden_app cannot write nppes_provider (writes are chartwarden_admin-only per §1 platform-shared shape)", async () => {
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO nppes_provider (npi, enumeration_type, status, basic)
           VALUES ('9999999999','NPI-1','active','{}'::jsonb)`,
          ),
        ),
      ).rejects.toThrow();
    });

    it("a WITH CHECK refuses an INSERT into another tenant's scope", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO hl7_message_outbound (organization_id, feed_id, message_type, message_control_id,
             payload_cipher, payload_sha256, segments_summary, source_aggregate_kind, source_aggregate_id, idempotency_key)
           VALUES ($1,$2,'ORM^O01','MSG-CROSS','cipher-blob',repeat('a',64),'{}'::jsonb,'m6_admission',gen_random_uuid(),'idem-cross')`,
            [ORG_A, a.feedId], // B tries to write a row scoped to A
          ),
        ),
      ).rejects.toThrow();
    });
  },
);
