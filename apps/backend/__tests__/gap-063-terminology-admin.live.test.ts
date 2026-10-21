/**
 * GAP-063 — M38's six unbuilt §4.1 routes, LIVE Postgres.
 *
 * Six of fourteen §4.1 rows had no `app.get/post` anywhere in the app. Four of them are the whole
 * platform-ops surface, and the audit's sharpest line is that the underlying capability was missing
 * too: "there is no version-load or embeddings-refresh job/processor anywhere in the package… code
 * systems are populated only via the static seed corpus".
 *
 * The load door had to be built at the DATABASE, not in TypeScript: migration 0015 created
 * `terminology_loader NOLOGIN`, granted it INSERT/UPDATE on the twelve canonical tables, and left the
 * SECURITY DEFINER functions that were supposed to own that grant unwritten — AND created no row
 * POLICY for the role, so the grant was dead on arrival (RLS-enabled with no permissive policy is
 * default-deny; 0159 then FORCE'd RLS so not even ownership exempts it). Migration 0206 adds both.
 *
 * Everything below runs as the NOBYPASSRLS `wardenx_app` role, so a missing GRANT, a missing POLICY or
 * a missing function fails the suite rather than passing on a superuser connection (GAP-086).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m38:admin:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDrizzleCarePlanReaderStore } from "../src/modules/07-care-plan/seams/drizzle-store";
import { createCarePlanReader } from "../src/modules/07-care-plan/seams/reader";
import {
  carePlanCodeUsageProducer,
  createRemediationService,
} from "../src/modules/38-terminology/remediation-service";
import { createDbTerminologyOpsStore } from "../src/modules/38-terminology/terminology-ops-store-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "terminology_loader",
];

const ORG_A = "11111111-1111-4111-8111-111111110631";
const ORG_B = "22222222-2222-4222-8222-222222220632";
const OPERATOR = "33333333-3333-4333-8333-333333330633";

describe.skipIf(!DB_URL)("GAP-063 M38 admin surface + remediation — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let ops: ReturnType<typeof createDbTerminologyOpsStore>;
  const providerEntity: Record<string, string> = {};
  const location: Record<string, string> = {};
  const carePlan: Record<string, string> = {};

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

  /** Seed one org's provider/location/care-plan chain (superuser — RLS + grants bypassed). */
  async function seedOrg(org: string, slug: string): Promise<void> {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,$2,$3,$3,'active')",
      [org, slug, slug],
    );
    providerEntity[org] = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-${slug}`, slug, `NPI-${slug}`],
      )
    ).rows[0].id;
    location[org] = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity[org], `Loc-${slug}`],
      )
    ).rows[0].id;
    carePlan[org] = (
      await admin.query(
        `INSERT INTO care_plan (organization_id, provider_entity_id, location_id, patient_id, admission_id,
           initial_due_at)
         VALUES ($1,$2,$3,gen_random_uuid(),gen_random_uuid(), now() + interval '5 days') RETURNING id`,
        [org, providerEntity[org], location[org]],
      )
    ).rows[0].id;
  }

  /** A problem row carrying a terminology code, as superuser. */
  async function seedProblem(
    org: string,
    opts: { icd10?: string; snomed?: string; status?: string },
  ): Promise<string> {
    const r = await admin.query(
      `INSERT INTO problem (organization_id, provider_entity_id, location_id, care_plan_id,
         icd10_code, snomed_code, description, kind, status)
       VALUES ($1,$2,$3,$4,$5,$6,'seeded','terminal',$7::problem_status) RETURNING id`,
      [
        org,
        providerEntity[org],
        location[org],
        carePlan[org],
        opts.icd10 ?? null,
        opts.snomed ?? null,
        opts.status ?? "active",
      ],
    );
    return r.rows[0].id as string;
  }

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

    await seedOrg(ORG_A, "gap063a");
    await seedOrg(ORG_B, "gap063b");
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'ops@gap063.test')`, [OPERATOR]);

    // The code-system catalog the version registration FKs into.
    await admin.query(
      `INSERT INTO code_system (id, name, source_uri, license_source)
       VALUES ('icd10cm','ICD-10-CM','urn:cms:icd10cm','public'),
              ('snomed','SNOMED CT','urn:ihtsdo:snomed','umls')`,
    );
    await admin.query(
      `INSERT INTO value_set (id, name, description, scope)
       VALUES ('level_of_care','Level of care','RHC/CHC/IRC/GIP','platform'),
              ('terminal_dx','Terminal diagnosis',NULL,'hospice')`,
    );

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    ops = createDbTerminologyOpsStore(handle.db);
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM terminology_update_log");
    await admin.query("DELETE FROM deprecation_mapping");
    await admin.query("DELETE FROM code_system_version");
    await admin.query("DELETE FROM value_set_tenant_extension");
    await admin.query("DELETE FROM problem");
  });

  // ── the write door (the substance of GAP-063's admin half) ──────────────────────────────────────
  describe("version registration through terminology_loader", () => {
    it("writes a real row as wardenx_app — the grant that was dead without a row policy", async () => {
      // 0015 granted terminology_loader INSERT on code_system_version and created no policy naming it.
      // With RLS enabled (and FORCE'd by 0159) this INSERT matched nothing and reported success. If
      // migration 0206's policy is removed, this assertion is what fails.
      const result = await ops.registerVersion({
        system: "icd10cm",
        version: "2027",
        sourceFileRef: "minio://terminology/icd10cm-2027.zip",
        checksum: "a".repeat(64),
        releasedOn: "2026-06-01",
        effectiveFrom: "2026-10-01",
        loadedBy: OPERATOR,
      });
      expect(result.created).toBe(true);
      expect(result.status).toBe("loading");

      const row = (
        await admin.query("SELECT * FROM code_system_version WHERE id = $1", [result.versionId])
      ).rows[0];
      expect(row).toBeDefined();
      expect(row.version).toBe("2027");
      expect(row.checksum).toBe("a".repeat(64));
      expect(row.loaded_by).toBe(OPERATOR);
    });

    it("does NOT activate the version — as-of resolution is untouched", async () => {
      // Registering is not ingesting. A row that landed `active` would make every as-of lookup resolve
      // against a version holding zero concepts.
      const { versionId } = await ops.registerVersion({
        system: "icd10cm",
        version: "2027",
        sourceFileRef: "minio://x",
        checksum: "a".repeat(64),
        releasedOn: "2026-06-01",
        effectiveFrom: "2026-10-01",
        loadedBy: OPERATOR,
      });
      const row = (
        await admin.query("SELECT status, effective_to FROM code_system_version WHERE id = $1", [
          versionId,
        ])
      ).rows[0];
      expect(row.status).toBe("loading");
      expect(row.effective_to).toBeNull();
    });

    it("appends a load-ledger row with ZERO concept counts", async () => {
      const { versionId } = await ops.registerVersion({
        system: "icd10cm",
        version: "2027",
        sourceFileRef: "minio://x",
        checksum: "a".repeat(64),
        releasedOn: "2026-06-01",
        effectiveFrom: "2026-10-01",
        loadedBy: OPERATOR,
      });
      const log = (
        await admin.query("SELECT * FROM terminology_update_log WHERE version_id = $1", [versionId])
      ).rows[0];
      expect(log.action).toBe("loaded");
      // A non-zero count here would misreport an empty version as loaded content.
      expect(log.concept_count).toBe(0);
      expect(log.summary.phase).toBe("registered");
    });

    it("is idempotent on (system, version) — the second call writes nothing and returns the first id", async () => {
      const first = await ops.registerVersion({
        system: "icd10cm",
        version: "2027",
        sourceFileRef: "minio://x",
        checksum: "a".repeat(64),
        releasedOn: "2026-06-01",
        effectiveFrom: "2026-10-01",
        loadedBy: OPERATOR,
      });
      const second = await ops.registerVersion({
        system: "icd10cm",
        version: "2027",
        sourceFileRef: "minio://different",
        checksum: "b".repeat(64),
        releasedOn: "2026-07-01",
        effectiveFrom: "2026-11-01",
        loadedBy: OPERATOR,
      });
      expect(second.created).toBe(false);
      expect(second.versionId).toBe(first.versionId);
      const count = (await admin.query("SELECT count(*)::int AS n FROM code_system_version"))
        .rows[0].n;
      expect(count).toBe(1);
      // The losing call must not overwrite the winner's provenance either.
      const row = (
        await admin.query("SELECT source_file_ref FROM code_system_version WHERE id = $1", [
          first.versionId,
        ])
      ).rows[0];
      expect(row.source_file_ref).toBe("minio://x");
      // …and it appends no second ledger entry.
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM terminology_update_log")).rows[0].n,
      ).toBe(1);
    });

    it("refuses a system that is not in the code_system catalog", async () => {
      // `loinc` is a valid enum member but has no catalog row here — the FK would fail with a raw
      // 23503 mid-statement; the function raises a named error instead.
      const err = await ops
        .registerVersion({
          system: "loinc",
          version: "2.77",
          sourceFileRef: "minio://x",
          checksum: "a".repeat(64),
          releasedOn: "2026-06-01",
          effectiveFrom: "2026-10-01",
          loadedBy: OPERATOR,
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).not.toBeNull();
      // Drizzle wraps the driver error as "Failed query: …" and keeps the server message on `.cause`,
      // so asserting on the top-level message would pass for ANY failed query.
      const cause = (err as { cause?: { message?: string } }).cause;
      expect(`${cause?.message ?? err}`).toMatch(/TERMINOLOGY_UNKNOWN_SYSTEM/);
    });

    it("§7.4 lockdown holds: wardenx_app still cannot write a canonical table directly", async () => {
      // The function is the ONLY door. If the 0206 policy had been written for wardenx_app instead of
      // terminology_loader, this would succeed and the lockdown would be gone.
      const direct = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await direct.connect();
      await expect(
        direct.query(
          `INSERT INTO code_system_version (code_system_id, version, released_on, effective_from,
             source_file_ref, checksum) VALUES ('icd10cm','9999','2026-01-01','2026-01-01','x','y')`,
        ),
      ).rejects.toThrow(/permission denied/i);
      await direct.end();
    });
  });

  // ── embeddings refresh ──────────────────────────────────────────────────────────────────────────
  describe("embeddings-refresh request", () => {
    it("targets the system's ACTIVE version, resolved server-side", async () => {
      const active = (
        await admin.query(
          `INSERT INTO code_system_version (code_system_id, version, released_on, effective_from,
             source_file_ref, checksum, status)
           VALUES ('icd10cm','2026','2025-06-01','2025-10-01','minio://a','c1','active') RETURNING id`,
        )
      ).rows[0].id;
      // A superseded version must not be picked even though it is newer by insertion order.
      await admin.query(
        `INSERT INTO code_system_version (code_system_id, version, released_on, effective_from,
           effective_to, source_file_ref, checksum, status)
         VALUES ('icd10cm','2025','2024-06-01','2024-10-01','2025-09-30','minio://b','c2','superseded')`,
      );
      const result = await ops.requestEmbeddingRefresh("icd10cm", OPERATOR);
      expect(result.logged).toBe(true);
      expect(result.versionId).toBe(active);
      const log = (
        await admin.query("SELECT * FROM terminology_update_log WHERE action = 'embedded'")
      ).rows[0];
      expect(log.version_id).toBe(active);
      expect(log.summary.phase).toBe("requested");
    });

    it("refuses when the system has no active version, and logs nothing", async () => {
      const result = await ops.requestEmbeddingRefresh("snomed", OPERATOR);
      expect(result.logged).toBe(false);
      expect(result.versionId).toBeNull();
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM terminology_update_log")).rows[0].n,
      ).toBe(0);
    });
  });

  // ── the cross-tenant governance view ────────────────────────────────────────────────────────────
  describe("value-set extension governance view", () => {
    async function seedExtension(org: string, code: string, removed = false): Promise<string> {
      const r = await admin.query(
        `INSERT INTO value_set_tenant_extension (value_set_id, organization_id, system_id, code, reason, removed_at)
         VALUES ('level_of_care',$1,'icd10cm',$2,'local policy for governance test',$3) RETURNING id`,
        [org, code, removed ? new Date() : null],
      );
      return r.rows[0].id as string;
    }

    it("returns EVERY tenant's extensions from one wardenx_app connection", async () => {
      await seedExtension(ORG_A, "I50.22");
      await seedExtension(ORG_B, "I50.23");
      const rows = await ops.listTenantExtensions({});
      expect(rows.map((r) => r.organizationId).sort()).toEqual([ORG_A, ORG_B].sort());
    });

    it("a DIRECT read of the same table as wardenx_app sees nothing — the RLS policy still stands", async () => {
      // This is why the governance view is a definer FUNCTION and not a grant: on the tenant pool the
      // org-scoped policy applies, so a plain SELECT would silently show one tenant while the page
      // claimed to show all of them.
      await seedExtension(ORG_A, "I50.22");
      await seedExtension(ORG_B, "I50.23");
      const direct = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await direct.connect();
      const res = await direct.query("SELECT id FROM value_set_tenant_extension");
      expect(res.rows).toHaveLength(0); // no app.org_id set ⇒ the policy matches nothing
      await direct.end();
    });

    it("hides soft-deleted rows unless asked for them", async () => {
      await seedExtension(ORG_A, "I50.22");
      await seedExtension(ORG_A, "I50.24", true);
      expect(await ops.listTenantExtensions({})).toHaveLength(1);
      expect(await ops.listTenantExtensions({ includeRemoved: true })).toHaveLength(2);
    });

    it("filters by org and by value set", async () => {
      await seedExtension(ORG_A, "I50.22");
      await seedExtension(ORG_B, "I50.23");
      expect(await ops.listTenantExtensions({ organizationId: ORG_B })).toHaveLength(1);
      expect(await ops.listTenantExtensions({ valueSetId: "terminal_dx" })).toHaveLength(0);
    });

    it("pages by the (created_at, id) keyset without repeating a row", async () => {
      for (const code of ["I50.22", "I50.23", "I50.24"]) await seedExtension(ORG_A, code);
      const page1 = await ops.listTenantExtensions({ limit: 2 });
      expect(page1).toHaveLength(2);
      const last = page1[1]!;
      const page2 = await ops.listTenantExtensions({
        limit: 2,
        cursor: `${last.createdAt}|${last.extensionId}`,
      });
      expect(page2).toHaveLength(1);
      expect(page2.map((r) => r.extensionId)).not.toContain(last.extensionId);
    });
  });

  // ── the tenant reads ────────────────────────────────────────────────────────────────────────────
  describe("catalog + history reads", () => {
    it("lists the value-set catalog", async () => {
      const items = await ops.listValueSets();
      // sud_test_loinc is seeded by migration 0500 (GAP-086), the other two by this suite.
      expect(items.map((v) => v.id)).toEqual(["level_of_care", "sud_test_loinc", "terminal_dx"]);
    });

    it("returns load history newest-first, including entries with no version", async () => {
      await admin.query(
        `INSERT INTO terminology_update_log (system_id, action, at)
         VALUES ('snomed','tenant_extension_added', now() - interval '1 day'),
                ('icd10cm','expanded', now())`,
      );
      const items = await ops.loadHistory({ limit: 10 });
      expect(items.map((h) => h.action)).toEqual(["expanded", "tenant_extension_added"]);
      expect(items[1]?.versionId).toBeNull(); // the LEFT JOIN keeps it
    });

    it("bounds deprecations by the `since` date and by system", async () => {
      const v = (
        await admin.query(
          `INSERT INTO code_system_version (code_system_id, version, released_on, effective_from,
             source_file_ref, checksum, status)
           VALUES ('icd10cm','2026','2025-06-01','2025-10-01','minio://a','c1','active') RETURNING id`,
        )
      ).rows[0].id;
      await admin.query(
        `INSERT INTO deprecation_mapping (system_id, deprecated_code, deprecation_effective,
           successor_codes, mapping_kind, created_in_version_id)
         VALUES ('icd10cm','I50.20','2026-01-01','{"I50.21"}','equivalent',$1),
                ('icd10cm','OLD.1','2020-01-01','{"NEW.1"}','equivalent',$1)`,
        [v],
      );
      expect(await ops.deprecationsSince("2025-01-01")).toHaveLength(1);
      expect(await ops.deprecationsSince("2019-01-01")).toHaveLength(2);
      expect(await ops.deprecationsSince("2019-01-01", "snomed")).toHaveLength(0);
    });
  });

  // ── the §7.3 remediation report, end to end over live rows ──────────────────────────────────────
  describe("remediation report over the M7 problem-list producer", () => {
    async function seedDeprecations(): Promise<void> {
      const v = (
        await admin.query(
          `INSERT INTO code_system_version (code_system_id, version, released_on, effective_from,
             source_file_ref, checksum, status)
           VALUES ('icd10cm','2026','2025-06-01','2025-10-01','minio://a','c1','active') RETURNING id`,
        )
      ).rows[0].id;
      await admin.query(
        `INSERT INTO deprecation_mapping (system_id, deprecated_code, deprecation_effective,
           successor_codes, mapping_kind, created_in_version_id)
         VALUES ('icd10cm','I50.20','2026-01-01','{"I50.21"}','equivalent',$1)`,
        [v],
      );
    }

    const service = () =>
      createRemediationService({
        ops,
        producers: [
          carePlanCodeUsageProducer(() =>
            createCarePlanReader(createDrizzleCarePlanReaderStore(handle.db)),
          ),
        ],
      });

    it("finds this org's problems on a deprecated code", async () => {
      await seedDeprecations();
      const p1 = await seedProblem(ORG_A, { icd10: "I50.20" });
      await seedProblem(ORG_A, { icd10: "I50.21" }); // current code — not remediation work
      const report = await service().report({ organizationId: ORG_A, since: "2025-01-01" });
      expect(report.totalAffected).toBe(1);
      expect(report.items[0]?.deprecatedCode).toBe("I50.20");
      expect(report.items[0]?.sampleRecordIds).toEqual([p1]);
      expect(report.items[0]?.recommendedAction).toBe("update_to_successor");
    });

    it("does NOT leak another tenant's rows — RLS scopes the producer", async () => {
      await seedDeprecations();
      await seedProblem(ORG_B, { icd10: "I50.20" });
      const report = await service().report({ organizationId: ORG_A, since: "2025-01-01" });
      expect(report.totalAffected).toBe(0);
      // …and the same call for org B does find it, so the zero above is scoping, not a broken query.
      const bReport = await service().report({ organizationId: ORG_B, since: "2025-01-01" });
      expect(bReport.totalAffected).toBe(1);
    });

    it("ignores resolved and inactive problems", async () => {
      await seedDeprecations();
      await seedProblem(ORG_A, { icd10: "I50.20", status: "resolved" });
      await seedProblem(ORG_A, { icd10: "I50.20", status: "inactive" });
      const report = await service().report({ organizationId: ORG_A, since: "2025-01-01" });
      expect(report.totalAffected).toBe(0);
    });

    it("reads BOTH code columns — a SNOMED-only problem is found too", async () => {
      const v = (
        await admin.query(
          `INSERT INTO code_system_version (code_system_id, version, released_on, effective_from,
             source_file_ref, checksum, status)
           VALUES ('snomed','2026','2025-06-01','2025-10-01','minio://s','c2','active') RETURNING id`,
        )
      ).rows[0].id;
      await admin.query(
        `INSERT INTO deprecation_mapping (system_id, deprecated_code, deprecation_effective,
           successor_codes, mapping_kind, created_in_version_id)
         VALUES ('snomed','88805009','2026-01-01','{"84114007"}','broader',$1)`,
        [v],
      );
      await seedProblem(ORG_A, { snomed: "88805009" });
      const report = await service().report({ organizationId: ORG_A, since: "2025-01-01" });
      expect(report.totalAffected).toBe(1);
      expect(report.items[0]?.systemId).toBe("snomed");
      // A `broader` mapping is never a mechanical swap.
      expect(report.items[0]?.recommendedAction).toBe("manual_review");
    });

    it("says which record classes it consulted", async () => {
      await seedDeprecations();
      const report = await service().report({ organizationId: ORG_A, since: "2025-01-01" });
      expect(report.coveredRecordTypes).toEqual(["problem_list"]);
    });
  });
});
