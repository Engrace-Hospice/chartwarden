/**
 * F-216 (#248) — LIVE Postgres proof of M39's §4.9 hourly `consent-expiration` / `expiration-reminder` crons
 * and the end-to-end they exist for: `m39.consent.expired` -> M5's persisted `patient_privacy_flag_snapshot`.
 *
 * Until F-216 NOTHING produced `m39.consent.expired` / `.expiring_soon` (`M39_QUEUES` / `shouldExpire` had no
 * caller under apps/backend), so a lapsed `42_cfr_part_2_release` consent stayed `active` forever and M5's
 * `sud` flag (which `privacy-flag-reader.ts` / `admission-clearance-reader.ts` read from the SNAPSHOT) stayed
 * lifted. This drives the REAL cron bodies -> the REAL catalog-validating transactional publisher -> the REAL
 * `createOutboxDispatcher` -> M5's real consumer, all as the NOBYPASSRLS `wardenx_app` role.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m39:consent-expiration:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M5_OUTBOX_EVENTS } from "../src/modules/05-patient/events-by-m5";
import { buildM5ConsentPrivacyConsumer } from "../src/modules/05-patient/outbox-consumers/m39-consent-privacy";
import {
  type M39CronDeps,
  M39_CRON_BOUNDS,
  M39_OUTBOX_EVENTS,
  runConsentExpirationCron,
  runConsentExpirationForOrg,
  runExpirationReminderForOrg,
} from "../src/modules/39-consent/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PART2 = "42_cfr_part_2_release";
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!DB_URL)(
  "F-216 — M39 consent expiration/reminder crons + M5 snapshot — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let deps: M39CronDeps;
    let dispatcher: ReturnType<typeof createOutboxDispatcher>;

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
      const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
        let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        if (strip) {
          sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
          sql = sql.replace(/\bvector\(\d+\)/g, "text");
          sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
        }
        await admin.query(sql);
      }
    }

    async function seedPatient(org: string): Promise<string> {
      const r = await admin.query(
        `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth)
       VALUES ($1, $2, 'Test', 'Patient', '1950-01-01', 'female') RETURNING id`,
        [org, `MRN-${randomUUID().slice(0, 8)}`],
      );
      return r.rows[0].id as string;
    }
    async function seedSnapshot(org: string, patientId: string, flags: string[]) {
      await admin.query(
        `INSERT INTO patient_privacy_flag_snapshot (patient_id, organization_id, flags, captured_at)
       VALUES ($1,$2,$3,now())`,
        [patientId, org, flags],
      );
    }
    async function snapshotFlags(patientId: string): Promise<string[] | null> {
      const { rows } = await admin.query(
        "SELECT flags FROM patient_privacy_flag_snapshot WHERE patient_id=$1",
        [patientId],
      );
      return rows[0] ? (rows[0].flags as string[]) : null;
    }

    /** Seed one consent_record as the superuser. `expiresInMs` relative to now (negative = lapsed). */
    async function seedConsent(
      org: string,
      patientId: string,
      opts: {
        typeKey?: string;
        status?: "active" | "revoked" | "superseded" | "expired";
        expiresInMs: number | null;
        supersededBy?: string;
      },
    ): Promise<string> {
      const status = opts.status ?? "active";
      const id = randomUUID();
      await admin.query(
        `INSERT INTO consent_record
         (id, organization_id, patient_id, type_key, scope_descriptor, grantor_kind, effective_at, expires_at,
          status, capture_method, capture_evidence_jsonb, created_by_id, signed_at, signed_by_id,
          revoked_at, revoked_via_id, superseded_at, superseded_by_consent_record_id)
       VALUES ($1,$2,$3,$4,'{}'::jsonb,'patient_self', now() - interval '400 days',
               CASE WHEN $5::bigint IS NULL THEN NULL ELSE now() + ($5::bigint * interval '1 millisecond') END,
               $6::consent_status,'typed_signature_in_app','{}'::jsonb,$7, now() - interval '400 days', $7,
               CASE WHEN $9::text='revoked' THEN now() - interval '5 days' END,
               CASE WHEN $9::text='revoked' THEN gen_random_uuid() END,
               CASE WHEN $9::text='superseded' THEN now() - interval '5 days' END,
               $8)`,
        [
          id,
          org,
          patientId,
          opts.typeKey ?? PART2,
          opts.expiresInMs,
          status,
          USER,
          opts.supersededBy ?? null,
          status,
        ],
      );
      return id;
    }
    async function statusOf(id: string): Promise<string> {
      return (await admin.query("SELECT status FROM consent_record WHERE id=$1", [id])).rows[0]
        .status;
    }
    async function events(type: string, org?: string) {
      const { rows } = await admin.query(
        `SELECT organization_id, aggregate_id, payload, status FROM outbox_event
       WHERE event_type=$1 ${org ? "AND organization_id=$2" : ""} ORDER BY created_at, id`,
        org ? [type, org] : [type],
      );
      return rows as {
        organization_id: string;
        aggregate_id: string;
        payload: Record<string, unknown>;
        status: string;
      }[];
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name)
       VALUES ($1,'f216-a','F216 A','F216 A'), ($2,'f216-b','F216 B','F216 B')`,
        [ORG_A, ORG_B],
      );
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f216@x.test')`, [USER]);
      await admin.query(
        `INSERT INTO consent_type_catalog (type_key, display_name_en, scope_discriminator,
         default_expiration_seconds, max_term_seconds, capture_method_floor,
         reminder_cadence_floor, revocation_cascade_kind, is_per_recipient, is_per_named_agent,
         is_post_mortem_eligible, requires_jurisdiction_code, cfr_42_part_2_compliant,
         hipaa_164_508_compliant, body_text_template_key, m22_template_version)
       VALUES
         ('portal_access','Portal Access','categorical',86400,86400,
          ARRAY['electronic_portal_signature']::text[],ARRAY['1_day']::text[],'portal_access',
          false,false,false,false,false,true,'consent_record','v1'),
         ('42_cfr_part_2_release','Part 2 Release','per_recipient',31536000,31536000,
          ARRAY['typed_signature_in_app']::text[],ARRAY['30_days']::text[],'part_2',
          true,false,true,false,true,true,'consent_record','v1')`,
      );
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      // The REAL catalog-validating publisher over the M39 + M5 catalogs.
      const catalog = buildBootOutboxCatalog([M39_OUTBOX_EVENTS, M5_OUTBOX_EVENTS]);
      const publisher = buildTxOutboxPublisher(catalog);
      deps = {
        db: handle.db,
        outbox: {
          publish: (tx, input) =>
            publisher.publish(tx as never, { ...input, callerModule: "m39" } as never),
        },
      };
      const m5Outbox = {
        publish: (tx: unknown, input: object) =>
          publisher.publish(tx as never, { ...input, callerModule: "m5" } as never),
      };
      const orgs: ActiveOrgEnumerator = {
        listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
      };
      dispatcher = createOutboxDispatcher({
        db: handle.db,
        orgs,
        consumers: [buildM5ConsentPrivacyConsumer({ db: handle.db, outbox: m5Outbox as never })],
        eventCatalog: catalog,
        options: { log: () => {} },
      });
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    beforeEach(async () => {
      await admin.query("DELETE FROM outbox_event");
      await admin.query("DELETE FROM consent_expiration_reminder");
      await admin.query("TRUNCATE patient_privacy_flag_snapshot, patient RESTART IDENTITY CASCADE");
      await admin.query("ALTER TABLE consent_record DISABLE TRIGGER USER");
      await admin.query("DELETE FROM consent_record");
      await admin.query("ALTER TABLE consent_record ENABLE TRIGGER USER");
    });

    it("flips a lapsed Part-2 consent and M5's snapshot re-restricts sud within one dispatcher cycle", async () => {
      const patientId = await seedPatient(ORG_A);
      await seedSnapshot(ORG_A, patientId, []); // the consent lifted the sud restriction
      const consentId = await seedConsent(ORG_A, patientId, { expiresInMs: -2 * 3600_000 });

      const summary = await runConsentExpirationForOrg(deps as never, ORG_A);
      expect(summary).toEqual({ expired: 1, backlogRemaining: false });
      expect(await statusOf(consentId)).toBe("expired");

      // The event committed in the SAME tx as the flip, with the catalogued payload.
      const expired = await events("m39.consent.expired");
      expect(expired).toHaveLength(1);
      expect(expired[0]?.organization_id).toBe(ORG_A);
      expect(expired[0]?.payload).toMatchObject({
        organizationId: ORG_A,
        patientId,
        consentRecordId: consentId,
        typeKey: PART2,
      });
      expect(expired[0]?.payload).not.toHaveProperty("remainingActiveConsentRecordId");

      // Until the dispatcher runs, M5's persisted snapshot is still lifted (the pre-F-216 defect, frozen here).
      expect(await snapshotFlags(patientId)).toEqual([]);
      const tick = await dispatcher.tick();
      expect(tick.delivered).toBeGreaterThanOrEqual(1);
      expect(await snapshotFlags(patientId)).toEqual(["sud"]);
      expect((await events("m39.consent.expired"))[0]?.status).toBe("dispatched");
    });

    it("is idempotent: a second run emits nothing and never re-expires", async () => {
      const patientId = await seedPatient(ORG_A);
      await seedConsent(ORG_A, patientId, { expiresInMs: -1000 });
      expect((await runConsentExpirationForOrg(deps as never, ORG_A)).expired).toBe(1);
      expect(await runConsentExpirationForOrg(deps as never, ORG_A)).toEqual({
        expired: 0,
        backlogRemaining: false,
      });
      expect(await events("m39.consent.expired")).toHaveLength(1);
    });

    it("leaves revoked / superseded / already-expired / future / indefinite rows untouched and silent", async () => {
      const patientId = await seedPatient(ORG_A);
      const live = await seedConsent(ORG_A, patientId, { expiresInMs: 30 * DAY });
      const indefinite = await seedConsent(ORG_A, patientId, { expiresInMs: null });
      const revoked = await seedConsent(ORG_A, patientId, { status: "revoked", expiresInMs: -DAY });
      const already = await seedConsent(ORG_A, patientId, { status: "expired", expiresInMs: -DAY });
      const successor = await seedConsent(ORG_A, patientId, { expiresInMs: 200 * DAY });
      const superseded = await seedConsent(ORG_A, patientId, {
        status: "superseded",
        expiresInMs: -DAY,
        supersededBy: successor,
      });

      expect(await runConsentExpirationForOrg(deps as never, ORG_A)).toEqual({
        expired: 0,
        backlogRemaining: false,
      });
      expect(await statusOf(live)).toBe("active");
      expect(await statusOf(indefinite)).toBe("active");
      expect(await statusOf(revoked)).toBe("revoked");
      expect(await statusOf(already)).toBe("expired");
      expect(await statusOf(superseded)).toBe("superseded");
      expect(await statusOf(successor)).toBe("active");
      expect(await events("m39.consent.expired")).toHaveLength(0);
    });

    it("cross-tenant: org A's job never touches org B, and the fan-out expires each org's own", async () => {
      const pa = await seedPatient(ORG_A);
      const pb = await seedPatient(ORG_B);
      const a = await seedConsent(ORG_A, pa, { expiresInMs: -1000 });
      const b = await seedConsent(ORG_B, pb, { expiresInMs: -1000 });

      expect((await runConsentExpirationForOrg(deps as never, ORG_A)).expired).toBe(1);
      expect(await statusOf(a)).toBe("expired");
      expect(await statusOf(b)).toBe("active"); // B untouched by A's job
      expect(await events("m39.consent.expired", ORG_B)).toHaveLength(0);

      const all = await runConsentExpirationCron({
        ...deps,
        activeOrgs: {
          listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
        },
      });
      expect(all.get(ORG_A)?.expired).toBe(0);
      expect(all.get(ORG_B)?.expired).toBe(1);
      expect(await statusOf(b)).toBe("expired");
      expect((await events("m39.consent.expired", ORG_B)).map((e) => e.aggregate_id)).toEqual([b]);
      expect((await events("m39.consent.expired", ORG_A)).map((e) => e.aggregate_id)).toEqual([a]);
    });

    it("renewal-safe: a lapsed consent whose renewal is still active does NOT re-restrict sud", async () => {
      const patientId = await seedPatient(ORG_A);
      await seedSnapshot(ORG_A, patientId, []);
      const renewal = await seedConsent(ORG_A, patientId, { expiresInMs: 300 * DAY });
      const old = await seedConsent(ORG_A, patientId, { expiresInMs: -1000 });

      expect((await runConsentExpirationForOrg(deps as never, ORG_A)).expired).toBe(1);
      expect(await statusOf(old)).toBe("expired");
      expect(await statusOf(renewal)).toBe("active");
      const [ev] = await events("m39.consent.expired");
      expect(ev?.payload).toMatchObject({
        consentRecordId: old,
        remainingActiveConsentRecordId: renewal,
      });

      await dispatcher.tick();
      expect(await snapshotFlags(patientId)).toEqual([]); // still lifted — a live consent remains
    });

    it("a non-Part-2 consent type expiring drives no M5 flag change", async () => {
      const patientId = await seedPatient(ORG_A);
      await seedSnapshot(ORG_A, patientId, []);
      await seedConsent(ORG_A, patientId, { typeKey: "portal_access", expiresInMs: -1000 });
      await runConsentExpirationForOrg(deps as never, ORG_A);
      await dispatcher.tick();
      expect(await snapshotFlags(patientId)).toEqual([]);
    });

    it("bounds a first-run backlog: at most pageSize*maxPages flip per org per run, the rest drain next run", async () => {
      const cap = M39_CRON_BOUNDS.pageSize * M39_CRON_BOUNDS.maxPagesPerOrg;
      await admin.query(
        `INSERT INTO consent_record
         (organization_id, patient_id, type_key, scope_descriptor, grantor_kind, effective_at, expires_at,
          status, capture_method, capture_evidence_jsonb, created_by_id, signed_at, signed_by_id)
       SELECT $1, gen_random_uuid(), 'portal_access', '{}'::jsonb, 'patient_self',
              now() - interval '400 days', now() - interval '1 day' - (g * interval '1 second'),
              'active','electronic_portal_signature','{}'::jsonb,$2, now() - interval '400 days',$2
       FROM generate_series(1, $3::int) g`,
        [ORG_A, USER, cap + 5],
      );
      const first = await runConsentExpirationForOrg(deps as never, ORG_A);
      expect(first).toEqual({ expired: cap, backlogRemaining: true });
      expect(await events("m39.consent.expired")).toHaveLength(cap);
      const second = await runConsentExpirationForOrg(deps as never, ORG_A);
      expect(second).toEqual({ expired: 5, backlogRemaining: false });
      expect(await events("m39.consent.expired")).toHaveLength(cap + 5);
    }, 180_000);

    it("emits the expiring_soon reminder once per (consent, window), honoring the type's cadence floor", async () => {
      const patientId = await seedPatient(ORG_A);
      const due = await seedConsent(ORG_A, patientId, { expiresInMs: 20 * DAY }); // Part 2 floor = [30_days]
      await seedConsent(ORG_A, patientId, { typeKey: "portal_access", expiresInMs: 20 * DAY }); // floor = [1_day]
      await seedConsent(ORG_A, patientId, { expiresInMs: 120 * DAY }); // outside the 90d look-ahead
      const pb = await seedPatient(ORG_B);
      await seedConsent(ORG_B, pb, { expiresInMs: 20 * DAY });

      const first = await runExpirationReminderForOrg(deps as never, ORG_A);
      expect(first.reminded).toBe(1);
      const soon = await events("m39.consent.expiring_soon");
      expect(soon).toHaveLength(1); // org B's consent is not reminded by org A's job
      expect(soon[0]?.payload).toMatchObject({
        organizationId: ORG_A,
        patientId,
        consentRecordId: due,
        typeKey: PART2,
        reminderKind: "30_days",
      });
      const rows = await admin.query(
        "SELECT reminder_kind, fired_at, idempotency_key FROM consent_expiration_reminder",
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].fired_at).not.toBeNull();

      // A retry / the next hourly tick emits nothing new.
      expect((await runExpirationReminderForOrg(deps as never, ORG_A)).reminded).toBe(0);
      expect(await events("m39.consent.expiring_soon")).toHaveLength(1);
      // 19.5 days on: the Part-2 consent (floor [30_days]) has nothing new to fire (30_days already fired),
      // while the portal_access consent (floor [1_day]) has just entered its 1-day window.
      const later = await runExpirationReminderForOrg(
        { ...deps, now: () => new Date(Date.now() + 19.5 * DAY) },
        ORG_A,
      );
      expect(later.reminded).toBe(1);
      const kinds = (await events("m39.consent.expiring_soon")).map((e) => e.payload.reminderKind);
      expect(kinds.sort()).toEqual(["1_day", "30_days"]);
    });
  },
);
