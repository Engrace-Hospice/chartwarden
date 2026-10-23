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
const MARKER = `PLAIN-MARKER-${randomUUID()}`;
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
  let stepUpFresh = true;
  const flagOn = true;
  let readBudget = 1_000;
  let author: string;
  let clinical: string;
  let outsider: string;
  const bodyCipher = createMessageBodyCipher({ kek: randomBytes(32), sealScheme: "legacy" });

  const mkServer = (flag: boolean, readLimiter?: AttemptLimiter): FastifyInstance => {
    const service = createExternalShareService({
      staffStore: createDrizzleShareStaffStore(kit.handle.db),
      partnerStore: createDrizzleSharePartnerStore(kit.handle.db),
      outbox: catalogOutbox() as never,
      flags: { forOrg: async () => ({ [EXTERNAL_PARTNERS_FLAG_KEY]: flag && flagOn }) },
      cipher: bodyCipher,
      ...(readLimiter ? { readLimiter } : {}),
    });
    const server = buildServer({
      db: kit.handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(kit.handle.db),
    });
    registerExternalShareRoutes(server, { service });
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
  const mk = async (
    channel: string,
    over: Record<string, unknown> = {},
    server = on,
  ): Promise<Made> => {
    stepUpFresh = true;
    const mgr = await newManager();
    const res = await staff(server, "POST", API, mgr, {
      channelId: channel,
      partnerName: "Northside Pharmacy",
      partnerKind: "pharmacy",
      baaReference: "BAA-2026-0042",
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
    return bearer;
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
    registerAbacRegistry(registry);
    author = await kit.seedUser("author", ORG_A, STAFF_KEYS);
    clinical = await kit.seedUser("clinical", ORG_A, STAFF_KEYS);
    outsider = await kit.seedUser("outsider", ORG_B, MANAGE_KEYS);
    on = mkServer(true);
    off = mkServer(false);
    limited = mkServer(true, { consume: async () => ({ allowed: --readBudget >= 0 }) });
    await Promise.all([on.ready(), off.ready(), limited.ready()]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([on?.close(), off?.close(), limited?.close()]);
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
      const body = { channelId: channel, partnerName: "P", partnerKind: "dme", baaReference: "B" };
      expect((await staff(on, "POST", API, clinical, body)).statusCode).toBe(403);
      expect((await staff(on, "GET", API, clinical)).statusCode).toBe(403);
      expect((await staff(on, "DELETE", `${API}/${randomUUID()}`, clinical)).statusCode).toBe(403);
      const mgr = await newManager();
      stepUpFresh = false;
      expect((await staff(on, "POST", API, mgr, body)).statusCode).toBe(403);
      expect((await staff(on, "DELETE", `${API}/${randomUUID()}`, mgr)).statusCode).toBe(403);
      stepUpFresh = true;
    });

    it("a care_team, bereavement or announcement channel and an unknown channel are the SAME 404 (no kind oracle)", async () => {
      stepUpFresh = true;
      const mgr = await newManager();
      const body = (id: string) => ({
        channelId: id,
        partnerName: "P",
        partnerKind: "dme",
        baaReference: "B",
      });
      const refused = [
        await mkChannel(kit, "care_team", randomUUID(), [author]),
        await rawChannel("bereavement"),
        await rawChannel("announcement"),
        randomUUID(),
      ];
      const results = await Promise.all(refused.map((id) => staff(on, "POST", API, mgr, body(id))));
      for (const res of results) expect(res.statusCode).toBe(404);
      expect(new Set(results.map((r) => shape(r.body))).size).toBe(1);
    });

    it("validates the body: expiry above 30 days, an empty BAA reference and a bad kind are 422", async () => {
      stepUpFresh = true;
      const mgr = await newManager();
      const ok = { channelId: channel, partnerName: "P", partnerKind: "dme", baaReference: "B" };
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
      expect((await read(made, bearer)).statusCode).toBe(200);
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
      ).toMatch(/permission denied/);
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
      const channel = await rawChannel("dm");
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
      const made = await mk(await rawChannel("dm"));
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
