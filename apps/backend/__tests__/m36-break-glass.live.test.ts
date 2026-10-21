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
import {
  createPredicateRegistry,
  registerAbacRegistry,
  resolveActorPermissions,
} from "@chartwarden/auth";
import { BREAK_GLASS_FLAG_KEY } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { createBreakGlassReadAccess } from "../src/modules/36-messaging/break-glass/break-glass-read-access";
import { createBreakGlassReviewSweep } from "../src/modules/36-messaging/break-glass/break-glass-review-sweep";
import { createBreakGlassService } from "../src/modules/36-messaging/break-glass/break-glass-service";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import {
  createDbMessagingRouteService,
  isActiveMessagingUser,
} from "../src/modules/36-messaging/messaging-route-service-db";
import { registerBreakGlassRoutes } from "../src/modules/36-messaging/routes/break-glass-routes";
import {
  CHANNEL_VISIBILITY_READ_PREDICATE,
  registerMessagingRoutes,
} from "../src/modules/36-messaging/routes/messaging-routes";
import {
  type LiveKit,
  STAFF_KEYS,
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
/** The live permission check the composition root binds: a grant is honoured only while its holder still has the invoke key. */
const holdsInvoke = async (organizationId: string, userId: string) =>
  (await resolveActorPermissions({ organizationId, userId })).has("messaging.break_glass.invoke");
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
  const REVIEW_SQL =
    "INSERT INTO message_break_glass_review (organization_id, grant_id) VALUES ($1,$2)";

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
      const id = (await kit.admin.query(GRANT_SQL, [ORG_A, onChannel, user, reason, text, ttl]))
        .rows[0].id as string;
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
    grantee = await kit.seedUser("grantee", ORG_A, [...STAFF_KEYS, "messaging.break_glass.invoke"]);
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
    expect(await grantAs("4 hours", "other", "x".repeat(19))).toMatch(
      /message_break_glass_grant_justification/,
    );
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
    expect(
      await denied("UPDATE message_break_glass_grant SET justification = 'edited' WHERE id=$1"),
    ).toMatch(/permission denied/);
    expect(
      await denied(
        "UPDATE message_break_glass_grant SET expires_at = expires_at + interval '1 hour' WHERE id=$1",
      ),
    ).toMatch(/permission denied/);
    expect(await denied("DELETE FROM message_break_glass_grant WHERE id=$1")).toMatch(
      /permission denied/,
    );
    expect(
      await denied(
        "UPDATE message_break_glass_grant SET revoked_at = now() - interval '5 days' WHERE id=$1",
        true,
      ),
    ).toBeNull();
    const [row] = await kit.one<{ recent: boolean }>(
      "SELECT revoked_at > now() - interval '1 minute' AS recent FROM message_break_glass_grant WHERE id=$1",
      [id],
    );
    expect(row.recent).toBe(true);
    expect(
      await denied("UPDATE message_break_glass_grant SET revoked_at = now() WHERE id=$1"),
    ).toMatch(/message_break_glass_grant_revoked/);
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
    expect(await grantAs("4 hours", "other", WHY, ORG_B)).toMatch(
      /row-level security|foreign key|violates/i,
    );
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
    expect(await complete(reviewer, "concern", null)).toMatch(
      /message_break_glass_review_concern_note/,
    );
    expect(await complete(reviewer, "fine", null)).toMatch(/message_break_glass_review_outcome/);
    expect(await complete(reviewer, "concern", "x".repeat(1001))).toMatch(
      /message_break_glass_review_note_len/,
    );
    expect(
      await appTx(reviewer, ORG_A, (q) =>
        q("UPDATE message_break_glass_review SET created_at = now() WHERE grant_id=$1", [id]),
      ),
    ).toMatch(/permission denied/);
    expect(
      await complete(reviewer, "concern", "Read a patient the grantee does not treat", true),
    ).toBeNull();
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
      await appTx(grantee, ORG_A, (q) =>
        q("DELETE FROM message_break_glass_read WHERE grant_id=$1", [id]),
      ),
    ).toMatch(/permission denied/);
    await revoke(id);
    expect(await record(grantee)).toMatch(/message_break_glass_read_grant/);
    await drop(id);
  });

  it("a read cannot be recorded once the grant has expired", async () => {
    const id = await seed(grantee, "1 second");
    await kit.one("SELECT pg_sleep(1.3)");
    const err = await appTx(grantee, ORG_A, (q) =>
      q(
        "INSERT INTO message_break_glass_read (organization_id, grant_id, read_kind) VALUES ($1,$2,'channel')",
        [ORG_A, id],
      ),
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
          : {
              breakGlass: {
                flags: { forOrg: async () => ({ [BREAK_GLASS_FLAG_KEY]: flag }) },
                holdsInvoke,
              },
            }),
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
        await writer.sendMessage(ORG_A, {
          channelId: careTeam,
          authorUserId: other,
          body: "care note",
        })
      ).messageId;
      await writer.sendMessage(ORG_A, {
        channelId: discipline,
        authorUserId: other,
        body: "team note",
      });
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

    it("a grant is not a standing right: it stops the moment its holder loses the invoke permission", async () => {
      const lost = await kit.seedUser("lost-key", ORG_A, STAFF_KEYS);
      const svc = mkService(true);
      expect(await holdsInvoke(ORG_A, lost)).toBe(false);
      const id = await seed(lost, "4 hours", "other", WHY, discipline);
      expect(await svc.canReadChannel(ORG_A, lost, discipline)).toBe(false);
      await drop(id);
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
      await kit.one("DELETE FROM membership_role WHERE membership_id=$1 AND role_id=$2", [
        m.id,
        role.id,
      ]);
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
      const thread = await svc.listThread(ORG_A, {
        channelId: careTeam,
        messageId: careMsg,
        userId: grantee,
      });
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
      await expect(
        svc.listMessages(ORG_A, { channelId: careTeam, userId: grantee }),
      ).rejects.toThrow(/ended/);
      const short = await grantOn(careTeam, "1 second");
      await kit.one("SELECT pg_sleep(1.3)");
      await expect(
        svc.listMessages(ORG_A, { channelId: careTeam, userId: grantee }),
      ).rejects.toThrow(/ended/);
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
      await expect(
        svc.deleteMessage(ORG_A, { userId: grantee, messageId: careMsg }),
      ).rejects.toThrow();
      await expect(svc.markRead(ORG_A, { userId: grantee, messageId: careMsg })).rejects.toThrow();
      await expect(
        svc.pinMessage(ORG_A, { userId: grantee, channelId: careTeam, messageId: careMsg }),
      ).rejects.toThrow();
      expect(await kit.one("SELECT 1 FROM message WHERE channel_id=$1", [careTeam])).toHaveLength(
        1,
      );
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
        const channelOf = (
          ctx: { organizationId?: string; userId?: string },
          t: Record<string, unknown>,
        ) => (typeof t.id === "string" && ctx.organizationId && ctx.userId ? t.id : null);
        registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
          const id = channelOf(ctx, target);
          return id
            ? svc.canViewChannel(ctx.organizationId as string, ctx.userId as string, id)
            : false;
        });
        registry.register(CHANNEL_VISIBILITY_READ_PREDICATE, async (ctx, target) => {
          const id = channelOf(ctx, target);
          return id
            ? svc.canReadChannel(ctx.organizationId as string, ctx.userId as string, id)
            : false;
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
        expect((await trail(id)).map((r) => r.read_kind).sort()).toEqual([
          "channel",
          "messages",
          "thread",
        ]);
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
        expect(await kit.one("SELECT 1 FROM message WHERE channel_id=$1", [careTeam])).toHaveLength(
          1,
        );
        await drop(id);
      });
    });
  });

  // ── S3: the break-glass routes (open, mine, end, reviews) over the real service, the permission and step-up guards and the outbox. ──────
  describe("S3 break-glass routes", () => {
    const KEK = randomBytes(32);
    const part2Denied = new Set<string>();
    let stepUpFresh = false;
    let on: FastifyInstance;
    let off: FastifyInstance;
    let invoker: string;
    let reviewerUser: string;
    let both: string;
    let nobody: string;
    let memberInvoker: string;
    let groupChannel: string;
    let announcement: string;

    const mkRouteService = (flag: boolean) => {
      const flags = { forOrg: async () => ({ [BREAK_GLASS_FLAG_KEY]: flag }) };
      const part2Gate = {
        allowedUserIds: async ({
          userIds,
          patientId,
        }: { userIds: readonly string[]; patientId: string }) =>
          new Set(userIds.filter((u) => !part2Denied.has(`${u}:${patientId}`))),
      };
      const route = createDbMessagingRouteService(kit.handle.db, {
        kek: KEK,
        outbox: catalogOutbox() as never,
        part2Gate,
        breakGlass: { flags, holdsInvoke },
      });
      return {
        route,
        service: createBreakGlassService({
          db: kit.handle.db,
          outbox: catalogOutbox() as never,
          flags,
          access: createBreakGlassReadAccess({
            db: kit.handle.db,
            part2Gate,
            flags,
            holdsInvoke,
            isActiveUser: (tx, org, user) => isActiveMessagingUser(tx, org, user),
          }),
          canViewChannel: route.canViewChannel,
        }),
      };
    };
    const mkServer = (flag: boolean) => {
      const { service } = mkRouteService(flag);
      const server = buildServer({
        db: kit.handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
        idempotencyStore: createDbIdempotencyStore(kit.handle.db),
      });
      registerBreakGlassRoutes(server, { service });
      return server;
    };
    const send = (
      server: FastifyInstance,
      method: "GET" | "POST",
      url: string,
      user: string,
      payload?: unknown,
    ) =>
      server.inject({
        method,
        url,
        headers: as(user, ORG_A),
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
    const API = "/api/v1/messaging/break-glass";
    const open = (
      user: string,
      channelId: string,
      over: Record<string, unknown> = {},
      server = on,
    ) =>
      send(server, "POST", API, user, {
        channelId,
        reasonCode: "patient_safety",
        justification: WHY,
        ...over,
      });
    const eventsOf = (grantId: string) =>
      kit.one<{ event_type: string; payload: Record<string, unknown> }>(
        "SELECT event_type, payload FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, id",
        [grantId],
      );
    const cleanup = async (...ids: string[]) => {
      await kit.one("DELETE FROM message_break_glass_grant WHERE id = ANY($1)", [ids]);
    };

    beforeAll(async () => {
      const registry = createPredicateRegistry();
      const channelId = (t: Record<string, unknown>) => (typeof t.id === "string" ? t.id : null);
      const { route } = mkRouteService(true);
      registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, t) => {
        const id = channelId(t);
        return id && ctx.organizationId && ctx.userId
          ? route.canViewChannel(ctx.organizationId, ctx.userId, id)
          : false;
      });
      // The real step_up_recent predicate is covered by its own suites; here it is a switch, so the route wiring is what is proven.
      registry.register("step_up_recent", async () => stepUpFresh);
      registerAbacRegistry(registry);
      on = mkServer(true);
      off = mkServer(false);
      await Promise.all([on.ready(), off.ready()]);
      const INVOKE_KEYS = ["messaging.read", "messaging.send", "messaging.break_glass.invoke"];
      invoker = await kit.seedUser("bg-invoker", ORG_A, INVOKE_KEYS);
      reviewerUser = await kit.seedUser("bg-reviewer", ORG_A, [
        "messaging.read",
        "messaging.break_glass.review",
      ]);
      both = await kit.seedUser("bg-both", ORG_A, [...INVOKE_KEYS, "messaging.break_glass.review"]);
      nobody = await kit.seedUser("bg-nobody", ORG_A, ["messaging.read", "messaging.send"]);
      memberInvoker = await kit.seedUser("bg-member", ORG_A, INVOKE_KEYS);
      groupChannel = await mkChannel(kit, "discipline", randomUUID(), [other, memberInvoker]);
      announcement = (
        await kit.one<{ id: string }>(
          `INSERT INTO channel (organization_id, channel_kind, title, retention_class)
           VALUES ($1,'announcement','bg-announce','operational') RETURNING id`,
          [ORG_A],
        )
      )[0].id;
    }, 60_000);
    afterAll(async () => {
      await Promise.all([on?.close(), off?.close()]);
    });
    // One test's grants never leak into the next (the one-open slot is per channel and holder).
    afterEach(async () => {
      await kit.one("DELETE FROM message_break_glass_grant WHERE grantee_user_id = ANY($1)", [
        [invoker, both, memberInvoker, nobody, reviewerUser],
      ]);
    });

    it("ACCESS: no invoke key 403, the flag off 404 before any step-up, and a missing step-up is 403 STEP_UP_REQUIRED", async () => {
      stepUpFresh = true;
      expect((await open(nobody, groupChannel)).statusCode).toBe(403);
      expect((await send(on, "GET", `${API}/mine`, nobody)).statusCode).toBe(403);
      expect((await send(on, "GET", `${API}/reviews`, invoker)).statusCode).toBe(403);
      stepUpFresh = false;
      // Off => the uniform 404 even though no step-up is fresh: the feature is not asked for.
      expect((await open(invoker, groupChannel, {}, off)).statusCode).toBe(404);
      const noStepUp = await open(invoker, groupChannel);
      expect(noStepUp.statusCode).toBe(403);
      expect(noStepUp.body).toContain("STEP_UP_REQUIRED");
      expect(
        await kit.one("SELECT 1 FROM message_break_glass_grant WHERE grantee_user_id=$1", [
          invoker,
        ]),
      ).toHaveLength(0);
    });

    it("VALIDATION: reason, justification length and duration are refused before anything is written", async () => {
      stepUpFresh = true;
      for (const bad of [
        { reasonCode: "because" },
        { justification: "too short" },
        { justification: "x".repeat(300) },
        { durationMinutes: 14 },
        { durationMinutes: 1441 },
        { durationMinutes: 90.5 },
      ]) {
        expect((await open(invoker, groupChannel, bad)).statusCode, JSON.stringify(bad)).toBe(422);
      }
      expect((await open(invoker, "not-a-uuid")).statusCode).toBe(422);
      expect(
        await kit.one("SELECT 1 FROM message_break_glass_grant WHERE grantee_user_id=$1", [
          invoker,
        ]),
      ).toHaveLength(0);
    });

    it("OPEN: 201 writes the grant and its review, reads work over HTTP-level service, and the event is PHI-free", async () => {
      stepUpFresh = true;
      const res = await open(invoker, groupChannel, { durationMinutes: 60 });
      expect(res.statusCode).toBe(201);
      const grant = res.json();
      expect(grant).toMatchObject({
        channelId: groupChannel,
        channelKind: "discipline",
        reasonCode: "patient_safety",
        status: "active",
        revokedAt: null,
      });
      const ms = new Date(grant.expiresAt).getTime() - new Date(grant.grantedAt).getTime();
      expect(ms).toBe(60 * 60_000);
      expect(
        await kit.one(
          "SELECT 1 FROM message_break_glass_review WHERE grant_id=$1 AND reviewed_at IS NULL",
          [grant.id],
        ),
      ).toHaveLength(1);
      const events = await eventsOf(grant.id);
      expect(events.map((e) => e.event_type)).toEqual(["m36.break_glass.granted"]);
      expect(Object.keys(events[0].payload).sort()).toEqual(
        [
          "channelId",
          "expiresAt",
          "grantId",
          "grantedAt",
          "granteeUserId",
          "organizationId",
          "reasonCode",
        ].sort(),
      );
      expect(JSON.stringify(events[0].payload)).not.toContain("Covering");
      // Default duration: four hours.
      await cleanup(grant.id);
      const dflt = (await open(invoker, groupChannel)).json();
      expect(new Date(dflt.expiresAt).getTime() - new Date(dflt.grantedAt).getTime()).toBe(
        4 * 60 * 60_000,
      );
      await cleanup(dflt.id);
    });

    it("REFUSALS: every reason a grant cannot be opened is the same 404 (no existence, Part 2 or category oracle); a member and a repeat are 409", async () => {
      stepUpFresh = true;
      const statusOf = async (channelId: string) => {
        const r = await open(invoker, channelId);
        return { status: r.statusCode, code: r.json().error?.code ?? r.json().code };
      };
      const unknown = await statusOf(randomUUID());
      expect(unknown.status).toBe(404);
      // An announcement is org-wide readable, so "you can already read this" (409) is accurate and discloses nothing.
      expect((await open(invoker, announcement)).body).toContain("BREAK_GLASS_NOT_NEEDED");
      // A care-team channel whose patient is Part 2 protected for this user answers exactly like an unknown channel.
      part2Denied.add(`${invoker}:${PATIENT}`);
      try {
        expect(await statusOf(channel)).toEqual(unknown);
      } finally {
        part2Denied.clear();
      }
      // An excluded role category (a patient-family identity) is the same 404.
      const [role] = await kit.one<{ id: string }>(
        `INSERT INTO role (organization_id, key, name, category, enabled) VALUES ($1,$2,$2,'patient_family'::role_category,true) RETURNING id`,
        [ORG_A, `t-pf-${randomUUID()}`],
      );
      const [m] = await kit.one<{ id: string }>(
        "SELECT id FROM membership WHERE user_id=$1 AND organization_id=$2",
        [invoker, ORG_A],
      );
      await kit.one(
        "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
        [ORG_A, m.id, role.id],
      );
      expect(await statusOf(groupChannel)).toEqual(unknown);
      await kit.one("DELETE FROM membership_role WHERE membership_id=$1 AND role_id=$2", [
        m.id,
        role.id,
      ]);
      // A member (who holds the key) already reads the channel: 409 BREAK_GLASS_NOT_NEEDED.
      const memberRes = await open(memberInvoker, groupChannel);
      expect(memberRes.statusCode).toBe(409);
      expect(memberRes.body).toContain("BREAK_GLASS_NOT_NEEDED");
      // A repeat while one is live: 409 BREAK_GLASS_ALREADY_ACTIVE.
      const first = (await open(invoker, groupChannel)).json();
      const again = await open(invoker, groupChannel);
      expect(again.statusCode).toBe(409);
      expect(again.body).toContain("BREAK_GLASS_ALREADY_ACTIVE");
      await cleanup(first.id);
    });

    it("LIMITS: a fourth live grant is refused 429 BREAK_GLASS_LIMIT, and the flag-off 404 has the same body as any refusal", async () => {
      stepUpFresh = true;
      const extra = await Promise.all(
        [1, 2, 3, 4].map(() => mkChannel(kit, "discipline", randomUUID(), [other])),
      );
      for (const ch of extra.slice(0, 3)) expect((await open(invoker, ch)).statusCode).toBe(201);
      const fourth = await open(invoker, extra[3] as string);
      expect(fourth.statusCode).toBe(429);
      expect(fourth.body).toContain("BREAK_GLASS_LIMIT");
      const unknown = randomUUID();
      const refused = await open(invoker, unknown);
      const flagOff = await open(invoker, unknown, {}, off);
      expect(flagOff.statusCode).toBe(refused.statusCode);
      expect(flagOff.json().error?.message).toBe(refused.json().error?.message);
    });

    it("MINE and END: the holder lists and ends their own grant once; someone else's is the random-id 404; a reviewer may end any", async () => {
      stepUpFresh = true;
      const grant = (await open(invoker, groupChannel)).json();
      const mine = await send(on, "GET", `${API}/mine`, invoker);
      expect(
        mine.json().grants.map((g: { id: string; status: string }) => [g.id, g.status]),
      ).toContainEqual([grant.id, "active"]);
      // Another holder of the invoke key only: the same 404 a random id gets.
      expect((await send(on, "POST", `${API}/${grant.id}/end`, memberInvoker)).statusCode).toBe(
        404,
      );
      const ended = await send(on, "POST", `${API}/${grant.id}/end`, invoker);
      expect(ended.statusCode).toBe(200);
      expect(ended.json().status).toBe("revoked");
      expect((await send(on, "POST", `${API}/${grant.id}/end`, invoker)).json().status).toBe(
        "revoked",
      );
      expect((await eventsOf(grant.id)).map((e) => e.event_type)).toEqual([
        "m36.break_glass.granted",
        "m36.break_glass.revoked",
      ]);
      const second = (await open(invoker, groupChannel)).json();
      expect((await send(on, "POST", `${API}/${second.id}/end`, reviewerUser)).json().status).toBe(
        "revoked",
      );
      expect((await send(on, "POST", `${API}/${randomUUID()}/end`, invoker)).statusCode).toBe(404);
      expect((await send(on, "POST", `${API}/not-a-uuid/end`, invoker)).statusCode).toBe(404);
      await cleanup(grant.id, second.id);
    });

    it("REVIEWS: only a reviewer sees the queue; the grantee never reviews their own; it completes once, after the grant ended", async () => {
      stepUpFresh = true;
      const grant = (
        await open(both, groupChannel, {
          justification: "Needed to correct a handoff note for the night team",
        })
      ).json();
      const queue = await send(on, "GET", `${API}/reviews?status=pending`, reviewerUser);
      expect(queue.statusCode).toBe(200);
      const row = queue.json().reviews.find((r: { grantId: string }) => r.grantId === grant.id);
      expect(row).toMatchObject({
        status: "pending",
        stillActive: true,
        overdue: false,
        readCount: 0,
        channelKind: "discipline",
        patientId: null,
      });
      expect(row.justification).toContain("night team");
      const detail = await send(on, "GET", `${API}/reviews/${row.reviewId}`, reviewerUser);
      expect(detail.statusCode).toBe(200);
      expect(detail.json().reads).toEqual([]);
      const complete = (user: string, body: Record<string, unknown>) =>
        send(on, "POST", `${API}/reviews/${row.reviewId}/complete`, user, body);
      // Still live: 409 BREAK_GLASS_STILL_ACTIVE.
      const early = await complete(reviewerUser, { outcome: "reviewed" });
      expect(early.statusCode).toBe(409);
      expect(early.body).toContain("BREAK_GLASS_STILL_ACTIVE");
      expect((await send(on, "POST", `${API}/${grant.id}/end`, both)).json().status).toBe(
        "revoked",
      );
      // The grantee holds both keys, yet never reviews their own grant.
      expect((await complete(both, { outcome: "reviewed" })).statusCode).toBe(403);
      // A concern needs a note; the bad outcome is refused.
      expect((await complete(reviewerUser, { outcome: "concern" })).statusCode).toBe(422);
      expect((await complete(reviewerUser, { outcome: "fine" })).statusCode).toBe(422);
      const done = await complete(reviewerUser, {
        outcome: "concern",
        note: "Read beyond what the reason needed",
      });
      expect(done.statusCode).toBe(200);
      expect(done.json()).toMatchObject({
        status: "reviewed",
        outcome: "concern",
        reviewerUserId: reviewerUser,
        stillActive: false,
      });
      const twice = await complete(reviewerUser, { outcome: "reviewed" });
      expect(twice.statusCode).toBe(409);
      expect(twice.body).toContain("BREAK_GLASS_REVIEW_DONE");
      const events = (await eventsOf(grant.id)).map((e) => e.event_type);
      expect(events).toEqual([
        "m36.break_glass.granted",
        "m36.break_glass.revoked",
        "m36.break_glass.reviewed",
      ]);
      const reviewed = (await eventsOf(grant.id)).find(
        (e) => e.event_type === "m36.break_glass.reviewed",
      );
      expect(JSON.stringify(reviewed?.payload)).not.toContain("Read beyond");
      const history = await send(on, "GET", `${API}/reviews?status=reviewed`, reviewerUser);
      expect(history.json().reviews.some((r: { grantId: string }) => r.grantId === grant.id)).toBe(
        true,
      );
      expect(
        (await send(on, "GET", `${API}/reviews/${randomUUID()}`, reviewerUser)).statusCode,
      ).toBe(404);
      await cleanup(grant.id);
    });

    it("S4 the overdue sweep alerts once per open review three days after its grant ended: never earlier, never once reviewed, never while live", async () => {
      const emitted: Array<{
        orgId: string;
        correlationId: string;
        payload: Record<string, unknown>;
      }> = [];
      const sweep = createBreakGlassReviewSweep({
        db: kit.handle.db,
        alerts: {
          emit: async (orgId, input) => {
            emitted.push({ orgId, correlationId: input.correlationId, payload: input.payload });
            return { alertId: "a", resolvedRecipientCount: 1 };
          },
        },
      });
      // The guard (correctly) forbids moving a grant's instants, so age rows with the guard switched off, as the superuser.
      const GUARD = "trg_message_break_glass_grant_guard";
      const age = async (grantId: string, endedDaysAgo: number) => {
        await kit.admin.query(`ALTER TABLE message_break_glass_grant DISABLE TRIGGER ${GUARD}`);
        try {
          await kit.admin.query(
            `UPDATE message_break_glass_grant
                SET expires_at = now() - ($2::int * interval '1 day'),
                    granted_at = now() - ($2::int * interval '1 day') - interval '23 hours'
              WHERE id=$1`,
            [grantId, endedDaysAgo],
          );
        } finally {
          await kit.admin.query(`ALTER TABLE message_break_glass_grant ENABLE TRIGGER ${GUARD}`);
        }
      };
      const reviewOf = async (grantId: string) =>
        (
          await kit.one<{ id: string }>(
            "SELECT id FROM message_break_glass_review WHERE grant_id=$1",
            [grantId],
          )
        )[0].id;
      const old = await seed(invoker, "4 hours", "other", WHY, groupChannel);
      const recent = await seed(both, "4 hours", "other", WHY, groupChannel);
      const reviewed = await seed(memberInvoker, "4 hours", "other", WHY, groupChannel);
      const live = await seed(nobody, "4 hours", "other", WHY, groupChannel);
      await age(old, 4);
      await age(recent, 1);
      await age(reviewed, 4);
      await kit.one(
        "UPDATE message_break_glass_review SET reviewer_user_id=$2, reviewed_at=now(), outcome='reviewed' WHERE grant_id=$1",
        [reviewed, reviewerUser],
      );
      const first = await sweep.overdueForOrg(ORG_A);
      expect(first.overdue).toBe(1);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        orgId: ORG_A,
        correlationId: `break-glass:${await reviewOf(old)}:overdue`,
      });
      expect(emitted[0]?.payload).toMatchObject({
        grantId: old,
        overdueAfterDays: 3,
        deepLink: "/messaging/governance/break-glass",
      });
      expect(JSON.stringify(emitted[0]?.payload)).not.toMatch(/Covering|justification|name/i);
      // A later tick sees the same review and re-emits the SAME correlation id (the alert dedupe absorbs it).
      await sweep.overdueForOrg(ORG_A);
      expect(new Set(emitted.map((e) => e.correlationId)).size).toBe(1);
      await cleanup(old, recent, reviewed, live);
    });

    it("an expired grant is renewable only by a NEW justified request: the old one stays on record, ended, with its own review", async () => {
      stepUpFresh = true;
      // A 1-second grant seeded directly (the route minimum is 15 minutes).
      const old = await seed(invoker, "1 second", "other", WHY, groupChannel);
      await kit.one("SELECT pg_sleep(1.3)");
      // The unrevoked expired grant still holds the one-open slot; a new request ends it and opens a fresh one.
      const renewed = await open(invoker, groupChannel);
      expect(renewed.statusCode).toBe(201);
      expect(renewed.json().id).not.toBe(old);
      const [oldRow] = await kit.one<{ revoked: boolean }>(
        "SELECT revoked_at IS NOT NULL AS revoked FROM message_break_glass_grant WHERE id=$1",
        [old],
      );
      expect(oldRow.revoked).toBe(true);
      const all = await send(on, "GET", `${API}/reviews?status=all`, reviewerUser);
      const oldReview = all.json().reviews.find((r: { grantId: string }) => r.grantId === old);
      expect(oldReview).toMatchObject({ status: "pending", stillActive: false });
      await cleanup(old, renewed.json().id);
    });
  });
});
