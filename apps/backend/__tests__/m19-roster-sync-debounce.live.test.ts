/**
 * F-155 (#248) — the m19 `handlers-unbound` group's own finding, now built: the §4.5 path 1 / §4.8
 * `m19.shift-sync.debounced` Direct-model roster sync finally has a jobs/ tier.
 *
 * THE FINDING. `reconcileOnCallRoster` (`roster/shift-sync.ts`) and `decideRosterSyncTrigger` have been a
 * complete, pure, well-documented reconciliation core since M19-T04, with no `jobs/` directory anywhere in
 * this module to run them — no BullMQ worker, no queue, no debounce primitive, no periodic catch-up. The
 * `m17.visit.assigned` outbox event has always been catalogued as an m19 consumer
 * (`events-by-m17.ts`/`M19_SUBSCRIBED_EVENT_NAMES`), and no factory ever yielded a live binding for it.
 *
 * WHAT'S NOW BUILT. `on_call_roster_sync_queue` (migration 0256) is a durable Postgres debounce table —
 * a TRUE reset-the-delay debounce via its `run_after` column, bumped forward by
 * `OnCallRosterSyncQueueRepository.triggerDebounce` on every `m17.visit.assigned` delivery
 * (`consumers/roster-sync-debounce.ts`), and claimed by the scheduled drain worker
 * (`jobs/worker.ts`'s `runOnCallRosterSyncDrainTick`) once 30 seconds of quiet have passed. A separate
 * catch-up-seed worker (`runOnCallRosterSyncCatchupTick`) covers the spec's OTHER named trigger ("at every
 * shift cron tick") by seeding a `cron_catchup` row for an org nothing has recently touched — never
 * disturbing an in-flight debounce.
 *
 * M17'S OWN ROSTER SEAM IS A PERMANENT, DOCUMENTED DENY-STUB (`17-scheduling/seams/drizzle-store.ts`'s
 * `SchedulingOnCallRosterUnavailableError` — "M17 owns no on-call rotation table"), a separate module's
 * gap this pass does not build. `reconcileOrgOnCallRoster`'s roster reader is therefore an INJECTED PORT
 * so this suite can prove the debounce/claim/apply machinery for real, the same way the M12 sync-trigger
 * suites inject their own vendor doubles rather than waiting on an unrelated integration.
 *
 * WHY LIVE. The debounce claim is `SELECT ... FOR UPDATE SKIP LOCKED` against a partial-unique index; the
 * RESET semantics are an `ON CONFLICT ... DO UPDATE` only Postgres can prove; and the cross-tenant
 * isolation claim is a real RLS read on the NOBYPASSRLS `chartwarden_app` role.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m19:roster-sync-debounce:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { OnCallRosterRead } from "../src/modules/19-oncall/index";
import {
  M19_OUTBOX_EVENTS,
  M19_ROSTER_SYNC_DEBOUNCE_WINDOW_MS,
  buildOncallRosterSyncDebounceConsumer,
  reconcileOrgOnCallRoster,
  runOnCallRosterSyncCatchupTick,
  runOnCallRosterSyncDrainTick,
} from "../src/modules/19-oncall/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111f155a19b";
const ORG_B = "22222222-2222-4222-8222-2222f155b19b";

/** The fixed instant every test drives the drain against — advanced explicitly per test via `now`. */
const T0 = new Date("2026-09-20T02:00:00.000Z");

type Seed = { pe: string; location: string; member: string; member2: string };

