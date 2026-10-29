/**
 * S09 (clinical workflow audit 2026-10-28) -- the on-call page chain, on real Postgres.
 *
 * Existing suites prove each link alone: the coverage-gap watchdog (m19-tier1-crons.live), the router
 * (m19-escalation-router.live), the M19 consumer of `m36.notification.delivery_failed` (m19-inbound-triggers.live,
 * which hand-builds that payload) and the vendor-failure producer (gap-101). What no live suite ran is the
 * M36 `oncall-alerts` consumer over the REAL emitter and the REAL platform `alert_rule` seed, nor the payload the
 * REAL settlement publishes when one of those pages fails to deliver. This suite owns both:
 *   - a coverage gap becomes ONE critical page to the seeded role set, once per provider entity per hour, and a new
 *     hour re-pages an unfilled hole (never silence, never a storm);
 *   - tenant isolation, and a malformed event throws (relay retry -> DLQ) instead of being dropped;
 *   - when that page's delivery fails, the `delivery_failed` the settlement publishes carries what M19 needs.
 * "REPORTED, NOT FIXED" cases pin today's behaviour (same convention as m19-inbound-triggers.live) so the day it
 * changes this suite fails and the change is made deliberately.
 *
 * Drives the writes as the NOBYPASSRLS `chartwarden_app` role with the real catalog-validating publisher.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m36:oncall-page-chain:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  type Tx,
  applyDeliveryTransition,
} from "../src/modules/36-messaging/delivery/delivery-settlement";
import {
  M36_OUTBOX_EVENTS,
  createDrizzleAlertEmitter,
  registerMessagingSeams,
  wireAlertRuleSeed,
} from "../src/modules/36-messaging/index";
import { buildM36OncallAlertConsumer } from "../src/modules/36-messaging/outbox-consumers/oncall-alerts";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "aaaaaaaa-0009-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0009-4000-8000-00000000000b";
const ORG_C = "cccccccc-0009-4000-8000-00000000000c";
const PE_1 = "dddddddd-0009-4000-8000-0000000000d1";
const PE_2 = "dddddddd-0009-4000-8000-0000000000d2";
const COVERAGE_GAP = "m19.oncall_shift.coverage_gap";
const COVERAGE_GAP_ALERT = "m19.oncall.coverage_gap_detected";
const HOUR_10 = new Date("2026-10-28T10:05:00Z");
const HOUR_10_LATER = new Date("2026-10-28T10:50:00Z");
const HOUR_11 = new Date("2026-10-28T11:05:00Z");

describe.skipIf(!DB_URL)("S09 on-call page chain — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let consumer: ReturnType<typeof buildM36OncallAlertConsumer>;
  let settleOutbox: Parameters<typeof applyDeliveryTransition>[1];
  const user: Record<string, string> = {};

  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (process.env.CHARTWARDEN_TEST_NO_PGVECTOR) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }
  async function addMember(orgId: string, tag: string, roleKey: string): Promise<string> {
    const roleId = (
      await admin.query(
        "INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,$2,'admin_executive') RETURNING id",
        [orgId, roleKey],
      )
    ).rows[0].id as string;
    const userId = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [`${tag}@s09.test`])
    ).rows[0].id as string;
    const membershipId = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [userId, orgId],
      )
    ).rows[0].id as string;
    await admin.query(
      "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
      [orgId, membershipId, roleId],
    );
    return userId;
  }
  const gapEvent = (org: string, pe: string, createdAt: Date, over: object = {}) => ({
    id: randomUUID(),
    eventType: COVERAGE_GAP,
    organizationId: org,
    createdAt,
    payload: {
      providerEntityId: pe,
      gapStartsAt: "2026-10-28T22:00:00Z",
      gapEndsAt: "2026-10-29T06:00:00Z",
      discipline: "clinical_rn",
      ...over,
    },
  });
  const handleEvent = (event: object) => consumer.handle(event as never);
  const alerts = async (org: string, like = "%") =>
    (
      await admin.query(
        `SELECT id, correlation_id, severity, payload FROM alert
          WHERE organization_id=$1 AND event_type=$2 AND correlation_id LIKE $3 ORDER BY correlation_id`,
        [org, COVERAGE_GAP_ALERT, like],
      )
    ).rows as {
      id: string;
      correlation_id: string;
      severity: string;
      payload: Record<string, unknown>;
    }[];
  const recipients = async (alertId: string): Promise<string[]> =>
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
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of LIVE_DROP_ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    await applyMigrations();
    for (const [id, slug] of [
      [ORG_A, "s09-a"],
      [ORG_B, "s09-b"],
      [ORG_C, "s09-c"],
    ] as const)
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    // The seeded coverage-gap rule resolves role_set {org_admin, clinical_supervisor}. A nurse is NOT in the set.
    user.aAdmin = await addMember(ORG_A, "a-admin", "org_admin");
    user.aSupervisor = await addMember(ORG_A, "a-sup", "clinical_supervisor");
    user.aNurse = await addMember(ORG_A, "a-nurse", "nurse");
    user.bAdmin = await addMember(ORG_B, "b-admin", "org_admin");
    user.cNurse = await addMember(ORG_C, "c-nurse", "nurse"); // ORG_C: nobody holds a role the rule names

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    const emitter = createDrizzleAlertEmitter(handle.db);
    registerMessagingSeams({ emitter });
    await wireAlertRuleSeed(handle.db);
    consumer = buildM36OncallAlertConsumer(emitter);
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M36_OUTBOX_EVENTS]));
    settleOutbox = {
      publish: (tx: unknown, e: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...e, callerModule: "m36" } as never),
    } as never;
  }, 300_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("a coverage gap raises ONE critical page, to the seeded role set and nobody else", async () => {
    await handleEvent(gapEvent(ORG_A, PE_1, HOUR_10));

    const rows = await alerts(ORG_A, `%${PE_1}%`);
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("critical");
    expect(rows[0].correlation_id).toBe(`outbox:${COVERAGE_GAP_ALERT}:${PE_1}:2026-10-28T10`);
    expect(rows[0].payload).toMatchObject({ providerEntityId: PE_1, discipline: "clinical_rn" });
    expect(await recipients(rows[0].id)).toEqual([user.aAdmin, user.aSupervisor].sort());
  });

  it("the standing gap re-published inside the hour (a new tick, or a redelivery) does not page again", async () => {
    const before = (await alerts(ORG_A, `%${PE_1}%`)).length;
    const replay = gapEvent(ORG_A, PE_1, HOUR_10_LATER);

    await handleEvent(replay);
    await handleEvent(replay);

    expect(await alerts(ORG_A, `%${PE_1}%`)).toHaveLength(before);
  });

  it("a new hour re-pages an unfilled hole; another provider entity in the same hour is its own page", async () => {
    await handleEvent(gapEvent(ORG_A, PE_1, HOUR_11));
    await handleEvent(gapEvent(ORG_A, PE_2, HOUR_10));

    const pe1 = (await alerts(ORG_A, `%${PE_1}%`)).map((r) => r.correlation_id);
    expect(pe1).toEqual([
      `outbox:${COVERAGE_GAP_ALERT}:${PE_1}:2026-10-28T10`,
      `outbox:${COVERAGE_GAP_ALERT}:${PE_1}:2026-10-28T11`,
    ]);
    expect(await alerts(ORG_A, `%${PE_2}%`)).toHaveLength(1);
  });

  it("tenant isolation: org B's gap pages org B's admin only, and the same key in org A is a different alert", async () => {
    await handleEvent(gapEvent(ORG_B, PE_1, HOUR_10));

    const bRows = await alerts(ORG_B, `%${PE_1}%`);
    expect(bRows).toHaveLength(1);
    expect(await recipients(bRows[0].id)).toEqual([user.bAdmin]);
    const aRows = await alerts(ORG_A, `%${PE_1}%2026-10-28T10`);
    expect(aRows).toHaveLength(1);
    expect(aRows[0].id).not.toBe(bRows[0].id);
    expect(await recipients(aRows[0].id)).not.toContain(user.bAdmin);
  });

  it("the organization comes from the envelope, never the payload", async () => {
    const event = gapEvent(ORG_C, PE_2, HOUR_10, { organizationId: ORG_A });

    await handleEvent(event);

    expect(await alerts(ORG_C, `%${PE_2}%`)).toHaveLength(1);
    // org A still holds exactly the one PE_2 page it had; nothing was re-routed to it.
    expect(await alerts(ORG_A, `%${PE_2}%`)).toHaveLength(1);
  });

  it("a malformed gap event throws (relay retry -> DLQ) and writes no alert", async () => {
    const before = (await alerts(ORG_A)).length;
    const bad = gapEvent(ORG_A, PE_1, HOUR_11, { providerEntityId: undefined });

    await expect(handleEvent(bad)).rejects.toThrow(/no providerEntityId/);

    expect((await alerts(ORG_A)).length).toBe(before);
  });

  it("a mandatory escalation-SLA breach is critical and keyed by the event: a redelivery collapses, a fresh breach pages", async () => {
    const breach = (id: string) => ({
      id,
      eventType: "m19.triage_call.escalation_sla_breached",
      organizationId: ORG_A,
      createdAt: HOUR_10,
      payload: {
        providerEntityId: PE_1,
        triageCallId: randomUUID(),
        escalationId: randomUUID(),
        tier: "tier_1_rn_supervisor",
        mandatory: true,
        slaTargetMinutes: 15,
        minutesOpen: 22,
      },
    });
    const first = breach(randomUUID());

    await handleEvent(first);
    await handleEvent(first);
    await handleEvent(breach(randomUUID()));

    const { rows } = await admin.query(
      `SELECT severity FROM alert WHERE organization_id=$1 AND event_type='m19.triage.escalation_sla_breached'`,
      [ORG_A],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.severity === "critical")).toBe(true);
  });

  it("REPORTED, NOT FIXED: a gap in an org where nobody holds the seeded roles raises the alert but reaches no one", async () => {
    // ORG_C's only member is a nurse. The rule names org_admin + clinical_supervisor, so the page resolves to nobody.
    // The raw emitter (what the production consumer is bound to) neither errors nor falls back, so the event is
    // acknowledged as handled and no human is told. This test builds the consumer itself, so a fix applied only
    // at the production binding would not trip it: the next test pins that binding's source too.
    const before = (await alerts(ORG_C, `%${PE_1}%`)).length;

    await handleEvent(gapEvent(ORG_C, PE_1, HOUR_10));

    const rows = await alerts(ORG_C, `%${PE_1}%`);
    expect(rows).toHaveLength(before + 1);
    expect(await recipients(rows[0].id)).toEqual([]);
  });

  it("REPORTED, NOT FIXED: the production binding hands the consumer the bare emitter (no recipient fallback)", () => {
    const boot = readFileSync(join(__dirname, "../src/index.ts"), "utf8");

    expect(boot).toContain('buildM36OncallAlertConsumer(getSeam("AlertEmitter") as AlertEmitter)');
  });

  it("when the coverage-gap page fails to deliver, the published delivery_failed names the entity and the alert type", async () => {
    const [page] = await alerts(ORG_A, `%${PE_1}%2026-10-28T10`);
    const delivery = (
      await admin.query(
        "SELECT id FROM notification_delivery WHERE alert_id=$1 AND recipient_user_id=$2 LIMIT 1",
        [page.id, user.aAdmin],
      )
    ).rows[0];
    expect(delivery).toBeDefined();

    const result = await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
      applyDeliveryTransition(tx as unknown as Tx, settleOutbox, {
        organizationId: ORG_A,
        deliveryId: delivery.id as string,
        transition: { status: "failed", failReason: "vendor_timeout" },
        now: new Date(),
      }),
    );

    expect(result).toBe("applied");
    const { rows } = await admin.query(
      `SELECT payload FROM outbox_event WHERE event_type='m36.notification.delivery_failed' AND aggregate_id=$1`,
      [delivery.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      organizationId: ORG_A,
      providerEntityId: PE_1,
      alertEventType: COVERAGE_GAP_ALERT,
      failureReason: "vendor_timeout",
      // The page went to a role set, not the on-call roster: M19's §4.8 consumer ignores it by design, so the
      // only follow-up to a failed coverage-gap page is whatever M36's own channels do.
      recipientKind: "role_set",
    });
  });
});
