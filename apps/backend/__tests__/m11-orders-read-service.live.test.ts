/**
 * M11L — the Drizzle `createDbOrderBackend` READ paths, proven against real Postgres.
 *
 * M11's pure/unit suites drive the order-machine and the in-memory slice; this drives the PRODUCTION read
 * service (the one the composition root now mounts) over the real M11 tables under `withOrgContext` — proving
 * the order worklist / detail / standing-order reads return the right rows and shape, that RLS scopes every
 * read by tenant (`app.org_id` as the NOBYPASSRLS `chartwarden_app` role), and that every write fail-closes 501.
 *
 * The seed is the proven one from `packages/db/migrations/__tests__/m11-rls-isolation.live.test.ts` — it
 * already sidesteps the M11 trigger hazards (kind='dme' so the lab-initial-states trigger is inert;
 * signature_kind='cosignature' so the apply-to-target trigger stays inert; verbal target_kind='medication_order'
 * so the set-target-pending trigger does not RAISE against a draft order).
 *
 * Gated on a live DB (default `bun run test` skips it):
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m11-orders-read-service.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbOrderBackend } from "../src/modules/11-orders/orders-route-service-db";
import { SYSTEM_ORDER_ACTOR } from "../src/modules/11-orders/routes/service";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** M11's actor columns carry real FKs to `membership`, so each org seeds its own. */
const USER = "33333333-3333-3333-3333-333333333333";
/** patient_id / admission_id / ordering_physician_mdm_id are NOT NULL but carry NO SQL FK — literals fine. */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const PHYSICIAN_MDM = "66666666-6666-6666-6666-666666666666";

