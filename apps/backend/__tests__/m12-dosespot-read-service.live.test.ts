/**
 * M12L-T01 — the Drizzle `createDbDoseSpotBackend` READ paths, proven against real Postgres.
 *
 * M12's pure suites drive the 14-state medication-order machine (draft → signed → transmitted → active),
 * the verbal-order timer, the refill loop and the EPCS-OFF gate, but never touch a database, so they can
 * neither prove the PRODUCTION read service returns real rows nor that RLS scopes them by tenant. This
 * drives the mounted `createDbDoseSpotBackend` (service + §4.7 ABAC resolver in one object) over the real
 * M12 tables under `withOrgContext` as the unprivileged `wardenx_app` role: the order list / active-meds /
 * refill-inbox reads return the seeded rows, RLS denies a cross-tenant read, and every write fail-closes 501.
 *
 * Gated on a live DB (default `bun run test` skips it):
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m12:read:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbDoseSpotBackend } from "../src/modules/12-dosespot/dosespot-route-service-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
/** An actor on neither §2.7 axis — not the named prescriber, not on the patient's caseload. */
const STRANGER_USER = "33333333-3333-3333-3333-3333333333ff";
const STRANGER_MEMBERSHIP = "33333333-3333-3333-3333-3333333333fe";
/** patient_id / admission_id / prescribing_physician_mdm_id are NOT NULL but carry NO SQL FK (cross-module
 * refs stay plain uuid, §3.3) — literals are fine. */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const PHYSICIAN_MDM = "66666666-6666-6666-6666-666666666666";

type SeedIds = { membership: string; medicationOrder: string; refillRequest: string };

