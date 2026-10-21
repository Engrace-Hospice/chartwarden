/**
 * F-071 (#174) — the RN-coverage producer, proven against real Postgres.
 *
 * `ipu_rn_coverage_window` is a MATERIALIZED invariant that four M37 write paths read, each treating an
 * absent row as uncovered. Nothing ever wrote a row: the `rn-coverage-watchdog` worker §2.3 D3 defines
 * was never built. `planOpenAdmission` refuses every non-`arranged` admission on that flag, so no GIP and
 * no inpatient-respite admission could be opened on any deployment.
 *
 * The FIRST case here is the whole issue: with no shifts, opening a GIP admission is refused — and it is
 * refused for the same reason it was refused before this change, which is why the second case matters.
 * Schedule an RN, run the watchdog, and the SAME call succeeds. Nothing else changes between them.
 *
 * Deliberately NOT using the trick every other M37 live suite uses — `INSERT INTO
 * ipu_rn_coverage_window … is_covered = true` before opening an admission. That insert is the harness
 * supplying the fact its own production path could not produce, which is exactly why nothing caught this
 * (the F-030 shape: the suites prove the GATE and nothing proves the PRODUCER). Here the rows come from
 * the worker or they do not come at all.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m37:coverage:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRnCoverageWatchdogCron } from "../src/modules/37-ipu/jobs/cron-workers";
import { buildDrizzleIpuRouteService } from "../src/modules/37-ipu/routes/service-drizzle";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const MEMBER = "44444444-4444-4444-4444-444444444444";
const PATIENT = "55555555-5555-5555-5555-555555555555";
const PE = "66666666-6666-6666-6666-666666666666";
/**
 * A DISTINCT facility per unit. `inpatient_unit_org_facility_uq` (migration 0149) is UNIQUE on
 * (organization_id, facility_id) — one IPU unit per facility per org — so every unit after the first
 * collided on 23505 and this suite has been red since the day it was written: 5 of its 8 tests died in
 * their own `createUnit` call, on a constraint that predates them. Nothing surfaced it because CI has
 * not executed a live suite; `arch:live-suites` proves a suite is WIRED to a job, never that the job
 * is green. (F-080, found while adding the confirm-staff test below.)
 */
const facilityFor = (n: number): string => `77777777-7777-4777-8777-${String(n).padStart(12, "0")}`;
const FACILITY = facilityFor(1);

const actor = {
  organizationId: ORG_A,
  userId: USER,
  roles: [] as string[],
  membershipId: MEMBER,
  stepUpRecent: true,
};
const readActor = { organizationId: ORG_A, userId: USER, roles: [] as string[] };

const HOUR = 3_600_000;

