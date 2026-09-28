/**
 * F-111 (#249) — M20's §4.8 `m20.sos-sla-watchdog.cron` finally has a production caller.
 *
 * THE FINDING. `lifecycle/sos-escalator.ts`'s `decideSosWatchdog` — the 5-second stale-cancel-window
 * sweep, the tier-1/2/3 SLA-dwell escalation, the `emergency_terminus` re-page loop — has been complete
 * and unit-tested since M20-T03 with NO production caller anywhere. No file under `20-field-safety`
 * matched `*cron*`/`*worker*`/`*job*`; the composition root wired M20's outbox consumers but registered
 * no cron worker for this module at all. An SOS alert nobody acknowledged within its tier's SLA sat
 * there forever — silently, since this is the absence of a background process, not an error path
 * anything logs.
 *
 * WHY THIS SUITE IS LIVE. The whole point is proving the WORKER, not the decider (already unit-tested
 * with no database). `runSosSlaWatchdogCron` fans out over active orgs via `withOrgContext`, resolves
 * the pinned policy through the real `SafetyPolicyProvider`, and applies the decision with the same
 * §2.5 version-guarded UPDATE the route layer and `consumers/m36-delivery-failed.ts` use — none of that
 * is representable against an in-memory double, and the double-escalation lock in particular is a
 * statement about how Postgres serializes two concurrent `UPDATE ... WHERE version = ?` statements
 * against the SAME row, not about anything this suite could fake.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m20:sos-sla-watchdog:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  M20_OUTBOX_EVENTS,
  type M20WorkerDeps,
  buildDrizzleSafetySeamStore,
  buildM20WorkerDeps,
  createSafetyPolicyProvider,
  runSosSlaWatchdogCron,
} from "../src/modules/20-field-safety/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111f111a001";
const ORG_B = "22222222-2222-4222-8222-2222f222b002";

type Seed = { pe: string; location: string; member: string };

describe.skipIf(!DB_URL)("F-111 M20 SOS SLA watchdog cron — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let deps: M20WorkerDeps;
  let clock = new Date("2026-09-01T17:00:00.000Z");
  const seeded: Record<string, Seed> = {};

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

  /** Seeds the §3.2 Phase-E policy floor for an org verbatim (`SAFETY_POLICY_FLOOR` — tier SLAs
   *  60s / 120s / 300s), done here with a plain INSERT so the test controls the version id directly
   *  (mirrors `ensurePolicyVersionForConsumer`'s own floor values). */
  async function seedPolicyVersion(org: string, effectiveFrom: Date): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO safety_policy (organization_id) VALUES ($1)
         ON CONFLICT (organization_id) DO UPDATE SET organization_id = EXCLUDED.organization_id
         RETURNING id`,
      [org],
    );
    const policyId = rows[0].id as string;
    const version = await admin.query(
      `INSERT INTO safety_policy_version
         (organization_id, safety_policy_id, effective_from,
          mid_visit_cadence_minutes, mid_visit_min_visit_duration_minutes,
          pre_visit_window_minutes, post_visit_window_minutes,
          gentle_reminder_minutes, supervisor_alert_minutes, escalation_minutes, sos_equivalent_minutes,
          sos_cancel_window_seconds, sos_tier_1_sla_seconds, sos_tier_2_sla_seconds, sos_tier_3_sla_seconds)
       VALUES ($1,$2,$3,60,60,15,5,5,15,30,60,5,60,120,300)
       RETURNING id`,
      [org, policyId, effectiveFrom],
    );
    return version.rows[0].id as string;
  }

  /** A real `safety_sos_alert` row, seeded directly (not through the press route) — the M20 consumer
   *  live test's own `seedSos` shape. `historyFromState` optionally back-dates a state-history row so
   *  `stateEnteredAt` is a controlled instant rather than falling back to `posted_at`. */
  async function seedSos(input: {
    org: string;
    lifecycleState: string;
    postedAt: Date;
    policyVersionId: string;
    history?: { fromState: string | null; enteredAt: Date };
  }): Promise<string> {
    const s = seeded[input.org] as Seed;
    const acked = ["acknowledged", "resolving", "resolved"].includes(input.lifecycleState);
    const { rows } = await admin.query(
      `INSERT INTO safety_sos_alert
         (organization_id, provider_entity_id, posted_by_membership_id, posted_at,
          posted_coordinates_cipher, posted_coordinates_accuracy_m, coordinates_consent_at,
          cancel_window_expired_at, lifecycle_state, safety_policy_version_id,
          acknowledged_at, acknowledged_by_membership_id)
       VALUES ($1,$2,$3,$4,$5,10,$4,$6,$7,$8,$9,$10) RETURNING id`,
      [
        input.org,
        s.pe,
        s.member,
        input.postedAt,
        Buffer.from([0]),
        new Date(input.postedAt.getTime() + 5_000),
        input.lifecycleState,
        input.policyVersionId,
        acked ? input.postedAt : null,
        acked ? s.member : null,
      ],
    );
    const sosAlertId = rows[0].id as string;
    if (input.history) {
      await admin.query(
        `INSERT INTO safety_sos_alert_state_history
           (organization_id, provider_entity_id, sos_alert_id, from_state, to_state, transitioned_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          input.org,
          s.pe,
          sosAlertId,
          input.history.fromState,
          input.lifecycleState,
          input.history.enteredAt,
        ],
      );
    }
    return sosAlertId;
  }

  async function alertRow(sosAlertId: string) {
    const { rows } = await admin.query(
      "SELECT lifecycle_state, version FROM safety_sos_alert WHERE id=$1",
      [sosAlertId],
    );
    return rows[0] as { lifecycle_state: string; version: number };
  }

  async function historyFor(sosAlertId: string) {
    const { rows } = await admin.query(
      "SELECT from_state, to_state, transitioned_by_membership_id FROM safety_sos_alert_state_history WHERE sos_alert_id=$1 ORDER BY transitioned_at",
      [sosAlertId],
    );
    return rows as {
      from_state: string | null;
      to_state: string;
      transitioned_by_membership_id: string | null;
    }[];
  }

  async function outboxFor(sosAlertId: string) {
    const { rows } = await admin.query(
      "SELECT event_type, payload FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at",
      [sosAlertId],
    );
    return rows as { event_type: string; payload: Record<string, unknown> }[];
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
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'f111-a','A','A','active'),($2,'f111-b','B','B','active')",
      [ORG_A, ORG_B],
    );

    let n = 0;
    for (const org of [ORG_A, ORG_B]) {
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `f111-${n++}@x.test`,
        ])
      ).rows[0].id as string;
      const member = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user, org],
        )
      ).rows[0].id as string;
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [org, `CCN-F111-${org.slice(0, 4)}`, `F111 ${org.slice(0, 4)}`, `NPI-F111-${org.slice(0, 4)}`],
        )
      ).rows[0].id as string;
      const location = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [pe],
        )
      ).rows[0].id as string;
      seeded[org] = { pe, location, member };
    }

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M20_OUTBOX_EVENTS]));
    deps = {
      ...buildM20WorkerDeps({
        connection: { host: "unused", port: 0 }, // never used — this suite calls runSosSlaWatchdogCron directly, not the BullMQ Worker.
        db: handle.db,
        outbox: {
          publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m20" }),
        },
        policy: createSafetyPolicyProvider(buildDrizzleSafetySeamStore(handle.db)),
        activeOrgs: {
          listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
        },
      }),
      // Closes over the mutable `clock` variable so each test can advance time without rebuilding `deps`.
      now: () => clock,
    };
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM outbox_event");
    await admin.query("DELETE FROM safety_sos_alert_state_history");
    await admin.query("DELETE FROM safety_sos_alert");
    clock = new Date("2026-09-01T17:00:00.000Z");
  });

  it("the stale-cancel-window sweep expires a lost delayed-job alert into acknowledging", async () => {
    const postedAt = new Date("2026-09-01T16:55:00.000Z");
    const policyVersionId = await seedPolicyVersion(ORG_A, postedAt);
    const sosAlertId = await seedSos({
      org: ORG_A,
      lifecycleState: "cancel_window_open",
      postedAt,
      policyVersionId,
    });
    // cancel_window_expired_at = postedAt + 5s; the clock is already 5 minutes past that.
    await runSosSlaWatchdogCron({ ...deps, activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] } });

    expect(await alertRow(sosAlertId)).toMatchObject({ lifecycle_state: "acknowledging", version: 2 });
    const history = await historyFor(sosAlertId);
    expect(history).toEqual([
      { from_state: "cancel_window_open", to_state: "acknowledging", transitioned_by_membership_id: null },
    ]);
  });

  it("an alert overdue on its tier-1 SLA escalates to escalation_tier_1", async () => {
    const postedAt = new Date("2026-09-01T16:58:00.000Z");
    const policyVersionId = await seedPolicyVersion(ORG_A, postedAt);
    const sosAlertId = await seedSos({
      org: ORG_A,
      lifecycleState: "acknowledging",
      postedAt,
      policyVersionId,
    });
    // stateEnteredAt falls back to posted_at (no history row); tier-1 SLA is 60s and clock is 17:00 —
    // 120s past posting, well past the SLA.
    await runSosSlaWatchdogCron(deps);

    expect(await alertRow(sosAlertId)).toMatchObject({
      lifecycle_state: "escalation_tier_1",
      version: 2,
    });
    const history = await historyFor(sosAlertId);
    expect(history).toEqual([
      {
        from_state: "acknowledging",
        to_state: "escalation_tier_1",
        transitioned_by_membership_id: null,
      },
    ]);
    const outbox = await outboxFor(sosAlertId);
    expect(outbox.map((r) => r.event_type)).toEqual(["m20.safety.sos_alert_escalated"]);
    expect(outbox[0]?.payload).toMatchObject({
      fromTier: "acknowledging",
      toTier: "escalation_tier_1",
      reasonCode: "sla_breach",
    });
  });

  it("escalation_tier_2 overdue on its SLA escalates to escalation_tier_3", async () => {
    const postedAt = new Date("2026-09-01T16:00:00.000Z");
    const policyVersionId = await seedPolicyVersion(ORG_A, postedAt);
    // `sosTierDwellSeconds`: the dwell for `escalation_tier_2` is `sosTier3SlaSeconds` (300s) — the SAME
    // knob that governs tier-3/terminus, per `sos-escalator.ts`'s own header note 1 (no tier-4 knob
    // exists). 360s before the clock, safely past it.
    const enteredTier2At = new Date("2026-09-01T16:54:00.000Z");
    const sosAlertId = await seedSos({
      org: ORG_A,
      lifecycleState: "escalation_tier_2",
      postedAt,
      policyVersionId,
      history: { fromState: "escalation_tier_1", enteredAt: enteredTier2At },
    });
    await runSosSlaWatchdogCron(deps);

    expect(await alertRow(sosAlertId)).toMatchObject({
      lifecycle_state: "escalation_tier_3",
      version: 2,
    });
  });

  it("escalation_tier_3 overdue on its SLA does NOT enter emergency_terminus — refused, not completed", async () => {
    const postedAt = new Date("2026-09-01T16:00:00.000Z");
    const policyVersionId = await seedPolicyVersion(ORG_A, postedAt);
    const enteredTier3At = new Date("2026-09-01T16:50:00.000Z"); // 600s before the clock; tier-3 SLA 300s
    const sosAlertId = await seedSos({
      org: ORG_A,
      lifecycleState: "escalation_tier_3",
      postedAt,
      policyVersionId,
      history: { fromState: "escalation_tier_2", enteredAt: enteredTier3At },
    });
    await runSosSlaWatchdogCron(deps);

    // Unchanged: no caller in this codebase implements the terminus's dial/PSAP/page effects, so the
    // watchdog refuses the rung rather than writing a record that says the life-safety chain reached its
    // mandated end when nothing dialed anyone (see jobs/cron-workers.ts's header).
    expect(await alertRow(sosAlertId)).toMatchObject({
      lifecycle_state: "escalation_tier_3",
      version: 1,
    });
    // Exactly the ONE seeded history row (entering tier_3) — no new row from this tick.
    expect(await historyFor(sosAlertId)).toHaveLength(1);
    expect(await outboxFor(sosAlertId)).toEqual([]);
  });

  it("an alert already in emergency_terminus (a future manual-escalate path) gets re-paged on its loop", async () => {
    const postedAt = new Date("2026-09-01T16:00:00.000Z");
    const policyVersionId = await seedPolicyVersion(ORG_A, postedAt);
    const terminusEnteredAt = new Date("2026-09-01T16:50:00.000Z"); // 600s before the clock; loop = tier-3 SLA (300s)
    const sosAlertId = await seedSos({
      org: ORG_A,
      lifecycleState: "emergency_terminus",
      postedAt,
      policyVersionId,
      history: { fromState: "escalation_tier_3", enteredAt: terminusEnteredAt },
    });
    await runSosSlaWatchdogCron(deps);

    // No transition (repage is not a state change) and no NEW history row beyond the one seeded entering
    // the terminus (`m20_ssash_no_self` would refuse a from===to row) — only the outbox/alert re-page
    // effects fire.
    expect(await alertRow(sosAlertId)).toMatchObject({
      lifecycle_state: "emergency_terminus",
      version: 1,
    });
    expect(await historyFor(sosAlertId)).toHaveLength(1);
    const outbox = await outboxFor(sosAlertId);
    expect(outbox.map((r) => r.event_type)).toEqual(["m20.safety.sos_terminus_reached"]);
    // 600s elapsed / 300s loop period = the SECOND re-page (iteration 0 was the terminus entry itself,
    // per `terminusLoopIteration`'s own doc comment).
    expect(outbox[0]?.payload).toMatchObject({
      loopIteration: 2,
      emergencyContactCallInitiated: false,
      psapJurisdictionId: null,
      wardenxOpsPaged: false,
    });
  });

  it("two concurrent ticks racing the same overdue alert escalate it exactly once", async () => {
    const postedAt = new Date("2026-09-01T16:58:00.000Z");
    const policyVersionId = await seedPolicyVersion(ORG_A, postedAt);
    const sosAlertId = await seedSos({
      org: ORG_A,
      lifecycleState: "acknowledging",
      postedAt,
      policyVersionId,
    });
    const singleOrgDeps = { ...deps, activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] } };

    // Both ticks race the SAME row. Postgres holds the row lock across the first UPDATE until it commits,
    // so the second's `WHERE version = ?` re-evaluates against the already-advanced version and matches
    // zero rows — `processOneAlert` catches that as a lost race and returns, never throwing out of
    // `runSosSlaWatchdogCron` itself.
    await Promise.all([runSosSlaWatchdogCron(singleOrgDeps), runSosSlaWatchdogCron(singleOrgDeps)]);

    expect(await alertRow(sosAlertId)).toMatchObject({
      lifecycle_state: "escalation_tier_1",
      version: 2, // NOT 3 — only one of the two ticks won.
    });
    expect(await historyFor(sosAlertId)).toHaveLength(1);
    expect(await outboxFor(sosAlertId)).toHaveLength(1);
  });

  it("a quiet acknowledged alert is left alone — the ladder's job is done", async () => {
    const postedAt = new Date("2026-09-01T16:00:00.000Z");
    const policyVersionId = await seedPolicyVersion(ORG_A, postedAt);
    const sosAlertId = await seedSos({
      org: ORG_A,
      lifecycleState: "acknowledged",
      postedAt,
      policyVersionId,
    });
    await runSosSlaWatchdogCron(deps);
    expect(await alertRow(sosAlertId)).toMatchObject({ lifecycle_state: "acknowledged", version: 1 });
  });

  it("fans out over every active org and writes each org's alert under its own tenant scope", async () => {
    const postedAt = new Date("2026-09-01T16:58:00.000Z");
    const policyVersionIdA = await seedPolicyVersion(ORG_A, postedAt);
    const policyVersionIdB = await seedPolicyVersion(ORG_B, postedAt);
    const alertA = await seedSos({
      org: ORG_A,
      lifecycleState: "acknowledging",
      postedAt,
      policyVersionId: policyVersionIdA,
    });
    const alertB = await seedSos({
      org: ORG_B,
      lifecycleState: "acknowledging",
      postedAt,
      policyVersionId: policyVersionIdB,
    });

    await runSosSlaWatchdogCron(deps); // deps' activeOrgs already lists both ORG_A and ORG_B.

    expect(await alertRow(alertA)).toMatchObject({ lifecycle_state: "escalation_tier_1" });
    expect(await alertRow(alertB)).toMatchObject({ lifecycle_state: "escalation_tier_1" });
  });
});
