/**
 * GAP-061 — M20's §4.8 `m20.overdue-detector.cron` (the 30-second lone-worker overdue check-in detector) and
 * `m20.coverage-gap-watchdog.cron` finally have a production caller.
 *
 * THE FINDING. `decideOverdueCheckIn` was complete and unit-tested with no caller: nothing flipped a schedule
 * to `overdue`, nothing cascaded the D4 tier, and the only `check_in_overdue` emitter was the M17 no-show
 * consumer. This suite proves the WORKER against real Postgres: the scan over `scis_overdue_scan_idx`'s
 * predicate, the `FOR UPDATE` per-row decision, the pinned-policy read, the state/stamp UPDATE (which must
 * satisfy `m20_scis_overdue_stamped` / `m20_scis_escalated_stamped`), and the outbox row published by the REAL
 * catalog-validating publisher in the same tx.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m20:overdue-detector:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildFoundationSiteReader } from "../src/bootstrap/foundation-site-reader";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  type M20WorkerDeps,
  M20_OUTBOX_EVENTS,
  buildDrizzleSafetySeamStore,
  buildM20WorkerDeps,
  createSafetyPolicyProvider,
  runCoverageGapWatchdogCron,
  runOverdueDetectorCron,
} from "../src/modules/20-field-safety/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111f061a001";
const ORG_B = "22222222-2222-4222-8222-2222f061b002";

type Seed = { pe: string; location: string; member: string; policyVersionId: string };

describe.skipIf(!DB_URL)(
  "GAP-061 M20 overdue detector + coverage-gap watchdog — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let deps: M20WorkerDeps;
    // 2026-09-01 17:00Z = 10:00 America/Los_Angeles (business hours).
    const BASE = new Date("2026-09-01T17:00:00.000Z");
    let clock = BASE;
    const seeded: Record<string, Seed> = {};

    const minutesBefore = (m: number) => new Date(BASE.getTime() - m * 60_000);

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

    /** The §3.2 Phase-E floor thresholds: gentle 5 / supervisor 15 / escalation 30 / sos_equivalent 60. */
    async function seedPolicyVersion(org: string): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO safety_policy (organization_id) VALUES ($1) RETURNING id`,
        [org],
      );
      const version = await admin.query(
        `INSERT INTO safety_policy_version
         (organization_id, safety_policy_id, effective_from,
          mid_visit_cadence_minutes, mid_visit_min_visit_duration_minutes,
          pre_visit_window_minutes, post_visit_window_minutes,
          gentle_reminder_minutes, supervisor_alert_minutes, escalation_minutes, sos_equivalent_minutes,
          sos_cancel_window_seconds, sos_tier_1_sla_seconds, sos_tier_2_sla_seconds, sos_tier_3_sla_seconds)
       VALUES ($1,$2,'2026-01-01T00:00:00Z',60,60,15,5,5,15,30,60,5,60,120,300)
       RETURNING id`,
        [org, rows[0].id],
      );
      return version.rows[0].id as string;
    }

    async function seedSchedule(input: {
      org: string;
      expectedAt: Date;
      windowMinutes?: number;
      state?: string;
      overdueDetectedAt?: Date | null;
      escalatedAt?: Date | null;
    }): Promise<string> {
      const s = seeded[input.org] as Seed;
      const { rows } = await admin.query(
        `INSERT INTO safety_check_in_schedule
         (organization_id, provider_entity_id, location_id, clinician_membership_id, kind,
          expected_at, window_minutes, state, overdue_detected_at, escalated_at, safety_policy_version_id)
       VALUES ($1,$2,$3,$4,'between_visits',$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          input.org,
          s.pe,
          s.location,
          s.member,
          input.expectedAt,
          input.windowMinutes ?? 5,
          input.state ?? "proposed",
          input.overdueDetectedAt ?? null,
          input.escalatedAt ?? null,
          s.policyVersionId,
        ],
      );
      return rows[0].id as string;
    }

    async function scheduleRow(id: string) {
      const { rows } = await admin.query(
        "SELECT state, overdue_detected_at, escalated_at FROM safety_check_in_schedule WHERE id=$1",
        [id],
      );
      return rows[0] as {
        state: string;
        overdue_detected_at: Date | null;
        escalated_at: Date | null;
      };
    }

    async function outboxFor(aggregateId: string) {
      const { rows } = await admin.query(
        "SELECT event_type, payload FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at",
        [aggregateId],
      );
      return rows as { event_type: string; payload: Record<string, unknown> }[];
    }

    const onlyOrgA = { listActiveOrgs: async () => [{ organizationId: ORG_A }] };

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
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'g061-a','A','A','active'),($2,'g061-b','B','B','active')",
        [ORG_A, ORG_B],
      );

      let n = 0;
      for (const org of [ORG_A, ORG_B]) {
        const user = (
          await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
            `g061-${n++}@x.test`,
          ])
        ).rows[0].id as string;
        const pe = (
          await admin.query(
            `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
            [
              org,
              `CCN-G061-${org.slice(0, 4)}`,
              `G061 ${org.slice(0, 4)}`,
              `NPI-G061-${org.slice(0, 4)}`,
            ],
          )
        ).rows[0].id as string;
        const member = (
          await admin.query(
            `INSERT INTO membership (user_id, organization_id, status, default_provider_entity_id)
           VALUES ($1,$2,'active',$3) RETURNING id`,
            [user, org, pe],
          )
        ).rows[0].id as string;
        const location = (
          await admin.query(
            `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
            [pe],
          )
        ).rows[0].id as string;
        seeded[org] = { pe, location, member, policyVersionId: await seedPolicyVersion(org) };
      }

      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      // The REAL catalog-validating publisher (not NOOP_OUTBOX): a payload that drifts from the §4.10 catalog
      // fails the tick here.
      const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M20_OUTBOX_EVENTS]));
      deps = {
        ...buildM20WorkerDeps({
          connection: { host: "unused", port: 0 }, // never used — the suite calls the run functions directly.
          db: handle.db,
          outbox: {
            publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m20" }),
          },
          policy: createSafetyPolicyProvider(buildDrizzleSafetySeamStore(handle.db)),
          activeOrgs: {
            listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
          },
          locationTimezone: (tx, locationId) =>
            buildFoundationSiteReader().locationTimezone(tx, locationId),
        }),
        now: () => clock,
      };
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    beforeEach(async () => {
      await admin.query("DELETE FROM outbox_event");
      await admin.query("DELETE FROM safety_check_in_schedule");
      clock = BASE;
    });

    it("flips a schedule past its window to overdue and writes a check_in_overdue outbox row", async () => {
      const id = await seedSchedule({ org: ORG_A, expectedAt: minutesBefore(6), windowMinutes: 5 });

      await runOverdueDetectorCron(deps);

      const row = await scheduleRow(id);
      expect(row.state).toBe("overdue");
      expect(row.overdue_detected_at?.toISOString()).toBe(BASE.toISOString());
      const events = await outboxFor(id);
      expect(events.map((e) => e.event_type)).toEqual(["m20.safety.check_in_overdue"]);
      expect(events[0]?.payload).toMatchObject({
        scheduleId: id,
        kind: "between_visits",
        minutesOverdue: 6,
      });
    });

    it("leaves a schedule inside its fulfilment window, and a future one, untouched", async () => {
      const inWindow = await seedSchedule({
        org: ORG_A,
        expectedAt: minutesBefore(2),
        windowMinutes: 5,
      });
      const future = await seedSchedule({
        org: ORG_A,
        expectedAt: new Date(BASE.getTime() + 10 * 60_000),
      });

      await runOverdueDetectorCron(deps);

      expect((await scheduleRow(inWindow)).state).toBe("proposed");
      expect((await scheduleRow(future)).state).toBe("proposed");
      expect(await outboxFor(inWindow)).toHaveLength(0);
    });

    it("is idempotent: a second tick at the same rung emits nothing more", async () => {
      const id = await seedSchedule({ org: ORG_A, expectedAt: minutesBefore(6) });

      await runOverdueDetectorCron(deps);
      await runOverdueDetectorCron(deps);

      expect(await outboxFor(id)).toHaveLength(1);
    });

    it("walks the D4 ladder: one check_in_escalated per rung, state escalated, escalated_at re-stamped", async () => {
      const id = await seedSchedule({ org: ORG_A, expectedAt: BASE });

      for (const [minutes, tier] of [
        [6, "gentle"],
        [16, "supervisor_alert"],
        [31, "escalation"],
        [61, "sos_equivalent"],
      ] as const) {
        clock = new Date(BASE.getTime() + minutes * 60_000);
        await runOverdueDetectorCron(deps);
        if (tier === "gentle") expect((await scheduleRow(id)).state).toBe("overdue");
        else expect((await scheduleRow(id)).state).toBe("escalated");
      }
      // A repeat tick at the top rung does nothing.
      await runOverdueDetectorCron(deps);

      const events = await outboxFor(id);
      expect(events.map((e) => e.event_type)).toEqual([
        "m20.safety.check_in_overdue",
        "m20.safety.check_in_escalated",
        "m20.safety.check_in_escalated",
        "m20.safety.check_in_escalated",
      ]);
      expect(events.slice(1).map((e) => e.payload.tier)).toEqual([
        "supervisor_alert",
        "escalation",
        "sos_equivalent",
      ]);
      // 10:00 Pacific on 2026-09-01 is inside the default business-hours window.
      expect(events[1]?.payload.afterHours).toBe(false);
      expect((await scheduleRow(id)).escalated_at?.toISOString()).toBe(
        new Date(BASE.getTime() + 61 * 60_000).toISOString(),
      );
    });

    it("does not touch a recorded schedule", async () => {
      // `recorded` requires fulfilled_by_check_in_id, so use `superseded` (also non-actionable).
      const id = await seedSchedule({
        org: ORG_A,
        expectedAt: minutesBefore(40),
        state: "superseded",
      });

      await runOverdueDetectorCron(deps);

      expect((await scheduleRow(id)).state).toBe("superseded");
      expect(await outboxFor(id)).toHaveLength(0);
    });

    it("works per tenant: ORG_B's overdue schedule is flipped by the all-orgs tick and ignored when only ORG_A is listed", async () => {
      const idB = await seedSchedule({ org: ORG_B, expectedAt: minutesBefore(6) });

      await runOverdueDetectorCron({ ...deps, activeOrgs: onlyOrgA });
      expect((await scheduleRow(idB)).state).toBe("proposed");

      await runOverdueDetectorCron(deps);
      expect((await scheduleRow(idB)).state).toBe("overdue");
    });

    it("coverage-gap watchdog reports a field-eligible clinician nobody is subscribed to", async () => {
      await runCoverageGapWatchdogCron({ ...deps, activeOrgs: onlyOrgA });

      const { rows } = await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m20.safety.coverage_gap_detected' AND organization_id=$1",
        [ORG_A],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toMatchObject({
        clinicianMembershipId: (seeded[ORG_A] as Seed).member,
        reason: "no_subscription",
      });
    });
  },
);
