/**
 * F-188 (#248) — M29's outbound operator alerts, proven to reach a PERSON on the real M36 emitter over real Postgres
 * (the real NOBYPASSRLS `wardenx_app` role, the real platform-default `alert_rule` seed, the real `alert` /
 * `notification_delivery` persistence).
 *
 * Before F-188 three independent defects meant no outbound alert ever notified anyone, each proven live on this same
 * chain: (1) every emit THREW at the `alert` INSERT — M29's `HIGH`/`NORMAL` are not `alert_severity` values — and the
 * worker swallows alert failures; (2) with a valid severity the three kinds still resolved ZERO recipients, because no
 * platform-default `alert_rule` existed; (3) `alert` is unique on `(organization_id, correlation_id)` and the old id
 * `m29-outbound:<kind>:<feedId>` never changed, so only the first alert per kind per feed could ever notify.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m29-alert-routing.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OUTBOUND_ALERT_WINDOW_MS,
  buildOutboundAlertEmit,
  emitOutboundAlert,
} from "../src/modules/29-external-interfaces/outbound/alert-routing";
import {
  OUTBOUND_ALERT_KINDS,
  type OutboundAlert,
} from "../src/modules/29-external-interfaces/outbound/outbound-events";
import {
  createDrizzleAlertEmitter,
  registerMessagingSeams,
  wireAlertRuleSeed,
} from "../src/modules/36-messaging/index";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "99999999-9999-9999-9999-999999999999";
const ORG_B = "88888888-8888-8888-8888-888888888888";
const FEED = "11111111-1111-1111-1111-111111111111";
const T0 = new Date("2026-05-01T10:00:00Z");

const intent = (
  kind: OutboundAlert["kind"],
  severity: OutboundAlert["severity"] = "HIGH",
): OutboundAlert => ({
  kind,
  severity,
  channel: kind === "hl7_outbound.transmission_failed" ? "operator-on-call" : "compliance",
  feedId: FEED,
  detail: "PHI-free operator summary",
});

describe.skipIf(!DB_URL)("F-188 — M29 outbound alerts reach a person, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let emitter: ReturnType<typeof createDrizzleAlertEmitter>;
  const user: Record<string, string> = {};

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
  async function addMember(
    orgId: string,
    tag: string,
    roleKey: string,
    category: string,
  ): Promise<string> {
    const roleId = (
      await admin.query(
        "INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,$2,$3) RETURNING id",
        [orgId, roleKey, category],
      )
    ).rows[0].id as string;
    const userId = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [`${tag}@f186.test`])
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
  /** Emit exactly what the worker emits for `alert` at `now`, on the real emitter. */
  const emit = (orgId: string, alert: OutboundAlert, now: Date) =>
    emitter.emit(orgId, buildOutboundAlertEmit(alert, now));
  const recipientsOf = async (alertId: string): Promise<string[]> =>
    (
      await admin.query(
        "SELECT DISTINCT recipient_user_id FROM notification_delivery WHERE alert_id=$1",
        [alertId],
      )
    ).rows
      .map((r) => r.recipient_user_id as string)
      .sort();

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    for (const [id, slug] of [
      [ORG_A, "org-f186-a"],
      [ORG_B, "org-f186-b"],
    ] as const)
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    user.orgAdmin = await addMember(ORG_A, "a-admin", "org_admin", "admin_executive");
    user.compliance = await addMember(
      ORG_A,
      "a-compliance",
      "compliance_officer",
      "compliance_quality",
    );
    user.clinicalLead = await addMember(ORG_A, "a-lead", "clinical_lead", "clinical_leadership");
    user.bystander = await addMember(ORG_A, "a-biller", "biller", "billing_finance");
    user.otherTenantAdmin = await addMember(ORG_B, "b-admin", "org_admin", "admin_executive");

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    emitter = createDrizzleAlertEmitter(handle.db);
    registerMessagingSeams({ emitter });
    await wireAlertRuleSeed(handle.db);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("the boot seed carries a platform-default rule for EVERY outbound alert kind", async () => {
    const { rows } = await admin.query(
      "SELECT event_type FROM alert_rule WHERE organization_id IS NULL AND enabled AND event_type = ANY($1)",
      [[...OUTBOUND_ALERT_KINDS]],
    );
    expect(rows.map((r) => r.event_type as string).sort()).toEqual(
      [...OUTBOUND_ALERT_KINDS].sort(),
    );
  });

  it("a failed transmission notifies the operator (org_admin) and the M11 owners — and nobody else", async () => {
    for (const severity of ["HIGH", "NORMAL"] as const) {
      const res = await emit(
        ORG_A,
        intent("hl7_outbound.transmission_failed", severity),
        new Date(T0.getTime() + (severity === "HIGH" ? 0 : 7 * 86_400_000)),
      );
      expect(res.resolvedRecipientCount).toBe(2);
      expect(await recipientsOf(res.alertId)).toEqual([user.orgAdmin, user.clinicalLead].sort());
      const { rows } = await admin.query("SELECT severity FROM alert WHERE id=$1", [res.alertId]);
      expect(rows[0].severity).toBe(severity === "HIGH" ? "critical" : "warn");
    }
  });

  it.each(["external_feed.baa_expired", "external_feed.baa_missing"] as const)(
    "%s notifies the compliance officer with org_admin as the backstop — and nobody else",
    async (kind) => {
      const res = await emit(ORG_A, intent(kind), T0);
      expect(res.resolvedRecipientCount).toBe(2);
      expect(await recipientsOf(res.alertId)).toEqual([user.compliance, user.orgAdmin].sort());
      const { rows } = await admin.query("SELECT severity FROM alert WHERE id=$1", [res.alertId]);
      expect(rows[0].severity).toBe("critical");
    },
  );

  it("never reaches a bystander in the same tenant or an admin of another tenant", async () => {
    const { rows } = await admin.query(
      `SELECT DISTINCT nd.recipient_user_id FROM notification_delivery nd JOIN alert a ON a.id = nd.alert_id
        WHERE a.event_type = ANY($1)`,
      [[...OUTBOUND_ALERT_KINDS]],
    );
    const reached = rows.map((r) => r.recipient_user_id as string);
    expect(reached).not.toContain(user.bystander);
    expect(reached).not.toContain(user.otherTenantAdmin);
    expect(reached.length).toBeGreaterThan(0);
  });

  it("a tenant's alert resolves only that tenant's people (ORG_B gets its own admin, not ORG_A's)", async () => {
    const res = await emit(ORG_B, intent("hl7_outbound.transmission_failed"), T0);
    expect(await recipientsOf(res.alertId)).toEqual([user.otherTenantAdmin]);
    const { rows } = await admin.query("SELECT organization_id FROM alert WHERE id=$1", [
      res.alertId,
    ]);
    expect(rows[0].organization_id).toBe(ORG_B);
  });

  it("THROTTLE: a retry storm inside one window pages once; the same still-true condition pages again next window", async () => {
    const kind = "hl7_outbound.transmission_failed" as const;
    const base = new Date("2026-06-01T03:00:00Z");
    const first = await emit(ORG_A, intent(kind), base);
    const storm = await emit(ORG_A, intent(kind), new Date(base.getTime() + 20 * 60_000));
    expect(storm.alertId).toBe(first.alertId); // absorbed: same window, same (kind, feed)
    const deliveriesAfterStorm = (
      await admin.query("SELECT count(*)::int n FROM notification_delivery WHERE alert_id=$1", [
        first.alertId,
      ])
    ).rows[0].n as number;
    expect(deliveriesAfterStorm).toBe(2); // one page (org_admin + clinical_lead), not one per retry

    const nextWindow = await emit(
      ORG_A,
      intent(kind),
      new Date(base.getTime() + OUTBOUND_ALERT_WINDOW_MS[kind]),
    );
    expect(nextWindow.alertId).not.toBe(first.alertId);
    expect(nextWindow.resolvedRecipientCount).toBe(2); // the pre-F-188 permanent id would have swallowed this forever
    expect(await recipientsOf(nextWindow.alertId)).toEqual(
      [user.orgAdmin, user.clinicalLead].sort(),
    );
  });

  it("the payload that reaches M36 carries ids and a summary only — no PHI fields", async () => {
    const res = await emit(
      ORG_A,
      intent("external_feed.baa_missing"),
      new Date("2026-07-01T00:00:00Z"),
    );
    const { rows } = await admin.query("SELECT payload FROM alert WHERE id=$1", [res.alertId]);
    expect(Object.keys(rows[0].payload as object).sort()).toEqual(["detail", "feedId"]);
  });

  // ── F-199 — STORMS: what an operator sees during an outage, on the REAL emitter as the real NOBYPASSRLS role ──────
  // BEFORE F-199 (proved below as the un-counted case): a repeat inside the window is absorbed and changes NOTHING on
  // the alert — the 2nd..200th failure is invisible, so "one flaky message" and "the lab is down" look identical.
  const KIND = "hl7_outbound.transmission_failed" as const;
  const STORM_KIND = "hl7_outbound.transmission_storm";
  const feedIn = (n: number) => `4${n.toString().padStart(7, "0")}-0000-4000-8000-000000000000`;
  /** Drive exactly what the worker's `emitAlert` drives: the counted alert + the escalation at the threshold. */
  const one = (orgId: string, feedId: string, at: Date, threshold: number) =>
    emitOutboundAlert(emitter, orgId, { ...intent(KIND), feedId }, at, threshold);
  /** The first failure lands ALONE (so the rest hit the ordinary "alert exists" path), the rest arrive together. */
  const storm = async (orgId: string, feedId: string, at: Date, n: number, threshold = 10) => {
    await one(orgId, feedId, at, threshold);
    await Promise.all(Array.from({ length: n - 1 }, () => one(orgId, feedId, at, threshold)));
  };
  /** Every emit in flight at once from a cold start — the first-insert RACE path as well as the counter. */
  const stormAllAtOnce = (orgId: string, feedId: string, at: Date, n: number, threshold = 10) =>
    Promise.all(Array.from({ length: n }, () => one(orgId, feedId, at, threshold)));
  const alertsOf = async (orgId: string, eventType: string, feedId: string) =>
    (
      await admin.query(
        "SELECT id, severity, payload FROM alert WHERE organization_id=$1 AND event_type=$2 AND payload->>'feedId'=$3 ORDER BY created_at",
        [orgId, eventType, feedId],
      )
    ).rows as Array<{ id: string; severity: string; payload: Record<string, unknown> }>;
  const deliveriesOf = async (alertId: string) =>
    (
      await admin.query("SELECT count(*)::int n FROM notification_delivery WHERE alert_id=$1", [
        alertId,
      ])
    ).rows[0].n as number;

  it("F-199 baseline: WITHOUT countRepeats a repeat is silently absorbed — the alert never changes (unchanged for every other producer)", async () => {
    const feed = feedIn(1);
    const at = new Date("2026-08-01T03:00:00Z");
    const a = await emitter.emit(
      ORG_A,
      buildOutboundAlertEmit({ ...intent(KIND), feedId: feed }, at),
    );
    for (let i = 0; i < 50; i++)
      await emitter.emit(ORG_A, buildOutboundAlertEmit({ ...intent(KIND), feedId: feed }, at));
    const rows = await alertsOf(ORG_A, KIND, feed);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(a.alertId);
    expect(rows[0]!.payload).not.toHaveProperty("occurrences");
    expect(await deliveriesOf(a.alertId)).toBe(2);
  });

  it("F-199: the first failure pages immediately and exactly the intended people; the count starts at 1", async () => {
    const feed = feedIn(2);
    await storm(ORG_A, feed, new Date("2026-08-02T03:00:00Z"), 1);
    const [row, ...rest] = await alertsOf(ORG_A, KIND, feed);
    expect(rest).toHaveLength(0);
    expect(row!.payload.occurrences).toBe(1);
    expect(await recipientsOf(row!.id)).toEqual([user.orgAdmin, user.clinicalLead].sort());
    expect(await alertsOf(ORG_A, STORM_KIND, feed)).toHaveLength(0); // no escalation for one failure
  });

  it("F-199: a storm of 25 pages ONCE, counts all 25, and escalates EXACTLY ONCE (critical, org_admin + clinical_lead)", async () => {
    const feed = feedIn(3);
    await storm(ORG_A, feed, new Date("2026-08-03T03:00:00Z"), 25);
    const failures = await alertsOf(ORG_A, KIND, feed);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.payload.occurrences).toBe(25);
    expect(await deliveriesOf(failures[0]!.id)).toBe(2); // 25 failures, still ONE page

    const escalations = await alertsOf(ORG_A, STORM_KIND, feed);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.severity).toBe("critical");
    expect(escalations[0]!.payload).toMatchObject({
      feedId: feed,
      occurrences: 10,
      windowMinutes: 60,
    });
    expect(await recipientsOf(escalations[0]!.id)).toEqual(
      [user.orgAdmin, user.clinicalLead].sort(),
    );
  });

  it("F-199: below the threshold there is a count but no escalation", async () => {
    const feed = feedIn(4);
    await storm(ORG_A, feed, new Date("2026-08-04T03:00:00Z"), 9);
    expect((await alertsOf(ORG_A, KIND, feed))[0]!.payload.occurrences).toBe(9);
    expect(await alertsOf(ORG_A, STORM_KIND, feed)).toHaveLength(0);
  });

  it("F-199: CONCURRENT repeats are counted exactly (no lost update) and still escalate exactly once", async () => {
    const feed = feedIn(5);
    await stormAllAtOnce(ORG_A, feed, new Date("2026-08-05T03:00:00Z"), 60); // all 60 in flight from a cold start
    expect((await alertsOf(ORG_A, KIND, feed))[0]!.payload.occurrences).toBe(60);
    expect(await alertsOf(ORG_A, STORM_KIND, feed)).toHaveLength(1);
  });

  it("F-199: the next window pages AGAIN with a fresh count, and can escalate again", async () => {
    const feed = feedIn(6);
    const w1 = new Date("2026-08-06T03:00:00Z");
    const w2 = new Date(w1.getTime() + OUTBOUND_ALERT_WINDOW_MS[KIND]);
    await storm(ORG_A, feed, w1, 12);
    await storm(ORG_A, feed, w2, 11);
    const failures = await alertsOf(ORG_A, KIND, feed);
    expect(failures.map((r) => r.payload.occurrences)).toEqual([12, 11]);
    expect(await alertsOf(ORG_A, STORM_KIND, feed)).toHaveLength(2);
    expect(await deliveriesOf(failures[1]!.id)).toBe(2);
  });

  it("F-199: another feed and another tenant count independently (neither inflates nor triggers the other's escalation)", async () => {
    const feed = feedIn(7);
    const at = new Date("2026-08-07T03:00:00Z");
    await storm(ORG_A, feed, at, 6);
    await storm(ORG_B, feed, at, 6); // the SAME feed id in another tenant
    await storm(ORG_A, feedIn(8), at, 6); // another feed, same tenant
    expect((await alertsOf(ORG_A, KIND, feed))[0]!.payload.occurrences).toBe(6);
    expect((await alertsOf(ORG_B, KIND, feed))[0]!.payload.occurrences).toBe(6);
    expect((await alertsOf(ORG_A, KIND, feedIn(8)))[0]!.payload.occurrences).toBe(6);
    for (const [org, f] of [
      [ORG_A, feed],
      [ORG_B, feed],
      [ORG_A, feedIn(8)],
    ] as const)
      expect(await alertsOf(org, STORM_KIND, f)).toHaveLength(0);
    expect(await recipientsOf((await alertsOf(ORG_B, KIND, feed))[0]!.id)).toEqual([
      user.otherTenantAdmin,
    ]);
  });

  it("F-199: BAA alerts are counted but never escalated", async () => {
    const at = new Date("2026-08-08T03:00:00Z");
    const feed = feedIn(9);
    for (let i = 0; i < 30; i++)
      await emitOutboundAlert(
        emitter,
        ORG_A,
        { ...intent("external_feed.baa_expired"), feedId: feed },
        at,
        10,
      );
    const rows = await alertsOf(ORG_A, "external_feed.baa_expired", feed);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.occurrences).toBe(30);
    expect(await alertsOf(ORG_A, STORM_KIND, feed)).toHaveLength(0);
  });

  it("F-199: neither alert carries PHI — ids, integers and fixed sentences only", async () => {
    const feed = feedIn(3); // the 25-failure storm above
    const [fail] = await alertsOf(ORG_A, KIND, feed);
    const [esc] = await alertsOf(ORG_A, STORM_KIND, feed);
    expect(Object.keys(fail!.payload).sort()).toEqual(["detail", "feedId", "occurrences"]);
    expect(Object.keys(esc!.payload).sort()).toEqual([
      "detail",
      "feedId",
      "occurrences",
      "windowMinutes",
    ]);
    expect(JSON.stringify([fail!.payload, esc!.payload])).not.toMatch(/MRN|DOB|PID\||patient/i);
  });

  it("F-199: the seeded rule for the escalation reaches org_admin + clinical_lead and no bystander", async () => {
    const { rows } = await admin.query(
      "SELECT recipient_resolver, severity_floor, resolver_args FROM alert_rule WHERE organization_id IS NULL AND event_type=$1 AND enabled",
      [STORM_KIND],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].severity_floor).toBe("critical");
    expect((rows[0].resolver_args as { roleKeys: string[] }).roleKeys.sort()).toEqual([
      "clinical_lead",
      "org_admin",
    ]);
  });
});
