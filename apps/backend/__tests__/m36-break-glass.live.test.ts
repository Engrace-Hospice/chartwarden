/**
 * M36 ADR-0087 (PROPOSED), WP 5.8 - messaging break-glass tables (migration 1140), LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 * S1 proves the database layer; S2-S4 extend this suite with the service, the routes and the review queue.
 *
 *   1. TENANCY    another organisation reads nothing and cannot grant against this organisation's channel.
 *   2. GRANT      insert-only apart from one revoke; the database clock sets granted_at; bounds (24h, justification 20..280, reason set);
 *                 one open grant per (channel, grantee); no DELETE for the app role.
 *   3. REVIEW     a grant cannot commit without its review; the reviewer is never the grantee; completed once, only after the grant ended;
 *                 a concern needs a note.
 *   4. READ TRAIL a read is recorded only against a live grant held by the reader (live, not expired, not revoked, not someone else's).
 *   5. AUDIT      the grant lands an audit_event that omits the justification.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:break-glass:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the chartwarden_* roles.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createPredicateRegistry, registerAbacRegistry } from "@chartwarden/auth";
import { BREAK_GLASS_FLAG_KEY } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import {
  CHANNEL_VISIBILITY_READ_PREDICATE,
  registerMessagingRoutes,
} from "../src/modules/36-messaging/routes/messaging-routes";
import {
  type LiveKit,
  as,
  bootLiveKit,
  catalogOutbox,
  headerAuth,
  mkChannel,
} from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a870001";
const ORG_B = "22222222-2222-4222-8222-22220a870002";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a87a1";
const WHY = "Covering the on-call RN for a deteriorating patient";

type Row = Record<string, unknown>;
type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;

describe.skipIf(!DB_URL)("M36 ADR-0087 break-glass tables - LIVE Postgres", () => {
  let kit: LiveKit;
  let grantee: string;
  let reviewer: string;
  let other: string;
  let outsider: string;
  let channel: string;

  const GRANT_SQL = `INSERT INTO message_break_glass_grant
    (organization_id, channel_id, grantee_user_id, reason_code, justification, expires_at)
    VALUES ($1,$2,$3,$4,$5, now() + $6::interval) RETURNING id`;
  const REVIEW_SQL = "INSERT INTO message_break_glass_review (organization_id, grant_id) VALUES ($1,$2)";

  /** Runs `body` as the app role for `user` in `org`; commits when `commit`, else rolls back. Returns the first error message or null. */
  const appTx = async (
    user: string,
    org: string,
    body: (q: Query) => Promise<unknown>,
    commit = false,
  ): Promise<string | null> => {
    await kit.appConn.query("BEGIN");
    try {
      await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [org]);
      await kit.appConn.query("SELECT set_config('app.user_id', $1, true)", [user]);
      await body(async (sql, p = []) => (await kit.appConn.query(sql, p)).rows as Row[]);
      await kit.appConn.query(commit ? "COMMIT" : "ROLLBACK");
      return null;
    } catch (err) {
      await kit.appConn.query("ROLLBACK").catch(() => undefined);
      return (err as Error).message;
    }
  };

  /** Seeds a grant AND its review in one committed transaction as the superuser. */
  const seed = async (
    user = grantee,
    ttl = "4 hours",
    reason = "patient_safety",
    text = WHY,
    onChannel = channel,
  ) => {
    await kit.admin.query("BEGIN");
    try {
      const id = (await kit.admin.query(GRANT_SQL, [ORG_A, onChannel, user, reason, text, ttl])).rows[0]
        .id as string;
      await kit.admin.query(REVIEW_SQL, [ORG_A, id]);
      await kit.admin.query("COMMIT");
      return id;
    } catch (err) {
      await kit.admin.query("ROLLBACK");
      throw err;
    }
  };
  const revoke = (id: string) =>
    kit.one("UPDATE message_break_glass_grant SET revoked_at = now() WHERE id=$1", [id]);
  const drop = (...ids: string[]) =>
    kit.one("DELETE FROM message_break_glass_grant WHERE id = ANY($1)", [ids]);
  const grantAs = (ttl: string, reason: string, text: string, org = ORG_A) =>
    appTx(grantee, org, async (q) => {
      const g = await q(GRANT_SQL, [org, channel, grantee, reason, text, ttl]);
      await q(REVIEW_SQL, [org, g[0].id]);
    });

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "adr87");
    grantee = await kit.seedUser("grantee", ORG_A);
    reviewer = await kit.seedUser("reviewer", ORG_A);
    other = await kit.seedUser("other", ORG_A);
    outsider = await kit.seedUser("outsider", ORG_B);
    channel = await mkChannel(kit, "care_team", PATIENT, [other]);
  }, 120_000);

  afterAll(async () => {
    await kit?.close();
  });

  it("the app role commits a grant with its review; the database clock sets granted_at and clears revoked_at", async () => {
    let id = "";
    const err = await appTx(
      grantee,
      ORG_A,
      async (q) => {
        const g = await q(
          `INSERT INTO message_break_glass_grant
           (organization_id, channel_id, grantee_user_id, reason_code, justification, granted_at, expires_at, revoked_at)
           VALUES ($1,$2,$3,'patient_safety',$4, now() - interval '2 days', now() + interval '1 hour', now()) RETURNING id`,
          [ORG_A, channel, grantee, WHY],
        );
        id = g[0].id as string;
        await q(REVIEW_SQL, [ORG_A, id]);
      },
      true,
    );
    expect(err).toBeNull();
    const [row] = await kit.one<{ ok: boolean; open: boolean }>(
      "SELECT granted_at > now() - interval '1 minute' AS ok, revoked_at IS NULL AS open FROM message_break_glass_grant WHERE id=$1",
      [id],
    );
    expect(row).toEqual({ ok: true, open: true });
    await drop(id);
  });

  it("a grant cannot commit without its review", async () => {
    const err = await appTx(
      grantee,
      ORG_A,
      (q) => q(GRANT_SQL, [ORG_A, channel, grantee, "patient_safety", WHY, "4 hours"]),
      true,
    );
    expect(err).toMatch(/message_break_glass_grant_unreviewed/);
    expect(
      await kit.one("SELECT 1 FROM message_break_glass_grant WHERE grantee_user_id=$1", [grantee]),
    ).toHaveLength(0);
  });

  it("bounds: 24 hours at most, justification 20..280 after trimming, a closed reason set", async () => {
    expect(await grantAs("24 hours", "other", WHY)).toBeNull();
    expect(await grantAs("25 hours", "other", WHY)).toMatch(/message_break_glass_grant_max_window/);
    expect(await grantAs("4 hours", "other", "x".repeat(19))).toMatch(/message_break_glass_grant_justification/);
    expect(await grantAs("4 hours", "other", `   ${"x".repeat(19)}   `)).toMatch(
      /message_break_glass_grant_justification/,
    );
    expect(await grantAs("4 hours", "other", "x".repeat(20))).toBeNull();
    expect(await grantAs("4 hours", "other", "x".repeat(280))).toBeNull();
    expect(await grantAs("4 hours", "other", "x".repeat(281))).toMatch(
      /message_break_glass_grant_justification/,
    );
    expect(await grantAs("4 hours", "because", WHY)).toMatch(/message_break_glass_grant_reason/);
    expect(await grantAs("0 seconds", "other", WHY)).toMatch(/message_break_glass_grant_window/);
  });

  it("insert-only apart from one revoke; no DELETE for the app role", async () => {
    const id = await seed();
    const denied = (sql: string, commit = false) =>
      appTx(grantee, ORG_A, (q) => q(sql, [id]), commit);
    expect(await denied("UPDATE message_break_glass_grant SET justification = 'edited' WHERE id=$1")).toMatch(
      /permission denied/,
    );
    expect(
      await denied("UPDATE message_break_glass_grant SET expires_at = expires_at + interval '1 hour' WHERE id=$1"),
    ).toMatch(/permission denied/);
    expect(await denied("DELETE FROM message_break_glass_grant WHERE id=$1")).toMatch(/permission denied/);
    expect(
      await denied("UPDATE message_break_glass_grant SET revoked_at = now() - interval '5 days' WHERE id=$1", true),
    ).toBeNull();
    const [row] = await kit.one<{ recent: boolean }>(
      "SELECT revoked_at > now() - interval '1 minute' AS recent FROM message_break_glass_grant WHERE id=$1",
      [id],
    );
    expect(row.recent).toBe(true);
    expect(await denied("UPDATE message_break_glass_grant SET revoked_at = now() WHERE id=$1")).toMatch(
      /message_break_glass_grant_revoked/,
    );
    await drop(id);
  });

  it("one open grant per channel and grantee; a revoked one frees the slot", async () => {
    const first = await seed();
    await expect(seed()).rejects.toThrow(/message_break_glass_grant_one_open/);
    await revoke(first);
    const second = await seed();
    await drop(first, second);
  });

  it("another organisation reads nothing and cannot grant against this organisation's channel", async () => {
    const id = await seed();
    let seen = -1;
    await appTx(outsider, ORG_B, async (q) => {
      seen = (await q("SELECT id FROM message_break_glass_grant")).length;
    });
    expect(seen).toBe(0);
    let own = -1;
    await appTx(grantee, ORG_A, async (q) => {
      own = (await q("SELECT id FROM message_break_glass_grant WHERE id=$1", [id])).length;
    });
    expect(own).toBe(1);
    expect(await grantAs("4 hours", "other", WHY, ORG_B)).toMatch(/row-level security|foreign key|violates/i);
    await drop(id);
  });

  it("review: never the grantee, only after the grant ended, completed once, a concern needs a note", async () => {
    const id = await seed();
    const complete = (who: string, outcome: string, note: string | null, commit = false) =>
      appTx(
        who,
        ORG_A,
        (q) =>
          q(
            "UPDATE message_break_glass_review SET reviewer_user_id=$2, reviewed_at=now(), outcome=$3, note=$4 WHERE grant_id=$1",
            [id, who, outcome, note],
          ),
        commit,
      );
    expect(await complete(reviewer, "reviewed", null)).toMatch(/message_break_glass_review_open/);
    await revoke(id);
    expect(await complete(grantee, "reviewed", null)).toMatch(/message_break_glass_review_self/);
    expect(await complete(reviewer, "concern", null)).toMatch(/message_break_glass_review_concern_note/);
    expect(await complete(reviewer, "fine", null)).toMatch(/message_break_glass_review_outcome/);
    expect(await complete(reviewer, "concern", "x".repeat(1001))).toMatch(
      /message_break_glass_review_note_len/,
    );
    expect(
      await appTx(reviewer, ORG_A, (q) =>
        q("UPDATE message_break_glass_review SET created_at = now() WHERE grant_id=$1", [id]),
      ),
    ).toMatch(/permission denied/);
    expect(await complete(reviewer, "concern", "Read a patient the grantee does not treat", true)).toBeNull();
    const [done] = await kit.one<{ outcome: string; by: string }>(
      "SELECT outcome, reviewer_user_id AS by FROM message_break_glass_review WHERE grant_id=$1",
      [id],
    );
    expect(done).toEqual({ outcome: "concern", by: reviewer });
    expect(await complete(reviewer, "reviewed", null)).toMatch(/message_break_glass_review_done/);
    await drop(id);
  });

  it("an expired grant can be reviewed without a revoke (the database clock decides)", async () => {
    const id = await seed(grantee, "1 second");
    await kit.one("SELECT pg_sleep(1.3)");
    const err = await appTx(reviewer, ORG_A, (q) =>
      q(
        "UPDATE message_break_glass_review SET reviewer_user_id=$2, reviewed_at=now(), outcome='reviewed' WHERE grant_id=$1",
        [id, reviewer],
      ),
    );
    expect(err).toBeNull();
    await drop(id);
  });

  it("a read is recorded only against a live grant held by the reader", async () => {
    const id = await seed();
    const record = (who: string, kind = "messages") =>
      appTx(
        who,
        ORG_A,
        (q) =>
          q(
            "INSERT INTO message_break_glass_read (organization_id, grant_id, read_kind, item_count, read_at) VALUES ($1,$2,$3,25, now() - interval '3 days')",
            [ORG_A, id, kind],
          ),
        true,
      );
    expect(await record(grantee)).toBeNull();
    expect(await record(grantee, "thread")).toBeNull();
    expect(await record(other)).toMatch(/message_break_glass_read_grant/);
    expect(await record(grantee, "export")).toMatch(/message_break_glass_read_kind/);
    const [row] = await kit.one<{ n: string; fresh: boolean }>(
      "SELECT count(*) AS n, bool_and(read_at > now() - interval '1 minute') AS fresh FROM message_break_glass_read WHERE grant_id=$1",
      [id],
    );
    expect(row).toEqual({ n: "2", fresh: true });
    expect(
      await appTx(grantee, ORG_A, (q) =>
        q("UPDATE message_break_glass_read SET item_count=1 WHERE grant_id=$1", [id]),
      ),
    ).toMatch(/permission denied/);
    expect(
      await appTx(grantee, ORG_A, (q) => q("DELETE FROM message_break_glass_read WHERE grant_id=$1", [id])),
    ).toMatch(/permission denied/);
    await revoke(id);
    expect(await record(grantee)).toMatch(/message_break_glass_read_grant/);
    await drop(id);
  });

  it("a read cannot be recorded once the grant has expired", async () => {
    const id = await seed(grantee, "1 second");
    await kit.one("SELECT pg_sleep(1.3)");
    const err = await appTx(grantee, ORG_A, (q) =>
      q("INSERT INTO message_break_glass_read (organization_id, grant_id, read_kind) VALUES ($1,$2,'channel')", [
        ORG_A,
        id,
      ]),
    );
    expect(err).toMatch(/message_break_glass_read_grant/);
    await drop(id);
  });

  it("the grant lands an audit_event that omits the justification", async () => {
    const id = await seed();
    const rows = await kit.one<{ event_type: string; after: Record<string, unknown> }>(
      "SELECT event_type, after FROM audit_event WHERE resource_kind='message_break_glass_grant' AND resource_id=$1",
      [id],
    );
    expect(rows.map((r) => r.event_type)).toContain("message_break_glass_grant.insert");
    for (const r of rows) expect(Object.keys(r.after ?? {})).not.toContain("justification");
    await drop(id);
  });

  it("the permissions are in the catalog", async () => {
    const perms = await kit.one<{ key: string; category: string }>(
      "SELECT key, category::text AS category FROM permission WHERE key LIKE 'messaging.break_glass.%' ORDER BY key",
    );
    expect(perms).toEqual([
      { key: "messaging.break_glass.invoke", category: "compliance" },
      { key: "messaging.break_glass.review", category: "compliance" },
    ]);
  });

  // ── S2: the real route service. A grant opens READ visibility on its one channel and nothing else. ─────────────────────────
  describe("S2 read access under a grant (the real route service)", () => {
    const KEK = randomBytes(32);
    const part2Denied = new Set<string>();
    let part2Throws = false;
    let careTeam: string;
    let discipline: string;
    let careMsg: string;

    /** A fresh service per call: the flag read is cached per service, so each test pins its own flag state. */
    const mkService = (flag: boolean | "absent") =>
      createDbMessagingRouteService(kit.handle.db, {
        kek: KEK,
        outbox: catalogOutbox() as never,
        part2Gate: {
          allowedUserIds: async ({ userIds, patientId }) => {
            if (part2Throws) throw new Error("consent seam down");
            return new Set(userIds.filter((u) => !part2Denied.has(`${u}:${patientId}`)));
          },
        },
        ...(flag === "absent"
          ? {}
          : { breakGlass: { flags: { forOrg: async () => ({ [BREAK_GLASS_FLAG_KEY]: flag }) } } }),
      });
    const trail = (grantId: string) =>
      kit.one<{ read_kind: string; resource_id: string | null; item_count: number | null }>(
        "SELECT read_kind, resource_id, item_count FROM message_break_glass_read WHERE grant_id=$1",
        [grantId],
      );
    const grantOn = (ch: string, ttl = "4 hours") => seed(grantee, ttl, "patient_safety", WHY, ch);

    beforeAll(async () => {
      careTeam = channel; // the outer setup's care-team channel (one per patient)
      discipline = await mkChannel(kit, "discipline", randomUUID(), [other]);
      const writer = mkService(true);
      careMsg = (
        await writer.sendMessage(ORG_A, { channelId: careTeam, authorUserId: other, body: "care note" })
      ).messageId;
      await writer.sendMessage(ORG_A, { channelId: discipline, authorUserId: other, body: "team note" });
    }, 60_000);

    it("a live grant opens READ visibility on its one channel for its one holder; membership visibility is unchanged", async () => {
      const svc = mkService(true);
      expect(await svc.canReadChannel(ORG_A, grantee, careTeam)).toBe(false);
      const id = await grantOn(careTeam);
      expect(await svc.canReadChannel(ORG_A, grantee, careTeam)).toBe(true);
      // canViewChannel still decides writes, assignees and recipients: a grant never makes anyone a viewer.
      expect(await svc.canViewChannel(ORG_A, grantee, careTeam)).toBe(false);
      expect(await svc.canReadChannel(ORG_A, grantee, discipline)).toBe(false);
      expect(await svc.canReadChannel(ORG_A, reviewer, careTeam)).toBe(false);
      expect(await svc.canReadChannel(ORG_A, other, discipline)).toBe(true);
      expect(await svc.canReadChannel(ORG_A, grantee, randomUUID())).toBe(false);
      await drop(id);
    });

    it("ends with the grant: revoked, expired on the database clock, flag off or absent", async () => {
      const id = await grantOn(careTeam);
      expect(await mkService(true).canReadChannel(ORG_A, grantee, careTeam)).toBe(true);
      expect(await mkService(false).canReadChannel(ORG_A, grantee, careTeam)).toBe(false);
      expect(await mkService("absent").canReadChannel(ORG_A, grantee, careTeam)).toBe(false);
      await revoke(id);
      expect(await mkService(true).canReadChannel(ORG_A, grantee, careTeam)).toBe(false);
      await drop(id);
      const short = await grantOn(careTeam, "1 second");
      expect(await mkService(true).canReadChannel(ORG_A, grantee, careTeam)).toBe(true);
      await kit.one("SELECT pg_sleep(1.3)");
      expect(await mkService(true).canReadChannel(ORG_A, grantee, careTeam)).toBe(false);
      await drop(short);
    });

    it("never skips the Part 2 gate: a denied or unreachable consent check refuses a care-team channel, not another kind", async () => {
      const ids = [await grantOn(careTeam), await grantOn(discipline)];
      const svc = mkService(true);
      part2Denied.add(`${grantee}:${PATIENT}`);
      try {
        expect(await svc.canReadChannel(ORG_A, grantee, careTeam)).toBe(false);
        expect(await svc.canReadChannel(ORG_A, grantee, discipline)).toBe(true);
      } finally {
        part2Denied.clear();
      }
      part2Throws = true;
      try {
        expect(await svc.canReadChannel(ORG_A, grantee, careTeam)).toBe(false);
      } finally {
        part2Throws = false;
      }
      expect(await svc.canReadChannel(ORG_A, grantee, careTeam)).toBe(true);
      await drop(...ids);
    });

    it("never skips the role-category refusal or an inactive user", async () => {
      const id = await grantOn(discipline);
      const svc = mkService(true);
      const [role] = await kit.one<{ id: string }>(
        `INSERT INTO role (organization_id, key, name, category, enabled)
         VALUES ($1,$2,$2,'patient_family'::role_category,true) RETURNING id`,
        [ORG_A, `t-pf-${randomUUID()}`],
      );
      const [m] = await kit.one<{ id: string }>(
        "SELECT id FROM membership WHERE user_id=$1 AND organization_id=$2",
        [grantee, ORG_A],
      );
      await kit.one(
        "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
        [ORG_A, m.id, role.id],
      );
      expect(await svc.canReadChannel(ORG_A, grantee, discipline)).toBe(false);
      await kit.one("DELETE FROM membership_role WHERE membership_id=$1 AND role_id=$2", [m.id, role.id]);
      expect(await svc.canReadChannel(ORG_A, grantee, discipline)).toBe(true);
      await kit.one("UPDATE membership SET status='suspended' WHERE id=$1", [m.id]);
      expect(await svc.canReadChannel(ORG_A, grantee, discipline)).toBe(false);
      await kit.one("UPDATE membership SET status='active' WHERE id=$1", [m.id]);
      expect(await svc.canReadChannel(ORG_A, grantee, discipline)).toBe(true);
      await drop(id);
    });

    it("reads under a grant leave one trail row each; a member's plain read leaves none", async () => {
      const svc = mkService(true);
      const id = await grantOn(careTeam);
      const channelView = await svc.getChannel(ORG_A, grantee, careTeam);
      expect(channelView.channelId).toBe(careTeam);
      const page = await svc.listMessages(ORG_A, { channelId: careTeam, userId: grantee });
      expect(page.messages).toHaveLength(1);
      const thread = await svc.listThread(ORG_A, { channelId: careTeam, messageId: careMsg, userId: grantee });
      expect(thread.root.messageId).toBe(careMsg);
      const rows = await trail(id);
      expect(rows.map((r) => r.read_kind).sort()).toEqual(["channel", "messages", "thread"]);
      expect(rows.find((r) => r.read_kind === "messages")?.item_count).toBe(1);
      expect(rows.find((r) => r.read_kind === "thread")?.resource_id).toBe(careMsg);
      await svc.listMessages(ORG_A, { channelId: careTeam, userId: other });
      expect(await trail(id)).toHaveLength(3);
      await drop(id);
    });

    it("a read nobody may do fails closed: no live grant and not a live member", async () => {
      const svc = mkService(true);
      // The route would have refused both; the service refuses them too (the grant can end between the route check and the read).
      await expect(svc.listMessages(ORG_A, { channelId: careTeam, userId: grantee })).rejects.toThrow(/ended/);
      const short = await grantOn(careTeam, "1 second");
      await kit.one("SELECT pg_sleep(1.3)");
      await expect(svc.listMessages(ORG_A, { channelId: careTeam, userId: grantee })).rejects.toThrow(/ended/);
      await expect(svc.getChannel(ORG_A, grantee, careTeam)).rejects.toThrow(/ended/);
      await expect(
        svc.listThread(ORG_A, { channelId: careTeam, messageId: careMsg, userId: grantee }),
      ).rejects.toThrow(/ended/);
      expect(await trail(short)).toHaveLength(0);
      await drop(short);
    });

    it("the service's own write guards refuse a grantee: edit, delete, mark-read and pin", async () => {
      const svc = mkService(true);
      const id = await grantOn(careTeam);
      await expect(
        svc.editMessage(ORG_A, { userId: grantee, messageId: careMsg, body: "edited" }),
      ).rejects.toThrow();
      await expect(svc.deleteMessage(ORG_A, { userId: grantee, messageId: careMsg })).rejects.toThrow();
      await expect(svc.markRead(ORG_A, { userId: grantee, messageId: careMsg })).rejects.toThrow();
      await expect(
        svc.pinMessage(ORG_A, { userId: grantee, channelId: careTeam, messageId: careMsg }),
      ).rejects.toThrow();
      expect(await kit.one("SELECT 1 FROM message WHERE channel_id=$1", [careTeam])).toHaveLength(1);
      await drop(id);
    });

    describe("through the HTTP routes (the real ABAC predicates)", () => {
      let server: FastifyInstance;
      const get = (user: string, url: string) =>
        server.inject({ method: "GET", url, headers: as(user, ORG_A) });
      const base = () => `/api/v1/messaging/channels/${careTeam}`;

      beforeAll(async () => {
        const svc = mkService(true);
        const registry = createPredicateRegistry();
        const channelOf = (ctx: { organizationId?: string; userId?: string }, t: Record<string, unknown>) =>
          typeof t.id === "string" && ctx.organizationId && ctx.userId ? t.id : null;
        registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
          const id = channelOf(ctx, target);
          return id ? svc.canViewChannel(ctx.organizationId as string, ctx.userId as string, id) : false;
        });
        registry.register(CHANNEL_VISIBILITY_READ_PREDICATE, async (ctx, target) => {
          const id = channelOf(ctx, target);
          return id ? svc.canReadChannel(ctx.organizationId as string, ctx.userId as string, id) : false;
        });
        registerAbacRegistry(registry);
        server = buildServer({
          db: kit.handle.db,
          authenticate: headerAuth,
          security: { rateLimitEnabled: false },
          idempotencyStore: createDbIdempotencyStore(kit.handle.db),
        });
        registerMessagingRoutes(server, {
          service: svc,
          announcements: createDbAnnouncementService(kit.handle.db),
        });
        await server.ready();
      });
      afterAll(async () => {
        await server?.close();
      });

      it("the three read GETs open for a grantee while the grant is live and close the moment it is revoked", async () => {
        expect((await get(grantee, base())).statusCode).toBe(403);
        const id = await grantOn(careTeam);
        expect((await get(grantee, base())).statusCode).toBe(200);
        const list = await get(grantee, `${base()}/messages`);
        expect(list.statusCode).toBe(200);
        expect(list.json().messages).toHaveLength(1);
        expect((await get(grantee, `${base()}/messages/${careMsg}/thread`)).statusCode).toBe(200);
        expect((await trail(id)).map((r) => r.read_kind).sort()).toEqual(["channel", "messages", "thread"]);
        await revoke(id);
        expect((await get(grantee, base())).statusCode).toBe(403);
        expect((await get(grantee, `${base()}/messages`)).statusCode).toBe(403);
        await drop(id);
      });

      it("every other route on the channel stays membership-only: send, react, pin, pins list, search", async () => {
        const id = await grantOn(careTeam);
        const send = await server.inject({
          method: "POST",
          url: `${base()}/messages`,
          headers: as(grantee, ORG_A, randomUUID()),
          payload: { body: "nope" },
        });
        expect(send.statusCode).toBe(403);
        expect(
          (
            await server.inject({
              method: "PUT",
              url: `${base()}/messages/${careMsg}/reactions/${encodeURIComponent("👍")}`,
              headers: as(grantee, ORG_A),
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await server.inject({
              method: "PUT",
              url: `${base()}/messages/${careMsg}/pin`,
              headers: as(grantee, ORG_A),
            })
          ).statusCode,
        ).toBe(403);
        expect((await get(grantee, `${base()}/pins`)).statusCode).toBe(403);
        expect((await get(grantee, `${base()}/search?q=care`)).statusCode).toBe(403);
        expect(await kit.one("SELECT 1 FROM message WHERE channel_id=$1", [careTeam])).toHaveLength(1);
        await drop(id);
      });
    });
  });
});
