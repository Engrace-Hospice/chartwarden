/**
 * GAP-105 (#174) — M37's five remaining §4.8 crons, proven against real Postgres as the NOBYPASSRLS
 * `chartwarden_app` role: irc-cap-watchdog, census-snapshot-builder, restraint-reassessment-watchdog,
 * bed-cleaning-sla-watchdog and gip-criteria-staleness-sweep.
 *
 * Before these crons `ipu_census_snapshot` had no writer (so `snapshot_taken` never fired and M26/M27/M23
 * read zero bed-days), `irc_episode.consecutive_day_count` stayed 1 forever (so the day-5 cap never
 * breached and the within-cap billing gate never closed), and nothing watched restraints, bed turnover or
 * GIP reassessment staleness. Rows here are seeded as the superuser; every cron runs through the real
 * `withOrgContext` on the app-role connection with a CATALOG-VALIDATING outbox (the F-080 lesson: a no-op
 * outbox skips the payload check that fails in production).
 *
 * Also asserted: re-running every cron is a no-op (no new rows, no new events), and ORG B's data is
 * untouched when only ORG A is swept — the cross-tenant check, made on the app role, not a superuser.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m37:watchdogs:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { createDbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/events-by-m37";
import {
  runBedCleaningSlaWatchdogCron,
  runCensusSnapshotBuilderCron,
  runGipCriteriaStalenessSweepCron,
  runIrcCapWatchdogCron,
  runRestraintReassessmentWatchdogCron,
} from "../src/modules/37-ipu/jobs/watchdog-workers";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const PE = "66666666-6666-4666-8666-666666666666";
const MEMBER = "44444444-4444-4444-8444-444444444444";
const REMOTE_FACILITY = "ffffffff-0000-4000-8000-000000000001";
/** 2026-10-05T12:00Z = 08:00 EDT on 2026-10-05, so the closed service date is 2026-10-04 (EDT). */
const NOW = new Date("2026-10-05T12:00:00Z");
const HOUR = 3_600_000;

const SCHEMAS = new Map<string, (typeof M37_OUTBOX_EVENTS)[number]["payloadSchema"]>(
  M37_OUTBOX_EVENTS.map((e) => [e.eventName, e.payloadSchema]),
);

interface Published {
  eventName: string;
  organizationId: string;
  payload: Record<string, unknown>;
}

