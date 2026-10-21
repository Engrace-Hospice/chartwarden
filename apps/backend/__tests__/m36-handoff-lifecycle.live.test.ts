/**
 * M36 WP 3.5 - the handoff LIFECYCLE around the routes, LIVE Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 * The expiry tick, the REAL outbox dispatcher and notification consumer over the REAL `AlertEmitter` (platform-default
 * rules seeded by `wireAlertRuleSeed`, supervisors resolved from the seeded `role_set`), and the offboarding path.
 *
 *   1. EXPIRY      the tick expires a due offer; the sender and the supervisor role set are alerted in-app.
 *   2. NO SUPERVISOR  a tenant with nobody in the supervisor roles gets a `needs_attention` event row on the closed
 *                  handoff and the sender gets the `no_supervisor` alert (never a silent drop).
 *   3. FLAG        a flag-OFF tenant's open offer still expires (accountability never stalls on a flag).
 *   4. POLICY      lowering the tenant expiry makes an in-flight offer expire earlier (tighten-only is applied on read).
 *   5. OFFBOARDING receiver left => declined/recipient_left; sender left => flagged once, supervisors told; redelivery
 *                  converges; suspend does nothing; accepted items stay with the receiver.
 *   6. SOCKETS     the revoked user's sockets are dropped even when a reassignment step fails, and the error is rethrown.
 *   7. ALERT TEXT  fixed generic text; no name, patient or item reaches an alert.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:handoff-lifecycle:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the wardenx_* roles.
 */
import { randomUUID } from "node:crypto";
import { resetAbacRegistry, resetAuthorizationContract, resetRbacEngine } from "@chartwarden/auth";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import {
  type DispatchableOutboxEvent,
  createOutboxDispatcher,
} from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog } from "../src/bootstrap/outbox-persister";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import {
  createDrizzleAlertEmitter,
  registerMessagingSeams,
  wireAlertRuleSeed,
} from "../src/modules/36-messaging/index";
import { endChannelMembershipsForUser } from "../src/modules/36-messaging/messaging-provider-db";
import {
  buildM36AccessRevocationConsumer,
  combineReassignments,
} from "../src/modules/36-messaging/outbox-consumers/access-revocation";
import {
  HANDOFF_NOTIFICATION_TEXT,
  buildM36HandoffNotificationsConsumer,
} from "../src/modules/36-messaging/outbox-consumers/handoff-notifications";
import { type LiveKit, as, bootLiveKit } from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-1111000f1001";
const ORG_B = "22222222-2222-4222-8222-2222000f1002";
const ORG_C = "33333333-3333-4333-8333-3333000f1003";
const BASE = "/api/v1/messaging/handoffs";
const POLICY_URL = "/api/v1/messaging/template-admin/handoff-policy";

