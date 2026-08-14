/**
 * GAP-040 — `rb_arrangement.nf_facility_name_snapshot`, LIVE Postgres.
 *
 * `createRbArrangement` wrote the literal string "[unresolved — M40 facility resolver deferred]" on
 * EVERY R&B arrangement, unconditionally, and the read API surfaces that field verbatim on the
 * arrangement view. M40's `MdmEntityProvider` has been registered over a Drizzle store at boot since M40
 * landed, and `facility` is one of the Phase-1 materialized kinds — the resolver was never deferred, it
 * was never called. The field had no test of any kind.
 *
 * This suite drives the production `buildDrizzleM24WriteService(...).createRbArrangement` as the
 * NOBYPASSRLS `wardenx_app` role over the REAL M40 provider composed on the REAL Drizzle MDM store.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m24:nf-facility-snapshot:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { createMdmEntityProvider } from "@wardenx/mdm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDrizzleM24WriteService } from "../src/modules/24-billing-medicaid/index";
import { createDbMdmStore } from "../src/modules/40-mdm/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG = "11111111-1111-1111-1111-111111111140";
const PE = "00000000-0000-0000-0000-000000000a40";
const USER = "00000000-0000-0000-0000-0000000ba040";
const PATIENT = "00000000-0000-0000-0000-0000000ee040";

const NF_LIVE = "00000000-0000-0000-0000-0000000fac01";
const NF_MERGED_AWAY = "00000000-0000-0000-0000-0000000fac02";
const NF_SURVIVOR = "00000000-0000-0000-0000-0000000fac03";
const NF_MISSING = "00000000-0000-0000-0000-0000000fac99";

const actor = {
  organizationId: ORG,
  userId: USER,
  roles: [] as string[],
  membershipId: USER,
  stepUpRecent: true,
};

const arrangementInput = (nfFacilityMdmId: string, effectiveFrom: string) => ({
  patientId: PATIENT,
  providerEntityId: PE,
  nfFacilityMdmId,
  effectiveFrom,
  nfPerDiemRoutineCents: 21000,
  nfPerDiemRespCents: 23000,
  nfPerDiemGipCents: 0,
  passThroughPct: 95,
  retentionPct: 5,
});

describe.skipIf(!DB_URL)("GAP-040 M24 NF-facility name snapshot — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof buildDrizzleM24WriteService>;
  /** The same service with the M40 resolver UNBOUND — the fail-closed posture check. */
  let svcUnbound: ReturnType<typeof buildDrizzleM24WriteService>;

  async function applyMigrations() {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

  const snapshotOf = async (arrangementId: string) =>
    (
      await admin.query("SELECT nf_facility_name_snapshot AS n FROM rb_arrangement WHERE id=$1", [
        arrangementId,
      ])
    ).rows[0]?.n;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m24-gap040@x.test')`, [USER]);
    await admin.query(
      `INSERT INTO provider_entity (id,organization_id,legal_name,ccn,npi,tax_id_encrypted,fiscal_year_end)
       VALUES ($1,$2,'PE','123456','1234567893','enc','12-31')`,
      [PE, ORG],
    );
    // Three M40 facility canonicals: a live one, and a merged pair (§7.2 redirect).
    await admin.query(
      "INSERT INTO facility (id,kind,name,status) VALUES ($1,'nf','Cedar Grove Nursing Center','active')",
      [NF_LIVE],
    );
    await admin.query(
      "INSERT INTO facility (id,kind,name,status) VALUES ($1,'nf','Riverbend Care Home (post-merge)','active')",
      [NF_SURVIVOR],
    );
    await admin.query(
      "INSERT INTO facility (id,kind,name,status,merged_into_id) VALUES ($1,'nf','Riverbend Care Home (old record)','merged',$2)",
      [NF_MERGED_AWAY, NF_SURVIVOR],
    );

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // The REAL M40 provider over the REAL Drizzle store — the same composition the boot path builds.
    const mdm = createMdmEntityProvider(createDbMdmStore(handle.db));
    svc = buildDrizzleM24WriteService(
      handle.db,
      undefined, // outbox — NOOP; this suite asserts the persisted snapshot, not the fan-out
      undefined, // cipher
      undefined, // coverage
      undefined, // ccnReader
      undefined, // locPeriodReader
      undefined, // signedEncounters
      undefined, // facilityKindReader
      undefined, // residenceReader
      { resolveFacility: (orgId: string, id: string) => mdm.resolveFacility(orgId, id) },
    );
    svcUnbound = buildDrizzleM24WriteService(handle.db);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("snapshots the facility's CANONICAL name — not a placeholder", async () => {
    const view = await svc.createRbArrangement(actor, arrangementInput(NF_LIVE, "2026-01-01"));
    expect(view.nfFacilityNameSnapshot).toBe("Cedar Grove Nursing Center");
    expect(await snapshotOf(view.id)).toBe("Cedar Grove Nursing Center");
    // The exact string that used to be written on every arrangement, forever.
    expect(view.nfFacilityNameSnapshot).not.toMatch(/unresolved/i);
  });

  it("follows the §7.2 merge redirect — a merged-away facility snapshots the SURVIVOR's name", async () => {
    // This is why the seam is used instead of a direct `facility` read: the tenant picked the old id,
    // and a raw SELECT would freeze a dead record's name onto a live contract.
    const view = await svc.createRbArrangement(
      actor,
      arrangementInput(NF_MERGED_AWAY, "2026-02-01"),
    );
    expect(view.nfFacilityNameSnapshot).toBe("Riverbend Care Home (post-merge)");
  });

  it("REFUSES an unresolvable facility id (422) instead of writing a placeholder", async () => {
    await expect(
      svc.createRbArrangement(actor, arrangementInput(NF_MISSING, "2026-03-01")),
    ).rejects.toMatchObject({ code: "NF_FACILITY_NOT_FOUND" });
    const rows = await admin.query("SELECT 1 FROM rb_arrangement WHERE nf_facility_mdm_id=$1", [
      NF_MISSING,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it("REFUSES the write when the M40 resolver is unbound (503) — never a silent placeholder", async () => {
    await expect(
      svcUnbound.createRbArrangement(actor, arrangementInput(NF_LIVE, "2026-04-01")),
    ).rejects.toMatchObject({ code: "MDM_FACILITY_RESOLVER_UNBOUND" });
  });

  it("keeps the snapshot FROZEN when the facility is later renamed", async () => {
    const view = await svc.createRbArrangement(actor, arrangementInput(NF_LIVE, "2026-05-01"));
    await admin.query("UPDATE facility SET name='Cedar Grove Post-Acute' WHERE id=$1", [NF_LIVE]);
    // A snapshot is the name as it stood when the contract was signed — the whole reason the column
    // exists beside `nf_facility_mdm_id`.
    expect(await snapshotOf(view.id)).toBe("Cedar Grove Nursing Center");
  });
});
