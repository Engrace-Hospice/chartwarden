/**
 * GAP-029 — M17 owns an on-call rotation source, so `VisitAssignmentReader.tonightsOnCallRoster` answers and
 * M19's Direct-model roster sync can create shifts. Before this, the Drizzle store threw unconditionally and
 * every production reconcile resolved `unavailable`.
 *
 * Proven against REAL Postgres as the NOBYPASSRLS `wardenx_app` role, through the production seam
 * (`createVisitAssignmentReader` over `createDrizzleSchedulingSeamStore`) and the production reconciler
 * (`reconcileOrgOnCallRoster`, default roster reader = the registered M17 seam):
 *   - a tenant with NO rotation rows reads as UNAVAILABLE (never as an empty roster that would cancel its
 *     hand-scheduled shifts);
 *   - rotation rows flow through the seam, cancelled and elapsed rows do not, another tenant sees none;
 *   - M19 creates `on_call_shift` rows from them (idempotently) and, once an entry is cancelled, cancels the
 *     scheduled shift it produced.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m17:oncall-roster:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSeam } from "../src/bootstrap/seams/registry";
import {
  SchedulingOnCallRosterUnavailableError,
  createDbSchedulingBackend,
  createDrizzleSchedulingSeamStore,
} from "../src/modules/17-scheduling/index";
import { createVisitAssignmentReader } from "../src/modules/17-scheduling/seams/providers";
import { reconcileOrgOnCallRoster } from "../src/modules/19-oncall/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "a2900000-0000-4000-8000-0000000000a1";
const ORG_B = "b2900000-0000-4000-8000-0000000000b1";
const HOUR_MS = 3_600_000;

type Seed = { pe: string; member: string; member2: string };

describe.skipIf(!DB_URL)("GAP-029 M17 on-call roster — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const seeded: Record<string, Seed> = {};

  async function seedOrg(org: string, slug: string): Promise<void> {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,$2,$2,$2,'active')",
      [org, slug],
    );
    const pe = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-${slug}`, `PE ${slug}`, `NPI-${slug}`],
      )
    ).rows[0].id as string;
    const location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [pe],
      )
    ).rows[0].id as string;
    const members: string[] = [];
    for (const n of ["a", "b"]) {
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `${slug}-${n}@gap029.test`,
        ])
      ).rows[0].id as string;
      members.push(
        (
          await admin.query(
            `INSERT INTO membership (user_id, organization_id, status, default_provider_entity_id,
               default_location_ids) VALUES ($1,$2,'active',$3,$4::jsonb) RETURNING id`,
            [user, org, pe, JSON.stringify([location])],
          )
        ).rows[0].id as string,
      );
    }
    await admin.query(
      `INSERT INTO tenant_oncall_policy
         (organization_id, provider_entity_id, model, escalation_tiers, callback_sla_per_severity)
       VALUES ($1,$2,'direct','{}'::jsonb,'{}'::jsonb)`,
      [org, pe],
    );
    seeded[org] = { pe, member: members[0] as string, member2: members[1] as string };
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
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
    await seedOrg(ORG_A, "gap029-a");
    await seedOrg(ORG_B, "gap029-b");
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    registerSeam(
      "VisitAssignmentReader",
      createVisitAssignmentReader(createDrizzleSchedulingSeamStore(handle.db)),
    );
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  const now = new Date("2026-10-08T20:00:00.000Z");
  const asOf = now.toISOString();
  const readRoster = (org: string) =>
    runWithRequestContext({ organizationId: org, userId: "" }, () =>
      createVisitAssignmentReader(createDrizzleSchedulingSeamStore(handle.db)).tonightsOnCallRoster(
        org as never,
        asOf as never,
      ),
    );
  const shifts = async (org: string) =>
    (
      await admin.query(
        "SELECT status, primary_on_call_membership_id AS m, discipline FROM on_call_shift WHERE organization_id = $1 ORDER BY shift_starts_at",
        [org],
      )
    ).rows;

  it("a tenant with no rotation rows is UNREADABLE, not an empty roster", async () => {
    await expect(readRoster(ORG_A)).rejects.toBeInstanceOf(SchedulingOnCallRosterUnavailableError);
  });

  it("rotation entries flow through the seam; cancelled and elapsed rows and other tenants do not", async () => {
    const svc = createDbSchedulingBackend(handle.db);
    const a = seeded[ORG_A] as Seed;
    const tonight = await svc.createOnCallRotationEntry(ORG_A, a.member, {
      membershipId: a.member,
      discipline: "clinical_rn",
      startsAt: new Date(now.getTime() + HOUR_MS).toISOString(),
      endsAt: new Date(now.getTime() + 9 * HOUR_MS).toISOString(),
    });
    const dropped = await svc.createOnCallRotationEntry(ORG_A, a.member, {
      membershipId: a.member2,
      discipline: "msw",
      startsAt: new Date(now.getTime() + HOUR_MS).toISOString(),
      endsAt: new Date(now.getTime() + 9 * HOUR_MS).toISOString(),
    });
    await svc.createOnCallRotationEntry(ORG_A, a.member, {
      membershipId: a.member2,
      discipline: "clinical_rn",
      startsAt: new Date(now.getTime() - 20 * HOUR_MS).toISOString(),
      endsAt: new Date(now.getTime() - 10 * HOUR_MS).toISOString(),
    });
    await svc.cancelOnCallRotationEntry(ORG_A, a.member, dropped.id);

    const roster = await readRoster(ORG_A);
    expect(roster).toEqual([
      expect.objectContaining({
        membershipId: a.member,
        discipline: "clinical_rn",
        fromIso: tonight.startsAt,
        toIso: tonight.endsAt,
      }),
    ]);
    // Another tenant has no rotation of its own: unreadable, and it never sees org A's rows.
    await expect(readRoster(ORG_B)).rejects.toBeInstanceOf(SchedulingOnCallRosterUnavailableError);
  });

  it("M19's reconciler creates shifts from the roster, idempotently, and cancels a dropped entry's shift", async () => {
    const svc = createDbSchedulingBackend(handle.db);
    const a = seeded[ORG_A] as Seed;

    const first = await reconcileOrgOnCallRoster(handle.db, ORG_A, asOf as never, now);
    expect(first).toMatchObject({ created: 1, cancelled: 0, degraded: false });
    const created = await shifts(ORG_A);
    expect(created).toEqual([
      expect.objectContaining({ status: "scheduled", m: a.member, discipline: "clinical_rn" }),
    ]);

    const second = await reconcileOrgOnCallRoster(handle.db, ORG_A, asOf as never, now);
    expect(second).toMatchObject({ created: 0, cancelled: 0 });

    const entries = await svc.listOnCallRotation(ORG_A);
    const live = entries.find((e) => e.membershipId === a.member && e.discipline === "clinical_rn");
    await svc.cancelOnCallRotationEntry(ORG_A, a.member, (live as { id: string }).id);
    const third = await reconcileOrgOnCallRoster(handle.db, ORG_A, asOf as never, now);
    expect(third).toMatchObject({ created: 0, cancelled: 1 });
    expect((await shifts(ORG_A))[0]).toMatchObject({ status: "cancelled" });
  });

  it("a tenant with no rotation rows keeps its hand-scheduled shifts (degraded, not cancelled)", async () => {
    const b = seeded[ORG_B] as Seed;
    await admin.query(
      `INSERT INTO on_call_shift
         (organization_id, provider_entity_id, shift_starts_at, shift_ends_at, discipline,
          primary_on_call_membership_id, policy_snapshot, status)
       VALUES ($1,$2,$3,$4,'clinical_rn',$5,'{}'::jsonb,'scheduled')`,
      [
        ORG_B,
        b.pe,
        new Date(now.getTime() + HOUR_MS),
        new Date(now.getTime() + 9 * HOUR_MS),
        b.member,
      ],
    );
    const result = await reconcileOrgOnCallRoster(handle.db, ORG_B, asOf as never, now);
    expect(result).toMatchObject({ created: 0, cancelled: 0, degraded: true });
    expect((await shifts(ORG_B))[0]).toMatchObject({ status: "scheduled" });
  });
});