describe.skipIf(!DB_URL)("M37 RN-coverage watchdog — LIVE Postgres (F-071)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof buildDrizzleIpuRouteService>;
  let unitId: string;
  let admissionSeq = 0;

  /** The single-org fan-out source the worker enumerates (the composition root binds M2's enumerator). */
  const activeOrgs = { listActiveOrgs: async () => [{ organizationId: ORG_A }] };
  /** A no-op outbox: this suite asserts on the coverage TABLE and the gate, not on emitted events. */
  const outbox = { publish: async () => {} };

  async function runWatchdog(): Promise<void> {
    await runRnCoverageWatchdogCron({
      connection: {} as never, // unused — the cron function is driven directly, not through BullMQ
      db: handle.db,
      outbox,
      activeOrgs,
      now: () => new Date(),
    });
  }

  /** Open a GIP admission on the unit. Each call uses fresh cross-module ids (unique per admission). */
  async function openGip() {
    admissionSeq += 1;
    const pad = String(admissionSeq).padStart(2, "0");
    return svc.openAdmission(actor, {
      patientId: PATIENT,
      admissionId: `99999999-0000-4000-8000-0000000000${pad}`,
      levelOfCarePeriodId: `99999999-1111-4111-8111-0000000000${pad}`,
      providerEntityId: PE,
      unitId,
      kind: "gip",
    });
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
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));

    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
      [ORG_A],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m37cov@x.test')`, [USER]);
    // The membership the shift assignment names — `active`, which is the eligibility the store resolves.
    await admin.query(
      "INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,'active')",
      [MEMBER, USER, ORG_A],
    );
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    svc = buildDrizzleIpuRouteService(handle.db, { outbox });

    const unit = await svc.createUnit(actor, {
      facilityId: FACILITY,
      displayName: "IPU One",
      bedCount: 4,
    });
    unitId = unit.id;
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("writes NO coverage rows when the unit has no shifts — and a GIP admission is refused", async () => {
    await runWatchdog();
    const covered = (
      await admin.query(
        "SELECT count(*)::int n FROM ipu_rn_coverage_window WHERE unit_id=$1 AND is_covered",
        [unitId],
      )
    ).rows[0].n;
    // The grid IS materialized (216 rows) — it just says uncovered, which is the honest answer.
    const total = (
      await admin.query("SELECT count(*)::int n FROM ipu_rn_coverage_window WHERE unit_id=$1", [
        unitId,
      ])
    ).rows[0].n;
    expect(total).toBe(216);
    expect(covered).toBe(0);

    await expect(openGip()).rejects.toMatchObject({ code: "IPU_RN_COVERAGE_UNAVAILABLE" });
  });

  it("schedules an RN, runs the watchdog, and the SAME call now succeeds", async () => {
    // A 12-hour shift starting an hour ago, with a CONFIRMED charge-RN assignment on it.
    const now = Date.now();
    const shiftId = (
      await admin.query(
        "INSERT INTO ipu_shift (organization_id,unit_id,shift_start_at,shift_end_at,created_by) " +
          "VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [
          ORG_A,
          unitId,
          new Date(now - HOUR).toISOString(),
          new Date(now + 11 * HOUR).toISOString(),
          MEMBER,
        ],
      )
    ).rows[0].id;
    await admin.query(
      "INSERT INTO ipu_staff_assignment (organization_id,shift_id,membership_id,role,state) " +
        "VALUES ($1,$2,$3,'charge_rn','confirmed')",
      [ORG_A, shiftId, MEMBER],
    );

    await runWatchdog();

    const covered = (
      await admin.query(
        "SELECT count(*)::int n FROM ipu_rn_coverage_window WHERE unit_id=$1 AND is_covered",
        [unitId],
      )
    ).rows[0].n;
    // 12 hours of shift → the hours whose start falls inside [start, end).
    expect(covered).toBeGreaterThanOrEqual(11);
    expect(covered).toBeLessThanOrEqual(13);

    const adm = await openGip();
    expect(adm.state).toBe("pending");
  });

  it("a TENTATIVE assignment does not cover — only `confirmed` counts (§2.3)", async () => {
    const now = Date.now();
    const unit2 = await svc.createUnit(actor, {
      facilityId: facilityFor(2),
      displayName: "IPU Two",
      bedCount: 2,
    });
    const shiftId = (
      await admin.query(
        "INSERT INTO ipu_shift (organization_id,unit_id,shift_start_at,shift_end_at,created_by) " +
          "VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [
          ORG_A,
          unit2.id,
          new Date(now - HOUR).toISOString(),
          new Date(now + 11 * HOUR).toISOString(),
          MEMBER,
        ],
      )
    ).rows[0].id;
    await admin.query(
      "INSERT INTO ipu_staff_assignment (organization_id,shift_id,membership_id,role,state) " +
        "VALUES ($1,$2,$3,'charge_rn','tentative')",
      [ORG_A, shiftId, MEMBER],
    );

    await runWatchdog();

    const covered = (
      await admin.query(
        "SELECT count(*)::int n FROM ipu_rn_coverage_window WHERE unit_id=$1 AND is_covered",
        [unit2.id],
      )
    ).rows[0].n;
    expect(covered).toBe(0);
  });

  it("a NON-RN role does not cover, however many of them are on shift", async () => {
    const now = Date.now();
    const unit3 = await svc.createUnit(actor, {
      facilityId: facilityFor(3),
      displayName: "IPU Three",
      bedCount: 2,
    });
    const shiftId = (
      await admin.query(
        "INSERT INTO ipu_shift (organization_id,unit_id,shift_start_at,shift_end_at,created_by) " +
          "VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [
          ORG_A,
          unit3.id,
          new Date(now - HOUR).toISOString(),
          new Date(now + 11 * HOUR).toISOString(),
          MEMBER,
        ],
      )
    ).rows[0].id;
    for (const role of ["cna", "lpn", "housekeeping"]) {
      await admin.query(
        `INSERT INTO ipu_staff_assignment (organization_id,shift_id,membership_id,role,state) VALUES ($1,$2,$3,'${role}','confirmed')`,
        [ORG_A, shiftId, MEMBER],
      );
    }
    await runWatchdog();
    const covered = (
      await admin.query(
        "SELECT count(*)::int n FROM ipu_rn_coverage_window WHERE unit_id=$1 AND is_covered",
        [unit3.id],
      )
    ).rows[0].n;
    expect(covered).toBe(0);
  });

  it("re-running the watchdog is idempotent — it upserts the grid rather than duplicating it", async () => {
    const before = (
      await admin.query("SELECT count(*)::int n FROM ipu_rn_coverage_window WHERE unit_id=$1", [
        unitId,
      ])
    ).rows[0].n;
    await runWatchdog();
    await runWatchdog();
    const after = (
      await admin.query("SELECT count(*)::int n FROM ipu_rn_coverage_window WHERE unit_id=$1", [
        unitId,
      ])
    ).rows[0].n;
    expect(after).toBe(before);
  });

  it("break-glass writes a row that the coverage gate reads, and it expires", async () => {
    const unit4 = await svc.createUnit(actor, {
      facilityId: facilityFor(4),
      displayName: "IPU Four",
      bedCount: 2,
    });
    await runWatchdog(); // materializes an all-uncovered grid for unit4
    admissionSeq += 1;
    const pad = String(admissionSeq).padStart(2, "0");
    const openOnUnit4 = () =>
      svc.openAdmission(actor, {
        patientId: PATIENT,
        admissionId: `88888888-0000-4000-8000-0000000000${pad}`,
        levelOfCarePeriodId: `88888888-1111-4111-8111-0000000000${pad}`,
        providerEntityId: PE,
        unitId: unit4.id,
        kind: "gip",
      });

    await expect(openOnUnit4()).rejects.toMatchObject({ code: "IPU_RN_COVERAGE_UNAVAILABLE" });

    const bg = await svc.invokeRnBreakGlass(actor, unit4.id, {
      reason: "Night RN called out; charge nurse covering from the adjacent unit until 06:00.",
      durationMinutes: 120,
    });
    expect(bg.invoked).toBe(true);
    expect(bg.alreadyActive).toBe(false);
    // It WROTE something. Before F-071 this route published an event and returned; the gate read the
    // coverage window only, so the documented escape hatch changed no answer.
    const row = (
      await admin.query(
        "SELECT reason, expires_at, invoked_by_membership_id FROM ipu_rn_break_glass WHERE unit_id=$1",
        [unit4.id],
      )
    ).rows[0];
    expect(row.invoked_by_membership_id).toBe(MEMBER);
    expect(String(row.reason)).toContain("called out");

    // The SAME call now passes — and the coverage grid still says uncovered, which is the point: the
    // compliance record shows the gap while the override lets care proceed.
    const adm = await openOnUnit4();
    expect(adm.state).toBe("pending");
    const stillUncovered = (
      await admin.query(
        "SELECT count(*)::int n FROM ipu_rn_coverage_window WHERE unit_id=$1 AND is_covered",
        [unit4.id],
      )
    ).rows[0].n;
    expect(stillUncovered).toBe(0);

    // A second invocation reports the live one rather than stacking a second window.
    const again = await svc.invokeRnBreakGlass(actor, unit4.id, {
      reason: "Second invocation while the first is still running — must not extend the window.",
      durationMinutes: 240,
    });
    expect(again.alreadyActive).toBe(true);
    expect(
      (
        await admin.query("SELECT count(*)::int n FROM ipu_rn_break_glass WHERE unit_id=$1", [
          unit4.id,
        ])
      ).rows[0].n,
    ).toBe(1);

    // Expire it in place; the gate stops passing with nothing having had to run.
    //
    // BOTH timestamps move back. `ipu_rn_break_glass_window_ordered` (migration 0230) is
    // CHECK (expires_at > invoked_at), so pushing only `expires_at` into the past raises 23514 and the
    // row never expires — which is how this line failed. Aging the whole window backwards is what an
    // elapsed override actually looks like. (F-080.)
    await admin.query(
      "UPDATE ipu_rn_break_glass SET invoked_at = now() - interval '2 hours', " +
        "expires_at = now() - interval '1 minute'",
    );
    await expect(openOnUnit4()).rejects.toMatchObject({ code: "IPU_RN_COVERAGE_UNAVAILABLE" });
  });

  it("the DB refuses an override longer than the §2.3 4-hour cap, whatever the route asks for", async () => {
    const unit5 = await svc.createUnit(actor, {
      facilityId: facilityFor(5),
      displayName: "IPU Five",
      bedCount: 1,
    });
    // The route's own TypeBox caps `durationMinutes` at 240; this asserts the DB floor under it, so a
    // caller reaching the store another way still cannot mint an unbounded override.
    await expect(
      admin.query(
        "INSERT INTO ipu_rn_break_glass (organization_id,unit_id,invoked_by_membership_id,expires_at,reason) " +
          "VALUES ($1,$2,$3, now() + interval '8 hours', $4)",
        [ORG_A, unit5.id, MEMBER, "x".repeat(60)],
      ),
    ).rejects.toThrow(/ipu_rn_break_glass_max_window/);
  });

  /**
   * F-080 — the whole chain through the SERVICE, with no raw SQL anywhere in it.
   *
   * Every other coverage test in this file inserts `state='confirmed'` directly, which is exactly the
   * value no product path could produce: `ipu_staff_assignment.state` defaults to `tentative`,
   * `assignStaff` never set it, and nothing in M37 ever wrote `confirmed`. So the watchdog materialized a
   * 216-row grid of `is_covered = false` for every unit on every deployment, and every GIP and
   * inpatient-respite admission stayed refused at open — the outage the watchdog was built to end. The
   * suite passed throughout, because its own fixture supplied the one fact the product could not.
   *
   * This is the same assertion the file's second test makes, minus the SQL: create the shift with
   * `createShift`, assign with `assignStaff`, confirm with `confirmStaff`, run the real watchdog, open
   * a GIP admission. The `tentative` arm in the middle is what fails against the pre-fix code.
   */
  it("covers an hour end-to-end through the service alone — no raw SQL (F-080)", async () => {
    const now = Date.now();
    const unit7 = await svc.createUnit(actor, {
      facilityId: facilityFor(6),
      displayName: "IPU Seven",
      bedCount: 1,
    });
    const shift = await svc.createShift(actor, {
      unitId: unit7.id,
      shiftStartAt: new Date(now - HOUR).toISOString(),
      shiftEndAt: new Date(now + 11 * HOUR).toISOString(),
    });
    const assignment = await svc.assignStaff(actor, shift.id, {
      membershipId: MEMBER,
      role: "charge_rn",
    });
    // The route creates it tentative — which is correct, and is why the confirm step has to exist.
    expect(assignment.state).toBe("tentative");

    await runWatchdog();
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM ipu_rn_coverage_window WHERE unit_id=$1 AND is_covered",
          [unit7.id],
        )
      ).rows[0].n,
    ).toBe(0);

    const confirmed = await svc.confirmStaff(actor, shift.id, { assignmentId: assignment.id });
    expect(confirmed.state).toBe("confirmed");

    await runWatchdog();
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM ipu_rn_coverage_window WHERE unit_id=$1 AND is_covered",
          [unit7.id],
        )
      ).rows[0].n,
    ).toBeGreaterThanOrEqual(11);

    admissionSeq += 1;
    const pad = String(admissionSeq).padStart(2, "0");
    const adm = await svc.openAdmission(actor, {
      patientId: PATIENT,
      admissionId: `99999999-0000-4000-8000-0000000000${pad}`,
      levelOfCarePeriodId: `99999999-1111-4111-8111-0000000000${pad}`,
      providerEntityId: PE,
      unitId: unit7.id,
      kind: "gip",
    });
    expect(adm.state).toBe("pending");

    // Confirming twice is idempotent — the second call returns the row rather than re-stamping it.
    const again = await svc.confirmStaff(actor, shift.id, { assignmentId: assignment.id });
    expect(again.state).toBe("confirmed");

    // …and a cancelled assignment is never confirmable back onto the grid.
    await svc.unassignStaff(actor, shift.id, { assignmentId: assignment.id });
    await expect(
      svc.confirmStaff(actor, shift.id, { assignmentId: assignment.id }),
    ).rejects.toMatchObject({ code: "ILLEGAL_STAFF_ASSIGNMENT_TRANSITION" });
  });

  it("the DB refuses an override with a too-short reason", async () => {
    const unit6 = await svc.createUnit(actor, {
      facilityId: facilityFor(7),
      displayName: "IPU Six",
      bedCount: 1,
    });
    await expect(
      admin.query(
        "INSERT INTO ipu_rn_break_glass (organization_id,unit_id,invoked_by_membership_id,expires_at,reason) " +
          "VALUES ($1,$2,$3, now() + interval '1 hour', 'short')",
        [ORG_A, unit6.id, MEMBER],
      ),
    ).rejects.toThrow(/ipu_rn_break_glass_reason_min/);
  });
});
