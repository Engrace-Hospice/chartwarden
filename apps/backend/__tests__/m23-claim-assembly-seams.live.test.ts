/**
 * M23 claim-assembly seam bindings — LIVE Postgres proof (#250, F-11x).
 *
 * `boot-assembly.ts` binds FOUR of `ClaimAssemblySeams`'s eleven reader methods to real data:
 * `patientPayer` (M5), `mdm.resolveProviderEntity` (M40 CCN + MAC jurisdiction), and two of
 * `referenceData`'s four methods (`wageIndexForCcn`, `activeSequestrationPolicy`). This proves each
 * against real rows under real RLS (`WARDENX_DEV_BYPASSRLS=0` discipline: this test connects as the
 * migrated `wardenx_app` role via `handle.db`, never the admin/superuser client used only to seed), and
 * proves the end-to-end `POST /claims/assemble` reachability boundary precisely: it now fails at
 * `admission.resolveForRange` (M6, still unbound) — one seam step later than before this pass, not
 * "unblocked".
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m23-claim-assembly-seams.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient, schema } from "@wardenx/db";
import { appRoleConnectionString } from "./_live-app-role";
import { registerSeam } from "../src/bootstrap/index";
import { buildPatientCoverageReader } from "../src/modules/05-patient/coverage-reader";
import { buildM23BootAssemblyService } from "../src/modules/23-billing-medicare/services/boot-assembly";
import {
  buildM23MdmProviderEntityAdapter,
  buildM23PatientPayerAdapter,
  buildM23ReferenceDataAdapter,
} from "../src/modules/23-billing-medicare/services/claim-assembly-seam-adapters";
import type { ProviderCcnPort } from "../src/modules/23-billing-medicare/routes/write-service";
import { and, eq } from "drizzle-orm";
import { Client } from "pg";
import { WardenXError } from "@wardenx/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** The same real `ProviderCcnPort` implementation `index.ts` binds against the SAME `tx` the adapter
 *  under test opens (its own `withOrgContext`), so these tests exercise the identical query production
 *  runs, not a stub. */
