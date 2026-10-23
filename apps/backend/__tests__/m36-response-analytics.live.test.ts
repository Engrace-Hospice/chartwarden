/**
 * M36 WP 6.2 (ADR-0092) - response analytics, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * The real route stack (Authorization Contract, M33's route, the M1 seam registry) over the REAL M36 reader. Rows are seeded by the
 * superuser connection (history needs timestamps in the past, so the guard triggers are bypassed with session_replication_role); every
 * READ runs as `chartwarden_app` through the route.
 *
 *   1. ACCESS      no session 401; a user without `messaging.analytics.read` 403; flag off (and flag absent) 404 for a permitted user.
 *   2. NUMBERS     the KPIs and the breakdown match what was seeded (median, in-time rate, escalation rate, handoff acceptance).
 *   3. AGGREGATES  the body carries no uuid and no person/patient/message field, whatever the breakdown.
 *   4. SMALL CELLS a group with fewer than 5 distinct people is withheld; with ONE hidden group the smallest visible one is withheld too
 *                  (no differencing); fewer than 5 people in the whole organisation is `insufficient_data`.
 *   5. BOUNDS      from >= to and a window over 92 days are refused; an unknown groupBy is refused.
 *   6. TENANCY     org B's rows never reach org A's figures (and the reverse); RLS as `chartwarden_app` shows zero foreign rows.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:response-analytics:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the chartwarden_* roles.
 */
import { randomUUID } from "node:crypto";
import { resetAbacRegistry, resetAuthorizationContract, resetRbacEngine } from "@chartwarden/auth";
import { ANALYTICS_MIN_COHORT } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, registerSeam } from "../src/bootstrap/index";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { registerMessagingResponseAnalyticsRoutes } from "../src/modules/33-reporting/routes/messaging-response-analytics.routes";
import { createResponseAnalyticsReader } from "../src/modules/36-messaging/analytics/response-analytics-reader";
import { type LiveKit, as, bootLiveKit, headerAuth, mkChannel } from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a620001";
const ORG_B = "22222222-2222-4222-8222-22220a620002";
const ROUTE = "/api/v1/messaging/analytics/response";
const KEY = "messaging.analytics.read";
const FLAG = "messaging.response_analytics";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const FORBIDDEN_FIELDS = /user|person|patient|assignee|requester|body|message|email|name/i;

