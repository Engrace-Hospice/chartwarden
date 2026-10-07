/**
 * §4.8 `m18.dek-rotation` — the EVV coordinate re-seal, proven against real Postgres as the NOBYPASSRLS
 * `wardenx_app` role.
 *
 * Covers: rows sealed under DEK v1 become readable under v2 after a rotation (event AND its geofence snapshot,
 * same envelope, same coordinate), legacy 'legacy-unencrypted' rows and another tenant's rows are untouched, a
 * re-run is a no-op, the M4 write-audit trail records the re-seal with the cipher scrubbed, the on-demand
 * `m34.tenant.dek_rotation_completed` consumer and the daily cron runner both drive it, and migration 0494's
 * guard rails hold: the app role still cannot UPDATE `coords_cipher` directly (the append-only trigger), the
 * definer is tenant-scoped by `app.org_id` (another org's event id is a no-op), and it refuses a target that is
 * legacy or whose envelope names a different version.
 *
 * The key ring is the in-memory per-tenant DEK ring (`_m18-coords-test-cipher.ts`) with M34's shape; the
 * envelope, the worker and the SQL are production code.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m18:dek-rotation:live
 * (`evv_event` is RANGE-partitioned → a throwaway superuser DB needs `max_locks_per_transaction` raised.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LEGACY_COORDS_DEK_VERSION,
  buildM18CronRunners,
  buildM18DekRotationConsumer,
  createDrizzleCoordsResealStore,
  createEvvCoordsCipher,
  resealOrgCoords,
} from "../src/modules/18-evv/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { createRotatableTestCoordsKeyRing } from "./_m18-coords-test-cipher";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "evv_coords_rekeyer",
];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ATTESTATION = "66666666-6666-6666-6666-666666666666";
const PORTLAND = { lat: 45.523, lng: -122.6789 };
const SALEM = { lat: 44.9429, lng: -123.0351 };

type Seed = { pe: string; location: string; member: string; device: string };
type EventRow = { id: string; coords_cipher: string; coords_dek_version: string };

/** The Postgres error under drizzle's "Failed query" wrapper (the RAISE text lives on `cause`). */
async function pgError(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const e = error as { message?: string; cause?: { message?: string } };
    return `${e.message ?? ""} ${e.cause?.message ?? ""}`;
  }
  return "no error";
}

