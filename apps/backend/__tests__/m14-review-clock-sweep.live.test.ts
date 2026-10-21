/**
 * GAP-042 — M14 `idg.review-clock-sweep` over the REAL M6 active-admission seam, proven against real
 * Postgres as the NOBYPASSRLS `chartwarden_app` role. The §418.56(d) clock is per ACTIVE admission (fallback
 * `activated_at`): an admission with NO idg_patient_packet at all must still escalate. Also proves a stamped
 * review overrides activation, non-active admissions are not swept, the M6 read is keyset-paged, the real
 * catalog-validating publisher accepts the payload, and org A's sweep never touches org B's admissions.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m14:review-clock-sweep:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { idgActiveAdmissionsForOrg } from "../src/modules/06-admission/index";
import type { IdgWriteOutboxPort } from "../src/modules/14-idg/idg-route-service-db";
import {
  M14_OUTBOX_EVENTS,
  buildM14WorkerDeps,
  runReviewClockSweepCron,
} from "../src/modules/14-idg/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
  "chartwarden_platform_live_test",
];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const MEMBER = "33333333-3333-3333-3333-33333333aaaa";

describe.skipIf(!DB_URL)(
  "GAP-042 — M14 review-clock sweep, active-admission population — LIVE",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let outbox: IdgWriteOutboxPort;
    const peOf: Record<string, string> = {};
    const locationOf: Record<string, string> = {};

    async function resetSchema() {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const r of ROLES)
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
        );
    }
    async function applyMigrations() {
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
        await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      }
    }
    async function seedOrg(orgId: string, slug: string) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [orgId, slug],
      );
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [orgId, `CCN-${slug}`, `PE ${slug}`, `NPI-${slug}`],
        )
      ).rows[0].id as string;
      peOf[orgId] = pe;
      locationOf[orgId] = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [pe],
        )
      ).rows[0].id as string;
    }
    async function seedPatient(orgId: string): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
       VALUES ($1,$2,'Jane','Doe','1950-01-01','female','active') RETURNING id`,
        [orgId, `mrn-${randomUUID()}`],
      );
      return rows[0].id as string;
    }
    async function seedAdmission(
      orgId: string,
      patientId: string,
      status: "active" | "discharged",
      activatedDaysAgo: number,
    ): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO admission (organization_id, patient_id, provider_entity_id, location_id, status,
          admission_at, activated_at, discharged_at)
       VALUES ($1,$2,$3,$4,$5::admission_status, now() - ($6 || ' days')::interval, now() - ($6 || ' days')::interval,
               CASE WHEN $7::boolean THEN now() - interval '1 day' ELSE NULL END)
       RETURNING id`,
        [
          orgId,
          patientId,
          peOf[orgId],
          locationOf[orgId],
          status,
          activatedDaysAgo,
          status === "discharged",
        ],
      );
      return rows[0].id as string;
    }
    async function seedReviewedPacket(
      orgId: string,
      patientId: string,
      admissionId: string,
      reviewedDaysAgo: number,
    ) {
      const meeting = (
        await admin.query(
          `INSERT INTO idg_meeting (organization_id, location_id, scheduled_start, scheduled_end, status,
           coordinator_membership_id, tenant_quorum_snapshot)
         VALUES ($1,$2, now() - interval '1 day', now() - interval '22 hours', 'adjourned', $3, '{}'::jsonb)
         RETURNING id`,
          [orgId, locationOf[orgId], MEMBER],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO idg_patient_packet
         (organization_id, provider_entity_id, location_id, idg_meeting_id, patient_id, admission_id,
          since_cursor_iso, built_snapshot, discipline_views, cover_summary_layer1, last_idg_reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,'{}'::jsonb,'seed', now() - ($8 || ' days')::interval)`,
        [
          orgId,
          peOf[orgId],
          locationOf[orgId],
          meeting,
          patientId,
          admissionId,
          new Date(Date.now() - 60 * 86400000).toISOString(),
          reviewedDaysAgo,
        ],
      );
    }
    async function escalationsFor(patientId: string) {
      const { rows } = await admin.query(
        "SELECT organization_id, payload FROM outbox_event WHERE event_type=$1 AND payload->>'patientId'=$2",
        ["m14.review_clock.escalated", patientId],
      );
      return rows as { organization_id: string; payload: Record<string, unknown> }[];
    }
    const sweep = (orgs: string[]) =>
      runReviewClockSweepCron(
        buildM14WorkerDeps({
          connection: {} as never, // the sweep never touches BullMQ
          db: handle.db,
          outbox,
          activeOrgs: {
            listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })),
          },
          activeAdmissions: {
            activeAdmissionsForOrg: (o, after, limit) =>
              idgActiveAdmissionsForOrg(handle.db, o, after, limit),
          },
        }),
      );

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await seedOrg(ORG_A, "org-a");
      await seedOrg(ORG_B, "org-b");
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M14_OUTBOX_EVENTS]));
      outbox = {
        publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m14" }),
      };
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("escalates a 12-day-old never-reviewed admission with NO packet (t_minus_3 off activated_at)", async () => {
      const patientId = await seedPatient(ORG_A);
      const admissionId = await seedAdmission(ORG_A, patientId, "active", 12);
      await sweep([ORG_A]);
      const rows = await escalationsFor(patientId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.organization_id).toBe(ORG_A);
      expect(rows[0]?.payload).toMatchObject({
        admissionId,
        stage: "t_minus_3",
        severity: "clinical_routine",
        lastIdgReviewedAt: null,
      });
    });

    it("a stamped IDG review overrides activation; a non-active admission is not swept", async () => {
      const reviewedPatient = await seedPatient(ORG_A);
      const reviewedAdm = await seedAdmission(ORG_A, reviewedPatient, "active", 15); // activation alone ⇒ t_zero
      await seedReviewedPacket(ORG_A, reviewedPatient, reviewedAdm, 2); // reviewed 2d ago ⇒ floor in 13d
      const dischargedPatient = await seedPatient(ORG_A);
      await seedAdmission(ORG_A, dischargedPatient, "discharged", 15);
      await sweep([ORG_A]);
      expect(await escalationsFor(reviewedPatient)).toHaveLength(0);
      expect(await escalationsFor(dischargedPatient)).toHaveLength(0);
    });

    it("an admission whose last review lapsed 16 days ago escalates t_plus_1 off the stamped review", async () => {
      const patientId = await seedPatient(ORG_A);
      const admissionId = await seedAdmission(ORG_A, patientId, "active", 90);
      await seedReviewedPacket(ORG_A, patientId, admissionId, 16);
      await sweep([ORG_A]);
      const rows = await escalationsFor(patientId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toMatchObject({ stage: "t_plus_1", severity: "critical" });
    });

    it("cross-tenant: sweeping org A never reads or escalates org B's admissions", async () => {
      const patientB = await seedPatient(ORG_B);
      await seedAdmission(ORG_B, patientB, "active", 12);
      await sweep([ORG_A]);
      expect(await escalationsFor(patientB)).toHaveLength(0);
      await sweep([ORG_B]);
      const rows = await escalationsFor(patientB);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.organization_id).toBe(ORG_B);
      // the M6 seam under org A's tenancy never returns org B's rows
      const seenByA = await idgActiveAdmissionsForOrg(handle.db, ORG_A, null, 1000);
      expect(seenByA.some((a) => a.patientId === patientB)).toBe(false);
    });

    it("the M6 active-admission read is keyset-paged (no row skipped or repeated across pages)", async () => {
      const all = await idgActiveAdmissionsForOrg(handle.db, ORG_A, null, 1000);
      expect(all.length).toBeGreaterThanOrEqual(3);
      const paged: string[] = [];
      let after: string | null = null;
      for (;;) {
        const page = await idgActiveAdmissionsForOrg(handle.db, ORG_A, after, 2);
        paged.push(...page.map((a) => a.admissionId));
        if (page.length < 2) break;
        after = page[page.length - 1]?.admissionId ?? null;
      }
      expect(paged).toEqual(all.map((a) => a.admissionId));
    });
  },
);
