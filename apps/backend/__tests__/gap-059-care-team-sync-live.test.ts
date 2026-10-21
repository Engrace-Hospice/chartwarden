/**
 * GAP-059 — Portal secure-message send (`POST /api/v1/portal/messages/send`) threw 501 on every call
 * in production: `MessagingProvider.syncCareTeamChannel` was an unconditional `notWired()` stub with
 * no try/catch around its call site, so every send failed before ever reaching `openChannel`/
 * `sendMessage`. The audit's literal fix (a try/catch matching the sibling read route) would have
 * only papered over a deeper gap: `syncCareTeamChannel` is supposed to be a real reconciliation against
 * the patient's care team (M36 spec D5 — "the source of truth is the care team, not the channel; the
 * channel mirrors it"), backed by a `CareTeamProvider` seam that was never built by any module — not
 * even registered as a seam name.
 *
 * This fix builds that seam for real: M5's new `CareTeamProvider` (the reverse of the existing
 * `CaseloadProvider` — same `patient_assignment` open rows, patient → users instead of user →
 * patients) and M36's `syncCareTeamChannel`, which now finds-or-creates the patient's `care_team`
 * channel and reconciles its `source:'auto'` membership against the real roster: adds newly-assigned
 * clinicians, soft-removes (`removed_at`) auto rows for clinicians no longer assigned, and — per D5's
 * admin-override invariant — never touches a `source:'manual'` row either way.
 *
 * Proves it end-to-end against REAL Postgres: the real `createDrizzleCareTeamStore` over
 * `patient_assignment`, and the real `createDbMessagingProvider`'s `syncCareTeamChannel` doing the
 * find-or-create + diff + reconcile over `channel`/`channel_member`, across three rounds (initial
 * seed, a roster change with a manual member present, and a no-op re-run).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/gap-059-care-team-sync-live.test.ts
 * (SUPERUSER to a THROWAWAY db; for a local PG without pgvector set WARDENX_TEST_NO_PGVECTOR=1.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerPatientSeams } from "../src/modules/05-patient/index";
import { createDrizzleCareTeamStore } from "../src/modules/05-patient/seams/drizzle-stores";
import { createDbMessagingProvider } from "../src/modules/36-messaging/messaging-provider-db";
import { appRoleConnectionString, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

describe.skipIf(!DB_URL)(
  "GAP-059 — M5 CareTeamProvider + M36 syncCareTeamChannel — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: { db: DbClient; close: () => Promise<void> };
    let org: string;
    let patientId: string;
    let rn: string; // primary_rn — stays assigned the whole test
    let msw: string; // case_manager_msw — unassigned partway through
    let aide: string; // added partway through
    let manualUserId: string; // a source:'manual' member the reconciler must never touch

    async function resetSchema() {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const r of ROLES)
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
        );
    }
    async function applyMigrations() {
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
    }
    async function seedUser(suffix: string): Promise<string> {
      return (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `g59-${suffix}@x.test`,
        ])
      ).rows[0].id as string;
    }
    async function assign(userId: string, role: string): Promise<void> {
      await admin.query(
        `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
       VALUES ($1,$2,$3,$4,CURRENT_DATE)`,
        [patientId, org, userId, role],
      );
    }
    async function unassign(userId: string, role: string): Promise<void> {
      await admin.query(
        `UPDATE patient_assignment SET unassigned_at = CURRENT_DATE
       WHERE patient_id=$1 AND clinician_user_id=$2 AND role=$3 AND unassigned_at IS NULL`,
        [patientId, userId, role],
      );
    }
    async function activeChannelMembers(
      channelId: string,
    ): Promise<Array<{ userId: string; source: string }>> {
      const rows = await admin.query(
        `SELECT user_id, source FROM channel_member WHERE channel_id=$1 AND removed_at IS NULL ORDER BY user_id`,
        [channelId],
      );
      return rows.rows.map((r) => ({ userId: r.user_id as string, source: r.source as string }));
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      org = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ('gap059','GAP059','GAP059') RETURNING id",
        )
      ).rows[0].id as string;
      patientId = (
        await admin.query(
          `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
         VALUES ($1,'MRN-G59','Care','Team','1990-01-01','F','active') RETURNING id`,
          [org],
        )
      ).rows[0].id as string;
      rn = await seedUser("rn");
      msw = await seedUser("msw");
      aide = await seedUser("aide");
      manualUserId = await seedUser("manual");
      await assign(rn, "primary_rn");
      await assign(msw, "case_manager_msw");

      // GAP-086 — this used to be `.replace("://postgres@", "://wardenx_app@")`, which only matches a
      // PASSWORDLESS url. Against any url carrying a password the pattern misses, `String.replace` returns
      // the input unchanged, and the whole suite silently ran as the SUPERUSER — which bypasses RLS
      // unconditionally, so the reconciler's org scoping was never actually exercised.
      handle = createDbClient({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });
      registerPatientSeams({
        db: handle.db,
        careTeam: { store: createDrizzleCareTeamStore(handle.db) },
      });
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    // GAP-086 guard: the failure this suite used to have was SILENT — a missed string replace left it on the
    // superuser, where RLS does not apply and every scoping assertion below is vacuous. Assert the identity
    // explicitly so a regression is a failing test rather than a quietly weaker one.
    it("drives the production path as the NOBYPASSRLS wardenx_app role, not the superuser", async () => {
      // node-postgres drizzle's `execute` resolves to a pg QueryResult (`{ rows }`), not an array.
      const result = await handle.db.execute<{ current_user: string; bypassrls: boolean }>(
        sql`SELECT current_user, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`,
      );
      const row = result.rows[0];
      expect(row?.current_user).toBe("wardenx_app");
      expect(row?.bypassrls).toBe(false);
    });

    it("CareTeamProvider resolves the real open patient_assignment roster, reverse of CaseloadProvider", async () => {
      const store = createDrizzleCareTeamStore(handle.db);
      const members = await store.listMembers(org, patientId);
      expect(new Set(members)).toEqual(new Set([rn, msw]));

      await unassign(msw, "case_manager_msw");
      const afterUnassign = await store.listMembers(org, patientId);
      expect(afterUnassign).toEqual([rn]);

      // restore for the messaging-level scenario below
      await assign(msw, "case_manager_msw");
    });

    it("syncCareTeamChannel finds-or-creates the care_team channel and seeds real auto membership", async () => {
      const provider = createDbMessagingProvider(handle.db);

      const first = await provider.syncCareTeamChannel(org, patientId);
      expect(first.membershipChanged).toBe(true);
      expect(await activeChannelMembers(first.channelId)).toEqual(
        expect.arrayContaining([
          { userId: rn, source: "auto" },
          { userId: msw, source: "auto" },
        ]),
      );

      // idempotent: same channel, no-op diff
      const second = await provider.syncCareTeamChannel(org, patientId);
      expect(second.channelId).toBe(first.channelId);
      expect(second.membershipChanged).toBe(false);

      const channelRows = await admin.query(
        `SELECT id FROM channel WHERE organization_id=$1 AND channel_kind='care_team' AND subject_id=$2`,
        [org, patientId],
      );
      expect(channelRows.rows).toHaveLength(1);
    });

    it("adds the verified portal participant with the portal role and does not prune it as a clinician", async () => {
      const provider = createDbMessagingProvider(handle.db);
      const synchronized = await provider.syncCareTeamChannel(org, patientId, aide);
      const portalRow = await admin.query(
        `SELECT role, source, removed_at FROM channel_member
         WHERE organization_id=$1 AND channel_id=$2 AND user_id=$3 AND removed_at IS NULL`,
        [org, synchronized.channelId, aide],
      );
      expect(portalRow.rows).toEqual([
        expect.objectContaining({ role: "portal_caregiver", source: "auto", removed_at: null }),
      ]);

      await provider.syncCareTeamChannel(org, patientId);
      const stillActive = await admin.query(
        `SELECT role FROM channel_member WHERE channel_id=$1 AND user_id=$2 AND removed_at IS NULL`,
        [synchronized.channelId, aide],
      );
      expect(stillActive.rows).toEqual([{ role: "portal_caregiver" }]);

      // Keep this shared live-suite fixture isolated for the roster-change scenario below.
      await admin.query(
        `UPDATE channel_member SET removed_at=now()
         WHERE channel_id=$1 AND user_id=$2 AND role='portal_caregiver' AND removed_at IS NULL`,
        [synchronized.channelId, aide],
      );
    });

    it("reconciles a roster change while leaving a manually-added member untouched (D5 admin-override invariant)", async () => {
      const provider = createDbMessagingProvider(handle.db);
      const { channelId } = await provider.syncCareTeamChannel(org, patientId);

      // an admin manually adds someone NOT on the care team (e.g. a covering clinician)
      await admin.query(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
       VALUES ($1,$2,$3,'member','manual')`,
        [org, channelId, manualUserId],
      );

      // roster changes: MSW comes off the case, a new aide comes on
      await unassign(msw, "case_manager_msw");
      await assign(aide, "aide");

      const reconciled = await provider.syncCareTeamChannel(org, patientId);
      expect(reconciled.membershipChanged).toBe(true);

      const active = await activeChannelMembers(channelId);
      expect(new Set(active)).toEqual(
        new Set([
          { userId: rn, source: "auto" }, // still on the team, untouched
          { userId: aide, source: "auto" }, // newly assigned, added
          { userId: manualUserId, source: "manual" }, // manual override, reconciler never touches it
        ]),
      );
      // MSW's row is soft-removed, not deleted, and the manual row was never soft-removed
      const mswRow = await admin.query(
        `SELECT removed_at FROM channel_member WHERE channel_id=$1 AND user_id=$2`,
        [channelId, msw],
      );
      expect(mswRow.rows[0].removed_at).not.toBeNull();
      const manualRow = await admin.query(
        `SELECT removed_at FROM channel_member WHERE channel_id=$1 AND user_id=$2`,
        [channelId, manualUserId],
      );
      expect(manualRow.rows[0].removed_at).toBeNull();

      // re-running with no further roster change is a true no-op
      const noop = await provider.syncCareTeamChannel(org, patientId);
      expect(noop.membershipChanged).toBe(false);
    });

    // Code review 2026-08-14 — `syncCareTeamChannel` used to call the M5 `CareTeamProvider` seam from
    // INSIDE its own `withOrgContext`, and that seam's Drizzle store opens its own `withOrgContext` on the
    // same pooled handle. One sync therefore needed TWO simultaneous pool connections. In production the
    // pool is `max: 10` with no `connectionTimeoutMillis`, and M31's portal routes call this per request,
    // so ten concurrent portal reads held all ten connections and each waited forever for an eleventh —
    // a pool-wide hang, not a slow path.
    //
    // A `max: 1` pool turns that latent shape into a deterministic, fast assertion: the nested version
    // can NEVER complete (the inner read waits on the one connection the outer transaction is holding),
    // while the hoisted version needs only one connection at a time. This is the whole defect expressed
    // as a single call, with no concurrency staging to get flaky.
    it("needs only ONE pooled connection at a time (a max:1 pool must still complete)", async () => {
      const single = createDbClient({
        connectionString: appRoleUrl(DB_URL as string),
        max: 1,
      });
      // The seam MUST resolve against the same single-connection handle — if the inner read borrowed a
      // different pool it would never contend, and the test would pass either way.
      registerPatientSeams({
        db: single.db,
        careTeam: { store: createDrizzleCareTeamStore(single.db) },
      });
      try {
        const provider = createDbMessagingProvider(single.db);
        const result = await Promise.race([
          provider.syncCareTeamChannel(org, patientId),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("syncCareTeamChannel deadlocked on a max:1 pool")),
              5_000,
            ),
          ),
        ]);
        expect(result.channelId).toBeTruthy();
      } finally {
        // Not awaited: if the call above deadlocked, its transaction still holds the only connection and
        // `pool.end()` would block on it, converting a clean assertion failure into a hung suite.
        void single.close().catch(() => {});
        registerPatientSeams({
          db: handle.db,
          careTeam: { store: createDrizzleCareTeamStore(handle.db) },
        });
      }
    });
  },
);
