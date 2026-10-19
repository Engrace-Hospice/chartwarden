/**
 * M36 WP 4.6 - notification policy (ADR-0073), LIVE Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 * The REAL Drizzle AlertEmitter ports (rules, preferences through migration 0194, verified endpoints through migration 1123, the M1
 * feature-flag reader, persistence) with only the clock fixed. Proves:
 *   1. flags: nothing changes unless `messaging.notification_policy` AND the event's family flag are both on for THAT tenant;
 *   2. quiet hours: a routine out-of-band row is skipped with a reason, the designated urgent request alert still gets its push (and
 *      its trail says quiet hours were bypassed), whatever the recipient's preferences say;
 *   3. verified endpoints only: no endpoint / a pending endpoint / another tenant's user gets in-app only and an explained omission;
 *   4. the class floor (critical = push + sms) and that a recipient's own routing map can only add;
 *   5. tenant isolation: the endpoint reader returns nothing for a user outside the tenant, never an endpoint value, and is not
 *      executable by PUBLIC; flags of one tenant do not leak to another.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m36:notification-policy:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the wardenx_* roles.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import {
  PLATFORM_DEFAULT_ALERT_RULES,
  createAlertEmitter,
  toNewAlertRuleRows,
} from "@wardenx/messaging";
import { withOrgContext } from "@wardenx/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrizzleFeatureFlagReader } from "../src/bootstrap/feature-flag-store";
import { createDrizzleAlertEmitterPorts } from "../src/modules/36-messaging/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-4111-8111-111111110046";
const ORG_B = "22222222-2222-4222-8222-222222220046";
const U = (n: number) => `33333333-3333-4333-8333-33333333004${n}`;
const [ASSIGNEE, NO_ENDPOINT, PENDING_ENDPOINT, ORG_B_USER] = [U(1), U(2), U(3), U(4)];
const POLICY = "messaging.notification_policy";
const ACK = "messaging.ack_requests";
const ROUTINE_EVENT = "test.wp46.routine";
/** 21:30 PDT: inside the assignee's 21:00-07:00 America/Los_Angeles quiet window. */
const NIGHT = new Date("2026-06-16T04:30:00Z");
/** 12:00 PDT: outside it. */
const NOON = new Date("2026-06-16T19:00:00Z");