describe.skipIf(!DB_URL)("M37 §4.8 watchdog crons — LIVE Postgres (GAP-105)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const published: Published[] = [];
  let seq = 0;

  const outbox = {
    publish: async (
      _tx: unknown,
      e: Published & { aggregateKind: string; aggregateId: string },
    ) => {
      const schema = SCHEMAS.get(e.eventName);
      if (!schema) throw new Error(`m37 event not in events-by-m37.ts: ${e.eventName}`);
      if (!Value.Check(schema, e.payload)) {
        const details = [...Value.Errors(schema, e.payload)].map((x) => `${x.path}: ${x.message}`);
        throw new Error(`payload_schema_violation ${e.eventName} — ${details.join("; ")}`);
      }
      published.push({
        eventName: e.eventName,
        organizationId: e.organizationId,
        payload: e.payload,
      });
    },
  };
  const deps = (orgs: string[]) => ({
    connection: {} as never,
    db: handle.db,
    outbox,
    activeOrgs: { listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })) },
    now: () => NOW,
  });
  const eventsOf = (name: string, org?: string) =>
    published.filter((p) => p.eventName === name && (org ? p.organizationId === org : true));

  const uuid = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, "0")}`;

  async function seedUnit(org: string, facility: string): Promise<string> {
    return (
      await admin.query(
        "INSERT INTO inpatient_unit (organization_id,facility_id,display_name,bed_count) VALUES ($1,$2,'U',4) RETURNING id",
        [org, facility],
      )
    ).rows[0].id;
  }

  async function seedAdmission(o: {
    org: string;
    unitId: string | null;
    kind: "gip" | "irc" | "arranged";
    state: string;
    activatedAt: Date;
    remote?: boolean;
  }): Promise<string> {
    seq += 1;
    return (
      await admin.query(
        `INSERT INTO ipu_admission (organization_id,provider_entity_id,patient_id,admission_id,
           level_of_care_period_id,unit_id,remote_facility_id,kind,state,activated_at,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$2) RETURNING id`,
        [
          o.org,
          PE,
          uuid(1000 + seq),
          uuid(2000 + seq),
          uuid(3000 + seq),
          o.unitId,
          o.remote ? REMOTE_FACILITY : null,
          o.kind,
          o.state,
          o.activatedAt.toISOString(),
        ],
      )
    ).rows[0].id;
  }

  async function seedBed(org: string, unitId: string, status: string): Promise<string> {
    seq += 1;
    const room = (
      await admin.query(
        "INSERT INTO ipu_room (organization_id,unit_id,room_number,kind,bed_count) VALUES ($1,$2,$3,'private',1) RETURNING id",
        [org, unitId, `R${seq}`],
      )
    ).rows[0].id;
    return (
      await admin.query(
        "INSERT INTO ipu_bed (organization_id,room_id,unit_id,bed_label,cleaning_status) VALUES ($1,$2,$3,'A',$4) RETURNING id",
        [org, room, unitId, status],
      )
    ).rows[0].id;
  }

  const count = async (table: string, org: string) =>
    (await admin.query(`SELECT count(*)::int n FROM ${table} WHERE organization_id=$1`, [org]))
      .rows[0].n;

  const seeded: Record<string, string> = {};

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
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    for (const [id, slug] of [
      [ORG_A, "org-a"],
      [ORG_B, "org-b"],
    ]) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    }
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // ── ORG A and ORG B get the SAME shape of data, so an isolation failure is visible as a count. ──
    for (const [org, facility] of [
      [ORG_A, "77777777-7777-4777-8777-000000000001"],
      [ORG_B, "77777777-7777-4777-8777-000000000002"],
    ] as const) {
      const key = org === ORG_A ? "A" : "B";
      const unit = await seedUnit(org, facility);
      seeded[`${key}.unit`] = unit;

      // Census: a GIP stay since 10-01 (still in bed); an IRC stay 10-03T20:00Z → discharged 10-04T15:00Z
      // (a bed-day on 10-03 and 10-04, NOT in the end-of-day head-count); an IRC stay that starts after the
      // closed day (no census effect); and an arranged remote GIP stay since 10-02.
      seeded[`${key}.gipStale`] = await seedAdmission({
        org,
        unitId: unit,
        kind: "gip",
        state: "active",
        activatedAt: new Date("2026-10-01T10:00:00Z"),
      });
      const ircDone = await seedAdmission({
        org,
        unitId: unit,
        kind: "irc",
        state: "discharged",
        activatedAt: new Date("2026-10-03T20:00:00Z"),
      });
      await admin.query(
        `INSERT INTO ipu_admission_state_history (organization_id,ipu_admission_id,to_state,at,by_membership_id)
         VALUES ($1,$2,'discharged',$3,$4)`,
        [org, ircDone, "2026-10-04T15:00:00Z", MEMBER],
      );
      await seedAdmission({
        org,
        unitId: unit,
        kind: "gip",
        state: "active",
        activatedAt: new Date(NOW.getTime() - 2 * HOUR),
      });
      const remote = await seedAdmission({
        org,
        unitId: null,
        kind: "arranged",
        state: "active",
        activatedAt: new Date("2026-10-02T09:00:00Z"),
        remote: true,
      });
      await admin.query(
        `INSERT INTO ipu_remote_inpatient_episode (organization_id,ipu_admission_id,provider_entity_id,patient_id,
           level_of_care_period_id,remote_facility_id,kind,started_at)
         VALUES ($1,$2,$3,$4,$5,$6,'gip','2026-10-02T09:00:00Z')`,
        [org, remote, PE, uuid(9000), uuid(9001), REMOTE_FACILITY],
      );

      // IRC episode that began 2026-10-01 (local) → today (10-05) is its day 5.
      const ircOpen = await seedAdmission({
        org,
        unitId: unit,
        kind: "irc",
        state: "active",
        activatedAt: new Date("2026-10-01T14:00:00Z"),
      });
      seeded[`${key}.ircEpisode`] = (
        await admin.query(
          `INSERT INTO irc_episode (organization_id,ipu_admission_id,provider_entity_id,patient_id,started_at,expected_end_at)
           VALUES ($1,$2,$3,$4,'2026-10-01T14:00:00Z','2026-10-06T14:00:00Z') RETURNING id`,
          [org, ircOpen, PE, uuid(9002)],
        )
      ).rows[0].id;

      // Restraints: one active and 30 minutes old on a 15-minute interval (due); one already released.
      const justification = "x".repeat(120);
      for (const [state, applied] of [
        ["active", NOW.getTime() - 30 * 60_000],
        ["released", NOW.getTime() - 300 * 60_000],
      ] as const) {
        const id = (
          await admin.query(
            `INSERT INTO ipu_restraint_event (organization_id,ipu_admission_id,restraint_kind,restraint_justification_text,
               ordering_physician_id,ordering_order_id,applied_at,applied_by_membership_id,applied_step_up_assertion_id,
               reassessment_interval_minutes,state,released_at)
             VALUES ($1,$2,'soft_limb',$3,$4,$4,$5,$4,$4,15,$6,$7) RETURNING id`,
            [
              org,
              seeded[`${key}.gipStale`],
              justification,
              MEMBER,
              new Date(applied).toISOString(),
              state,
              state === "released" ? new Date(applied + HOUR).toISOString() : null,
            ],
          )
        ).rows[0].id;
        seeded[`${key}.restraint.${state}`] = id;
      }

      // Beds: one dirty for 130 minutes (10 minutes past the 2-hour SLA; the nag window is 20 minutes wide), one ready.
      const dirty = await seedBed(org, unit, "discharged_dirty");
      await admin.query(
        `INSERT INTO ipu_bed_cleaning_event (organization_id,bed_id,from_status,to_status,at)
         VALUES ($1,$2,'occupied','discharged_dirty',$3)`,
        [org, dirty, new Date(NOW.getTime() - 130 * 60_000).toISOString()],
      );
      seeded[`${key}.dirtyBed`] = dirty;
      await seedBed(org, unit, "ready");
    }
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("irc-cap-watchdog advances an episode to day 5, breaches the cap, and announces each entry once", async () => {
    await runIrcCapWatchdogCron(deps([ORG_A]));
    const ep = (
      await admin.query("SELECT consecutive_day_count n, state FROM irc_episode WHERE id=$1", [
        seeded["A.ircEpisode"],
      ])
    ).rows[0];
    expect(ep).toEqual({ n: 5, state: "breached" });
    expect(eventsOf("m37.irc_episode.cap_approaching", ORG_A)).toHaveLength(1);
    expect(eventsOf("m37.irc_episode.cap_breached", ORG_A)).toHaveLength(1);
    expect(eventsOf("m37.irc_episode.cap_breached", ORG_A)[0]?.payload.consecutiveDayCount).toBe(5);

    await runIrcCapWatchdogCron(deps([ORG_A]));
    expect(eventsOf("m37.irc_episode.cap_breached", ORG_A)).toHaveLength(1); // re-run: no new event
  });

  it("census-snapshot-builder writes one snapshot per (unit | remote facility) per closed date", async () => {
    await runCensusSnapshotBuilderCron(deps([ORG_A]));
    const unitRow = (
      await admin.query(
        `SELECT census_count_gip g, census_count_irc i, bed_days_gip bg, bed_days_irc bi
           FROM ipu_census_snapshot WHERE organization_id=$1 AND service_date='2026-10-04' AND unit_id=$2`,
        [ORG_A, seeded["A.unit"]],
      )
    ).rows[0];
    // GIP + the open-episode IRC patient are still in bed at end of day; the other IRC patient left at
    // 11:00 EDT: a bed-day, not a head-count.
    expect(unitRow).toEqual({ g: 1, i: 1, bg: 1, bi: 2 });
    const remoteRow = (
      await admin.query(
        `SELECT census_count_arranged_gip g, bed_days_arranged_gip b
           FROM ipu_census_snapshot WHERE organization_id=$1 AND service_date='2026-10-04' AND unit_id IS NULL AND remote_facility_id=$2`,
        [ORG_A, REMOTE_FACILITY],
      )
    ).rows[0];
    expect(remoteRow).toEqual({ g: 1, b: 1 });
    // 3 backfill dates x (unit + remote facility). 10-02 has no unit IRC stay but has the GIP + remote.
    expect(await count("ipu_census_snapshot", ORG_A)).toBe(6);
    expect(eventsOf("m37.census.snapshot_taken", ORG_A)).toHaveLength(6);
    const day3 = (
      await admin.query(
        "SELECT bed_days_irc b FROM ipu_census_snapshot WHERE organization_id=$1 AND service_date='2026-10-03' AND unit_id=$2",
        [ORG_A, seeded["A.unit"]],
      )
    ).rows[0];
    expect(day3.b).toBe(2);

    // Re-run: converges on the same rows and publishes nothing.
    await runCensusSnapshotBuilderCron(deps([ORG_A]));
    expect(await count("ipu_census_snapshot", ORG_A)).toBe(6);
    expect(eventsOf("m37.census.snapshot_taken", ORG_A)).toHaveLength(6);
  });

  it("restraint-reassessment-watchdog flags only the ACTIVE restraint past its interval", async () => {
    await runRestraintReassessmentWatchdogCron(deps([ORG_A]));
    const due = eventsOf("m37.restraint.reassessment_due", ORG_A);
    expect(due).toHaveLength(1);
    expect(due[0]?.payload.restraintEventId).toBe(seeded["A.restraint.active"]);
  });

  it("bed-cleaning-sla-watchdog flags only the bed past its turnover SLA", async () => {
    await runBedCleaningSlaWatchdogCron(deps([ORG_A]));
    const overdue = eventsOf("m37.bed.cleaning_overdue", ORG_A);
    expect(overdue).toHaveLength(1);
    expect(overdue[0]?.payload).toMatchObject({ bedId: seeded["A.dirtyBed"], slaMinutes: 120 });
  });

  it("gip-criteria-staleness-sweep flags the 4-day-stale GIP admission, not the fresh one", async () => {
    await runGipCriteriaStalenessSweepCron(deps([ORG_A]));
    const stale = eventsOf("m37.gip_criteria.reassessment_due", ORG_A);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.payload.ipuAdmissionId).toBe(seeded["A.gipStale"]);
  });

  it("CROSS-TENANT: sweeping org A touched nothing of org B's, as the app role", async () => {
    expect(published.every((p) => p.organizationId === ORG_A)).toBe(true);
    const b = (
      await admin.query("SELECT consecutive_day_count n, state FROM irc_episode WHERE id=$1", [
        seeded["B.ircEpisode"],
      ])
    ).rows[0];
    expect(b).toEqual({ n: 1, state: "active" });
    expect(await count("ipu_census_snapshot", ORG_B)).toBe(0);

    // RLS on the app role: org B's tenant context cannot read org A's snapshots at all.
    const visibleToB = await withOrgContext(
      handle.db,
      { organizationId: ORG_B, userId: "" },
      async (tx) => {
        const [row] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.ipuCensusSnapshot);
        return row?.n ?? -1;
      },
    );
    expect(visibleToB).toBe(0);
  });

  it("org B then gets the same answers from its own sweep, and one org's failure does not stop the others", async () => {
    const before = published.length;
    await runIrcCapWatchdogCron(deps([ORG_B]));
    await runCensusSnapshotBuilderCron(deps([ORG_B]));
    expect(
      (
        await admin.query("SELECT consecutive_day_count n FROM irc_episode WHERE id=$1", [
          seeded["B.ircEpisode"],
        ])
      ).rows[0].n,
    ).toBe(5);
    expect(await count("ipu_census_snapshot", ORG_B)).toBe(6);
    expect(published.slice(before).every((p) => p.organizationId === ORG_B)).toBe(true);

    // Failure isolation: org A's publish throws; org B (enumerated after it) is still swept, and the
    // tick fails afterwards so BullMQ retries / dead-letters it.
    const failingForA = {
      ...deps([ORG_A, ORG_B]),
      outbox: {
        publish: async (
          tx: unknown,
          e: Published & { aggregateKind: string; aggregateId: string },
        ) => {
          if (e.organizationId === ORG_A) throw new Error("boom");
          await outbox.publish(tx, e);
        },
      },
    };
    const mid = eventsOf("m37.restraint.reassessment_due", ORG_B).length;
    await expect(runRestraintReassessmentWatchdogCron(failingForA)).rejects.toThrow(/1 of 2 org/);
    expect(eventsOf("m37.restraint.reassessment_due", ORG_B).length).toBe(mid + 1);
  });
});