const testProviderCcnPort: ProviderCcnPort = {
  async ccnForProviderEntity(tx, organizationId, providerEntityId) {
    const [provider] = await (tx as DbClient)
      .select({ ccn: schema.providerEntities.ccn })
      .from(schema.providerEntities)
      .where(
        and(
          eq(schema.providerEntities.id, providerEntityId),
          eq(schema.providerEntities.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!provider) throw new WardenXError("NOT_FOUND", "provider CCN unavailable", 404);
    return provider.ccn;
  },
};

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const U = "00000000-0000-0000-0000-0000000000ff";

describe.skipIf(!DB_URL)("M23 claim-assembly seam bindings — LIVE Postgres (#250)", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };

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

  async function seedOrg(orgId: string, slug: string) {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)",
      [orgId, slug, slug],
    );
  }

  async function seedProviderEntity(orgId: string, ccn: string): Promise<string> {
    const row = await admin.query(
      `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1, $2, 'Test Hospice', $3, 'enc', '0930') RETURNING id`,
      [orgId, ccn, `${ccn}0000001`],
    );
    return row.rows[0].id as string;
  }

  async function seedMacCredential(orgId: string, providerEntityId: string, jurisdiction: string) {
    await admin.query(
      `INSERT INTO mac_submitter_credential
         (organization_id, provider_entity_id, mac_jurisdiction, submitter_id, trading_partner_id,
          client_id, client_secret_cipher, client_secret_dek_version, set_by_membership_id)
       VALUES ($1, $2, $3, 'sub-1', 'tp-1', 'client-1', 'cipher-1', 1, $4)`,
      [orgId, providerEntityId, jurisdiction, U],
    );
  }

  async function seedWageIndex(ccn: string, fy: number, factor: string, cbsa: string | null) {
    await admin.query(
      `INSERT INTO wage_index_factor (ccn, fiscal_year_starting, cbsa_code, factor_decimal, load_source_ref)
       VALUES ($1, $2, $3, $4, 'test-fixture')`,
      [ccn, fy, cbsa, factor],
    );
  }

  async function seedSequestrationPolicy(
    orgId: string,
    providerEntityId: string,
    pct: string,
    effectiveFrom: string,
  ) {
    await admin.query(
      `INSERT INTO sequestration_policy
         (organization_id, provider_entity_id, percentage, effective_from, set_by_membership_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [orgId, providerEntityId, pct, effectiveFrom, U],
    );
  }

  async function seedPatient(orgId: string): Promise<string> {
    const row = await admin.query(
      `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
       VALUES ($1, $2, 'Jane', 'Doe', '1950-01-01', 'female', 'active') RETURNING id`,
      [orgId, `mrn-${Math.random().toString(36).slice(2)}`],
    );
    return row.rows[0].id as string;
  }

  async function seedPatientPayer(
    orgId: string,
    patientId: string,
    rank: number,
    coverageKind: string,
    effectiveFrom: string,
  ) {
    await admin.query(
      `INSERT INTO patient_payer
         (patient_id, organization_id, payer_id, rank, coverage_kind, subscriber_id, effective_from)
       VALUES ($1, $2, $3, $4, $5, 'mbi-1', $6)`,
      [patientId, orgId, U, rank, coverageKind, effectiveFrom],
    );
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
    await seedOrg(ORG_A, "org-a");
    await seedOrg(ORG_B, "org-b");

    // `_live-app-role.ts` (GAP-086): grants wardenx_app LOGIN + a password and PROVES the returned url
    // actually connects as the NOBYPASSRLS app role, not a superuser — a bare-superuser handle would
    // make every "never resolves another org's row" assertion below pass vacuously.
    const appConnectionString = await appRoleConnectionString(admin, DB_URL!);
    handle = createDbClient({ connectionString: appConnectionString });

    // M5's seam registry entry, so `getSeam("PatientCoverageReader")` resolves for real (the
    // adapter under test calls through the registry exactly as boot-assembly.ts does).
    registerSeam("PatientCoverageReader", buildPatientCoverageReader(handle.db));
  }, 120_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (admin) await admin.end();
  });

  describe("mdm.resolveProviderEntity", () => {
    it("resolves the real CCN + admin-configured MAC jurisdiction, cbsaCode null", async () => {
      const pe = await seedProviderEntity(ORG_A, "381234");
      await seedMacCredential(ORG_A, pe, "ngs_j6");
      const adapter = buildM23MdmProviderEntityAdapter(handle.db, testProviderCcnPort);
      const resolved = await adapter.resolveProviderEntity(ORG_A, pe);
      expect(resolved).toEqual({ ccn: "381234", macJurisdiction: "ngs_j6", cbsaCode: null });
    });

    it("returns null when the provider entity has no MAC submitter credential yet", async () => {
      const pe = await seedProviderEntity(ORG_A, "381235");
      const adapter = buildM23MdmProviderEntityAdapter(handle.db, testProviderCcnPort);
      expect(await adapter.resolveProviderEntity(ORG_A, pe)).toBeNull();
    });

    it("never resolves another org's provider entity (cross-tenant RLS isolation)", async () => {
      const peOrgB = await seedProviderEntity(ORG_B, "381236");
      await seedMacCredential(ORG_B, peOrgB, "cgs_j15");
      const adapter = buildM23MdmProviderEntityAdapter(handle.db, testProviderCcnPort);
      expect(await adapter.resolveProviderEntity(ORG_A, peOrgB)).toBeNull();
    });
  });

  describe("referenceData.wageIndexForCcn", () => {
    it("resolves a loaded CMS wage-index factor for (ccn, fiscal year)", async () => {
      await seedWageIndex("381237", 2026, "0.9234", "38900");
      const adapter = buildM23ReferenceDataAdapter(
        handle.db,
        () => {
          throw new WardenXError("SEAM_UNBOUND", "hipps", 503);
        },
        () => {
          throw new WardenXError("SEAM_UNBOUND", "chc", 503);
        },
      );
      expect(await adapter.wageIndexForCcn("381237", 2026)).toEqual({
        factorDecimal: "0.9234",
        cbsaCode: "38900",
      });
    });

    it("returns null (never fabricates a factor) for a CCN/FY the CMS file hasn't loaded", async () => {
      // NOTE: migration 0080_billing_m23_seed.sql pre-seeds 5 REPRESENTATIVE placeholder rows for
      // FY2026 (010001, 050002, 380001, 450003, 999999 — explicitly marked "not authoritative"), so a
      // real null-path proof must use a CCN/FY outside that fixed set, not assume the table is empty.
      const adapter = buildM23ReferenceDataAdapter(
        handle.db,
        () => {
          throw new Error("unreachable");
        },
        () => {
          throw new Error("unreachable");
        },
      );
      expect(await adapter.wageIndexForCcn("777777", 2026)).toBeNull();
    });
  });

  describe("referenceData.activeSequestrationPolicy", () => {
    it("resolves the policy in effect on the service date", async () => {
      const pe = await seedProviderEntity(ORG_A, "381238");
      await seedSequestrationPolicy(ORG_A, pe, "2.00", "2020-01-01");
      const adapter = buildM23ReferenceDataAdapter(
        handle.db,
        () => {
          throw new Error("unreachable");
        },
        () => {
          throw new Error("unreachable");
        },
      );
      const resolved = await adapter.activeSequestrationPolicy(ORG_A, pe, "2026-06-01");
      expect(resolved?.percentage).toBe("2.00");
      expect(resolved?.effectiveTo).toBeNull();
    });

    it("never resolves another org's sequestration policy (cross-tenant RLS isolation)", async () => {
      const peOrgB = await seedProviderEntity(ORG_B, "381239");
      await seedSequestrationPolicy(ORG_B, peOrgB, "2.00", "2020-01-01");
      const adapter = buildM23ReferenceDataAdapter(
        handle.db,
        () => {
          throw new Error("unreachable");
        },
        () => {
          throw new Error("unreachable");
        },
      );
      expect(await adapter.activeSequestrationPolicy(ORG_A, peOrgB, "2026-06-01")).toBeNull();
    });
  });

  describe("patientPayer.medicarePrimaryForRange", () => {
    it("resolves Medicare FFS as primary when rank 1 covers the whole range", async () => {
      const patientId = await seedPatient(ORG_A);
      await seedPatientPayer(ORG_A, patientId, 1, "medicare_ffs", "2020-01-01");
      const adapter = buildM23PatientPayerAdapter();
      const resolved = await adapter.medicarePrimaryForRange(ORG_A, patientId, {
        from: "2026-01-01",
        to: "2026-01-31",
      });
      expect(resolved?.medicarePrimary).toBe(true);
    });

    it("resolves Medicare FFS as NOT primary when it is rank 2 behind a commercial payer", async () => {
      const patientId = await seedPatient(ORG_A);
      await seedPatientPayer(ORG_A, patientId, 1, "commercial", "2020-01-01");
      await seedPatientPayer(ORG_A, patientId, 2, "medicare_ffs", "2020-01-01");
      const adapter = buildM23PatientPayerAdapter();
      const resolved = await adapter.medicarePrimaryForRange(ORG_A, patientId, {
        from: "2026-01-01",
        to: "2026-01-31",
      });
      expect(resolved?.medicarePrimary).toBe(false);
    });

    it("returns null when no medicare_ffs coverage is in force across the whole range", async () => {
      const patientId = await seedPatient(ORG_A);
      const adapter = buildM23PatientPayerAdapter();
      const resolved = await adapter.medicarePrimaryForRange(ORG_A, patientId, {
        from: "2026-01-01",
        to: "2026-01-31",
      });
      expect(resolved).toBeNull();
    });
  });

  describe("end-to-end boundary: POST /claims/assemble's real SEAM_UNBOUND wall today", () => {
    it("progresses past patientPayer and fails at admission.resolveForRange (M6, still unbound) — not at patientPayer", async () => {
      const patientId = await seedPatient(ORG_A);
      await seedPatientPayer(ORG_A, patientId, 1, "medicare_ffs", "2020-01-01");
      const pe = await seedProviderEntity(ORG_A, "381240");

      const service = buildM23BootAssemblyService(handle.db);
      await expect(
        service.assemble(
          { organizationId: ORG_A, userId: U, membershipId: U, actorKind: "user" },
          {
            providerEntityId: pe,
            patientId,
            serviceFrom: "2026-01-01",
            serviceTo: "2026-01-31",
            tob: "811",
          },
        ),
      ).rejects.toMatchObject({
        code: "SEAM_UNBOUND",
        message: expect.stringContaining("AdmissionContextReader"),
      });
    });

    it("still fails BEFORE admission when patientPayer itself resolves to non-Medicare-primary (D15 gate, unchanged)", async () => {
      const patientId = await seedPatient(ORG_A);
      // no medicare_ffs coverage seeded at all
      const pe = await seedProviderEntity(ORG_A, "381241");
      const service = buildM23BootAssemblyService(handle.db);
      await expect(
        service.assemble(
          { organizationId: ORG_A, userId: U, membershipId: U, actorKind: "user" },
          {
            providerEntityId: pe,
            patientId,
            serviceFrom: "2026-01-01",
            serviceTo: "2026-01-31",
            tob: "811",
          },
        ),
      ).rejects.toMatchObject({ code: "NON_MEDICARE_PRIMARY_PAYER" });
    });
  });
});