describe.skipIf(!DB_URL)("M36 WP 4.6 notification policy - LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let clock = NIGHT;
  let seq = 0;

  const emitter = () => {
    const ports = createDrizzleAlertEmitterPorts(handle.db, {
      flags: createDrizzleFeatureFlagReader(handle.db),
    });
    return createAlertEmitter({ ...ports, now: () => clock });
  };
  const setFlags = async (org: string, flags: Record<string, boolean>) => {
    await admin.query("DELETE FROM feature_flag WHERE organization_id = $1", [org]);
    for (const [key, value] of Object.entries(flags)) {
      await admin.query(
        `INSERT INTO feature_flag (organization_id,flag_key,value_type,value) VALUES ($1,$2,'bool',$3::jsonb)`,
        [org, key, JSON.stringify(value)],
      );
    }
  };
  const readBad = (ids: unknown) =>
    withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, async (tx) =>
      tx.execute(
        sql`SELECT * FROM delivery_endpoint_verified_channels_for_org_users(${ORG_A}, ${JSON.stringify(ids)}::jsonb)`,
      ),
    );
  const emitRequest = async (
    org: string,
    userId: string,
    ackClass: "important" | "urgent" | "critical" = "urgent",
    eventType = "m36.ack.requested",
  ) => {
    seq += 1;
    return emitter().emit(org, {
      eventType,
      severity: "warn",
      correlationId: `wp46:${seq}`,
      payload: { recipientUserId: userId, ackClass, message: "x" },
    });
  };
  const rows = async (alertId: string) =>
    (
      await admin.query(
        `SELECT recipient_user_id, channel::text, status::text, fail_reason
           FROM notification_delivery WHERE alert_id=$1 ORDER BY recipient_user_id, channel::text`,
        [alertId],
      )
    ).rows as Array<{
      recipient_user_id: string;
      channel: string;
      status: string;
      fail_reason: string | null;
    }>;
  const trailOf = async (alertId: string) =>
    (await admin.query("SELECT payload->'policyTrail' AS t FROM alert WHERE id=$1", [alertId]))
      .rows[0]?.t as unknown;
  const channelsOf = (r: Awaited<ReturnType<typeof rows>>, user: string) =>
    r.filter((x) => x.recipient_user_id === user).map((x) => `${x.channel}:${x.status}`);

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
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
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wp46-a','A','A'),($2,'wp46-b','B','B')",
      [ORG_A, ORG_B],
    );
    const members: Array<[string, string]> = [
      [ASSIGNEE, ORG_A],
      [NO_ENDPOINT, ORG_A],
      [PENDING_ENDPOINT, ORG_A],
      [ORG_B_USER, ORG_B],
    ];
    for (const [u, org] of members) {
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [u, `${u}@x.test`]);
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')",
        [u, org],
      );
    }
    // The REAL seeded platform rules (as the boot persister writes them) plus one routine broadcast rule for the quiet-hours contrast.
    for (const r of toNewAlertRuleRows(PLATFORM_DEFAULT_ALERT_RULES)) {
      await admin.query(
        `INSERT INTO alert_rule (organization_id,event_type,category,severity_floor,recipient_resolver,resolver_args,channels_override,system_locked,enabled)
         VALUES (NULL,$1,$2,$3,$4,$5::jsonb,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [
          r.eventType,
          r.category,
          r.severityFloor,
          r.recipientResolver,
          JSON.stringify(r.resolverArgs),
          r.channelsOverride,
          r.systemLocked,
          r.enabled,
        ],
      );
    }
    await admin.query(
      `INSERT INTO alert_rule (organization_id,event_type,category,severity_floor,recipient_resolver,resolver_args)
       VALUES (NULL,$1,'clinical_routine','warn','role_set','{"roleKeys":[],"userIdPaths":["recipientUserId"]}'::jsonb)`,
      [ROUTINE_EVENT],
    );
    // Endpoints: verified push+sms (assignee), a PENDING push (3), a verified push in the OTHER tenant (4); none for 2.
    const ep = (user: string, channel: string, value: string, status: string) =>
      admin.query(
        `INSERT INTO delivery_endpoint (user_id,channel,endpoint_value,verification_status,verified_at)
         VALUES ($1,$2,$3,$4, CASE WHEN $5::boolean THEN now() END)`,
        [user, channel, value, status, status === "verified"],
      );
    await ep(ASSIGNEE, "push", "sub-secret-1", "verified");
    await ep(ASSIGNEE, "sms", "+15550000001", "verified");
    await ep(PENDING_ENDPOINT, "push", "sub-secret-3", "pending");
    await ep(ORG_B_USER, "push", "sub-secret-4", "verified");
    // The assignee keeps quiet hours 21:00-07:00 Los Angeles and asks for routine push alerts.
    await admin.query(
      `INSERT INTO user_notification_preferences (user_id,organization_id,routing_map,quiet_hours)
       VALUES ($1,$2,'{"clinical_routine":{"warn":["push"]}}'::jsonb,
               '{"tz":"America/Los_Angeles","ranges":[{"daysOfWeek":[0,1,2,3,4,5,6],"start":"21:00","end":"07:00"}],"severityOverride":"critical"}'::jsonb)`,
      [ASSIGNEE, ORG_A],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("runs as a NOBYPASSRLS role, so every assertion below is under RLS", async () => {
    const r = await handle.db.execute<{ rolbypassrls: boolean; rolsuper: boolean }>(
      sql`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`,
    );
    expect(r.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  it("flags off (the default): the seeded in-app-only rule is untouched and no trail is written", async () => {
    await setFlags(ORG_A, {});
    const { alertId } = await emitRequest(ORG_A, ASSIGNEE);
    expect(channelsOf(await rows(alertId), ASSIGNEE)).toEqual(["in_app:pending"]);
    expect(await trailOf(alertId)).toBeNull();
  });

  it("only one of the two flags on: still in-app only", async () => {
    await setFlags(ORG_A, { [POLICY]: true });
    expect(channelsOf(await rows((await emitRequest(ORG_A, ASSIGNEE)).alertId), ASSIGNEE)).toEqual([
      "in_app:pending",
    ]);
    await setFlags(ORG_A, { [ACK]: true });
    expect(channelsOf(await rows((await emitRequest(ORG_A, ASSIGNEE)).alertId), ASSIGNEE)).toEqual([
      "in_app:pending",
    ]);
  });

  it("both flags on, at night inside the recipient's quiet hours: the urgent push is planned and the trail says quiet hours were bypassed", async () => {
    await setFlags(ORG_A, { [POLICY]: true, [ACK]: true });
    clock = NIGHT;
    const { alertId } = await emitRequest(ORG_A, ASSIGNEE, "urgent");
    expect(channelsOf(await rows(alertId), ASSIGNEE)).toEqual(["in_app:pending", "push:pending"]);
    expect(await trailOf(alertId)).toEqual([
      {
        recipientUserId: ASSIGNEE,
        channel: "push",
        decision: "planned",
        reasons: ["designated_floor", "quiet_hours_bypassed"],
      },
    ]);
  });

  it("the class floor: critical adds sms; important is push only", async () => {
    expect(
      channelsOf(await rows((await emitRequest(ORG_A, ASSIGNEE, "critical")).alertId), ASSIGNEE),
    ).toEqual(["in_app:pending", "push:pending", "sms:pending"]);
    expect(
      channelsOf(await rows((await emitRequest(ORG_A, ASSIGNEE, "important")).alertId), ASSIGNEE),
    ).toEqual(["in_app:pending", "push:pending"]);
  });

  it("quiet hours: the routine alert's push is skipped with a reason at night and delivered at noon", async () => {
    clock = NIGHT;
    const night = await rows((await emitRequest(ORG_A, ASSIGNEE, "urgent", ROUTINE_EVENT)).alertId);
    expect(night.filter((r) => r.channel === "push")).toEqual([
      {
        recipient_user_id: ASSIGNEE,
        channel: "push",
        status: "skipped_quiet_hours",
        fail_reason: "quiet_hours",
      },
    ]);
    clock = NOON;
    const noon = await rows((await emitRequest(ORG_A, ASSIGNEE, "urgent", ROUTINE_EVENT)).alertId);
    expect(noon.filter((r) => r.channel === "push").map((r) => r.status)).toEqual(["pending"]);
    clock = NIGHT;
  });

  it("verified endpoints only: no endpoint and a pending endpoint get in-app only, with the omission explained", async () => {
    for (const user of [NO_ENDPOINT, PENDING_ENDPOINT]) {
      const { alertId } = await emitRequest(ORG_A, user, "critical");
      expect(channelsOf(await rows(alertId), user)).toEqual(["in_app:pending"]);
      expect(await trailOf(alertId)).toEqual([
        {
          recipientUserId: user,
          channel: "push",
          decision: "omitted",
          reasons: ["designated_floor", "no_verified_endpoint"],
        },
        {
          recipientUserId: user,
          channel: "sms",
          decision: "omitted",
          reasons: ["designated_floor", "no_verified_endpoint"],
        },
      ]);
    }
  });

  it("tenant isolation: a user of another tenant named in this tenant's alert gets no row and no endpoint is read for them", async () => {
    const { alertId } = await emitRequest(ORG_A, ORG_B_USER, "urgent");
    expect(await rows(alertId)).toEqual([]);
    const readAs = async (sessionOrg: string, argOrg: string, ids: unknown) =>
      withOrgContext(
        handle.db,
        { organizationId: sessionOrg, userId: "" },
        async (tx) =>
          (
            await tx.execute<{ user_id: string; channel: string }>(
              sql`SELECT * FROM delivery_endpoint_verified_channels_for_org_users(${argOrg}, ${JSON.stringify(ids)}::jsonb)`,
            )
          ).rows,
      );
    // A tenant-A session naming tenant B (or B's user under A's id) reads nothing.
    expect(await readAs(ORG_A, ORG_B, [ORG_B_USER])).toEqual([]);
    expect(await readAs(ORG_A, ORG_A, [ORG_B_USER])).toEqual([]);
    expect(await readAs(ORG_B, ORG_B, [ORG_B_USER])).toEqual([
      { user_id: ORG_B_USER, channel: "push" },
    ]);
    // No tenant context at all reads nothing either.
    const bare = await handle.db.execute<{ user_id: string }>(
      sql`SELECT * FROM delivery_endpoint_verified_channels_for_org_users(${ORG_B}, ${JSON.stringify([ORG_B_USER])}::jsonb)`,
    );
    expect(bare.rows).toEqual([]);
  });

  it("the reader refuses a non-array or oversized id list", async () => {
    await expect(readBad({ not: "array" })).rejects.toThrow();
    await expect(readBad(Array.from({ length: 501 }, () => ORG_B_USER))).rejects.toThrow();
  });

  it("the reader returns channel names only (no endpoint value) and is not executable by PUBLIC", async () => {
    const cols = await admin.query(
      `SELECT pg_get_function_result('delivery_endpoint_verified_channels_for_org_users(uuid,jsonb)'::regprocedure) AS r`,
    );
    expect(cols.rows[0].r).toBe("TABLE(user_id uuid, channel text)");
    const priv = await admin.query(
      `SELECT has_function_privilege('public','delivery_endpoint_verified_channels_for_org_users(uuid,jsonb)','EXECUTE') AS pub,
              has_function_privilege('wardenx_app','delivery_endpoint_verified_channels_for_org_users(uuid,jsonb)','EXECUTE') AS app`,
    );
    expect(priv.rows[0]).toEqual({ pub: false, app: true });
    const ownerRow = await admin.query(
      `SELECT pg_get_userbyid(proowner) AS o, prosecdef FROM pg_proc WHERE proname='delivery_endpoint_verified_channels_for_org_users'`,
    );
    expect(ownerRow.rows[0]).toEqual({ o: "wardenx_admin", prosecdef: true });
  });

  it("flags are per tenant: tenant B with both flags off stays in-app only while A has them on", async () => {
    await setFlags(ORG_B, {});
    const { alertId } = await emitRequest(ORG_B, ORG_B_USER, "critical");
    expect(channelsOf(await rows(alertId), ORG_B_USER)).toEqual(["in_app:pending"]);
    await setFlags(ORG_B, { [POLICY]: true, [ACK]: true });
    const on = await emitRequest(ORG_B, ORG_B_USER, "urgent");
    expect(channelsOf(await rows(on.alertId), ORG_B_USER)).toEqual([
      "in_app:pending",
      "push:pending",
    ]);
  });

  it("the delivery rows of a designated route carry no failure reason and no endpoint id before dispatch", async () => {
    const { alertId } = await emitRequest(ORG_A, ASSIGNEE, "urgent");
    const r = await admin.query(
      "SELECT fail_reason, endpoint_id, vendor_message_id FROM notification_delivery WHERE alert_id=$1",
      [alertId],
    );
    expect(
      r.rows.every(
        (x) => x.fail_reason === null && x.endpoint_id === null && x.vendor_message_id === null,
      ),
    ).toBe(true);
  });
});
