/**
 * M36 WP 4.10 - snooze and reminders (ADR-0077), LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * The real route stack, the real Drizzle stores, the real snooze lookup, the real Drizzle AlertEmitter and the real reminder sweep, on
 * migration 1125. Proves:
 *   1. OWNER + TENANT: rows are visible to their owner alone (a colleague, a context with no user and another tenant read, update and
 *      delete nothing); the two SECURITY DEFINER readers answer for the session tenant only, are bounded, and are not PUBLIC.
 *   2. URGENT IS NEVER SNOOZABLE: an open acknowledgment request (as sender or assignee) refuses the snooze through the route AND the
 *      trigger; a request opened AFTER the snooze voids it for as long as it is open; an urgent item arriving while snoozed still gets
 *      its push; an urgent message and one with an open request refuse a reminder (route and trigger).
 *   3. EFFECT: a snooze skips ONLY the out-of-band rows of a mention (reason `snoozed`), never the in-app row; an expired snooze, a
 *      colleague's snooze, a flag-off tenant and a mention with no channel id are untouched.
 *   4. BOUNDS: the 24-hour and 30-day CHECKs hold against a caller that skips the service; the 25-reminder cap holds under 8-way
 *      concurrency.
 *   5. REMINDER SWEEP: a due reminder raises ONE alert (ids and fixed text only, no body), exactly once across repeats and a crash
 *      between the alert and the delete; deleted message / lost access / stale / flag off behave as designed; another tenant's rows
 *      are never touched.
 *   6. IDEMPOTENT RETRY: the same Idempotency-Key replays the stored answer. Audit rows exist and carry no text.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:snooze-reminder:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the chartwarden_* roles.
 */
import { randomUUID } from "node:crypto";
import {
  PLATFORM_DEFAULT_ALERT_RULES,
  createAlertEmitter,
  toNewAlertRuleRows,
} from "@chartwarden/messaging";
import { REMINDER_MAX_PENDING, SNOOZE_REMINDER_FLAG_KEY } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrizzleFeatureFlagReader } from "../src/bootstrap/feature-flag-store";
import { buildServer } from "../src/bootstrap/index";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { createDrizzleAlertEmitterPorts } from "../src/modules/36-messaging/index";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import { sweepRemindersForOrg } from "../src/modules/36-messaging/snooze-reminders/reminder-sweep";
import { createSnoozeReminderService } from "../src/modules/36-messaging/snooze-reminders/snooze-reminder-service";
import {
  createDbReminderSweepStore,
  createDbSnoozeReminderStore,
} from "../src/modules/36-messaging/snooze-reminders/snooze-reminder-store-db";
import { createSnoozedUsersPort } from "../src/modules/36-messaging/snooze-reminders/snoozed-users-port";
import {
  type LiveKit,
  STAFF_KEYS,
  as,
  bootLiveKit,
  errorCode,
  headerAuth,
  mkChannel,
} from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-1111104a0001";
const ORG_B = "22222222-2222-4222-8222-2222104a0002";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000104a00a1";
const SECRET = "Okafor MRN 88421 morphine";
const POLICY = SNOOZE_REMINDER_FLAG_KEY;
const MIN = 60_000;
const NO_QUIET = '{"tz":"UTC","ranges":[],"severityOverride":"critical"}';

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;