describe.skipIf(!DB_URL)("M18 §4.8 m18.dek-rotation — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const keys = createRotatableTestCoordsKeyRing("v1");
  const cipher = createEvvCoordsCipher(keys);
  const seeded: Record<string, Seed> = {};
  const ids: Record<string, string> = {};

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

  /** An `evv_event` + its geofence snapshot, sealed exactly as the capture seals them (same envelope in both). */
  async function sealedEvent(
    org: string,
    coords: { lat: number; lng: number },
    stored?: { cipher: string; dekVersion: string },
  ): Promise<string> {
    const s = seeded[org];
    if (!s) throw new Error("unseeded org");
    const sealed = stored ?? (await cipher.seal(org, coords));
    const at = new Date(Date.now() - 3_600_000);
    const id = (
      await admin.query(
        `INSERT INTO evv_event (organization_id, provider_entity_id, location_id, visit_id, patient_id, kind,
           service_type_code, posting_membership_id, posting_discipline_at_recording, evv_device_id,
           captured_at, event_at, coords_cipher, coords_dek_version, accuracy_m, gps_quality,
           device_attestation_id_at_record)
         VALUES ($1,$2,$3,$4,$5,'check_in','routine_visit',$6,'rn',$7,$8,$8,$9,$10,9,'acceptable',$11)
         RETURNING id`,
        [
          org,
          s.pe,
          s.location,
          randomUUID(),
          PATIENT,
          s.member,
          s.device,
          at,
          sealed.cipher,
          sealed.dekVersion,
          ATTESTATION,
        ],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO evv_geofence_evaluation (organization_id, evv_event_id, applied_policy_id, applied_policy_scope,
         applied_radius_m, applied_max_accuracy_m, device_coords_cipher, computed_distance_m, decision)
       VALUES ($1,$2,$3,'platform',200,50,$4,12,'inside')`,
      [org, id, randomUUID(), sealed.cipher],
    );
    return id;
  }

  async function eventRow(id: string): Promise<EventRow> {
    return (
      await admin.query("SELECT id, coords_cipher, coords_dek_version FROM evv_event WHERE id=$1", [
        id,
      ])
    ).rows[0] as EventRow;
  }
  async function geofenceCipher(eventId: string): Promise<string> {
    return (
      await admin.query(
        "SELECT device_coords_cipher FROM evv_geofence_evaluation WHERE evv_event_id=$1",
        [eventId],
      )
    ).rows[0].device_coords_cipher as string;
  }
  const store = () => createDrizzleCoordsResealStore(handle.db);

  /**
   * Rotate the in-memory key ring AND each tenant's `tenant_key_ring.current_dek_version` in step:
   * `evv_reseal_coords` (0494) only accepts the tenant's current, non-destroyed version.
   */
  async function rotateTo(version: string): Promise<void> {
    keys.rotateTo(version);
    for (const org of [ORG_A, ORG_B]) {
      await admin.query(
        `INSERT INTO tenant_key_ring (organization_id, tenant_account_id, current_dek_version,
           current_dek_kek_wrapped_ciphertext, current_dek_kek_id)
         SELECT $1, gen_random_uuid(), $2, '\\x00'::bytea, 'kek-test'
          WHERE NOT EXISTS (SELECT 1 FROM tenant_key_ring WHERE organization_id = $1)`,
        [org, version],
      );
      await admin.query(
        "UPDATE tenant_key_ring SET current_dek_version = $2 WHERE organization_id = $1",
        [org, version],
      );
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    let n = 0;
    for (const org of [ORG_A, ORG_B]) {
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `m18rot-${n++}@x.test`,
        ])
      ).rows[0].id as string;
      const member = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user, org],
        )
      ).rows[0].id as string;
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [
            org,
            `CCN-ROT-${org.slice(0, 4)}`,
            `ROT ${org.slice(0, 4)}`,
            `NPI-ROT-${org.slice(0, 4)}`,
          ],
        )
      ).rows[0].id as string;
      const location = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [pe],
        )
      ).rows[0].id as string;
      const device = (
        await admin.query(
          `INSERT INTO evv_device (organization_id, membership_id, platform, device_key_fingerprint,
             m2_device_attestation_id, status, approved_at)
           VALUES ($1,$2,'ios',$3,$4,'approved', now()) RETURNING id`,
          [org, member, `fp-ROT-${n}`, ATTESTATION],
        )
      ).rows[0].id as string;
      seeded[org] = { pe, location, member, device };
    }

    // Everything below is sealed under DEK v1.
    ids.a1 = await sealedEvent(ORG_A, PORTLAND);
    ids.a2 = await sealedEvent(ORG_A, SALEM);
    ids.b1 = await sealedEvent(ORG_B, PORTLAND);
    // A pre-GAP-133 row: base64, stamped legacy by 0491. Never re-sealed.
    ids.legacy = await sealedEvent(ORG_A, PORTLAND, {
      cipher: Buffer.from(`${PORTLAND.lat},${PORTLAND.lng}`).toString("base64"),
      dekVersion: LEGACY_COORDS_DEK_VERSION,
    });

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    const who = await handle.db.execute(sql`SELECT current_user AS u`);
    expect((who as unknown as { rows: { u: string }[] }).rows[0]?.u).toBe("wardenx_app");

    await rotateTo("v2");
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("the app role still cannot UPDATE coords_cipher directly (append-only trigger)", async () => {
    const forged = (await cipher.seal(ORG_A, SALEM)).cipher;
    const err = await pgError(
      withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
        (tx as typeof handle.db).execute(
          sql`UPDATE evv_event SET coords_cipher = ${forged}, coords_dek_version = 'v2' WHERE id = ${ids.a1}::uuid`,
        ),
      ),
    );
    expect(err).toMatch(/EVV_EVENT_APPEND_ONLY_IMMUTABLE_COLUMN/);
  });

  it("the definer refuses a legacy target and an envelope that names a different version", async () => {
    const before = await eventRow(ids.a1 as string);
    const call = (target: string, version: string) =>
      withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
        (tx as typeof handle.db).execute(
          sql`SELECT evv_reseal_coords(${ids.a1}::uuid, (SELECT event_at FROM evv_event WHERE id = ${ids.a1}::uuid), ${before.coords_cipher}, ${target}, ${version})`,
        ),
      );
    expect(await pgError(call(before.coords_cipher, LEGACY_COORDS_DEK_VERSION))).toMatch(
      /EVV_RESEAL_INVALID_DEK_VERSION/,
    );
    expect(await pgError(call(before.coords_cipher, "v2"))).toMatch(
      /EVV_RESEAL_ENVELOPE_VERSION_MISMATCH/,
    );
    // A well-formed envelope under a version that is not the tenant's current key ring version.
    expect(await pgError(call("v1.v9.AAAA.AAAA.AAAA", "v9"))).toMatch(
      /EVV_RESEAL_NOT_CURRENT_DEK_VERSION/,
    );
    expect(await eventRow(ids.a1 as string)).toEqual(before);
  });

  it("the definer is tenant-scoped: org B cannot re-seal org A's event by id", async () => {
    const before = await eventRow(ids.a1 as string);
    const forged = await cipher.seal(ORG_A, SALEM);
    const res = await withOrgContext(handle.db, { organizationId: ORG_B, userId: "" }, (tx) =>
      (tx as typeof handle.db).execute(
        sql`SELECT evv_reseal_coords(${ids.a1}::uuid, now(), ${before.coords_cipher}, ${forged.cipher}, ${forged.dekVersion}) AS moved`,
      ),
    );
    expect((res as unknown as { rows: { moved: number }[] }).rows[0]?.moved).toBe(0);
    expect(await eventRow(ids.a1 as string)).toEqual(before);
  });

  it("re-seals org A's v1 rows under v2: same coordinate, geofence snapshot in step, legacy + org B untouched", async () => {
    const legacyBefore = await eventRow(ids.legacy as string);
    const orgBBefore = await eventRow(ids.b1 as string);

    const result = await resealOrgCoords({ store: store(), keys }, ORG_A);

    expect(result).toMatchObject({ currentVersion: "v2", resealed: 2, raced: 0, complete: true });
    for (const [id, coords] of [
      [ids.a1, PORTLAND],
      [ids.a2, SALEM],
    ] as const) {
      const row = await eventRow(id as string);
      expect(row.coords_dek_version).toBe("v2");
      expect(row.coords_cipher.startsWith("v1.v2.")).toBe(true);
      expect(await cipher.open(ORG_A, row.coords_cipher)).toEqual(coords);
      expect(await geofenceCipher(id as string)).toBe(row.coords_cipher);
    }
    expect(await eventRow(ids.legacy as string)).toEqual(legacyBefore);
    expect(await eventRow(ids.b1 as string)).toEqual(orgBBefore);
  });

  it("the M4 write-audit trail records the re-seal with the coordinate cipher scrubbed", async () => {
    const { rows } = await admin.query(
      `SELECT after FROM audit_event WHERE resource_id=$1 AND event_type='evv_event.update'`,
      [ids.a1],
    );
    expect(rows.length).toBeGreaterThan(0);
    const after = JSON.stringify(rows.map((r) => r.after));
    expect(after).not.toContain((await eventRow(ids.a1 as string)).coords_cipher);
  });

  it("a re-run is a no-op", async () => {
    const before = [await eventRow(ids.a1 as string), await eventRow(ids.a2 as string)];

    const again = await resealOrgCoords({ store: store(), keys }, ORG_A);

    expect(again).toMatchObject({ scanned: 0, resealed: 0, complete: true });
    expect([await eventRow(ids.a1 as string), await eventRow(ids.a2 as string)]).toEqual(before);
  });

  it("the m34.tenant.dek_rotation_completed consumer re-seals its envelope tenant", async () => {
    await buildM18DekRotationConsumer({ store: store(), keys }).handle({
      organizationId: ORG_B,
      payload: { tenantAccountId: randomUUID(), orgId: ORG_B, fromVersion: "v1", toVersion: "v2" },
    });

    const row = await eventRow(ids.b1 as string);
    expect(row.coords_dek_version).toBe("v2");
    expect(await cipher.open(ORG_B, row.coords_cipher)).toEqual(PORTLAND);
    expect(await geofenceCipher(ids.b1 as string)).toBe(row.coords_cipher);
  });

  it("the daily cron runner sweeps every active org after a further rotation", async () => {
    await rotateTo("v3");
    const runners = buildM18CronRunners({
      connection: {},
      db: handle.db,
      outbox: { publish: async () => {} },
      activeOrgs: {
        listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
      },
      aggregator: {} as never,
      coordsKeys: keys,
    });

    await runners.dekRotation();

    for (const id of [ids.a1, ids.a2, ids.b1]) {
      expect((await eventRow(id as string)).coords_dek_version).toBe("v3");
    }
    expect((await eventRow(ids.legacy as string)).coords_dek_version).toBe(
      LEGACY_COORDS_DEK_VERSION,
    );
  });
});
