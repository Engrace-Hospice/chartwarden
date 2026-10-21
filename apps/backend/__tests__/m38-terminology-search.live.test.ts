/**
 * M38 terminology SEARCH — `GET /api/v1/terminology/:system/search` filters, LIVE Postgres.
 *
 * Before: `searchConcepts` ignored `inValueSet` outright and `billableOnly` only worked for ICD-10-CM, so the
 * shared CodeSearchInput picker's value-set and billable options silently returned unfiltered results.
 *
 * Everything runs through the REAL route (full middleware chain via Fastify inject, real `terminology.read`
 * permission gate) over the REAL Drizzle store, connected as the NOBYPASSRLS `wardenx_app` role — the one tenant-
 * scoped table (`value_set_tenant_extension`) is only meaningful on that role. Data is loaded through the real
 * loader (register → stage → activate) from tiny INVENTED fixtures; no licensed content.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m38:search:live
 * (a PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { createTerminologyProvider } from "@chartwarden/terminology";
import {
  type LoadableSystemId,
  SILENT_LOGGER,
  createInMemoryObjects,
  createRecordingFollowUps,
  runLoadVersion,
  sha256Hex,
} from "@chartwarden/terminology-loader";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CARC_CSV,
  ICD10CM_ORDER_2026,
  ICD10CM_ORDER_2027,
  LOINC_CSV,
  bytes,
  zip,
} from "../../../packages/terminology-loader/__tests__/_fixtures";
import { buildServer } from "../src/bootstrap/index";
import {
  createDbLoaderStore,
  createDbTerminologyOpsStore,
  createDbTerminologyStore,
  registerTerminologyRoutes,
} from "../src/modules/38-terminology/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const NO_PGVECTOR = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "terminology_loader",
];

const ORG_A = "11111111-1111-4111-8111-111111110901";
const ORG_B = "22222222-2222-4222-8222-222222220902";
const OPERATOR = "33333333-3333-4333-8333-333333330903";

/** Test-only auth shim: populate request.context from headers (mirrors terminology-routes.test). */
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = [];
}

/** A tiny INVENTED page in the shape x12.org serves (see parsers/x12-code-list-html.ts). */
const RARC_PAGE = `<!DOCTYPE html><html><body><table id="codelist"><tbody>
<tr class="prod-set current"><td class="code">N940</td><td class="description">Invented current remark<span class="dates"><br>Start: 07/01/2026</span></td></tr>
<tr class="prod-set deactivated"><td class="code">MA01</td><td class="description">Invented old remark<span class="dates"><br>Start: 01/01/1997 | Stop: 08/01/2004</span></td></tr>
</tbody></table></body></html>`;

const as = (org: string) => ({ "x-test-user": `reader_${org.slice(0, 2)}`, "x-test-org": org });

