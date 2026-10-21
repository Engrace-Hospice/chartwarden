/**
 * M23 tenant-entered WAGE INDEX — LIVE Postgres proof (F-211).
 *
 * After F-210 `POST /claims/assemble` stopped at `WAGE_INDEX_UNAVAILABLE`: the platform-shared `wage_index_factor` has no loader
 * and only five non-authoritative placeholder CCNs. The wage index is now TENANT-ENTERED into the org-scoped, append-only
 * `tenant_wage_index` (migration 0280) through `buildDrizzleWageIndexService`, and `buildM23ReferenceDataAdapter.wageIndexForCcn`
 * prefers that row, then a platform AUTHORITATIVE row, and never a placeholder. Proven against real rows under REAL RLS (every
 * service call runs on the migrated NOBYPASSRLS `chartwarden_app` role via `_live-app-role.ts`; the superuser client only seeds
 * and inspects):
 *   - create / supersede / list / get / live lookup, and the audit trail the M4 trigger writes;
 *   - validation (plausible band, CCN shape, fiscal-year window, source citation) as a typed 422;
 *   - one LIVE value per CCN + fiscal year: the service pre-check (409 naming the clash) AND the partial-unique-index backstop;
 *   - append-only: the app role can neither edit a value nor delete a row; a superseded row is frozen;
 *   - cross-tenant isolation (read, lookup, adapter, and the RLS WITH CHECK on a forged organization_id);
 *   - the adapter's precedence (tenant > authoritative platform > nothing) and that a tenant's entry never leaks to, nor
 *     rewrites, the platform-shared table or another tenant's pricing.
 * No outbox event is emitted by this surface, so there is no publisher to bind.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m23-wage-index.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { M23WriteActor } from "../src/modules/23-billing-medicare/routes/actor";
import {
  buildDrizzleWageIndexService,
  resolveWageIndexForOrg,
} from "../src/modules/23-billing-medicare/routes/wage-index-service";
import type { CreateWageIndexBody } from "../src/modules/23-billing-medicare/routes/wage-index-typebox";
import { buildM23ReferenceDataAdapter } from "../src/modules/23-billing-medicare/services/claim-assembly-seam-adapters";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEMBERSHIP_A = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
const MEMBERSHIP_B = "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1";
const CCN = "381240";

const actorA: M23WriteActor = {
  organizationId: ORG_A,
  userId: USER_A,
  roles: ["org_admin"],
  membershipId: MEMBERSHIP_A,
  stepUpRecent: false,
  actorKind: "user",
};
const actorB: M23WriteActor = {
  organizationId: ORG_B,
  userId: USER_B,
  roles: ["org_admin"],
  membershipId: MEMBERSHIP_B,
  stepUpRecent: false,
  actorKind: "user",
};

function entry(over: Partial<CreateWageIndexBody> = {}): CreateWageIndexBody {
  return {
    ccn: CCN,
    fiscalYearStarting: 2025,
    cbsaCode: "38900",
    factorDecimal: "1.0342",
    sourceReference: "CMS FY2026 hospice wage index final rule, Table A",
    ...over,
  };
}

describe.skipIf(!DB_URL)("M23 tenant-entered wage index — LIVE Postgres (F-211)", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let appUrl: string;
  const svc = () => buildDrizzleWageIndexService(handle.db);

  async function applyMigrations() {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

  async function reset() {
    await admin.query("ALTER TABLE tenant_wage_index DISABLE TRIGGER trg_tenant_wage_index_guard");
    await admin.query("DELETE FROM tenant_wage_index");
    await admin.query("ALTER TABLE tenant_wage_index ENABLE TRIGGER trg_tenant_wage_index_guard");
    await admin.query("DELETE FROM wage_index_factor WHERE load_source_ref = 'f211-test'");
  }

  async function seedPlatform(ccn: string, fy: number, factor: string, authoritative: boolean) {
    await admin.query(
      `INSERT INTO wage_index_factor (ccn, fiscal_year_starting, cbsa_code, factor_decimal, load_source_ref, is_authoritative)
       VALUES ($1,$2,'12060',$3,'f211-test',$4)`,
      [ccn, fy, factor, authoritative],
    );
  }

  async function asApp<T>(orgId: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
      return await fn(c);
    } finally {
      await c.query("ROLLBACK");
      await c.end();
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
    for (const [id, slug] of [
      [ORG_A, "org-a"],
      [ORG_B, "org-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)",
        [id, slug, slug],
      );
    }
    // The M4 audit trigger dereferences app.user_id as an FK: real user rows.
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'f211a@x.test'),($2,'f211b@x.test')`,
      [USER_A, USER_B],
    );
    appUrl = await appRoleConnectionString(admin, DB_URL as string);
    handle = createDbClient({ connectionString: appUrl });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  describe("migration 0280 side effects", () => {
    it("marks the five 0080 placeholder rows non-authoritative and leaves the column default TRUE", async () => {
      const { rows } = await admin.query(
        "SELECT ccn, is_authoritative FROM wage_index_factor WHERE load_source_ref LIKE 'TODO(cms-fixture)%' ORDER BY ccn",
      );
      expect(rows.map((r) => r.ccn)).toEqual(["010001", "050002", "380001", "450003", "999999"]);
      expect(rows.every((r) => r.is_authoritative === false)).toBe(true);
      await seedPlatform("111111", 2025, "1.1000", true);
      const one = await admin.query(
        "SELECT is_authoritative FROM wage_index_factor WHERE ccn='111111' AND fiscal_year_starting=2025",
      );
      expect(one.rows[0].is_authoritative).toBe(true);
      await admin.query("DELETE FROM wage_index_factor WHERE ccn='111111'");
    });

    it("grants the two new permission keys to the admin roles only (catalog mirror rows exist)", async () => {
      const { rows } = await admin.query(
        "SELECT key, default_abac FROM permission WHERE key IN ('billing.wage_index.read','billing.wage_index.admin') ORDER BY key",
      );
      expect(rows).toEqual([
        { key: "billing.wage_index.admin", default_abac: "inOrg" },
        { key: "billing.wage_index.read", default_abac: "inOrg" },
      ]);
    });
  });

  describe("create / read", () => {
    it("creates a value, reads it back by id, list and live lookup, bound to the actor's org and membership", async () => {
      await reset();
      const created = await svc().createWageIndex(actorA, entry({ entryReason: "annual load" }));
      expect(created).toMatchObject({
        organizationId: ORG_A,
        ccn: CCN,
        fiscalYearStarting: 2025,
        cbsaCode: "38900",
        factorDecimal: "1.0342",
        enteredByMembershipId: MEMBERSHIP_A,
        entryReason: "annual load",
        supersededAt: null,
        supersededById: null,
      });
      expect(await svc().getWageIndex(actorA, created.wageIndexId)).toEqual(created);
      expect((await svc().listWageIndexes(actorA, {})).map((r) => r.wageIndexId)).toEqual([
        created.wageIndexId,
      ]);
      expect(await svc().liveWageIndex(actorA, CCN, 2025)).toEqual(created);
      expect(await svc().liveWageIndex(actorA, CCN, 2024)).toBeNull();
      expect(await svc().liveWageIndex(actorA, "999000", 2025)).toBeNull();
    });

    it("stores the factor exactly as a four-place decimal string (no float drift) and allows a null CBSA", async () => {
      await reset();
      const created = await svc().createWageIndex(
        actorA,
        entry({ factorDecimal: "0.9", cbsaCode: undefined }),
      );
      expect(created.factorDecimal).toBe("0.9000");
      expect(created.cbsaCode).toBeNull();
    });

    it("the M4 audit trigger records the entry (insert) in audit_event", async () => {
      await reset();
      const created = await svc().createWageIndex(actorA, entry());
      const { rows } = await admin.query(
        "SELECT event_type, actor_user_id FROM audit_event WHERE resource_kind='tenant_wage_index' AND resource_id=$1",
        [created.wageIndexId],
      );
      expect(rows).toEqual([{ event_type: "tenant_wage_index.insert", actor_user_id: USER_A }]);
    });

    it("filters the list by CCN and fiscal year, newest fiscal year first", async () => {
      await reset();
      await svc().createWageIndex(actorA, entry());
      await svc().createWageIndex(
        actorA,
        entry({ fiscalYearStarting: 2024, factorDecimal: "1.0100" }),
      );
      await svc().createWageIndex(actorA, entry({ ccn: "050002", factorDecimal: "1.5000" }));
      expect(
        (await svc().listWageIndexes(actorA, {})).map((r) => `${r.ccn}/${r.fiscalYearStarting}`),
      ).toEqual(["050002/2025", "381240/2025", "381240/2024"]);
      expect((await svc().listWageIndexes(actorA, { ccn: CCN })).length).toBe(2);
      expect((await svc().listWageIndexes(actorA, { fiscalYearStarting: 2024 })).length).toBe(1);
    });
  });

  describe("validation is a typed 422; the database CHECKs are the backstop", () => {
    it.each([
      ["a factor below the band (0.4999)", { factorDecimal: "0.4999" }],
      ["a factor above the band (2.5001)", { factorDecimal: "2.5001" }],
      ["a factor keyed as a percent (103.42)", { factorDecimal: "103.42" }],
      ["a five-place factor", { factorDecimal: "1.03421" }],
      ["a short CCN", { ccn: "38124" }],
      ["a fiscal year beyond next", { fiscalYearStarting: 2099 }],
      ["a blank source", { sourceReference: "  " }],
      ["a bad CBSA", { cbsaCode: "389" }],
    ] as const)("refuses %s", async (_name, over) => {
      await reset();
      await expect(svc().createWageIndex(actorA, entry(over))).rejects.toMatchObject({
        code: "WAGE_INDEX_INVALID",
        statusCode: 422,
      });
      expect(await svc().listWageIndexes(actorA, { includeSuperseded: true })).toEqual([]);
    });

    it("the database itself refuses an out-of-band factor even bypassing the service (23514)", async () => {
      await reset();
      await asApp(ORG_A, async (c) => {
        await expect(
          c.query(
            `INSERT INTO tenant_wage_index (organization_id, ccn, fiscal_year_starting, factor_decimal, source_reference, entered_by_membership_id)
             VALUES ($1,$2,2025,3.0,'x',$3)`,
            [ORG_A, CCN, MEMBERSHIP_A],
          ),
        ).rejects.toMatchObject({ code: "23514" });
      });
    });
  });

  describe("one live value per CCN + fiscal year", () => {
    it("rejects a second live value with a 409 naming the clash, but admits another year or CCN", async () => {
      await reset();
      const first = await svc().createWageIndex(actorA, entry());
      await expect(
        svc().createWageIndex(actorA, entry({ factorDecimal: "1.0500" })),
      ).rejects.toMatchObject({
        code: "WAGE_INDEX_EXISTS",
        statusCode: 409,
        message: expect.stringContaining(first.wageIndexId),
      });
      await svc().createWageIndex(actorA, entry({ fiscalYearStarting: 2024 }));
      await svc().createWageIndex(actorA, entry({ ccn: "050002" }));
    });

    it("the partial unique index is the race-safe backstop: a direct duplicate live insert is refused (23505)", async () => {
      await reset();
      await svc().createWageIndex(actorA, entry());
      await asApp(ORG_A, async (c) => {
        await expect(
          c.query(
            `INSERT INTO tenant_wage_index (organization_id, ccn, fiscal_year_starting, factor_decimal, source_reference, entered_by_membership_id)
             VALUES ($1,$2,2025,1.2,'x',$3)`,
            [ORG_A, CCN, MEMBERSHIP_A],
          ),
        ).rejects.toMatchObject({ code: "23505" });
      });
    });

    it("two tenants may each hold a value for the same CCN + year", async () => {
      await reset();
      await svc().createWageIndex(actorA, entry());
      await expect(
        svc().createWageIndex(actorB, entry({ factorDecimal: "0.9100" })),
      ).resolves.toMatchObject({
        organizationId: ORG_B,
        factorDecimal: "0.9100",
      });
    });
  });

  describe("supersede (append-only correction)", () => {
    it("keeps the old value as history, makes the successor live, and rejects a second supersede", async () => {
      await reset();
      const v1 = await svc().createWageIndex(actorA, entry());
      const v2 = await svc().supersedeWageIndex(
        actorA,
        v1.wageIndexId,
        entry({ factorDecimal: "1.0432", entryReason: "transposed digits" }),
      );
      expect(v2.wageIndexId).not.toBe(v1.wageIndexId);
      expect(v2).toMatchObject({ factorDecimal: "1.0432", supersededAt: null });
      expect((await svc().liveWageIndex(actorA, CCN, 2025))?.wageIndexId).toBe(v2.wageIndexId);
      const old = await svc().getWageIndex(actorA, v1.wageIndexId);
      expect(old.supersededById).toBe(v2.wageIndexId);
      expect(old.supersededAt).not.toBeNull();
      expect(old.factorDecimal).toBe("1.0342");
      expect((await svc().listWageIndexes(actorA, {})).map((r) => r.wageIndexId)).toEqual([
        v2.wageIndexId,
      ]);
      expect(
        (await svc().listWageIndexes(actorA, { includeSuperseded: true }))
          .map((r) => r.wageIndexId)
          .sort(),
      ).toEqual([v1.wageIndexId, v2.wageIndexId].sort());
      await expect(svc().supersedeWageIndex(actorA, v1.wageIndexId, entry())).rejects.toMatchObject(
        {
          code: "WAGE_INDEX_ALREADY_SUPERSEDED",
          statusCode: 409,
        },
      );
    });

    it("an invalid correction leaves the live value untouched (the supersede is one transaction)", async () => {
      await reset();
      const v1 = await svc().createWageIndex(actorA, entry());
      await expect(
        svc().supersedeWageIndex(actorA, v1.wageIndexId, entry({ factorDecimal: "9.9999" })),
      ).rejects.toMatchObject({ code: "WAGE_INDEX_INVALID" });
      expect((await svc().liveWageIndex(actorA, CCN, 2025))?.wageIndexId).toBe(v1.wageIndexId);
    });

    it("a supersede cannot change the CCN or fiscal year, and another tenant's id is a 404", async () => {
      await reset();
      const v1 = await svc().createWageIndex(actorA, entry());
      await expect(
        svc().supersedeWageIndex(actorA, v1.wageIndexId, entry({ ccn: "050002" })),
      ).rejects.toMatchObject({ code: "WAGE_INDEX_KEY_MISMATCH", statusCode: 422 });
      await expect(
        svc().supersedeWageIndex(actorA, v1.wageIndexId, entry({ fiscalYearStarting: 2024 })),
      ).rejects.toMatchObject({ code: "WAGE_INDEX_KEY_MISMATCH" });
      await expect(svc().supersedeWageIndex(actorB, v1.wageIndexId, entry())).rejects.toMatchObject(
        {
          statusCode: 404,
        },
      );
      expect((await svc().liveWageIndex(actorA, CCN, 2025))?.wageIndexId).toBe(v1.wageIndexId);
    });
  });

  describe("append-only at the database (the app role cannot edit a value or delete a row)", () => {
    it("refuses UPDATE of the factor and DELETE", async () => {
      await reset();
      const v1 = await svc().createWageIndex(actorA, entry());
      await asApp(ORG_A, async (c) => {
        await expect(
          c.query("UPDATE tenant_wage_index SET factor_decimal = 1.9 WHERE id = $1", [
            v1.wageIndexId,
          ]),
        ).rejects.toMatchObject({ code: "42501" });
      });
      await asApp(ORG_A, async (c) => {
        await expect(
          c.query("DELETE FROM tenant_wage_index WHERE id = $1", [v1.wageIndexId]),
        ).rejects.toMatchObject({
          code: "42501",
        });
      });
    });

    it("the guard trigger freezes the value even against a superuser UPDATE, and a superseded row entirely", async () => {
      await reset();
      const v1 = await svc().createWageIndex(actorA, entry());
      await expect(
        admin.query("UPDATE tenant_wage_index SET factor_decimal = 1.9 WHERE id = $1", [
          v1.wageIndexId,
        ]),
      ).rejects.toThrow(/append-only/);
      await svc().supersedeWageIndex(actorA, v1.wageIndexId, entry({ factorDecimal: "1.0400" }));
      await asApp(ORG_A, async (c) => {
        await expect(
          c.query(
            "UPDATE tenant_wage_index SET superseded_by_id = gen_random_uuid() WHERE id = $1",
            [v1.wageIndexId],
          ),
        ).rejects.toMatchObject({ code: "23001" });
      });
    });
  });

  describe("cross-tenant isolation (real RLS on chartwarden_app)", () => {
    it("org B never sees, fetches or resolves org A's wage index", async () => {
      await reset();
      const a = await svc().createWageIndex(actorA, entry());
      expect(await svc().listWageIndexes(actorB, { includeSuperseded: true })).toEqual([]);
      await expect(svc().getWageIndex(actorB, a.wageIndexId)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(await svc().liveWageIndex(actorB, CCN, 2025)).toBeNull();
      expect(await resolveWageIndexForOrg(handle.db, ORG_B, CCN, 2025)).toBeNull();
      expect(await resolveWageIndexForOrg(handle.db, ORG_A, CCN, 2025)).toEqual({
        factorDecimal: "1.0342",
        cbsaCode: "38900",
        source: "tenant",
      });
    });

    it("RLS WITH CHECK refuses a row forged into another organization", async () => {
      await reset();
      await asApp(ORG_B, async (c) => {
        await expect(
          c.query(
            `INSERT INTO tenant_wage_index (organization_id, ccn, fiscal_year_starting, factor_decimal, source_reference, entered_by_membership_id)
             VALUES ($1,$2,2025,1.1,'x',$3)`,
            [ORG_A, CCN, MEMBERSHIP_A],
          ),
        ).rejects.toMatchObject({ code: "42501" });
      });
    });

    it("no organization context, no rows (RLS is FORCED, not just enabled)", async () => {
      await reset();
      await svc().createWageIndex(actorA, entry());
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        const { rows } = await c.query("SELECT count(*)::int AS n FROM tenant_wage_index");
        expect(rows[0].n).toBe(0);
      } finally {
        await c.end();
      }
    });

    it("a tenant entry never touches the platform-shared table or another tenant's pricing", async () => {
      await reset();
      await svc().createWageIndex(actorA, entry({ factorDecimal: "1.4000" }));
      const platform = await admin.query(
        "SELECT count(*)::int AS n FROM wage_index_factor WHERE ccn = $1",
        [CCN],
      );
      expect(platform.rows[0].n).toBe(0);
      const adapter = buildM23ReferenceDataAdapter(handle.db);
      expect(await adapter.wageIndexForCcn(CCN, 2025, ORG_B)).toBeNull();
      expect(await adapter.wageIndexForCcn(CCN, 2025, ORG_A)).toEqual({
        factorDecimal: "1.4000",
        cbsaCode: "38900",
      });
      // and the app role cannot write the platform table at all
      await asApp(ORG_A, async (c) => {
        await expect(
          c.query(
            `INSERT INTO wage_index_factor (ccn, fiscal_year_starting, factor_decimal, load_source_ref) VALUES ('222222',2025,'1.0','x')`,
          ),
        ).rejects.toMatchObject({ code: "42501" });
      });
    });
  });

  describe("referenceData adapter precedence (what POST /claims/assemble reads)", () => {
    it("tenant value wins over an authoritative platform row", async () => {
      await reset();
      await seedPlatform(CCN, 2025, "0.9000", true);
      await svc().createWageIndex(actorA, entry({ factorDecimal: "1.0342" }));
      const adapter = buildM23ReferenceDataAdapter(handle.db);
      expect(await adapter.wageIndexForCcn(CCN, 2025, ORG_A)).toEqual({
        factorDecimal: "1.0342",
        cbsaCode: "38900",
      });
      // another tenant with no entry of its own falls through to the authoritative platform row
      expect(await adapter.wageIndexForCcn(CCN, 2025, ORG_B)).toEqual({
        factorDecimal: "0.9000",
        cbsaCode: "12060",
      });
    });

    it("falls back to an AUTHORITATIVE platform row; never to a non-authoritative placeholder", async () => {
      await reset();
      await seedPlatform("333333", 2025, "1.2000", true);
      await seedPlatform("444444", 2025, "1.0000", false);
      const adapter = buildM23ReferenceDataAdapter(handle.db);
      expect(await adapter.wageIndexForCcn("333333", 2025, ORG_A)).toEqual({
        factorDecimal: "1.2000",
        cbsaCode: "12060",
      });
      expect(await adapter.wageIndexForCcn("444444", 2025, ORG_A)).toBeNull();
      // a tenant entry rescues the placeholder CCN
      await svc().createWageIndex(actorA, entry({ ccn: "444444", factorDecimal: "1.0700" }));
      expect(await adapter.wageIndexForCcn("444444", 2025, ORG_A)).toEqual({
        factorDecimal: "1.0700",
        cbsaCode: "38900",
      });
    });

    it("returns null (fail closed) when neither exists, and after a supersede answers with the correction only", async () => {
      await reset();
      const adapter = buildM23ReferenceDataAdapter(handle.db);
      expect(await adapter.wageIndexForCcn(CCN, 2025, ORG_A)).toBeNull();
      const v1 = await svc().createWageIndex(actorA, entry());
      await svc().supersedeWageIndex(actorA, v1.wageIndexId, entry({ factorDecimal: "1.0500" }));
      expect(await adapter.wageIndexForCcn(CCN, 2025, ORG_A)).toEqual({
        factorDecimal: "1.0500",
        cbsaCode: "38900",
      });
    });
  });
});
