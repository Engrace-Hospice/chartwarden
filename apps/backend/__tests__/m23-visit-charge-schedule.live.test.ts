/**
 * M23 tenant-entered hospice VISIT-CHARGE SCHEDULE — LIVE Postgres proof (migration 1056).
 *
 * A visit claim line is billed at a charge per 15-minute unit per discipline that the tenant keys into the M23-owned
 * `hospice_visit_charge_schedule` through `buildDrizzleVisitChargeService`; `buildM23ReferenceDataAdapter` reads the
 * live versions covering a claim's service range. This proves, against real rows under REAL RLS (every service call
 * runs on the migrated NOBYPASSRLS `wardenx_app` role via `_live-app-role.ts`; the superuser client only seeds and
 * inspects), the same properties the rate-table suite proves for `hospice_rate_table`:
 *   - create / supersede / list / get / effective-on, the audit trail, and the permission catalog mirror rows;
 *   - validation (no charge at all, dollars-as-cents, inverted window) as a typed 422, and the database CHECKs;
 *   - non-overlap: the service pre-check (409 naming the clashing id) AND the database EXCLUDE backstop;
 *   - append-only: the app role can neither edit a charge nor delete a row, and a superseded row is frozen;
 *   - cross-tenant isolation (read, lookup, and the RLS WITH CHECK on a forged organization_id);
 *   - the adapter's windowed read (`visitChargeVersions`), the exact input claim assembly fails closed on.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m23:visit-charge-schedule:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { M23WriteActor } from "../src/modules/23-billing-medicare/routes/actor";
import { buildDrizzleVisitChargeService } from "../src/modules/23-billing-medicare/routes/visit-charge-service";
import type { CreateVisitChargeBody } from "../src/modules/23-billing-medicare/routes/visit-charge-typebox";
import { buildM23ReferenceDataAdapter } from "../src/modules/23-billing-medicare/services/claim-assembly-seam-adapters";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEMBERSHIP_A = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
const MEMBERSHIP_B = "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1";
const PE_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PE_A2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const actor = (organizationId: string, userId: string, membershipId: string): M23WriteActor => ({
  organizationId,
  userId,
  roles: ["org_admin"],
  membershipId,
  stepUpRecent: false,
  actorKind: "user",
});
const actorA = actor(ORG_A, USER_A, MEMBERSHIP_A);
const actorB = actor(ORG_B, USER_B, MEMBERSHIP_B);

function schedule(over: Partial<CreateVisitChargeBody> = {}): CreateVisitChargeBody {
  return {
    providerEntityId: PE_A,
    effectiveFrom: "2026-10-01",
    rnUnitChargeCents: 2_500,
    aideUnitChargeCents: 1_500,
    mswUnitChargeCents: 0,
    ...over,
  };
}

describe.skipIf(!DB_URL)(
  "M23 hospice visit-charge schedule — LIVE Postgres (migration 1056)",
  () => {
    let admin: Client;
    let handle: { db: DbClient; close: () => Promise<void> };
    let appUrl: string;
    const svc = () => buildDrizzleVisitChargeService(handle.db);

    async function reset() {
      // The app role cannot delete; the superuser resets between tests (the guard trigger admits only the destruction
      // role, so disable it for the reset only).
      await admin.query(
        "ALTER TABLE hospice_visit_charge_schedule DISABLE TRIGGER trg_hospice_visit_charge_schedule_guard",
      );
      await admin.query("DELETE FROM hospice_visit_charge_schedule");
      await admin.query(
        "ALTER TABLE hospice_visit_charge_schedule ENABLE TRIGGER trg_hospice_visit_charge_schedule_guard",
      );
    }

    async function asApp<T>(org: string, fn: (c: Client) => Promise<T>): Promise<T> {
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.org_id', $1, true)", [org]);
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
      const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
        let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        if (stripVector)
          sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
        await admin.query(sql);
      }
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
        `INSERT INTO "user" (id,email) VALUES ($1,'vc-a@x.test'),($2,'vc-b@x.test')`,
        [USER_A, USER_B],
      );
      appUrl = await appRoleConnectionString(admin, DB_URL as string);
      handle = createDbClient({ connectionString: appUrl });
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      await admin?.end();
    });

    it("registers the two permission keys in the catalog mirror", async () => {
      const { rows } = await admin.query(
        "SELECT key FROM permission WHERE key LIKE 'billing.visit_charge.%' ORDER BY key",
      );
      expect(rows.map((r) => r.key)).toEqual([
        "billing.visit_charge.admin",
        "billing.visit_charge.read",
      ]);
    });

    describe("create / list / get / effective-on", () => {
      it("creates an open-ended version with only the entered disciplines, and reads it back", async () => {
        await reset();
        const created = await svc().createVisitCharge(
          actorA,
          schedule({ entryReason: "FY2027 charge master" }),
        );
        expect(created).toMatchObject({
          organizationId: ORG_A,
          providerEntityId: PE_A,
          effectiveFrom: "2026-10-01",
          effectiveTo: null,
          rnUnitChargeCents: 2_500,
          aideUnitChargeCents: 1_500,
          mswUnitChargeCents: 0, // a deliberate free charge, distinct from "not entered"
          lpnUnitChargeCents: null,
          ptUnitChargeCents: null,
          enteredByMembershipId: MEMBERSHIP_A,
          entryReason: "FY2027 charge master",
          supersededAt: null,
        });
        expect(await svc().getVisitCharge(actorA, PE_A, created.visitChargeScheduleId)).toEqual(
          created,
        );
        expect(
          (await svc().listVisitCharges(actorA, PE_A, {})).map((r) => r.visitChargeScheduleId),
        ).toEqual([created.visitChargeScheduleId]);
      });

      it("the M4 audit trigger records the entry (insert) in audit_event", async () => {
        await reset();
        const created = await svc().createVisitCharge(actorA, schedule());
        const { rows } = await admin.query(
          "SELECT event_type, actor_user_id FROM audit_event WHERE resource_kind='hospice_visit_charge_schedule' AND resource_id=$1",
          [created.visitChargeScheduleId],
        );
        expect(rows).toEqual([
          { event_type: "hospice_visit_charge_schedule.insert", actor_user_id: USER_A },
        ]);
      });

      it("looks up by date with inclusive boundaries and null outside every window", async () => {
        await reset();
        await svc().createVisitCharge(actorA, schedule({ effectiveTo: "2027-09-30" }));
        const at = (d: string) => svc().effectiveVisitCharge(actorA, PE_A, d);
        expect(await at("2026-10-01")).not.toBeNull();
        expect(await at("2027-09-30")).not.toBeNull();
        expect(await at("2026-09-30")).toBeNull();
        expect(await at("2027-10-01")).toBeNull();
      });
    });

    describe("validation (typed 422, nothing written)", () => {
      it.each([
        [
          "no charge entered at all",
          {
            rnUnitChargeCents: undefined,
            aideUnitChargeCents: undefined,
            mswUnitChargeCents: undefined,
          },
          /at least one/,
        ],
        ["an inverted window", { effectiveTo: "2026-09-30" }, /must not precede/],
      ])("rejects %s", async (_name, over, message) => {
        await reset();
        await expect(svc().createVisitCharge(actorA, schedule(over))).rejects.toMatchObject({
          code: "VISIT_CHARGE_INVALID",
          statusCode: 422,
          message: expect.stringMatching(message),
        });
        const { rows } = await admin.query(
          "SELECT count(*)::int AS n FROM hospice_visit_charge_schedule",
        );
        expect(rows[0].n).toBe(0);
      });

      it("the database CHECKs are a second wall: a direct app-role insert of an out-of-band charge or an empty schedule is refused", async () => {
        await reset();
        await asApp(ORG_A, async (c) => {
          await expect(
            c.query(
              `INSERT INTO hospice_visit_charge_schedule (organization_id, provider_entity_id, effective_from,
               rn_unit_charge_cents, entered_by_membership_id) VALUES ($1,$2,'2026-10-01', 100001, $3)`,
              [ORG_A, PE_A, MEMBERSHIP_A],
            ),
          ).rejects.toMatchObject({ code: "23514" });
        });
        await asApp(ORG_A, async (c) => {
          await expect(
            c.query(
              `INSERT INTO hospice_visit_charge_schedule (organization_id, provider_entity_id, effective_from,
               entered_by_membership_id) VALUES ($1,$2,'2026-10-01', $3)`,
              [ORG_A, PE_A, MEMBERSHIP_A],
            ),
          ).rejects.toMatchObject({ code: "23514" });
        });
      });
    });

    describe("non-overlap and supersede", () => {
      it("refuses an overlapping live version (409 naming the clash) and allows another provider entity", async () => {
        await reset();
        const v1 = await svc().createVisitCharge(actorA, schedule({ effectiveTo: "2027-09-30" }));
        await expect(
          svc().createVisitCharge(actorA, schedule({ effectiveFrom: "2027-06-01" })),
        ).rejects.toMatchObject({
          code: "VISIT_CHARGE_OVERLAP",
          statusCode: 409,
          message: expect.stringContaining(v1.visitChargeScheduleId),
        });
        await svc().createVisitCharge(actorA, schedule({ providerEntityId: PE_A2 }));
      });

      it("the EXCLUDE constraint is the race-safe backstop beneath the pre-check", async () => {
        await reset();
        await svc().createVisitCharge(actorA, schedule());
        await expect(
          admin.query(
            `INSERT INTO hospice_visit_charge_schedule (organization_id, provider_entity_id, effective_from,
             rn_unit_charge_cents, entered_by_membership_id) VALUES ($1,$2,'2027-01-01', 2600, $3)`,
            [ORG_A, PE_A, MEMBERSHIP_A],
          ),
        ).rejects.toMatchObject({ code: "23P01" });
      });

      it("supersedes a live version: the old row is kept as history and the successor may reuse its window", async () => {
        await reset();
        const v1 = await svc().createVisitCharge(actorA, schedule());
        const v2 = await svc().supersedeVisitCharge(
          actorA,
          v1.visitChargeScheduleId,
          schedule({ rnUnitChargeCents: 2_700 }),
        );
        expect(v2.visitChargeScheduleId).not.toBe(v1.visitChargeScheduleId);
        const history = await svc().listVisitCharges(actorA, PE_A, { includeSuperseded: true });
        expect(history).toHaveLength(2);
        const old = history.find((h) => h.visitChargeScheduleId === v1.visitChargeScheduleId);
        expect(old).toMatchObject({ supersededById: v2.visitChargeScheduleId });
        expect(
          (await svc().effectiveVisitCharge(actorA, PE_A, "2026-12-01"))?.rnUnitChargeCents,
        ).toBe(2_700);
        await expect(
          svc().supersedeVisitCharge(actorA, v1.visitChargeScheduleId, schedule()),
        ).rejects.toMatchObject({ code: "VISIT_CHARGE_ALREADY_SUPERSEDED", statusCode: 409 });
      });
    });

    describe("append-only at the database", () => {
      it("refuses UPDATE of a charge and DELETE by the app role", async () => {
        await reset();
        const v1 = await svc().createVisitCharge(actorA, schedule());
        await asApp(ORG_A, async (c) => {
          await expect(
            c.query(
              "UPDATE hospice_visit_charge_schedule SET rn_unit_charge_cents = 1 WHERE id = $1",
              [v1.visitChargeScheduleId],
            ),
          ).rejects.toMatchObject({ code: "42501" });
        });
        await asApp(ORG_A, async (c) => {
          await expect(
            c.query("DELETE FROM hospice_visit_charge_schedule WHERE id = $1", [
              v1.visitChargeScheduleId,
            ]),
          ).rejects.toMatchObject({ code: "42501" });
        });
      });

      it("the guard trigger freezes a superseded row even for the supersede columns", async () => {
        await reset();
        const v1 = await svc().createVisitCharge(actorA, schedule());
        await svc().supersedeVisitCharge(actorA, v1.visitChargeScheduleId, schedule());
        await asApp(ORG_A, async (c) => {
          await expect(
            c.query(
              "UPDATE hospice_visit_charge_schedule SET superseded_by_id = gen_random_uuid() WHERE id = $1",
              [v1.visitChargeScheduleId],
            ),
          ).rejects.toMatchObject({ code: "23001" });
        });
      });
    });

    describe("cross-tenant isolation (real RLS on wardenx_app)", () => {
      it("org B never sees, fetches or resolves org A's schedule", async () => {
        await reset();
        const a = await svc().createVisitCharge(actorA, schedule());
        expect(await svc().listVisitCharges(actorB, PE_A, { includeSuperseded: true })).toEqual([]);
        await expect(
          svc().getVisitCharge(actorB, PE_A, a.visitChargeScheduleId),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(await svc().effectiveVisitCharge(actorB, PE_A, "2026-12-01")).toBeNull();
      });

      it("RLS WITH CHECK refuses a row forged into another organization", async () => {
        await reset();
        await asApp(ORG_B, async (c) => {
          await expect(
            c.query(
              `INSERT INTO hospice_visit_charge_schedule (organization_id, provider_entity_id, effective_from,
               rn_unit_charge_cents, entered_by_membership_id) VALUES ($1,$2,'2026-10-01', 2500, $3)`,
              [ORG_A, PE_A, MEMBERSHIP_A],
            ),
          ).rejects.toMatchObject({ code: "42501" });
        });
      });

      it("no organization context, no rows (RLS is FORCED, not just enabled)", async () => {
        await reset();
        await svc().createVisitCharge(actorA, schedule());
        const c = new Client({ connectionString: appUrl });
        await c.connect();
        try {
          const { rows } = await c.query(
            "SELECT count(*)::int AS n FROM hospice_visit_charge_schedule",
          );
          expect(rows[0].n).toBe(0);
        } finally {
          await c.end();
        }
      });
    });

    describe("referenceData adapter (what POST /claims/assemble reads)", () => {
      it("visitChargeVersions returns the live versions intersecting the claim window, in the discipline vocabulary", async () => {
        await reset();
        const v1 = await svc().createVisitCharge(actorA, schedule({ effectiveTo: "2026-12-31" }));
        await svc().createVisitCharge(
          actorA,
          schedule({
            effectiveFrom: "2027-01-01",
            rnUnitChargeCents: 2_600,
            ptUnitChargeCents: 3_100,
          }),
        );
        const adapter = buildM23ReferenceDataAdapter(handle.db);

        const spanning = await adapter.visitChargeVersions(ORG_A, PE_A, {
          from: "2026-12-15",
          to: "2027-01-15",
        });
        expect(spanning.map((v) => [v.effectiveFrom, v.effectiveTo])).toEqual([
          ["2026-10-01", "2026-12-31"],
          ["2027-01-01", null],
        ]);
        expect(spanning[0]?.charges).toEqual({
          rn: 2_500,
          lpn: null,
          chha: 1_500,
          msw: 0,
          pt: null,
          ot: null,
          slp: null,
        });
        expect(spanning[1]?.charges.pt).toBe(3_100);

        // a window before any version, another provider entity, and another tenant all read empty
        expect(
          await adapter.visitChargeVersions(ORG_A, PE_A, { from: "2026-01-01", to: "2026-01-31" }),
        ).toEqual([]);
        expect(
          await adapter.visitChargeVersions(ORG_A, PE_A2, { from: "2026-12-15", to: "2027-01-15" }),
        ).toEqual([]);
        expect(
          await adapter.visitChargeVersions(ORG_B, PE_A, { from: "2026-12-15", to: "2027-01-15" }),
        ).toEqual([]);

        // a superseded version is history, never read
        await svc().supersedeVisitCharge(
          actorA,
          v1.visitChargeScheduleId,
          schedule({ effectiveTo: "2026-12-31", rnUnitChargeCents: 2_550 }),
        );
        const after = await adapter.visitChargeVersions(ORG_A, PE_A, {
          from: "2026-10-01",
          to: "2026-10-31",
        });
        expect(after).toHaveLength(1);
        expect(after[0]?.charges.rn).toBe(2_550);
      });
    });
  },
);
