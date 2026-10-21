/**
 * M23 tenant-entered hospice RATE TABLE — LIVE Postgres proof (F-210).
 *
 * `POST /claims/assemble` stopped at `SEAM_UNBOUND` on `referenceData.perDiemRateTable` because no CMS per-diem
 * rate data existed anywhere. Rates are now TENANT-ENTERED into the M23-owned `hospice_rate_table` (migration
 * 0279) through `buildDrizzleRateTableService`, and `buildM23ReferenceDataAdapter` reads the version covering the
 * claim's service date. This proves, against real rows under REAL RLS (every service call runs on the migrated
 * NOBYPASSRLS `chartwarden_app` role via `_live-app-role.ts`; the superuser client only seeds and inspects):
 *   - create / supersede / list / get / effective-on, and the audit trail the M4 trigger writes;
 *   - validation (dollars-as-cents, tier order, CHC hourly x24, fiscal-year window) as a typed 422;
 *   - non-overlap: the service pre-check (409 with the clashing id) AND the database EXCLUDE backstop;
 *   - append-only: the app role can neither edit a rate nor delete a row, and a superseded row is frozen;
 *   - cross-tenant isolation (read, lookup, and the RLS WITH CHECK on a forged organization_id);
 *   - the date lookup (inclusive boundaries) and the adapter's wage-adjusted CHC hourly + `RATE_TABLE_MISSING`.
 * No outbox event is emitted by this surface, so there is no publisher to bind.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m23-rate-table.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { M23WriteActor } from "../src/modules/23-billing-medicare/routes/actor";
import {
  buildDrizzleRateTableService,
  hospiceRateTableEffectiveForOrg,
} from "../src/modules/23-billing-medicare/routes/rate-table-service";
import type { CreateRateTableBody } from "../src/modules/23-billing-medicare/routes/rate-table-typebox";
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
const PE_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PE_A2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PE_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

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

/** FY2026 (Oct 2025 - Sep 2026) national-shaped rates in whole cents; 24 x 4400 = 105600. */
function rates(over: Partial<CreateRateTableBody> = {}): CreateRateTableBody {
  return {
    providerEntityId: PE_A,
    fiscalYearStarting: 2025,
    effectiveFrom: "2025-10-01",
    rhcDays1to60PerDiemCents: 21_500,
    rhcDays61PlusPerDiemCents: 17_000,
    chcPerDiemCents: 105_600,
    ircPerDiemCents: 49_000,
    gipPerDiemCents: 118_000,
    chcHourlyRateCents: 4_400,
    laborShareRhc: "0.6600",
    laborShareChc: "0.6800",
    laborShareIrc: "0.5400",
    laborShareGip: "0.6400",
    ...over,
  };
}