describe.skipIf(!DB_URL)("M36 WP 6.2 response analytics - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  const flags: Record<string, boolean> = { [FLAG]: true };
  let viewer: string;
  let plainUser: string;
  let viewerB: string;
  let requesterA: string;
  let channelA: string;

  const get = (user: string | null, org: string, query = "") =>
    app.inject({
      method: "GET",
      url: `${ROUTE}${query}`,
      headers: user ? as(user, org) : {},
    });

  async function roleOf(org: string, key: string): Promise<string> {
    const found = await kit.one<{ id: string }>(
      `SELECT id FROM role WHERE organization_id=$1 AND key=$2`,
      [org, key],
    );
    if (found[0]) return found[0].id;
    return (
      await kit.one<{ id: string }>(
        `INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,$2,'clinical_staff') RETURNING id`,
        [org, key],
      )
    )[0]!.id;
  }

  /** A clinician of `discipline` in `org` (an active member holding that clinical role). */
  async function clinician(org: string, discipline: string, n: number): Promise<string> {
    const id = await kit.seedUser(`${discipline}${n}`, org, []);
    const roleId = await roleOf(org, discipline);
    await kit.admin.query(
      `INSERT INTO membership_role (organization_id, membership_id, role_id)
       SELECT $1, m.id, $3 FROM membership m WHERE m.user_id=$2 AND m.organization_id=$1`,
      [org, id, roleId],
    );
    return id;
  }

  /** One acknowledgment request (own message) opened `daysAgo` days ago, acknowledged after `ackSeconds` (null = still pending). */
  async function request(o: {
    org: string;
    channel: string;
    requester: string;
    assignee: string;
    daysAgo: number;
    ackSeconds: number | null;
    escalated?: boolean;
    /** Leave `updated_at` at now(): a request that changed today, so it is not yet settled. */
    changedToday?: boolean;
  }): Promise<void> {
    await kit.admin.query("SET session_replication_role = replica");
    try {
      const message = (
        await kit.admin.query(
          `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256)
           VALUES ($1,$2,$3,'user','\\x00',$4) RETURNING id`,
          [o.channel, o.org, o.requester, randomUUID().replaceAll("-", "").padEnd(64, "0")],
        )
      ).rows[0].id as string;
      const acked = o.ackSeconds !== null;
      const requestId = (
        await kit.admin.query(
          `INSERT INTO message_acknowledgment_request
             (organization_id, message_id, channel_id, patient_id, ack_class, status, requester_user_id, assigned_user_id,
              requested_at, window_started_at, deadline_at, current_tier, acknowledged_at, acknowledged_by_user_id, updated_at)
           SELECT $1,$2,$3,$4,'urgent',$5::message_ack_status,$6,$7, t, t, t + interval '20 minutes', $8,
                  CASE WHEN $9::int IS NULL THEN NULL ELSE t + ($9::int * interval '1 second') END,
                  CASE WHEN $9::int IS NULL THEN NULL ELSE $7::uuid END,
                  CASE WHEN $11::boolean THEN now() ELSE t + (coalesce($9::int, 0) * interval '1 second') END
             FROM (SELECT now() - ($10::int * interval '1 day') AS t) x
           RETURNING id`,
          [
            o.org,
            message,
            o.channel,
            randomUUID(),
            acked ? "acknowledged" : o.escalated ? "escalated" : "pending",
            o.requester,
            o.assignee,
            !acked && o.escalated ? 1 : 0,
            o.ackSeconds,
            o.daysAgo,
            o.changedToday === true,
          ],
        )
      ).rows[0].id as string;
      if (o.escalated) {
        await kit.admin.query(
          `INSERT INTO message_acknowledgment_event (organization_id, request_id, event_type, actor_kind, tier, created_at)
           VALUES ($1,$2,'escalated','system',1, CASE WHEN $3::boolean THEN now() ELSE now() - ($4::int * interval '1 day') END)`,
          [o.org, requestId, o.changedToday === true, o.daysAgo],
        );
      }
    } finally {
      await kit.admin.query("SET session_replication_role = origin");
    }
  }

  async function handoff(org: string, from: string, to: string, acceptSeconds: number | null) {
    await kit.admin.query("SET session_replication_role = replica");
    try {
      await kit.admin.query(
        `INSERT INTO clinical_handoff
           (organization_id, from_user_id, to_user_id, state, offered_at, expires_at, accepted_at, closed_at, closed_reason, updated_at)
         SELECT $1,$2,$3,$4,t,t + interval '12 hours',
                CASE WHEN $5::int IS NULL THEN NULL ELSE t + ($5::int * interval '1 second') END,
                t + interval '1 hour', 'deadline', t + interval '1 hour'
           FROM (SELECT now() - interval '2 days' AS t) x`,
        [org, from, to, acceptSeconds === null ? "expired" : "accepted", acceptSeconds],
      );
    } finally {
      await kit.admin.query("SET session_replication_role = origin");
    }
  }

  beforeAll(async () => {
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp62");
    viewer = await kit.seedUser("viewer", ORG_A, [KEY]);
    plainUser = await kit.seedUser("plain", ORG_A, ["messaging.read"]);
    viewerB = await kit.seedUser("viewerb", ORG_B, [KEY]);
    requesterA = await kit.seedUser("requester", ORG_A, []);
    const requesterB = await kit.seedUser("requesterb", ORG_B, []);
    channelA = await mkChannel(kit, "care_team", randomUUID(), []);

    // Org A (settled figures only). rn: 6 people, 23 requests (22 acked in 60 s, 1 acked in 60 s after an escalation) plus 1 still pending
    // (excluded); md: 5 people, 20 requests (19 in 180 s, 1 in 21 minutes = late); sw: 2 people, 2 requests in 600 s.
    // 45 settled requests, 13 people.
    const seedAll = async (org: string, d: string, n: number) => {
      const out: string[] = [];
      for (let i = 1; i <= n; i++) out.push(await clinician(org, d, i));
      return out;
    };
    const rn = await seedAll(ORG_A, "rn", 6);
    const md = await seedAll(ORG_A, "md", 5);
    const sw = await seedAll(ORG_A, "sw", 2);
    const open = (assignee: string, ackSeconds: number | null, escalated = false) =>
      request({
        org: ORG_A,
        channel: channelA,
        requester: requesterA,
        assignee,
        daysAgo: 3,
        ackSeconds,
        escalated,
      });
    for (let i = 0; i < 22; i++) await open(rn[i % 6]!, 60);
    await open(rn[0]!, 60, true);
    await open(rn[1]!, null); // still pending: not settled, so in no figure
    for (let i = 0; i < 19; i++) await open(md[i % 5]!, 180);
    await open(md[4]!, 21 * 60);
    for (const s of sw) await open(s, 600);
    for (const to of rn.slice(0, 5)) await handoff(ORG_A, requesterA, to, 120);
    await handoff(ORG_A, requesterA, rn[5]!, null);

    // Org B: 2 people only, so its own report is `insufficient_data`; its rows must not reach A.
    const bChannel = await mkChannel(kit, "care_team", randomUUID(), []);
    const bNurses = await seedAll(ORG_B, "rn", 2);
    await kit.admin.query(`UPDATE channel SET organization_id=$1 WHERE id=$2`, [ORG_B, bChannel]);
    for (const nurse of bNurses) {
      await request({
        org: ORG_B,
        channel: bChannel,
        requester: requesterB,
        assignee: nurse,
        daysAgo: 1,
        ackSeconds: 5,
      });
    }

    const server = buildServer({
      db: kit.handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(kit.handle.db),
    });
    registerMessagingResponseAnalyticsRoutes(server);
    app = server;
    registerSeam(
      "MessagingResponseAnalyticsReader",
      createResponseAnalyticsReader({
        db: kit.handle.db,
        flags: { forOrg: async (org) => (org === ORG_A || org === ORG_B ? flags : {}) },
      }),
    );
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await kit?.close();
  });

  it("refuses a request with no session (401) and a user without the key (403)", async () => {
    expect((await get(null, ORG_A)).statusCode).toBe(401);
    expect((await get(plainUser, ORG_A)).statusCode).toBe(403);
  });

  it("is a 404 for a permitted user while the tenant flag is off or absent", async () => {
    flags[FLAG] = false;
    expect((await get(viewer, ORG_A)).statusCode).toBe(404);
    delete flags[FLAG];
    expect((await get(viewer, ORG_A)).statusCode).toBe(404);
    flags[FLAG] = true;
  });

  it("reports the seeded KPIs for org A only (org B's rows never reach it)", async () => {
    const res = await get(viewer, ORG_A, "?groupBy=class");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.minCohort).toBe(ANALYTICS_MIN_COHORT);
    expect(body.kpis.requests).toBe(45);
    expect(body.kpis.acknowledged).toBe(45);
    expect(body.kpis.medianAckSeconds).toBe(60);
    expect(body.kpis.ackedBeforeDeadlineRate).toBeCloseTo(44 / 45, 5); // 1 late; the pending one is not settled
    expect(body.kpis.escalationRate).toBeCloseTo(1 / 45, 5);
    expect(body.kpis.handoffsOffered).toBe(6);
    expect(body.kpis.handoffsAccepted).toBe(5);
    expect(body.kpis.medianHandoffAcceptSeconds).toBe(120);
    expect(body.cells).toHaveLength(1); // one class, 13 people
    expect(body.cells[0].group).toBe("urgent");
  });

  it("carries no uuid and no person, patient or message field in any breakdown", async () => {
    for (const groupBy of ["class", "discipline"]) {
      const text = (await get(viewer, ORG_A, `?groupBy=${groupBy}`)).body;
      expect(text).not.toMatch(UUID_RE);
      const keys = new Set<string>();
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") {
          for (const [k, x] of Object.entries(v)) {
            keys.add(k);
            walk(x);
          }
        }
      };
      walk(JSON.parse(text));
      for (const k of keys) expect(k, k).not.toMatch(FORBIDDEN_FIELDS);
    }
  });

  it("withholds a small group and, with exactly one hidden, the smallest visible group as well", async () => {
    const body = (await get(viewer, ORG_A, "?groupBy=discipline")).json();
    // rn (6 people) visible; md (5) visible but smallest; sw (2) hidden -> md hidden too.
    expect(body.cells.map((c: { group: string }) => c.group)).toEqual(["rn"]);
    expect(body.suppressedGroups).toBe(2);
    const rn = body.cells[0];
    expect(rn.requests).toBe(23);
    expect(rn.medianAckSeconds).toBe(60);
  });

  it("two hidden groups whose COMBINED distinct people are under the floor also withhold the next-smallest visible group", async () => {
    // sw (2 people) + chaplain (1 person) = 3 distinct people < 5, so "total minus shown" would isolate them: md is withheld too.
    const chaplain = await clinician(ORG_A, "chaplain", 1);
    await request({
      org: ORG_A,
      channel: channelA,
      requester: requesterA,
      assignee: chaplain,
      daysAgo: 3,
      ackSeconds: 30,
    });
    const body = (await get(viewer, ORG_A, "?groupBy=discipline")).json();
    expect(body.cells.map((c: { group: string }) => c.group)).toEqual(["rn"]);
    expect(body.suppressedGroups).toBe(3);
    expect(body.breakdownWithheld).toBe(false);
  });

  it("shows both groups once the hidden groups together involve at least 5 distinct people", async () => {
    for (const n of [2, 3, 4]) {
      const extra = await clinician(ORG_A, "chaplain", n);
      for (let k = 0; k < 6; k++) {
        await request({
          org: ORG_A,
          channel: channelA,
          requester: requesterA,
          assignee: extra,
          daysAgo: 3,
          ackSeconds: 30,
        });
      }
    }
    // sw 2 + chaplain 4 are still separate hidden groups, but together 6 distinct people and 21 requests: the residual clears both floors.
    const body = (await get(viewer, ORG_A, "?groupBy=discipline")).json();
    expect(body.cells.map((c: { group: string }) => c.group).sort()).toEqual(["md", "rn"]);
    expect(body.suppressedGroups).toBe(2);
  });

  it("snaps the window to whole UTC days: two windows that differ by under a day return identical results", async () => {
    const day = (offset: number, time: string) => {
      const d = new Date(Date.now() - offset * 86_400_000);
      return `${d.toISOString().slice(0, 10)}T${time}Z`;
    };
    const a = await get(
      viewer,
      ORG_A,
      `?from=${day(10, "00:00:00.000")}&to=${day(0, "00:00:00.000")}`,
    );
    const b = await get(
      viewer,
      ORG_A,
      `?from=${day(10, "23:59:59.999")}&to=${day(0, "23:59:59.999")}`,
    );
    expect(a.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    expect(a.json().from).toMatch(/T00:00:00\.000Z$/);
    expect(a.json().to).toMatch(/T00:00:00\.000Z$/);
  });

  it("serves completed UTC days only: the response `to` is the start of today, and a request made today never changes the answer", async () => {
    const todayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    const before = await get(viewer, ORG_A, "?groupBy=class");
    expect(before.json().to).toBe(todayStart);
    // a `to` in the future is capped the same way
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
    expect((await get(viewer, ORG_A, `?to=${future}`)).json().to).toBe(todayStart);
    // a request opened right now (today) is not in the figures, so polling through the day reveals nothing
    const fresh = await clinician(ORG_A, "rn", 99);
    await request({
      org: ORG_A,
      channel: channelA,
      requester: requesterA,
      assignee: fresh,
      daysAgo: 0,
      ackSeconds: 5,
    });
    const after = await get(viewer, ORG_A, "?groupBy=class");
    expect(after.json()).toEqual(before.json());
  });

  it("serves settled requests only: one acknowledged or escalated today (or still open) never changes a past window, so polling cannot see it", async () => {
    const before = await get(viewer, ORG_A, "?groupBy=class");
    const fresh = await clinician(ORG_A, "rn", 98);
    await request({
      org: ORG_A,
      channel: channelA,
      requester: requesterA,
      assignee: fresh,
      daysAgo: 3,
      ackSeconds: 5,
      escalated: true,
      changedToday: true,
    });
    await request({
      org: ORG_A,
      channel: channelA,
      requester: requesterA,
      assignee: fresh,
      daysAgo: 3,
      ackSeconds: null,
    });
    expect((await get(viewer, ORG_A, "?groupBy=class")).json()).toEqual(before.json());
  });

  it("is a uniform 404 for a permitted user with the flag off even when the query is invalid; sends Cache-Control: no-store", async () => {
    flags[FLAG] = false;
    expect((await get(viewer, ORG_A, "?groupBy=bogus")).statusCode).toBe(404);
    flags[FLAG] = true;
    const ok = await get(viewer, ORG_A, "?groupBy=class");
    expect(ok.headers["cache-control"]).toBe("no-store");
  });

  it("answers insufficient_data for a window that holds no completed day (only today)", async () => {
    const todayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
    const res = await get(viewer, ORG_A, `?from=${todayStart}&to=${new Date().toISOString()}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "insufficient_data", minCohort: ANALYTICS_MIN_COHORT });
  });

  it("measures the 92-day cap on the snapped window", async () => {
    const at = (days: number, time: string) => {
      const d = new Date(Date.now() - days * 86_400_000);
      return `${d.toISOString().slice(0, 10)}T${time}Z`;
    };
    // 91 days and 2 hours apart as instants, 93 whole days after snapping: refused.
    const res = await get(viewer, ORG_A, `?from=${at(93, "23:00:00")}&to=${at(1, "01:00:00")}`);
    expect([400, 422]).toContain(res.statusCode);
  });

  it("answers insufficient_data when fewer than the minimum number of people stand behind the whole report", async () => {
    const body = (await get(viewerB, ORG_B)).json();
    expect(body).toEqual({ status: "insufficient_data", minCohort: ANALYTICS_MIN_COHORT });
  });

  it("refuses a reversed window, a window over 92 days and an unknown breakdown", async () => {
    const now = new Date();
    const iso = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
    for (const q of [
      `?from=${iso(1)}&to=${iso(2)}`,
      `?from=${iso(100)}&to=${iso(0)}`,
      "?groupBy=user",
      "?groupBy=team",
    ]) {
      const res = await get(viewer, ORG_A, q);
      expect([400, 422], q).toContain(res.statusCode);
    }
  });

  it("RLS as chartwarden_app: a foreign tenant context reads zero of org A's requests, events or handoffs", async () => {
    await kit.appConn.query("BEGIN");
    try {
      await kit.appConn.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_B]);
      for (const table of [
        "message_acknowledgment_request",
        "message_acknowledgment_event",
        "clinical_handoff",
      ]) {
        const rows = (
          await kit.appConn.query(
            `SELECT count(*)::int AS n FROM ${table} WHERE organization_id = $1`,
            [ORG_A],
          )
        ).rows[0].n;
        expect(rows, table).toBe(0);
      }
    } finally {
      await kit.appConn.query("ROLLBACK");
    }
  });
});