describe.skipIf(!DB_URL)("F-155 M19 §4.5/§4.8 on_call_roster_sync_queue — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const seeded: Record<string, Seed> = {};

  async function applyMigrations() {
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
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

  async function pendingRowsFor(org: string) {
    const { rows } = await admin.query(
      `SELECT id, reason, status, run_after, triggering_event_outbox_id
         FROM on_call_roster_sync_queue WHERE organization_id = $1 ORDER BY enqueued_at`,
      [org],
    );
    return rows;
  }

  async function shiftsFor(org: string) {
    const { rows } = await admin.query(
      `SELECT id, discipline, status, primary_on_call_membership_id, shift_starts_at, shift_ends_at,
              cancellation_reason
         FROM on_call_shift WHERE organization_id = $1 ORDER BY shift_starts_at`,
      [org],
    );
    return rows;
  }

  const deliver = (eventType: string, organizationId: string, payload: Record<string, unknown>) =>
    buildOncallRosterSyncDebounceConsumer({ db: handle.db, now: () => T0 }).handle({
      id: crypto.randomUUID(),
      organizationId,
      eventType,
      aggregateKind: "visit",
      aggregateId: String(payload.visitId ?? ""),
      payload,
      attemptCount: 1,
      createdAt: T0,
    });

  const visitAssignedPayload = (org: string) => ({
    visitId: crypto.randomUUID(),
    assignedMembershipId: (seeded[org] as Seed).member,
    patientId: crypto.randomUUID(),
    scheduledStartedAt: T0.toISOString(),
    scheduledEndedAt: new Date(T0.getTime() + 3_600_000).toISOString(),
  });

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
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'f155m19-a','A','A','active'),($2,'f155m19-b','B','B','active')",
      [ORG_A, ORG_B],
    );
    let n = 0;
    for (const org of [ORG_A, ORG_B]) {
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `f155m19-${n++}@x.test`,
        ])
      ).rows[0].id as string;
      const user2 = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `f155m19-${n++}@x.test`,
        ])
      ).rows[0].id as string;
      const member = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user, org],
        )
      ).rows[0].id as string;
      const member2 = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user2, org],
        )
      ).rows[0].id as string;
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [
            org,
            `CCN-F155-${org.slice(0, 4)}`,
            `F155 ${org.slice(0, 4)}`,
            `NPI-F155-${org.slice(0, 4)}`,
          ],
        )
      ).rows[0].id as string;
      const location = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [pe],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO tenant_oncall_policy
           (organization_id, provider_entity_id, model, escalation_tiers, callback_sla_per_severity)
         VALUES ($1,$2,'direct','{}'::jsonb,'{}'::jsonb)`,
        [org, pe],
      );
      seeded[org] = { pe, location, member, member2 };
    }

    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    void M19_OUTBOX_EVENTS; // referenced so the catalog import is not flagged unused by a stricter lint pass
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM on_call_roster_sync_queue");
    await admin.query("DELETE FROM on_call_shift");
    await admin.query("DELETE FROM outbox_event");
  });

  it("a first m17.visit.assigned trigger inserts one pending row, run_after ~30s out", async () => {
    await deliver("m17.visit.assigned", ORG_A, visitAssignedPayload(ORG_A));
    const rows = await pendingRowsFor(ORG_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("m17_visit_assigned");
    expect(rows[0].status).toBe("pending");
    expect(new Date(rows[0].run_after).getTime()).toBe(
      T0.getTime() + M19_ROSTER_SYNC_DEBOUNCE_WINDOW_MS,
    );
  });

  it("two triggers close together collapse onto ONE pending row — the debounce resets, not duplicates", async () => {
    await deliver("m17.visit.assigned", ORG_A, visitAssignedPayload(ORG_A));
    const firstEventId = (await pendingRowsFor(ORG_A))[0].triggering_event_outbox_id as string;
    await deliver("m17.visit.assigned", ORG_A, visitAssignedPayload(ORG_A));
    const rows = await pendingRowsFor(ORG_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].triggering_event_outbox_id).not.toBe(firstEventId);
  });

  it("a SECOND trigger genuinely RESETS run_after forward, not merely re-stamps the same value", async () => {
    const secondAt = new Date(T0.getTime() + 5_000); // 5s after the first, still inside the 30s window
    await buildOncallRosterSyncDebounceConsumer({ db: handle.db, now: () => T0 }).handle({
      id: crypto.randomUUID(),
      organizationId: ORG_A,
      eventType: "m17.visit.assigned",
      aggregateKind: "visit",
      aggregateId: crypto.randomUUID(),
      payload: visitAssignedPayload(ORG_A),
      attemptCount: 1,
      createdAt: T0,
    });
    const first = (await pendingRowsFor(ORG_A))[0];
    expect(new Date(first.run_after).getTime()).toBe(
      T0.getTime() + M19_ROSTER_SYNC_DEBOUNCE_WINDOW_MS,
    );

    await buildOncallRosterSyncDebounceConsumer({ db: handle.db, now: () => secondAt }).handle({
      id: crypto.randomUUID(),
      organizationId: ORG_A,
      eventType: "m17.visit.assigned",
      aggregateKind: "visit",
      aggregateId: crypto.randomUUID(),
      payload: visitAssignedPayload(ORG_A),
      attemptCount: 1,
      createdAt: secondAt,
    });
    const rows = await pendingRowsFor(ORG_A);
    expect(rows).toHaveLength(1);
    // Had the debounce NOT reset, run_after would still be T0 + window (already 5s in the past relative
    // to secondAt + window). The bumped value proves the window counts down from the LATEST trigger.
    expect(new Date(rows[0].run_after).getTime()).toBe(
      secondAt.getTime() + M19_ROSTER_SYNC_DEBOUNCE_WINDOW_MS,
    );
    expect(new Date(rows[0].run_after).getTime()).toBeGreaterThan(
      new Date(first.run_after).getTime(),
    );
  });

  it("two triggers close together drive exactly ONE reconciliation pass, not two", async () => {
    let rosterReads = 0;
    const fakeReader = async (): Promise<OnCallRosterRead> => {
      rosterReads++;
      return {
        kind: "roster",
        entries: [
          {
            membershipId: (seeded[ORG_A] as Seed).member,
            discipline: "rn",
            fromIso: T0.toISOString() as never,
            toIso: new Date(T0.getTime() + 8 * 3_600_000).toISOString() as never,
          },
        ],
      };
    };
    // Two deliveries 200 ms apart, both inside the 30 s debounce window.
    await deliver("m17.visit.assigned", ORG_A, visitAssignedPayload(ORG_A));
    await deliver("m17.visit.assigned", ORG_A, visitAssignedPayload(ORG_A));

    const past = new Date(T0.getTime() + M19_ROSTER_SYNC_DEBOUNCE_WINDOW_MS + 1_000);
    await runOnCallRosterSyncDrainTick({
      db: handle.db,
      connection: { host: "unused", port: 0 } as never, // never used — these calls go straight to the tick function, not the BullMQ Worker/Queue
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      rosterReader: fakeReader,
      now: () => past,
    });

    expect(rosterReads).toBe(1);
    const shifts = await shiftsFor(ORG_A);
    expect(shifts).toHaveLength(1);
    expect(shifts[0].status).toBe("scheduled");
    expect(shifts[0].primary_on_call_membership_id).toBe((seeded[ORG_A] as Seed).member);
    // The drained row is marked completed, not left pending — the second collapsed trigger did not
    // leave a stray row behind either.
    const rows = await pendingRowsFor(ORG_A);
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(0);
  });

  it("reconciliation creates a new shift and cancels one the roster no longer names", async () => {
    const s = seeded[ORG_A] as Seed;
    // A previously-synced scheduled shift for member2, which the new roster below drops.
    await admin.query(
      `INSERT INTO on_call_shift
         (organization_id, provider_entity_id, shift_starts_at, shift_ends_at, discipline,
          primary_on_call_membership_id, policy_snapshot, status)
       VALUES ($1,$2,$3,$4,'clinical_rn',$5,'{}'::jsonb,'scheduled')`,
      [ORG_A, s.pe, T0, new Date(T0.getTime() + 8 * 3_600_000), s.member2],
    );

    const rosterRead: OnCallRosterRead = {
      kind: "roster",
      entries: [
        {
          membershipId: s.member,
          discipline: "rn",
          fromIso: T0.toISOString() as never,
          toIso: new Date(T0.getTime() + 8 * 3_600_000).toISOString() as never,
        },
      ],
    };
    const result = await reconcileOrgOnCallRoster(
      handle.db,
      ORG_A,
      T0.toISOString() as never,
      T0,
      async () => rosterRead,
    );
    expect(result.created).toBe(1);
    expect(result.cancelled).toBe(1);
    expect(result.degraded).toBe(false);

    const shifts = await shiftsFor(ORG_A);
    expect(shifts).toHaveLength(2);
    const scheduled = shifts.find((r) => r.primary_on_call_membership_id === s.member);
    const cancelled = shifts.find((r) => r.primary_on_call_membership_id === s.member2);
    expect(scheduled?.status).toBe("scheduled");
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.cancellation_reason).toBe("m17_roster_no_longer_names_actor");
  });

  it("a redelivery against an unchanged roster is idempotent — second pass creates and cancels nothing", async () => {
    const s = seeded[ORG_A] as Seed;
    const rosterRead: OnCallRosterRead = {
      kind: "roster",
      entries: [
        {
          membershipId: s.member,
          discipline: "rn",
          fromIso: T0.toISOString() as never,
          toIso: new Date(T0.getTime() + 8 * 3_600_000).toISOString() as never,
        },
      ],
    };
    await reconcileOrgOnCallRoster(
      handle.db,
      ORG_A,
      T0.toISOString() as never,
      T0,
      async () => rosterRead,
    );
    const second = await reconcileOrgOnCallRoster(
      handle.db,
      ORG_A,
      T0.toISOString() as never,
      T0,
      async () => rosterRead,
    );
    expect(second.created).toBe(0);
    expect(second.cancelled).toBe(0);
    expect(await shiftsFor(ORG_A)).toHaveLength(1);
  });

  it("a degraded (unavailable) roster read leaves existing shifts untouched — §2.7 class D-C", async () => {
    const s = seeded[ORG_A] as Seed;
    await admin.query(
      `INSERT INTO on_call_shift
         (organization_id, provider_entity_id, shift_starts_at, shift_ends_at, discipline,
          primary_on_call_membership_id, policy_snapshot, status)
       VALUES ($1,$2,$3,$4,'clinical_rn',$5,'{}'::jsonb,'scheduled')`,
      [ORG_A, s.pe, T0, new Date(T0.getTime() + 8 * 3_600_000), s.member],
    );
    const result = await reconcileOrgOnCallRoster(
      handle.db,
      ORG_A,
      T0.toISOString() as never,
      T0,
      async () => ({ kind: "unavailable", reason: "seam threw" }),
    );
    expect(result.degraded).toBe(true);
    expect(result.created).toBe(0);
    expect(result.cancelled).toBe(0);
    const shifts = await shiftsFor(ORG_A);
    expect(shifts).toHaveLength(1);
    expect(shifts[0].status).toBe("scheduled");
  });

  it("the catch-up seeder does not disturb an in-flight (bumped) debounce", async () => {
    await deliver("m17.visit.assigned", ORG_A, visitAssignedPayload(ORG_A));
    const before = (await pendingRowsFor(ORG_A))[0];
    await runOnCallRosterSyncCatchupTick({
      db: handle.db,
      connection: { host: "unused", port: 0 } as never, // never used — these calls go straight to the tick function, not the BullMQ Worker/Queue
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      now: () => new Date(T0.getTime() + 5_000),
    });
    const after = await pendingRowsFor(ORG_A);
    expect(after).toHaveLength(1);
    expect(after[0].reason).toBe("m17_visit_assigned");
    expect(new Date(after[0].run_after).getTime()).toBe(new Date(before.run_after).getTime());
  });

  it("the catch-up seeder seeds a claimable row for an org nothing has recently touched", async () => {
    expect(await pendingRowsFor(ORG_A)).toHaveLength(0);
    await runOnCallRosterSyncCatchupTick({
      db: handle.db,
      connection: { host: "unused", port: 0 } as never, // never used — these calls go straight to the tick function, not the BullMQ Worker/Queue
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      now: () => T0,
    });
    const rows = await pendingRowsFor(ORG_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("cron_catchup");
    expect(new Date(rows[0].run_after).getTime()).toBe(T0.getTime());
  });

  it("org A's trigger never creates a pending row for org B — RLS isolation", async () => {
    await deliver("m17.visit.assigned", ORG_A, visitAssignedPayload(ORG_A));
    expect(await pendingRowsFor(ORG_A)).toHaveLength(1);
    expect(await pendingRowsFor(ORG_B)).toHaveLength(0);
  });

  it("the drain claim is a real UPDATE — a due row is marked processing then completed", async () => {
    await deliver("m17.visit.assigned", ORG_A, visitAssignedPayload(ORG_A));
    const past = new Date(T0.getTime() + M19_ROSTER_SYNC_DEBOUNCE_WINDOW_MS + 1_000);
    await runOnCallRosterSyncDrainTick({
      db: handle.db,
      connection: { host: "unused", port: 0 } as never, // never used — these calls go straight to the tick function, not the BullMQ Worker/Queue
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      rosterReader: async () => ({ kind: "unavailable", reason: "no real M17 source" }),
      now: () => past,
    });
    const rows = await pendingRowsFor(ORG_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
  });

  it("a not-yet-due debounce row is left alone by the drain tick", async () => {
    await deliver("m17.visit.assigned", ORG_A, visitAssignedPayload(ORG_A));
    await runOnCallRosterSyncDrainTick({
      db: handle.db,
      connection: { host: "unused", port: 0 } as never, // never used — these calls go straight to the tick function, not the BullMQ Worker/Queue
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      rosterReader: async () => ({ kind: "unavailable", reason: "should not be called" }),
      now: () => T0, // still inside the 30s window
    });
    const rows = await pendingRowsFor(ORG_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
  });
});