describe.skipIf(!DB_URL)("M36 WP 4.10 snooze and reminders - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  let alice: string;
  let bob: string;
  let carol: string;
  let dan: string;
  let channel: string;
  let routineMsg: string;
  let seq = 0;
  let flagOn = true;
  const sweepStore = () => createDbReminderSweepStore(kit.handle.db);

  const setFlag = async (org: string, on: boolean) => {
    await kit.admin.query("DELETE FROM feature_flag WHERE organization_id = $1", [org]);
    if (on) {
      await kit.admin.query(
        "INSERT INTO feature_flag (organization_id,flag_key,value_type,value) VALUES ($1,$2,'bool','true'::jsonb)",
        [org, POLICY],
      );
    }
  };
  const emitter = () =>
    createAlertEmitter({
      ...createDrizzleAlertEmitterPorts(kit.handle.db, {
        flags: createDrizzleFeatureFlagReader(kit.handle.db),
      }),
      now: () => new Date(),
    });

  /** Run raw SQL as `chartwarden_app` with a tenant (and optionally a user) bound, always rolled back. */
  async function asApp<T>(
    org: string,
    user: string | null,
    fn: (q: Query) => Promise<T>,
  ): Promise<T> {
    await kit.appConn.query("BEGIN");
    try {
      await kit.appConn.query(
        "SELECT set_config('app.org_id',$1,true), set_config('app.user_id',$2,true)",
        [org, user ?? ""],
      );
      return await fn((sql, p) => kit.appConn.query(sql, p));
    } finally {
      await kit.appConn.query("ROLLBACK");
    }
  }
  const sqlError = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (e) {
      return e as { code?: string; message: string };
    }
  };

  const send = async (ch = channel, author = alice) =>
    (await kit.service.sendMessage(ORG_A, { channelId: ch, authorUserId: author, body: SECRET }))
      .messageId;
  const openRequest = async (requester: string, assignee: string, ch = channel) => {
    const messageId = await send(ch, requester);
    const id = (
      await kit.admin.query(
        `INSERT INTO message_acknowledgment_request
           (organization_id, message_id, channel_id, patient_id, ack_class, requester_user_id, assigned_user_id, requested_at, window_started_at, deadline_at)
         VALUES ($1,$2,$3,$4,'important',$5,$6,now(),now(), now() + interval '60 minutes') RETURNING id`,
        [ORG_A, messageId, ch, PATIENT, requester, assignee],
      )
    ).rows[0].id as string;
    return { id, messageId };
  };
  const closeRequest = (id: string) =>
    kit.admin.query(
      "UPDATE message_acknowledgment_request SET status='cancelled', cancelled_at=now(), version=version+1 WHERE id=$1",
      [id],
    );
  const reset = async () => {
    await kit.admin.query(
      "UPDATE message_acknowledgment_request SET status='cancelled', cancelled_at=now(), version=version+1 WHERE status NOT IN ('resolved','cancelled')",
    );
    await kit.admin.query("DELETE FROM message_snooze");
    await kit.admin.query("DELETE FROM message_reminder");
    await setFlag(ORG_A, true);
    flagOn = true;
  };

  const put = (path: string, user: string, payload: object, key?: string, org = ORG_A) =>
    app.inject({
      method: "PUT",
      url: path,
      headers: as(user, org, key ?? `k-${++seq}-${randomUUID()}`),
      payload,
    });
  const snoozePath = (ch = channel) => `/api/v1/messaging/channels/${ch}/snooze`;
  const reminderPath = (m: string) => `/api/v1/messaging/messages/${m}/reminder`;
  const inMin = (n: number) => new Date(Date.now() + n * MIN).toISOString();
  const snoozeRows = (user?: string) =>
    kit.count(
      `SELECT count(*)::int AS n FROM message_snooze ${user ? `WHERE user_id = '${user}'` : ""}`,
    );
  const reminderRows = (user?: string) =>
    kit.count(
      `SELECT count(*)::int AS n FROM message_reminder ${user ? `WHERE user_id = '${user}'` : ""}`,
    );

  const deliveries = async (alertId: string) =>
    (
      await kit.admin.query(
        `SELECT recipient_user_id, channel::text AS channel, status::text AS status, fail_reason
           FROM notification_delivery WHERE alert_id = $1 ORDER BY channel::text`,
        [alertId],
      )
    ).rows as Array<{
      recipient_user_id: string;
      channel: string;
      status: string;
      fail_reason: string | null;
    }>;
  const mention = async (
    user: string,
    payload: Record<string, unknown> = { channelId: channel, messageId: routineMsg },
  ) => {
    seq += 1;
    return emitter().emit(ORG_A, {
      eventType: "m36.message.mentioned",
      severity: "info",
      correlationId: `wp410:mention:${seq}`,
      payload: { mentionedUserId: user, message: "x", ...payload },
    });
  };

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp410");
    alice = await kit.seedUser("alice", ORG_A, STAFF_KEYS);
    bob = await kit.seedUser("bob", ORG_A, STAFF_KEYS);
    carol = await kit.seedUser("carol", ORG_A, STAFF_KEYS);
    dan = await kit.seedUser("dan", ORG_B, STAFF_KEYS);
    channel = await mkChannel(kit, "care_team", PATIENT, [alice, bob]);
    for (const r of toNewAlertRuleRows(PLATFORM_DEFAULT_ALERT_RULES)) {
      await kit.admin.query(
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
    // A tenant routes mentions out-of-band too (the seeded rule is in-app only), so the snooze has something to quiet.
    await kit.admin.query(
      `INSERT INTO alert_rule (organization_id,event_type,category,severity_floor,recipient_resolver,resolver_args,channels_override)
       VALUES ($1,'m36.message.mentioned','clinical_routine','info','role_set','{"roleKeys":[],"userIdPaths":["mentionedUserId"]}'::jsonb,'{in_app,push}')`,
      [ORG_A],
    );
    for (const u of [alice, bob]) {
      await kit.admin.query(
        "INSERT INTO user_notification_preferences (user_id,organization_id,routing_map,quiet_hours) VALUES ($1,$2,'{}'::jsonb,$3::jsonb)",
        [u, ORG_A, NO_QUIET],
      );
    }
    await kit.admin.query(
      "INSERT INTO delivery_endpoint (user_id,channel,endpoint_value,verification_status,verified_at) VALUES ($1,'push','sub-secret-bob','verified',now())",
      [bob],
    );
    await setFlag(ORG_A, true);
    routineMsg = await send(channel, alice);

    const service = createSnoozeReminderService({
      isEnabled: async () => flagOn,
      store: createDbSnoozeReminderStore(kit.handle.db),
      canViewChannel: kit.service.canViewChannel,
    });
    app = buildServer({
      db: kit.handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(kit.handle.db),
    });
    registerMessagingRoutes(app, {
      service: kit.service,
      announcements: createDbAnnouncementService(kit.handle.db),
      snoozeReminders: { service },
    });
    await app.ready();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await kit?.close();
  });

  it("runs as a NOBYPASSRLS role, so every assertion below is under RLS", async () => {
    const r = await kit.appConn.query(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user",
    );
    expect(r.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  describe("owner and tenant isolation", () => {
    it("a snooze is visible to its owner alone: a colleague, no user context and another tenant see and change nothing", async () => {
      await reset();
      expect((await put(snoozePath(), alice, { duration_minutes: 60 })).statusCode).toBe(200);
      const read = (org: string, user: string | null) =>
        asApp(
          org,
          user,
          async (q) => (await q("SELECT count(*)::int AS n FROM message_snooze")).rows[0].n,
        );
      expect(await read(ORG_A, alice)).toBe(1);
      expect(await read(ORG_A, bob)).toBe(0);
      expect(await read(ORG_A, null)).toBe(0);
      expect(await read(ORG_B, dan)).toBe(0);
      const touch = (user: string | null, sql: string) =>
        asApp(ORG_A, user, async (q) => (await q(sql)).rowCount);
      expect(
        await touch(
          bob,
          "UPDATE message_snooze SET snoozed_until = snoozed_until + interval '1 minute'",
        ),
      ).toBe(0);
      expect(await touch(bob, "DELETE FROM message_snooze")).toBe(0);
      expect(await touch(null, "DELETE FROM message_snooze")).toBe(0);
      // Forging the owner on insert is refused by the policy's WITH CHECK.
      const forged = await asApp(ORG_A, bob, async (q) =>
        sqlError(
          q(
            "INSERT INTO message_snooze (organization_id,user_id,channel_id,snoozed_until) VALUES ($1,$2,$3, now() + interval '1 hour')",
            [ORG_A, alice, channel],
          ),
        ),
      );
      expect(forged?.code).toBe("42501");
    });

    it("a reminder is visible to its owner alone, and the route lists only the caller's", async () => {
      await reset();
      const m = await send();
      expect((await put(reminderPath(m), alice, { remind_at: inMin(30) })).statusCode).toBe(200);
      const read = (org: string, user: string | null) =>
        asApp(
          org,
          user,
          async (q) => (await q("SELECT count(*)::int AS n FROM message_reminder")).rows[0].n,
        );
      expect(await read(ORG_A, alice)).toBe(1);
      expect(await read(ORG_A, bob)).toBe(0);
      expect(await read(ORG_A, null)).toBe(0);
      expect(await read(ORG_B, dan)).toBe(0);
      const list = (user: string, org = ORG_A) =>
        app.inject({ method: "GET", url: "/api/v1/messaging/reminders", headers: as(user, org) });
      expect((await list(alice)).json().reminders).toHaveLength(1);
      expect((await list(bob)).json().reminders).toHaveLength(0);
      expect((await list(dan, ORG_B)).json().reminders).toHaveLength(0);
    });

    it("the readers answer for the session tenant only, are bounded, return ids only, and are not PUBLIC", async () => {
      await reset();
      await put(snoozePath(), alice, { duration_minutes: 60 });
      const m = await send();
      await put(reminderPath(m), alice, { remind_at: inMin(30) });
      const snoozed = (org: string, ctxOrg: string, ids: unknown) =>
        asApp(
          ctxOrg,
          null,
          async (q) =>
            (
              await q("SELECT * FROM message_snoozed_users_for_channel($1,$2,$3::jsonb)", [
                org,
                channel,
                JSON.stringify(ids),
              ])
            ).rows,
        );
      expect(await snoozed(ORG_A, ORG_A, [alice, bob])).toEqual([{ user_id: alice }]);
      expect(await snoozed(ORG_A, ORG_B, [alice])).toEqual([]); // another tenant's session
      expect(await snoozed(ORG_A, "", [alice])).toEqual([]); // no tenant context
      expect(await snoozed(ORG_B, ORG_A, [alice])).toEqual([]); // a foreign org id from a tenant session
      const many = Array.from({ length: 501 }, () => randomUUID());
      const tooMany = await asApp(ORG_A, null, async (q) =>
        sqlError(
          q("SELECT * FROM message_snoozed_users_for_channel($1,$2,$3::jsonb)", [
            ORG_A,
            channel,
            JSON.stringify(many),
          ]),
        ),
      );
      expect(tooMany?.code).toBe("22023");
      await kit.admin.query(
        "UPDATE message_reminder SET set_at = now() - interval '2 hours', remind_at = now() - interval '1 hour'",
      );
      const due = (org: string, ctxOrg: string) =>
        asApp(
          ctxOrg,
          null,
          async (q) => (await q("SELECT * FROM message_reminder_due($1, 10)", [org])).rows,
        );
      const dueA = await due(ORG_A, ORG_A);
      expect(dueA).toHaveLength(1);
      expect(Object.keys(dueA[0]).sort()).toEqual([
        "channel_id",
        "id",
        "message_id",
        "remind_at",
        "user_id",
      ]);
      expect(await due(ORG_A, ORG_B)).toEqual([]);
      expect(await due(ORG_B, ORG_A)).toEqual([]);
      for (const fn of [
        "message_snoozed_users_for_channel(uuid,uuid,jsonb)",
        "message_reminder_due(uuid,integer,integer)",
      ]) {
        const priv = await kit.admin.query(
          `SELECT has_function_privilege('public', '${fn}', 'EXECUTE') AS pub, has_function_privilege('chartwarden_app', '${fn}', 'EXECUTE') AS app`,
        );
        expect(priv.rows[0]).toEqual({ pub: false, app: true });
      }
    });
  });

  describe("urgent is never snoozable", () => {
    it("an open request refuses the snooze for its sender and its assignee (typed 409)", async () => {
      await reset();
      const { id } = await openRequest(alice, bob);
      for (const user of [alice, bob]) {
        const res = await put(snoozePath(), user, { duration_minutes: 60 });
        expect(res.statusCode).toBe(409);
        expect(errorCode(res)).toBe("SNOOZE_URGENT_NOT_ALLOWED");
      }
      expect(await snoozeRows()).toBe(0);
      const state = await app.inject({ method: "GET", url: snoozePath(), headers: as(bob, ORG_A) });
      expect(state.json()).toMatchObject({ snoozable: false, snoozed_until: null });
      // A colleague who is neither sender nor assignee is not blocked; once the request closes the same call succeeds.
      expect((await put(snoozePath(), carol, { duration_minutes: 60 })).statusCode).toBe(404);
      await closeRequest(id);
      expect((await put(snoozePath(), bob, { duration_minutes: 60 })).statusCode).toBe(200);
    });

    it("the trigger refuses a caller that skips the service", async () => {
      await reset();
      await openRequest(alice, bob);
      const refused = await asApp(ORG_A, bob, async (q) =>
        sqlError(
          q(
            "INSERT INTO message_snooze (organization_id,user_id,channel_id,snoozed_until) VALUES ($1,$2,$3, now() + interval '1 hour')",
            [ORG_A, bob, channel],
          ),
        ),
      );
      expect(refused?.code).toBe("23514");
      expect(refused?.message).toContain("message_snooze_urgent");
      expect(await snoozeRows()).toBe(0);
    });

    it("a request opened AFTER the snooze voids it while open, and the lookup stops reporting it", async () => {
      await reset();
      expect((await put(snoozePath(), bob, { duration_minutes: 120 })).statusCode).toBe(200);
      const port = createSnoozedUsersPort(kit.handle.db, {
        forOrg: async () => ({ [POLICY]: true }),
      });
      expect([...(await port(ORG_A, channel, [alice, bob], routineMsg))]).toEqual([bob]);
      const { id } = await openRequest(alice, bob);
      expect([...(await port(ORG_A, channel, [alice, bob], routineMsg))]).toEqual([]);
      // Re-snoozing is refused and ending the snooze is still allowed.
      expect((await put(snoozePath(), bob, { duration_minutes: 60 })).statusCode).toBe(409);
      await closeRequest(id);
      expect([...(await port(ORG_A, channel, [alice, bob], routineMsg))]).toEqual([bob]);
      const del = await app.inject({
        method: "DELETE",
        url: snoozePath(),
        headers: as(bob, ORG_A),
      });
      expect(del.json()).toEqual({ cleared: true });
    });

    it("the lookup is empty while the flag is off, even with a running snooze", async () => {
      await reset();
      await put(snoozePath(), bob, { duration_minutes: 60 });
      const off = createSnoozedUsersPort(kit.handle.db, { forOrg: async () => ({}) });
      expect([...(await off(ORG_A, channel, [bob], routineMsg))]).toEqual([]);
    });

    it("an urgent item arriving while snoozed still gets its push", async () => {
      await reset();
      await put(snoozePath(), bob, { duration_minutes: 120 });
      await kit.admin.query(
        "INSERT INTO feature_flag (organization_id,flag_key,value_type,value) VALUES ($1,'messaging.ack_requests','bool','true'::jsonb)",
        [ORG_A],
      );
      const { id } = await openRequest(alice, bob);
      seq += 1;
      const { alertId } = await emitter().emit(ORG_A, {
        eventType: "m36.ack.requested",
        severity: "warn",
        correlationId: `wp410:ack:${seq}`,
        payload: { recipientUserId: bob, ackClass: "urgent", message: "x" },
      });
      const rows = await deliveries(alertId);
      expect(rows.find((r) => r.channel === "push")).toMatchObject({
        recipient_user_id: bob,
        status: "pending",
        fail_reason: null,
      });
      await closeRequest(id);
    });
  });

  describe("effect of a snooze on a mention", () => {
    it("skips the out-of-band row with the reason 'snoozed' and keeps the in-app row", async () => {
      await reset();
      const before = await mention(bob);
      expect((await deliveries(before.alertId)).map((r) => `${r.channel}:${r.status}`)).toEqual([
        "in_app:pending",
        "push:pending",
      ]);
      await put(snoozePath(), bob, { duration_minutes: 60 });
      const during = await deliveries((await mention(bob)).alertId);
      expect(during.find((r) => r.channel === "in_app")).toMatchObject({ status: "pending" });
      expect(during.find((r) => r.channel === "push")).toMatchObject({
        status: "skipped_quiet_hours",
        fail_reason: "snoozed",
      });
    });

    it("an expired snooze, a colleague's snooze, a mention with no channel id and a flag-off tenant are untouched", async () => {
      await reset();
      await put(snoozePath(), bob, { duration_minutes: 60 });
      const pushOf = async (id: string) =>
        (await deliveries(id)).find((r) => r.channel === "push")?.status;
      // the snooze has run out
      await kit.admin.query(
        "UPDATE message_snooze SET snoozed_at = now() - interval '2 hours', snoozed_until = now() - interval '1 hour'",
      );
      expect(await pushOf((await mention(bob)).alertId)).toBe("pending");
      // a colleague's snooze does not quiet bob
      await kit.admin.query("DELETE FROM message_snooze");
      await put(snoozePath(), alice, { duration_minutes: 60 });
      expect(await pushOf((await mention(bob)).alertId)).toBe("pending");
      // no channel id on the alert: never looked up
      await put(snoozePath(), bob, { duration_minutes: 60 });
      expect(await pushOf((await mention(bob, {})).alertId)).toBe("pending");
      // a different conversation
      expect(await pushOf((await mention(bob, { channelId: randomUUID() })).alertId)).toBe(
        "pending",
      );
      // flag off for the tenant: the row exists but nothing is quieted
      await setFlag(ORG_A, false);
      expect(await pushOf((await mention(bob)).alertId)).toBe("pending");
      await setFlag(ORG_A, true);
      expect(await pushOf((await mention(bob)).alertId)).toBe("skipped_quiet_hours");
    });
  });

  describe("a mention on an urgent-priority message", () => {
    it("is never quieted by a snooze, even with no request on it", async () => {
      await reset();
      const urgentMsg = await send(channel, alice);
      await kit.admin.query("ALTER TABLE message DISABLE TRIGGER trg_message_urgency_immutable");
      try {
        await kit.admin.query(
          "UPDATE message SET urgency='urgent', urgent_recipient_user_id=$2 WHERE id=$1",
          [urgentMsg, bob],
        );
      } finally {
        await kit.admin.query("ALTER TABLE message ENABLE TRIGGER trg_message_urgency_immutable");
      }
      await put(snoozePath(), bob, { duration_minutes: 60 });
      const push = async (messageId: string) =>
        (await deliveries((await mention(bob, { channelId: channel, messageId })).alertId)).find(
          (r) => r.channel === "push",
        )?.status;
      expect(await push(urgentMsg)).toBe("pending");
      // the same snooze still quiets a routine message, and a mention naming no message is never quieted
      expect(await push(routineMsg)).toBe("skipped_quiet_hours");
      const noMessage = await mention(bob, { channelId: channel });
      expect((await deliveries(noMessage.alertId)).find((r) => r.channel === "push")?.status).toBe(
        "pending",
      );
    });
  });

  describe("bounds", () => {
    it("the 24-hour and 30-day CHECKs hold against a caller that skips the service", async () => {
      await reset();
      const m = await send();
      const attempt = (sql: string, params: unknown[]) =>
        asApp(ORG_A, alice, async (q) => sqlError(q(sql, params)));
      const snooze = (interval: string) =>
        attempt(
          `INSERT INTO message_snooze (organization_id,user_id,channel_id,snoozed_until) VALUES ($1,$2,$3, now() + interval '${interval}')`,
          [ORG_A, alice, channel],
        );
      expect((await snooze("24 hours 1 second"))?.code).toBe("23514");
      expect((await snooze("-1 minute"))?.code).toBe("23514");
      expect(await snooze("23 hours 59 minutes")).toBeNull();
      const reminder = (interval: string) =>
        attempt(
          `INSERT INTO message_reminder (organization_id,user_id,channel_id,message_id,remind_at) VALUES ($1,$2,$3,$4, now() + interval '${interval}')`,
          [ORG_A, alice, channel, m],
        );
      expect((await reminder("30 days 1 minute"))?.code).toBe("23514");
      expect((await reminder("-1 minute"))?.code).toBe("23514");
      expect(await reminder("29 days")).toBeNull();
    });

    it("the route enforces the same edges", async () => {
      await reset();
      for (const minutes of [4, 1441]) {
        expect((await put(snoozePath(), alice, { duration_minutes: minutes })).statusCode).toBe(
          422,
        );
      }
      expect((await put(snoozePath(), alice, { duration_minutes: 1440 })).statusCode).toBe(200);
      const m = await send();
      expect((await put(reminderPath(m), alice, { remind_at: inMin(0) })).statusCode).toBe(422);
      expect(
        (await put(reminderPath(m), alice, { remind_at: inMin(30 * 24 * 60 + 1) })).statusCode,
      ).toBe(422);
      expect(
        (await put(reminderPath(m), alice, { remind_at: "2030-01-01T10:00:00" })).statusCode,
      ).toBe(422);
      expect(
        (await put(reminderPath(m), alice, { remind_at: inMin(30 * 24 * 60 - 1) })).statusCode,
      ).toBe(200);
    });

    it("holds at 25 pending reminders even with 8 sets racing past the cap", async () => {
      await reset();
      const ids: string[] = [];
      for (let i = 0; i < REMINDER_MAX_PENDING + 4; i += 1) ids.push(await send());
      for (const m of ids.slice(0, REMINDER_MAX_PENDING - 4)) {
        expect((await put(reminderPath(m), alice, { remind_at: inMin(60) })).statusCode).toBe(200);
      }
      const racers = ids.slice(REMINDER_MAX_PENDING - 4, REMINDER_MAX_PENDING + 4);
      const results = await Promise.all(
        racers.map((m) => put(reminderPath(m), alice, { remind_at: inMin(60) })),
      );
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(4);
      const refused = results.filter((r) => r.statusCode === 409);
      expect(refused).toHaveLength(4);
      for (const r of refused) expect(errorCode(r)).toBe("REMINDER_LIMIT_REACHED");
      expect(await reminderRows(alice)).toBe(REMINDER_MAX_PENDING);
      // Replacing an existing reminder at the cap still works, and a colleague has their own allowance.
      expect(
        (await put(reminderPath(ids[0] as string), alice, { remind_at: inMin(90) })).statusCode,
      ).toBe(200);
      expect(
        (await put(reminderPath(racers[0] as string), bob, { remind_at: inMin(90) })).statusCode,
      ).toBe(200);
    });
  });

  describe("reminders on urgent messages", () => {
    it("an open request on the message refuses a reminder through the route and the trigger", async () => {
      await reset();
      const { id, messageId } = await openRequest(alice, bob);
      const res = await put(reminderPath(messageId), bob, { remind_at: inMin(30) });
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe("REMINDER_URGENT_NOT_ALLOWED");
      const refused = await asApp(ORG_A, bob, async (q) =>
        sqlError(
          q(
            "INSERT INTO message_reminder (organization_id,user_id,channel_id,message_id,remind_at) VALUES ($1,$2,$3,$4, now() + interval '1 hour')",
            [ORG_A, bob, channel, messageId],
          ),
        ),
      );
      expect(refused?.code).toBe("23514");
      expect(refused?.message).toContain("message_reminder_urgent");
      expect(await reminderRows()).toBe(0);
      await closeRequest(id);
    });

    it("an urgent message refuses a reminder through the route and the trigger", async () => {
      await reset();
      const messageId = await send(channel, alice);
      // Test-only: urgency is fixed at send by a trigger; bypass it as the superuser to get an urgent row without the whole urgent entry.
      await kit.admin.query("ALTER TABLE message DISABLE TRIGGER trg_message_urgency_immutable");
      try {
        await kit.admin.query(
          "UPDATE message SET urgency='urgent', urgent_recipient_user_id=$2 WHERE id=$1",
          [messageId, bob],
        );
      } finally {
        await kit.admin.query("ALTER TABLE message ENABLE TRIGGER trg_message_urgency_immutable");
      }
      const res = await put(reminderPath(messageId), bob, { remind_at: inMin(30) });
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe("REMINDER_URGENT_NOT_ALLOWED");
      const refused = await asApp(ORG_A, bob, async (q) =>
        sqlError(
          q(
            "INSERT INTO message_reminder (organization_id,user_id,channel_id,message_id,remind_at) VALUES ($1,$2,$3,$4, now() + interval '1 hour')",
            [ORG_A, bob, channel, messageId],
          ),
        ),
      );
      expect(refused?.code).toBe("23514");
      expect(await reminderRows()).toBe(0);
    });
  });

  describe("IDOR and tenancy through the routes", () => {
    it("a non-member, another tenant and a stranger's id are one identical 404 and write nothing", async () => {
      await reset();
      const m = await send();
      const shape = (r: { json(): { error: Record<string, unknown> } }) => ({
        ...r.json().error,
        correlationId: undefined,
      });
      const nonMember = await put(snoozePath(), carol, { duration_minutes: 60 });
      const otherTenant = await put(snoozePath(), dan, { duration_minutes: 60 }, undefined, ORG_B);
      const unknown = await put(snoozePath(randomUUID()), alice, { duration_minutes: 60 });
      for (const r of [nonMember, otherTenant, unknown]) expect(r.statusCode).toBe(404);
      expect(shape(nonMember)).toEqual(shape(unknown));
      const rem = [
        await put(reminderPath(m), carol, { remind_at: inMin(30) }),
        await put(reminderPath(m), dan, { remind_at: inMin(30) }, undefined, ORG_B),
        await put(reminderPath(randomUUID()), alice, { remind_at: inMin(30) }),
      ];
      for (const r of rem) expect(r.statusCode).toBe(404);
      expect(shape(rem[0] as never)).toEqual(shape(rem[2] as never));
      expect(await snoozeRows()).toBe(0);
      expect(await reminderRows()).toBe(0);
      // Cancelling someone else's reminder is a no-op.
      await put(reminderPath(m), alice, { remind_at: inMin(30) });
      const del = await app.inject({
        method: "DELETE",
        url: reminderPath(m),
        headers: as(bob, ORG_A),
      });
      expect(del.json()).toEqual({ cleared: false });
      expect(await reminderRows(alice)).toBe(1);
    });

    it("the feature off is the uniform 404 on every route and writes nothing", async () => {
      await reset();
      flagOn = false;
      const m = await send();
      const calls = [
        app.inject({ method: "GET", url: snoozePath(), headers: as(alice, ORG_A) }),
        put(snoozePath(), alice, { duration_minutes: 60 }),
        app.inject({
          method: "GET",
          url: "/api/v1/messaging/reminders",
          headers: as(alice, ORG_A),
        }),
        put(reminderPath(m), alice, { remind_at: inMin(30) }),
      ];
      for (const r of await Promise.all(calls)) expect(r.statusCode).toBe(404);
      expect(await snoozeRows()).toBe(0);
      expect(await reminderRows()).toBe(0);
    });
  });

  describe("idempotent retry and audit", () => {
    it("the same Idempotency-Key replays the stored answer (the end is not recomputed)", async () => {
      await reset();
      const key = `idem-${randomUUID()}`;
      const first = await put(snoozePath(), alice, { duration_minutes: 60 }, key);
      await new Promise((r) => setTimeout(r, 25));
      const again = await put(snoozePath(), alice, { duration_minutes: 60 }, key);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual(first.json());
      expect(await snoozeRows(alice)).toBe(1);
      // A different key is a new request: the window moves.
      const moved = await put(snoozePath(), alice, { duration_minutes: 60 });
      expect(moved.json().snoozed_until).not.toBe(first.json().snoozed_until);
      expect(await snoozeRows(alice)).toBe(1);
    });

    it("every write is audited and the audit rows carry no message text", async () => {
      await reset();
      await put(snoozePath(), alice, { duration_minutes: 60 });
      const m = await send();
      await put(reminderPath(m), alice, { remind_at: inMin(30) });
      const rows = (
        await kit.admin.query(
          "SELECT event_type, after FROM audit_event WHERE event_type IN ('message_snooze.insert','message_reminder.insert') ORDER BY event_type",
        )
      ).rows as Array<{ event_type: string; after: unknown }>;
      const kinds = new Set(rows.map((r) => r.event_type));
      expect([...kinds].sort()).toEqual(["message_reminder.insert", "message_snooze.insert"]);
      expect(JSON.stringify(rows)).not.toContain("MRN");
      expect(JSON.stringify(rows)).not.toContain("morphine");
    });
  });

  describe("the reminder sweep", () => {
    const deps = (over: Partial<Parameters<typeof sweepRemindersForOrg>[0]> = {}) => ({
      isEnabled: async () => flagOn,
      store: sweepStore(),
      alerts: emitter(),
      canViewChannel: kit.service.canViewChannel,
      ...over,
    });
    const makeDue = async (user: string, messageId: string, agoMinutes = 1) => {
      await put(reminderPath(messageId), user, { remind_at: inMin(30) });
      await kit.admin.query(
        "UPDATE message_reminder SET set_at = now() - interval '30 days', remind_at = now() - make_interval(mins => $2) WHERE message_id = $1 AND user_id = $3",
        [messageId, agoMinutes, user],
      );
    };
    const reminderAlerts = async (user: string) =>
      (
        await kit.admin.query(
          `SELECT a.id, a.payload FROM alert a JOIN notification_delivery d ON d.alert_id = a.id
            WHERE a.event_type = 'm36.reminder.due' AND d.recipient_user_id = $1 AND d.channel::text = 'in_app'`,
          [user],
        )
      ).rows as Array<{ id: string; payload: Record<string, unknown> }>;
    const clearAlerts = () =>
      kit.admin.query("DELETE FROM alert WHERE event_type = 'm36.reminder.due'");

    it("raises ONE alert to the owner (ids and fixed text only), deletes the row, and is a no-op on a repeat", async () => {
      await reset();
      await clearAlerts();
      const m = await send();
      await makeDue(alice, m);
      expect(await sweepRemindersForOrg(deps(), ORG_A)).toEqual({
        raised: 1,
        dropped: 0,
        failed: 0,
      });
      const alerts = await reminderAlerts(alice);
      expect(alerts).toHaveLength(1);
      expect(Object.keys(alerts[0]?.payload ?? {}).sort()).toEqual([
        "channelId",
        "deepLink",
        "message",
        "messageId",
        "recipientUserId",
      ]);
      expect(JSON.stringify(alerts)).not.toContain("morphine");
      expect(await reminderAlerts(bob)).toHaveLength(0);
      expect(await reminderRows()).toBe(0);
      expect(await sweepRemindersForOrg(deps(), ORG_A)).toEqual({
        raised: 0,
        dropped: 0,
        failed: 0,
      });
      expect(await reminderAlerts(alice)).toHaveLength(1);
    });

    it("a crash between the alert and the delete re-raises the SAME alert (no duplicate)", async () => {
      await reset();
      await clearAlerts();
      const m = await send();
      await makeDue(alice, m);
      let first = true;
      const crashing = deps({
        store: {
          ...sweepStore(),
          remove: async (org, row) => {
            if (first) {
              first = false;
              throw new Error("crash before delete");
            }
            return sweepStore().remove(org, row);
          },
        },
      });
      expect(await sweepRemindersForOrg(crashing, ORG_A)).toEqual({
        raised: 0,
        dropped: 0,
        failed: 1,
      });
      expect(await reminderRows()).toBe(1);
      expect(await sweepRemindersForOrg(crashing, ORG_A)).toEqual({
        raised: 1,
        dropped: 0,
        failed: 0,
      });
      expect(await reminderAlerts(alice)).toHaveLength(1);
      expect(await reminderRows()).toBe(0);
    });

    it("drops (raising nothing) a reminder whose message was deleted, whose owner left the conversation, or that is stale", async () => {
      await reset();
      await clearAlerts();
      const deleted = await send();
      const left = await send();
      const stale = await send();
      await makeDue(alice, deleted);
      await makeDue(bob, left);
      await makeDue(alice, stale, 8 * 24 * 60);
      await kit.admin.query("UPDATE message SET status='deleted', deleted_at=now() WHERE id=$1", [
        deleted,
      ]);
      await kit.admin.query("DELETE FROM channel_member WHERE user_id=$1 AND channel_id=$2", [
        bob,
        channel,
      ]);
      try {
        expect(await sweepRemindersForOrg(deps(), ORG_A)).toEqual({
          raised: 0,
          dropped: 3,
          failed: 0,
        });
      } finally {
        await kit.admin.query(
          "INSERT INTO channel_member (organization_id, channel_id, user_id, role, source) VALUES ($1,$2,$3,'member','manual')",
          [ORG_A, channel, bob],
        );
      }
      expect(await reminderAlerts(alice)).toHaveLength(0);
      expect(await reminderAlerts(bob)).toHaveLength(0);
      expect(await reminderRows()).toBe(0);
    });

    it("leaves every row alone while the flag is off, and never touches another tenant's rows", async () => {
      await reset();
      const m = await send();
      await makeDue(alice, m);
      flagOn = false;
      expect(await sweepRemindersForOrg(deps(), ORG_A)).toEqual({
        raised: 0,
        dropped: 0,
        failed: 0,
      });
      expect(await reminderRows()).toBe(1);
      flagOn = true;
      // The sweep of org B (the session tenant) cannot list org A's due rows.
      expect(await sweepStore().listDue(ORG_B, 50)).toEqual([]);
      expect((await sweepStore().listDue(ORG_A, 50)).map((r) => r.userId)).toEqual([alice]);
      expect(await reminderRows()).toBe(1);
    });

    it("a due reminder goes through the ordinary pipeline: in-app pending, no message text anywhere on the alert", async () => {
      await reset();
      await clearAlerts();
      const m = await send();
      await makeDue(bob, m);
      await sweepRemindersForOrg(deps(), ORG_A);
      const rows = (
        await kit.admin.query(
          `SELECT d.channel::text AS channel, d.status::text AS status FROM notification_delivery d JOIN alert a ON a.id = d.alert_id
            WHERE a.event_type = 'm36.reminder.due' AND d.recipient_user_id = $1`,
          [bob],
        )
      ).rows;
      expect(rows).toEqual([{ channel: "in_app", status: "pending" }]);
      const stored = (
        await kit.admin.query("SELECT payload FROM alert WHERE event_type = 'm36.reminder.due'")
      ).rows;
      expect(JSON.stringify(stored)).not.toMatch(/Okafor|MRN|morphine/);
    });
  });
});