describe.skipIf(!DB_URL)("M23 hospice rate table — LIVE Postgres (F-210)", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let appUrl: string;
  const svc = () => buildDrizzleRateTableService(handle.db);

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
    // The app role cannot delete; the superuser resets between tests (the guard trigger admits only the
    // destruction role, so disable it for the reset only).
    await admin.query(
      "ALTER TABLE hospice_rate_table DISABLE TRIGGER trg_hospice_rate_table_guard",
    );
    await admin.query("DELETE FROM hospice_rate_table");
    await admin.query("ALTER TABLE hospice_rate_table ENABLE TRIGGER trg_hospice_rate_table_guard");
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
      `INSERT INTO "user" (id,email) VALUES ($1,'f206a@x.test'),($2,'f206b@x.test')`,
      [USER_A, USER_B],
    );
    appUrl = await appRoleConnectionString(admin, DB_URL as string);
    handle = createDbClient({ connectionString: appUrl });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  describe("create / list / get / effective-on", () => {
    it("creates a version, defaulting effectiveTo to the fiscal-year end, and reads it back", async () => {
      await reset();
      const created = await svc().createRateTable(
        actorA,
        rates({ entryReason: "FY2026 final rule" }),
      );
      expect(created).toMatchObject({
        organizationId: ORG_A,
        providerEntityId: PE_A,
        fiscalYearStarting: 2025,
        effectiveFrom: "2025-10-01",
        effectiveTo: "2026-09-30",
        rhcDays1to60PerDiemCents: 21_500,
        chcHourlyRateCents: 4_400,
        enteredByMembershipId: MEMBERSHIP_A,
        entryReason: "FY2026 final rule",
        supersededAt: null,
        supersededById: null,
      });
      expect(await svc().getRateTable(actorA, PE_A, created.rateTableId)).toEqual(created);
      expect((await svc().listRateTables(actorA, PE_A, {})).map((r) => r.rateTableId)).toEqual([
        created.rateTableId,
      ]);
    });

    it("the M4 audit trigger records the entry (insert) in audit_event", async () => {
      await reset();
      const created = await svc().createRateTable(actorA, rates());
      const { rows } = await admin.query(
        "SELECT event_type, actor_user_id FROM audit_event WHERE resource_kind='hospice_rate_table' AND resource_id=$1",
        [created.rateTableId],
      );
      expect(rows).toEqual([{ event_type: "hospice_rate_table.insert", actor_user_id: USER_A }]);
    });

    it("looks up by service date with inclusive boundaries and null outside every window", async () => {
      await reset();
      await svc().createRateTable(actorA, rates());
      const at = (d: string) => svc().effectiveRateTable(actorA, PE_A, d);
      expect((await at("2025-10-01"))?.effectiveFrom).toBe("2025-10-01");
      expect(await at("2026-09-30")).not.toBeNull();
      expect(await at("2025-09-30")).toBeNull();
      expect(await at("2026-10-01")).toBeNull();
    });

    it("picks the right version when two fiscal years are entered", async () => {
      await reset();
      await svc().createRateTable(actorA, rates());
      await svc().createRateTable(
        actorA,
        rates({
          fiscalYearStarting: 2026,
          effectiveFrom: "2026-10-01",
          rhcDays1to60PerDiemCents: 22_300,
          chcPerDiemCents: 108_000,
          chcHourlyRateCents: 4_500,
        }),
      );
      expect(
        (await svc().effectiveRateTable(actorA, PE_A, "2026-09-30"))?.rhcDays1to60PerDiemCents,
      ).toBe(21_500);
      expect(
        (await svc().effectiveRateTable(actorA, PE_A, "2026-10-01"))?.rhcDays1to60PerDiemCents,
      ).toBe(22_300);
    });

    it("scopes versions to the provider entity", async () => {
      await reset();
      await svc().createRateTable(actorA, rates());
      expect(await svc().effectiveRateTable(actorA, PE_A2, "2026-01-01")).toBeNull();
      // a different provider entity may hold its OWN version over the same dates
      await svc().createRateTable(actorA, rates({ providerEntityId: PE_A2 }));
      expect(await svc().effectiveRateTable(actorA, PE_A2, "2026-01-01")).not.toBeNull();
    });
  });

  describe("validation (typed 422, nothing written)", () => {
    it.each([
      ["dollars keyed as cents", { rhcDays1to60PerDiemCents: 215 }, /plausible band/],
      [
        "RHC tiers reversed",
        { rhcDays1to60PerDiemCents: 16_000, rhcDays61PlusPerDiemCents: 17_000 },
        /ADR-0001/,
      ],
      ["CHC hourly disagrees with the per-diem", { chcHourlyRateCents: 5_400 }, /must agree/],
      ["window outside the fiscal year", { effectiveFrom: "2025-09-01" }, /fiscal year 2025/],
    ])("rejects %s", async (_name, over, message) => {
      await reset();
      await expect(svc().createRateTable(actorA, rates(over))).rejects.toMatchObject({
        code: "RATE_TABLE_INVALID",
        statusCode: 422,
        message: expect.stringMatching(message),
      });
      const { rows } = await admin.query("SELECT count(*)::int AS n FROM hospice_rate_table");
      expect(rows[0].n).toBe(0);
    });

    it("the database CHECKs are a second wall: a direct app-role insert of a bad rate is refused", async () => {
      await reset();
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
        await expect(
          c.query(
            `INSERT INTO hospice_rate_table (organization_id, provider_entity_id, fiscal_year_starting, effective_from,
               rhc_days_1_60_per_diem_cents, rhc_days_61_plus_per_diem_cents, chc_per_diem_cents, irc_per_diem_cents,
               gip_per_diem_cents, chc_hourly_rate_cents, entered_by_membership_id)
             VALUES ($1,$2,2025,'2025-10-01', 215, 170, 105600, 49000, 118000, 4400, $3)`,
            [ORG_A, PE_A, MEMBERSHIP_A],
          ),
        ).rejects.toMatchObject({ code: "23514" });
      } finally {
        await c.query("ROLLBACK");
        await c.end();
      }
    });
  });

  describe("non-overlap", () => {
    it("rejects an overlapping window with a 409 naming the clashing version", async () => {
      await reset();
      const first = await svc().createRateTable(actorA, rates({ effectiveTo: "2026-03-31" }));
      await expect(
        svc().createRateTable(actorA, rates({ effectiveFrom: "2026-03-31" })),
      ).rejects.toMatchObject({
        code: "RATE_TABLE_OVERLAP",
        statusCode: 409,
        message: expect.stringContaining(first.rateTableId),
      });
    });

    it("admits an adjacent window (the day after)", async () => {
      await reset();
      await svc().createRateTable(actorA, rates({ effectiveTo: "2026-03-31" }));
      const second = await svc().createRateTable(actorA, rates({ effectiveFrom: "2026-04-01" }));
      expect(second.effectiveTo).toBe("2026-09-30");
    });

    it("the EXCLUDE constraint is the race-safe backstop: a direct overlapping insert is refused (23P01)", async () => {
      await reset();
      await svc().createRateTable(actorA, rates());
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
        await expect(
          c.query(
            `INSERT INTO hospice_rate_table (organization_id, provider_entity_id, fiscal_year_starting, effective_from, effective_to,
               rhc_days_1_60_per_diem_cents, rhc_days_61_plus_per_diem_cents, chc_per_diem_cents, irc_per_diem_cents,
               gip_per_diem_cents, chc_hourly_rate_cents, entered_by_membership_id)
             VALUES ($1,$2,2025,'2026-01-01','2026-01-31', 21500, 17000, 105600, 49000, 118000, 4400, $3)`,
            [ORG_A, PE_A, MEMBERSHIP_A],
          ),
        ).rejects.toMatchObject({ code: "23P01" });
      } finally {
        await c.query("ROLLBACK");
        await c.end();
      }
    });

    it("two tenants may hold the same dates (overlap is per organization and provider entity)", async () => {
      await reset();
      await svc().createRateTable(actorA, rates());
      await expect(
        svc().createRateTable(actorB, rates({ providerEntityId: PE_B })),
      ).resolves.toMatchObject({ organizationId: ORG_B });
    });
  });

  describe("supersede (append-only correction)", () => {
    it("keeps the old version as history, makes the successor live, and rejects a second supersede", async () => {
      await reset();
      const v1 = await svc().createRateTable(actorA, rates());
      const v2 = await svc().supersedeRateTable(
        actorA,
        v1.rateTableId,
        rates({ rhcDays1to60PerDiemCents: 21_600, entryReason: "mis-keyed day 1-60 rate" }),
      );
      expect(v2.rateTableId).not.toBe(v1.rateTableId);
      expect(v2).toMatchObject({ rhcDays1to60PerDiemCents: 21_600, supersededAt: null });

      // the lookup now answers with the correction
      expect((await svc().effectiveRateTable(actorA, PE_A, "2026-01-01"))?.rateTableId).toBe(
        v2.rateTableId,
      );
      // the old row is retained, flagged, and names its successor
      const old = await svc().getRateTable(actorA, PE_A, v1.rateTableId);
      expect(old.supersededById).toBe(v2.rateTableId);
      expect(old.supersededAt).not.toBeNull();
      expect(old.rhcDays1to60PerDiemCents).toBe(21_500);
      // default list = live only; includeSuperseded = full history
      expect((await svc().listRateTables(actorA, PE_A, {})).map((r) => r.rateTableId)).toEqual([
        v2.rateTableId,
      ]);
      expect(
        (await svc().listRateTables(actorA, PE_A, { includeSuperseded: true }))
          .map((r) => r.rateTableId)
          .sort(),
      ).toEqual([v1.rateTableId, v2.rateTableId].sort());
      // superseding the superseded row again is a 409, never a second live version
      await expect(svc().supersedeRateTable(actorA, v1.rateTableId, rates())).rejects.toMatchObject(
        { code: "RATE_TABLE_ALREADY_SUPERSEDED", statusCode: 409 },
      );
    });

    it("an invalid successor leaves the original live (the whole supersede rolls back)", async () => {
      await reset();
      const v1 = await svc().createRateTable(actorA, rates());
      await expect(
        svc().supersedeRateTable(actorA, v1.rateTableId, rates({ rhcDays1to60PerDiemCents: 5 })),
      ).rejects.toMatchObject({ code: "RATE_TABLE_INVALID" });
      expect((await svc().getRateTable(actorA, PE_A, v1.rateTableId)).supersededAt).toBeNull();
    });

    it("a successor overlapping ANOTHER live version rolls back and leaves the original live", async () => {
      await reset();
      const h1 = await svc().createRateTable(actorA, rates({ effectiveTo: "2026-03-31" }));
      await svc().createRateTable(actorA, rates({ effectiveFrom: "2026-04-01" }));
      await expect(
        svc().supersedeRateTable(actorA, h1.rateTableId, rates({ effectiveTo: "2026-06-30" })),
      ).rejects.toMatchObject({ code: "RATE_TABLE_OVERLAP", statusCode: 409 });
      expect((await svc().getRateTable(actorA, PE_A, h1.rateTableId)).supersededAt).toBeNull();
    });

    it("404s a provider-entity mismatch and another tenant's row (no existence leak)", async () => {
      await reset();
      const v1 = await svc().createRateTable(actorA, rates());
      await expect(
        svc().supersedeRateTable(actorA, v1.rateTableId, rates({ providerEntityId: PE_A2 })),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        svc().supersedeRateTable(actorB, v1.rateTableId, rates({ providerEntityId: PE_A })),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("append-only at the database (the app role cannot edit a rate or delete a row)", () => {
    async function asApp<T>(fn: (c: Client) => Promise<T>): Promise<T> {
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
        return await fn(c);
      } finally {
        await c.query("ROLLBACK");
        await c.end();
      }
    }

    it("refuses UPDATE of a rate column and DELETE", async () => {
      await reset();
      const v1 = await svc().createRateTable(actorA, rates());
      await asApp(async (c) => {
        await expect(
          c.query("UPDATE hospice_rate_table SET gip_per_diem_cents = 1 WHERE id = $1", [
            v1.rateTableId,
          ]),
        ).rejects.toMatchObject({ code: "42501" });
      });
      await asApp(async (c) => {
        await expect(
          c.query("DELETE FROM hospice_rate_table WHERE id = $1", [v1.rateTableId]),
        ).rejects.toMatchObject({ code: "42501" });
      });
    });

    it("the guard trigger freezes a superseded row even for the supersede columns", async () => {
      await reset();
      const v1 = await svc().createRateTable(actorA, rates());
      await svc().supersedeRateTable(actorA, v1.rateTableId, rates());
      await asApp(async (c) => {
        await expect(
          c.query(
            "UPDATE hospice_rate_table SET superseded_by_id = gen_random_uuid() WHERE id = $1",
            [v1.rateTableId],
          ),
        ).rejects.toMatchObject({ code: "23001" });
      });
    });
  });

  describe("cross-tenant isolation (real RLS on chartwarden_app)", () => {
    it("org B never sees, fetches or resolves org A's rates", async () => {
      await reset();
      const a = await svc().createRateTable(actorA, rates());
      // even when B asks for A's provider entity id by name
      expect(await svc().listRateTables(actorB, PE_A, { includeSuperseded: true })).toEqual([]);
      await expect(svc().getRateTable(actorB, PE_A, a.rateTableId)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(await svc().effectiveRateTable(actorB, PE_A, "2026-01-01")).toBeNull();
      // the org-explicit seam function the assembly adapter uses
      expect(
        await hospiceRateTableEffectiveForOrg(handle.db, ORG_B, PE_A, "2026-01-01"),
      ).toBeNull();
      expect(
        (await hospiceRateTableEffectiveForOrg(handle.db, ORG_A, PE_A, "2026-01-01"))?.id,
      ).toBe(a.rateTableId);
    });

    it("RLS WITH CHECK refuses a row forged into another organization", async () => {
      await reset();
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_B]);
        await expect(
          c.query(
            `INSERT INTO hospice_rate_table (organization_id, provider_entity_id, fiscal_year_starting, effective_from,
               rhc_days_1_60_per_diem_cents, rhc_days_61_plus_per_diem_cents, chc_per_diem_cents, irc_per_diem_cents,
               gip_per_diem_cents, chc_hourly_rate_cents, entered_by_membership_id)
             VALUES ($1,$2,2025,'2025-10-01', 21500, 17000, 105600, 49000, 118000, 4400, $3)`,
            [ORG_A, PE_A, MEMBERSHIP_A],
          ),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await c.query("ROLLBACK");
        await c.end();
      }
    });

    it("no organization context, no rows (RLS is FORCED, not just enabled)", async () => {
      await reset();
      await svc().createRateTable(actorA, rates());
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        const { rows } = await c.query("SELECT count(*)::int AS n FROM hospice_rate_table");
        expect(rows[0].n).toBe(0);
      } finally {
        await c.end();
      }
    });
  });

  describe("referenceData adapter (what POST /claims/assemble reads)", () => {
    const scope = (orgId: string, providerEntityId: string, serviceFrom: string) => ({
      orgId,
      providerEntityId,
      serviceFrom,
    });

    it("perDiemRateTable returns the per-diems, the CHC HOURLY rate and the four labor shares for the service date", async () => {
      await reset();
      await svc().createRateTable(actorA, rates());
      const adapter = buildM23ReferenceDataAdapter(handle.db);
      expect(
        await adapter.perDiemRateTable("ngs_j6", 2025, scope(ORG_A, PE_A, "2026-02-14")),
      ).toEqual({
        rhcDays1to60PerDiemCents: 21_500,
        rhcDays61PlusPerDiemCents: 17_000,
        chcHourlyRateCents: 4_400,
        ircPerDiemCents: 49_000,
        gipPerDiemCents: 118_000,
        rhcLaborShare: "0.6600",
        chcLaborShare: "0.6800",
        ircLaborShare: "0.5400",
        gipLaborShare: "0.6400",
      });
    });

    it("chcHourlyRateCents applies the wage index to the CHC LABOR SHARE only (half-up)", async () => {
      await reset();
      await svc().createRateTable(actorA, rates()); // hourly 4400, CHC labor share 0.68
      const adapter = buildM23ReferenceDataAdapter(handle.db);
      // 4400 x (0.68 x 0.9234 + 0.32) = 4400 x 0.947912 = 4170.8128 -> 4171 (the whole-rate multiply gave 4063)
      expect(
        await adapter.chcHourlyRateCents(2025, "0.9234", scope(ORG_A, PE_A, "2026-02-14")),
      ).toBe(4_171);
    });

    it("a version entered BEFORE labor shares existed (NULL set) fails closed RATE_TABLE_LABOR_SHARE_MISSING", async () => {
      await reset();
      await admin.query(
        `INSERT INTO hospice_rate_table (organization_id, provider_entity_id, fiscal_year_starting, effective_from, effective_to,
           rhc_days_1_60_per_diem_cents, rhc_days_61_plus_per_diem_cents, chc_per_diem_cents, irc_per_diem_cents, gip_per_diem_cents,
           chc_hourly_rate_cents, entered_by_membership_id)
         VALUES ($1,$2,2025,'2025-10-01','2026-09-30',21500,17000,105600,49000,118000,4400,$3)`,
        [ORG_A, PE_A, MEMBERSHIP_A],
      );
      const adapter = buildM23ReferenceDataAdapter(handle.db);
      for (const call of [
        () => adapter.perDiemRateTable("ngs_j6", 2025, scope(ORG_A, PE_A, "2026-02-14")),
        () => adapter.chcHourlyRateCents(2025, "0.9234", scope(ORG_A, PE_A, "2026-02-14")),
      ]) {
        await expect(call()).rejects.toMatchObject({
          code: "RATE_TABLE_LABOR_SHARE_MISSING",
          statusCode: 422,
        });
      }
    });

    it("the database CHECKs the labor shares: band, and all-or-none", async () => {
      await reset();
      const ins = (
        rhc: string | null,
        chc: string | null,
        irc: string | null,
        gip: string | null,
      ) =>
        admin.query(
          `INSERT INTO hospice_rate_table (organization_id, provider_entity_id, fiscal_year_starting, effective_from, effective_to,
             rhc_days_1_60_per_diem_cents, rhc_days_61_plus_per_diem_cents, chc_per_diem_cents, irc_per_diem_cents, gip_per_diem_cents,
             chc_hourly_rate_cents, labor_share_rhc, labor_share_chc, labor_share_irc, labor_share_gip, entered_by_membership_id)
           VALUES ($1,$2,2025,'2025-10-01','2026-09-30',21500,17000,105600,49000,118000,4400,$3,$4,$5,$6,$7)`,
          [ORG_A, PE_A, rhc, chc, irc, gip, MEMBERSHIP_A],
        );
      await expect(ins("0.2900", "0.68", "0.54", "0.64")).rejects.toThrow(
        /hospice_rate_table_labor_share_chk/,
      );
      await expect(ins("0.66", "0.9100", "0.54", "0.64")).rejects.toThrow(
        /hospice_rate_table_labor_share_chk/,
      );
      await expect(ins("0.66", "0.68", null, "0.64")).rejects.toThrow(
        /hospice_rate_table_labor_share_chk/,
      );
      await ins("0.66", "0.68", "0.54", "0.64");
    });

    it("a stored labor share is frozen (append-only trigger), even against a superuser UPDATE of the live row", async () => {
      await reset();
      const created = await svc().createRateTable(actorA, rates());
      await expect(
        admin.query("UPDATE hospice_rate_table SET labor_share_rhc = 0.5 WHERE id = $1", [
          created.rateTableId,
        ]),
      ).rejects.toThrow(/append-only/);
    });

    it("prices from the version in effect on the service date, not a later correction window", async () => {
      await reset();
      await svc().createRateTable(actorA, rates({ effectiveTo: "2026-03-31" }));
      await svc().createRateTable(
        actorA,
        rates({ effectiveFrom: "2026-04-01", rhcDays1to60PerDiemCents: 22_000 }),
      );
      const adapter = buildM23ReferenceDataAdapter(handle.db);
      expect(
        (await adapter.perDiemRateTable("ngs_j6", 2025, scope(ORG_A, PE_A, "2026-03-31")))
          .rhcDays1to60PerDiemCents,
      ).toBe(21_500);
      expect(
        (await adapter.perDiemRateTable("ngs_j6", 2025, scope(ORG_A, PE_A, "2026-04-01")))
          .rhcDays1to60PerDiemCents,
      ).toBe(22_000);
    });

    it("fails CLOSED with an actionable RATE_TABLE_MISSING (never SEAM_UNBOUND, never a guess)", async () => {
      await reset();
      const adapter = buildM23ReferenceDataAdapter(handle.db);
      for (const call of [
        () => adapter.perDiemRateTable("ngs_j6", 2025, scope(ORG_A, PE_A, "2026-02-14")),
        () => adapter.chcHourlyRateCents(2025, "0.9234", scope(ORG_A, PE_A, "2026-02-14")),
      ]) {
        await expect(call()).rejects.toMatchObject({
          code: "RATE_TABLE_MISSING",
          statusCode: 422,
          message: expect.stringContaining(`2026-02-14 for provider entity ${PE_A}`),
        });
        await expect(call()).rejects.toMatchObject({
          message: expect.stringContaining("/api/v1/billing/rate-tables"),
        });
      }
    });

    it("RATE_TABLE_MISSING when only ANOTHER tenant, another entity, or another year has rates", async () => {
      await reset();
      await svc().createRateTable(actorB, rates({ providerEntityId: PE_B }));
      await svc().createRateTable(actorA, rates({ providerEntityId: PE_A2 }));
      await svc().createRateTable(actorA, rates()); // FY2026 for PE_A only
      const adapter = buildM23ReferenceDataAdapter(handle.db);
      await expect(
        adapter.perDiemRateTable("ngs_j6", 2025, scope(ORG_A, PE_B, "2026-02-14")),
      ).rejects.toMatchObject({ code: "RATE_TABLE_MISSING" });
      await expect(
        adapter.perDiemRateTable("ngs_j6", 2026, scope(ORG_A, PE_A, "2026-11-01")),
      ).rejects.toMatchObject({ code: "RATE_TABLE_MISSING" });
    });
  });

  // ── FY2027 workstream E — hqrp_compliant (0394) and the national-reference warnings ──
  describe("HQRP status + CMS national reference (migration 0394)", () => {
    const FY2027_NON_COMPLIANT = {
      fiscalYearStarting: 2026,
      effectiveFrom: "2026-10-01",
      rhcDays1to60PerDiemCents: 22_709,
      rhcDays61PlusPerDiemCents: 17_904,
      chcPerDiemCents: 165_866,
      chcHourlyRateCents: 6_911,
      ircPerDiemCents: 52_458,
      gipPerDiemCents: 118_335,
    };

    it("persists hqrpCompliant and warns when the keyed rates are the OTHER column", async () => {
      await reset();
      const declaredCompliant = await svc().createRateTable(
        actorA,
        rates({ ...FY2027_NON_COMPLIANT, hqrpCompliant: true }),
      );
      expect(declaredCompliant.hqrpCompliant).toBe(true);
      expect(declaredCompliant.nationalReferenceWarnings).toHaveLength(1);
      expect(declaredCompliant.nationalReferenceWarnings[0]).toMatch(
        /NON-compliant national rates/,
      );

      const fixed = await svc().supersedeRateTable(
        actorA,
        declaredCompliant.rateTableId,
        rates({ ...FY2027_NON_COMPLIANT, hqrpCompliant: false }),
      );
      expect(fixed.hqrpCompliant).toBe(false);
      expect(fixed.nationalReferenceWarnings).toEqual([]);
      const { rows } = await admin.query(
        "SELECT hqrp_compliant FROM hospice_rate_table WHERE id = $1",
        [fixed.rateTableId],
      );
      expect(rows[0].hqrp_compliant).toBe(false);
    });

    it("an omitted status is stored NULL (undeclared), and the guard freezes it like the rates", async () => {
      await reset();
      const v = await svc().createRateTable(actorA, rates());
      expect(v.hqrpCompliant).toBeNull();
      expect(v.nationalReferenceWarnings).toEqual([]); // no FY2026 reference is bundled
      await expect(
        admin.query("UPDATE hospice_rate_table SET hqrp_compliant = true WHERE id = $1", [
          v.rateTableId,
        ]),
      ).rejects.toThrow(/append-only/);
    });
  });
});
