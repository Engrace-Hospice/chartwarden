/**
 * GAP-043 - the worker-role listener-health watcher against a real database, as the NOBYPASSRLS `wardenx_app` role, with
 * the REAL catalog-validating outbox publisher, the REAL outbox relay (`createOutboxDispatcher`), the REAL M36 consumer and
 * the REAL Drizzle `AlertEmitter` over the real platform-default `alert_rule` seed.
 *
 * The scenario the in-process tick can never detect: the listener process is DEAD (no ticks, a stale heartbeat, nothing
 * bound). The watcher notices from the heartbeat + a real TCP probe, publishes `m29.external_feed.listener_down` in the same
 * transaction as the state change, the relay hands it to the M36 consumer, and the compliance officer + org admin of THAT
 * tenant get the page. Then: an alive-but-quiet feed stays half_open with no page; a frame closes the outage and the paired
 * `listener_recovered` notice goes out; an expected quiet window suppresses the page; tenants are isolated.
 *
 * The probe is a real socket: `probeTcpPort` against a closed port (nobody listening) and against a real
 * `net.createServer` (listener alive). NOT covered here: a real mTLS listener process dying (the listener supervisor has its
 * own live suite, gap-086-m29-listener, which also proves the heartbeat fact is written).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:gap043:listener-watch:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite DROPs the wardenx_* roles.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M29_OUTBOX_EVENTS } from "../src/modules/29-external-interfaces/events-by-m29";
import { createDrizzleFeedHealthStore } from "../src/modules/29-external-interfaces/listener/health-store-drizzle";
import {
  HEARTBEAT_STALE_MS,
  runFeedHealthWatch,
} from "../src/modules/29-external-interfaces/listener/health-watch";
import { createDrizzleFeedWatchStore } from "../src/modules/29-external-interfaces/listener/health-watch-store-drizzle";
import { probeTcpPort } from "../src/modules/29-external-interfaces/listener/tcp-probe";
import {
  createDrizzleAlertEmitter,
  registerMessagingSeams,
  wireAlertRuleSeed,
} from "../src/modules/36-messaging/index";
import { buildM36FeedHealthAlertConsumer } from "../src/modules/36-messaging/outbox-consumers/feed-health-alerts";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "aaaaaaaa-0043-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0043-4000-8000-00000000000b";
const MEMBER = "eeeeeeee-0043-4000-8000-0000000000e1";
const MINUTE = 60_000;

describe.skipIf(!DB_URL)("GAP-043 listener-health watcher - LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let emitter: ReturnType<typeof createDrizzleAlertEmitter>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let watchStore: ReturnType<typeof createDrizzleFeedWatchStore>;
  const user: Record<string, string> = {};
  const servers: net.Server[] = [];

  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (process.env.WARDENX_TEST_NO_PGVECTOR) {
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
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [`${tag}@g043.test`])
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

  /** A port with nobody listening (bind, read the number, close). */
  const freePort = (): Promise<number> =>
    new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const port = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(port));
      });
    });
  /** A real listening socket on `port` (the listener process "being alive"). */
  const listenOn = (port: number): Promise<net.Server> =>
    new Promise((resolve) => {
      const s = net.createServer((socket) => socket.destroy());
      servers.push(s);
      s.listen(port, "127.0.0.1", () => resolve(s));
    });
  const closeServer = (s: net.Server): Promise<void> => new Promise((r) => s.close(() => r()));

  async function insertFeed(
    orgId: string,
    port: number,
    over: { quiet?: unknown; threshold?: number } = {},
  ) {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO external_feed
         (id, organization_id, kind, display_name, status, protocol, port, proposed_by_membership_id,
          approved_at, created_at, expected_quiet_windows, listener_down_threshold_seconds)
       VALUES ($1,$2,'adt_inbound','Watched ADT','active','mllp_tls',$3,$4,
               now() - interval '1 day', now() - interval '1 day', $5::jsonb, $6)`,
      [
        id,
        orgId,
        port,
        MEMBER,
        over.quiet === undefined ? null : JSON.stringify(over.quiet),
        over.threshold ?? null,
      ],
    );
    return id;
  }
  const heartbeat = (feedId: string, orgId: string, ageMs: number, bound: boolean) =>
    admin.query(
      `INSERT INTO external_feed_listener_state (feed_id, organization_id, listener_heartbeat_at, listener_bound)
       VALUES ($1,$2, now() - ($3 || ' milliseconds')::interval, $4)
       ON CONFLICT (feed_id) DO UPDATE SET listener_heartbeat_at = EXCLUDED.listener_heartbeat_at,
                                           listener_bound = EXCLUDED.listener_bound`,
      [feedId, orgId, String(ageMs), bound],
    );
  const stateOf = async (feedId: string) =>
    (
      await admin.query(
        "SELECT circuit_state, outage_opened_at FROM external_feed_listener_state WHERE feed_id = $1",
        [feedId],
      )
    ).rows[0] as { circuit_state: string; outage_opened_at: Date | null } | undefined;
  const healthStateOf = async (feedId: string) =>
    (
      await admin.query(
        "SELECT listener_circuit_state FROM external_feed_health WHERE feed_id = $1 ORDER BY hour_bucket DESC LIMIT 1",
        [feedId],
      )
    ).rows[0]?.listener_circuit_state as string | undefined;
  const eventsOf = async (feedId: string, name: string) =>
    (
      await admin.query(
        `SELECT payload FROM outbox_event WHERE event_type = $1 AND payload->>'feedId' = $2`,
        [name, feedId],
      )
    ).rows;
  const alertsOf = async (orgId: string, type: string, feedId: string) =>
    (
      await admin.query(
        `SELECT a.id, a.severity::text AS severity, a.correlation_id FROM alert a
          WHERE a.organization_id = $1 AND a.event_type = $2 AND a.correlation_id LIKE $3`,
        [orgId, type, `%${feedId}%`],
      )
    ).rows;
  const recipientsOf = async (alertId: string) =>
    (
      await admin.query(
        "SELECT DISTINCT recipient_user_id FROM notification_delivery WHERE alert_id = $1",
        [alertId],
      )
    ).rows
      .map((r) => r.recipient_user_id as string)
      .sort();
  const watch = async (probeHost = "127.0.0.1") =>
    runFeedHealthWatch({
      activeOrgs: {
        listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
      },
      store: watchStore,
      probeTcp: probeTcpPort,
      probeHost,
      now: () => new Date(),
      log: () => {},
    });

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
    await applyMigrations();
    for (const [id, slug] of [
      [ORG_A, "g043-a"],
      [ORG_B, "g043-b"],
    ] as const)
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    user.aCompliance = await addMember(ORG_A, "a-co", "compliance_officer");
    user.aAdmin = await addMember(ORG_A, "a-admin", "org_admin");
    user.bCompliance = await addMember(ORG_B, "b-co", "compliance_officer");
    user.bAdmin = await addMember(ORG_B, "b-admin", "org_admin");

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    emitter = createDrizzleAlertEmitter(handle.db);
    registerMessagingSeams({ emitter });
    await wireAlertRuleSeed(handle.db);

    // The REAL catalog-validating publisher, bound as the M29 caller (not NOOP_OUTBOX): a payload that does not match the
    // catalog schema is refused here exactly as it would be in production.
    const catalog = buildBootOutboxCatalog([M29_OUTBOX_EVENTS]);
    const publisher = buildTxOutboxPublisher(catalog);
    watchStore = createDrizzleFeedWatchStore({
      db: handle.db,
      outbox: {
        publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m29" } as never),
      },
    });
    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [buildM36FeedHealthAlertConsumer(emitter)],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 300_000);

  afterAll(async () => {
    await Promise.all(servers.map((s) => (s.listening ? closeServer(s) : Promise.resolve())));
    await handle?.close();
    if (admin) await admin.end();
  });

  describe("a DEAD listener process (stale heartbeat, nothing bound)", () => {
    let feedA: string;
    let feedB: string;
    let portA: number;

    it("the watcher opens the outage, publishes listener_down with the state, and the relay pages that tenant's people", async () => {
      portA = await freePort();
      feedA = await insertFeed(ORG_A, portA);
      await heartbeat(feedA, ORG_A, HEARTBEAT_STALE_MS + 60_000, true); // last seen alive 2.5 minutes ago
      const out = await watch();
      expect(out.wentDown).toContain(feedA);

      const state = await stateOf(feedA);
      expect(state?.circuit_state).toBe("open");
      expect(state?.outage_opened_at).not.toBeNull();
      expect(await healthStateOf(feedA)).toBe("open"); // the dashboard's rollup follows the decision
      const events = await eventsOf(feedA, "m29.external_feed.listener_down");
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        feedId: feedA,
        organizationId: ORG_A,
        state: "open",
        heartbeatStale: true,
        tcpOk: false,
      });
      expect(JSON.stringify(events[0].payload)).not.toMatch(/host|port|cert/i);

      await dispatcher.tick();
      const pages = await alertsOf(ORG_A, "external_feed.listener_down", feedA);
      expect(pages).toHaveLength(1);
      expect(pages[0].severity).toBe("critical");
      expect(pages[0].correlation_id).toContain(state?.outage_opened_at?.toISOString() ?? "never");
      expect(await recipientsOf(pages[0].id)).toEqual([user.aCompliance, user.aAdmin].sort());
    });

    it("a second pass inside the same outage publishes nothing and pages nobody again", async () => {
      await watch();
      expect(await eventsOf(feedA, "m29.external_feed.listener_down")).toHaveLength(1);
      await dispatcher.tick();
      expect(await alertsOf(ORG_A, "external_feed.listener_down", feedA)).toHaveLength(1);
    });

    it("tenant isolation: org B's own dead feed pages ONLY org B's people, and org A's rows are untouched", async () => {
      feedB = await insertFeed(ORG_B, await freePort());
      await heartbeat(feedB, ORG_B, HEARTBEAT_STALE_MS + 60_000, true);
      await watch();
      await dispatcher.tick();
      const pages = await alertsOf(ORG_B, "external_feed.listener_down", feedB);
      expect(pages).toHaveLength(1);
      expect(await recipientsOf(pages[0].id)).toEqual([user.bCompliance, user.bAdmin].sort());
      expect(await alertsOf(ORG_A, "external_feed.listener_down", feedB)).toEqual([]);
      expect(await alertsOf(ORG_B, "external_feed.listener_down", feedA)).toEqual([]);
    });

    it("the listener coming back (fresh heartbeat, port accepting) moves open -> half_open without a second page", async () => {
      await listenOn(portA);
      await heartbeat(feedA, ORG_A, 5_000, true);
      await watch();
      expect((await stateOf(feedA))?.circuit_state).toBe("half_open");
      expect(await healthStateOf(feedA)).toBe("half_open");
      expect(await eventsOf(feedA, "m29.external_feed.listener_down")).toHaveLength(1);
      await dispatcher.tick();
      expect(await alertsOf(ORG_A, "external_feed.listener_down", feedA)).toHaveLength(1);
      expect(await alertsOf(ORG_A, "external_feed.listener_recovered", feedA)).toEqual([]);
    });

    it("a frame closes the outage: listener_recovered is published and the paired notice goes out (info)", async () => {
      await admin.query(
        `INSERT INTO hl7_message_inbound
           (organization_id, feed_id, message_type, message_control_id, payload_cipher, payload_sha256,
            segments_summary, sending_facility_raw_id, idempotency_key)
         VALUES ($1,$2,'ADT^A01','CTRL-1','cipher',$3,'{}'::jsonb,'FAC',$4)`,
        [ORG_A, feedA, createHash("sha256").update("x").digest("hex"), randomUUID()],
      );
      await watch();
      const state = await stateOf(feedA);
      expect(state?.circuit_state).toBe("closed");
      expect(state?.outage_opened_at).toBeNull();
      expect(await eventsOf(feedA, "m29.external_feed.listener_recovered")).toHaveLength(1);
      await dispatcher.tick();
      const notices = await alertsOf(ORG_A, "external_feed.listener_recovered", feedA);
      expect(notices).toHaveLength(1);
      expect(notices[0].severity).toBe("info");
      expect(await recipientsOf(notices[0].id)).toEqual([user.aCompliance, user.aAdmin].sort());
      // and a further pass is quiet
      await watch();
      expect(await eventsOf(feedA, "m29.external_feed.listener_recovered")).toHaveLength(1);
    });
  });

  describe("a listener that is ALIVE but a partner that is quiet", () => {
    it("fresh heartbeat + bound + port accepting + no frames: half_open, no event, no page", async () => {
      const port = await freePort();
      const feed = await insertFeed(ORG_A, port);
      await listenOn(port);
      await heartbeat(feed, ORG_A, 5_000, true);
      await watch();
      expect((await stateOf(feed))?.circuit_state).toBe("half_open");
      expect(await eventsOf(feed, "m29.external_feed.listener_down")).toEqual([]);
    });

    it("an expected quiet window suppresses the page even with a dead listener", async () => {
      const feed = await insertFeed(ORG_A, await freePort(), {
        quiet: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59", tz: "UTC" }],
      });
      await heartbeat(feed, ORG_A, HEARTBEAT_STALE_MS + 60_000, false);
      await watch();
      expect(await eventsOf(feed, "m29.external_feed.listener_down")).toEqual([]);
      expect((await stateOf(feed))?.circuit_state).toBe("closed"); // only the heartbeat fact exists
    });

    it("a tenant-tightened 60s threshold pages a 2 minute silence that the 5 minute default would not", async () => {
      const port = await freePort();
      const feed = await insertFeed(ORG_A, port, { threshold: 60 });
      await heartbeat(feed, ORG_A, HEARTBEAT_STALE_MS + 60_000, false);
      await admin.query(
        `INSERT INTO hl7_message_inbound
           (organization_id, feed_id, message_type, message_control_id, payload_cipher, payload_sha256,
            segments_summary, sending_facility_raw_id, idempotency_key, received_at)
         VALUES ($1,$2,'ADT^A01','CTRL-T','cipher',$3,'{}'::jsonb,'FAC',$4, now() - interval '2 minutes')`,
        [ORG_A, feed, createHash("sha256").update("t").digest("hex"), randomUUID()],
      );
      await watch();
      expect(await eventsOf(feed, "m29.external_feed.listener_down")).toHaveLength(1);
    });

    it("a feed that never heartbeated is left alone inside its grace period", async () => {
      const feed = randomUUID();
      await admin.query(
        `INSERT INTO external_feed
           (id, organization_id, kind, display_name, status, protocol, port, proposed_by_membership_id,
            approved_at, created_at)
         VALUES ($1,$2,'adt_inbound','Brand new','active','mllp_tls',$3,$4, now(), now())`,
        [feed, ORG_A, await freePort(), MEMBER],
      );
      await watch();
      expect(await stateOf(feed)).toBeUndefined();
      expect(await eventsOf(feed, "m29.external_feed.listener_down")).toEqual([]);
    });
  });

  describe("the listener's heartbeat fact, written as wardenx_app", () => {
    it("heartbeat() leaves the facts without touching the watcher-owned state, and record() omitting state keeps it", async () => {
      const feedId = await insertFeed(ORG_A, await freePort());
      await admin.query(
        `INSERT INTO external_feed_listener_state (feed_id, organization_id, circuit_state, outage_opened_at)
         VALUES ($1,$2,'open', now())`,
        [feedId, ORG_A],
      );
      const store = createDrizzleFeedHealthStore({ db: handle.db });
      const descriptor = {
        id: feedId,
        organizationId: ORG_A,
        kind: "adt_inbound",
        displayName: "x",
        port: 1,
        protocol: "mllp_tls",
        status: "active",
        baaContractRef: null,
        sendingFacilityAllowlist: [],
      } as never;
      const at = new Date();
      await store.heartbeat(descriptor, { bound: true, at });
      const { rows } = await admin.query(
        "SELECT listener_bound, listener_heartbeat_at, circuit_state FROM external_feed_listener_state WHERE feed_id = $1",
        [feedId],
      );
      expect(rows[0].listener_bound).toBe(true);
      expect(new Date(rows[0].listener_heartbeat_at).getTime()).toBe(at.getTime());
      expect(rows[0].circuit_state).toBe("open"); // not clobbered by the listener

      await admin.query(
        `INSERT INTO external_feed_health (feed_id, hour_bucket, organization_id, listener_circuit_state)
         VALUES ($1, date_trunc('hour', now()), $2, 'open')`,
        [feedId, ORG_A],
      );
      await store.record(descriptor, {
        hourBucket: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000),
        upSecondsDelta: 30,
        downSecondsDelta: 0,
      });
      expect(await healthStateOf(feedId)).toBe("open"); // state omitted => the watcher's value stands
    });

    it("tenant isolation of the state table: org B sees none of org A's rows and cannot write into them", async () => {
      const app = new Client({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });
      await app.connect();
      try {
        await app.query("BEGIN");
        await app.query("SELECT set_config('app.org_id',$1,true)", [ORG_B]);
        const visible = await app.query(
          "SELECT count(*)::int AS n FROM external_feed_listener_state WHERE organization_id = $1",
          [ORG_A],
        );
        expect(visible.rows[0].n).toBe(0);
        await expect(
          app.query(
            "INSERT INTO external_feed_listener_state (feed_id, organization_id) SELECT id, organization_id FROM external_feed LIMIT 1",
          ),
        ).rejects.toBeDefined();
      } finally {
        await app.query("ROLLBACK").catch(() => undefined);
        await app.end();
      }
    });
  });
});
