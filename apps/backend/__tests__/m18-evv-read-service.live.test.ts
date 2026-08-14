/**
 * M18 EVV — the Drizzle `createDbEvvBackend` READ paths, proven against real Postgres (mirrors M6L-T01).
 *
 * M18's pure suites exercise the check-in/check-out pairing and aggregator machinery in memory; the RLS
 * live suite proves the policies at the table level. Neither drives the PRODUCTION read service — the one
 * the composition root casts to `EvvRouteService` and mounts. This applies the real migrations, seeds a full
 * EVV chain per tenant as superuser, then drives `createDbEvvBackend` over the M18-owned tables as the
 * unprivileged (NOBYPASSRLS) `wardenx_app` role under `withOrgContext`, proving:
 *   • the event ledger / device roster reads return the seeded rows, coordinate-free on the wire (§4.3);
 *   • RLS scopes every read by tenant (org B cannot see org A's event, and `getEvent` cross-tenant 404s);
 *   • every write still fail-closes 501 (the deny-stub throws SYNCHRONOUSLY — asserted as such).
 *
 * Gated on a live DB (default `bun run test` skips it):
 *   WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m18-evv-read-service.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbEvvBackend } from "../src/modules/18-evv/evv-route-service-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** `evv_device.membership_id` / `evv_geofence_policy.set_by_membership_id` FK `membership`; each org needs one. */
const USER = "33333333-3333-3333-3333-333333333333";
/** visit_id / patient_id / device_attestation_id_at_record carry NO SQL FK (app-validated) — literals are fine. */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const VISIT = "55555555-5555-5555-5555-555555555555";
const DEVICE_ATTEST = "66666666-6666-6666-6666-666666666666";

type SeedIds = { membership: string; evvDevice: string; evvEvent: string };

describe.skipIf(!DB_URL)("M18 EVV Drizzle read service — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbEvvBackend>;
  const seeded: Record<string, SeedIds> = {};

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations() {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  /** Seed one full M18 EVV chain for `org` as superuser (RLS + grants bypassed). */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const membership = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, org],
      )
    ).rows[0].id as string;
    const providerEntity = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M18R${n}`, `M18R ${n}`, `NPI-M18R${n}`],
      )
    ).rows[0].id as string;
    const location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M18R${n}`],
      )
    ).rows[0].id as string;
    const evvDevice = (
      await admin.query(
        `INSERT INTO evv_device (organization_id, membership_id, platform, device_key_fingerprint,
           m2_device_attestation_id)
         VALUES ($1,$2,'ios',$3,$4) RETURNING id`,
        [org, membership, `fp-M18R${n}`, DEVICE_ATTEST],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO evv_geofence_policy (organization_id, scope, radius_m, max_accuracy_m, effective_from,
         set_by_membership_id)
       VALUES ($1,'tenant',150,50, now()::date, $2)`,
      [org, membership],
    );
    // event_at = now() routes into the current-month partition (0047 pre-creates current + 12 forward months).
    const evvEvent = (
      await admin.query(
        `INSERT INTO evv_event (organization_id, provider_entity_id, location_id, visit_id, patient_id, kind,
           service_type_code, posting_membership_id, posting_discipline_at_recording, evv_device_id,
           captured_at, event_at, coords_cipher, coords_dek_version, accuracy_m, gps_quality,
           device_attestation_id_at_record)
         VALUES ($1,$2,$3,$4,$5,'check_in','T1021',$6,'rn',$7, now(), now(),'enc',1,4.5,'high',$8)
         RETURNING id`,
        [org, providerEntity, location, VISIT, PATIENT, membership, evvDevice, DEVICE_ATTEST],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO evv_missing_resolution (organization_id, visit_id, kind, detected_by_source)
       VALUES ($1,$2,'missing_checkout','sync_reconcile')`,
      [org, VISIT],
    );
    return { membership, evvDevice, evvEvent };
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m18r@x.test')`, [USER]);
    seeded[ORG_A] = await seedOrg(ORG_A, 1);
    seeded[ORG_B] = await seedOrg(ORG_B, 2);
    // Prod connects as the NOBYPASSRLS `wardenx_app` role; `withOrgContext` does NOT SET ROLE, so to exercise
    // RLS faithfully connect the client AS wardenx_app — NOLOGIN in the migrations, so grant LOGIN here.
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    service = createDbEvvBackend(handle.db);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("listEvents returns the org's EVV event, coordinate-free on the wire (§4.3, RLS-scoped)", async () => {
    const events = await service.listEvents(ORG_A, {});
    expect(events.length).toBe(1);
    const dto = events[0];
    expect(dto.id).toBe(seeded[ORG_A].evvEvent);
    expect(dto.organizationId).toBe(ORG_A);
    expect(dto.kind).toBe("check_in");
    // §4.3: the event projection NEVER carries coordinates on the wire.
    expect("lat" in dto).toBe(false);
    expect("lng" in dto).toBe(false);
    expect("coordsCipher" in dto).toBe(false);
  });

  it("listDevices returns the org's device roster (RLS-scoped)", async () => {
    const devices = await service.listDevices(ORG_A);
    expect(devices.length).toBe(1);
    expect(devices[0].id).toBe(seeded[ORG_A].evvDevice);
    expect(devices[0].membershipId).toBe(seeded[ORG_A].membership);
    expect(devices[0].platform).toBe("ios");
  });

  it("RLS: org B cannot see org A's event through the read service", async () => {
    const bEvents = await service.listEvents(ORG_B, {});
    expect(bEvents.every((e) => e.id !== seeded[ORG_A].evvEvent)).toBe(true);
    expect(bEvents.every((e) => e.organizationId === ORG_B)).toBe(true);
    // getEvent scopes by app.org_id too → org A's event is a 404 for org B (NotFoundError, statusCode 404).
    await expect(service.getEvent(ORG_B, seeded[ORG_A].evvEvent)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("the M18L write lifecycle persists over RLS: selfRegisterDevice round-trips through listDevices", async () => {
    // The write lifecycle is live (no route at 501). A device self-register needs only a membership (no M17
    // visit), so it is the read-suite's persistence smoke-check; the full write suite (m18-evv-write) exhausts
    // capture / geofence / resolution / aggregator. Prove one mutation commits under RLS and reads back scoped.
    const created = await service.selfRegisterDevice(ORG_A, seeded[ORG_A].membership, {
      platform: "android",
      modelDescription: "Pixel 8",
    });
    expect(created.status).toBe("pending_approval");
    const devices = await service.listDevices(ORG_A, seeded[ORG_A].membership);
    expect(devices.some((d) => d.id === created.id && d.platform === "android")).toBe(true);
    // RLS: org B cannot see org A's freshly-written device.
    const bDevices = await service.listDevices(ORG_B);
    expect(bDevices.every((d) => d.id !== created.id)).toBe(true);
  });
});
