/**
 * GAP-035 / 037 / 038 / 039 / 040 / 041 — M26 cap projections, inpatient denominator, methodology lock and the
 * band-escalation alerts reaching a PERSON, LIVE Postgres as the NOBYPASSRLS `wardenx_app` role, through the
 * real catalog-validating outbox publisher, the real platform-default `alert_rule` seed and the real M36 emitter.
 *
 * Before: recompute() wrote only agency + inpatient snapshots (no per-patient band ever existed), the cron
 * published to a no-op outbox stamped `manual_recompute`, total_patient_days was never written (inpatient
 * utilisation 0% forever), a methodology-less period promoted to `active` could never lock its methodology, no
 * consumer turned `m26.cap.threshold_crossed` into an alert, and the NOE/NOTR window alerts had no `alert_rule`.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m26:projections-alerts:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildM26AbacPredicates } from "../src/modules/26-cap/abac-predicates";
import { createDrizzleCapConsumerStore } from "../src/modules/26-cap/consumers/drizzle-store";
import { M26_OUTBOX_EVENTS } from "../src/modules/26-cap/index";
import { buildStores } from "../src/modules/26-cap/jobs/index";
import { buildDrizzleM26ReadService } from "../src/modules/26-cap/routes/read-service-drizzle";
import { buildDrizzleM26WriteService } from "../src/modules/26-cap/routes/write-service-drizzle";
import { buildM26SeamImpls } from "../src/modules/26-cap/seam-impls";
import {
  createDrizzleAlertEmitter,
  registerMessagingSeams,
  wireAlertRuleSeed,
} from "../src/modules/36-messaging/index";
import { buildM36CapThresholdAlertConsumer } from "../src/modules/36-messaging/outbox-consumers/cap-threshold-alerts";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG = "11111111-aaaa-4aaa-8aaa-111111111111";
const ORG_B = "22222222-aaaa-4aaa-8aaa-222222222222";
const ORG_C = "44444444-aaaa-4aaa-8aaa-444444444444"; // no cap.event.read holder at all: only an org_admin
const USER = "33333333-aaaa-4aaa-8aaa-333333333333";
const CAP_YEAR = "FY2026"; // wholly in the past, so the run-rate extrapolation factor is exactly 1
const CAP_CENTS = 3_536_144; // the migration-0393 FY2026 per-beneficiary cap
const PAT_HIGH = "aaaaaaaa-0000-4000-8000-0000000000a1"; // 96% of the cap -> warn_95
const PAT_LOW = "aaaaaaaa-0000-4000-8000-0000000000a2"; // 10% -> safe
const PAT_DEAD = "aaaaaaaa-0000-4000-8000-0000000000a3"; // deceased, 91% -> watch_90, frozen
const PAT_NONE = "aaaaaaaa-0000-4000-8000-0000000000a9"; // never accrued

describe.skipIf(!DB_URL)("M26 projections + alerts - LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const user: Record<string, string> = {};
  let periodId = "";

  const outbox = buildTxOutboxPublisher(buildBootOutboxCatalog([M26_OUTBOX_EVENTS]));
  const m26Outbox = {
    publish: (
      tx: unknown,
      input: Parameters<typeof outbox.publish>[1] extends infer I ? Omit<I, "callerModule"> : never,
    ) =>
      outbox.publish(tx as Parameters<typeof outbox.publish>[0], { ...input, callerModule: "m26" }),
  };
  const actor = { organizationId: ORG, userId: USER, roles: [], stepUpRecent: true };
  const write = () => buildDrizzleM26WriteService(handle.db, m26Outbox);
  const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
  }
  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }
  async function addMember(orgId: string, tag: string, roleKey: string): Promise<string> {
    const roleId = (
      await admin.query(
        "INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,$2,'billing_finance') RETURNING id",
        [orgId, roleKey],
      )
    ).rows[0].id as string;
    const userId = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [`${tag}@m26.test`])
    ).rows[0].id as string;
    const membershipId = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [userId, orgId],
      )
    ).rows[0].id as string;
    await admin.query(
      "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
      [orgId, membershipId, roleId],
    );
    return userId;
  }
  /**
   * GAP-040 - a member whose role grants exactly `permissionKeys` through `role_permission`. `expired` stamps the
   * grant's `expires_at` in the past, `enabled: false` disables the role: both must confer nothing.
   */
  async function addHolder(
    orgId: string,
    tag: string,
    permissionKeys: readonly string[],
    opts: { expired?: boolean; enabled?: boolean } = {},
  ): Promise<string> {
    const roleId = (
      await admin.query(
        "INSERT INTO role (organization_id, key, name, category, enabled) VALUES ($1,$2,$2,'billing_finance',$3) RETURNING id",
        [orgId, `holder_${tag}`, opts.enabled ?? true],
      )
    ).rows[0].id as string;
    for (const key of permissionKeys)
      await admin.query(
        "INSERT INTO role_permission (organization_id, role_id, permission_key) VALUES ($1,$2,$3)",
        [orgId, roleId, key],
      );
    const userId = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [`${tag}@m26.test`])
    ).rows[0].id as string;
    const membershipId = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [userId, orgId],
      )
    ).rows[0].id as string;
    await admin.query(
      "INSERT INTO membership_role (organization_id, membership_id, role_id, expires_at) VALUES ($1,$2,$3,$4)",
      [orgId, membershipId, roleId, opts.expired ? new Date(Date.now() - 86_400_000) : null],
    );
    return userId;
  }
  async function seedAccrual(patient: string, paid: number, deceasedAt: string | null = null) {
    await admin.query(
      `INSERT INTO cap_beneficiary_accrual (organization_id, cap_period_id, patient_id, mbi_normalized,
         paid_cents, first_election_in_period, deceased_at) VALUES ($1,$2,$3,$4,$5,'2025-10-01',$6)`,
      [ORG, periodId, patient, `MBI${patient.slice(-2)}`, paid, deceasedAt],
    );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    for (const [id, slug] of [
      [ORG, "m26-proj-a"],
      [ORG_B, "m26-proj-b"],
      [ORG_C, "m26-proj-c"],
    ] as const)
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'actor@m26.test')`, [USER]);
    user.cfo = await addMember(ORG, "cfo", "cfo");
    user.biller = await addMember(ORG, "biller", "biller"); // bystander: holds no cap/billing-manager role
    user.billingManager = await addMember(ORG, "bm", "billing_manager");
    user.otherCfo = await addMember(ORG_B, "ocfo", "cfo");
    // GAP-040 - the cap audience is whoever HOLDS cap.event.read, through any role, in THIS tenant, live.
    user.holder = await addHolder(ORG, "holder", ["cap.event.read"]);
    user.holderOnlyBilling = await addHolder(ORG, "billingonly", ["billing.claim.read"]);
    user.holderExpired = await addHolder(ORG, "expired", ["cap.event.read"], { expired: true });
    user.holderRoleDisabled = await addHolder(ORG, "disabled", ["cap.event.read"], {
      enabled: false,
    });
    user.otherTenantHolder = await addHolder(ORG_B, "otherholder", ["cap.event.read"]);
    user.compliance = await addMember(ORG, "co", "compliance_officer");
    user.orgAdminC = await addMember(ORG_C, "adminc", "org_admin");

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    registerMessagingSeams({ emitter: createDrizzleAlertEmitter(handle.db) });
    await wireAlertRuleSeed(handle.db);
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  // ── GAP-039 ───────────────────────────────────────────────────────────────────────────────────
  it("a period opened with no methodology can still lock it after the first projection promoted it to active", async () => {
    const opened = await write().openPeriod(actor, { capYear: CAP_YEAR });
    periodId = opened.id;
    expect(opened.methodology).toBeNull();
    await seedAccrual(PAT_HIGH, Math.round(CAP_CENTS * 0.96));
    await seedAccrual(PAT_LOW, Math.round(CAP_CENTS * 0.1));
    await seedAccrual(PAT_DEAD, Math.round(CAP_CENTS * 0.91), "2026-01-15");

    await write().recompute(actor, periodId);
    expect((await q("SELECT status FROM cap_period WHERE id=$1", [periodId]))[0].status).toBe(
      "active",
    );

    const predicates = buildM26AbacPredicates({ db: handle.db });
    const ctx = { organizationId: ORG, userId: USER, roles: [], attributes: {} } as never;
    expect(
      await predicates.cap_period_methodology_unlocked?.(ctx, { capPeriodId: periodId } as never),
    ).toBe(true);
    const locked = await write().lockMethodology(actor, periodId, {
      methodology: "streamlined",
      reason: "GAP-039 live proof",
    });
    expect(locked.methodology).toBe("streamlined");
    expect(
      await predicates.cap_period_methodology_unlocked?.(ctx, { capPeriodId: periodId } as never),
    ).toBe(false);
  });

  // ── GAP-037 ───────────────────────────────────────────────────────────────────────────────────
  it("writes a patient_aggregate snapshot per accrual row with the right band and the death freeze", async () => {
    const rows = await q(
      `SELECT DISTINCT ON (patient_id) patient_id, alert_band, cap_amount_cents, paid_ytd_cents,
              projected_year_end_cents FROM cap_projection_snapshot
        WHERE cap_period_id=$1 AND scope='patient_aggregate' ORDER BY patient_id, computed_at DESC`,
      [periodId],
    );
    const byPatient = new Map(rows.map((r) => [r.patient_id as string, r]));
    expect(byPatient.get(PAT_HIGH)?.alert_band).toBe("warn_95");
    expect(byPatient.get(PAT_LOW)?.alert_band).toBe("safe");
    expect(byPatient.get(PAT_DEAD)?.alert_band).toBe("watch_90");
    expect(Number(byPatient.get(PAT_HIGH)?.cap_amount_cents)).toBe(CAP_CENTS);
    // frozen at death: no extrapolation beyond what was paid
    const dead = byPatient.get(PAT_DEAD);
    expect(Number(dead?.projected_year_end_cents)).toBe(Number(dead?.paid_ytd_cents));
  });

  it("raises a cap_threshold_event + m26.cap.threshold_crossed for each escalated PATIENT only", async () => {
    const events = await q(
      `SELECT patient_id, prior_band, current_band FROM cap_threshold_event
        WHERE cap_period_id=$1 AND scope='patient_aggregate' ORDER BY patient_id`,
      [periodId],
    );
    expect(events.map((e) => [e.patient_id, e.prior_band, e.current_band])).toEqual([
      [PAT_HIGH, "safe", "warn_95"],
      [PAT_DEAD, "safe", "watch_90"],
    ]);
    const published = await q(
      `SELECT payload FROM outbox_event WHERE event_type='m26.cap.threshold_crossed'
          AND payload->>'scope'='patient_aggregate'`,
    );
    expect(published).toHaveLength(2);
    expect(published.find((p) => p.payload.patientId === PAT_HIGH)?.payload).toMatchObject({
      bandTo: "warn_95",
      capYear: CAP_YEAR,
      capAmountCents: CAP_CENTS,
    });
  });

  it("the patient projection seam returns the snapshot, and null (not a fabricated safe view) with none", async () => {
    const seams = buildM26SeamImpls(handle.db, buildDrizzleM26ReadService(handle.db));
    const high = await seams.projection.getPatientProjection(ORG, periodId, PAT_HIGH);
    expect(high?.band).toBeDefined();
    expect(high?.patientId).toBe(PAT_HIGH);
    expect(await seams.projection.getPatientProjection(ORG, periodId, PAT_NONE)).toBeNull();
  });

  // ── GAP-041 ───────────────────────────────────────────────────────────────────────────────────
  it("the NIGHTLY cron publishes through the real outbox and stamps the snapshot nightly_batch", async () => {
    await admin.query("UPDATE cap_beneficiary_accrual SET paid_cents=$1 WHERE patient_id=$2", [
      Math.round(CAP_CENTS * 1.02),
      PAT_HIGH,
    ]);
    const before = (
      await q(
        "SELECT count(*)::int n FROM outbox_event WHERE event_type='m26.cap.projection_updated'",
      )
    )[0].n as number;
    await buildStores(handle.db, m26Outbox).projection.recompute(ORG, periodId);

    const after = (
      await q(
        "SELECT count(*)::int n FROM outbox_event WHERE event_type='m26.cap.projection_updated'",
      )
    )[0].n as number;
    expect(after).toBeGreaterThan(before);
    const stamped = await q(
      `SELECT DISTINCT computed_by FROM cap_projection_snapshot
        WHERE cap_period_id=$1 ORDER BY computed_by`,
      [periodId],
    );
    expect(stamped.map((r) => r.computed_by)).toContain("nightly_batch");
    const crossed = await q(
      `SELECT payload FROM outbox_event WHERE event_type='m26.cap.threshold_crossed'
          AND payload->>'patientId'=$1 AND payload->>'bandTo'='breach_100'`,
      [PAT_HIGH],
    );
    expect(crossed).toHaveLength(1);
  });

  // ── GAP-040 ───────────────────────────────────────────────────────────────────────────────────
  it("a breach notifies the cap.event.read holders and the compliance escalation, and nobody else", async () => {
    const emitter = createDrizzleAlertEmitter(handle.db);
    const consumer = buildM36CapThresholdAlertConsumer(emitter);
    const rows = await q(
      `SELECT id, organization_id, event_type, aggregate_kind, aggregate_id, payload, created_at
         FROM outbox_event WHERE event_type='m26.cap.threshold_crossed'
          AND payload->>'patientId'=$1 AND payload->>'bandTo'='breach_100'`,
      [PAT_HIGH],
    );
    const row = rows[0];
    const event = {
      id: row.id as string,
      organizationId: row.organization_id as string,
      eventType: row.event_type as string,
      aggregateKind: row.aggregate_kind as string,
      aggregateId: row.aggregate_id as string,
      payload: row.payload,
      attemptCount: 0,
      createdAt: row.created_at as Date,
    };
    await consumer.handle(event);
    await consumer.handle(event); // redelivery: same correlation id, still one alert

    const alerts = await q(
      "SELECT id, event_type, severity FROM alert WHERE event_type='m26.cap.patient_breach_100'",
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");
    const recipients = (
      await q("SELECT DISTINCT recipient_user_id FROM notification_delivery WHERE alert_id=$1", [
        alerts[0].id,
      ])
    )
      .map((r) => r.recipient_user_id as string)
      .sort();
    // the holder (a custom role that grants cap.event.read) + the breach's compliance_officer tier. NOT the old
    // hand-made cfo / billing_manager role keys, NOT a member holding only billing.*, NOT an expired grant, NOT a
    // disabled role, NOT another tenant's holder, NOT a bystander.
    expect(recipients).toEqual([user.holder, user.compliance].sort());
    for (const excluded of [
      user.cfo,
      user.billingManager,
      user.holderOnlyBilling,
      user.holderExpired,
      user.holderRoleDisabled,
      user.otherTenantHolder,
      user.otherCfo,
      user.biller,
    ])
      expect(recipients).not.toContain(excluded);
  });

  it("a watch band reaches ONLY the holders, and a tenant with no holder falls back to its org administrators", async () => {
    const emitter = createDrizzleAlertEmitter(handle.db);
    const watch = await emitter.emit(ORG, {
      eventType: "m26.cap.patient_watch_90",
      severity: "warn",
      correlationId: "gap-040:watch:org-a",
      payload: {},
    });
    const watchRecipients = (
      await q("SELECT DISTINCT recipient_user_id FROM notification_delivery WHERE alert_id=$1", [
        watch.alertId,
      ])
    ).map((r) => r.recipient_user_id as string);
    expect(watchRecipients).toEqual([user.holder]); // no compliance tier below a breach

    const floor = await emitter.emit(ORG_C, {
      eventType: "m26.cap.patient_watch_90",
      severity: "warn",
      correlationId: "gap-040:watch:org-c",
      payload: {},
    });
    expect(floor.resolvedRecipientCount).toBe(1);
    const floorRecipients = (
      await q("SELECT DISTINCT recipient_user_id FROM notification_delivery WHERE alert_id=$1", [
        floor.alertId,
      ])
    ).map((r) => r.recipient_user_id as string);
    expect(floorRecipients).toEqual([user.orgAdminC]);
  });

  // ── GAP-035 ───────────────────────────────────────────────────────────────────────────────────
  it("a cron alert code (NOE window breached) now resolves recipients instead of persisting with none", async () => {
    const emitter = createDrizzleAlertEmitter(handle.db);
    const res = await emitter.emit(ORG, {
      eventType: "m23.noe.window_breached",
      severity: "critical",
      correlationId: "m23-cron:m23.noe.window_breached:noe-1:2026-10-08",
      payload: { noeId: "noe-1", admissionId: "adm-1" },
    });
    expect(res.resolvedRecipientCount).toBe(2); // the billing_manager + the compliance_officer (no org_admin seeded)
    const { rows } = await admin.query(
      "SELECT recipient_user_id FROM notification_delivery WHERE alert_id=$1",
      [res.alertId],
    );
    expect(rows.map((r) => r.recipient_user_id as string).sort()).toEqual(
      [user.billingManager, user.compliance].sort(),
    );
  });

  // ── GAP-038 ───────────────────────────────────────────────────────────────────────────────────
  it("level-of-care days feed the denominator so inpatient utilisation and the settlement overage are real", async () => {
    const store = createDrizzleCapConsumerStore(handle.db, {
      outbox: m26Outbox,
      // the day-line path never reads the MBI / first-election facts (accrual lines only)
      mbi: { mbiNormalizedForPatient: async () => null },
      firstElection: { firstElectionEffectiveDateInRange: async () => null },
    });
    const day = (n: number, revCode: "0651" | "0655" | "0656", days: number) => ({
      organizationId: ORG,
      claimId: "dddddddd-0000-4000-8000-0000000000c1",
      patientId: PAT_HIGH,
      sourceId: `dddddddd-0000-4000-8000-00000000000${n}`,
      revCode,
      days,
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-30",
      postedAt: "2026-04-01T00:00:00.000Z",
    });
    await store.recordInpatientDay(day(1, "0651", 70)); // routine
    await store.recordInpatientDay(day(2, "0656", 20)); // GIP
    await store.recordInpatientDay(day(3, "0655", 10)); // IRC -> 30 inpatient / 100 total = 30%

    const acc = (
      await q(
        "SELECT gip_days, irc_days, total_patient_days FROM cap_inpatient_accrual WHERE cap_period_id=$1",
        [periodId],
      )
    )[0];
    expect(acc).toEqual({ gip_days: 20, irc_days: 10, total_patient_days: 100 });

    await write().recompute(actor, periodId);
    const inp = (
      await q(
        `SELECT pct_of_cap, alert_band FROM cap_projection_snapshot
          WHERE cap_period_id=$1 AND scope='inpatient' ORDER BY computed_at DESC LIMIT 1`,
        [periodId],
      )
    )[0];
    expect(Number(inp.pct_of_cap)).toBeCloseTo(0.3, 4);
    expect(inp.alert_band).toBe("inpatient_breach_20");

    const seams = buildM26SeamImpls(handle.db, buildDrizzleM26ReadService(handle.db));
    const view = await seams.inpatient.getInpatientProjection(ORG, periodId);
    expect(view).toMatchObject({ inpatientDayCount: 30, totalDayCount: 100 });

    // settlement: allowed = floor(0.2 * 100) = 20 inpatient days -> 10 overage days (not all 30)
    await write().closePeriod(actor, periodId);
    const settlement = await write().proposeSettlement(actor, periodId);
    expect(settlement.inpatientTotalDays).toBe(30);
    expect(settlement.inpatientOverageDays).toBe(10);
    // methodology was locked in the first test, so the in_settlement period could be proposed at all (GAP-039)
    expect(settlement.status).toBe("proposed");
  });
});