describe.skipIf(!DB_URL)("M36 WP 3.5 handoff lifecycle - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  let offApp: FastifyInstance;
  let binding: ReturnType<LiveKit["build"]>["handoffs"];
  let offBinding: ReturnType<LiveKit["build"]>["handoffs"];
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let supervisorA: string;
  let adminA: string;
  let supervisorRoleId: string;

  const call = (
    server: FastifyInstance,
    user: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: object,
    org = ORG_A,
  ) => server.inject({ method, url, headers: as(user, org), ...(payload ? { payload } : {}) });
  const anchor = (patient: string) => ({ kind: "patient", ref_id: patient, patient_id: patient });

  /** A fresh sender + receiver in `org` with one patient on the sender's caseload and one open offer. */
  async function offered(org = ORG_A) {
    const from = await kit.seedUser("snd", org);
    const to = await kit.seedUser("rcv", org);
    const patient = randomUUID();
    kit.caseload.set(from, [patient]);
    const res = await call(
      app,
      from,
      "POST",
      BASE,
      { to_user_id: to, items: [anchor(patient)] },
      org,
    );
    expect(res.statusCode).toBe(201);
    return { from, to, patient, id: res.json().handoff.id as string };
  }
  const makeDue = (id: string) =>
    kit.admin.query(
      "UPDATE clinical_handoff SET offered_at = now() - interval '5 hours', expires_at = now() - interval '1 minute' WHERE id=$1",
      [id],
    );
  const handoffRow = async (id: string) =>
    (await kit.one<Record<string, unknown>>("SELECT * FROM clinical_handoff WHERE id=$1", [id]))[0];
  const eventTypes = async (id: string) =>
    (
      await kit.one<{ event_type: string }>(
        "SELECT event_type FROM clinical_handoff_event WHERE handoff_id=$1 ORDER BY created_at, id",
        [id],
      )
    ).map((e) => e.event_type);
  const outboxRows = (eventName: string, aggregateId: string) =>
    kit.one<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM outbox_event WHERE event_type=$1 AND aggregate_id=$2 ORDER BY created_at",
      [eventName, aggregateId],
    );
  /** Delivers every pending outbox row (a notification can itself be re-queued, so two passes). */
  async function drain() {
    await dispatcher.tick();
    await dispatcher.tick();
  }
  /** Alerts raised for a handoff, with their recipients. */
  const alertsFor = (handoffId: string) =>
    kit.one<{ event_type: string; recipient: string; message: string }>(
      `SELECT a.event_type, nd.recipient_user_id AS recipient, a.payload->>'message' AS message
         FROM alert a JOIN notification_delivery nd ON nd.alert_id = a.id
        WHERE a.correlation_id LIKE $1 ORDER BY a.event_type, nd.recipient_user_id`,
      [`handoff:${handoffId}:%`],
    );
  const alertTypes = async (handoffId: string) => [
    ...new Set((await alertsFor(handoffId)).map((a) => a.event_type)),
  ];
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
    return roleId;
  };

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp35l");
    await kit.admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wp35l-c','C','C')",
      [ORG_C],
    );
    supervisorA = await kit.seedUser("supervisor", ORG_A);
    supervisorRoleId = await addRole(ORG_A, supervisorA, "clinical_supervisor");
    adminA = await kit.seedUser("admin", ORG_A, [
      "messaging.read",
      "messaging.send",
      "patient.read",
      "messaging.template.manage",
    ]);
    const on = kit.build(true);
    app = on.server;
    binding = on.handoffs;
    const off = kit.build(false);
    offApp = off.server;
    offBinding = off.handoffs;
    await app.ready();
    await offApp.ready();

    const emitter = createDrizzleAlertEmitter(kit.handle.db);
    registerMessagingSeams({ emitter });
    await wireAlertRuleSeed(kit.handle.db);
    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () =>
        [ORG_A, ORG_B, ORG_C].map((organizationId) => ({ organizationId })),
    };
    dispatcher = createOutboxDispatcher({
      db: kit.handle.db,
      orgs,
      consumers: [
        buildM36HandoffNotificationsConsumer({
          alerts: emitter,
          stillOffered: binding.stillOffered,
          markNeedsAttention: binding.markNeedsAttention,
          isActiveUser: binding.isActiveUser,
        }),
      ],
      eventCatalog: buildBootOutboxCatalog([M36_OUTBOX_EVENTS]),
      options: { log: () => {} },
    });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await offApp?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await kit?.close();
  });

  describe("offer notification", () => {
    it("alerts the receiver once, in-app, with fixed generic text, and not after the offer was withdrawn", async () => {
      const { from, to, id } = await offered();
      await drain();
      const alerts = await alertsFor(id);
      expect(alerts).toEqual([
        {
          event_type: "m36.handoff.offered",
          recipient: to,
          message: HANDOFF_NOTIFICATION_TEXT.offered,
        },
      ]);
      expect(from).not.toBe(to);

      const later = await offered();
      await call(app, later.from, "POST", `${BASE}/${later.id}/cancel`);
      await drain();
      expect(await alertsFor(later.id)).toEqual([]);
    });
  });

  describe("expiry tick", () => {
    it("expires a due offer and alerts the sender and the supervisor role set, in-app only", async () => {
      const { from, to, id } = await offered();
      await drain();
      await makeDue(id);
      const swept = await binding.expireDue(ORG_A);
      expect(swept.expired).toBeGreaterThanOrEqual(1);
      expect(await handoffRow(id)).toMatchObject({ state: "expired", closed_reason: "deadline" });
      expect(await eventTypes(id)).toEqual(["offered", "closed"]);
      const rows = await outboxRows("m36.handoff.unaccepted", id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toMatchObject({ cause: "expired", unacceptedItemCount: 1 });

      await drain();
      const alerts = (await alertsFor(id)).filter((a) => a.event_type !== "m36.handoff.offered");
      expect(alerts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event_type: "m36.handoff.unaccepted",
            recipient: from,
            message: HANDOFF_NOTIFICATION_TEXT.unaccepted,
          }),
          expect.objectContaining({
            event_type: "m36.handoff.supervisor_review",
            recipient: supervisorA,
            message: HANDOFF_NOTIFICATION_TEXT.supervisorReview,
          }),
        ]),
      );
      expect(alerts.some((a) => a.recipient === to)).toBe(false);
      expect(await eventTypes(id)).not.toContain("needs_attention");
      const channels = await kit.one<{ channel: string }>(
        `SELECT DISTINCT nd.channel FROM notification_delivery nd JOIN alert a ON a.id = nd.alert_id
          WHERE a.correlation_id LIKE $1`,
        [`handoff:${id}:%`],
      );
      expect(channels.map((c) => c.channel)).toEqual(["in_app"]);
    });

    it("a second tick finds nothing and publishes nothing more (convergence)", async () => {
      const { id } = await offered();
      await makeDue(id);
      await binding.expireDue(ORG_A);
      const again = await binding.expireDue(ORG_A);
      expect(again.expired).toBe(0);
      expect(await outboxRows("m36.handoff.unaccepted", id)).toHaveLength(1);
    });

    it("never expires another tenant's handoff", async () => {
      const mine = await offered(ORG_C);
      await makeDue(mine.id);
      await binding.expireDue(ORG_A);
      expect((await handoffRow(mine.id))?.state).toBe("offered");
      await binding.expireDue(ORG_C);
      expect((await handoffRow(mine.id))?.state).toBe("expired");
    });

    it("still expires an offer for a tenant whose flag is OFF", async () => {
      const { id } = await offered();
      await makeDue(id);
      expect((await call(offApp, adminA, "GET", `${BASE}/${id}`)).statusCode).toBe(404);
      const swept = await offBinding.expireDue(ORG_A);
      expect(swept.expired).toBeGreaterThanOrEqual(1);
      expect((await handoffRow(id))?.state).toBe("expired");
    });

    it("expires an in-flight offer earlier once the tenant lowers the expiry (tighten-only on read)", async () => {
      const { id } = await offered();
      await kit.admin.query(
        "UPDATE clinical_handoff SET offered_at = now() - interval '20 minutes', expires_at = now() + interval '3 hours' WHERE id=$1",
        [id],
      );
      await binding.expireDue(ORG_A);
      expect((await handoffRow(id))?.state).toBe("offered");
      const put = await call(app, adminA, "PUT", POLICY_URL, { expiry_minutes: 15 });
      expect(put.statusCode).toBe(200);
      try {
        await binding.expireDue(ORG_A);
        expect((await handoffRow(id))?.state).toBe("expired");
      } finally {
        await call(app, adminA, "DELETE", POLICY_URL);
      }
    });
  });

  describe("no supervisor reachable", () => {
    it("records needs_attention on the closed handoff and tells the sender, never dropping the alert silently", async () => {
      const { from, id } = await offered(ORG_C);
      await drain();
      await makeDue(id);
      await binding.expireDue(ORG_C);
      await drain();
      expect(await handoffRow(id)).toMatchObject({ state: "expired" });
      expect(await eventTypes(id)).toEqual(["offered", "closed", "needs_attention"]);
      const alerts = await alertsFor(id);
      const types = alerts.map((a) => a.event_type);
      expect(types).toContain("m36.handoff.unaccepted");
      expect(types).toContain("m36.handoff.no_supervisor");
      expect(types).not.toContain("m36.handoff.supervisor_review");
      expect(alerts.find((a) => a.event_type === "m36.handoff.no_supervisor")).toMatchObject({
        recipient: from,
        message: HANDOFF_NOTIFICATION_TEXT.noSupervisor,
      });
      const dto = await call(app, from, "GET", `${BASE}/${id}`, undefined, ORG_C);
      expect(dto.json().handoff.needs_attention).toBe(true);
      // a redelivery of the same event adds no second marker
      await binding.markNeedsAttention(ORG_C, id);
      expect((await eventTypes(id)).filter((t) => t === "needs_attention")).toHaveLength(1);
    });
  });

  describe("offboarding", () => {
    const revokeEvent = (leaver: string, eventType: string, payload: Record<string, unknown>) =>
      ({
        id: randomUUID(),
        organizationId: ORG_A,
        eventType,
        aggregateKind: "membership",
        aggregateId: leaver,
        payload: { userId: leaver, ...payload },
        attemptCount: 0,
        createdAt: new Date(),
      }) satisfies DispatchableOutboxEvent;
    const consumer = (
      extra: Partial<Parameters<typeof buildM36AccessRevocationConsumer>[0]> = {},
    ) =>
      buildM36AccessRevocationConsumer({
        endChannelMemberships: (orgId, userId) =>
          endChannelMembershipsForUser(kit.handle.db, orgId, userId),
        reassignOwnedItems: combineReassignments([binding.reassignForLeaver]),
        ...extra,
      });
    const revoke = (leaver: string, eventType = "m2.membership.revoked") =>
      consumer().handle(revokeEvent(leaver, eventType, { to: "revoked", scope: "org" }));

    it("declines the offers addressed to a receiver who left and converges on redelivery", async () => {
      const { from, to, id } = await offered();
      await revoke(to);
      expect(await handoffRow(id)).toMatchObject({
        state: "declined",
        closed_reason: "recipient_left",
      });
      expect(
        (
          await kit.one<{ state: string; accountable_user_id: string }>(
            "SELECT state, accountable_user_id FROM clinical_handoff_item WHERE handoff_id=$1",
            [id],
          )
        ).map((i) => [i.state, i.accountable_user_id]),
      ).toEqual([["declined", from]]);
      const rows = await outboxRows("m36.handoff.unaccepted", id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toMatchObject({ cause: "recipient_left" });
      await revoke(to, "m2.user.deactivated");
      expect(await outboxRows("m36.handoff.unaccepted", id)).toHaveLength(1);
      expect((await eventTypes(id)).filter((t) => t === "recipient_left")).toHaveLength(1);
      await drain();
      expect(await alertTypes(id)).toEqual(
        expect.arrayContaining(["m36.handoff.unaccepted", "m36.handoff.supervisor_review"]),
      );
    });

    it("flags a sender who left once, leaves the offer open for the receiver, and tells supervisors", async () => {
      const { from, to, id } = await offered();
      // The event is published AFTER the membership ended; mirror that so the departed sender reads as inactive.
      await kit.admin.query("UPDATE membership SET status='revoked' WHERE user_id=$1", [from]);
      await revoke(from);
      expect((await handoffRow(id))?.state).toBe("offered");
      expect((await eventTypes(id)).filter((t) => t === "sender_left")).toHaveLength(1);
      const rows = await outboxRows("m36.handoff.unaccepted", id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toMatchObject({ cause: "sender_left" });
      await revoke(from, "m2.user.deactivated");
      expect((await eventTypes(id)).filter((t) => t === "sender_left")).toHaveLength(1);
      expect(await outboxRows("m36.handoff.unaccepted", id)).toHaveLength(1);
      await drain();
      const alerts = await alertsFor(id);
      expect(
        alerts.some(
          (a) => a.event_type === "m36.handoff.supervisor_review" && a.recipient === supervisorA,
        ),
      ).toBe(true);
      // the departed sender is not alerted
      expect(
        alerts.some((a) => a.event_type === "m36.handoff.unaccepted" && a.recipient === from),
      ).toBe(false);
      // the receiver can still accept
      const [item] = await kit.one<{ id: string }>(
        "SELECT id FROM clinical_handoff_item WHERE handoff_id=$1",
        [id],
      );
      const accepted = await call(app, to, "POST", `${BASE}/${id}/accept`, {
        item_ids: [item?.id],
      });
      expect(accepted.statusCode).toBe(200);
    });

    it("does nothing on suspend (reinstatable) and keeps items the receiver already accepted", async () => {
      const { to, id } = await offered();
      await consumer().handle(revokeEvent(to, "m2.membership.suspended", { to: "suspended" }));
      expect((await handoffRow(id))?.state).toBe("offered");

      const done = await offered();
      const [item] = await kit.one<{ id: string }>(
        "SELECT id FROM clinical_handoff_item WHERE handoff_id=$1",
        [done.id],
      );
      await call(app, done.to, "POST", `${BASE}/${done.id}/accept`, { item_ids: [item?.id] });
      await revoke(done.to);
      expect((await handoffRow(done.id))?.state).toBe("accepted");
      const [after] = await kit.one<{ accountable_user_id: string }>(
        "SELECT accountable_user_id FROM clinical_handoff_item WHERE handoff_id=$1",
        [done.id],
      );
      expect(after?.accountable_user_id).toBe(done.to);
    });

    it("drops the leaver's sockets even when a reassignment step fails, still runs the handoff step, and rethrows", async () => {
      const { to, id } = await offered();
      const disconnectUser = vi.fn().mockResolvedValue(undefined);
      const failing = consumer({
        disconnectUser,
        reassignOwnedItems: combineReassignments([
          async () => {
            throw new Error("tasks down");
          },
          binding.reassignForLeaver,
        ]),
      });
      await expect(
        failing.handle(revokeEvent(to, "m2.membership.revoked", { to: "revoked" })),
      ).rejects.toThrow(/tasks down/);
      expect(disconnectUser).toHaveBeenCalledWith(ORG_A, to);
      expect((await handoffRow(id))?.state).toBe("declined");
    });

    it("drops the sockets when the HANDOFF step itself fails, and the retry then converges", async () => {
      const { to, id } = await offered();
      const disconnectUser = vi.fn().mockResolvedValue(undefined);
      let broken = true;
      const flaky = consumer({
        disconnectUser,
        reassignOwnedItems: combineReassignments([
          async (orgId, userId) => {
            if (broken) throw new Error("handoffs down");
            await binding.reassignForLeaver(orgId, userId);
          },
        ]),
      });
      const event = revokeEvent(to, "m2.membership.revoked", { to: "revoked" });
      await expect(flaky.handle(event)).rejects.toThrow(/handoffs down/);
      expect(disconnectUser).toHaveBeenCalledWith(ORG_A, to);
      expect((await handoffRow(id))?.state).toBe("offered");
      broken = false;
      await flaky.handle(event);
      expect((await handoffRow(id))?.state).toBe("declined");
    });
  });

  describe("alert text", () => {
    it("never carries a name, a patient id or an item reference, and never the banned word", async () => {
      const { patient } = await offered();
      await drain();
      const dump = JSON.stringify(
        await kit.one(
          "SELECT event_type, payload FROM alert WHERE correlation_id LIKE 'handoff:%'",
        ),
      );
      expect(dump).not.toContain(patient);
      expect(dump).not.toMatch(/acknowledg/i);
      expect(dump).not.toContain("Ann B.");
      expect(supervisorRoleId).toBeTruthy();
    });
  });
});
