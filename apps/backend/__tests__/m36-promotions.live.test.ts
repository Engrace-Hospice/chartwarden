/**
 * M36 WP 3.7 - chart promotion, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * The real route stack (Authorization Contract, `channel_visibility`, the DB route service, the read-audit plugin) over the
 * REAL catalog-validating outbox publisher (not NOOP_OUTBOX), the REAL message-body cipher (the snapshot reader opens the
 * same sealed bodies the send route wrote) and the owner events published through the real catalog by the owning module.
 *
 *   1. REQUEST      201 / 200 replay / N concurrent identical requests => 1 row + 1 PHI-free outbox row; supersede on edit.
 *   2. ALLOW-LIST   only (m8, encounter_addendum) and (m14, idg_agenda_item): transport, service AND the table CHECK refuse the rest.
 *   3. SOURCE       a message outside a patient channel is 422; Part 2 deny, a hidden channel, a missing permission and a
 *                   foreign tenant are all the SAME 404; losing patient.read denies the reads.
 *   4. WITHDRAW     requester only; a withdrawn request can be proposed again.
 *   5. OUTCOME      the owner's decided event (real publisher) is applied by the consumer; redelivery converges; an event from
 *                   the wrong owner (or a spoofed payload owner) is ignored; an accepted outcome beats withdrawn/superseded.
 *   6. BACKSTOPS    the database refuses editing identity columns, a decided row and any DELETE by chartwarden_app.
 *   7. AUDIT        trigger rows carry neither patient_id nor the body hash; the read event lands WITH the resource id.
 *   8. NO TEXT      no stored column, outbox row or audit row contains the message text; the seam re-reads it with the real cipher.
 *   9. FLAG         off => 404 / disabled list.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:promotions:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the wardenx_* roles.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { resetAbacRegistry, resetAuthorizationContract, resetRbacEngine } from "@chartwarden/auth";
import { messageBodySha256 } from "@chartwarden/messaging";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { M8_OUTBOX_EVENTS } from "../src/modules/08-encounters/events-by-m8";
import { M14_OUTBOX_EVENTS } from "../src/modules/14-idg/events-by-m14";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import { buildM36PromotionOutcomesConsumer } from "../src/modules/36-messaging/outbox-consumers/promotion-outcomes";
import { buildPromotionDeps } from "../src/modules/36-messaging/promotions/deps";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import {
  type LiveKit,
  STAFF_KEYS,
  as,
  bootLiveKit,
  catalogOutbox,
  errorCode,
  headerAuth,
  mkChannel,
  plainDoc,
} from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-1111000f0701";
const ORG_B = "22222222-2222-4222-8222-2222000f0702";
const FLAG = "messaging.promotions";
const PROMOTER_KEYS = [...STAFF_KEYS, "messaging.promote", "encounter.addendum_sign"];
const BASE = "/api/v1/messaging/chart-promotions";
const BODY_MARKER = "wp37-secret-hip-pain-marker";
const stripIds = (b: string) => b.replace(/"(requestId|correlationId)":"[^"]*"/g, "");
const M8 = { target_module: "m8", target_kind: "encounter_addendum" } as const;
const M14 = { target_module: "m14", target_kind: "idg_agenda_item" } as const;

describe.skipIf(!DB_URL)("M36 WP 3.7 chart promotion - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  let offApp: FastifyInstance;
  let binding: ReturnType<typeof buildPromotionDeps>;
  let publishOwnerEvent: (eventName: string, payload: Record<string, unknown>) => Promise<string>;
  let author: string;
  let requester: string;
  let colleague: string;
  let outsider: string;
  let orgBUser: string;
  const part2Denied = new Set<string>();
  const noPermissions = new Set<string>();
  const alerts: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const meetings = new Set<string>();
  const KEK = randomBytes(32);

  const call = (
    server: FastifyInstance,
    user: string,
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: object,
    org = ORG_A,
  ) =>
    server.inject({
      method,
      url,
      headers: as(user, org, method === "GET" ? undefined : randomUUID()),
      ...(payload ? { payload } : {}),
    });
  const post = async (channel: string, user: string, text = BODY_MARKER) => {
    const res = await call(app, user, "POST", `/api/v1/messaging/channels/${channel}/messages`, {
      bodyDoc: plainDoc(text),
    });
    expect(res.statusCode).toBe(201);
    return res.json().messageId as string;
  };
  const propose = (user: string, ch: string, msg: string, body: object = M8, server = app) =>
    call(
      server,
      user,
      "POST",
      `/api/v1/messaging/channels/${ch}/messages/${msg}/chart-promotions`,
      body,
    );
  /** A fresh patient channel with a message from `author`, the requester and a colleague as members. */
  async function scene() {
    const patient = randomUUID();
    const ch = await mkChannel(kit, "care_team", patient, [author, requester, colleague]);
    const msg = await post(ch, author);
    return { patient, ch, msg };
  }
  const row = async (id: string) =>
    (
      await kit.one<Record<string, unknown>>("SELECT * FROM chart_promotion_request WHERE id=$1", [
        id,
      ])
    )[0];
  const storedSha = async (messageId: string) =>
    (
      await kit.one<{ body_sha256: string }>("SELECT body_sha256 FROM message WHERE id=$1", [
        messageId,
      ])
    )[0]?.body_sha256 as string;
  const outboxCount = (aggregateId: string) =>
    kit.count(
      "SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m36.promotion.requested' AND aggregate_id=$1",
      [aggregateId],
    );
  const consumer = () =>
    buildM36PromotionOutcomesConsumer({
      alerts: {
        emit: async (
          _org: string,
          input: { eventType: string; payload: Record<string, unknown> },
        ) => {
          alerts.push(input);
          return { alertId: "a", resolvedRecipientCount: 1 };
        },
      } as never,
      applyOutcome: (orgId, event) => binding.service.applyOutcome(orgId, event),
    });
  /** Publish an owner's decided event through the REAL catalog and hand the stored envelope to the consumer, as the dispatcher would. */
  async function decide(
    eventName: "m8.chart_promotion.decided" | "m14.chart_promotion.decided",
    promotionRequestId: string,
    over: Record<string, unknown> = {},
  ) {
    const id = await publishOwnerEvent(eventName, {
      organizationId: ORG_A,
      promotionRequestId,
      outcome: "accepted",
      resultRef: randomUUID(),
      decidedByUserId: colleague,
      reasonCode: null,
      at: new Date().toISOString(),
      ...over,
    });
    const [stored] = await kit.one<{ id: string; payload: unknown }>(
      "SELECT id, payload FROM outbox_event WHERE id=$1",
      [id],
    );
    const event = {
      id: stored?.id,
      organizationId: ORG_A,
      eventType: eventName,
      aggregateKind: "chart_promotion_request",
      aggregateId: promotionRequestId,
      payload: stored?.payload,
      attemptCount: 0,
      createdAt: new Date(),
    };
    await consumer().handle(event as never);
    return event;
  }

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp37p");
    author = await kit.seedUser("author", ORG_A);
    requester = await kit.seedUser("requester", ORG_A, PROMOTER_KEYS);
    colleague = await kit.seedUser("colleague", ORG_A);
    outsider = await kit.seedUser("outsider", ORG_A, PROMOTER_KEYS);
    orgBUser = await kit.seedUser("b", ORG_B, PROMOTER_KEYS);
    const outbox = catalogOutbox();
    const messaging = createDbMessagingRouteService(kit.handle.db, {
      kek: KEK,
      outbox: outbox as never,
      part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
    });
    const part2Gate = {
      allowedUserIds: async ({
        patientId,
        userIds,
      }: { patientId: string; userIds: readonly string[] }) =>
        new Set(userIds.filter((u) => !part2Denied.has(`${u}:${patientId}`))),
    };
    const build = (enabled: boolean) => {
      const promotions = buildPromotionDeps({
        db: kit.handle.db,
        flags: { forOrg: async () => ({ [FLAG]: enabled }) },
        outbox: outbox as never,
        messaging,
        bodyOpener: createMessageBodyCipher({ kek: KEK }),
        part2Gate,
        meetingExists: async (_org, id) => meetings.has(id),
        permissionsFor: async (_org, userId) =>
          noPermissions.has(userId) ? new Set<string>() : new Set(PROMOTER_KEYS),
      });
      const server = buildServer({
        db: kit.handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
        idempotencyStore: createDbIdempotencyStore(kit.handle.db),
      });
      registerMessagingRoutes(server, {
        service: messaging,
        announcements: createDbAnnouncementService(kit.handle.db),
        promotions,
      });
      return { server, promotions };
    };
    const on = build(true);
    app = on.server;
    binding = on.promotions;
    offApp = build(false).server;
    await app.ready();
    await offApp.ready();
    const ownerPublisher = buildTxOutboxPublisher(
      buildBootOutboxCatalog([M36_OUTBOX_EVENTS, M8_OUTBOX_EVENTS, M14_OUTBOX_EVENTS]),
    );
    publishOwnerEvent = async (eventName, payload) => {
      const owner = eventName.split(".")[0] as string;
      const aggregateId = String(payload.promotionRequestId);
      await withOrgContext(kit.handle.db, systemOrgContext(ORG_A), (tx) =>
        ownerPublisher.publish(
          tx as never,
          {
            eventName,
            payload,
            organizationId: ORG_A,
            aggregateKind: "chart_promotion_request",
            aggregateId,
            callerModule: owner as never,
          } as never,
        ),
      );
      const rows = await kit.one<{ id: string }>(
        "SELECT id FROM outbox_event WHERE event_type=$1 AND aggregate_id=$2 ORDER BY created_at DESC LIMIT 1",
        [eventName, aggregateId],
      );
      return (rows[0] as { id: string }).id;
    };
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await offApp?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await kit?.close();
  });

  describe("request, replay and idempotency", () => {
    it("creates a proposed request with attribution and a hash, and publishes one PHI-free catalog-valid event", async () => {
      const { patient, ch, msg } = await scene();
      const res = await propose(requester, ch, msg);
      expect(res.statusCode).toBe(201);
      const dto = res.json().promotion;
      expect(dto).toMatchObject({
        status: "proposed",
        target_module: "m8",
        target_kind: "encounter_addendum",
        requested_by: requester,
        source_author_user_id: author,
        patient_id: patient,
        allowed_actions: ["withdraw"],
      });
      expect(Object.keys(dto)).not.toContain("source_body_sha256");
      expect(JSON.stringify(res.json())).not.toContain(BODY_MARKER);
      expect(await row(dto.id)).toMatchObject({
        status: "proposed",
        source_body_sha256: (
          await kit.one<{ body_sha256: string }>("SELECT body_sha256 FROM message WHERE id=$1", [
            msg,
          ])
        )[0]?.body_sha256,
        source_author_user_id: author,
      });
      const [event] = await kit.one<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM outbox_event WHERE event_type='m36.promotion.requested' AND aggregate_id=$1",
        [dto.id],
      );
      expect(Object.keys(event?.payload ?? {}).sort()).toEqual([
        "at",
        "organizationId",
        "promotionRequestId",
        "requestedByUserId",
        "targetKind",
        "targetModule",
      ]);
      expect(JSON.stringify(event)).not.toContain(patient);
      expect(JSON.stringify(event)).not.toContain(await storedSha(msg));
    });

    it("a repeat request replays (200, created:false) with no second row and no second event", async () => {
      const { ch, msg } = await scene();
      const first = await propose(requester, ch, msg);
      const again = await propose(requester, ch, msg);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({
        created: false,
        promotion: { id: first.json().promotion.id },
      });
      expect(await outboxCount(first.json().promotion.id)).toBe(1);
    });

    it("N concurrent identical requests leave exactly one row and one outbox row", async () => {
      const { ch, msg } = await scene();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => propose(requester, ch, msg)),
      );
      expect(results.map((r) => r.statusCode).filter((s) => s === 201)).toHaveLength(1);
      expect(results.every((r) => [200, 201].includes(r.statusCode))).toBe(true);
      const id = results[0]?.json().promotion.id as string;
      expect(new Set(results.map((r) => r.json().promotion.id)).size).toBe(1);
      expect(await outboxCount(id)).toBe(1);
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM chart_promotion_request WHERE message_id=$1",
          [msg],
        ),
      ).toBe(1);
    });

    it("the two targets are independent proposals; a suggested meeting must exist (m14 only)", async () => {
      const { ch, msg } = await scene();
      const a = await propose(requester, ch, msg, M8);
      const b = await propose(requester, ch, msg, M14);
      expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
      const meeting = randomUUID();
      const fresh = await scene();
      const bad = await propose(requester, fresh.ch, fresh.msg, {
        ...M14,
        suggested_target_ref: meeting,
      });
      expect([bad.statusCode, errorCode(bad)]).toEqual([422, "PROMOTION_SUGGESTED_REF_INVALID"]);
      meetings.add(meeting);
      const good = await propose(requester, fresh.ch, fresh.msg, {
        ...M14,
        suggested_target_ref: meeting,
      });
      expect(good.statusCode).toBe(201);
      expect(good.json().promotion.suggested_target_ref).toBe(meeting);
      const m8Ref = await propose(requester, fresh.ch, fresh.msg, {
        ...M8,
        suggested_target_ref: meeting,
      });
      expect(m8Ref.statusCode).toBe(422);
    });

    it("editing the message supersedes the old proposal and proposes the new text", async () => {
      const { ch, msg } = await scene();
      const first = (await propose(requester, ch, msg)).json().promotion.id as string;
      const edit = await call(app, author, "PATCH", `/api/v1/messaging/messages/${msg}`, {
        bodyDoc: plainDoc(`${BODY_MARKER} (edited)`),
      });
      expect(edit.statusCode).toBe(200);
      const second = await propose(requester, ch, msg);
      expect(second.statusCode).toBe(201);
      expect(second.json().promotion.id).not.toBe(first);
      expect(await row(first)).toMatchObject({ status: "superseded", reason_code: "superseded" });
      expect(await row(second.json().promotion.id)).toMatchObject({ status: "proposed" });
    });
  });

  describe("target allow-list: no path to an order", () => {
    it("refuses an unknown module, an order kind, a mismatched pair and an extra key; nothing is written", async () => {
      const { ch, msg } = await scene();
      const before = await kit.count("SELECT count(*)::int AS n FROM chart_promotion_request");
      const attempts: object[] = [
        { target_module: "m11", target_kind: "encounter_addendum" },
        { target_module: "m12", target_kind: "idg_agenda_item" },
        { target_module: "m8", target_kind: "order" },
        { ...M8, patient_id: randomUUID() },
      ];
      for (const body of attempts) {
        expect((await propose(requester, ch, msg, body)).statusCode).toBe(422);
      }
      const mismatch = await propose(requester, ch, msg, {
        target_module: "m8",
        target_kind: "idg_agenda_item",
      });
      expect([mismatch.statusCode, errorCode(mismatch)]).toEqual([422, "PROMOTION_TARGET_INVALID"]);
      expect(await kit.count("SELECT count(*)::int AS n FROM chart_promotion_request")).toBe(
        before,
      );
    });

    it("the table itself refuses a target outside the two pairs", async () => {
      const { patient, ch, msg } = await scene();
      const insert = (module: string, kind: string) =>
        kit.admin.query(
          `INSERT INTO chart_promotion_request (organization_id,message_id,channel_id,patient_id,target_module,target_kind,
             requested_by_user_id,source_author_user_id,source_sent_at,source_body_sha256)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$7,now(),$8)`,
          [ORG_A, msg, ch, patient, module, kind, author, messageBodySha256("x")],
        );
      await expect(insert("m11", "medication_order")).rejects.toThrow(
        /chart_promotion_request_target/,
      );
      await expect(insert("m8", "idg_agenda_item")).rejects.toThrow(
        /chart_promotion_request_target/,
      );
    });
  });

  describe("source rules and uniform refusals", () => {
    it("a message outside a patient channel is a typed 422", async () => {
      const ch = await mkChannel(kit, "location", randomUUID(), [author, requester]);
      const msg = await post(ch, author);
      const res = await propose(requester, ch, msg);
      expect([res.statusCode, errorCode(res)]).toEqual([
        422,
        "PROMOTION_SOURCE_NOT_PATIENT_LINKED",
      ]);
    });

    it("Part 2 deny and a missing permission answer ONE byte-identical 404 (a non-member, in this or another tenant, is stopped by the shared channel guard with its 403)", async () => {
      const { patient, ch, msg } = await scene();
      const reference = await propose(requester, ch, randomUUID());
      expect(reference.statusCode).toBe(404);
      part2Denied.add(`${requester}:${patient}`);
      const part2 = await propose(requester, ch, msg);
      part2Denied.delete(`${requester}:${patient}`);
      const hidden = await propose(outsider, ch, msg);
      noPermissions.add(requester);
      const noPerm = await propose(requester, ch, msg);
      noPermissions.delete(requester);
      const foreign = await call(
        app,
        orgBUser,
        "POST",
        `/api/v1/messaging/channels/${ch}/messages/${msg}/chart-promotions`,
        M8,
        ORG_B,
      );
      // A non-member of the channel is stopped by the shared channel guard (the same 403 every channel route gives).
      expect([hidden.statusCode, foreign.statusCode]).toEqual([403, 403]);
      for (const r of [part2, noPerm]) {
        expect(r.statusCode).toBe(404);
        expect(stripIds(r.body)).toBe(stripIds(reference.body));
      }
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM chart_promotion_request WHERE message_id=$1",
          [msg],
        ),
      ).toBe(0);
    });

    it("a colleague without messaging.promote cannot propose (403)", async () => {
      const { ch, msg } = await scene();
      expect((await propose(colleague, ch, msg)).statusCode).toBe(403);
    });
  });

  describe("reads and tenancy", () => {
    it("the requester and a channel viewer read it; an outsider, a foreign tenant and a viewer who lost patient.read get the same 404", async () => {
      const { ch, msg } = await scene();
      const id = (await propose(requester, ch, msg)).json().promotion.id as string;
      expect((await call(app, requester, "GET", `${BASE}/${id}`)).statusCode).toBe(200);
      expect((await call(app, colleague, "GET", `${BASE}/${id}`)).statusCode).toBe(200);
      const reference = await call(app, requester, "GET", `${BASE}/${randomUUID()}`);
      const outsiderRes = await call(app, outsider, "GET", `${BASE}/${id}`);
      const foreign = await call(app, orgBUser, "GET", `${BASE}/${id}`, undefined, ORG_B);
      noPermissions.add(colleague);
      const lost = await call(app, colleague, "GET", `${BASE}/${id}`);
      const lostList = await call(
        app,
        colleague,
        "GET",
        `/api/v1/messaging/channels/${ch}/messages/${msg}/chart-promotions`,
      );
      noPermissions.delete(colleague);
      for (const r of [outsiderRes, foreign, lost]) {
        expect(r.statusCode).toBe(404);
        expect(stripIds(r.body)).toBe(stripIds(reference.body));
      }
      expect(lostList.json()).toEqual({ promotions: [] });
    });

    it("raw SQL as chartwarden_app in the other tenant sees no row; a cross-org insert is rejected", async () => {
      const { ch, msg, patient } = await scene();
      await propose(requester, ch, msg);
      await kit.appConn.query("BEGIN");
      await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_B]);
      const seen = await kit.appConn.query(
        "SELECT count(*)::int AS n FROM chart_promotion_request WHERE message_id=$1",
        [msg],
      );
      expect(seen.rows[0].n).toBe(0);
      await expect(
        kit.appConn.query(
          `INSERT INTO chart_promotion_request (organization_id,message_id,channel_id,patient_id,target_module,target_kind,
             requested_by_user_id,source_author_user_id,source_sent_at,source_body_sha256)
           VALUES ($1,$2,$3,$4,'m8','encounter_addendum',$5,$5,now(),$6)`,
          [ORG_A, randomUUID(), ch, patient, author, messageBodySha256("x")],
        ),
      ).rejects.toThrow();
      await kit.appConn.query("ROLLBACK");
    });

    it("lists my proposals with active/closed filtering", async () => {
      const { ch, msg } = await scene();
      const id = (await propose(requester, ch, msg)).json().promotion.id as string;
      const active = await call(app, requester, "GET", `${BASE}?status=active&limit=100`);
      expect(active.json().enabled).toBe(true);
      expect(active.json().promotions.map((p: { id: string }) => p.id)).toContain(id);
      const closed = await call(app, requester, "GET", `${BASE}?status=closed&limit=100`);
      expect(closed.json().promotions.map((p: { id: string }) => p.id)).not.toContain(id);
    });
  });

  describe("withdraw", () => {
    it("only the requester withdraws; a repeat is unchanged; the message can then be proposed again", async () => {
      const { ch, msg } = await scene();
      const id = (await propose(requester, ch, msg)).json().promotion.id as string;
      const foreignWithdraw = await call(
        app,
        orgBUser,
        "POST",
        `${BASE}/${id}/withdraw`,
        undefined,
        ORG_B,
      );
      expect(foreignWithdraw.statusCode).toBe(404);
      expect((await call(app, colleague, "POST", `${BASE}/${id}/withdraw`)).statusCode).toBe(403);
      expect((await row(id))?.status).toBe("proposed");
      const out = await call(app, requester, "POST", `${BASE}/${id}/withdraw`);
      expect(out.json().promotion).toMatchObject({
        status: "withdrawn",
        reason_code: "requester",
        allowed_actions: [],
      });
      expect((await call(app, requester, "POST", `${BASE}/${id}/withdraw`)).statusCode).toBe(200);
      const again = await propose(requester, ch, msg);
      expect(again.statusCode).toBe(201);
      expect(again.json().promotion.id).not.toBe(id);
    });
  });

  describe("outcome application through the real catalog", () => {
    it("an accepted decision from the owner sets result_ref and decided_*, tells the requester once, and converges on redelivery", async () => {
      const { ch, msg } = await scene();
      const id = (await propose(requester, ch, msg)).json().promotion.id as string;
      const resultRef = randomUUID();
      const before = alerts.length;
      const event = await decide("m8.chart_promotion.decided", id, { resultRef });
      expect(await row(id)).toMatchObject({
        status: "accepted",
        result_ref: resultRef,
        decided_by_user_id: colleague,
      });
      expect(alerts.length).toBe(before + 1);
      expect(alerts.at(-1)).toMatchObject({
        eventType: "m36.promotion.decided",
        payload: { requestedByUserId: requester, promotionRequestId: id },
      });
      await consumer().handle(event as never);
      expect(alerts.length).toBe(before + 1);
      const dto = (await call(app, requester, "GET", `${BASE}/${id}`)).json().promotion;
      expect(dto).toMatchObject({
        status: "accepted",
        result_ref: resultRef,
        decided_by: colleague,
      });
    });

    it("a rejection records the reason; a later accepted event for the closed request changes nothing", async () => {
      const { ch, msg } = await scene();
      const id = (await propose(requester, ch, msg, M14)).json().promotion.id as string;
      await decide("m14.chart_promotion.decided", id, {
        outcome: "rejected",
        resultRef: null,
        reasonCode: "duplicate",
      });
      expect(await row(id)).toMatchObject({
        status: "rejected",
        reason_code: "duplicate",
        result_ref: null,
      });
      await decide("m14.chart_promotion.decided", id);
      expect((await row(id))?.status).toBe("rejected");
    });

    it("an event from the WRONG owner, or one that claims another owner in its payload, is ignored", async () => {
      const { ch, msg } = await scene();
      const id = (await propose(requester, ch, msg, M8)).json().promotion.id as string;
      await decide("m14.chart_promotion.decided", id, { ownerModule: "m8" });
      expect(await row(id)).toMatchObject({ status: "proposed", result_ref: null });
    });

    it("a signed record beats the requester's intent: withdrawn and superseded requests still become accepted", async () => {
      const w = await scene();
      const withdrawn = (await propose(requester, w.ch, w.msg)).json().promotion.id as string;
      await call(app, requester, "POST", `${BASE}/${withdrawn}/withdraw`);
      const sibling = (await propose(requester, w.ch, w.msg)).json().promotion.id as string;
      await decide("m8.chart_promotion.decided", withdrawn);
      expect(await row(withdrawn)).toMatchObject({ status: "accepted" });
      expect((await row(withdrawn))?.result_ref).not.toBeNull();
      // A same-text replacement is closed in the same flow (one signed record per message).
      expect(await row(sibling)).toMatchObject({
        status: "superseded",
        reason_code: "superseded",
        result_ref: null,
      });

      const s = await scene();
      const old = (await propose(requester, s.ch, s.msg)).json().promotion.id as string;
      await call(app, author, "PATCH", `/api/v1/messaging/messages/${s.msg}`, {
        bodyDoc: plainDoc("edited after proposal"),
      });
      const newer = (await propose(requester, s.ch, s.msg)).json().promotion.id as string;
      expect((await row(old))?.status).toBe("superseded");
      expect((await row(newer))?.status).toBe("proposed");
      await decide("m8.chart_promotion.decided", old);
      expect((await row(old))?.status).toBe("accepted");
      // The proposal for the edited text is a different text: the stale signed record does not close it.
      expect((await row(newer))?.status).toBe("proposed");
    });

    it("an acceptance that arrives for a REJECTED request changes nothing (rejected is final) and is reported, not applied", async () => {
      const { ch, msg } = await scene();
      const id = (await propose(requester, ch, msg)).json().promotion.id as string;
      await decide("m8.chart_promotion.decided", id, {
        outcome: "rejected",
        resultRef: null,
        reasonCode: "other",
      });
      expect((await row(id))?.status).toBe("rejected");
      await decide("m8.chart_promotion.decided", id);
      expect(await row(id)).toMatchObject({ status: "rejected", result_ref: null });
    });

    it("an unknown request id is logged and dropped, never thrown", async () => {
      await expect(decide("m8.chart_promotion.decided", randomUUID())).resolves.toBeDefined();
    });
  });

  describe("database backstops", () => {
    it("chartwarden_app cannot DELETE, cannot edit identity or attribution columns, and cannot touch a decided row", async () => {
      const { ch, msg } = await scene();
      const id = (await propose(requester, ch, msg)).json().promotion.id as string;
      const orgTx = async (sql: string) => {
        await kit.appConn.query("BEGIN");
        try {
          await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
          await kit.appConn.query(sql, [id]);
        } finally {
          await kit.appConn.query("ROLLBACK");
        }
      };
      await expect(orgTx("DELETE FROM chart_promotion_request WHERE id=$1")).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        orgTx("UPDATE chart_promotion_request SET patient_id=gen_random_uuid() WHERE id=$1"),
      ).rejects.toThrow(/permission denied/);
      await expect(
        orgTx("UPDATE chart_promotion_request SET source_body_sha256=repeat('a',64) WHERE id=$1"),
      ).rejects.toThrow(/permission denied/);
      await decide("m8.chart_promotion.decided", id);
      await expect(
        kit.admin.query(
          "UPDATE chart_promotion_request SET status='rejected', result_ref=NULL WHERE id=$1",
          [id],
        ),
      ).rejects.toThrow(/chart_promotion_final|decided|check/i);
    });
  });

  describe("audit and no stored text", () => {
    it("trigger rows never copy the patient or the body hash; the read event lands with the resource id and the patient", async () => {
      const { patient, ch, msg } = await scene();
      const id = (await propose(requester, ch, msg)).json().promotion.id as string;
      await call(app, requester, "GET", `${BASE}/${id}`);
      const rows = await kit.one<{ event_type: string; before: unknown; after: unknown }>(
        "SELECT event_type, before, after FROM audit_event WHERE resource_kind='chart_promotion_request' AND resource_id=$1",
        [id],
      );
      const types = rows.map((r) => r.event_type);
      expect(types).toContain("chart_promotion_request.insert");
      expect(types).toContain("chart_promotion_request.viewed");
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(patient);
      expect(dump).not.toContain(await storedSha(msg));
      expect(dump).not.toContain(BODY_MARKER);
      const [viewed] = await kit.one<{ resource_id: string; patient: string | null }>(
        "SELECT resource_id, context->>'patientId' AS patient FROM audit_event WHERE event_type='chart_promotion_request.viewed' AND resource_id=$1 LIMIT 1",
        [id],
      );
      expect(viewed).toMatchObject({ resource_id: id, patient });
    });

    it("the POST reply is read-audited against the patient too", async () => {
      const { patient, ch, msg } = await scene();
      const id = (await propose(requester, ch, msg)).json().promotion.id as string;
      const [viewed] = await kit.one<{ patient: string | null }>(
        "SELECT context->>'patientId' AS patient FROM audit_event WHERE event_type='chart_promotion_request.viewed' AND resource_id=$1 LIMIT 1",
        [id],
      );
      expect(viewed?.patient).toBe(patient);
    });

    it("the message text is stored nowhere: not in the table, the outbox, the audit log or any DTO", async () => {
      const text = `wp37-unique-${randomUUID()}`;
      const patient = randomUUID();
      const ch = await mkChannel(kit, "care_team", patient, [author, requester]);
      const msg = await post(ch, author, text);
      const res = await propose(requester, ch, msg);
      const id = res.json().promotion.id as string;
      await call(app, requester, "GET", `${BASE}/${id}`);
      await decide("m8.chart_promotion.decided", id);
      const dumps = await kit.one<{ t: string }>(
        `SELECT row_to_json(t)::text AS t FROM chart_promotion_request t WHERE t.id=$1
         UNION ALL SELECT row_to_json(o)::text FROM outbox_event o WHERE o.aggregate_id=$1
         UNION ALL SELECT row_to_json(a)::text FROM audit_event a WHERE a.resource_id=$1`,
        [id],
      );
      expect(dumps.length).toBeGreaterThan(3);
      for (const d of dumps) expect(d.t).not.toContain(text);
      expect(res.body).not.toContain(text);
    });

    it("the seam re-reads the text with the real cipher only for an m8 caller that asks, and serves none once the message was edited", async () => {
      const { ch, msg } = await scene();
      const id = (await propose(requester, ch, msg)).json().promotion.id as string;
      const reader = binding.sourceReader;
      const asked = { targetModule: "m8", reviewerUserId: colleague, withText: true } as const;
      const review = await reader.forReview(ORG_A, id, asked);
      expect(review).toMatchObject({ snapshotText: BODY_MARKER, sourceState: "current" });
      // No withText => structurally no text, even for m8.
      const silent = await reader.forReview(ORG_A, id, {
        targetModule: "m8",
        reviewerUserId: colleague,
      });
      expect(silent).toMatchObject({ snapshotText: null, sourceState: "current" });
      expect(
        await reader.forReview(ORG_A, id, { targetModule: "m14", reviewerUserId: colleague }),
      ).toBeNull();
      await call(app, author, "PATCH", `/api/v1/messaging/messages/${msg}`, {
        bodyDoc: plainDoc("changed afterwards"),
      });
      const edited = await reader.forReview(ORG_A, id, asked);
      expect(edited).toMatchObject({ snapshotText: null, sourceState: "edited_since" });
      expect(JSON.stringify(edited)).not.toContain(BODY_MARKER);
      expect(JSON.stringify(edited)).not.toContain("changed afterwards");
    });

    it("an m8 reviewer without encounter.addendum_sign (or patient.read) gets nothing from the seam", async () => {
      const { ch, msg, patient } = await scene();
      const id = (await propose(requester, ch, msg)).json().promotion.id as string;
      noPermissions.add(colleague);
      try {
        expect(
          await binding.sourceReader.forReview(ORG_A, id, {
            targetModule: "m8",
            reviewerUserId: colleague,
            withText: true,
          }),
        ).toBeNull();
        expect(
          await binding.sourceReader.pendingForPatients(ORG_A, {
            targetModule: "m8",
            patientIds: [patient],
            reviewerUserId: colleague,
            limit: 10,
          }),
        ).toEqual([]);
      } finally {
        noPermissions.delete(colleague);
      }
    });
  });

  describe("flag", () => {
    it("off => every single and write route is 404 and the list answers disabled", async () => {
      const { ch, msg } = await scene();
      const id = (await propose(requester, ch, msg)).json().promotion.id as string;
      const off = [
        await propose(requester, ch, msg, M8, offApp),
        await call(offApp, requester, "GET", `${BASE}/${id}`),
        await call(offApp, requester, "POST", `${BASE}/${id}/withdraw`),
        await call(
          offApp,
          requester,
          "GET",
          `/api/v1/messaging/channels/${ch}/messages/${msg}/chart-promotions`,
        ),
      ];
      for (const r of off) expect(r.statusCode).toBe(404);
      expect((await call(offApp, requester, "GET", BASE)).json()).toEqual({
        enabled: false,
        promotions: [],
      });
      expect(await binding.sourceReader.enabled(ORG_A)).toBe(true);
    });
  });
});