describe.skipIf(!DB_URL)("M11 Drizzle read service — LIVE Postgres (M11L)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbOrderBackend>;
  const seeded: Record<string, { orderRecord: string; standingOrder: string }> = {};

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

  /** Seed one full M11 orders chain for `org` as superuser (RLS + grants bypassed). */
  async function seedOrg(org: string, n: number) {
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
        [org, `CCN-M11R${n}`, `M11R Provider ${n}`, `NPI-M11R${n}`],
      )
    ).rows[0].id as string;

    const location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M11R${n}`],
      )
    ).rows[0].id as string;

    const standingOrder = (
      await admin.query(
        `INSERT INTO standing_order (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, kind, kind_version, template_data, cadence, effective_from, ordering_physician_mdm_id)
         VALUES ($1,$2,$3,$4,$5,'dme','v1','{}'::jsonb,'weekly', now(), $6) RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, PHYSICIAN_MDM],
      )
    ).rows[0].id as string;

    // kind='dme' (not 'lab') so the BEFORE-INSERT lab-initial-states trigger is a no-op; replaces_order_id
    // left null so the correction-supersede trigger does not fire.
    const orderRecord = (
      await admin.query(
        `INSERT INTO order_record (organization_id, provider_entity_id, location_id, patient_id, admission_id,
           kind, kind_version, data, drafter_membership_id, drafter_discipline, ordering_physician_mdm_id)
         VALUES ($1,$2,$3,$4,$5,'dme','v1','{}'::jsonb,$6,'rn',$7) RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, membership, PHYSICIAN_MDM],
      )
    ).rows[0].id as string;

    // signature_kind='cosignature' so the AFTER-INSERT apply-to-target trigger (fires only for the primary
    // 'signature') stays inert and the order_record status is not mutated by seeding.
    await admin.query(
      `INSERT INTO order_signature (organization_id, provider_entity_id, location_id, target_kind, target_id,
         signature_kind, signer_membership_id, signer_discipline)
       VALUES ($1,$2,$3,'order',$4,'cosignature',$5,'rn')`,
      [org, providerEntity, location, orderRecord, membership],
    );

    // target_kind='medication_order' so verbal_order_set_target_pending (which RAISES unless the linked order
    // is in pending_signature) does not fire against our draft order_record.
    await admin.query(
      `INSERT INTO verbal_order (organization_id, provider_entity_id, location_id, target_kind, target_id,
         recording_membership_id, ordering_physician_mdm_id, verbal_attestation, received_at, effective_at,
         deadline_at, deadline_policy_version)
       VALUES ($1,$2,$3,'medication_order',$4,$5,$6,'read back', now(), now(), now() + interval '48 hours','v1')`,
      [org, providerEntity, location, orderRecord, membership, PHYSICIAN_MDM],
    );

    await admin.query(
      `INSERT INTO order_verbal_policy (organization_id, provider_entity_id, location_id,
         updated_by_membership_id)
       VALUES ($1,$2,$3,$4)`,
      [org, providerEntity, location, membership],
    );

    seeded[org] = { orderRecord, standingOrder };
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m11r@x.test')`, [USER]);
    await seedOrg(ORG_A, 1);
    await seedOrg(ORG_B, 2);
    // Prod connects as the NOBYPASSRLS `chartwarden_app` role (a login role SET ROLEs to it); `withOrgContext`
    // deliberately does NOT SET ROLE. To exercise RLS faithfully here, connect the client AS chartwarden_app —
    // it is NOLOGIN in the migrations, so grant LOGIN for the throwaway run.
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    service = createDbOrderBackend(handle.db);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("listOrders returns the org's order (RLS-scoped) with the right OrderView shape", async () => {
    const { orders } = await service.listOrders(ORG_A, {});
    expect(orders.length).toBe(1);
    expect(orders[0].id).toBe(seeded[ORG_A].orderRecord);
    expect(orders[0].patientId).toBe(PATIENT);
    expect(orders[0].admissionId).toBe(ADMISSION);
    expect(orders[0].kind).toBe("dme");
    expect(orders[0].status).toBe("draft");
  });

  it("getOrder returns the seeded order detail for its own org", async () => {
    const order = await service.getOrder(ORG_A, seeded[ORG_A].orderRecord);
    expect(order.id).toBe(seeded[ORG_A].orderRecord);
    expect(order.kind).toBe("dme");
    // seed's cosignature signature (not the primary 'signature') is not joined → signedBy stays null.
    expect(order.signedBy).toBeNull();
  });

  it("listStandingOrders returns the org's standing order", async () => {
    const { standingOrders } = await service.listStandingOrders(ORG_A);
    expect(standingOrders.length).toBe(1);
    expect(standingOrders[0].id).toBe(seeded[ORG_A].standingOrder);
    expect(standingOrders[0].cadence).toBe("weekly");
  });

  it("RLS: org B does NOT see org A's order through the read service", async () => {
    const { orders } = await service.listOrders(ORG_B, {});
    expect(orders.every((o) => o.id !== seeded[ORG_A].orderRecord)).toBe(true);
    // getOrder throws NotFoundError (404) — the row is invisible to org B under RLS, not merely filtered.
    await expect(service.getOrder(ORG_B, seeded[ORG_A].orderRecord)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("writes are live (M11L): a created draft persists and reads back under RLS", async () => {
    // drafter_membership_id FKs membership.id — resolve org A's seeded membership (USER is a user_id).
    const membershipA = (
      await admin.query("SELECT id FROM membership WHERE organization_id=$1 LIMIT 1", [ORG_A])
    ).rows[0].id as string;
    const draft = await service.createDraft(
      ORG_A,
      membershipA,
      {
        patientId: PATIENT,
        admissionId: ADMISSION,
        kind: "dme",
        drafterDiscipline: "rn_case_manager",
        data: { hcpcs: "E0260" },
        orderingPhysicianMdmId: PHYSICIAN_MDM,
      },
      SYSTEM_ORDER_ACTOR,
    );
    expect(draft.status).toBe("draft");
    const readBack = await service.getOrder(ORG_A, draft.id);
    expect(readBack.id).toBe(draft.id);
    expect(readBack.kind).toBe("dme");
  });

  // Finding 9 — the signer is shown by NAME: `signedByDisplayName` is resolved from the signature's membership id
  // through the in-org membership join (name only); an unsigned order carries null.
  it("getOrder resolves the signer's display name from the signature membership", async () => {
    await admin.query(`UPDATE "user" SET name = 'Dr. Sig Ner' WHERE id = $1`, [USER]);
    const row = (
      await admin.query(
        `SELECT o.id, o.provider_entity_id, o.location_id, m.id AS mid FROM order_record o
         JOIN membership m ON m.organization_id = o.organization_id WHERE o.organization_id = $1 LIMIT 1`,
        [ORG_A],
      )
    ).rows[0];
    const unsigned = await service.getOrder(ORG_A, row.id);
    expect(unsigned.signedByDisplayName ?? null).toBeNull();
    await admin.query(
      `INSERT INTO order_signature (organization_id, provider_entity_id, location_id, target_kind, target_id,
         signature_kind, signer_membership_id, signer_discipline)
       VALUES ($1,$2,$3,'order',$4,'signature',$5,'rn')`,
      [ORG_A, row.provider_entity_id, row.location_id, row.id, row.mid],
    );
    const signed = await service.getOrder(ORG_A, row.id);
    expect(signed.signedBy).toBe(row.mid);
    expect(signed.signedByDisplayName).toBe("Dr. Sig Ner");
  });
});
