/**
 * M36 gap closure B (ADR-0079) - the unreachable watch, the supervisor page and the stalled-escalation figure, LIVE Postgres as the
 * NOBYPASSRLS `wardenx_app` role (and, when CHARTWARDEN_TEST_REDIS_URL is set, a real Valkey for the notice claims).
 *
 * The REAL Drizzle ack store, alert-emitter ports (rules seeded as the boot persister writes them, role_set recipients through
 * membership_role, verified endpoints through migration 1123, the M1 feature-flag reader, persistence) and stats reader; only the
 * clock is fixed. Proves:
 *   1. G-5  a `failed_unreachable` request past its deadline is raised to the supervisor role once per stage, a second worker (fresh
 *           claims, a flushed Valkey) converges on the same alert row, the next stage is a new alert, and it is bounded;
 *   2. G-5  nothing is raised before the deadline, with `messaging.escalation_timers` off, for another tenant, or for a request that is
 *           not failed_unreachable; the request itself is never written;
 *   3. G-3  with `messaging.notification_policy` + `messaging.ack_requests` on, a supervisor with a VERIFIED endpoint gets a push row
 *           (the class floor) and one without stays in-app only; with the flags off, or nobody verified, the unpaged ops notice fires;
 *   4. G-3  the alert payload is fixed text, ids and codes: no channel, message, patient or name;
 *   5. G-4  the stalled figure counts an overdue pending request the sweep should have handled, not one in its unroutable backoff, not
 *           failed_unreachable, and reads 0 when the tenant's escalation flag is off;
 *   6. G-4  the Valkey claim is `SET NX PX`: exactly one of two processes holds it until release.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... [CHARTWARDEN_TEST_REDIS_URL=redis://localhost:PORT] bun run test:m36:ack-unwatched:live
 * Use a PRIVATE pgvector/pgvector:pg18 container (and a private valkey/valkey:8): the suite resets the public schema and the wardenx_* roles.
 */
import { createAlertEmitter } from "@chartwarden/messaging";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrizzleFeatureFlagReader } from "../src/bootstrap/feature-flag-store";
import { createOpsNoticeClaims } from "../src/bootstrap/ops-notice-claims";
import { createUnreachableWatch } from "../src/modules/36-messaging/ack-escalation/unreachable-watch";
import { createDbAckQueueStatsReader } from "../src/modules/36-messaging/ack-requests/ack-queue-stats-db";
import { createDbAckStore } from "../src/modules/36-messaging/ack-requests/ack-store-db";
import { wireAlertRuleSeed } from "../src/modules/36-messaging/alert-rule-seed-persister";
import { createDrizzleAlertEmitterPorts } from "../src/modules/36-messaging/index";
import { type LiveKit, STAFF_KEYS, bootLiveKit, mkChannel } from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const REDIS_URL = process.env.CHARTWARDEN_TEST_REDIS_URL;
const ORG_A = "11111111-1111-4111-8111-11110a790001";
const ORG_B = "22222222-2222-4222-8222-22220a790002";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a79a1";
const TIMERS = "messaging.escalation_timers";
const POLICY = "messaging.notification_policy";
const ACK = "messaging.ack_requests";
const ATTENTION = "m36.ack.supervisor_attention";
const HOUR = 3_600_000;
const MIN = 60_000;
const SECRET = "Okafor MRN 88421 morphine";

