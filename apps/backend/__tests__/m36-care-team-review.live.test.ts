/**
 * M36 WP 3.9 - care-team removal routes the removed clinician's open tasks to the review queue, LIVE Postgres as the
 * NOBYPASSRLS `chartwarden_app` role (ADR-0066).
 *
 * The real route stack over the REAL catalog-validating outbox publisher and the REAL `AlertEmitter` with the seeded
 * platform-default rules. The channel-membership-sync consumer is driven with the real `m5.patient.assignment_ended` event
 * SHAPE ({patientId, organizationId, clinicianUserId, role}) and a fresh outbox event id each time: the M5 assignment
 * service itself is not run here (it needs a full patient/assignment graph); the soft-removal of the channel_member row and
 * the immediate loss of access are proven live by m36-channel-membership-lifecycle.live.test.ts, so the roster sync is a
 * stub here and the roster seam is a controllable map.
 *
 *   1. ROUTES        the removed clinician's open task is queued (care_team_change / care_team_removed, subject = clinician,
 *                    trigger = the event id); a supervisor sees it and can reassign it; the task row is unchanged by routing.
 *   2. REDELIVERY    the same event queues and alerts nothing more.
 *   3. STILL ON TEAM a clinician who still holds another role on the roster: nothing queued.
 *   4. DEDUPE        a task already under a lifecycle review is not queued a second time.
 *   5. SCOPE         another patient's task, a bereavement task and another clinician's task are not queued.
 *   6. ALERTS        one fixed-text supervisor alert; none to the removed clinician; none when the flag is off (rows still land).
 *   7. AUDIT         the queue rows scrub patient_id and trigger_ref.
 *   8. IDOR          tenant B's event cannot queue tenant A's task and tenant B cannot read A's row.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:care-team-review:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the chartwarden_* roles.
 */
import { randomUUID } from "node:crypto";
import { resetAbacRegistry, resetAuthorizationContract, resetRbacEngine } from "@chartwarden/auth";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { buildCareTeamReviewRouter } from "../src/modules/36-messaging/care-team-sync/binding";
import {
  createDrizzleAlertEmitter,
  registerMessagingSeams,
  wireAlertRuleSeed,
} from "../src/modules/36-messaging/index";
import { buildM36ChannelMembershipSyncConsumer } from "../src/modules/36-messaging/outbox-consumers/channel-membership-sync";
import { buildReviewDeps } from "../src/modules/36-messaging/review/deps";
import { REVIEW_ALERT_TEXT } from "../src/modules/36-messaging/review/review-alerts";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import { buildTaskDeps } from "../src/modules/36-messaging/tasks/deps";
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
const ORG_A = "11111111-1111-4111-8111-1111000f3901";
const ORG_B = "22222222-2222-4222-8222-2222000f3902";
const REVIEW_BASE = "/api/v1/messaging/review-items";
const REVIEW_KEYS = [...STAFF_KEYS, "messaging.review"];

interface ReviewItem {
  id: string;
  cause: string | null;
  source: string | null;
  state: string;
  item_id: string | null;
}

