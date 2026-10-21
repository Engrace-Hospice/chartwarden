import { randomUUID } from "node:crypto";
/**
 * M7L-T01 — the Drizzle `createDbCarePlanRouteService` READ paths, proven against real Postgres.
 *
 * M7's pure suites exercise the version/quorum/clock machinery but never touch a database, and the
 * RLS-isolation suite drives the raw policies as `chartwarden_app`. Neither proves the PRODUCTION read
 * SERVICE — the one the composition root mounts — returns the right rows through `withOrgContext`.
 * This drives that service over the real M7 tables: the care-plan aggregate / version-ledger reads
 * surface the seeded chain, RLS scopes every read by tenant (org B is denied org A's plan), and the
 * bootstrap write drives a real insert (the full write lifecycle lives in m7-care-plan-write.live).
 *
 * As the template M6 suite notes: prod connects as the NOBYPASSRLS `chartwarden_app` role (a login role
 * SET ROLEs to it) and `withOrgContext` deliberately does NOT SET ROLE, so the read client here
 * connects AS `chartwarden_app` to exercise RLS faithfully.
 *
 * Gated on a live DB (default `bun run test` skips it):
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m7-care-plan-read-service.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbCarePlanRouteService } from "../src/modules/07-care-plan/care-plan-route-service-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** `care_plan_signature.membership_id` carries a real FK to `membership`, so each org needs one. */
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";

type SeedIds = { membership: string; carePlan: string; carePlanVersion: string; problem: string };

describe.skipIf(!DB_URL)("M7 Drizzle read service — LIVE Postgres (M7L-T01)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbCarePlanRouteService>;
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

  /** Seed one full M7 care-plan chain for `org` as superuser (RLS + grants bypassed). */
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
        [org, `CCN-M7R${n}`, `M7R Provider ${n}`, `NPI-M7R${n}`],
      )
    ).rows[0].id as string;

    const location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M7R${n}`],
      )
    ).rows[0].id as string;

    const carePlan = (
      await admin.query(
        `INSERT INTO care_plan (organization_id, provider_entity_id, location_id, patient_id, admission_id,
           initial_due_at)
         VALUES ($1,$2,$3,$4,$5, now() + interval '5 days') RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION],
      )
    ).rows[0].id as string;

    const carePlanVersion = (
      await admin.query(
        `INSERT INTO care_plan_version (organization_id, provider_entity_id, location_id, care_plan_id,
           sequence, kind, required_signer_set)
         VALUES ($1,$2,$3,$4,1,'initial','[]'::jsonb) RETURNING id`,
        [org, providerEntity, location, carePlan],
      )
    ).rows[0].id as string;

    await admin.query(
      `INSERT INTO care_plan_signature (organization_id, provider_entity_id, location_id,
         care_plan_version_id, membership_id, signer_role, signature_method, attestation_text)
       VALUES ($1,$2,$3,$4,$5,'rn_case_manager','typed','I attest')`,
      [org, providerEntity, location, carePlanVersion, membership],
    );

    const problem = (
      await admin.query(
        `INSERT INTO problem (organization_id, provider_entity_id, location_id, care_plan_id,
           description, kind, sud_related)
         VALUES ($1,$2,$3,$4,'Pain management','terminal',false) RETURNING id`,
        [org, providerEntity, location, carePlan],
      )
    ).rows[0].id as string;

    return { membership, carePlan, carePlanVersion, problem };
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m7r@x.test')`, [USER]);
    seeded[ORG_A] = await seedOrg(ORG_A, 1);
    seeded[ORG_B] = await seedOrg(ORG_B, 2);
    // Prod connects as the NOBYPASSRLS `chartwarden_app` role (a login role SET ROLEs to it); `withOrgContext`
    // deliberately does NOT SET ROLE. To exercise RLS faithfully, connect the read client AS chartwarden_app —
    // it is NOLOGIN in the migrations, so grant LOGIN for the throwaway run.
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    service = createDbCarePlanRouteService(handle.db);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("listVersions returns the org's seeded version ledger (RLS-scoped, paging shape)", async () => {
    const page = (await service.listVersions(ORG_A, seeded[ORG_A].carePlan)) as {
      items: { id: string; sequence: number; signatures: unknown[] }[];
      nextCursor: string | null;
    };
    expect(page.items.length).toBe(1);
    expect(page.items[0].id).toBe(seeded[ORG_A].carePlanVersion);
    expect(page.items[0].sequence).toBe(1);
    expect(page.items[0].signatures.length).toBe(1); // the seeded rn_case_manager signature
    expect(page.nextCursor).toBeNull();
  });

  it("getCarePlanForPatient returns the seeded plan aggregate with its version + problem", async () => {
    const plan = (await service.getCarePlanForPatient(ORG_A, PATIENT)) as {
      id: string;
      patientId: string;
      versions: unknown[];
      problems: { id: string }[];
      redacted: boolean;
    } | null;
    expect(plan).not.toBeNull();
    expect(plan?.id).toBe(seeded[ORG_A].carePlan);
    expect(plan?.patientId).toBe(PATIENT);
    expect(plan?.versions.length).toBe(1);
    expect(plan?.problems.some((p) => p.id === seeded[ORG_A].problem)).toBe(true);
    expect(plan?.redacted).toBe(false); // no SUD problems seeded here
  });

  it("RLS: org B cannot see org A's plan through the read service", async () => {
    // listVersions of A's plan id, bound to org B, is a non-leaking 404 (RLS-hidden ≡ absent).
    await expect(service.listVersions(ORG_B, seeded[ORG_A].carePlan)).rejects.toMatchObject({
      statusCode: 404,
    });
    // Same patient id is seeded under both tenants; org B must resolve its OWN plan, never A's.
    const bPlan = (await service.getCarePlanForPatient(ORG_B, PATIENT)) as { id: string } | null;
    expect(bPlan?.id).toBe(seeded[ORG_B].carePlan);
    expect(bPlan?.id).not.toBe(seeded[ORG_A].carePlan);
  });

  it("bootstrapCarePlan opens a plan (T02 — the M7 write lifecycle is now live; full coverage in m7-care-plan-write.live)", async () => {
    // Every M7 write is live now (T02); prove the bootstrap path drives a real insert under the
    // unprivileged role. The version/sign/authoring lifecycle is exercised in the dedicated write suite.
    // Fresh patient + admission — the seeded chain already owns ADMISSION's one-per-admission slot.
    const boot = (await service.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as {
      id: string;
      status: string;
    };
    expect(boot.status).toBe("draft");
    expect(boot.id).toBeTruthy();
  });
});
