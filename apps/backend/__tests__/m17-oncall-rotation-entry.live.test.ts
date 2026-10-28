/**
 * CW-QA-0016 (#860) — `oncall_rotation_entry` (M17's on-call rotation source) against REAL Postgres as the
 * NOBYPASSRLS `chartwarden_app` role, through the production store (`createDrizzleOnCallRotationStore`, the
 * object behind the M17 `/api/v1/oncall-rotation` routes and `tonightsOnCallRoster`).
 *   - cross-tenant denial (RLS read / write / WITH CHECK, and through the store);
 *   - overlapping rotation entries (exact duplicate refused; distinct overlaps coexist; cancel frees the slot);
 *   - effective roster selection (elapsed, boundary, cancelled, future, ordering, none_configured vs empty);
 *   - concurrent update (racing cancels / racing identical creates);
 *   - deletion / history (rows are cancelled never deleted; the app role cannot DELETE).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m17:oncall-rotation-entry:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import { ConflictError, NotFoundError } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDrizzleOnCallRotationStore } from "../src/modules/17-scheduling/seams/oncall-rotation-store";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const HOUR_MS = 3_600_000;
const NOW = new Date("2026-10-08T20:00:00.000Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR_MS).toISOString();

type Seed = { actor: string; m1: string; m2: string };

describe.skipIf(!DB_URL)("M17 oncall_rotation_entry — LIVE Postgres", () => {
  let admin: Client;
  let app: Client;
  let handle: ReturnType<typeof createDbClient>;
  let store: ReturnType<typeof createDrizzleOnCallRotationStore>;
  const seeded: Record<string, Seed> = {};
  let ORG_A = "";
  let ORG_B = "";

  async function seedOrg(org: string, slug: string): Promise<void> {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,$2,$2,$2,'active')",
      [org, slug],
    );
    const ids: string[] = [];
    for (const n of ["actor", "m1", "m2"]) {
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `${slug}-${n}@cw860.test`,
        ])
      ).rows[0].id as string;
      ids.push(
        (
          await admin.query(
            "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
            [user, org],
          )
        ).rows[0].id as string,
      );
    }
    seeded[org] = { actor: ids[0] as string, m1: ids[1] as string, m2: ids[2] as string };
  }

  /** One statement as the app role with the tenant GUC set (empty when org is null). */
  async function asApp(org: string | null, sql: string, params: unknown[] = []) {
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.org_id', $1, true)", [org ?? ""]);
      const res = await app.query(sql, params);
      await app.query("COMMIT");
      return res;
    } catch (e) {
      await app.query("ROLLBACK");
      throw e;
    }
  }

  const roster = (org: string) =>
    runWithRequestContext({ organizationId: org, userId: "" }, () =>
      store.rosterAsOf(NOW.toISOString()),
    );
  const create = (
    org: string,
    m: string,
    discipline: "clinical_rn" | "msw",
    from: number,
    to: number,
  ) =>
    store.create(org, (seeded[org] as Seed).actor, {
      membershipId: m,
      discipline,
      startsAt: at(from),
      endsAt: at(to),
    });

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of LIVE_DROP_ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    app = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await app.connect();
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    // The races below only race if the store's pool can hold more than one connection (default max is 10).
    expect(handle.pool.options.max).toBeGreaterThan(1);
    store = createDrizzleOnCallRotationStore(handle.db);
  }, 180_000);

  // Fresh tenants per test, so every test creates what it reads and the file is order-independent.
  beforeEach(async () => {
    ORG_A = randomUUID();
    ORG_B = randomUUID();
    await seedOrg(ORG_A, `cw860-a-${ORG_A.slice(0, 8)}`);
    await seedOrg(ORG_B, `cw860-b-${ORG_B.slice(0, 8)}`);
  });

  afterAll(async () => {
    await handle?.close();
    if (app) await app.end();
    if (admin) await admin.end();
  });

  it("a tenant with no rotation rows reads none_configured, not an empty roster", async () => {
    expect(await roster(ORG_B)).toEqual({ kind: "none_configured" });
  });

  describe("effective roster selection", () => {
    it("returns running and upcoming entries, ordered; drops elapsed, boundary-ended and cancelled", async () => {
      const a = seeded[ORG_A] as Seed;
      await create(ORG_A, a.m1, "clinical_rn", -20, -10); // elapsed
      await create(ORG_A, a.m1, "msw", -5, 0); // ends exactly at asOf -> not effective
      const cancelled = await create(ORG_A, a.m2, "msw", 1, 9);
      await store.cancel(ORG_A, a.actor, cancelled.id);
      const later = await create(ORG_A, a.m2, "clinical_rn", 10, 18); // upcoming
      const tonight = await create(ORG_A, a.m1, "clinical_rn", -1, 8); // running

      const r = await roster(ORG_A);
      expect(r.kind).toBe("roster");
      if (r.kind !== "roster") return;
      expect(r.entries.map((e) => [e.membershipId, e.discipline, e.fromIso])).toEqual([
        [a.m1, "clinical_rn", tonight.startsAt],
        [a.m2, "clinical_rn", later.startsAt],
      ]);
    });

    it("all-cancelled entries read an EMPTY roster (rows exist), not none_configured", async () => {
      const b = seeded[ORG_B] as Seed;
      const entry = await create(ORG_B, b.m1, "msw", 1, 5);
      await store.cancel(ORG_B, b.actor, entry.id);
      expect(await roster(ORG_B)).toEqual({ kind: "roster", entries: [] });
    });
  });

  describe("cross-tenant denial (RLS as chartwarden_app)", () => {
    it("org B's GUC sees none of org A's rows; an empty or never-set GUC sees nothing", async () => {
      const a = seeded[ORG_A] as Seed;
      await create(ORG_A, a.m1, "msw", 1, 2);
      const own = await asApp(ORG_A, "SELECT count(*)::int AS n FROM oncall_rotation_entry");
      expect(own.rows[0].n).toBe(1);
      const other = await asApp(ORG_B, "SELECT count(*)::int AS n FROM oncall_rotation_entry");
      expect(other.rows[0].n).toBe(0);
      // GUC set to '' (what asApp(null) does): the ''::uuid cast in the policy must fail closed.
      await expect(
        asApp(null, "SELECT count(*)::int AS n FROM oncall_rotation_entry"),
      ).rejects.toThrow(/invalid input syntax for type uuid/i);
      // GUC never set on the connection: current_setting(..., true) is NULL -> matches no rows.
      const fresh = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await fresh.connect();
      try {
        const res = await fresh.query("SELECT count(*)::int AS n FROM oncall_rotation_entry");
        expect(res.rows[0].n).toBe(0);
      } finally {
        await fresh.end();
      }
    });

    it("WITH CHECK refuses an insert for another tenant; cross-tenant UPDATE touches zero rows", async () => {
      const a = seeded[ORG_A] as Seed;
      await create(ORG_A, a.m1, "msw", 1, 2);
      await expect(
        asApp(
          ORG_B,
          `INSERT INTO oncall_rotation_entry (organization_id, membership_id, discipline, starts_at, ends_at,
             created_by_membership_id) VALUES ($1,$2,'msw',$3,$4,$2)`,
          [ORG_A, a.m1, at(30), at(31)],
        ),
      ).rejects.toThrow(/row-level security/i);
      const upd = await asApp(
        ORG_B,
        "UPDATE oncall_rotation_entry SET updated_at = now() WHERE organization_id = $1",
        [ORG_A],
      );
      expect(upd.rowCount).toBe(0);
      expect(await store.list(ORG_A)).toHaveLength(1); // the refused insert left nothing behind
    });

    it("the store cannot cancel, list or schedule across tenants", async () => {
      const a = seeded[ORG_A] as Seed;
      const b = seeded[ORG_B] as Seed;
      const aId = (await create(ORG_A, a.m1, "msw", 1, 2)).id;
      await create(ORG_B, b.m1, "msw", 1, 2);
      await expect(store.cancel(ORG_B, b.actor, aId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(create(ORG_B, a.m1, "msw", 1, 2)).rejects.toBeInstanceOf(NotFoundError); // org A's member
      const listedB = await store.list(ORG_B, { includeCancelled: true });
      expect(listedB.map((e) => e.membershipId)).toEqual([b.m1]);
      expect((await store.list(ORG_A)).some((e) => e.id === aId)).toBe(true);
    });
  });

  describe("overlapping rotation entries", () => {
    it("refuses an exact duplicate (409), allows distinct overlaps, and frees the slot on cancel", async () => {
      const a = seeded[ORG_A] as Seed;
      const first = await create(ORG_A, a.m1, "msw", 40, 48);
      await expect(create(ORG_A, a.m1, "msw", 40, 48)).rejects.toBeInstanceOf(ConflictError);
      // Backup coverage: another person, same discipline and window.
      await expect(create(ORG_A, a.m2, "msw", 40, 48)).resolves.toBeTruthy();
      // Same person, different discipline, same window.
      await expect(create(ORG_A, a.m1, "clinical_rn", 40, 48)).resolves.toBeTruthy();
      await store.cancel(ORG_A, a.actor, first.id);
      await expect(create(ORG_A, a.m1, "msw", 40, 48)).resolves.toBeTruthy();
    });

    it("DOCUMENTED BEHAVIOUR: the same person may hold overlapping but non-identical windows (no exclusion constraint)", async () => {
      const a = seeded[ORG_A] as Seed;
      await create(ORG_A, a.m1, "msw", 50, 58);
      await expect(create(ORG_A, a.m1, "msw", 54, 62)).resolves.toBeTruthy();
      const r = await roster(ORG_A);
      expect(r.kind === "roster" && r.entries.filter((e) => e.membershipId === a.m1)).toHaveLength(
        2,
      );
    });

    it("the DB itself refuses an inverted window and an unknown discipline", async () => {
      const a = seeded[ORG_A] as Seed;
      const ins = (disc: string, from: number, to: number) =>
        asApp(
          ORG_A,
          `INSERT INTO oncall_rotation_entry (organization_id, membership_id, discipline, starts_at, ends_at,
             created_by_membership_id) VALUES ($1,$2,$3,$4,$5,$2)`,
          [ORG_A, a.m1, disc, at(from), at(to)],
        );
      await expect(ins("msw", 60, 59)).rejects.toThrow(/window_chk/);
      await expect(ins("external", 60, 61)).rejects.toThrow(/discipline_chk/);
    });
  });

  describe("concurrent update", () => {
    it("two racing cancels: exactly one wins, the other is NotFound, cancellation is stamped once", async () => {
      const a = seeded[ORG_A] as Seed;
      const entry = await create(ORG_A, a.m2, "clinical_rn", 70, 78);
      const results = await Promise.allSettled([
        store.cancel(ORG_A, a.actor, entry.id),
        store.cancel(ORG_A, a.m1, entry.id),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(NotFoundError);
      const row = (
        await admin.query(
          "SELECT cancelled_at, cancelled_by_membership_id AS by FROM oncall_rotation_entry WHERE id=$1",
          [entry.id],
        )
      ).rows[0];
      expect(row.cancelled_at).not.toBeNull();
      expect([a.actor, a.m1]).toContain(row.by);
      // The loser must not have overwritten the winner's stamp.
      const winnerIdx = results.findIndex((r) => r.status === "fulfilled");
      expect(row.by).toBe(winnerIdx === 0 ? a.actor : a.m1);
    });

    it("racing identical creates: one row, one ConflictError", async () => {
      const a = seeded[ORG_A] as Seed;
      const results = await Promise.allSettled([
        create(ORG_A, a.m2, "msw", 80, 88),
        create(ORG_A, a.m2, "msw", 80, 88),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(ConflictError);
    });
  });

  describe("deletion and history", () => {
    it("cancel keeps the row (history), stamps the actor, and re-cancel is NotFound", async () => {
      const a = seeded[ORG_A] as Seed;
      const entry = await create(ORG_A, a.m1, "msw", 90, 98);
      await store.cancel(ORG_A, a.actor, entry.id);
      expect((await store.list(ORG_A)).some((e) => e.id === entry.id)).toBe(false);
      const hist = (await store.list(ORG_A, { includeCancelled: true })).find(
        (e) => e.id === entry.id,
      );
      expect(hist?.cancelledAt).not.toBeNull();
      const row = (
        await admin.query(
          "SELECT cancelled_by_membership_id AS by FROM oncall_rotation_entry WHERE id=$1",
          [entry.id],
        )
      ).rows[0];
      expect(row.by).toBe(a.actor);
      await expect(store.cancel(ORG_A, a.actor, entry.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("the app role cannot DELETE, and cancelled_at/cancelled_by must move together", async () => {
      const a = seeded[ORG_A] as Seed;
      await create(ORG_A, a.m1, "msw", 95, 96); // a live row for both statements to hit
      await expect(
        asApp(ORG_A, "DELETE FROM oncall_rotation_entry WHERE organization_id = $1", [ORG_A]),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        asApp(
          ORG_A,
          "UPDATE oncall_rotation_entry SET cancelled_at = now() WHERE organization_id = $1",
          [ORG_A],
        ),
      ).rejects.toThrow(/cancelled_chk/);
    });

    it("one create and one cancel leave one insert and one update audit_event for that row", async () => {
      const a = seeded[ORG_A] as Seed;
      const count = async (eventType: string) =>
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM audit_event WHERE organization_id = $1 AND resource_kind = 'oncall_rotation_entry' AND event_type = $2",
            [ORG_A, eventType],
          )
        ).rows[0].n as number;
      const [insertsBefore, updatesBefore] = [
        await count("oncall_rotation_entry.insert"),
        await count("oncall_rotation_entry.update"),
      ];
      const entry = await create(ORG_A, a.m1, "msw", 100, 108);
      await store.cancel(ORG_A, a.actor, entry.id);
      expect(await count("oncall_rotation_entry.insert")).toBe(insertsBefore + 1);
      expect(await count("oncall_rotation_entry.update")).toBe(updatesBefore + 1);
      const ids = await admin.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE resource_id = $1 AND resource_kind = 'oncall_rotation_entry'",
        [entry.id],
      );
      expect(ids.rows[0].n).toBe(2);
    });
  });
});