describe.skipIf(!DB_URL)("M36 WP 3.9 care-team review - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  let supervisor: string;
  let supervisorB: string;
  let creator: string;
  let removed: string;
  let other: string;
  let target: string;
  let flagOn = true;
  /** patientId -> roster the (stubbed) CareTeamProvider returns. */
  const roster = new Map<string, string[]>();
  let consumer: ReturnType<typeof buildM36ChannelMembershipSyncConsumer>;
  let consumerB: ReturnType<typeof buildM36ChannelMembershipSyncConsumer>;

  const call = (user: string, method: "GET" | "POST", url: string, payload?: object, org = ORG_A) =>
    app.inject({ method, url, headers: as(user, org), ...(payload ? { payload } : {}) });

  const endedEvent = (patientId: string, clinicianUserId: string, org = ORG_A) =>
    ({
      id: randomUUID(),
      organizationId: org,
      eventType: "m5.patient.assignment_ended",
      aggregateKind: "x",
      aggregateId: "agg",
      payload: { patientId, organizationId: org, clinicianUserId, role: "primary_rn" },
      attemptCount: 0,
      createdAt: new Date(),
    }) satisfies DispatchableOutboxEvent;

  async function mkTask(channelId: string, assignee: string): Promise<string> {
    const messageId = (
      await kit.one<{ id: string }>(
        `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256)
         VALUES ($1,$2,$3,'user','\\x00',repeat('a',64)) RETURNING id`,
        [channelId, ORG_A, creator],
      )
    )[0]?.id as string;
    const res = await call(
      creator,
      "POST",
      `/api/v1/messaging/channels/${channelId}/messages/${messageId}/tasks`,
      { assignee_user_id: assignee },
    );
    expect(res.statusCode).toBe(201);
    return res.json().task.id as string;
  }

  /** A patient with a care-team channel and one open task for the clinician about to be removed. */
  async function patientWithTask(assignee = removed) {
    const patientId = randomUUID();
    const channelId = await mkChannel(kit, "care_team", patientId, [
      creator,
      removed,
      other,
      target,
    ]);
    const taskId = await mkTask(channelId, assignee);
    roster.set(patientId, [creator, other, target]);
    return { patientId, channelId, taskId };
  }

  const reviewRows = (taskId: string) =>
    kit.one<Record<string, unknown>>(
      "SELECT * FROM messaging_review_item WHERE item_id=$1 ORDER BY created_at",
      [taskId],
    );
  const taskRow = async (taskId: string) =>
    JSON.stringify(
      (await kit.one("SELECT * FROM communication_task WHERE id=$1", [taskId]))[0] ?? null,
    );
  const queuedAlerts = () =>
    kit.one<{ recipient: string; message: string; correlation_id: string }>(
      `SELECT nd.recipient_user_id AS recipient, a.payload->>'message' AS message, a.correlation_id
         FROM alert a JOIN notification_delivery nd ON nd.alert_id = a.id
        WHERE a.event_type = 'm36.review.queued'`,
    );
  const assigneeAlerts = () =>
    kit.count(
      "SELECT count(*)::int AS n FROM alert WHERE event_type = 'm36.review.task_needs_decision'",
    );

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp39");
    supervisor = await kit.seedUser("supervisor", ORG_A, REVIEW_KEYS);
    supervisorB = await kit.seedUser("supervisor-b", ORG_B, REVIEW_KEYS);
    creator = await kit.seedUser("creator", ORG_A);
    removed = await kit.seedUser("removed", ORG_A);
    other = await kit.seedUser("other", ORG_A);
    target = await kit.seedUser("target", ORG_A);

    const roleId = (
      await kit.admin.query(
        "INSERT INTO role (organization_id, key, name, category) VALUES ($1,'clinical_supervisor','clinical_supervisor','admin_executive') RETURNING id",
        [ORG_A],
      )
    ).rows[0].id as string;
    const membershipId = (
      await kit.one<{ id: string }>(
        "SELECT id FROM membership WHERE user_id=$1 AND organization_id=$2",
        [supervisor, ORG_A],
      )
    )[0]?.id as string;
    await kit.admin.query(
      "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
      [ORG_A, membershipId, roleId],
    );

    const outbox = catalogOutbox();
    const tasks = buildTaskDeps({
      db: kit.handle.db,
      flags: { forOrg: async () => ({ "messaging.tasks": true }) },
      outbox: outbox as never,
      messaging: kit.service,
      careTeamMembers: async () => [],
    });
    const review = buildReviewDeps({
      db: kit.handle.db,
      flags: { forOrg: async () => ({ "messaging.tasks": true }) },
      outbox: outbox as never,
      messaging: kit.service,
      patientLabels: async (_org, ids) =>
        new Map(ids.map((id) => [id, { displayName: "Ann B.", mrnSuffix: "1234" }] as const)),
      part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
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
      tasks,
      review,
    });
    await app.ready();

    const emitter = createDrizzleAlertEmitter(kit.handle.db);
    registerMessagingSeams({ emitter });
    await wireAlertRuleSeed(kit.handle.db);
    const buildConsumer = () =>
      buildM36ChannelMembershipSyncConsumer({
        syncCareTeam: async () => undefined,
        archiveCareTeam: async () => undefined,
        reopenCareTeam: async () => false,
        patientIdForAdmission: async () => null,
        routeForReview: buildCareTeamReviewRouter({
          db: kit.handle.db,
          careTeamMembers: async (_org, patientId) => roster.get(patientId) ?? [],
          alerts: emitter,
          isFlagOn: async () => flagOn,
        }),
      });
    consumer = buildConsumer();
    consumerB = buildConsumer();
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await kit?.close();
  });

  describe("1. routing", () => {
    it("queues the removed clinician's open task, shows it to a supervisor and leaves the task untouched", async () => {
      const { patientId, taskId } = await patientWithTask();
      const before = await taskRow(taskId);
      const event = endedEvent(patientId, removed);

      await consumer.handle(event);

      expect(await taskRow(taskId)).toBe(before);
      const rows = await reviewRows(taskId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source: "care_team_change",
        cause: "care_team_removed",
        subject_user_id: removed,
        trigger_ref: event.id,
        state: "open",
      });
      const listed = (await call(supervisor, "GET", `${REVIEW_BASE}?state=open&limit=100`)).json()
        .items as ReviewItem[];
      const item = listed.find((i) => i.item_id === taskId);
      expect(item).toMatchObject({ cause: "care_team_removed", source: "care_team_change" });

      const res = await call(supervisor, "POST", `${REVIEW_BASE}/${item?.id}/reassign`, {
        to_user_id: target,
      });
      expect(res.statusCode).toBe(200);
      expect((await reviewRows(taskId))[0]).toMatchObject({
        state: "resolved",
        resolution: "reassigned",
      });
    });
  });

  describe("2. redelivery", () => {
    it("queues and alerts nothing more for the same event", async () => {
      const { patientId, taskId } = await patientWithTask();
      const event = endedEvent(patientId, removed);
      await consumer.handle(event);
      const alertsBefore = (await queuedAlerts()).length;

      await consumer.handle(event);

      expect(await reviewRows(taskId)).toHaveLength(1);
      expect((await queuedAlerts()).length).toBe(alertsBefore);
    });
  });

  describe("3. still on the team", () => {
    it("routes nothing when the clinician is still on the roster through another role", async () => {
      const { patientId, taskId } = await patientWithTask();
      roster.set(patientId, [removed, other]);

      await consumer.handle(endedEvent(patientId, removed));

      expect(await reviewRows(taskId)).toHaveLength(0);
    });
  });

  describe("4. dedupe against a lifecycle review", () => {
    it("does not queue a task that already has an open review", async () => {
      const { patientId, taskId } = await patientWithTask();
      await kit.admin.query(
        `INSERT INTO messaging_review_item (organization_id, source, cause, trigger_ref, patient_id, subject_user_id, item_kind, item_id)
         VALUES ($1,'patient_lifecycle','discharge',$2,$3,$4,'task',$5)`,
        [ORG_A, randomUUID(), patientId, removed, taskId],
      );

      await consumer.handle(endedEvent(patientId, removed));

      const rows = await reviewRows(taskId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.source).toBe("patient_lifecycle");
    });
  });

  describe("5. scope", () => {
    it("queues only the clinician's own active care-team tasks for this patient", async () => {
      const mine = await patientWithTask();
      const otherPatient = await patientWithTask();
      const othersTask = await mkTask(mine.channelId, other);
      const bereavementPatient = randomUUID();
      const bereavement = (
        await kit.one<{ id: string }>(
          `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class, archives_at)
           VALUES ($1,'bereavement',$2,'bereavement','bereavement', now() + interval '13 months') RETURNING id`,
          [ORG_A, bereavementPatient],
        )
      )[0]?.id as string;
      for (const userId of [creator, removed]) {
        await kit.admin.query(
          `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
           VALUES ($1,$2,$3,'member','manual')`,
          [ORG_A, bereavement, userId],
        );
      }
      const bereavementTask = await mkTask(bereavement, removed);
      roster.set(bereavementPatient, []);

      await consumer.handle(endedEvent(mine.patientId, removed));
      await consumer.handle(endedEvent(bereavementPatient, removed));

      expect(await reviewRows(mine.taskId)).toHaveLength(1);
      expect(await reviewRows(otherPatient.taskId)).toHaveLength(0);
      expect(await reviewRows(othersTask)).toHaveLength(0);
      expect(await reviewRows(bereavementTask)).toHaveLength(0);
    });
  });

  describe("6. alerts", () => {
    it("sends one fixed-text supervisor alert and none to the removed clinician", async () => {
      const assigneeBefore = await assigneeAlerts();
      const { patientId } = await patientWithTask();
      const seen = new Set((await queuedAlerts()).map((a) => a.correlation_id));

      await consumer.handle(endedEvent(patientId, removed));

      const fresh = (await queuedAlerts()).filter((a) => !seen.has(a.correlation_id));
      expect(fresh.map((a) => a.recipient)).toEqual([supervisor]);
      expect(fresh[0]?.message).toBe(REVIEW_ALERT_TEXT.queued);
      expect(await assigneeAlerts()).toBe(assigneeBefore);
      expect((await queuedAlerts()).some((a) => a.recipient === removed)).toBe(false);
    });

    it("queues the rows but sends no alert when the tasks flag is off", async () => {
      const { patientId, taskId } = await patientWithTask();
      const alertsBefore = (await queuedAlerts()).length;
      flagOn = false;
      try {
        await consumer.handle(endedEvent(patientId, removed));
      } finally {
        flagOn = true;
      }
      expect(await reviewRows(taskId)).toHaveLength(1);
      expect((await queuedAlerts()).length).toBe(alertsBefore);
    });
  });

  describe("7. audit", () => {
    it("scrubs patient_id and trigger_ref from the queue rows", async () => {
      const { patientId, taskId } = await patientWithTask();
      const event = endedEvent(patientId, removed);
      await consumer.handle(event);
      const row = (await reviewRows(taskId))[0];
      const rows = await kit.one(
        "SELECT event_type, before, after FROM audit_event WHERE resource_kind='messaging_review_item' AND resource_id=$1",
        [row?.id],
      );
      expect(rows.length).toBeGreaterThan(0);
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(patientId);
      expect(dump).not.toContain(event.id);
    });
  });

  describe("8. tenant isolation", () => {
    it("an event in tenant B cannot queue tenant A's task, and B cannot read A's item", async () => {
      const { patientId, taskId } = await patientWithTask();

      await consumerB.handle(endedEvent(patientId, removed, ORG_B));
      await consumer.handle(endedEvent(patientId, removed));

      const rows = await reviewRows(taskId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.organization_id).toBe(ORG_A);
      const listedB = (
        await call(supervisorB, "GET", `${REVIEW_BASE}?state=all&limit=100`, undefined, ORG_B)
      ).json().items as ReviewItem[];
      expect(listedB.some((i) => i.item_id === taskId)).toBe(false);
    });
  });
});
