/**
 * M36 ADR-0096 (PROPOSED), WP 6.6 - external partner share (migration 1180), LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role, through the
 * real routes (fastify inject), the real service and the real catalog-validating outbox publisher.
 *
 *   1. FLAG        off => create and EVERY partner route are the neutral 404; list and revoke still work.
 *   2. ACCESS      a clinical role is 403; a missing step-up is 403; a channel kind that may never be shared is the same 404 as an unknown channel.
 *   3. SECRETS     only hashes are stored; the invite is single use; the second factor locks after 5 attempts and never resets.
 *   4. SCOPE       the partner reads ONLY the shared conversation, ONLY what was posted after the share, minus attachments / links / references / redactions.
 *   5. IDOR        another share id, a random id and a malformed id are the same 404; an enrolment-stage bearer reads nothing.
 *   6. REVOKE      the very next request after a revoke is a 404 (no cache); a second revoke is 409.
 *   7. EXPIRY      an expired share is a 404 on the database clock.
 *   8. TENANCY     another organisation's staff sees nothing; a bearer or an invitation presented under another organisation matches nothing.
 *   9. TRAIL       every read leaves a trail row; the database refuses a read row for a revoked share; audit rows omit hashes.
 *  10. NO CONTENT  no outbox event, alert or notification row carries a message body; the notification text is a constant.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:external-share:live
 * Use a PRIVATE pgvector/pgvector:pg18 container (max_locks_per_transaction=2048): the suite resets the public schema and the chartwarden_* roles.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createPredicateRegistry, registerAbacRegistry } from "@chartwarden/auth";
import {
  EXTERNAL_PARTNERS_FLAG_KEY,
  EXTERNAL_PARTNER_NOTIFICATION_TEXT,
  EXTERNAL_SHARE_EVENT_CREATED,
  EXTERNAL_SHARE_EVENT_REVOKED,
} from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { partnerNotificationText } from "../src/modules/36-messaging/external-share/external-share-secrets";
import {
  type AttemptLimiter,
  createExternalShareService,
} from "../src/modules/36-messaging/external-share/external-share-service";
import {
  createDrizzleSharePartnerStore,
  createDrizzleShareStaffStore,
} from "../src/modules/36-messaging/external-share/external-share-store";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import { registerExternalShareRoutes } from "../src/modules/36-messaging/routes/external-share-routes";
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
  errorCode,
  headerAuth,
  mkChannel,
} from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a960001";
const ORG_B = "22222222-2222-4222-8222-22220a960002";
const API = "/api/v1/messaging/external-shares";
const PARTNER = "/api/v1/messaging/partner";
const MANAGE_KEYS = ["messaging.read", "messaging.share.manage"];
// No digit runs: the partner identifier matcher withholds any message holding 6 or more digits in a row (ADR-0096 D16).
const MARKER = `PLAIN-MARKER-${randomUUID().replace(/[0-9]/g, (c) => "ghijklmnop"[Number(c)] ?? "x")}`;
const HOUR_MS = 3_600_000;

type Row = Record<string, unknown>;
const shape = (body: string): string =>
  body.replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "ID");

interface Made {
  readonly id: string;
  readonly inviteToken: string;
  readonly code: string;
  readonly channel: string;
}

describe.skipIf(!DB_URL)("M36 ADR-0096 external partner share - LIVE Postgres", () => {
  let kit: LiveKit;
  let on: FastifyInstance;
  let off: FastifyInstance;
  let limited: FastifyInstance;
  let banner: FastifyInstance;
  let bannerOff: FastifyInstance;
  let stepUpFresh = true;
  const flagOn = true;
  let readBudget = 1_000;
  let author: string;
  let clinical: string;
  let outsider: string;
  const bodyCipher = createMessageBodyCipher({ kek: randomBytes(32), sealScheme: "legacy" });

  const mkService = (flag: boolean, readLimiter?: AttemptLimiter) =>
    createExternalShareService({
      staffStore: createDrizzleShareStaffStore(kit.handle.db),
      partnerStore: createDrizzleSharePartnerStore(kit.handle.db),
      outbox: catalogOutbox() as never,
      flags: { forOrg: async () => ({ [EXTERNAL_PARTNERS_FLAG_KEY]: flag && flagOn }) },
      cipher: bodyCipher,
      canViewChannel: kit.service.canViewChannel,
      ...(readLimiter ? { readLimiter } : {}),
    });
  const mkServer = (flag: boolean, readLimiter?: AttemptLimiter): FastifyInstance => {
    const service = mkService(flag, readLimiter);
    const server = buildServer({
      db: kit.handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(kit.handle.db),
    });
    registerExternalShareRoutes(server, { service });
    return server;
  };

  /** The messaging routes with the member banner wired (the channel detail), over the same service as the share routes. */
  const mkBannerServer = (flag: boolean): FastifyInstance => {
    const service = mkService(flag);
    const server = buildServer({
      db: kit.handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(kit.handle.db),
    });
    registerMessagingRoutes(server, {
      service: kit.service,
      announcements: createDbAnnouncementService(kit.handle.db),
      externalShare: { indicator: service.indicator },
    });
    return server;
  };

  const staff = (
    server: FastifyInstance,
    method: "GET" | "POST" | "DELETE",
    url: string,
    user: string,
    payload?: unknown,
    org = ORG_A,
  ) =>
    server.inject({
      method,
      url,
      headers: as(user, org),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const partner = (
    server: FastifyInstance,
    method: "GET" | "POST",
    url: string,
    bearer?: string,
    payload?: unknown,
  ) =>
    server.inject({
      method,
      url,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const newManager = () => kit.seedUser("mgr", ORG_A, MANAGE_KEYS);
  /** A channel of a kind mkChannel cannot build (dm / announcement / bereavement shape their subject, key and retention class). */
  const rawChannel = async (kind: "dm" | "announcement" | "bereavement"): Promise<string> =>
    (
      await kit.one<{ id: string }>(
        `INSERT INTO channel (organization_id, channel_kind, subject_id, dm_participant_key, title, retention_class, archives_at)
         VALUES ($1,$2::channel_kind,$3,$4,$5,$6::channel_retention_class,$7) RETURNING id`,
        [
          ORG_A,
          kind,
          kind === "bereavement" ? randomUUID() : null,
          kind === "dm" ? `k-${randomUUID()}` : null,
          `adr96-${kind}`,
          kind === "announcement" ? "operational" : kind === "dm" ? "care_related" : "bereavement",
          kind === "bereavement" ? new Date(Date.now() + 86_400_000).toISOString() : null,
        ],
      )
    )[0].id;
  const q = (sql: string, p: unknown[] = []) => kit.one<Row>(sql, p);
  const shareRow = async (id: string) =>
    (await q("SELECT * FROM message_external_share WHERE id=$1", [id]))[0] as Row;

  const seedMessage = async (
    channel: string,
    text: string,
    opts: { at?: Date; status?: string; by?: string } = {},
  ): Promise<string> => {
    const sealed = await bodyCipher.seal(ORG_A, text);
    return (
      await kit.one<{ id: string }>(
        `INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256, created_at, status, deleted_at)
         VALUES ($1,$2,$3,'user',$4,$5, coalesce($6::timestamptz, now()), $7::message_status, CASE WHEN $7 = 'deleted' THEN now() END) RETURNING id`,
        [
          ORG_A,
          channel,
          opts.by ?? author,
          sealed.cipher,
          sealed.sha256,
          opts.at?.toISOString() ?? null,
          opts.status ?? "sent",
        ],
      )
    )[0].id;
  };

  /** Create a share through the route (fresh manager, step-up fresh). */
  /** Makes `user` a plain member of `channel` (the creator of a share must be able to view it). */
  const join = async (user: string, channel: string): Promise<void> => {
    await kit.admin.query(
      `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source) VALUES ($1,$2,$3,'member','manual') ON CONFLICT DO NOTHING`,
      [ORG_A, channel, user],
    );
  };
  const mk = async (
    channel: string,
    over: Record<string, unknown> = {},
    server = on,
  ): Promise<Made> => {
    stepUpFresh = true;
    const mgr = await newManager();
    await join(mgr, channel);
    const res = await staff(server, "POST", API, mgr, {
      channelId: channel,
      partnerName: "Northside Pharmacy",
      partnerKind: "pharmacy",
      baaReference: "BAA-2026-0042",
      acknowledgedMinimumNecessary: true,
      ...over,
    });
    expect(res.statusCode, res.body).toBe(201);
    const j = res.json();
    return { id: j.id, inviteToken: j.inviteToken, code: j.verificationCode, channel };
  };
  const redeem = (m: Made, server = on, org = ORG_A, token = m.inviteToken) =>
    partner(server, "POST", `${PARTNER}/redeem`, undefined, { organizationId: org, token });
  /** redeem + verify => an ACTIVE bearer. */
  const activate = async (m: Made, server = on): Promise<string> => {
    const r = await redeem(m, server);
    expect(r.statusCode, r.body).toBe(200);
    const bearer = r.json().sessionToken as string;
    const v = await partner(server, "POST", `${PARTNER}/shares/${m.id}/verify`, bearer, {
      code: m.code,
    });
    expect(v.statusCode, v.body).toBe(200);
    expect(v.json().stage).toBe("active");
    // D13: verify returns a NEW bearer; the enrolment one is dead from here on.
    const active = v.json().sessionToken as string;
    expect(active).not.toBe(bearer);
    return active;
  };
  const read = (m: { id: string }, bearer: string, server = on, query = "") =>
    partner(server, "GET", `${PARTNER}/shares/${m.id}/messages${query}`, bearer);
  const bodies = (res: { json(): { messages: Array<{ body: string }> } }) =>
    res.json().messages.map((x) => x.body);

  /** Setup-only: fixture a state the app role can never reach, with the share guard switched off. */
  const withShareGuardOff = async (fn: () => Promise<unknown>) => {
    await kit.admin.query(
      "ALTER TABLE message_external_share DISABLE TRIGGER trg_message_external_share_guard",
    );
    try {
      await fn();
    } finally {
      await kit.admin.query(
        "ALTER TABLE message_external_share ENABLE TRIGGER trg_message_external_share_guard",
      );
    }
  };
  /** Frees the tenant and per-creator caps between groups (setup only). */
  const clearShares = () =>
    withShareGuardOff(() =>
      kit.admin.query(
        "UPDATE message_external_share SET revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, created_by), created_at = created_at - interval '3 days'",
      ),
    );

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "adr96");
    const registry = createPredicateRegistry();
    registry.register("step_up_recent", async () => stepUpFresh);
    registry.register(CHANNEL_VISIBILITY_READ_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return kit.service.canReadChannel(ctx.organizationId, ctx.userId, channelId);
    });
    registerAbacRegistry(registry);
    author = await kit.seedUser("author", ORG_A, STAFF_KEYS);
    clinical = await kit.seedUser("clinical", ORG_A, STAFF_KEYS);
    outsider = await kit.seedUser("outsider", ORG_B, MANAGE_KEYS);
    on = mkServer(true);
    off = mkServer(false);
    limited = mkServer(true, { consume: async () => ({ allowed: --readBudget >= 0 }) });
    banner = mkBannerServer(true);
    bannerOff = mkBannerServer(false);
    await Promise.all([
      on.ready(),
      off.ready(),
      limited.ready(),
      banner.ready(),
      bannerOff.ready(),
    ]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([
      on?.close(),
      off?.close(),
      limited?.close(),
      banner?.close(),
      bannerOff?.close(),
    ]);
    await kit?.close();
  });

  // ── 1 + 2: flag and access ────────────────────────────────────────────────────────────────────────────────────────────────
  describe("flag and access", () => {
    let channel: string;
    beforeAll(async () => {
      channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
    });

    it("flag off => create is the neutral 404 before any step-up, and nothing is written", async () => {
      const mgr = await newManager();
      stepUpFresh = false;
      const res = await staff(off, "POST", API, mgr, {
        channelId: channel,
        partnerName: "P",
        partnerKind: "dme",
        baaReference: "B",
        acknowledgedMinimumNecessary: true,
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("STEP_UP");
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM message_external_share WHERE created_by=$1",
          [mgr],
        ),
      ).toBe(0);
    });

    it("flag off => EVERY partner route is the same neutral 404 for a share that exists; list and revoke still work", async () => {
      const made = await mk(channel);
      const bearer = await activate(made);
      const unknown = await partner(off, "GET", `${PARTNER}/shares/${randomUUID()}`, bearer);
      const gone = await Promise.all([
        partner(off, "GET", `${PARTNER}/shares/${made.id}`, bearer),
        partner(off, "POST", `${PARTNER}/shares/${made.id}/verify`, bearer, { code: made.code }),
        read(made, bearer, off),
        redeem(made, off),
      ]);
      for (const res of gone) {
        expect(res.statusCode).toBe(404);
        expect(shape(res.body)).toBe(shape(unknown.body));
      }
      // The flag is a kill switch, not a deletion: turning it back on restores the very same bearer.
      expect((await partner(on, "GET", `${PARTNER}/shares/${made.id}`, bearer)).statusCode).toBe(
        200,
      );
      const mgr = await newManager();
      stepUpFresh = true;
      expect((await staff(off, "GET", API, mgr)).statusCode).toBe(200);
      expect((await staff(off, "DELETE", `${API}/${made.id}`, mgr)).statusCode).toBe(200);
    });

    it("a clinical role is 403 on create, list and revoke; a missing step-up is 403 on create and revoke", async () => {
      stepUpFresh = true;
      const body = {
        channelId: channel,
        partnerName: "P",
        partnerKind: "dme",
        baaReference: "B",
        acknowledgedMinimumNecessary: true,
      };
      expect((await staff(on, "POST", API, clinical, body)).statusCode).toBe(403);
      expect((await staff(on, "GET", API, clinical)).statusCode).toBe(403);
      expect((await staff(on, "DELETE", `${API}/${randomUUID()}`, clinical)).statusCode).toBe(403);
      const mgr = await newManager();
      stepUpFresh = false;
      expect((await staff(on, "POST", API, mgr, body)).statusCode).toBe(403);
      expect((await staff(on, "DELETE", `${API}/${randomUUID()}`, mgr)).statusCode).toBe(403);
      stepUpFresh = true;
    });

    it("a care_team, bereavement or announcement or direct-message channel (creator IS a member) and an unknown channel are the SAME 404 (no kind oracle)", async () => {
      stepUpFresh = true;
      const mgr = await newManager();
      const body = (id: string) => ({
        channelId: id,
        partnerName: "P",
        partnerKind: "dme",
        baaReference: "B",
        acknowledgedMinimumNecessary: true,
      });
      const refused = [
        await mkChannel(kit, "care_team", randomUUID(), [author]),
        await rawChannel("bereavement"),
        await rawChannel("announcement"),
        await rawChannel("dm"),
        randomUUID(),
      ];
      for (const id of refused.slice(0, -1)) await join(mgr, id);
      const results = await Promise.all(refused.map((id) => staff(on, "POST", API, mgr, body(id))));
      for (const res of results) expect(res.statusCode).toBe(404);
      expect(new Set(results.map((r) => shape(r.body))).size).toBe(1);
    });

    it("validates the body: expiry above 30 days, an empty BAA reference and a bad kind are 422", async () => {
      stepUpFresh = true;
      const mgr = await newManager();
      const ok = {
        channelId: channel,
        partnerName: "P",
        partnerKind: "dme",
        baaReference: "B",
        acknowledgedMinimumNecessary: true,
      };
      for (const bad of [
        { ...ok, expiresInDays: 31 },
        { ...ok, baaReference: "   " },
        { ...ok, partnerKind: "clinic" },
        { ...ok, partnerName: "" },
      ]) {
        expect((await staff(on, "POST", API, mgr, bad)).statusCode).toBe(422);
      }
    });
  });

  // ── 3: secrets, single use, second factor ────────────────────────────────────────────────────────────────────────────────
  describe("secrets and the second factor", () => {
    let channel: string;
    beforeAll(async () => {
      await clearShares();
      channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
    });

    it("stores only hashes; the default life is 7 days; the token and code are shown once", async () => {
      const made = await mk(channel);
      const row = await shareRow(made.id);
      const text = JSON.stringify(row);
      expect(text).not.toContain(made.inviteToken);
      expect(text).not.toContain(made.code);
      expect(String(row.invite_token_hash)).toMatch(/^[0-9a-f]{64}$/);
      expect(String(row.code_hash)).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
      const days =
        (new Date(String(row.expires_at)).getTime() - new Date(String(row.shared_from)).getTime()) /
        86_400_000;
      expect(Math.round(days * 10) / 10).toBe(7);
      const mgr = await newManager();
      const listed = JSON.stringify((await staff(on, "GET", API, mgr)).json());
      expect(listed).not.toContain(made.inviteToken);
      expect(listed).not.toContain(made.code);
    });

    it("the invitation is single use, and a wrong token is the neutral 404", async () => {
      const made = await mk(channel);
      expect((await redeem(made)).statusCode).toBe(200);
      const again = await redeem(made);
      expect(again.statusCode).toBe(404);
      const wrong = await redeem(made, on, ORG_A, randomBytes(32).toString("base64url"));
      expect(wrong.statusCode).toBe(404);
      expect(shape(wrong.body)).toBe(shape(again.body));
    });

    it("an enrolment-stage bearer reads nothing; a wrong code is 422 and counted; the right code activates", async () => {
      const made = await mk(channel);
      await seedMessage(channel, `${MARKER} stage`);
      const bearer = (await redeem(made)).json().sessionToken as string;
      expect((await read(made, bearer)).statusCode).toBe(404);
      const state = await partner(on, "GET", `${PARTNER}/shares/${made.id}`, bearer);
      expect(state.json()).toMatchObject({ stage: "enrolment", partnerName: "Northside Pharmacy" });
      const wrong = made.code === "00000000" ? "11111111" : "00000000";
      const bad = await partner(on, "POST", `${PARTNER}/shares/${made.id}/verify`, bearer, {
        code: wrong,
      });
      expect(bad.statusCode).toBe(422);
      expect(errorCode(bad)).toBe("EXTERNAL_SHARE_CODE_INVALID");
      expect(Number((await shareRow(made.id)).code_attempts)).toBe(1);
      expect((await read(made, bearer)).statusCode).toBe(404);
      const good = await partner(on, "POST", `${PARTNER}/shares/${made.id}/verify`, bearer, {
        code: made.code,
      });
      expect(good.json().stage).toBe("active");
      // The enrolment token was rotated away: only the new one reads.
      expect((await read(made, bearer)).statusCode).toBe(404);
      expect((await read(made, good.json().sessionToken)).statusCode).toBe(200);
    });

    it("five wrong codes lock the share for good: even the right code is then a 404, and the counter never resets", async () => {
      const made = await mk(channel);
      const bearer = (await redeem(made)).json().sessionToken as string;
      const wrong = made.code === "00000000" ? "11111111" : "00000000";
      for (let i = 0; i < 5; i += 1) {
        const bad = await partner(on, "POST", `${PARTNER}/shares/${made.id}/verify`, bearer, {
          code: wrong,
        });
        expect(bad.statusCode).toBe(422);
      }
      const locked = await partner(on, "POST", `${PARTNER}/shares/${made.id}/verify`, bearer, {
        code: made.code,
      });
      expect(locked.statusCode).toBe(404);
      expect(Number((await shareRow(made.id)).code_attempts)).toBe(5);
      const mgr = await newManager();
      const listed = (await staff(on, "GET", API, mgr)).json().shares as Array<{
        id: string;
        codeLocked: boolean;
      }>;
      expect(listed.find((s) => s.id === made.id)?.codeLocked).toBe(true);
    });

    it("the database caps the counter and freezes the secrets and the expiry (as the app role)", async () => {
      const made = await mk(channel);
      const mgr = await newManager();
      const tx = async (sql: string, p: unknown[] = []) => {
        await kit.appConn.query("BEGIN");
        try {
          await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
          await kit.appConn.query("SELECT set_config('app.user_id', $1, true)", [mgr]);
          await kit.appConn.query(sql, p);
          await kit.appConn.query("ROLLBACK");
          return null;
        } catch (err) {
          await kit.appConn.query("ROLLBACK").catch(() => undefined);
          return (err as Error).message;
        }
      };
      expect(
        await tx(
          "UPDATE message_external_share SET expires_at = expires_at + interval '1 day' WHERE id=$1",
          [made.id],
        ),
      ).toMatch(/permission denied|immutable/);
      expect(
        await tx("UPDATE message_external_share SET code_attempts = 3 WHERE id=$1", [made.id]),
      ).toMatch(/attempts/);
      expect(await tx("DELETE FROM message_external_share WHERE id=$1", [made.id])).toMatch(
        /permission denied/,
      );
      expect(
        await tx("UPDATE message_external_share SET invite_token_hash = 'x' WHERE id=$1", [
          made.id,
        ]),
      ).toMatch(/permission denied|immutable/);
    });
  });

  // ── 4: scope ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("what the partner can read", () => {
    it("reads ONLY the shared conversation, ONLY what was posted after the share, minus clinical content", async () => {
      await clearShares();
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const other = await mkChannel(kit, "discipline", randomUUID(), [author]);
      await seedMessage(channel, `${MARKER} BEFORE`, { at: new Date(Date.now() - HOUR_MS) });
      const made = await mk(channel);
      await seedMessage(other, `${MARKER} OTHER-CHANNEL`);
      await seedMessage(channel, `${MARKER} visible-1`);
      await seedMessage(channel, `${MARKER} deleted`, { status: "deleted" });
      const withAttachment = await seedMessage(channel, `${MARKER} attachment`);
      const withReference = await seedMessage(channel, `${MARKER} reference`);
      const withLink = await seedMessage(channel, `${MARKER} link`);
      const redacted = await seedMessage(channel, `${MARKER} redacted`);
      await seedMessage(channel, `${MARKER} visible-2`);
      await kit.admin.query(
        `INSERT INTO message_attachment (organization_id, channel_id, message_id, mime_type, byte_size, filename)
         VALUES ($1,$2,$3,'application/pdf',10,'f.pdf')`,
        [ORG_A, channel, withAttachment],
      );
      await kit.admin.query(
        `INSERT INTO message_entity_reference (organization_id, message_id, reference_kind, entity_id, start_offset, end_offset)
         VALUES ($1,$2,'patient',$3,0,3)`,
        [ORG_A, withReference, randomUUID()],
      );
      await kit.admin.query(
        `INSERT INTO clinical_link (organization_id, message_id, link_kind, source_id, created_by)
         VALUES ($1,$2,'medication',$3,$4)`,
        [ORG_A, withLink, randomUUID(), author],
      );
      await kit.admin.query("BEGIN");
      await kit.admin.query("SELECT set_config('app.user_id', $1, true)", [author]);
      await kit.admin.query(
        `INSERT INTO message_redaction (organization_id, message_id, requested_by, reason) VALUES ($1,$2,$3,'redaction needed here')`,
        [ORG_A, redacted, author],
      );
      await kit.admin.query("COMMIT");
      const bearer = await activate(made);
      const res = await read(made, bearer);
      expect(res.statusCode, res.body).toBe(200);
      expect(bodies(res)).toEqual([`${MARKER} visible-1`, `${MARKER} visible-2`]);
      expect(res.json().nextCursor).toBeNull();
      expect(res.body).not.toContain("channelId");
      expect(res.headers["cache-control"]).toContain("no-store");
    });

    it("pages with a keyset cursor and never repeats or skips a message", async () => {
      await clearShares();
      const channel = await mkChannel(kit, "location", randomUUID(), [author]);
      const made = await mk(channel);
      for (let i = 1; i <= 5; i += 1) await seedMessage(channel, `${MARKER} page-${i}`);
      const bearer = await activate(made);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 6; guard += 1) {
        const res = await read(
          made,
          bearer,
          on,
          `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        expect(res.statusCode, res.body).toBe(200);
        seen.push(...bodies(res));
        cursor = res.json().nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual([1, 2, 3, 4, 5].map((i) => `${MARKER} page-${i}`));
      expect((await read(made, bearer, on, "?cursor=junk")).statusCode).toBe(422);
    });

    it("a message posted after the share is visible on the very next read (live, not a snapshot)", async () => {
      await clearShares();
      const channel = await mkChannel(kit, "location", randomUUID(), [author]);
      const made = await mk(channel);
      const bearer = await activate(made);
      expect(bodies(await read(made, bearer))).toEqual([]);
      await seedMessage(channel, `${MARKER} live-now`);
      expect(bodies(await read(made, bearer))).toEqual([`${MARKER} live-now`]);
    });
  });

  // ── 5: IDOR ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("IDOR", () => {
    it("another share's id, a random id and a malformed id are the same 404 (never a 403)", async () => {
      await clearShares();
      const a = await mk(await mkChannel(kit, "discipline", randomUUID(), [author]));
      const b = await mk(await mkChannel(kit, "discipline", randomUUID(), [author]));
      const bearerA = await activate(a);
      const own = await read(a, bearerA);
      expect(own.statusCode).toBe(200);
      const probes = [
        read({ id: b.id }, bearerA),
        read({ id: randomUUID() }, bearerA),
        partner(on, "GET", `${PARTNER}/shares/not-a-uuid/messages`, bearerA),
        partner(on, "GET", `${PARTNER}/shares/${b.id}`, bearerA),
        partner(on, "POST", `${PARTNER}/shares/${b.id}/verify`, bearerA, { code: b.code }),
      ];
      const results = await Promise.all(probes);
      for (const res of results) expect(res.statusCode).toBe(404);
      // Only the id-bearing path 404s; a malformed id fails schema validation and is allowed to differ in code, never in status class.
      expect(
        new Set([results[0], results[1], results[3], results[4]].map((r) => shape(r.body))).size,
      ).toBe(1);
      // B was never touched by A's bearer: no attempt counted, still not redeemed.
      expect(Number((await shareRow(b.id)).code_attempts)).toBe(0);
    });

    it("no bearer, a malformed bearer and a forged bearer are the same 404", async () => {
      const made = await mk(await mkChannel(kit, "location", randomUUID(), [author]));
      const forged = `${ORG_A}.${randomBytes(32).toString("base64url")}`;
      const results = await Promise.all([
        partner(on, "GET", `${PARTNER}/shares/${made.id}/messages`),
        partner(on, "GET", `${PARTNER}/shares/${made.id}/messages`, "garbage"),
        partner(on, "GET", `${PARTNER}/shares/${made.id}/messages`, forged),
      ]);
      for (const res of results) expect(res.statusCode).toBe(404);
      expect(new Set(results.map((r) => shape(r.body))).size).toBe(1);
    });
  });

  // ── 6 + 7: revoke and expiry ──────────────────────────────────────────────────────────────────────────────────────────────
  describe("revoke and expiry", () => {
    it("the partner's VERY NEXT request after a revoke is a 404; a second revoke is 409; the event is PHI-free", async () => {
      await clearShares();
      const channel = await mkChannel(kit, "on_call", randomUUID(), [author]);
      const made = await mk(channel);
      await seedMessage(channel, `${MARKER} before-revoke`);
      const bearer = await activate(made);
      expect((await read(made, bearer)).statusCode).toBe(200);
      const mgr = await newManager();
      stepUpFresh = true;
      const revoked = await staff(on, "DELETE", `${API}/${made.id}`, mgr);
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect(revoked.json().status).toBe("revoked");
      for (const res of [
        await read(made, bearer),
        await partner(on, "GET", `${PARTNER}/shares/${made.id}`, bearer),
        await partner(on, "POST", `${PARTNER}/shares/${made.id}/verify`, bearer, {
          code: made.code,
        }),
      ]) {
        expect(res.statusCode).toBe(404);
      }
      expect((await staff(on, "DELETE", `${API}/${made.id}`, mgr)).statusCode).toBe(409);
      expect((await staff(on, "DELETE", `${API}/${randomUUID()}`, mgr)).statusCode).toBe(404);
      const events = await q(
        "SELECT event_type, payload FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, id",
        [made.id],
      );
      expect(events.map((e) => e.event_type)).toEqual([
        EXTERNAL_SHARE_EVENT_CREATED,
        EXTERNAL_SHARE_EVENT_REVOKED,
      ]);
      expect(Object.keys(events[1]?.payload as object).sort()).toEqual([
        "at",
        "channelId",
        "organizationId",
        "revokedBy",
        "shareId",
      ]);
    });

    it("a revoked share cannot be redeemed and a revoked invitation is dead", async () => {
      await clearShares();
      const made = await mk(await mkChannel(kit, "discipline", randomUUID(), [author]));
      const mgr = await newManager();
      stepUpFresh = true;
      expect((await staff(on, "DELETE", `${API}/${made.id}`, mgr)).statusCode).toBe(200);
      expect((await redeem(made)).statusCode).toBe(404);
    });

    it("an expired share is a 404 on the database clock (no cache), for an active bearer and for the invitation", async () => {
      await clearShares();
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const made = await mk(channel, { expiresInDays: 1 });
      const fresh = await mk(channel, { expiresInDays: 1 });
      const bearer = await activate(made);
      expect((await read(made, bearer)).statusCode).toBe(200);
      await withShareGuardOff(() =>
        kit.admin.query(
          "UPDATE message_external_share SET shared_from = shared_from - interval '2 days', created_at = created_at - interval '2 days', expires_at = expires_at - interval '2 days' WHERE id = ANY($1::uuid[])",
          [[made.id, fresh.id]],
        ),
      );
      expect((await read(made, bearer)).statusCode).toBe(404);
      expect((await redeem(fresh)).statusCode).toBe(404);
      const mgr = await newManager();
      const listed = (await staff(on, "GET", API, mgr)).json().shares as Array<{
        id: string;
        status: string;
      }>;
      expect(listed.find((s) => s.id === made.id)?.status).toBe("expired");
    });
  });

  // ── review fixes ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("review fixes", () => {
    it("create needs MEMBERSHIP: a non-member holder of the permission gets the SAME 404 as an unknown channel, and nothing is written", async () => {
      await clearShares();
      stepUpFresh = true;
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const mgr = await newManager(); // holds messaging.share.manage, is NOT a member
      const body = {
        partnerName: "P",
        partnerKind: "dme",
        baaReference: "B",
        acknowledgedMinimumNecessary: true,
      };
      const outsiderRes = await staff(on, "POST", API, mgr, { ...body, channelId: channel });
      const unknownRes = await staff(on, "POST", API, mgr, { ...body, channelId: randomUUID() });
      expect(outsiderRes.statusCode).toBe(404);
      expect(shape(outsiderRes.body)).toBe(shape(unknownRes.body));
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM message_external_share WHERE channel_id=$1",
          [channel],
        ),
      ).toBe(0);
      await join(mgr, channel);
      expect((await staff(on, "POST", API, mgr, { ...body, channelId: channel })).statusCode).toBe(
        201,
      );
    });

    it("a direct-message channel cannot be shared even by a member (404, nothing written)", async () => {
      await clearShares();
      stepUpFresh = true;
      const dm = await rawChannel("dm");
      const mgr = await newManager();
      await join(mgr, dm);
      const res = await staff(on, "POST", API, mgr, {
        channelId: dm,
        partnerName: "P",
        partnerKind: "dme",
        baaReference: "B",
        acknowledgedMinimumNecessary: true,
      });
      expect(res.statusCode).toBe(404);
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM message_external_share WHERE channel_id=$1",
          [dm],
        ),
      ).toBe(0);
    });

    it("an unauthenticated caller never sees validation detail: bad body or query with no live bearer is the 404", async () => {
      const made = await mk(await mkChannel(kit, "discipline", randomUUID(), [author]));
      const forged = `${ORG_A}.${randomBytes(32).toString("base64url")}`;
      const [a, b, c] = await Promise.all([
        partner(on, "POST", `${PARTNER}/shares/${made.id}/verify`, forged, { code: "nope" }),
        partner(on, "GET", `${PARTNER}/shares/${made.id}/messages?cursor=junk&limit=9999`, forged),
        partner(on, "GET", `${PARTNER}/shares/${made.id}/messages?cursor=junk`),
      ]);
      for (const res of [a, b, c]) expect(res.statusCode).toBe(404);
      expect(new Set([a, b, c].map((r) => shape(r.body))).size).toBe(1);
      // With a live bearer the same bad input is a 422.
      const bearer = await activate(made);
      expect((await read(made, bearer, on, "?cursor=junk")).statusCode).toBe(422);
      expect(
        (await partner(on, "POST", `${PARTNER}/shares/${made.id}/verify`, bearer, { code: "nope" }))
          .statusCode,
      ).toBe(422);
    });

    it("hides urgent, targeted, acknowledgment-request, legal-hold, pending/rejected-redaction messages and replies to hidden ones", async () => {
      await clearShares();
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const made = await mk(channel);
      const visible = await seedMessage(channel, `${MARKER} ok-root`);
      const sealed = await bodyCipher.seal(ORG_A, `${MARKER} urgent`);
      const urgent = (
        await kit.one<{ id: string }>(
          `INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256, urgency, urgent_recipient_user_id)
           VALUES ($1,$2,$3,'user',$4,$5,'urgent',$6) RETURNING id`,
          [ORG_A, channel, author, sealed.cipher, sealed.sha256, clinical],
        )
      )[0].id;
      const important = await seedMessage(channel, `${MARKER} important-ack`);
      const replyToHidden = await seedMessage(channel, `${MARKER} reply-to-urgent`);
      const replyToVisible = await seedMessage(channel, `${MARKER} reply-to-ok`);
      await kit.admin.query("UPDATE message SET parent_message_id=$2 WHERE id=$1", [
        replyToHidden,
        urgent,
      ]);
      await kit.admin.query("UPDATE message SET parent_message_id=$2 WHERE id=$1", [
        replyToVisible,
        visible,
      ]);
      // An ack request can only exist on a care_team channel (a trigger), which is never shareable; the exclusion is defence in depth, so the
      // fixture bypasses the trigger (setup only).
      await kit.admin.query("BEGIN");
      await kit.admin.query("SET LOCAL session_replication_role = replica");
      await kit.admin.query(
        `INSERT INTO message_acknowledgment_request (organization_id, message_id, channel_id, patient_id, ack_class, requester_user_id, assigned_user_id, deadline_at)
         VALUES ($1,$2,$3,$4,'important',$5,$6, now() + interval '1 hour')`,
        [ORG_A, important, channel, randomUUID(), author, clinical],
      );
      await kit.admin.query("COMMIT");
      const bearer = await activate(made);
      const got = bodies(await read(made, bearer));
      expect(got).toEqual([`${MARKER} ok-root`, `${MARKER} reply-to-ok`]);
    });

    it("a message under an ACTIVE legal hold is hidden from the partner and is shown again once the hold is released", async () => {
      await clearShares();
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const made = await mk(channel);
      await seedMessage(channel, `${MARKER} held-later`);
      const bearer = await activate(made);
      expect(bodies(await read(made, bearer))).toEqual([`${MARKER} held-later`]);
      const hold = (
        await kit.one<{ id: string }>(
          `INSERT INTO legal_hold (organization_id, name, criteria, reason) VALUES ($1,'adr96-hold',$2::jsonb,'litigation hold for the test') RETURNING id`,
          [ORG_A, JSON.stringify({ channelIds: [channel] })],
        )
      )[0].id;
      expect(bodies(await read(made, bearer))).toEqual([]);
      await kit.admin.query(
        "UPDATE legal_hold SET status='released', released_at=now() WHERE id=$1",
        [hold],
      );
      expect(bodies(await read(made, bearer))).toEqual([`${MARKER} held-later`]);
    });

    it("the lockout is a durable audit trail: every wrong attempt and the 5th (locking) one leave an audit row without the code", async () => {
      await clearShares();
      const made = await mk(await mkChannel(kit, "discipline", randomUUID(), [author]));
      const bearer = (await redeem(made)).json().sessionToken as string;
      const wrong = made.code === "00000000" ? "11111111" : "00000000";
      for (let i = 0; i < 5; i += 1) {
        await partner(on, "POST", `${PARTNER}/shares/${made.id}/verify`, bearer, { code: wrong });
      }
      const rows = await q(
        "SELECT (after->>'code_attempts')::int AS n, after::text AS after FROM audit_event WHERE resource_id::text = $1 AND event_type = 'message_external_share.update' ORDER BY n DESC NULLS LAST",
        [made.id],
      );
      expect(rows.some((r) => Number(r.n) === 5)).toBe(true);
      for (const r of rows) {
        expect(String(r.after)).not.toContain(made.code);
        expect(String(r.after)).not.toContain("code_hash");
      }
    });
  });

  // ── ADR-0096 D13 to D18 ───────────────────────────────────────────────────────────────────────────────────────────────────
  /** Setup-only: the session guard forces last_seen_at := now() on any update, so ageing a session fixtures it with the guard off. */
  const withSessionGuardOff = async <T>(fn: () => Promise<T>): Promise<T> => {
    await kit.admin.query(
      "ALTER TABLE message_external_session DISABLE TRIGGER trg_message_external_session_guard",
    );
    try {
      return await fn();
    } finally {
      await kit.admin.query(
        "ALTER TABLE message_external_session ENABLE TRIGGER trg_message_external_session_guard",
      );
    }
  };
  const idleFor = (shareId: string, minutes: number) =>
    withSessionGuardOff(() =>
      kit.admin.query(
        "UPDATE message_external_session SET last_seen_at = now() - make_interval(mins => $2) WHERE share_id=$1",
        [shareId, minutes],
      ),
    );
  /** Runs one statement as the app role for `user`; null when it ran (rolled back), else the database message. */
  const appRun = async (
    user: string,
    sql: string,
    params: unknown[] = [],
  ): Promise<string | null> => {
    await kit.appConn.query("BEGIN");
    try {
      await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
      await kit.appConn.query("SELECT set_config('app.user_id', $1, true)", [user]);
      await kit.appConn.query(sql, params);
      return null;
    } catch (err) {
      return (err as Error).message;
    } finally {
      await kit.appConn.query("ROLLBACK").catch(() => undefined);
    }
  };
  const REISSUE = (id: string) => `${API}/${id}/reissue`;
  const stateOf = (made: { id: string }, bearer: string, server = on) =>
    partner(server, "GET", `${PARTNER}/shares/${made.id}`, bearer);

  describe("session life, rotation and reissue (D13, D14)", () => {
    it("IDLE: 31 minutes without a request kills the bearer; every accepted request restarts the clock", async () => {
      await clearShares();
      const made = await mk(await mkChannel(kit, "discipline", randomUUID(), [author]));
      const bearer = await activate(made);
      await idleFor(made.id, 29);
      expect((await stateOf(made, bearer)).statusCode).toBe(200); // accepted: last_seen_at is now again
      await idleFor(made.id, 29);
      expect((await read(made, bearer)).statusCode).toBe(200);
      await idleFor(made.id, 31);
      for (const res of [await stateOf(made, bearer), await read(made, bearer)]) {
        expect(res.statusCode).toBe(404);
      }
      // A rejected request does not revive it.
      expect((await stateOf(made, bearer)).statusCode).toBe(404);
    });

    it("ABSOLUTE: 12 hours kills it even when it was used a second ago; the session never outlives 12 hours or the share", async () => {
      await clearShares();
      const made = await mk(await mkChannel(kit, "discipline", randomUUID(), [author]), {
        expiresInDays: 30,
      });
      const bearer = await activate(made);
      const row = (
        await q(
          "SELECT extract(epoch FROM (expires_at - created_at)) AS life, expires_at <= (SELECT expires_at FROM message_external_share WHERE id=$1) AS within FROM message_external_session WHERE share_id=$1",
          [made.id],
        )
      )[0] as Row;
      expect(Number(row.life)).toBeLessThanOrEqual(12 * 3600);
      expect(row.within).toBe(true);
      expect((await stateOf(made, bearer)).statusCode).toBe(200);
      await withSessionGuardOff(() =>
        kit.admin.query(
          "UPDATE message_external_session SET created_at = created_at - interval '13 hours', expires_at = expires_at - interval '13 hours' WHERE share_id=$1",
          [made.id],
        ),
      );
      expect((await stateOf(made, bearer)).statusCode).toBe(404);
      expect((await read(made, bearer)).statusCode).toBe(404);
    });

    it("the database refuses a session past 12 hours, and a last-seen touch alone leaves no audit row", async () => {
      await clearShares();
      const made = await mk(await mkChannel(kit, "discipline", randomUUID(), [author]));
      const bearer = await activate(made);
      const before = await kit.count(
        "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='message_external_session'",
      );
      await stateOf(made, bearer);
      await stateOf(made, bearer);
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='message_external_session'",
        ),
      ).toBe(before);
      const bad = await withSessionGuardOff(() =>
        kit.admin
          .query(
            "UPDATE message_external_session SET expires_at = created_at + interval '13 hours' WHERE share_id=$1",
            [made.id],
          )
          .then(
            () => null,
            (e: Error) => e.message,
          ),
      );
      expect(bad).toMatch(/lifetime|violates check/);
    });

    it("ROTATION: the enrolment token is useless once verify has returned the active one", async () => {
      await clearShares();
      const made = await mk(await mkChannel(kit, "discipline", randomUUID(), [author]));
      const enrolment = (await redeem(made)).json().sessionToken as string;
      expect((await stateOf(made, enrolment)).statusCode).toBe(200);
      const verified = await partner(on, "POST", `${PARTNER}/shares/${made.id}/verify`, enrolment, {
        code: made.code,
      });
      expect(verified.statusCode, verified.body).toBe(200);
      const active = verified.json().sessionToken as string;
      expect(active).not.toBe(enrolment);
      expect((await stateOf(made, enrolment)).statusCode).toBe(404);
      expect((await read(made, enrolment)).statusCode).toBe(404);
      expect(
        (
          await partner(on, "POST", `${PARTNER}/shares/${made.id}/verify`, enrolment, {
            code: made.code,
          })
        ).statusCode,
      ).toBe(404);
      expect((await stateOf(made, active)).json().stage).toBe("active");
      // Verify on the active bearer rotates nothing and returns no token.
      const again = await partner(on, "POST", `${PARTNER}/shares/${made.id}/verify`, active, {
        code: made.code,
      });
      expect(again.statusCode).toBe(200);
      expect(again.json().sessionToken).toBeNull();
      // Only the hash of the new bearer is stored.
      const text = JSON.stringify(
        await q("SELECT * FROM message_external_session WHERE share_id=$1", [made.id]),
      );
      expect(text).not.toContain(active);
      expect(text).not.toContain(enrolment);
    });

    it("REISSUE: new invitation and NEW code, the old session, invitation and code are dead, the counter restarts, and it is audited without secrets", async () => {
      await clearShares();
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const made = await mk(channel);
      const unredeemed = await mk(channel);
      const bearer = await activate(made);
      const wrong = made.code === "00000000" ? "11111111" : "00000000";
      // Burn attempts on a second redeemed-but-unverified session of another share to prove the reset: use `unredeemed`'s enrolment session.
      const burner = (await redeem(unredeemed)).json().sessionToken as string;
      for (let i = 0; i < 3; i += 1) {
        await partner(on, "POST", `${PARTNER}/shares/${unredeemed.id}/verify`, burner, {
          code: unredeemed.code === wrong ? "22222222" : wrong,
        });
      }
      expect(Number((await shareRow(unredeemed.id)).code_attempts)).toBe(3);

      const mgr = await newManager();
      stepUpFresh = true;
      const res = await staff(on, "POST", REISSUE(unredeemed.id), mgr);
      expect(res.statusCode, res.body).toBe(200);
      const fresh = res.json();
      expect(fresh.inviteToken).not.toBe(unredeemed.inviteToken);
      expect(fresh.verificationCode).toMatch(/^\d{8}$/);
      const row = await shareRow(unredeemed.id);
      expect(Number(row.code_attempts)).toBe(0);
      expect(row.invite_redeemed_at).toBeNull();
      expect(Number(row.invite_generation)).toBe(2);
      expect(row.reissued_by).toBe(mgr);
      expect(JSON.stringify(row)).not.toContain(fresh.inviteToken);
      expect(JSON.stringify(row)).not.toContain(fresh.verificationCode);
      // The old session (enrolment, of generation 1) and the old invitation are dead.
      expect((await stateOf(unredeemed, burner)).statusCode).toBe(404);
      expect((await redeem(unredeemed)).statusCode).toBe(404); // the OLD invitation token
      // The new invitation works; the OLD code does not (and is counted); the NEW one does.
      const next = await partner(on, "POST", `${PARTNER}/redeem`, undefined, {
        organizationId: ORG_A,
        token: fresh.inviteToken,
      });
      expect(next.statusCode, next.body).toBe(200);
      const nextBearer = next.json().sessionToken as string;
      const oldCode = await partner(
        on,
        "POST",
        `${PARTNER}/shares/${unredeemed.id}/verify`,
        nextBearer,
        { code: unredeemed.code },
      );
      expect(oldCode.statusCode).toBe(422);
      expect(Number((await shareRow(unredeemed.id)).code_attempts)).toBe(1);
      const okCode = await partner(
        on,
        "POST",
        `${PARTNER}/shares/${unredeemed.id}/verify`,
        nextBearer,
        { code: fresh.verificationCode },
      );
      expect(okCode.json().stage).toBe("active");
      // An ACTIVE session of the older generation dies the same way.
      const activeBeforeReissue = await mk(channel);
      const activeBearer = await activate(activeBeforeReissue);
      expect((await stateOf(activeBeforeReissue, activeBearer)).statusCode).toBe(200);
      expect((await staff(on, "POST", REISSUE(activeBeforeReissue.id), mgr)).statusCode).toBe(200);
      expect((await stateOf(activeBeforeReissue, activeBearer)).statusCode).toBe(404);
      expect((await read(activeBeforeReissue, activeBearer)).statusCode).toBe(404);
      // The untouched share keeps working.
      expect((await stateOf(made, bearer)).statusCode).toBe(200);
      // Audit: the update is recorded with the generation and the actor, never a hash or a code; the event is PHI-free.
      const audit = await q(
        "SELECT after::text AS after FROM audit_event WHERE resource_id::text = $1 AND event_type = 'message_external_share.update' AND (after->>'invite_generation')::int = 2",
        [unredeemed.id],
      );
      expect(audit.length).toBeGreaterThan(0);
      for (const r of audit) {
        expect(String(r.after)).toContain("reissued_by");
        expect(String(r.after)).not.toContain("code_hash");
        expect(String(r.after)).not.toContain(fresh.verificationCode);
      }
      const events = await q(
        "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m36.external_share.reissued'",
        [unredeemed.id],
      );
      expect(events).toHaveLength(1);
      expect(Object.keys(events[0]?.payload as object).sort()).toEqual([
        "at",
        "channelId",
        "organizationId",
        "reissuedBy",
        "shareId",
      ]);
    });

    it("the counter and the redemption cannot be reset any other way (the database refuses, as the app role)", async () => {
      await clearShares();
      const made = await mk(await mkChannel(kit, "discipline", randomUUID(), [author]));
      const bearer = (await redeem(made)).json().sessionToken as string;
      const wrong = made.code === "00000000" ? "11111111" : "00000000";
      await partner(on, "POST", `${PARTNER}/shares/${made.id}/verify`, bearer, { code: wrong });
      const mgr = await newManager();
      expect(
        await appRun(mgr, "UPDATE message_external_share SET code_attempts = 0 WHERE id=$1", [
          made.id,
        ]),
      ).toMatch(/attempts/);
      expect(
        await appRun(
          mgr,
          "UPDATE message_external_share SET invite_redeemed_at = NULL WHERE id=$1",
          [made.id],
        ),
      ).toMatch(/single use/);
      expect(
        await appRun(
          mgr,
          "UPDATE message_external_share SET invite_generation = invite_generation + 1 WHERE id=$1",
          [made.id],
        ),
      ).toMatch(/reissue/);
      expect(
        await appRun(mgr, "UPDATE message_external_share SET invite_token_hash = 'x' WHERE id=$1", [
          made.id,
        ]),
      ).toMatch(/immutable/);
      expect(
        await appRun(mgr, "UPDATE message_external_share SET code_hash = 'x' WHERE id=$1", [
          made.id,
        ]),
      ).toMatch(/immutable/);
      const reissueSet = (extra: string) =>
        `UPDATE message_external_share SET invite_generation = invite_generation + 1, invite_token_hash = 'n1', code_hash = 'n2', invite_redeemed_at = NULL, code_attempts = 0${extra} WHERE id=$1`;
      // The explicit path needs: the acting user as reissued_by, NEW secrets, zero attempts, a live share.
      expect(await appRun(mgr, reissueSet(""), [made.id])).toMatch(/actor/);
      expect(await appRun(mgr, reissueSet(`, reissued_by = '${randomUUID()}'`), [made.id])).toMatch(
        /actor|foreign key|violates/,
      );
      expect(await appRun(mgr, reissueSet(`, reissued_by = '${mgr}'`), [made.id])).toBeNull();
      expect(
        await appRun(
          mgr,
          `UPDATE message_external_share SET invite_generation = invite_generation + 1, invite_token_hash = invite_token_hash, code_hash = 'n2', invite_redeemed_at = NULL, code_attempts = 0, reissued_by = '${mgr}' WHERE id=$1`,
          [made.id],
        ),
      ).toMatch(/new invitation AND a new code/);
      expect(
        await appRun(
          mgr,
          `UPDATE message_external_share SET invite_generation = invite_generation + 2, invite_token_hash = 'n1', code_hash = 'n2', invite_redeemed_at = NULL, code_attempts = 0, reissued_by = '${mgr}' WHERE id=$1`,
          [made.id],
        ),
      ).toMatch(/one generation/);
      expect(
        await appRun(
          mgr,
          `UPDATE message_external_share SET invite_generation = invite_generation + 1, invite_token_hash = 'n1', code_hash = 'n2', code_attempts = 1, reissued_by = '${mgr}' WHERE id=$1`,
          [made.id],
        ),
      ).toMatch(/zero attempts/);
      // Sessions: the bearer hash changes only with the stage; the lifetime columns are frozen.
      expect(
        await appRun(
          mgr,
          "UPDATE message_external_session SET token_hash = 'zzz' WHERE share_id=$1",
          [made.id],
        ),
      ).toMatch(/rotates the bearer/);
      expect(
        await appRun(
          mgr,
          "UPDATE message_external_session SET expires_at = expires_at + interval '1 hour' WHERE share_id=$1",
          [made.id],
        ),
      ).toMatch(/permission denied|immutable/);
      expect(
        await appRun(
          mgr,
          "UPDATE message_external_session SET stage = 'active', token_hash = token_hash WHERE share_id=$1",
          [made.id],
        ),
      ).toMatch(/rotates the bearer/);
      // A revoked share cannot be reissued at the database either.
      stepUpFresh = true;
      expect((await staff(on, "DELETE", `${API}/${made.id}`, mgr)).statusCode).toBe(200);
      expect(await appRun(mgr, reissueSet(`, reissued_by = '${mgr}'`), [made.id])).toMatch(
        /live share/,
      );
    });

    it("reissue is gated: flag off 404, clinical role 403, no step-up 403, a revoked share 409, an unknown share 404", async () => {
      await clearShares();
      const made = await mk(await mkChannel(kit, "discipline", randomUUID(), [author]));
      const mgr = await newManager();
      stepUpFresh = true;
      expect((await staff(off, "POST", REISSUE(made.id), mgr)).statusCode).toBe(404);
      expect((await staff(on, "POST", REISSUE(made.id), clinical)).statusCode).toBe(403);
      stepUpFresh = false;
      expect((await staff(on, "POST", REISSUE(made.id), mgr)).statusCode).toBe(403);
      stepUpFresh = true;
      expect((await staff(on, "POST", REISSUE(randomUUID()), mgr)).statusCode).toBe(404);
      expect((await staff(on, "DELETE", `${API}/${made.id}`, mgr)).statusCode).toBe(200);
      expect((await staff(on, "POST", REISSUE(made.id), mgr)).statusCode).toBe(409);
      expect(
        (await staff(outsiderServer(), "POST", REISSUE(made.id), outsider, undefined, ORG_B))
          .statusCode,
      ).toBe(404);
    });
  });

  const outsiderServer = () => on;

  describe("minimum necessary and identifiers (D15, D16)", () => {
    it("create REQUIRES the acknowledgement (422 without it) and stores and audits it", async () => {
      await clearShares();
      stepUpFresh = true;
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const mgr = await newManager();
      await join(mgr, channel);
      const body = { channelId: channel, partnerName: "P", partnerKind: "dme", baaReference: "B" };
      for (const bad of [{}, { acknowledgedMinimumNecessary: false }]) {
        expect((await staff(on, "POST", API, mgr, { ...body, ...bad })).statusCode).toBe(422);
      }
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM message_external_share WHERE channel_id=$1",
          [channel],
        ),
      ).toBe(0);
      const ok = await staff(on, "POST", API, mgr, { ...body, acknowledgedMinimumNecessary: true });
      expect(ok.statusCode, ok.body).toBe(201);
      expect((await shareRow(ok.json().id)).minimum_necessary_acknowledged).toBe(true);
      const audit = await q(
        "SELECT after::text AS after FROM audit_event WHERE resource_id::text=$1 AND event_type='message_external_share.insert'",
        [ok.json().id],
      );
      expect(String(audit[0]?.after)).toContain("minimum_necessary_acknowledged");
      expect(
        await appRun(
          mgr,
          "UPDATE message_external_share SET minimum_necessary_acknowledged = false WHERE id=$1",
          [ok.json().id],
        ),
      ).toMatch(/permission denied|immutable/);
    });

    it("a message with an identifier is WITHHELD (omitted), ordinary clinical shorthand passes, and the trail counts the withheld ones without content", async () => {
      await clearShares();
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const made = await mk(channel);
      await seedMessage(channel, `${MARKER} give 2 tabs of 5 mg at 10:30, room 214`);
      await seedMessage(channel, `${MARKER} DOB 4/12/1950 is on the chart`);
      await seedMessage(channel, `${MARKER} her number is 555-123-4567`);
      await seedMessage(channel, `${MARKER} refill ready for pickup`);
      await seedMessage(channel, `${MARKER} mrn A12345 please confirm`);
      const bearer = await activate(made);
      const res = await read(made, bearer);
      expect(res.statusCode, res.body).toBe(200);
      expect(bodies(res)).toEqual([
        `${MARKER} give 2 tabs of 5 mg at 10:30, room 214`,
        `${MARKER} refill ready for pickup`,
      ]);
      expect(res.body).not.toContain("1950");
      expect(res.body).not.toContain("555-123");
      const trail = await q(
        "SELECT message_count, withheld_count FROM message_external_share_read WHERE share_id=$1",
        [made.id],
      );
      expect(trail.map((r) => [Number(r.message_count), Number(r.withheld_count)])).toEqual([
        [2, 3],
      ]);
      expect(
        JSON.stringify(
          await q("SELECT * FROM message_external_share_read WHERE share_id=$1", [made.id]),
        ),
      ).not.toContain("1950");
    });
  });

  describe("member banner (D18)", () => {
    const detail = (server: FastifyInstance, user: string, channel: string) =>
      staff(server, "GET", `/api/v1/messaging/channels/${channel}`, user);

    it("a member sees the indicator while a share is active; it names the kind and expiry and nothing else", async () => {
      await clearShares();
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const before = await detail(banner, author, channel);
      expect(before.statusCode, before.body).toBe(200);
      expect(before.json().externalShare).toBeUndefined();
      const made = await mk(channel, { partnerKind: "dme" });
      const res = await detail(banner, author, channel);
      expect(res.statusCode, res.body).toBe(200);
      const share = res.json().externalShare;
      expect(share).toMatchObject({ active: true, partnerKind: "dme" });
      expect(Object.keys(share).sort()).toEqual(["active", "expiresAt", "partnerKind"]);
      expect(new Date(share.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(JSON.stringify(share)).not.toContain(made.id);
      expect(JSON.stringify(share)).not.toContain("Northside");
    });

    it("a non-member never sees it (the channel is refused outright)", async () => {
      await clearShares();
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      await mk(channel);
      const res = await detail(banner, clinical, channel);
      expect([403, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain("externalShare");
    });

    it("revoked, expired and flag-off all remove it on the next read (flag off cuts partner reads, so the banner follows)", async () => {
      await clearShares();
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const revoked = await mk(channel);
      const mgr = await newManager();
      stepUpFresh = true;
      expect((await detail(banner, author, channel)).json().externalShare?.active).toBe(true);
      expect((await detail(bannerOff, author, channel)).json().externalShare).toBeUndefined();
      expect((await staff(on, "DELETE", `${API}/${revoked.id}`, mgr)).statusCode).toBe(200);
      expect((await detail(banner, author, channel)).json().externalShare).toBeUndefined();
      const expiring = await mk(channel, { expiresInDays: 1 });
      expect((await detail(banner, author, channel)).json().externalShare?.active).toBe(true);
      await withShareGuardOff(() =>
        kit.admin.query(
          "UPDATE message_external_share SET shared_from = shared_from - interval '2 days', created_at = created_at - interval '2 days', expires_at = expires_at - interval '2 days' WHERE id=$1",
          [expiring.id],
        ),
      );
      expect((await detail(banner, author, channel)).json().externalShare).toBeUndefined();
    });

    it("with two active shares the banner shows the one that ends last", async () => {
      await clearShares();
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      await mk(channel, { expiresInDays: 2 });
      await mk(channel, { expiresInDays: 9 });
      const share = (await detail(banner, author, channel)).json().externalShare;
      const days = (new Date(share.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(8);
    });
  });

  // ── 8: tenancy ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("tenancy", () => {
    it("another organisation's staff lists and revokes nothing; a bearer or an invitation under another organisation matches nothing", async () => {
      await clearShares();
      const made = await mk(await mkChannel(kit, "discipline", randomUUID(), [author]));
      stepUpFresh = true;
      const listed = await staff(on, "GET", API, outsider, undefined, ORG_B);
      expect(listed.json().shares).toEqual([]);
      expect(
        (await staff(on, "DELETE", `${API}/${made.id}`, outsider, undefined, ORG_B)).statusCode,
      ).toBe(404);
      expect((await redeem(made, on, ORG_B)).statusCode).toBe(404);
      const bearer = await activate(made);
      const [, token] = bearer.split(".");
      const swapped = `${ORG_B}.${token}`;
      expect((await read(made, swapped)).statusCode).toBe(404);
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM message_external_share WHERE id=$1 AND revoked_at IS NULL",
          [made.id],
        ),
      ).toBe(1);
    });

    it("RLS: the app role in another organisation sees none of the three tables' rows", async () => {
      const made = await mk(await mkChannel(kit, "discipline", randomUUID(), [author]));
      await activate(made);
      await kit.appConn.query("BEGIN");
      try {
        await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_B]);
        for (const table of [
          "message_external_share",
          "message_external_session",
          "message_external_share_read",
        ]) {
          const n = (await kit.appConn.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
          expect(n, table).toBe(0);
        }
      } finally {
        await kit.appConn.query("ROLLBACK");
      }
    });
  });

  // ── 9: trail and audit ────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("read trail and audit", () => {
    it("every successful read leaves exactly one trail row with the count; audit rows land and omit the hashes", async () => {
      await clearShares();
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const made = await mk(channel);
      await seedMessage(channel, `${MARKER} trail-1`);
      await seedMessage(channel, `${MARKER} trail-2`);
      const bearer = await activate(made);
      expect((await read(made, bearer)).statusCode).toBe(200);
      expect((await read(made, bearer, on, "?limit=1")).statusCode).toBe(200);
      const trail = await q(
        "SELECT message_count FROM message_external_share_read WHERE share_id=$1 ORDER BY read_at, id",
        [made.id],
      );
      expect(trail.map((r) => Number(r.message_count))).toEqual([2, 1]);
      const audit = await q(
        "SELECT event_type, after::text AS after FROM audit_event WHERE resource_id::text = $1 OR after->>'share_id' = $1",
        [made.id],
      );
      expect(audit.map((r) => r.event_type)).toEqual(
        expect.arrayContaining([
          "message_external_share.insert",
          "message_external_share_read.insert",
        ]),
      );
      for (const row of audit) {
        expect(String(row.after)).not.toContain("invite_token_hash");
        expect(String(row.after)).not.toContain("code_hash");
        expect(String(row.after)).not.toContain("token_hash");
      }
    });

    it("the database refuses a trail row for a revoked share, an enrolment session or another share's session", async () => {
      await clearShares();
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const made = await mk(channel);
      const other = await mk(channel);
      const bearer = await activate(made);
      const sessionId = (
        await q("SELECT id FROM message_external_session WHERE share_id=$1", [made.id])
      )[0]?.id as string;
      await activate(other);
      const otherSession = (
        await q("SELECT id FROM message_external_session WHERE share_id=$1", [other.id])
      )[0]?.id as string;
      const tryInsert = async (shareId: string, session: string) => {
        await kit.appConn.query("BEGIN");
        try {
          await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
          await kit.appConn.query(
            "INSERT INTO message_external_share_read (organization_id, share_id, session_id, message_count) VALUES ($1,$2,$3,0)",
            [ORG_A, shareId, session],
          );
          return null;
        } catch (err) {
          return (err as Error).message;
        } finally {
          await kit.appConn.query("ROLLBACK").catch(() => undefined);
        }
      };
      expect(await tryInsert(made.id, sessionId)).toBeNull();
      expect(await tryInsert(made.id, otherSession)).toMatch(
        /message_external_share_read_live|foreign key|violates/,
      );
      const mgr = await newManager();
      stepUpFresh = true;
      expect((await staff(on, "DELETE", `${API}/${made.id}`, mgr)).statusCode).toBe(200);
      expect(await tryInsert(made.id, sessionId)).toMatch(/message_external_share_read_live/);
      expect((await read(made, bearer)).statusCode).toBe(404);
    });

    it("a read that is rate limited is a 429 and leaves no trail row", async () => {
      await clearShares();
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const made = await mk(channel, {}, limited);
      const bearer = await activate(made, limited);
      readBudget = 1;
      expect((await read(made, bearer, limited)).statusCode).toBe(200);
      expect((await read(made, bearer, limited)).statusCode).toBe(429);
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM message_external_share_read WHERE share_id=$1",
          [made.id],
        ),
      ).toBe(1);
    });
  });

  // ── 10: no content out of band ────────────────────────────────────────────────────────────────────────────────────────────
  describe("no content out of band", () => {
    it("the notification text is a constant; no outbox event, alert or notification row carries a message body", async () => {
      expect(partnerNotificationText()).toBe(EXTERNAL_PARTNER_NOTIFICATION_TEXT);
      expect(partnerNotificationText()).not.toMatch(/[0-9]|@/);
      const dump = async (table: string) =>
        (
          await kit.admin.query(`SELECT count(*)::int AS n FROM ${table} t WHERE t::text LIKE $1`, [
            `%${MARKER}%`,
          ])
        ).rows[0].n as number;
      expect(await dump("outbox_event")).toBe(0);
      expect(await dump("audit_event")).toBe(0);
      expect(await dump("message_external_share")).toBe(0);
      expect(await dump("message_external_session")).toBe(0);
      expect(await dump("message_external_share_read")).toBe(0);
      for (const table of ["alert", "notification_delivery"]) {
        const exists = await q("SELECT to_regclass($1) AS t", [`public.${table}`]);
        if (exists[0]?.t) expect(await dump(table), table).toBe(0);
      }
    });
  });
});
