/**
 * GAP-086 — the `sud_test_loinc` M38 value set is SEEDED, and the REAL M29 inbound adapter now flags a seeded
 * SUD LOINC as SUD — LIVE Postgres, as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Before: nothing seeded `sud_test_loinc`, so `isMemberOf` was false for every code and M29's inbound lab gate
 * (`buildM29InboundSeamPorts().terminology.classifyLoinc` → `decideLabSudRedaction`) never redacted a 42 CFR Part 2
 * result. The unit tests faked `classifyLoinc`, so nothing noticed.
 *
 * Everything below drives the PRODUCTION path: migration 0500 (applied with every other migration) seeds the platform
 * rows; the M38 provider over the Drizzle store (`createDbTerminologyStore`) is registered as the `TerminologyProvider`
 * seam exactly as `index.ts` does; the M29 adapter resolves it through `getSeam`. The only stub is the M39 consent
 * evaluator (its own suite owns it) — the SUD *classification* is never stubbed.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m29:sud-loinc-seed:live
 * (a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { SUD_TEST_LOINC_ENTRIES, SUD_TEST_LOINC_VALUE_SET_ID } from "@chartwarden/terminology";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __resetSeamsForTest, getSeam } from "../src/bootstrap/seams/registry";
import {
  SUD_TEST_LOINC_VALUE_SET,
  buildM29InboundSeamPorts,
} from "../src/modules/29-external-interfaces/inbound/inbound-seam-ports";
import { decideLabSudRedaction } from "../src/modules/29-external-interfaces/inbound/lab-sud-redaction";
import { createDbTerminologyStore } from "../src/modules/38-terminology/index";
import { registerTerminologySeams } from "../src/modules/38-terminology/seams";
import { appRoleConnectionString, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const NO_PGVECTOR = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const SEED_MIGRATION = "0500_terminology_sud_test_loinc_value_set.sql";
const ROLES = [
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
  "terminology_loader",
];

const ORG_A = "11111111-1111-4111-8111-111111110861";
const ORG_B = "22222222-2222-4222-8222-222222220862";
const ACTOR = "33333333-3333-4333-8333-333333330863";
const PATIENT = "44444444-4444-4444-8444-444444440864";

/** Real LOINC codes: three SUD tests the seed must hold, three ordinary labs it must not. */
const THC_URINE = "3426-4"; // Tetrahydrocannabinol [Presence] in Urine
const OPIATES_SAMHSA = "8222-2"; // Opiates [Presence] in Urine by SAMHSA screen method
const DOA_PANEL = "69739-1"; // Drugs of abuse panel - Urine by Screen method
const GLUCOSE = "2345-7"; // Glucose [Mass/volume] in Serum or Plasma
const HEMOGLOBIN = "718-7"; // Hemoglobin [Mass/volume] in Blood
const CREATININE = "2160-0"; // Creatinine [Mass/volume] in Serum or Plasma
/** An INVENTED local-lab code (not a real LOINC), seeded as a catalog concept only so it can be a tenant extension. */
const LOCAL_CODE = "99999-1";

const AS_OF = "2026-10-07";

