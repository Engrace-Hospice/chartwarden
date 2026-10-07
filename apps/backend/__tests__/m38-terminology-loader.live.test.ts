/**
 * GAP-108 — M38's terminology LOADER and its nine §4.3 jobs, LIVE Postgres (+ Valkey for the BullMQ test).
 *
 * Before: no worker existed, `packages/terminology-loader` did not exist, the admin load route only registered a
 * version row (`pending_loader_worker`), and ICD-10-CM could only be loaded out of band by a superuser script.
 *
 * Everything below runs as the NOBYPASSRLS `wardenx_app` role (GAP-086): the loader's writes go through the
 * migration-0364 `terminology_loader_*` SECURITY DEFINER functions, so a missing grant, policy or function fails the
 * suite instead of passing on a superuser connection. Fixtures are tiny, hand-made and invented (no licensed content).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… WARDENX_TEST_REDIS_URL=redis://… bun run test:m38:loader:live
 * (valkey/valkey:8, not redis; for a local PG without pgvector also set WARDENX_TEST_NO_PGVECTOR=1 — the embeddings
 *  test then skips itself).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { createTerminologyProvider } from "@wardenx/terminology";
import {
  EMBEDDING_DIMENSIONS,
  type LoadVersionDeps,
  type LoadableSystemId,
  PUBLIC_SOURCE_ADAPTERS,
  SILENT_LOGGER,
  createInMemoryObjects,
  createRecordingFollowUps,
  embedderUnavailable,
  licensedSourceDenyStub,
  refreshExpansionsForSystem,
  runLoadVersion,
  runRefreshEmbeddings,
  sha256Hex,
} from "@wardenx/terminology-loader";
import type { Queue } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CARC_CSV,
  CVX_TXT,
  HCPCS_FIXED,
  ICD10CM_ORDER_2026,
  ICD10CM_ORDER_2027,
  ICD10PCS_ORDER,
  LOINC_CSV,
  NDC_PACKAGE,
  NDC_PRODUCT,
  REVENUE_CSV,
  RXNCONSO,
  RXNREL,
  RXNSAT,
  SNOMED_CONCEPT,
  SNOMED_DESC,
  SNOMED_REL,
  bytes,
  zip,
} from "../../../packages/terminology-loader/__tests__/_fixtures";
import { createDrizzleCarePlanReaderStore } from "../src/modules/07-care-plan/seams/drizzle-store";
import { createCarePlanReader } from "../src/modules/07-care-plan/seams/reader";
import {
  M38_PLATFORM_JOB_ID,
  TERMINOLOGY_QUEUES,
  buildTerminologyProducer,
  carePlanCodeUsageProducer,
  createDbEmbeddingStore,
  createDbExpansionWriter,
  createDbLoaderStore,
  createDbTerminologyOpsStore,
  createDbTerminologyStore,
  registerM38Workers,
  runTenantDeprecationScanJob,
  scheduleM38Jobs,
} from "../src/modules/38-terminology/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const REDIS_URL = process.env.WARDENX_TEST_REDIS_URL;
const NO_PGVECTOR = !!process.env.WARDENX_TEST_NO_PGVECTOR;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "terminology_loader",
];

const ORG_A = "11111111-1111-4111-8111-111111110801";
const ORG_B = "22222222-2222-4222-8222-222222220802";
const OPERATOR = "33333333-3333-4333-8333-333333330803";

describe.skipIf(!DB_URL)("GAP-108 M38 terminology loader + jobs — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let ops: ReturnType<typeof createDbTerminologyOpsStore>;
  let store: ReturnType<typeof createDbLoaderStore>;
  let provider: ReturnType<typeof createTerminologyProvider>;
  const providerEntity: Record<string, string> = {};
  const location: Record<string, string> = {};
  const carePlan: Record<string, string> = {};

  const objects = createInMemoryObjects();
  const followUps = createRecordingFollowUps();
  const deps = (over: Partial<LoadVersionDeps> = {}): LoadVersionDeps => ({
    store,
    objects,
    followUps,
    log: SILENT_LOGGER,
    today: () => new Date().toISOString().slice(0, 10),
    embeddingsAvailable: false,
    ...over,
  });

  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (NO_PGVECTOR)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

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
        `INSERT INTO care_plan (organization_id, provider_entity_id, location_id, patient_id, admission_id, initial_due_at)
         VALUES ($1,$2,$3,gen_random_uuid(),gen_random_uuid(), now() + interval '5 days') RETURNING id`,
        [org, providerEntity[org], location[org]],
      )
    ).rows[0].id;
  }

  async function seedProblem(org: string, icd10: string): Promise<string> {
    const r = await admin.query(
      `INSERT INTO problem (organization_id, provider_entity_id, location_id, care_plan_id, icd10_code, description, kind, status)
       VALUES ($1,$2,$3,$4,$5,'seeded','terminal','active') RETURNING id`,
      [org, providerEntity[org], location[org], carePlan[org], icd10],
    );
    return r.rows[0].id as string;
  }

  /** Put a source file in the (in-memory) platform bucket and register it through the REAL definer function. */
  async function register(
    system: LoadableSystemId,
    version: string,
    effectiveFrom: string,
    file: Uint8Array,
    checksum?: string,
  ): Promise<string> {
    const key = `terminology/${system}/${version}`;
    objects.objects.set(key, file);
    const reg = await ops.registerVersion({
      system,
      version,
      sourceFileRef: key,
      checksum: checksum ?? sha256Hex(file),
      releasedOn: "2026-06-01",
      effectiveFrom,
      loadedBy: OPERATOR,
    });
    return reg.versionId;
  }

  const count = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await admin.query(sql, params)).rows[0].n);

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
    await seedOrg(ORG_A, "gap108a");
    await seedOrg(ORG_B, "gap108b");
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'ops@gap108.test')`, [OPERATOR]);
    // icd10cm carries the free-text label an older loader wrote: still PUBLIC, so it must not be gated.
    await admin.query(
      `INSERT INTO code_system (id, name, source_uri, license_source) VALUES
         ('icd10cm','ICD-10-CM','urn:cms:icd10cm','CDC/NCHS (public domain)'),
         ('snomed','SNOMED CT US','urn:ihtsdo:snomed','umls'),
         ('loinc','LOINC','http://loinc.org','regenstrief'),
         ('rxnorm','RxNorm','urn:nlm:rxnorm','umls'),
         ('icd10pcs','ICD-10-PCS','urn:cms:icd10pcs','public'),
         ('ndc','NDC','urn:fda:ndc','public'),
         ('hcpcs','HCPCS','urn:cms:hcpcs','public'),
         ('cvx','CVX','urn:cdc:cvx','public'),
         ('revenue','UB-04 revenue','urn:nubc:revenue','public'),
         ('carc','X12 CARC','urn:x12:carc','public'),
         ('rarc','X12 RARC','urn:x12:rarc','public')`,
    );
    await admin.query(
      `INSERT INTO value_set (id, name, description, scope) VALUES ('terminal_dx','Terminal diagnosis',NULL,'hospice')`,
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    ops = createDbTerminologyOpsStore(handle.db);
    store = createDbLoaderStore(handle.db);
    provider = createTerminologyProvider(createDbTerminologyStore(handle.db));
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  beforeEach(() => {
    followUps.calls.length = 0;
  });

  // ── §7.4 still holds, and the staging area is invisible to tenant traffic ───────────────────────
  it("wardenx_app still cannot write a canonical table or even read the staging area", async () => {
    await expect(
      handle.db.execute(
        "INSERT INTO concept_hcpcs (code, display, status, effective_date, version_id) VALUES ('A1','x','active','2026-01-01',gen_random_uuid())" as never,
      ),
    ).rejects.toThrow();
    await expect(handle.db.execute("SELECT * FROM concept_staging" as never)).rejects.toThrow();
    await expect(
      handle.db.execute("UPDATE terminology_license_attestation SET licensee = 'x'" as never),
    ).rejects.toThrow();
  });

  // ── load → stage → active, two versions coexisting ──────────────────────────────────────────────
  describe("ICD-10-CM: load → stage → active, then a second version", () => {
    let v26: string;
    let v27: string;

    it("a staged version is NOT visible to clinical lookups; activation makes it so", async () => {
      v26 = await register("icd10cm", "FY2026", "2025-10-01", bytes(ICD10CM_ORDER_2026));
      expect((await store.getVersion(v26))?.status).toBe("loading");

      const staged = await runLoadVersion(deps(), { versionId: v26, activate: false });
      expect(staged.outcome).toBe("staged");
      expect((await store.getVersion(v26))?.status).toBe("staged");
      expect(
        await count(
          "SELECT count(*) AS n FROM concept_staging WHERE version_id = $1 AND kind = 'concept'",
          [v26],
        ),
      ).toBe(5);
      expect(
        await count("SELECT count(*) AS n FROM concept_icd10cm WHERE version_id = $1", [v26]),
      ).toBe(0);
      expect(await provider.lookup("icd10cm", "I42.0", new Date("2026-01-15"))).toBeNull();

      const done = await runLoadVersion(deps(), { versionId: v26 });
      expect(done).toMatchObject({ outcome: "activated", stage: null });
      expect((await store.getVersion(v26))?.status).toBe("active");
      expect(
        await count("SELECT count(*) AS n FROM concept_staging WHERE version_id = $1", [v26]),
      ).toBe(0);
      const hit = await provider.lookup("icd10cm", "I42.0", new Date("2026-01-15"));
      expect(hit).toMatchObject({
        code: "I42.0",
        status: "active",
        properties: { isBillableLeaf: true, parentCode: "I42" },
      });
      // typed columns were split out of the staged properties
      const row = (
        await admin.query(
          "SELECT is_billable_leaf, parent_code, properties FROM concept_icd10cm WHERE code='I42.0' AND version_id=$1",
          [v26],
        )
      ).rows[0];
      expect(row.is_billable_leaf).toBe(true);
      expect(row.parent_code).toBe("I42");
      expect(row.properties.isBillableLeaf).toBeUndefined();
    });

    it("the ledger records registered → staged → activated", async () => {
      const phases = (
        await admin.query(
          "SELECT summary->>'phase' AS phase FROM terminology_update_log WHERE version_id=$1 AND action='loaded' ORDER BY at, id",
          [v26],
        )
      ).rows.map((r) => r.phase);
      expect(phases).toEqual(expect.arrayContaining(["registered", "staged", "activated"]));
    });

    it("a newer version supersedes the prior WITHOUT deleting it; deprecations are mapped", async () => {
      v27 = await register("icd10cm", "FY2027", "2026-10-01", bytes(ICD10CM_ORDER_2027));
      const out = await runLoadVersion(deps({ embeddingsAvailable: true }), { versionId: v27 });
      expect(out).toMatchObject({
        outcome: "activated",
        activation: { supersededVersionId: v26, deprecations: 2, newCodes: 2 },
      });
      expect(followUps.calls).toEqual(
        expect.arrayContaining([
          `expansions:icd10cm:${v27}`,
          `embeddings:icd10cm:${v27}`,
          `scan:icd10cm:${v27}`,
        ]),
      );

      const prior = (
        await admin.query(
          "SELECT status, to_char(effective_to, 'YYYY-MM-DD') AS eto FROM code_system_version WHERE id=$1",
          [v26],
        )
      ).rows[0];
      expect(prior).toMatchObject({ status: "superseded", eto: "2026-09-30" });
      // both versions' rows exist; the older ones end the day before the new span
      expect(
        await count("SELECT count(*) AS n FROM concept_icd10cm WHERE version_id=$1", [v26]),
      ).toBe(5);
      expect(
        await count("SELECT count(*) AS n FROM concept_icd10cm WHERE version_id=$1", [v27]),
      ).toBe(6);
      // as-of resolution picks the version in force on the date
      expect(
        (await provider.lookup("icd10cm", "I42.0", new Date("2026-06-01")))?.properties,
      ).toMatchObject({ isBillableLeaf: true });
      expect(
        (await provider.lookup("icd10cm", "I42.0", new Date("2026-11-01")))?.properties,
      ).toMatchObject({ isBillableLeaf: false });
      // a code the new release dropped: valid before, not after
      expect((await provider.validate("icd10cm", "Z51.5", new Date("2026-06-01"))).valid).toBe(
        true,
      );
      expect((await provider.validate("icd10cm", "Z51.5", new Date("2026-11-01"))).valid).toBe(
        false,
      );
      // deprecation mapping with successors
      expect(await provider.getDeprecationMapping("icd10cm", "I42.0")).toMatchObject({
        mappingKind: "narrower",
        successorCodes: ["I42.00", "I42.01"],
      });
      expect(await provider.getDeprecationMapping("icd10cm", "Z51.5")).toMatchObject({
        mappingKind: "none",
        successorCodes: [],
      });
      // never DELETEs a concept row (§7.2)
      expect(
        await count(
          "SELECT count(*) AS n FROM audit_event WHERE event_type = 'concept_icd10cm.delete'",
        ),
      ).toBe(0);
    });

    it("is idempotent: a re-run is a no-op and a direct re-activation reports zeros", async () => {
      const before = await count("SELECT count(*) AS n FROM terminology_update_log");
      expect(await runLoadVersion(deps(), { versionId: v27 })).toEqual({
        outcome: "noop",
        status: "active",
      });
      expect(await store.activate(v27, null)).toMatchObject({
        concepts: 0,
        deprecations: 0,
        supersededVersionId: null,
      });
      expect(await count("SELECT count(*) AS n FROM terminology_update_log")).toBe(before);
      expect(
        await count("SELECT count(*) AS n FROM concept_icd10cm WHERE version_id=$1", [v27]),
      ).toBe(6);
    });

    it("refuses a version that is not newer than the active one and fails it cleanly", async () => {
      const stale = await register(
        "icd10cm",
        "FY2026-rebuild",
        "2025-10-01",
        bytes(ICD10CM_ORDER_2026),
      );
      const out = await runLoadVersion(deps(), { versionId: stale });
      expect(out).toMatchObject({ outcome: "failed" });
      expect((out as { reason: string }).reason).toMatch(/VERSION_NOT_NEWER/);
      expect(
        await count("SELECT count(*) AS n FROM concept_staging WHERE version_id=$1", [stale]),
      ).toBe(0);
      expect(
        await count("SELECT count(*) AS n FROM concept_icd10cm WHERE version_id=$1", [stale]),
      ).toBe(0);
    });
  });

  // ── failure leaves no residue; retry; resume ────────────────────────────────────────────────────
  describe("failure, retry and resume", () => {
    it("a checksum mismatch FAILS the version with no staging rows and no concept rows", async () => {
      const id = await register(
        "icd10cm",
        "FY2028-bad",
        "2027-10-01",
        bytes(ICD10CM_ORDER_2027),
        "0".repeat(64),
      );
      const out = await runLoadVersion(deps(), { versionId: id });
      expect(out).toMatchObject({ outcome: "failed" });
      expect((out as { reason: string }).reason).toMatch(/CHECKSUM_MISMATCH/);
      expect((await store.getVersion(id))?.status).toBe("failed");
      expect(
        await count("SELECT count(*) AS n FROM concept_staging WHERE version_id=$1", [id]),
      ).toBe(0);
      expect(
        await count("SELECT count(*) AS n FROM concept_icd10cm WHERE version_id=$1", [id]),
      ).toBe(0);
      expect(
        await count(
          "SELECT count(*) AS n FROM deprecation_mapping WHERE created_in_version_id=$1",
          [id],
        ),
      ).toBe(0);
      const reason = (
        await admin.query(
          "SELECT summary->>'reason' AS r FROM terminology_update_log WHERE version_id=$1 AND summary->>'phase'='failed'",
          [id],
        )
      ).rows[0];
      expect(reason.r).toMatch(/CHECKSUM_MISMATCH/);
      // a failed version is not "in force" for FHIR metadata either
      expect(
        (await createDbTerminologyStore(handle.db).codeSystemMeta("icd10cm", "2027-11-01")).version,
      ).not.toBe("FY2028-bad");
    });

    it("re-registering the failed (system, version) with the right checksum retries it", async () => {
      const file = bytes(ICD10CM_ORDER_2027);
      const key = "terminology/icd10cm/FY2028-bad";
      objects.objects.set(key, file);
      const reg = await ops.registerVersion({
        system: "icd10cm",
        version: "FY2028-bad",
        sourceFileRef: key,
        checksum: sha256Hex(file),
        releasedOn: "2026-06-01",
        effectiveFrom: "2027-10-01",
        loadedBy: OPERATOR,
      });
      expect(reg).toMatchObject({ created: true, status: "loading" });
      expect((await runLoadVersion(deps(), { versionId: reg.versionId })).outcome).toBe(
        "activated",
      );
    });

    it("a crash mid-staging is restarted from scratch, never duplicating or tripping on partial rows", async () => {
      const id = await register("icd10cm", "FY2029-crash", "2028-10-01", bytes(ICD10CM_ORDER_2027));
      // simulate the previous run dying after one chunk
      await store.stageRows(
        id,
        "concept",
        [
          {
            code: "ZZZ.1",
            display: "partial",
            status: "active",
            effectiveDate: null,
            endDate: null,
            properties: {},
          },
        ],
        true,
      );
      expect(
        await count("SELECT count(*) AS n FROM concept_staging WHERE version_id=$1", [id]),
      ).toBe(1);
      const out = await runLoadVersion(deps(), { versionId: id });
      expect(out.outcome).toBe("activated");
      expect(
        await count(
          "SELECT count(*) AS n FROM concept_icd10cm WHERE version_id=$1 AND code='ZZZ.1'",
          [id],
        ),
      ).toBe(0);
      expect(
        await count("SELECT count(*) AS n FROM concept_icd10cm WHERE version_id=$1", [id]),
      ).toBe(6);
    });

    it("resumes from staged without touching the source file", async () => {
      const id = await register(
        "icd10cm",
        "FY2030-resume",
        "2029-10-01",
        bytes(ICD10CM_ORDER_2027),
      );
      expect((await runLoadVersion(deps(), { versionId: id, activate: false })).outcome).toBe(
        "staged",
      );
      const reads = objects.reads.length;
      objects.objects.delete("terminology/icd10cm/FY2030-resume"); // the file is gone: a resume must not need it
      expect((await runLoadVersion(deps(), { versionId: id })).outcome).toBe("activated");
      expect(objects.reads).toHaveLength(reads);
    });
  });

  // ── licence gate + attribution ──────────────────────────────────────────────────────────────────
  describe("licence attestation gate (SNOMED / LOINC / RxNorm)", () => {
    const snomedFile = zip({
      "sct2_Concept_Snapshot_US.txt": SNOMED_CONCEPT,
      "sct2_Description_Snapshot-en_US.txt": SNOMED_DESC,
      "sct2_Relationship_Snapshot_US.txt": SNOMED_REL,
    });
    const loincFile = zip({ "LoincTable/Loinc.csv": LOINC_CSV });
    const rxnormFile = zip({
      "rrf/RXNCONSO.RRF": RXNCONSO,
      "rrf/RXNSAT.RRF": RXNSAT,
      "rrf/RXNREL.RRF": RXNREL,
    });

    it.each([
      ["snomed", snomedFile],
      ["loinc", loincFile],
      ["rxnorm", rxnormFile],
    ] as const)(
      "%s: registration is REFUSED by the database without an attestation",
      async (system, file) => {
        await expect(register(system, "gated-1", "2026-01-01", file)).rejects.toThrow(
          /TERMINOLOGY_LICENSE_ATTESTATION_REQUIRED/,
        );
        expect(
          await count(
            "SELECT count(*) AS n FROM code_system_version WHERE code_system_id=$1::code_system_id",
            [system],
          ),
        ).toBe(0);
      },
    );

    it("a public system cannot be attested; a licensed one can, and the gate opens", async () => {
      await expect(
        ops.recordLicenseAttestation({
          system: "icd10cm",
          licensee: "x",
          licenseReference: "y",
          attestedBy: OPERATOR,
          effectiveFrom: "2026-01-01",
          effectiveTo: null,
          attributionText: "z",
        }),
      ).rejects.toThrow(/TERMINOLOGY_LICENSE_NOT_REQUIRED/);

      for (const [system, text] of [
        ["snomed", "SNOMED CT is used under licence from SNOMED International (test)."],
        ["loinc", "LOINC is copyright Regenstrief Institute (test)."],
        ["rxnorm", "RxNorm is a trademark of the NLM (test)."],
      ] as const) {
        const { attestationId } = await ops.recordLicenseAttestation({
          system,
          licensee: "WardenX Platform",
          licenseReference: `REF-${system}`,
          attestedBy: OPERATOR,
          effectiveFrom: "2026-01-01",
          effectiveTo: null,
          attributionText: text,
        });
        expect(attestationId).toMatch(/^[0-9a-f-]{36}$/);
      }
      expect((await ops.activeAttributions()).map((a) => a.systemId).sort()).toEqual([
        "loinc",
        "rxnorm",
        "snomed",
      ]);
    });

    it("SNOMED loads once attested: typed columns, hierarchy path, FHIR copyright", async () => {
      const id = await register("snomed", "2024-03", "2024-03-01", snomedFile);
      expect((await runLoadVersion(deps(), { versionId: id })).outcome).toBe("activated");
      const row = (
        await admin.query(
          "SELECT display, fully_specified_name, semantic_tag, hierarchy_path FROM concept_snomed WHERE code='900001002' AND version_id=$1",
          [id],
        )
      ).rows[0];
      expect(row).toMatchObject({
        display: "Synthetic child disorder",
        semantic_tag: "disorder",
        hierarchy_path: ["900001001"],
      });
      expect(await provider.lookup("snomed", "900001002", new Date("2024-06-01"))).toMatchObject({
        properties: { semanticTag: "disorder", hierarchyPath: ["900001001"] },
      });
      expect((await provider.asFhirCodeSystem("snomed", new Date("2024-06-01"))).copyright).toMatch(
        /SNOMED International/,
      );
    });

    it("LOINC and RxNorm load with their typed columns", async () => {
      const l = await register("loinc", "2.78", "2024-02-01", loincFile);
      expect((await runLoadVersion(deps(), { versionId: l })).outcome).toBe("activated");
      expect(
        (
          await admin.query(
            "SELECT component, scale, short_name, status FROM concept_loinc WHERE code='99990-1'",
          )
        ).rows[0],
      ).toMatchObject({ component: "Synthetic analyte", scale: "Qn", status: "active" });
      expect(
        (await admin.query("SELECT status FROM concept_loinc WHERE code='99991-9'")).rows[0].status,
      ).toBe("retired");

      const r = await register("rxnorm", "2024-03-04", "2024-03-04", rxnormFile);
      expect((await runLoadVersion(deps(), { versionId: r })).outcome).toBe("activated");
      expect(
        (
          await admin.query(
            "SELECT tty, ingredient_rxcui, ndcs FROM concept_rxnorm WHERE code='200'",
          )
        ).rows[0],
      ).toMatchObject({
        tty: "SCD",
        ingredient_rxcui: "100",
        ndcs: ["11112222203", "11112222205"],
      });
    });

    it("a revoked attestation closes the gate (at registration AND at activation) and drops the attribution", async () => {
      const staged = await register("snomed", "2024-09", "2024-09-01", snomedFile);
      expect((await runLoadVersion(deps(), { versionId: staged, activate: false })).outcome).toBe(
        "staged",
      );
      const att = (await ops.listLicenseAttestations("snomed"))[0];
      expect(await ops.revokeLicenseAttestation(att?.id as string, OPERATOR)).toBe(true);
      expect(await ops.revokeLicenseAttestation(att?.id as string, OPERATOR)).toBe(false);

      // the orchestrator refuses on the pure gate…
      const out = await runLoadVersion(deps(), { versionId: staged });
      expect(out).toMatchObject({ outcome: "failed" });
      expect((out as { reason: string }).reason).toMatch(/LICENSE_ATTESTATION_REVOKED/);
      // …and the database refuses by itself if the orchestrator is bypassed
      await expect(store.activate(staged, null)).rejects.toThrow();
      await expect(register("snomed", "2025-03", "2025-03-01", snomedFile)).rejects.toThrow(
        /ATTESTATION_REQUIRED/,
      );
      expect((await ops.activeAttributions()).some((a) => a.systemId === "snomed")).toBe(false);
      expect(
        (await provider.asFhirCodeSystem("snomed", new Date("2024-06-01"))).copyright,
      ).toBeUndefined();
    });
  });

  // ── the seven common-shape systems (concept tables created by 0364) ─────────────────────────────
  describe("tier-1 common-shape systems load through the same pipeline", () => {
    it.each([
      ["icd10pcs", () => bytes(ICD10PCS_ORDER), "concept_icd10pcs", 2, "0016070"],
      ["hcpcs", () => bytes(HCPCS_FIXED), "concept_hcpcs", 4, "Q5001"],
      [
        "ndc",
        () => zip({ "product.txt": NDC_PRODUCT, "package.txt": NDC_PACKAGE }),
        "concept_ndc",
        3,
        "01111222203",
      ],
      ["cvx", () => bytes(CVX_TXT), "concept_cvx", 3, "21"],
      ["revenue", () => bytes(REVENUE_CSV), "concept_revenue", 2, "0651"],
      ["carc", () => bytes(CARC_CSV), "concept_carc", 2, "A1"],
      ["rarc", () => bytes("code,display\nN1,Alert\nMA01,Remark\n"), "concept_rarc", 2, "MA01"],
    ] as const)(
      "%s: load -> stage -> active, readable through the provider",
      async (system, file, table, n, probe) => {
        const id = await register(system, "t1-load", "2026-01-01", file());
        expect((await runLoadVersion(deps(), { versionId: id })).outcome).toBe("activated");
        expect(await count(`SELECT count(*) AS n FROM ${table} WHERE version_id=$1`, [id])).toBe(n);
        expect(
          await count("SELECT count(*) AS n FROM concept_staging WHERE version_id=$1", [id]),
        ).toBe(0);
        const hit = await provider.lookup(system, probe, new Date("2026-06-01"));
        expect(hit?.code).toBe(probe);
      },
    );

    it("HCPCS surfaces Q-codes and the modifier flag; a terminated G-code is valid before its end date only", async () => {
      expect((await provider.lookup("hcpcs", "Q5001", new Date("2026-06-01")))?.properties).toEqual(
        { kind: "code" },
      );
      expect((await provider.lookup("hcpcs", "26", new Date("2026-06-01")))?.properties).toEqual({
        kind: "modifier",
      });
      expect((await provider.validate("hcpcs", "G0300", new Date("2026-06-01"))).valid).toBe(true);
      expect((await provider.validate("hcpcs", "G0300", new Date("2027-02-01"))).valid).toBe(false);
    });

    it("a CPT-shaped HCPCS file fails the version with no rows (D4)", async () => {
      const id = await register(
        "hcpcs",
        "t1-cpt",
        "2026-02-01",
        bytes("code,display\n99213,Office visit\n"),
      );
      const out = await runLoadVersion(deps(), { versionId: id });
      expect(out).toMatchObject({ outcome: "failed" });
      expect((out as { reason: string }).reason).toMatch(/CPT_NOT_LOADABLE|CODE_INVALID/);
      expect(await count("SELECT count(*) AS n FROM concept_hcpcs WHERE version_id=$1", [id])).toBe(
        0,
      );
    });
  });

  // ── refresh_expansions / refresh_embeddings ─────────────────────────────────────────────────────
  describe("follow-up jobs", () => {
    it("refresh_expansions materialises value-set members and is idempotent", async () => {
      await admin.query(
        `INSERT INTO value_set_member (value_set_id, system_id, code, member_effective) VALUES
           ('terminal_dx','icd10cm','C50.91','2025-10-01'), ('terminal_dx','icd10cm','I42.00','2026-10-01')`,
      );
      const writer = createDbExpansionWriter(handle.db);
      const first = await refreshExpansionsForSystem("icd10cm", writer, SILENT_LOGGER);
      expect(first).toMatchObject({ valueSetIds: ["terminal_dx"], rowsWritten: 2 });
      expect(
        await count(
          "SELECT count(*) AS n FROM value_set_expansion WHERE value_set_id='terminal_dx'",
        ),
      ).toBe(2);
      await refreshExpansionsForSystem("icd10cm", writer, SILENT_LOGGER);
      expect(
        await count(
          "SELECT count(*) AS n FROM value_set_expansion WHERE value_set_id='terminal_dx'",
        ),
      ).toBe(2);
      expect(
        await provider.isMemberOf("terminal_dx", "icd10cm", "C50.91", {
          asOf: new Date("2026-01-01"),
        }),
      ).toMatchObject({ isMember: true });
      expect(
        await count("SELECT count(*) AS n FROM terminology_update_log WHERE action='expanded'"),
      ).toBe(2);
    });

    it.skipIf(NO_PGVECTOR)(
      "refresh_embeddings writes vectors for the active version through the loader door, only once",
      async () => {
        const embedder = {
          available: true,
          modelId: "test-embedder",
          embed: async (texts: readonly string[]) =>
            texts.map((t) =>
              Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => ((t.length + i) % 7) / 10),
            ),
        };
        const run = () =>
          runRefreshEmbeddings(
            { store: createDbEmbeddingStore(handle.db), embedder, log: SILENT_LOGGER },
            "icd10cm",
          );
        const first = await run();
        const active = (
          await admin.query(
            "SELECT id FROM code_system_version WHERE code_system_id='icd10cm' AND status='active' AND effective_to IS NULL",
          )
        ).rows[0].id;
        expect(first.outcome).toBe("refreshed");
        expect(first.embedded).toBeGreaterThan(0);
        expect(
          await count("SELECT count(*) AS n FROM concept_embedding WHERE asof_version=$1", [
            active,
          ]),
        ).toBe(first.embedded);
        expect((await run()).embedded).toBe(0);
        // not faked when the backend is absent
        expect(
          (
            await runRefreshEmbeddings(
              {
                store: createDbEmbeddingStore(handle.db),
                embedder: embedderUnavailable,
                log: SILENT_LOGGER,
              },
              "icd10cm",
            )
          ).outcome,
        ).toBe("embedder_unavailable");
        // wardenx_app cannot write vectors directly
        await expect(handle.db.execute("DELETE FROM concept_embedding" as never)).rejects.toThrow();
      },
    );
  });

  // ── tenant isolation ────────────────────────────────────────────────────────────────────────────
  describe("tenant_deprecation_scan and tenant extensions are tenant-isolated", () => {
    const carePlanProducer = () =>
      carePlanCodeUsageProducer(() =>
        createCarePlanReader(createDrizzleCarePlanReaderStore(handle.db)),
      );
    const orgs = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    const quiet = { error() {}, info() {} };
    const scanJob = async () => ({
      system: "icd10cm",
      versionId: (
        await admin.query(
          "SELECT id FROM code_system_version WHERE code_system_id='icd10cm' AND version='FY2027'",
        )
      ).rows[0].id as string,
      effectiveFrom: "2026-10-01",
    });
    const progressOf = () => {
      const done = new Set<string>();
      return { completedOrgs: done, markCompleted: async (o: string) => void done.add(o) };
    };

    it("alerts only the org that uses a deprecated code, with only its own counts", async () => {
      await admin.query("DELETE FROM problem");
      await seedProblem(ORG_A, "I42.0");
      await seedProblem(ORG_B, "C50.91");
      const alerts: { org: string; payload: Record<string, unknown> }[] = [];
      const progress = progressOf();
      const result = await runTenantDeprecationScanJob(
        {
          activeOrgs: orgs,
          ops,
          producers: [carePlanProducer()],
          alerts: { emit: async (org, input) => void alerts.push({ org, payload: input.payload }) },
          log: quiet,
        },
        await scanJob(),
        progress,
      );
      expect(result).toMatchObject({ orgsScanned: 2, orgsAlerted: 1, deprecatedCodes: 2 });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.org).toBe(ORG_A);
      expect(alerts[0]?.payload).toMatchObject({
        system: "icd10cm",
        affectedRecordCount: 1,
        sampleCodes: ["I42.0"],
      });
      expect(JSON.stringify(alerts[0])).not.toContain("C50.91");
      expect([...progress.completedOrgs].sort()).toEqual([ORG_A, ORG_B].sort());
    });

    it("one org's failure does not stop the others; a retry skips orgs already done (no double alert)", async () => {
      await admin.query("DELETE FROM problem");
      await seedProblem(ORG_A, "I42.0");
      await seedProblem(ORG_B, "I42.0");
      const alerts: string[] = [];
      let failB = true;
      const flaky = {
        recordType: "problem_list",
        usage: async (org: string, codes: readonly { systemId: string; code: string }[]) => {
          if (org === ORG_B && failB) throw new Error("producer down for B");
          return carePlanProducer().usage(org, codes);
        },
      };
      const base = {
        activeOrgs: orgs,
        ops,
        producers: [flaky],
        alerts: { emit: async (org: string) => void alerts.push(org) },
        log: quiet,
      };
      const progress = progressOf();
      await expect(runTenantDeprecationScanJob(base, await scanJob(), progress)).rejects.toThrow(
        /1 org\(s\) failed/,
      );
      expect(alerts).toEqual([ORG_A]);
      failB = false;
      const retry = await runTenantDeprecationScanJob(base, await scanJob(), progress);
      expect(retry).toMatchObject({ orgsSkipped: 1, orgsAlerted: 1 });
      expect(alerts).toEqual([ORG_A, ORG_B]); // A was NOT alerted twice
    });

    it("a tenant value-set extension is invisible to the other tenant (RLS), but visible to platform governance", async () => {
      const { extensionId } = await provider.addTenantExtension(
        ORG_A,
        "terminal_dx",
        "icd10cm",
        "I42.01",
        "palliative encounter coding",
        OPERATOR,
      );
      expect(extensionId).toBeTruthy();
      const store2 = createDbTerminologyStore(handle.db);
      expect(
        (await store2.tenantExtensionMembers(ORG_A, "terminal_dx")).map((m) => m.code),
      ).toEqual(["I42.01"]);
      expect(await store2.tenantExtensionMembers(ORG_B, "terminal_dx")).toEqual([]);
      const seenByB = await withOrgContext(handle.db, { organizationId: ORG_B, userId: "" }, (tx) =>
        tx.execute("SELECT id FROM value_set_tenant_extension" as never),
      );
      expect((seenByB as unknown as { rows: unknown[] }).rows).toHaveLength(0);
      expect((await ops.listTenantExtensions({ limit: 10 })).map((x) => x.organizationId)).toEqual([
        ORG_A,
      ]);
    });
  });

  // ── the real BullMQ workers (Valkey) ────────────────────────────────────────────────────────────
  describe.skipIf(!REDIS_URL)("BullMQ: nine real workers + the producer, over Valkey", () => {
    it("constructs one worker per §4.3 queue, registers the schedules, and drives a load through the queue", async () => {
      const url = new URL(REDIS_URL as string);
      const connection = {
        host: url.hostname,
        port: Number(url.port || 6379),
        maxRetriesPerRequest: null as null,
      };
      const producer = buildTerminologyProducer(connection);
      const log = SILENT_LOGGER;
      const workers = registerM38Workers({
        connection,
        load: deps({ followUps: producer }),
        scheduled: {
          store,
          objects,
          followUps: producer,
          log,
          now: () => new Date(),
          fetchImpl: fetch,
          egressEnabled: false,
          publicAdapters: PUBLIC_SOURCE_ADAPTERS,
          licensed: licensedSourceDenyStub,
        },
        expansions: { writer: createDbExpansionWriter(handle.db) },
        embeddings: {
          store: createDbEmbeddingStore(handle.db),
          embedder: embedderUnavailable,
          continueRun: async () => undefined,
        },
        scan: {
          activeOrgs: { listActiveOrgs: async () => [] },
          ops,
          producers: [],
          alerts: { emit: async () => undefined },
          log: { error() {}, info() {} },
        },
        failVersion: (id, reason) => store.fail(id, reason),
        log,
      });
      const schedules = await scheduleM38Jobs(connection);
      try {
        expect(workers.map((w) => w.name).sort()).toEqual(Object.values(TERMINOLOGY_QUEUES).sort());
        const icdQueue = schedules.find(
          (q) => q.name === TERMINOLOGY_QUEUES.scheduledIcd10cm,
        ) as Queue;
        expect((await icdQueue.getRepeatableJobs()).map((j) => j.name).sort()).toEqual([
          "activate",
          "dry_run",
        ]);

        const id = await register(
          "icd10cm",
          "FY2031-queue",
          "2030-10-01",
          bytes(ICD10CM_ORDER_2027),
        );
        await producer.enqueueLoadVersion(id, true);
        const deadline = Date.now() + 60_000;
        let status = "loading";
        while (Date.now() < deadline && status !== "active" && status !== "failed") {
          await new Promise((r) => setTimeout(r, 250));
          status = (await store.getVersion(id))?.status ?? status;
        }
        expect(status).toBe("active");
      } finally {
        await Promise.all(workers.map((w) => w.close()));
        await Promise.all([...schedules, ...producer.queues].map((q) => q.close()));
      }
    }, 120_000);
  });

  it("registers the platform job id used by the tenant-scan fan-out", () => {
    expect(M38_PLATFORM_JOB_ID).toBe("m38-terminology-workers");
  });
});