describe.skipIf(!DB_URL)("M38 terminology search filters — LIVE Postgres, via the route", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  const objects = createInMemoryObjects();

  async function applyMigrations(): Promise<void> {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (NO_PGVECTOR)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

  /** Register through the REAL definer function and run the REAL loader to `active`. */
  async function load(
    system: LoadableSystemId,
    version: string,
    effectiveFrom: string,
    file: Uint8Array,
  ): Promise<void> {
    const ops = createDbTerminologyOpsStore(handle.db);
    const key = `terminology/${system}/${version}`;
    objects.objects.set(key, file);
    const reg = await ops.registerVersion({
      system,
      version,
      sourceFileRef: key,
      checksum: sha256Hex(file),
      releasedOn: "2026-06-01",
      effectiveFrom,
      loadedBy: OPERATOR,
    });
    const out = await runLoadVersion(
      {
        store: createDbLoaderStore(handle.db),
        objects,
        followUps: createRecordingFollowUps(),
        log: SILENT_LOGGER,
        today: () => new Date().toISOString().slice(0, 10),
        embeddingsAvailable: false,
      },
      { versionId: reg.versionId },
    );
    expect(out.outcome).toBe("activated");
  }

  async function search(
    system: string,
    query: string,
    org: string = ORG_B,
  ): Promise<{
    status: number;
    codes: string[];
    body: { results: Array<Record<string, unknown>> };
  }> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/terminology/${system}/search?${query}`,
      headers: as(org),
    });
    const body = res.json();
    return {
      status: res.statusCode,
      codes: (body.results ?? []).map((r: { code: string }) => r.code),
      body,
    };
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
    for (const [org, slug] of [
      [ORG_A, "srch-a"],
      [ORG_B, "srch-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,$2,$2,$2,'active')",
        [org, slug],
      );
    }
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'ops@search.test')`, [OPERATOR]);
    await admin.query(
      `INSERT INTO code_system (id, name, source_uri, license_source) VALUES
         ('icd10cm','ICD-10-CM','urn:cms:icd10cm','public'),
         ('loinc','LOINC','http://loinc.org','regenstrief'),
         ('carc','X12 CARC','urn:x12:carc','public'),
         ('rarc','X12 RARC','urn:x12:rarc','public')`,
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // The licence gate is the real one: LOINC loads only under an attestation (a TEST attestation on a throwaway DB).
    await createDbTerminologyOpsStore(handle.db).recordLicenseAttestation({
      system: "loinc",
      licensee: "Search live suite (test fixture)",
      licenseReference: "TEST-ONLY",
      attestedBy: OPERATOR,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      attributionText: "test fixture",
    });
    await load("icd10cm", "FY2026", "2025-10-01", bytes(ICD10CM_ORDER_2026));
    await load("icd10cm", "FY2027", "2026-10-01", bytes(ICD10CM_ORDER_2027));
    await load("loinc", "2.78", "2024-02-01", zip({ "LoincTable/Loinc.csv": LOINC_CSV }));
    await load("carc", "t1", "2000-01-01", bytes(CARC_CSV));
    await load("rarc", "t1", "2000-01-01", bytes(RARC_PAGE));

    // Value sets (platform reference data, seeded as the migration owner exactly like migration 0500 does).
    await admin.query(
      `INSERT INTO value_set (id, name, scope) VALUES
         ('vs_dx','Dx subset','hospice'), ('vs_lab','Lab subset','platform')`,
    );
    await admin.query(
      `INSERT INTO value_set_member (value_set_id, system_id, code, member_effective, member_end) VALUES
         ('vs_dx','icd10cm','I42.00','2026-10-01',NULL),
         ('vs_dx','icd10cm','I42.01','2020-01-01','2026-09-30'),
         ('vs_dx','icd10cm','C50.91','1970-01-01',NULL)`,
    );
    await admin.query(
      `INSERT INTO value_set_member (value_set_id, system_id, code, member_effective, annotations) VALUES
         ('vs_lab','loinc','99990-1','1970-01-01','{}'),
         ('vs_lab','loinc','99998-4','1970-01-01','{"source":"loinc","display":"Orphan lab [Presence] in Urine","loincDeprecated":false}'),
         ('vs_lab','loinc','99997-6','1970-01-01','{"source":"loinc","display":"Old orphan lab","loincDeprecated":true}')`,
    );

    const provider = createTerminologyProvider(createDbTerminologyStore(handle.db));
    // ORG_A extends vs_dx with I42.0 (an active, non-platform-member code).
    await provider.addTenantExtension(ORG_A, "vs_dx", "icd10cm", "I42.0", "tenant add", OPERATOR);

    resetAuthorizationContract();
    resetRbacEngine();
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore(
        [ORG_A, ORG_B].map((org) => ({
          orgId: org,
          userId: `reader_${org.slice(0, 2)}`,
          grants: [
            {
              roleKey: "seed",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["terminology.read"],
            },
          ],
        })),
      ).store,
    );
    app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    registerTerminologyRoutes(app, { provider });
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    resetAuthorizationContract();
    resetRbacEngine();
    await handle?.close();
    await admin?.end();
  });

  it("is genuinely the NOBYPASSRLS wardenx_app role", async () => {
    const r = await admin.query(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'wardenx_app'",
    );
    expect(r.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    const who = (await handle.db.execute("SELECT current_user AS u" as never)) as unknown as {
      rows: Array<{ u: string }>;
    };
    expect(who.rows[0]?.u).toBe("wardenx_app");
  });

  describe("billableOnly", () => {
    it("ICD-10-CM: active billable leaves only", async () => {
      const all = await search("icd10cm", "q=cardiomyopathy&limit=50");
      expect(all.codes).toEqual(["I42", "I42.0", "I42.00", "I42.01"]);
      const billable = await search("icd10cm", "q=cardiomyopathy&billableOnly=true&limit=50");
      expect(billable.codes).toEqual(["I42.00", "I42.01"]);
    });

    it("ICD-10-CM: honours asOf (the FY2026 release had I42.0 as billable)", async () => {
      const r = await search("icd10cm", "q=cardiomyopathy&billableOnly=true&asOf=2026-06-01");
      expect(r.codes).toEqual(["I42.0"]);
    });

    it("LOINC: means status = active, so a retired code drops out (not a silent no-op)", async () => {
      const all = await search("loinc", "q=analyte&limit=50");
      expect(all.codes).toEqual(["99990-1", "99991-9"]);
      const billable = await search("loinc", "q=analyte&billableOnly=true&limit=50");
      expect(billable.codes).toEqual(["99990-1"]);
    });

    it("CARC: works on a common-shape system", async () => {
      const r = await search("carc", "q=deductible&billableOnly=true");
      expect(r.codes).toEqual(["1"]);
    });
  });

  describe("inValueSet", () => {
    it("restricts to platform members covering asOf (an ended member is excluded)", async () => {
      const r = await search("icd10cm", "q=cardiomyopathy&inValueSet=vs_dx&limit=50", ORG_B);
      expect(r.codes).toEqual(["I42.00"]);
    });

    it("unions the CALLING tenant's live extensions, and only theirs (RLS)", async () => {
      const a = await search("icd10cm", "q=cardiomyopathy&inValueSet=vs_dx&limit=50", ORG_A);
      expect(a.codes).toEqual(["I42.0", "I42.00"]);
      const b = await search("icd10cm", "q=cardiomyopathy&inValueSet=vs_dx&limit=50", ORG_B);
      expect(b.codes).toEqual(["I42.00"]);
    });

    it("a removed tenant extension no longer shows", async () => {
      await admin.query(
        "UPDATE value_set_tenant_extension SET removed_at = now() WHERE organization_id = $1",
        [ORG_A],
      );
      const a = await search("icd10cm", "q=cardiomyopathy&inValueSet=vs_dx&limit=50", ORG_A);
      expect(a.codes).toEqual(["I42.00"]);
      await admin.query(
        "UPDATE value_set_tenant_extension SET removed_at = NULL WHERE organization_id = $1",
        [ORG_A],
      );
    });

    it("composes with billableOnly and asOf", async () => {
      const r = await search(
        "icd10cm",
        "q=cardiomyopathy&inValueSet=vs_dx&billableOnly=true&limit=50",
        ORG_A,
      );
      expect(r.codes).toEqual(["I42.00"]);
      const earlier = await search("icd10cm", "q=breast&inValueSet=vs_dx&asOf=2026-06-01");
      expect(earlier.codes).toEqual(["C50.91"]);
    });

    it("only members of the searched system match", async () => {
      expect((await search("icd10cm", "q=a&inValueSet=vs_lab")).codes).toEqual([]);
    });

    it("an unknown value set is 404 NOT_FOUND, not an empty list", async () => {
      const r = await search("icd10cm", "q=cardiomyopathy&inValueSet=does_not_exist");
      expect(r.status).toBe(404);
    });

    it("LOINC value-set members with no concept row are still searchable by their member display", async () => {
      const byName = await search("loinc", "q=orphan&inValueSet=vs_lab&limit=50");
      expect(byName.codes).toEqual(["99997-6", "99998-4"]);
      expect(byName.body.results.find((c) => c.code === "99998-4")).toMatchObject({
        display: "Orphan lab [Presence] in Urine",
        status: "active",
      });
      expect(byName.body.results.find((c) => c.code === "99997-6")).toMatchObject({
        status: "deprecated",
      });
      // a loaded concept in the same set still comes from the concept table
      const loaded = await search("loinc", "q=99990&inValueSet=vs_lab");
      expect(loaded.codes).toEqual(["99990-1"]);
      // billableOnly never fabricates active-ness for a member without a concept row
      const billable = await search("loinc", "q=lab&inValueSet=vs_lab&billableOnly=true");
      expect(billable.codes).toEqual([]);
    });

    it("limit applies to the merged result", async () => {
      const r = await search("loinc", "q=9999&inValueSet=vs_lab&limit=2");
      expect(r.codes).toHaveLength(2);
    });
  });

  describe("X12 page upload format loads end to end", () => {
    it("a saved RARC page is staged, activated and searchable; billableOnly drops the retired code", async () => {
      // today: the code stopped in 2004 is outside its effective window
      expect((await search("rarc", "q=invented&limit=50")).codes).toEqual(["N940"]);
      // as of 2003 it is in force, but marked retired, so billableOnly still drops it
      const then = await search("rarc", "q=invented&asOf=2003-01-01&limit=50");
      expect(then.codes).toEqual(["MA01"]);
      expect(then.body.results[0]).toMatchObject({ status: "retired" });
      expect((await search("rarc", "q=invented&asOf=2003-01-01&billableOnly=true")).codes).toEqual(
        [],
      );
    });
  });

  describe("fuzzy matching treats LIKE wildcards as literals", () => {
    it("q=% does not match every row", async () => {
      expect((await search("icd10cm", "q=%25")).codes).toEqual([]);
      expect((await search("icd10cm", "q=_")).codes).toEqual([]);
    });
  });
});
