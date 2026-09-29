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
 *   WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m29-alert-routing.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDrizzleAlertEmitter,
  registerMessagingSeams,
  wireAlertRuleSeed,
} from "../src/modules/36-messaging/index";
import {
  OUTBOUND_ALERT_WINDOW_MS,
  buildOutboundAlertEmit,
} from "../src/modules/29-external-interfaces/outbound/alert-routing";
import {
  OUTBOUND_ALERT_KINDS,
  type OutboundAlert,
} from "../src/modules/29-external-interfaces/outbound/outbound-events";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "99999999-9999-9999-9999-999999999999";
const ORG_B = "88888888-8888-8888-8888-888888888888";
const FEED = "11111111-1111-1111-1111-111111111111";
const T0 = new Date("2026-05-01T10:00:00Z");

const intent = (kind: OutboundAlert["kind"], severity: OutboundAlert["severity"] = "HIGH"): OutboundAlert => ({
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
  async function addMember(orgId: string, tag: string, roleKey: string, category: string): Promise<string> {
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
  const emit = (orgId: string, alert: OutboundAlert, now: Date) => emitter.emit(orgId, buildOutboundAlertEmit(alert, now));
  const recipientsOf = async (alertId: string): Promise<string[]> =>
    (
      await admin.query("SELECT DISTINCT recipient_user_id FROM notification_delivery WHERE alert_id=$1", [alertId])
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
    user.compliance = await addMember(ORG_A, "a-compliance", "compliance_officer", "compliance_quality");
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
    expect(rows.map((r) => r.event_type as string).sort()).toEqual([...OUTBOUND_ALERT_KINDS].sort());
  });

  it("a failed transmission notifies the operator (org_admin) and the M11 owners — and nobody else", async () => {
    for (const severity of ["HIGH", "NORMAL"] as const) {
      const res = await emit(ORG_A, intent("hl7_outbound.transmission_failed", severity), new Date(T0.getTime() + (severity === "HIGH" ? 0 : 7 * 86_400_000)));
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
    const { rows } = await admin.query("SELECT organization_id FROM alert WHERE id=$1", [res.alertId]);
    expect(rows[0].organization_id).toBe(ORG_B);
  });

  it("THROTTLE: a retry storm inside one window pages once; the same still-true condition pages again next window", async () => {
    const kind = "hl7_outbound.transmission_failed" as const;
    const base = new Date("2026-06-01T03:00:00Z");
    const first = await emit(ORG_A, intent(kind), base);
    const storm = await emit(ORG_A, intent(kind), new Date(base.getTime() + 20 * 60_000));
    expect(storm.alertId).toBe(first.alertId); // absorbed: same window, same (kind, feed)
    const deliveriesAfterStorm = (
      await admin.query("SELECT count(*)::int n FROM notification_delivery WHERE alert_id=$1", [first.alertId])
    ).rows[0].n as number;
    expect(deliveriesAfterStorm).toBe(2); // one page (org_admin + clinical_lead), not one per retry

    const nextWindow = await emit(
      ORG_A,
      intent(kind),
      new Date(base.getTime() + OUTBOUND_ALERT_WINDOW_MS[kind]),
    );
    expect(nextWindow.alertId).not.toBe(first.alertId);
    expect(nextWindow.resolvedRecipientCount).toBe(2); // the pre-F-188 permanent id would have swallowed this forever
    expect(await recipientsOf(nextWindow.alertId)).toEqual([user.orgAdmin, user.clinicalLead].sort());
  });

  it("the payload that reaches M36 carries ids and a summary only — no PHI fields", async () => {
    const res = await emit(ORG_A, intent("external_feed.baa_missing"), new Date("2026-07-01T00:00:00Z"));
    const { rows } = await admin.query("SELECT payload FROM alert WHERE id=$1", [res.alertId]);
    expect(Object.keys(rows[0].payload as object).sort()).toEqual(["detail", "feedId"]);
  });
});
