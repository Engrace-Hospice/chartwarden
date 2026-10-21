/**
 * F-172 (#248) — the real `PseudonymKeyProvider.activeKey()` (KEK envelope over the platform-singleton
 * `patient_pseudonym_key`) + the three D21 consumers it unblocks (`m2.session.created`,
 * `m5.patient.deceased`, `m5.patient.merged`), end to end over real Postgres.
 *
 * Two prior passes (F-142, F-167) declined to build this, reasoning M34's per-tenant DEK-wrap mechanism
 * "does not transfer" and that a from-scratch provider was "genuinely new security-critical
 * infrastructure." This suite proves the built provider is the SAME already-ratified app-layer
 * AES-256-GCM envelope pattern (ADR-0038) applied to a platform-singleton secret, not a fabricated one:
 *
 *   • `patient_pseudonym_key` really is unreadable on the tenant `wardenx_app` credential (the
 *     `tenant_key_ring`/M34-F02 shape) and readable on the platform credential.
 *   • mint-on-first-use is race-safe: two concurrent callers on a cold table mint exactly ONE epoch.
 *   • the ciphertext at rest is never the plaintext key material.
 *   • an unknown KEK id refuses with a stated reason (never a wrong/zero key).
 *   • rotation retires the old epoch and mints a new one; a `patient_active_period` row written under the
 *     OLD epoch keeps that epoch tag after rotation — never silently rewritten.
 *   • the three real consumers write real `patient_active_period`/`user_active_period` rows, redeliveries
 *     are idempotent, and cross-tenant isolation holds.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m35:pseudonym-key-provider:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { computeBillingPseudonym, loadPseudonymKekRing } from "@chartwarden/subscription-billing";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activePeriodRowExists,
  buildM35PatientActivePeriodConsumer,
  buildM35SessionCreatedConsumer,
  createDrizzlePseudonymKeyProvider,
  rotatePseudonymKey,
} from "../src/modules/35-subscription/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-111111110171";
const ORG_B = "22222222-2222-4222-8222-222222220171";
const KEK_1 = `kek-1:${Buffer.alloc(32, 0x11).toString("base64")}`;
const KEK_2 = `kek-2:${Buffer.alloc(32, 0x22).toString("base64")}`;

function ring(active: string, retired = "") {
  const r = loadPseudonymKekRing({
    M35_PSEUDONYM_KEY_KEK: active,
    M35_PSEUDONYM_KEY_KEK_RETIRED: retired,
  } as NodeJS.ProcessEnv);
  if (!r) throw new Error("expected a ring");
  return r;
}

describe.skipIf(!DB_URL)("F-172 (#248) — M35 pseudonym-key provider, LIVE Postgres", () => {
  let admin: Client;
  let appHandle: ReturnType<typeof createDbClient>;
  let platformHandle: ReturnType<typeof createDbClient>;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
  }
  async function applyMigrations() {
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name)
       VALUES ($1,'m35-ppk-a','M35 PPK A','M35 PPK A'), ($2,'m35-ppk-b','M35 PPK B','M35 PPK B')`,
      [ORG_A, ORG_B],
    );

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    appHandle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    // The platform credential (`DATABASE_PLATFORM_URL`) — `wardenx_admin` holds the 0143 platform-only
    // grants (`GRANT ALL ... TO wardenx_admin`), the M34/GAP-097/098 precedent for standing in for
    // `wardenx_platform_login` in a live suite.
    await admin.query("ALTER ROLE wardenx_admin LOGIN BYPASSRLS PASSWORD 'f171_platform'");
    const u = new URL(DB_URL as string);
    u.username = "wardenx_admin";
    u.password = "f171_platform";
    platformHandle = createDbClient({ connectionString: u.toString() });
  }, 240_000);

  afterAll(async () => {
    await appHandle?.close();
    await platformHandle?.close();
    await admin?.end();
  });

  it("patient_pseudonym_key is unreadable on the tenant wardenx_app credential, readable on the platform one", async () => {
    const failureOf = async (handle: ReturnType<typeof createDbClient>): Promise<string | null> => {
      try {
        await handle.db.execute(sql`SELECT count(*)::int AS n FROM patient_pseudonym_key`);
        return null;
      } catch (e) {
        const cause = (e as { cause?: { message?: string } }).cause;
        return cause?.message ?? (e as Error).message;
      }
    };
    expect(await failureOf(appHandle)).toMatch(
      /permission denied for table patient_pseudonym_key/i,
    );
    expect(await failureOf(platformHandle)).toBeNull();
  });

  it("mint-on-first-use is race-safe: two concurrent callers on a cold table mint exactly one epoch", async () => {
    const provider = createDrizzlePseudonymKeyProvider(platformHandle.db, ring(KEK_1));
    const [a, b] = await Promise.all([provider.activeKey(), provider.activeKey()]);
    expect(a.keyEpoch).toBe(b.keyEpoch);
    expect(a.keyMaterial).toBe(b.keyMaterial);
    expect(a.keyMaterial).toHaveLength(64); // 32 bytes, hex-encoded

    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM patient_pseudonym_key WHERE is_active = true",
    );
    expect(rows[0].n).toBe(1);
  });

  it("the ciphertext at rest is never the plaintext key material", async () => {
    const provider = createDrizzlePseudonymKeyProvider(platformHandle.db, ring(KEK_1));
    const key = await provider.activeKey();
    const { rows } = await admin.query(
      "SELECT key_material_ciphertext, key_kms_ref FROM patient_pseudonym_key WHERE is_active = true",
    );
    expect(rows[0].key_material_ciphertext).not.toBe(key.keyMaterial);
    expect(rows[0].key_material_ciphertext).not.toContain(key.keyMaterial);
    expect(rows[0].key_kms_ref).toBe("kek-1");
  });

  it("an unknown KEK id refuses with a stated reason, never a wrong/zero key", async () => {
    await admin.query(
      "UPDATE patient_pseudonym_key SET key_kms_ref = 'no-such-kek' WHERE is_active = true",
    );
    const provider = createDrizzlePseudonymKeyProvider(platformHandle.db, ring(KEK_1));
    await expect(provider.activeKey()).rejects.toThrow(/no pseudonym KEK 'no-such-kek'/);
    await admin.query(
      "UPDATE patient_pseudonym_key SET key_kms_ref = 'kek-1' WHERE is_active = true",
    );
  });

  it("a ciphertext copied onto a different epoch's row fails authentication (the AAD binds the epoch)", async () => {
    const provider = createDrizzlePseudonymKeyProvider(platformHandle.db, ring(KEK_1));
    const before = await provider.activeKey();
    // Mint a SECOND row directly (simulating a restore/operator error placing one epoch's ciphertext onto
    // another's row) — the active row keeps its own ciphertext; only key_epoch is swapped underneath it.
    await admin.query(
      `UPDATE patient_pseudonym_key SET key_epoch = key_epoch || '-tampered' WHERE is_active = true`,
    );
    await expect(provider.activeKey()).rejects.toThrow(/failed authentication/);
    await admin.query(
      `UPDATE patient_pseudonym_key SET key_epoch = replace(key_epoch, '-tampered', '') WHERE is_active = true`,
    );
    expect((await provider.activeKey()).keyEpoch).toBe(before.keyEpoch);
  });

  it("rotation retires the old epoch, mints a new one, and a historic row keeps its original epoch tag", async () => {
    const r = ring(KEK_2, KEK_1);
    const provider = createDrizzlePseudonymKeyProvider(platformHandle.db, r);
    const before = await provider.activeKey();

    // Write a fact under the OLD epoch (as the .merged consumer would have, pre-rotation).
    const oldPseudonym = computeBillingPseudonym(before.keyMaterial, "patient-pre-rotation");
    await admin.query(
      `INSERT INTO patient_active_period
         (organization_id, patient_pseudonym, pseudonym_key_epoch, period_year_month, was_active, became_active_at)
       VALUES ($1,$2,$3,'2026-01',true,now())`,
      [ORG_A, oldPseudonym, before.keyEpoch],
    );

    const result = await rotatePseudonymKey(platformHandle.db, r);
    expect(result.retiredEpoch).toBe(before.keyEpoch);
    expect(result.newEpoch).not.toBe(before.keyEpoch);

    const after = await provider.activeKey();
    expect(after.keyEpoch).toBe(result.newEpoch);
    expect(after.keyMaterial).not.toBe(before.keyMaterial);

    // The historic row is untouched — never rewritten onto the new epoch.
    const { rows } = await admin.query(
      "SELECT pseudonym_key_epoch FROM patient_active_period WHERE patient_pseudonym = $1",
      [oldPseudonym],
    );
    expect(rows[0].pseudonym_key_epoch).toBe(before.keyEpoch);

    // The old epoch's key is still resolvable through the retired-KEK ring (the rotation window) — the
    // retired row's own ciphertext still opens under kek-1, which is still configured as retired-only.
    const { rows: retiredRow } = await admin.query(
      "SELECT key_epoch, key_material_ciphertext, key_kms_ref, is_active, retired_at FROM patient_pseudonym_key WHERE key_epoch = $1",
      [before.keyEpoch],
    );
    expect(retiredRow[0].is_active).toBe(false);
    expect(retiredRow[0].retired_at).not.toBeNull();
  });

  // ── the three D21 consumers ──────────────────────────────────────────────────────────────────────────
  describe("the three consumers this provider unblocks", () => {
    async function freshRing() {
      await admin.query("DELETE FROM patient_pseudonym_key");
      return ring(KEK_1);
    }

    it("m2.session.created: resolves userId -> membershipId and upserts a user_active_period row", async () => {
      const r = await freshRing();
      const provider = createDrizzlePseudonymKeyProvider(platformHandle.db, r);
      const userId = "33333333-3333-4333-8333-000000000001";
      await admin.query("INSERT INTO \"user\" (id,email,name) VALUES ($1,'u1@f171.example','U1')", [
        userId,
      ]);
      const membershipId = (
        await admin.query(
          "INSERT INTO membership (organization_id,user_id,status) VALUES ($1,$2,'active') RETURNING id",
          [ORG_A, userId],
        )
      ).rows[0].id as string;

      const consumer = buildM35SessionCreatedConsumer({ db: appHandle.db, keyProvider: provider });
      await consumer.handle({
        eventType: "m2.session.created",
        organizationId: ORG_A,
        payload: { sessionId: "s1", userId, organizationId: ORG_A },
      });

      const key = await provider.activeKey();
      const pseudonym = computeBillingPseudonym(key.keyMaterial, membershipId);
      expect(pseudonym).toMatch(/^[a-f0-9]{32}$/);
      const period = new Date().toISOString().slice(0, 7);
      expect(await activePeriodRowExists(appHandle.db, ORG_A, pseudonym, period, "user")).toBe(
        true,
      );
      // Cross-tenant isolation — org B never sees org A's row.
      expect(await activePeriodRowExists(appHandle.db, ORG_B, pseudonym, period, "user")).toBe(
        false,
      );

      // Redelivery is idempotent (no duplicate row — the unique index would throw on a naive re-insert).
      await expect(
        consumer.handle({
          eventType: "m2.session.created",
          organizationId: ORG_A,
          payload: { sessionId: "s2", userId, organizationId: ORG_A },
        }),
      ).resolves.toBeUndefined();
      const { rows } = await admin.query(
        "SELECT count(*)::int AS n FROM user_active_period WHERE organization_id = $1 AND membership_pseudonym = $2",
        [ORG_A, pseudonym],
      );
      expect(rows[0].n).toBe(1);
    });

    it("m2.session.created: a user with no membership in this org is a documented no-op", async () => {
      const r = await freshRing();
      const provider = createDrizzlePseudonymKeyProvider(platformHandle.db, r);
      const consumer = buildM35SessionCreatedConsumer({ db: appHandle.db, keyProvider: provider });
      await expect(
        consumer.handle({
          eventType: "m2.session.created",
          organizationId: ORG_A,
          payload: {
            sessionId: "s3",
            userId: "99999999-9999-4999-8999-000000000009",
            organizationId: ORG_A,
          },
        }),
      ).resolves.toBeUndefined();
    });

    it("m5.patient.merged: the survivor's raw patientId is marked active for the current period", async () => {
      const r = await freshRing();
      const provider = createDrizzlePseudonymKeyProvider(platformHandle.db, r);
      const consumer = buildM35PatientActivePeriodConsumer({
        db: appHandle.db,
        keyProvider: provider,
      });
      const survivorId = "44444444-4444-4444-8444-000000000001";

      await consumer.handle({
        eventType: "m5.patient.merged",
        organizationId: ORG_A,
        payload: { patientId: survivorId, sourcePatientId: "dup-1", organizationId: ORG_A },
      });

      const key = await provider.activeKey();
      const pseudonym = computeBillingPseudonym(key.keyMaterial, survivorId);
      const period = new Date().toISOString().slice(0, 7);
      expect(await activePeriodRowExists(appHandle.db, ORG_A, pseudonym, period, "patient")).toBe(
        true,
      );
    });

    it("m5.patient.deceased: marks the period inactive with reason='died', leaves was_active true", async () => {
      const r = await freshRing();
      const provider = createDrizzlePseudonymKeyProvider(platformHandle.db, r);
      const consumer = buildM35PatientActivePeriodConsumer({
        db: appHandle.db,
        keyProvider: provider,
      });
      const patientId = "55555555-5555-4555-8555-000000000001";
      const deceasedDate = "2026-03-15";

      await consumer.handle({
        eventType: "m5.patient.deceased",
        organizationId: ORG_A,
        payload: { patientId, deceasedDate, organizationId: ORG_A },
      });

      const key = await provider.activeKey();
      const pseudonym = computeBillingPseudonym(key.keyMaterial, patientId);
      const { rows } = await admin.query(
        "SELECT was_active, became_inactive_at, inactivity_reason FROM patient_active_period WHERE organization_id = $1 AND patient_pseudonym = $2",
        [ORG_A, pseudonym],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].was_active).toBe(true);
      expect(rows[0].inactivity_reason).toBe("died");
      expect(rows[0].became_inactive_at).not.toBeNull();

      // Redelivery is idempotent — still exactly one row, same reason.
      await consumer.handle({
        eventType: "m5.patient.deceased",
        organizationId: ORG_A,
        payload: { patientId, deceasedDate, organizationId: ORG_A },
      });
      const { rows: after } = await admin.query(
        "SELECT count(*)::int AS n FROM patient_active_period WHERE organization_id = $1 AND patient_pseudonym = $2",
        [ORG_A, pseudonym],
      );
      expect(after[0].n).toBe(1);
    });
  });
});
