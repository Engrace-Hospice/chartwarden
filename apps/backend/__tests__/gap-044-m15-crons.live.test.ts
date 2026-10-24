/**
 * GAP-044 — the five M15 §4.6 crons, END TO END over real Postgres.
 *
 * None of them existed: M15 had no jobs directory, five catalogued `m15.*` events were never emitted, and a
 * lapsed 418.78 volunteer gate was only ever caught fail-closed at read time (the stored status never
 * flipped, assignments never inactivated, the hour ledger was never written).
 *
 * Nothing is stubbed on the write side: the worker functions run as the NOBYPASSRLS `chartwarden_app` role
 * through the REAL catalog-validating outbox publisher (a payload the M15 catalog rejects rolls the tick
 * back and fails HERE), and the hour aggregator reads signed volunteer visits through M8's REAL
 * `SignedEncountersReader` over the real `encounter` table.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m15:crons:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  createDrizzleEncounterReaderStore,
  registerEncounterSeams,
} from "../src/modules/08-encounters/index";
import {
  type M15WorkerDeps,
  M15_OUTBOX_EVENTS,
  buildDrizzleM15ReadService,
  buildM15WorkerDeps,
  orgsDueNow,
  runChaplainInitialOverdueCron,
  runMswInitialOverdueCron,
  runSupervisoryOverdueCron,
  runSupervisoryOverdueForOrg,
  runVolunteerGateWatcherCron,
  runVolunteerHourAggregatorCron,
} from "../src/modules/15-discipline-care-plans/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const USER_V = "44444444-4444-4444-4444-444444444444";
const ANY_UUID = "99999999-9999-9999-9999-999999999999";

const NOW = new Date("2026-10-05T03:00:00.000Z");
const DAY = 86_400_000;
const at = (days: number): string => new Date(NOW.getTime() + days * DAY).toISOString();

describe.skipIf(!DB_URL)("GAP-044 — M15 crons, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let deps: M15WorkerDeps;
  const peOf: Record<string, string> = {};
  const locOf: Record<string, string> = {};
  let volunteerMembershipId: string;

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
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  async function plan(
    org: string,
    kind: string,
    over: {
      status?: string;
      nextDue?: string | null;
      clockStarted?: string | null;
      declinedAt?: string | null;
      patientId?: string;
    } = {},
  ): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO discipline_care_plan
         (organization_id, patient_id, admission_id, provider_entity_id, location_id, kind, status,
          next_supervisory_due_at, initial_assessment_clock_started_at, spiritual_care_declined_at,
          spiritual_care_declined)
       VALUES ($1, COALESCE($2, gen_random_uuid()), gen_random_uuid(), $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        org,
        over.patientId ?? null,
        peOf[org],
        locOf[org],
        kind,
        over.status ?? "active",
        over.nextDue ?? null,
        over.clockStarted ?? null,
        over.declinedAt ?? null,
        over.declinedAt ? "Patient declined spiritual care." : null,
      ],
    );
    return rows[0].id as string;
  }

  async function events(eventType: string, org?: string) {
    const { rows } = await admin.query(
      `SELECT organization_id, aggregate_id, payload FROM outbox_event
        WHERE event_type=$1 ${org ? "AND organization_id=$2" : ""} ORDER BY created_at`,
      org ? [eventType, org] : [eventType],
    );
    return rows as {
      organization_id: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
    }[];
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'g44@x.test'),($2,'g44v@x.test')`, [
      USER,
      USER_V,
    ]);
    for (const org of [ORG_A, ORG_B]) {
      peOf[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [org, `CCN-${org.slice(0, 4)}`, `PE ${org.slice(0, 4)}`, `NPI-${org.slice(0, 4)}`],
        )
      ).rows[0].id as string;
      locOf[org] = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
             VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [peOf[org]],
        )
      ).rows[0].id as string;
    }
    volunteerMembershipId = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER_V, ORG_A],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    registerEncounterSeams({ store: createDrizzleEncounterReaderStore(handle.db) });

    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M15_OUTBOX_EVENTS]));
    deps = {
      ...buildM15WorkerDeps({
        connection: {} as never,
        db: handle.db,
        outbox: {
          publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m15" }),
        },
        activeOrgs: {
          listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
        },
      }),
      now: () => NOW,
    };
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("supervisory-overdue emits for a breached aide_poc clock only, per tenant", async () => {
    const overdueA = await plan(ORG_A, "aide_poc", { nextDue: at(-1) });
    const gateA = await plan(ORG_A, "aide_poc", { nextDue: at(-3) });
    await plan(ORG_A, "aide_poc", { nextDue: at(2) });
    const overdueB = await plan(ORG_B, "aide_poc", { nextDue: at(-1) });

    await runSupervisoryOverdueCron(deps);

    const evs = await events("m15.aide_supervisory.overdue");
    const byPlan = new Map(evs.map((e) => [e.payload.planId, e]));
    expect(evs).toHaveLength(3);
    expect(byPlan.get(overdueA)?.payload).toMatchObject({ hoursOverdue: 24, severity: "warn" });
    expect(byPlan.get(gateA)?.payload).toMatchObject({ hoursOverdue: 72, severity: "critical" });
    expect(byPlan.get(overdueB)?.organization_id).toBe(ORG_B);
  });

  it("msw + chaplain initial-overdue honour the signed and declined-care paths", async () => {
    const msw = await plan(ORG_A, "msw_plan", { status: "draft", clockStarted: at(-6) });
    await plan(ORG_A, "msw_plan", { status: "draft", clockStarted: at(-2) });
    const mswWarn = await plan(ORG_A, "msw_plan", { status: "draft", clockStarted: at(-3.5) });
    const chaplain = await plan(ORG_A, "spiritual_plan", { status: "draft", clockStarted: at(-6) });
    await plan(ORG_A, "spiritual_plan", {
      status: "draft",
      clockStarted: at(-6),
      declinedAt: at(-5),
    });

    await runMswInitialOverdueCron(deps);
    await runChaplainInitialOverdueCron(deps);

    const mswEvents = await events("m15.msw.assessment_initial_overdue");
    // Ladder (spec §7.2): day-3 warn (daysOverdue 0) / day-5 critical; day-2 is silent.
    const mswByPlan = new Map(mswEvents.map((e) => [e.payload.planId, e.payload]));
    expect(mswEvents).toHaveLength(2);
    expect(mswByPlan.get(msw)).toMatchObject({ daysOverdue: 1, severity: "critical" });
    expect(mswByPlan.get(mswWarn)).toMatchObject({ daysOverdue: 0, severity: "warn" });
    const chaplainEvents = await events("m15.chaplain.assessment_initial_overdue");
    expect(chaplainEvents.map((e) => e.payload.planId)).toEqual([chaplain]);
  });

  it("gate watcher flips an expired gate, inactivates assignments, alerts the ladder — idempotently", async () => {
    const volunteerPlan = await plan(ORG_A, "volunteer_plan", { status: "active" });
    const assignmentId = (
      await admin.query(
        `INSERT INTO volunteer_assignment
           (organization_id, provider_entity_id, location_id, plan_id, volunteer_membership_id,
            coordinator_membership_id, starts_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [ORG_A, peOf[ORG_A], locOf[ORG_A], volunteerPlan, volunteerMembershipId, ANY_UUID, at(-90)],
      )
    ).rows[0].id as string;
    const gate = async (kind: string, status: string, validUntil: string | null) =>
      (
        await admin.query(
          `INSERT INTO volunteer_compliance_gate
             (organization_id, volunteer_membership_id, gate_kind, status, valid_from, valid_until,
              recorded_by_membership_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [ORG_A, volunteerMembershipId, kind, status, at(-365), validUntil, ANY_UUID],
        )
      ).rows[0].id as string;
    const expiredGate = await gate("tb_screening", "satisfied", at(-1));
    const oneDayGate = await gate("background_check", "expiring_soon", at(1));
    const leadInGate = await gate("annual_ce", "satisfied", at(30));
    // A gate first seen 10 days out (the 30/14 runs were missed): it gets the tightest crossed mark (14), once.
    const missedGate = await gate("confidentiality_agreement", "satisfied", at(10));

    await runVolunteerGateWatcherCron(deps);

    const status = async (id: string) =>
      (await admin.query("SELECT status FROM volunteer_compliance_gate WHERE id=$1", [id])).rows[0]
        .status as string;
    expect(await status(expiredGate)).toBe("expired");
    expect(await status(leadInGate)).toBe("expiring_soon");
    const asg = (
      await admin.query(
        "SELECT inactivated_at, inactivation_reason FROM volunteer_assignment WHERE id=$1",
        [assignmentId],
      )
    ).rows[0];
    expect(asg.inactivated_at).not.toBeNull();
    expect(asg.inactivation_reason).toBe("gate_expired:tb_screening");

    const expired = await events("m15.volunteer.gate_expired");
    expect(expired).toHaveLength(1);
    expect(expired[0]?.payload).toMatchObject({
      gateKind: "tb_screening",
      openAssignmentsCount: 1,
      volunteerMembershipId,
    });
    expect((await events("m15.volunteer.assignment_inactivated"))[0]?.payload).toMatchObject({
      affectedPlanIds: [volunteerPlan],
      reason: "gate_expired:tb_screening",
    });
    const expiring = await events("m15.volunteer.gate_expiring");
    expect(
      expiring.map((e) => [e.aggregate_id, e.payload.daysOut, e.payload.severity]).sort(),
    ).toEqual(
      [
        [leadInGate, 30, "info"],
        [missedGate, 14, "warn"],
        [oneDayGate, 1, "critical"],
      ].sort(),
    );

    const stamp = async (id: string) =>
      (
        await admin.query(
          "SELECT last_expiry_notice_days_out AS d FROM volunteer_compliance_gate WHERE id=$1",
          [id],
        )
      ).rows[0].d as number | null;
    expect([await stamp(leadInGate), await stamp(missedGate), await stamp(oneDayGate)]).toEqual([
      30, 14, 1,
    ]);
    expect(await stamp(expiredGate)).toBeNull();

    // Idempotent: a replayed tick flips nothing and emits no second expiry / cascade / ladder notice.
    await runVolunteerGateWatcherCron(deps);
    expect(await events("m15.volunteer.gate_expiring")).toHaveLength(3);
    expect(await events("m15.volunteer.gate_expired")).toHaveLength(1);
    expect(await events("m15.volunteer.assignment_inactivated")).toHaveLength(1);
  });

  it("hour aggregator ledgers signed volunteer visits once, reports unresolved durations, never zero", async () => {
    const patientId = (await admin.query("SELECT gen_random_uuid() AS id")).rows[0].id as string;
    await plan(ORG_A, "volunteer_plan", { status: "active", patientId });
    const volunteerPlan = (
      await admin.query(
        "SELECT id FROM discipline_care_plan WHERE patient_id=$1 AND kind='volunteer_plan'",
        [patientId],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO volunteer_assignment
         (organization_id, provider_entity_id, location_id, plan_id, volunteer_membership_id,
          coordinator_membership_id, starts_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ORG_A, peOf[ORG_A], locOf[ORG_A], volunteerPlan, volunteerMembershipId, ANY_UUID, at(-90)],
    );
    const visit = (day: string, minutes: number | null) =>
      admin.query(
        `INSERT INTO encounter (organization_id, patient_id, admission_id, authored_by_membership_id,
                                encounter_type, discipline, service_date, started_at, ended_at,
                                status, signed_at, vocab_version_id)
         VALUES ($1,$2,gen_random_uuid(),$3,'volunteer_visit','volunteer',$4::date,
                 ($4 || ' 09:00:00+00')::timestamptz,
                 CASE WHEN $5::int IS NULL THEN NULL
                      ELSE ($4 || ' 09:00:00+00')::timestamptz + ($5::int || ' minutes')::interval END,
                 'signed', now(), gen_random_uuid())`,
        [ORG_A, patientId, volunteerMembershipId, day, minutes],
      );
    await visit("2026-09-01", 90);
    await visit("2026-09-02", null); // no bracket → unresolved, NOT zero minutes

    await runVolunteerHourAggregatorCron(deps);

    const ledger = (
      await admin.query(
        `SELECT id, total_volunteer_hour_minutes FROM volunteer_hour_ledger
          WHERE organization_id=$1 AND provider_entity_id=$2 AND fiscal_year=2026`,
        [ORG_A, peOf[ORG_A]],
      )
    ).rows[0];
    expect(Number(ledger.total_volunteer_hour_minutes)).toBe(90);
    const entries = (
      await admin.query(
        "SELECT duration_minutes, source FROM volunteer_hour_entry WHERE ledger_id=$1",
        [ledger.id],
      )
    ).rows;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: "encounter" });
    const recomputed = await events("m15.volunteer.ratio_recomputed");
    expect(recomputed).toHaveLength(1);
    expect(recomputed[0]?.payload).toMatchObject({
      providerEntityId: peOf[ORG_A],
      fiscalYear: 2026,
      hoursMinutes: 90,
      status: "unavailable",
    });

    // Idempotent on source_encounter_id: nothing new on a replay.
    await runVolunteerHourAggregatorCron(deps);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM volunteer_hour_entry WHERE ledger_id=$1",
          [ledger.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(await events("m15.volunteer.ratio_recomputed")).toHaveLength(1);

    // M15-F04 — staff patient-care hours now come from M8's signed digests: a resolved RN visit becomes the
    // denominator (a null-duration RN visit is excluded, not zero), so the ratio is real, not `unavailable`.
    const staffVisit = (day: string, minutes: number | null) =>
      admin.query(
        `INSERT INTO encounter (organization_id, patient_id, admission_id, authored_by_membership_id,
                                encounter_type, discipline, service_date, started_at, ended_at,
                                status, signed_at, vocab_version_id)
         VALUES ($1,$2,gen_random_uuid(),$3,'routine_visit','rn',$4::date,
                 ($4 || ' 09:00:00+00')::timestamptz,
                 CASE WHEN $5::int IS NULL THEN NULL
                      ELSE ($4 || ' 09:00:00+00')::timestamptz + ($5::int || ' minutes')::interval END,
                 'signed', now(), gen_random_uuid())`,
        [ORG_A, patientId, volunteerMembershipId, day, minutes],
      );
    await staffVisit("2026-09-01", 1800);
    await staffVisit("2026-09-02", null);
    await visit("2026-09-03", 60); // new volunteer minutes ⇒ the ledger changes ⇒ the event re-emits
    await runVolunteerHourAggregatorCron(deps);
    const after = await events("m15.volunteer.ratio_recomputed");
    expect(after).toHaveLength(2);
    expect(after[1]?.payload).toMatchObject({ hoursMinutes: 150, status: "green" });

    // 0347 — the cron PERSISTED the denominator once per PE × FY on the ledger row (1800 RN minutes; the
    // null-duration visit is counted unresolved, not zero) and the read path serves exactly that value.
    const persisted = async () =>
      (
        await admin.query(
          `SELECT patient_care_minutes, patient_care_visits_counted, patient_care_visits_unresolved,
                  patient_care_computed_at
             FROM volunteer_hour_ledger WHERE organization_id=$1 AND provider_entity_id=$2 AND fiscal_year=2026`,
          [ORG_A, peOf[ORG_A]],
        )
      ).rows[0];
    const row = await persisted();
    expect(Number(row.patient_care_minutes)).toBe(1800);
    expect(row.patient_care_visits_counted).toBe(1);
    expect(row.patient_care_visits_unresolved).toBe(1);
    expect(new Date(row.patient_care_computed_at).toISOString()).toBe(NOW.toISOString());

    const readService = buildDrizzleM15ReadService(handle.db, {
      now: () => NOW.toISOString() as never,
    });
    const actorFor = (organizationId: string) => ({
      organizationId,
      userId: USER,
      membershipId: null,
      roles: [],
      sessionClass: "staff",
      locationIds: [],
    });
    const query = (org: string) => ({ providerEntityId: peOf[org] as string, fiscalYear: 2026 });
    const served = (await readService.getVolunteerHourRatio(
      actorFor(ORG_A),
      query(ORG_A) as never,
    )) as { status: string; staffPatientCareMinutes: number | null; reason?: string };
    expect(served.staffPatientCareMinutes).toBe(1800);
    expect(served.status).toBe("green");
    expect(served.reason).toBeUndefined();

    // A staff visit signed AFTER the volunteer ledger settled still refreshes the denominator (the
    // no-new-volunteer-entries pass persists it too).
    await staffVisit("2026-09-04", 600);
    await runVolunteerHourAggregatorCron(deps);
    expect(Number((await persisted()).patient_care_minutes)).toBe(2400);

    // Older than 48h ⇒ still served, flagged stale.
    await admin.query(
      `UPDATE volunteer_hour_ledger SET patient_care_computed_at = $3::timestamptz - interval '3 days'
        WHERE organization_id=$1 AND provider_entity_id=$2`,
      [ORG_A, peOf[ORG_A], NOW.toISOString()],
    );
    const stale = (await readService.getVolunteerHourRatio(
      actorFor(ORG_A),
      query(ORG_A) as never,
    )) as { staffPatientCareMinutes: number | null; reason?: string };
    expect(stale.staffPatientCareMinutes).toBe(2400);
    expect(stale.reason).toContain("stale");

    // Never computed (NULL) ⇒ unavailable with the honest reason.
    await admin.query(
      `UPDATE volunteer_hour_ledger SET patient_care_minutes=NULL, patient_care_computed_at=NULL
        WHERE organization_id=$1 AND provider_entity_id=$2`,
      [ORG_A, peOf[ORG_A]],
    );
    const never = (await readService.getVolunteerHourRatio(
      actorFor(ORG_A),
      query(ORG_A) as never,
    )) as { status: string; reason?: string };
    expect(never.status).toBe("unavailable");
    expect(never.reason).toContain("not been computed");

    // Cross-tenant: org B's actor sees neither org A's ledger nor its denominator (RLS as chartwarden_app).
    const other = (await readService.getVolunteerHourRatio(
      actorFor(ORG_B),
      query(ORG_A) as never,
    )) as { status: string; volunteerHourMinutes: number; staffPatientCareMinutes: number | null };
    expect(other).toMatchObject({
      status: "unavailable",
      volunteerHourMinutes: 0,
      staffPatientCareMinutes: null,
    });
  });

  it("retries are per org: a failing tenant does not re-emit for the tenants that already committed", async () => {
    const before = async (org: string) =>
      (await events("m15.aide_supervisory.overdue", org)).length;
    const [a0, b0] = [await before(ORG_A), await before(ORG_B)];
    const failingB: M15WorkerDeps = {
      ...deps,
      outbox: {
        publish: (tx, e) => {
          if (e.organizationId === ORG_B) throw new Error("boom: tenant B outbox down");
          return deps.outbox.publish(tx, e);
        },
      },
    };

    // All-orgs invocation: A commits, B rolls back whole (one tx), the tick reports the failure.
    await expect(runSupervisoryOverdueCron(failingB)).rejects.toThrow(/M15_CRON_PARTIAL_FAILURE/);
    const [a1, b1] = [await before(ORG_A), await before(ORG_B)];
    expect(a1).toBeGreaterThan(a0);
    expect(b1).toBe(b0); // B's transaction rolled back: nothing half-emitted

    // The retry is the per-org job for B alone: B emits, A is untouched.
    await runSupervisoryOverdueForOrg(deps, ORG_B);
    expect(await before(ORG_A)).toBe(a1);
    expect(await before(ORG_B)).toBeGreaterThan(b1);
  });

  it("hourly tick acts only for orgs whose LOCAL hour is the spec hour (org_timezone)", async () => {
    // NOW = 03:00Z. ORG_A is on UTC (local 03:00 = gate-watcher hour); ORG_B on Asia/Tokyo (local 12:00).
    await admin.query(
      `UPDATE organization SET settings = COALESCE(settings,'{}'::jsonb) || $2::jsonb WHERE id=$1`,
      [ORG_A, JSON.stringify({ org_timezone: "UTC" })],
    );
    await admin.query(
      `UPDATE organization SET settings = COALESCE(settings,'{}'::jsonb) || $2::jsonb WHERE id=$1`,
      [ORG_B, JSON.stringify({ org_timezone: "Asia/Tokyo" })],
    );
    expect(await orgsDueNow(deps, "volunteerGateWatcher")).toEqual([ORG_A]);
    expect(await orgsDueNow(deps, "mswInitialOverdue")).toEqual([]); // hour 2: neither
    expect(await orgsDueNow(deps, "supervisoryOverdue")).toEqual([ORG_A, ORG_B]); // not a wall-clock cron
  });
});