describe.skipIf(!DB_URL)("GAP-086 sud_test_loinc seed + M29 adapter — LIVE Postgres", () => {
  let admin: Client;
  let appClient: Client;
  let handle: ReturnType<typeof createDbClient>;
  const terminology = () => buildM29InboundSeamPorts().terminology;

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

  const adminCount = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await admin.query(sql, params)).rows[0].n);

  /** Run `fn` on the chartwarden_app connection inside a transaction scoped to `org` (the production RLS GUC). */
  async function asOrg<T>(org: string, fn: () => Promise<T>): Promise<T> {
    await appClient.query("BEGIN");
    try {
      await appClient.query("SELECT set_config('app.org_id', $1, true)", [org]);
      return await fn();
    } finally {
      await appClient.query("ROLLBACK");
    }
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
      [ORG_A, "gap086suda"],
      [ORG_B, "gap086sudb"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,$2,$2,$2,'active')",
        [org, slug],
      );
    }
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'actor@gap086sud.test')`, [ACTOR]);

    // A tenant extension must name a code the catalog resolves as ACTIVE (§7.6), so give the catalog one invented
    // local code. (The platform SUD codes need no concept row: platform membership reads `value_set_member`.)
    await admin.query(
      `INSERT INTO code_system (id, name, source_uri, license_source) VALUES ('loinc','LOINC','http://loinc.org','regenstrief')`,
    );
    const version = await admin.query(
      `INSERT INTO code_system_version (code_system_id, version, released_on, effective_from, source_file_ref, checksum, status)
       VALUES ('loinc','test-fixture','2026-01-01','2026-01-01','seed://gap086','0','active') RETURNING id`,
    );
    await admin.query(
      `INSERT INTO concept_loinc (code, display, status, effective_date, version_id)
       VALUES ($1,'Invented local drug screen (test fixture)','active','2026-01-01',$2)`,
      [LOCAL_CODE, version.rows[0].id],
    );

    const url = await appRoleConnectionString(admin, DB_URL as string);
    appClient = new Client({ connectionString: url });
    await appClient.connect();
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    __resetSeamsForTest();
    registerTerminologySeams({ store: createDbTerminologyStore(handle.db) });
  }, 300_000);

  afterAll(async () => {
    __resetSeamsForTest();
    await handle?.close();
    await appClient?.end();
    await admin?.end();
  });

  // ── the seed itself ──────────────────────────────────────────────────────────────────────────────
  it("M29 reads the same slug the seed defines", () => {
    expect(SUD_TEST_LOINC_VALUE_SET).toBe(SUD_TEST_LOINC_VALUE_SET_ID);
  });

  it("migration 0500 created the platform value set with every seeded LOINC code", async () => {
    const vs = await admin.query(`SELECT scope FROM value_set WHERE id = $1`, [
      SUD_TEST_LOINC_VALUE_SET_ID,
    ]);
    expect(vs.rows).toEqual([{ scope: "platform" }]);
    expect(
      await adminCount(`SELECT count(*) n FROM value_set_member WHERE value_set_id = $1`, [
        SUD_TEST_LOINC_VALUE_SET_ID,
      ]),
    ).toBe(SUD_TEST_LOINC_ENTRIES.length);
    expect(
      await adminCount(
        `SELECT count(*) n FROM value_set_member WHERE value_set_id = $1 AND system_id <> 'loinc'`,
        [SUD_TEST_LOINC_VALUE_SET_ID],
      ),
    ).toBe(0);
  });

  it("stores the LOINC long common name for every code, exactly as the TS list carries it", async () => {
    const { rows } = await admin.query<{ code: string; display: string }>(
      `SELECT code, annotations->>'display' AS display FROM value_set_member WHERE value_set_id = $1`,
      [SUD_TEST_LOINC_VALUE_SET_ID],
    );
    const db = new Map(rows.map((r) => [r.code, r.display]));
    expect(db.size).toBe(SUD_TEST_LOINC_ENTRIES.length);
    for (const [code, name] of SUD_TEST_LOINC_ENTRIES) expect(db.get(code)).toBe(name);
  });

  it("re-running the seed migration is a no-op (idempotent)", async () => {
    const before = await adminCount(`SELECT count(*) n FROM value_set_member`);
    await admin.query(readFileSync(join(MIGRATIONS_DIR, SEED_MIGRATION), "utf8"));
    expect(await adminCount(`SELECT count(*) n FROM value_set_member`)).toBe(before);
    expect(
      await adminCount(`SELECT count(*) n FROM value_set WHERE id = $1`, [
        SUD_TEST_LOINC_VALUE_SET_ID,
      ]),
    ).toBe(1);
  });

  // ── RLS: reference data is readable by the app, writable only through the loader door ───────────────
  it("chartwarden_app can read the platform members but cannot write them", async () => {
    const read = await asOrg(ORG_A, () =>
      appClient.query(`SELECT count(*)::int n FROM value_set_member WHERE value_set_id = $1`, [
        SUD_TEST_LOINC_VALUE_SET_ID,
      ]),
    );
    expect(read.rows[0].n).toBe(SUD_TEST_LOINC_ENTRIES.length);

    await expect(
      asOrg(ORG_A, () =>
        appClient.query(
          `INSERT INTO value_set_member (value_set_id, system_id, code, member_effective)
           VALUES ($1, 'loinc', '1-1', '2026-01-01')`,
          [SUD_TEST_LOINC_VALUE_SET_ID],
        ),
      ),
    ).rejects.toThrow();
    // A tenant cannot quietly empty the set either (DELETE is not granted; an RLS-hidden write would match 0 rows).
    await expect(
      asOrg(ORG_A, () =>
        appClient.query(`DELETE FROM value_set_member WHERE value_set_id = $1`, [
          SUD_TEST_LOINC_VALUE_SET_ID,
        ]),
      ),
    ).rejects.toThrow();
    expect(
      await adminCount(`SELECT count(*) n FROM value_set_member WHERE value_set_id = $1`, [
        SUD_TEST_LOINC_VALUE_SET_ID,
      ]),
    ).toBe(SUD_TEST_LOINC_ENTRIES.length);
  });

  // ── the real M29 adapter over the real M38 provider ─────────────────────────────────────────────────
  it("flags seeded SUD LOINCs as sud_test through the real adapter", async () => {
    for (const code of [THC_URINE, OPIATES_SAMHSA, DOA_PANEL]) {
      await expect(
        terminology().classifyLoinc({ code, asOfDate: AS_OF, organizationId: ORG_A }),
      ).resolves.toEqual({ categories: ["sud_test"] });
    }
  });

  it("leaves non-SUD LOINCs alone (glucose, hemoglobin, creatinine)", async () => {
    for (const code of [GLUCOSE, HEMOGLOBIN, CREATININE]) {
      await expect(
        terminology().classifyLoinc({ code, asOfDate: AS_OF, organizationId: ORG_A }),
      ).resolves.toEqual({ categories: [] });
    }
  });

  it("flags EVERY seeded code (no member is silently unreachable through the adapter)", async () => {
    const misses: string[] = [];
    for (const [code] of SUD_TEST_LOINC_ENTRIES) {
      const r = await terminology().classifyLoinc({ code, asOfDate: AS_OF });
      if (!r.categories.includes("sud_test")) misses.push(code);
    }
    expect(misses).toEqual([]);
  }, 300_000);

  it("classifies as of the observation date (a future-dated and a historical observation both match)", async () => {
    for (const asOfDate of ["2000-01-01", "2031-06-30"]) {
      await expect(
        terminology().classifyLoinc({ code: THC_URINE, asOfDate, organizationId: ORG_A }),
      ).resolves.toEqual({ categories: ["sud_test"] });
    }
  });

  // ── the gate end to end: classification real, consent evaluator the only stub ──────────────────────
  it("redacts a patient's SUD result when consent does not allow disclosure, and not a glucose", async () => {
    const deps = {
      terminology: terminology(),
      consent: { evaluateForIngressRedaction: async () => ({ allowDisclosure: false }) },
    };
    const sud = await decideLabSudRedaction(
      { organizationId: ORG_A, patientId: PATIENT, loincCodes: [THC_URINE], asOf: AS_OF },
      deps,
    );
    expect(sud).toEqual({ sudDetected: true, redact: true });

    const plain = await decideLabSudRedaction(
      { organizationId: ORG_A, patientId: PATIENT, loincCodes: [GLUCOSE], asOf: AS_OF },
      deps,
    );
    expect(plain).toEqual({ sudDetected: false, redact: false });

    const mixed = await decideLabSudRedaction(
      { organizationId: ORG_A, patientId: PATIENT, loincCodes: [GLUCOSE, DOA_PANEL], asOf: AS_OF },
      deps,
    );
    expect(mixed).toEqual({ sudDetected: true, redact: true });
  });

  it("does not redact a SUD result when the patient has consented to disclosure", async () => {
    const decision = await decideLabSudRedaction(
      { organizationId: ORG_A, patientId: PATIENT, loincCodes: [THC_URINE], asOf: AS_OF },
      {
        terminology: terminology(),
        consent: { evaluateForIngressRedaction: async () => ({ allowDisclosure: true }) },
      },
    );
    expect(decision).toEqual({ sudDetected: true, redact: false });
  });

  // ── tenant extension: adds codes for one tenant only ────────────────────────────────────────────────
  describe("tenant extension", () => {
    let extensionId: string;

    it("before any extension the invented local code is not SUD for anyone", async () => {
      for (const organizationId of [ORG_A, ORG_B, undefined]) {
        await expect(
          terminology().classifyLoinc({
            code: LOCAL_CODE,
            asOfDate: AS_OF,
            ...(organizationId ? { organizationId } : {}),
          }),
        ).resolves.toEqual({ categories: [] });
      }
    });

    it("org A adds the local code through the real M38 write path, as chartwarden_app under RLS", async () => {
      const provider = getSeam("TerminologyProvider") as {
        addTenantExtension(
          orgId: string,
          valueSetId: string,
          system: "loinc",
          code: string,
          reason: string,
          actorUserId: string,
        ): Promise<{ extensionId: string }>;
      };
      const out = await provider.addTenantExtension(
        ORG_A,
        SUD_TEST_LOINC_VALUE_SET_ID,
        "loinc",
        LOCAL_CODE,
        "In-house methadone clinic drug screen",
        ACTOR,
      );
      extensionId = out.extensionId;
      expect(extensionId).toMatch(/^[0-9a-f-]{36}$/);
      // The row is org A's, written with the org's id (asserted by id, not by a timestamp).
      const row = await admin.query(
        `SELECT organization_id FROM value_set_tenant_extension WHERE id = $1`,
        [extensionId],
      );
      expect(row.rows).toEqual([{ organization_id: ORG_A }]);
    });

    it("the extension makes the code SUD for org A only — not org B, not an org-less call", async () => {
      await expect(
        terminology().classifyLoinc({
          code: LOCAL_CODE,
          asOfDate: AS_OF,
          organizationId: ORG_A,
        }),
      ).resolves.toEqual({ categories: ["sud_test"] });
      await expect(
        terminology().classifyLoinc({
          code: LOCAL_CODE,
          asOfDate: AS_OF,
          organizationId: ORG_B,
        }),
      ).resolves.toEqual({ categories: [] });
      await expect(
        terminology().classifyLoinc({ code: LOCAL_CODE, asOfDate: AS_OF }),
      ).resolves.toEqual({ categories: [] });
    });

    it("RLS: org B's connection cannot see org A's extension row; org A's can", async () => {
      const asB = await asOrg(ORG_B, () =>
        appClient.query(`SELECT id FROM value_set_tenant_extension WHERE id = $1`, [extensionId]),
      );
      expect(asB.rows).toEqual([]);
      const asA = await asOrg(ORG_A, () =>
        appClient.query(`SELECT id FROM value_set_tenant_extension WHERE id = $1`, [extensionId]),
      );
      expect(asA.rows).toEqual([{ id: extensionId }]);
    });

    it("an extension never weakens the platform set, and a platform member cannot be re-added (redundant)", async () => {
      const provider = getSeam("TerminologyProvider") as {
        addTenantExtension(...args: unknown[]): Promise<unknown>;
      };
      await expect(
        provider.addTenantExtension(
          ORG_B,
          SUD_TEST_LOINC_VALUE_SET_ID,
          "loinc",
          THC_URINE,
          "already platform",
          ACTOR,
        ),
      ).rejects.toThrow();
      // Org B still gets the platform classification for a seeded code.
      await expect(
        terminology().classifyLoinc({ code: THC_URINE, asOfDate: AS_OF, organizationId: ORG_B }),
      ).resolves.toEqual({ categories: ["sud_test"] });
    });
  });
});