describe.skipIf(!DB_URL)("M36 gap closure B (ADR-0079) - LIVE Postgres", () => {
  let kit: LiveKit;
  let nurse: string;
  let rn: string;
  let supervisor: string;
  let supervisorNoEndpoint: string;
  let supervisorB: string;
  let channel: string;
  let clock = new Date();
  const flagsReader = () => createDrizzleFeatureFlagReader(kit.handle.db);
  const notices: Array<{ kind: string; details: Record<string, unknown> }> = [];

  const setFlags = async (org: string, flags: Record<string, boolean>) => {
    await kit.admin.query("DELETE FROM feature_flag WHERE organization_id = $1", [org]);
    for (const [key, value] of Object.entries(flags)) {
      await kit.admin.query(
        `INSERT INTO feature_flag (organization_id,flag_key,value_type,value) VALUES ($1,$2,'bool',$3::jsonb)`,
        [org, key, JSON.stringify(value)],
      );
    }
  };
  const addRole = async (org: string, userId: string, key: string) => {
    const roleId =
      (
        await kit.one<{ id: string }>("SELECT id FROM role WHERE organization_id=$1 AND key=$2", [
          org,
          key,
        ])
      )[0]?.id ??
      ((
        await kit.admin.query(
          "INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,$2,'admin_executive') RETURNING id",
          [org, key],
        )
      ).rows[0].id as string);
    const membershipId = (
      await kit.one<{ id: string }>(
        "SELECT id FROM membership WHERE user_id=$1 AND organization_id=$2",
        [userId, org],
      )
    )[0]?.id as string;
    await kit.admin.query(
      "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
      [org, membershipId, roleId],
    );
  };
  const flagOn = (org: string) =>
    flagsReader()
      .forOrg(org)
      .then((f) => f[TIMERS] === true);

  /** A fresh worker: its own claims (a new process, or a flushed Valkey) over the real store and the real emitter. */
  const makeWatch = (claims = createOpsNoticeClaims(undefined, () => clock.getTime())) => {
    const ports = createDrizzleAlertEmitterPorts(kit.handle.db, { flags: flagsReader() });
    return createUnreachableWatch({
      store: createDbAckStore(kit.handle.db),
      isEnabled: flagOn,
      claims,
      attention: {
        alerts: createAlertEmitter({ ...ports, now: () => clock }),
        opsNotice: (n) => notices.push({ kind: n.kind, details: { ...n.details } }),
      },
      now: () => clock,
    });
  };

  /** A request is BORN pending (the insert guard); failed_unreachable is reached by the legal transition. */
  const born = async (
    org: string,
    requester: string,
    assignee: string,
    ch: string,
    minutes = 15,
  ) => {
    const messageId = (
      await kit.service.sendMessage(org, { channelId: ch, authorUserId: requester, body: SECRET })
    ).messageId;
    return (
      await kit.admin.query(
        `INSERT INTO message_acknowledgment_request
           (organization_id, message_id, channel_id, patient_id, ack_class, requester_user_id, assigned_user_id, requested_at, window_started_at, deadline_at)
         VALUES ($1,$2,$3,$4,'important',$5,$6,now(),now(), now() + make_interval(mins => $7)) RETURNING id, deadline_at`,
        [org, messageId, ch, PATIENT, requester, assignee, minutes],
      )
    ).rows[0] as { id: string; deadline_at: Date };
  };
  const unreachable = (id: string) =>
    kit.admin.query(
      "UPDATE message_acknowledgment_request SET status='failed_unreachable', version=version+1 WHERE id=$1",
      [id],
    );
  const attentionAlerts = (org = ORG_A) =>
    kit.one<{ id: string; payload: Record<string, unknown>; correlation_id: string }>(
      "SELECT id, payload, correlation_id FROM alert WHERE organization_id=$1 AND event_type=$2 ORDER BY created_at, id",
      [org, ATTENTION],
    );
  const deliveriesOf = (alertId: string) =>
    kit.one<{ recipient_user_id: string; channel: string; status: string }>(
      "SELECT recipient_user_id, channel::text, status::text FROM notification_delivery WHERE alert_id=$1 ORDER BY recipient_user_id, channel::text",
      [alertId],
    );

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp79");
    nurse = await kit.seedUser("nurse", ORG_A, STAFF_KEYS);
    rn = await kit.seedUser("rn", ORG_A, STAFF_KEYS);
    supervisor = await kit.seedUser("supervisor", ORG_A, STAFF_KEYS);
    supervisorNoEndpoint = await kit.seedUser("supervisor2", ORG_A, STAFF_KEYS);
    supervisorB = await kit.seedUser("supervisorb", ORG_B, STAFF_KEYS);
    await addRole(ORG_A, supervisor, "clinical_supervisor");
    await addRole(ORG_A, supervisorNoEndpoint, "don");
    await addRole(ORG_B, supervisorB, "clinical_supervisor");
    channel = await mkChannel(kit, "care_team", PATIENT, [nurse, rn]);
    await wireAlertRuleSeed(kit.handle.db);
    await kit.admin.query(
      `INSERT INTO delivery_endpoint (user_id,channel,endpoint_value,verification_status,verified_at)
       VALUES ($1,'push','sub-secret-sup','verified', now())`,
      [supervisor],
    );
  }, 240_000);

  afterAll(async () => {
    await kit?.close();
  });

  it("the app connection is a NOBYPASSRLS role, so every assertion below is under RLS", async () => {
    const r = await kit.one<{ rolbypassrls: boolean; rolsuper: boolean }>(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'wardenx_app'",
    );
    expect(r[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    const who = await kit.appConn.query("SELECT current_user AS u");
    expect(who.rows[0].u).toBe("wardenx_app");
  });

  describe("G-5 the watch", () => {
    let req: { id: string; deadline_at: Date };

    beforeAll(async () => {
      await setFlags(ORG_A, { [TIMERS]: true });
      req = await born(ORG_A, nurse, rn, channel);
      await unreachable(req.id);
    });

    it("raises nothing before the deadline", async () => {
      clock = new Date(req.deadline_at.getTime() - MIN);
      expect(await makeWatch().watch(ORG_A)).toEqual({ raised: 0, failed: 0 });
      expect(await attentionAlerts()).toHaveLength(0);
    });

    it("raises the supervisor alert once the deadline has passed, to the supervisor roles, and not again on the next tick", async () => {
      clock = new Date(req.deadline_at.getTime() + MIN);
      const watch = makeWatch();
      expect(await watch.watch(ORG_A)).toEqual({ raised: 1, failed: 0 });
      expect(await watch.watch(ORG_A)).toEqual({ raised: 0, failed: 0 });
      const alerts = await attentionAlerts();
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.correlation_id).toMatch(new RegExp(`^ack-unwatched:${req.id}:\\d+:0$`));
      const to = (await deliveriesOf(alerts[0]?.id as string))
        .map((d) => d.recipient_user_id)
        .sort();
      expect(to).toEqual([supervisor, supervisorNoEndpoint].sort());
      expect(notices.filter((n) => n.kind === "m36.ack.failed_unreachable_unwatched")).toHaveLength(
        1,
      );
    });

    it("a second worker with fresh claims (flushed Valkey) converges on the same alert row", async () => {
      await makeWatch().watch(ORG_A);
      expect(await attentionAlerts()).toHaveLength(1);
    });

    it("the next stage (1 h later) is a new alert, and the schedule is bounded", async () => {
      const watch = makeWatch();
      clock = new Date(req.deadline_at.getTime() + HOUR + MIN);
      expect((await watch.watch(ORG_A)).raised).toBe(1);
      expect(await attentionAlerts()).toHaveLength(2);
      clock = new Date(req.deadline_at.getTime() + 365 * 24 * HOUR);
      expect((await makeWatch().watch(ORG_A)).raised).toBe(0);
      expect(await attentionAlerts()).toHaveLength(2);
    });

    it("never writes the request", async () => {
      const row = await kit.one<{ status: string }>(
        "SELECT status::text FROM message_acknowledgment_request WHERE id=$1",
        [req.id],
      );
      expect(row[0]?.status).toBe("failed_unreachable");
    });

    it("the alert is fixed text with ids and codes only: no channel, message, patient or name", async () => {
      const [first] = await attentionAlerts();
      expect(Object.keys(first?.payload ?? {}).sort()).toEqual(
        ["ackClass", "deepLink", "message", "reason", "requestId"].sort(),
      );
      expect(JSON.stringify(first?.payload)).not.toContain("Okafor");
      expect(first?.payload.deepLink).toBe("/messaging/unacknowledged");
    });

    it("does nothing with the escalation flag off, for another tenant's supervisors, or for a request that is not failed_unreachable", async () => {
      const before = (await attentionAlerts()).length;
      const pending = await born(ORG_A, nurse, rn, channel);
      clock = new Date(pending.deadline_at.getTime() + MIN);
      await makeWatch().watch(ORG_A);
      expect(await attentionAlerts()).toHaveLength(before); // pending: the timer's job, not the watch's

      const other = await born(ORG_A, nurse, rn, channel);
      await unreachable(other.id);
      await setFlags(ORG_A, {});
      expect(await makeWatch().watch(ORG_A)).toEqual({ raised: 0, failed: 0 });
      expect(await attentionAlerts()).toHaveLength(before);
      await setFlags(ORG_A, { [TIMERS]: true });

      expect(await attentionAlerts(ORG_B)).toHaveLength(0);
      const toB = await kit.one(
        "SELECT 1 FROM notification_delivery nd JOIN alert a ON a.id=nd.alert_id WHERE a.event_type=$1 AND nd.recipient_user_id=$2",
        [ATTENTION, supervisorB],
      );
      expect(toB).toHaveLength(0);
    });
  });

  describe("G-3 the supervisor page", () => {
    it("flags off (the default): in-app only for every supervisor, and the unpaged ops notice says so", async () => {
      await setFlags(ORG_A, { [TIMERS]: true });
      const req = await born(ORG_A, nurse, rn, channel);
      await unreachable(req.id);
      clock = new Date(req.deadline_at.getTime() + MIN);
      notices.length = 0;
      await makeWatch().watch(ORG_A);
      const alert = (await attentionAlerts()).find((a) => a.correlation_id.includes(req.id));
      expect((await deliveriesOf(alert?.id as string)).map((d) => d.channel)).toEqual([
        "in_app",
        "in_app",
      ]);
      // Earlier requests are still overdue and unreachable at this clock, so look at THIS request's notice.
      const unpaged = notices.filter(
        (n) => n.kind === "m36.ack.supervisor_unpaged" && n.details.requestId === req.id,
      );
      expect(unpaged).toHaveLength(1);
      expect(unpaged[0]?.details).toMatchObject({
        organizationId: ORG_A,
        requestId: req.id,
        supervisors: 2,
      });
    });

    it("both policy flags on: the supervisor with a verified endpoint is paged (push row), the other stays in-app only", async () => {
      const second = await born(ORG_A, nurse, rn, channel);
      await unreachable(second.id);
      clock = new Date(second.deadline_at.getTime() + MIN);
      await setFlags(ORG_A, { [TIMERS]: true, [POLICY]: true, [ACK]: true });
      notices.length = 0;
      await makeWatch().watch(ORG_A);
      const alert = (await attentionAlerts()).find((a) => a.correlation_id.includes(second.id));
      const rows = await deliveriesOf(alert?.id as string);
      expect(rows.filter((r) => r.channel === "push")).toEqual([
        { recipient_user_id: supervisor, channel: "push", status: "pending" },
      ]);
      expect(
        rows.filter((r) => r.recipient_user_id === supervisorNoEndpoint).map((r) => r.channel),
      ).toEqual(["in_app"]);
      expect(
        notices.filter(
          (n) => n.kind === "m36.ack.supervisor_unpaged" && n.details.requestId === second.id,
        ),
      ).toHaveLength(0);
    });

    it("policy on but no supervisor has a verified endpoint: still visible - the unpaged ops notice fires", async () => {
      await kit.admin.query(
        "UPDATE delivery_endpoint SET verification_status='pending' WHERE user_id=$1",
        [supervisor],
      );
      const third = await born(ORG_A, nurse, rn, channel);
      await unreachable(third.id);
      clock = new Date(third.deadline_at.getTime() + MIN);
      notices.length = 0;
      await makeWatch().watch(ORG_A);
      expect(
        notices.filter(
          (n) => n.kind === "m36.ack.supervisor_unpaged" && n.details.requestId === third.id,
        ),
      ).toHaveLength(1);
      await kit.admin.query(
        "UPDATE delivery_endpoint SET verification_status='verified' WHERE user_id=$1",
        [supervisor],
      );
    });
  });

  describe("G-4 the stalled figure", () => {
    it("counts an overdue pending request the sweep should have handled; 0 with the flag off; failed_unreachable and backed-off requests are not counted", async () => {
      await setFlags(ORG_A, { [TIMERS]: true });
      await kit.admin.query("DELETE FROM message_acknowledgment_event");
      await kit.admin.query("DELETE FROM message_acknowledgment_request");
      const stalled = await born(ORG_A, nurse, rn, channel, 60);
      const backedOff = await born(ORG_A, nurse, rn, channel, 60);
      const dead = await born(ORG_A, nurse, rn, channel, 60);
      await unreachable(dead.id);
      await kit.admin.query(
        `INSERT INTO message_acknowledgment_event
           (organization_id, request_id, event_type, actor_kind, from_status, to_status, assigned_user_id, tier)
         VALUES ($1,$2,'route_unavailable','system','pending','pending',$3,1)`,
        [ORG_A, backedOff.id, rn],
      );
      const now = new Date(stalled.deadline_at.getTime() + 20 * MIN);
      const reader = createDbAckQueueStatsReader(kit.handle.db, { isEscalationEnabled: flagOn });
      const on = await reader(ORG_A, now);
      // Only `stalled` counts: the other two share its deadline but are excluded (backoff; unreachable).
      expect(on.escalationStalledSeconds).toBeGreaterThanOrEqual(20 * 60 - 1);
      expect(on.escalationStalledSeconds).toBeLessThan(21 * 60);
      expect(on.overdue).toBe(3); // the existing gauge still counts all three
      await setFlags(ORG_A, {});
      expect((await reader(ORG_A, now)).escalationStalledSeconds).toBe(0);
      expect(
        (await createDbAckQueueStatsReader(kit.handle.db)(ORG_B, now)).escalationStalledSeconds,
      ).toBe(0);
    });
  });

  describe.skipIf(!REDIS_URL)("G-4 the Valkey claim", () => {
    it("is SET NX PX: one of two processes holds the key until it is released", async () => {
      const redis = new Redis(REDIS_URL as string);
      try {
        const a = createOpsNoticeClaims(redis);
        const b = createOpsNoticeClaims(redis);
        const key = `wp79:${Date.now()}`;
        expect(await a.claim(key, 5_000)).toBe(true);
        expect(await b.claim(key, 5_000)).toBe(false);
        await b.release(key);
        expect(await a.claim(key, 5_000)).toBe(true);
        await a.release(key);
      } finally {
        redis.disconnect();
      }
    });
  });
});
