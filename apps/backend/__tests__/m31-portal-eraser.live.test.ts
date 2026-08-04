/**
 * M31 portal destruction eraser — the LIVE Postgres proof (§3.7 / D15, M31-T06 boot wiring).
 *
 * The pure `erasePortalRecord` core is unit-tested with the in-memory slice store; this proves the REAL
 * Drizzle store (`buildDrizzlePortalEraseStore`) performs the destructive dispositions over the three
 * M31-owned tables under RLS, exactly as the composition-root `registerPortalErasers` wires it:
 *   • active telehealth visits → `ended_aborted` with their vendor-room recording ciphers shredded,
 *   • the patient's active grants revoked with `revoke_cascade_source='destruction'`,
 *   • an account left with no active grant to ANY patient flipped to `revoked`, contact ciphers shredded,
 *   • an account that STILL has an active grant to another patient LEFT ACTIVE (the orphan test).
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m31-portal-eraser.live.test.ts
 * (SUPERUSER to a THROWAWAY db; for a local PG without pgvector set WARDENX_TEST_NO_PGVECTOR=1.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@wardenx/db";
import type { PatientId } from "@wardenx/types";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDrizzlePortalEraseStore, erasePortalRecord } from "../src/modules/31-portal/eraser";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const USER_1 = "22222222-2222-2222-2222-222222222221";
const USER_2 = "22222222-2222-2222-2222-222222222222";
const MEMBER = "33333333-3333-3333-3333-333333333333";
const CONSENT = "44444444-4444-4444-4444-444444444444";
const PATIENT = "55555555-5555-5555-5555-555555555555" as PatientId; // the destroyed subject
const OTHER_PATIENT = "55555555-5555-5555-5555-555555555556" as PatientId; // keeps USER_2's account alive

describe.skipIf(!DB_URL)("M31 portal destruction eraser — LIVE Postgres (§3.7/D15)", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let providerEntity: string;
  let location: string;
  let acctSingle: string; // USER_1 — only a grant to PATIENT → orphaned by the erase
  let acctShared: string; // USER_2 — grants to PATIENT and OTHER_PATIENT → survives

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

  async function seedAccount(userId: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO portal_account (organization_id, user_id, relationship, status, display_name_cipher, email_cipher)
         VALUES ($1,$2,'family_caregiver','active','enc-name','enc-email') RETURNING id`,
        [ORG, userId],
      )
    ).rows[0].id as string;
  }
  async function seedGrant(accountId: string, patientId: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO portal_access_grant (organization_id, provider_entity_id, location_id, portal_account_id,
           patient_id, grant_kind, scope_set_jsonb, source_consent_record_id, source_consent_version,
           granted_by_membership_id, revoke_reason_cipher)
         VALUES ($1,$2,$3,$4,$5,'family_caregiver','{}'::jsonb,$6,'v1',$7,'enc-reason') RETURNING id`,
        [ORG, providerEntity, location, accountId, patientId, CONSENT, MEMBER],
      )
    ).rows[0].id as string;
  }
  async function seedVisit(patientId: string, state: string): Promise<string> {
    const endReason = ["ended_clean", "ended_aborted"].includes(state) ? "provider_ended" : null;
    return (
      await admin.query(
        `INSERT INTO telehealth_visit (organization_id, provider_entity_id, location_id, m17_visit_id,
           patient_id, assigned_membership_id, lifecycle_state, vendor, vendor_room_id_cipher,
           vendor_room_url_cipher, scheduled_visit_setting, recording_enabled, end_reason)
         VALUES ($1,$2,$3,gen_random_uuid(),$4,$5,$6,'daily_co','enc-room','enc-url','patient_home',true,$7)
         RETURNING id`,
        [ORG, providerEntity, location, patientId, MEMBER, state, endReason],
      )
    ).rows[0].id as string;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'u1@x.test'),($2,'u2@x.test')`, [
      USER_1,
      USER_2,
    ]);
    providerEntity = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-M31','M31 Provider','NPI-M31','enc','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity],
      )
    ).rows[0].id as string;

    acctSingle = await seedAccount(USER_1);
    acctShared = await seedAccount(USER_2);
    await seedGrant(acctSingle, PATIENT); // USER_1 → PATIENT only
    await seedGrant(acctShared, PATIENT); // USER_2 → PATIENT
    await seedGrant(acctShared, OTHER_PATIENT); // USER_2 → OTHER_PATIENT (keeps the account alive)
    await seedVisit(PATIENT, "in_progress"); // active → must be aborted
    await seedVisit(PATIENT, "ended_clean"); // already ended → ref still shredded

    await admin.query("ALTER ROLE wardenx_app LOGIN");
    handle = createDbClient({
      connectionString: (DB_URL as string).replace("://postgres@", "://wardenx_app@"),
    });

    // Run the REAL eraser exactly as registerPortalErasers wires it.
    await erasePortalRecord(ORG, PATIENT, "", buildDrizzlePortalEraseStore(handle.db));
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("aborts the active telehealth visit and leaves no active visit for the patient", async () => {
    const r = await admin.query(
      "SELECT count(*)::int AS n FROM telehealth_visit WHERE patient_id=$1 AND lifecycle_state NOT IN ('ended_clean','ended_aborted','reconciled')",
      [PATIENT],
    );
    expect(r.rows[0].n).toBe(0);
    const aborted = await admin.query(
      "SELECT count(*)::int AS n FROM telehealth_visit WHERE patient_id=$1 AND lifecycle_state='ended_aborted' AND end_reason='destruction'",
      [PATIENT],
    );
    expect(aborted.rows[0].n).toBe(1);
  });

  it("shreds the vendor-room recording ciphers on every one of the patient's visits", async () => {
    const r = await admin.query(
      "SELECT count(*)::int AS n FROM telehealth_visit WHERE patient_id=$1 AND (vendor_room_id_cipher <> '' OR vendor_room_url_cipher <> '')",
      [PATIENT],
    );
    expect(r.rows[0].n).toBe(0); // both visits (active + already-ended) shredded
  });

  it("revokes the patient's grants with revoke_cascade_source='destruction' and shreds the reason cipher", async () => {
    const r = await admin.query(
      "SELECT count(*)::int AS n FROM portal_access_grant WHERE patient_id=$1 AND revoked_at IS NULL",
      [PATIENT],
    );
    expect(r.rows[0].n).toBe(0);
    const src = await admin.query(
      "SELECT count(*)::int AS n FROM portal_access_grant WHERE patient_id=$1 AND revoke_cascade_source='destruction' AND revoke_reason_cipher IS NULL",
      [PATIENT],
    );
    expect(src.rows[0].n).toBe(2); // both accounts' grants to PATIENT
  });

  it("flips the ORPHANED account (no remaining active grant) to revoked with contact ciphers shredded", async () => {
    const r = await admin.query(
      "SELECT status, display_name_cipher, email_cipher FROM portal_account WHERE id=$1",
      [acctSingle],
    );
    expect(r.rows[0].status).toBe("revoked");
    expect(r.rows[0].display_name_cipher).toBe("");
    expect(r.rows[0].email_cipher).toBe("");
  });

  it("LEAVES the account that still has an active grant to another patient (no over-revocation)", async () => {
    const r = await admin.query("SELECT status FROM portal_account WHERE id=$1", [acctShared]);
    expect(r.rows[0].status).toBe("active");
    const alive = await admin.query(
      "SELECT count(*)::int AS n FROM portal_access_grant WHERE portal_account_id=$1 AND revoked_at IS NULL",
      [acctShared],
    );
    expect(alive.rows[0].n).toBe(1); // the OTHER_PATIENT grant survives
  });
});