describe.skipIf(!DB_URL)("M12 DoseSpot Drizzle read service — LIVE Postgres (M12L-T01)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbDoseSpotBackend>;
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

  /** Seed one full M12 DoseSpot chain for `org` as superuser (RLS + grants bypassed). Reuses the proven
   * shape from packages/db/migrations/__tests__/m12-rls-isolation.live.test.ts — the partitioned
   * medication_order (prescription of record), a refill_request, a dosespot_webhook_event (whose
   * correlation_id is NOT NULL, the RLS suite's fix), and a dosespot_prescriber. */
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
        [org, `CCN-M12R${n}`, `M12R Provider ${n}`, `NPI-M12R${n}`],
      )
    ).rows[0].id as string;

    const location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M12R${n}`],
      )
    ).rows[0].id as string;

    // medication_order — the partitioned prescription of record. is_controlled_substance defaults false and
    // dea_schedule stays NULL, satisfying the controlled_schedule_consistency CHECK. status defaults 'draft';
    // set 'active' so activeMedications() returns it.
    const medicationOrder = (
      await admin.query(
        `INSERT INTO medication_order (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, med_class, drug_name, strength, dose_form, route, data, prescriber_membership_id,
           prescribing_physician_mdm_id, status)
         VALUES ($1,$2,$3,$4,$5,'standard','Morphine','5 mg','tablet','oral','{}'::jsonb,$6,$7,'active') RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, membership, PHYSICIAN_MDM],
      )
    ).rows[0].id as string;

    const refillRequest = (
      await admin.query(
        `INSERT INTO refill_request (organization_id, provider_entity_id, location_id,
           source_medication_order_id, patient_id, dosespot_event_id, received_at)
         VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING id`,
        [org, providerEntity, location, medicationOrder, PATIENT, `rx-evt-M12R${n}`],
      )
    ).rows[0].id as string;

    // dosespot_webhook_event — correlation_id is NOT NULL (the RLS suite's fix), so pass the event id for it.
    await admin.query(
      `INSERT INTO dosespot_webhook_event (organization_id, dosespot_event_id, event_type, raw_body_cipher,
         raw_body_dek, body_digest, signature_verified_at, correlation_id)
       VALUES ($1,$2,'script_status_update','cipher','dek','digest', now(), $2)`,
      [org, `wh-evt-M12R${n}`],
    );

    await admin.query(
      `INSERT INTO dosespot_prescriber (organization_id, membership_id, npi)
       VALUES ($1,$2,$3)`,
      [org, membership, `NPI-PRES-M12R${n}`],
    );

    return { membership, medicationOrder, refillRequest };
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m12r@x.test')`, [USER]);
    seeded[ORG_A] = await seedOrg(ORG_A, 1);
    seeded[ORG_B] = await seedOrg(ORG_B, 2);
    // Prod connects as the NOBYPASSRLS `wardenx_app` role (a login role SET ROLEs to it); `withOrgContext`
    // deliberately does NOT SET ROLE. To exercise RLS faithfully here, connect the client AS wardenx_app —
    // it is NOLOGIN in the migrations, so grant LOGIN for the throwaway run.
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    service = createDbDoseSpotBackend(handle.db);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("listOrders returns the org's seeded medication order (RLS-scoped)", async () => {
    const { orders } = await service.listOrders(ORG_A, { scope: { orgWide: true, userId: "" } });
    expect(orders.length).toBe(1);
    expect(orders[0].id).toBe(seeded[ORG_A].medicationOrder);
    expect(orders[0].status).toBe("active");
    expect(orders[0].drugName).toBe("Morphine");
  });

  // GAP-033 — a non-org-wide scope narrows the list in the WHERE clause. No CaseloadProvider is registered
  // in this suite, so the "on-caseload" arm is exercised via the session-pinned patient (the other
  // legitimate non-org-wide arm); a stranger with neither gets an empty list.
  it("listOrders: an off-caseload prescriber gets an empty list, a patient-pinned scope gets rows", async () => {
    const off = await service.listOrders(ORG_A, {
      scope: { orgWide: false, userId: STRANGER_USER, sessionPatientId: null },
    });
    expect(off.orders).toEqual([]);
    expect(off.statusCounts).toEqual({});
    const on = await service.listOrders(ORG_A, {
      scope: { orgWide: false, userId: STRANGER_USER, sessionPatientId: PATIENT },
    });
    expect(on.orders.map((o) => o.id)).toEqual([seeded[ORG_A].medicationOrder]);
  });

  it("activeMedications returns the active order for the patient", async () => {
    const { orders } = await service.activeMedications(ORG_A, PATIENT);
    expect(orders.length).toBe(1);
    expect(orders[0].id).toBe(seeded[ORG_A].medicationOrder);
    expect(orders[0].patientId).toBe(PATIENT);
  });

  // GAP-026 — the inbox is NARROWED to the caller's §2.7 scope, not merely RLS-scoped to the org.
  // `refill_inbox_scope` resolves to allow on a list (no per-row target to gate), so this service call
  // is the only control on the list side and it used to apply none: every clinician in the tenant saw
  // every refill. The caseload axis reads M5's `CaseloadProvider`, unregistered in this suite, so the
  // named-prescriber axis is what separates the two callers below.
  it("listRefills narrows the inbox to the caller's scope, not the whole org", async () => {
    const prescriber = { userId: USER, membershipId: seeded[ORG_A].membership };
    const { refills } = await service.listRefills(ORG_A, prescriber);
    expect(refills.length).toBe(1);
    expect(refills[0].id).toBe(seeded[ORG_A].refillRequest);

    // An actor on neither axis gets an EMPTY inbox — the row is visible to RLS and withheld anyway.
    const stranger = { userId: STRANGER_USER, membershipId: STRANGER_MEMBERSHIP };
    expect((await service.listRefills(ORG_A, stranger)).refills).toEqual([]);
  });

  // The narrowing is a WHERE clause (see dosespot-refill-inbox-sql.test.ts for the emitted SQL). The
  // prescriber axis is a correlated EXISTS against the partitioned `medication_order`, so it is worth
  // proving against real Postgres that it separates TWO prescribers in the SAME tenant — the
  // stranger case above would still pass if the sub-select matched nothing at all for anyone.
  it("the prescriber EXISTS separates two prescribers inside one tenant", async () => {
    const OTHER_USER = "33333333-3333-3333-3333-3333333333a1";
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m12r-other@x.test')`, [
      OTHER_USER,
    ]);
    const otherMembership = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [OTHER_USER, ORG_A],
      )
    ).rows[0].id as string;
    const mine = await admin.query(
      `SELECT provider_entity_id, location_id FROM medication_order WHERE id = $1`,
      [seeded[ORG_A].medicationOrder],
    );
    const { provider_entity_id: pe, location_id: loc } = mine.rows[0];
    const otherOrder = (
      await admin.query(
        `INSERT INTO medication_order (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, med_class, drug_name, strength, dose_form, route, data, prescriber_membership_id,
           prescribing_physician_mdm_id, status)
         VALUES ($1,$2,$3,$4,$5,'standard','Lorazepam','1 mg','tablet','oral','{}'::jsonb,$6,$7,'active') RETURNING id`,
        [ORG_A, pe, loc, PATIENT, ADMISSION, otherMembership, PHYSICIAN_MDM],
      )
    ).rows[0].id as string;
    const otherRefill = (
      await admin.query(
        `INSERT INTO refill_request (organization_id, provider_entity_id, location_id,
           source_medication_order_id, patient_id, dosespot_event_id, received_at)
         VALUES ($1,$2,$3,$4,$5,'rx-evt-M12R-other', now()) RETURNING id`,
        [ORG_A, pe, loc, otherOrder, PATIENT],
      )
    ).rows[0].id as string;

    // Two refills now exist in ORG_A, for the SAME patient, differing only by whose order they came
    // from. Each prescriber sees exactly one.
    const forMe = await service.listRefills(ORG_A, {
      userId: USER,
      membershipId: seeded[ORG_A].membership,
    });
    expect(forMe.refills.map((r) => r.id)).toEqual([seeded[ORG_A].refillRequest]);

    const forOther = await service.listRefills(ORG_A, {
      userId: OTHER_USER,
      membershipId: otherMembership,
    });
    expect(forOther.refills.map((r) => r.id)).toEqual([otherRefill]);

    // Clean up so the surrounding suite's single-refill expectations still hold.
    await admin.query("DELETE FROM refill_request WHERE id = $1", [otherRefill]);
    await admin.query("DELETE FROM medication_order WHERE id = $1", [otherOrder]);
  });

  it("loadRefillScope grants the named prescriber and denies everyone else (GAP-026)", async () => {
    const facts = await service.loadRefillScope(ORG_A, seeded[ORG_A].refillRequest, {
      userId: USER,
      membershipId: seeded[ORG_A].membership,
    });
    // The comparison is membership-id to membership-id. The ABAC layer used to pass `context.userId`
    // here — a different id space — so this was false for every real caller, and with the caseload
    // axis hardcoded false the predicate denied EVERYONE on a refill detail in production.
    expect(facts?.isNamedPrescriber).toBe(true);
    expect(facts?.patientInCaseload).toBe(false); // no CaseloadProvider seam registered here

    const other = await service.loadRefillScope(ORG_A, seeded[ORG_A].refillRequest, {
      userId: STRANGER_USER,
      membershipId: STRANGER_MEMBERSHIP,
    });
    expect(other).toEqual({ isNamedPrescriber: false, patientInCaseload: false });

    // A cross-tenant / unknown refill id is fail-closed null, never a permissive default.
    expect(
      await service.loadRefillScope(ORG_B, seeded[ORG_A].refillRequest, {
        userId: USER,
        membershipId: seeded[ORG_A].membership,
      }),
    ).toBeNull();
  });

  it("RLS: org B cannot see org A's medication order or refill through the service", async () => {
    const { orders } = await service.listOrders(ORG_B, { scope: { orgWide: true, userId: "" } });
    expect(orders.every((o) => o.id !== seeded[ORG_A].medicationOrder)).toBe(true);
    await expect(service.getOrder(ORG_B, seeded[ORG_A].medicationOrder)).rejects.toMatchObject({
      statusCode: 404,
    });
    const { refills } = await service.listRefills(ORG_B, {
      userId: USER,
      membershipId: seeded[ORG_B].membership,
    });
    expect(refills.every((r) => r.id !== seeded[ORG_A].refillRequest)).toBe(true);
  });

  it("writes are live (M12L): enrollPrescriber persists and reads back on the roster under RLS", async () => {
    const enrolled = await service.enrollPrescriber(ORG_A, seeded[ORG_A].membership, ["III", "IV"]);
    expect(enrolled.enrolled).toBe(true);
    const { prescribers } = await service.listPrescribers(ORG_A);
    const row = prescribers.find((p) => p.membershipId === seeded[ORG_A].membership);
    expect(row).toBeDefined();
    expect(row?.deaAuthorizedSchedules).toEqual(["III", "IV"]);
  });
});
