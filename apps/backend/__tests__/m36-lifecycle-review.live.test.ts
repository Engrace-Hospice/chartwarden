/**
 * M36 WP 3.8 - the lifecycle review queue, LIVE Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 * The real route stack over the REAL catalog-validating outbox publisher, the REAL `AlertEmitter` with the seeded
 * platform-default rules, and the two M36 consumers fed synthetic `m6.admission.discharged` / `m5.patient.deceased`.
 *
 *   1. NEVER DELETES   death queues the open tasks; no row count of the messaging tables decreases; the channel is
 *                      archived, a member still reads it, a send and a new task are refused (410).
 *   2. BEREAVEMENT     a bereavement channel is not archived, its task is not queued, posting still works.
 *   3. QUEUE           the open care-team tasks appear for a messaging.review holder; others get 403; alerts are fixed text.
 *   4. DECISIONS       reassign and close end to end (task events, outbox rows, review row resolved); resolved rows are
 *                      final; wardenx_app cannot DELETE or rewrite identity columns; replays and conflicts.
 *   5. CLOSED ELSEWHERE the assignee closes the task herself and the trigger resolves the review.
 *   6. TRIGGERS        transfer-out, discharge, the M5-only death, the death arriving twice, a readmitted patient.
 *   7. AUDIT           trigger rows scrub patient_id and trigger_ref; list and action reads land with a resource id.
 *   8. PART 2          a restricted patient is a listed, counted, non-actionable row; acting on it is a 404.
 *   9. IDOR            tenant B cannot list or act on tenant A's rows (uniform 404).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m36:lifecycle-review:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the wardenx_* roles.
 */
import { randomUUID } from "node:crypto";
import { resetAbacRegistry, resetAuthorizationContract, resetRbacEngine } from "@chartwarden/auth";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import {
  createDrizzleAlertEmitter,
  registerMessagingSeams,
  wireAlertRuleSeed,
} from "../src/modules/36-messaging/index";
import { setCareTeamChannelArchived } from "../src/modules/36-messaging/messaging-provider-db";
import { buildM36ChannelMembershipSyncConsumer } from "../src/modules/36-messaging/outbox-consumers/channel-membership-sync";
import { buildM36PatientLifecycleReviewConsumer } from "../src/modules/36-messaging/outbox-consumers/patient-lifecycle-review";
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
  errorCode,
  headerAuth,
  mkChannel,
  plainDoc,
} from "./_m36-handoff-live-kit";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-1111000f2001";
const ORG_B = "22222222-2222-4222-8222-2222000f2002";
const REVIEW_BASE = "/api/v1/messaging/review-items";
const REVIEW_KEYS = [...STAFF_KEYS, "messaging.review"];
const COUNTED_TABLES = [
  "message",
  "message_revision",
  "channel_member",
  "channel",
  "communication_task",
  "communication_task_event",
  "clinical_handoff",
  "clinical_handoff_item",
  "clinical_handoff_event",
  "clinical_link",
  "messaging_review_item",
];

interface ReviewItem {
  id: string;
  cause: string | null;
  source: string | null;
  state: string;
  resolution: string | null;
  restricted: boolean;
  patient_id: string | null;
  patient_display_name: string | null;
  item_id: string | null;
  allowed_actions: string[];
  task: { assignee_user_id: string } | null;
}

describe.skipIf(!DB_URL)("M36 WP 3.8 lifecycle review queue - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  let supervisor: string;
  let supervisorB: string;
  let creator: string;
  let assignee: string;
  let assignee2: string;
  let target: string;
  let plain: string;
  let reviewConsumer: ReturnType<typeof buildM36PatientLifecycleReviewConsumer>;
  let syncConsumer: ReturnType<typeof buildM36ChannelMembershipSyncConsumer>;
  const part2Denied = new Set<string>();
  const admissionPatient = new Map<string, { patientId: string; other: boolean }>();

  const call = (
    user: string,
    method: "GET" | "POST",
    url: string,
    payload?: object,
    org = ORG_A,
    key?: string,
  ) => app.inject({ method, url, headers: as(user, org, key), ...(payload ? { payload } : {}) });

  const ev = (eventType: string, payload: Record<string, unknown>): DispatchableOutboxEvent => ({
    id: randomUUID(),
    organizationId: ORG_A,
    eventType,
    aggregateKind: "x",
    aggregateId: "agg",
    payload,
    attemptCount: 0,
    createdAt: new Date(),
  });
  /** Both M36 consumers, in the order the dispatcher would run them. */
  async function deliver(eventType: string, payload: Record<string, unknown>) {
    const event = ev(eventType, payload);
    await syncConsumer.handle(event);
    await reviewConsumer.handle(event);
  }
  const deathOf = (patientId: string) => deliver("m5.patient.deceased", { patientId });
  const dischargeOf = (admissionId: string, reason: string) =>
    deliver("m6.admission.discharged", { admissionId, reason });

  /** A patient with a care-team channel (members: creator + the assignees + target) and one open task per assignee. */
  async function patientWithTasks(assignees: string[] = [assignee]) {
    const patientId = randomUUID();
    const channelId = await mkChannel(kit, "care_team", patientId, [
      creator,
      assignee,
      assignee2,
      target,
    ]);
    const taskIds: string[] = [];
    for (const who of assignees) {
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
        { assignee_user_id: who },
      );
      expect(res.statusCode).toBe(201);
      taskIds.push(res.json().task.id as string);
    }
    return { patientId, channelId, taskIds };
  }
  const listItems = async (state = "all", user = supervisor, org = ORG_A) =>
    (await call(user, "GET", `${REVIEW_BASE}?state=${state}&limit=100`, undefined, org)).json()
      .items as ReviewItem[];
  const itemFor = async (taskId: string) =>
    (await listItems("all")).find((i) => i.item_id === taskId) as ReviewItem;
  const reviewRow = async (taskId: string) =>
    (
      await kit.one<Record<string, unknown>>(
        "SELECT * FROM messaging_review_item WHERE item_id=$1 ORDER BY created_at",
        [taskId],
      )
    )[0];
  const counts = async () =>
    Object.fromEntries(
      await Promise.all(
        COUNTED_TABLES.map(
          async (t) => [t, await kit.count(`SELECT count(*)::int AS n FROM ${t}`)] as const,
        ),
      ),
    );
  const alertsOf = (kind: "queued" | "task_needs_decision") =>
    kit.one<{ recipient: string; message: string; correlation_id: string }>(
      `SELECT nd.recipient_user_id AS recipient, a.payload->>'message' AS message, a.correlation_id
         FROM alert a JOIN notification_delivery nd ON nd.alert_id = a.id
        WHERE a.event_type = $1`,
      [`m36.review.${kind}`],
    );
  /** A transaction as the real NOBYPASSRLS app role, scoped to `org`, always rolled back. */
  async function asApp<T>(org: string, fn: () => Promise<T>): Promise<T> {
    await kit.appConn.query("BEGIN");
    await kit.appConn.query("SELECT set_config('app.org_id',$1,true)", [org]);
    try {
      return await fn();
    } finally {
      await kit.appConn.query("ROLLBACK");
    }
  }

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp38");
    supervisor = await kit.seedUser("supervisor", ORG_A, REVIEW_KEYS);
    supervisorB = await kit.seedUser("supervisor-b", ORG_B, REVIEW_KEYS);
    creator = await kit.seedUser("creator", ORG_A);
    assignee = await kit.seedUser("assignee", ORG_A);
    assignee2 = await kit.seedUser("assignee2", ORG_A);
    target = await kit.seedUser("target", ORG_A);
    plain = await kit.seedUser("plain", ORG_A);

    // The seeded rule aims `m36.review.queued` at the clinical_supervisor role: give the supervisor that role.
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
      part2Gate: {
        allowedUserIds: async ({ patientId, userIds }) =>
          new Set(userIds.filter((u) => !part2Denied.has(`${u}:${patientId}`))),
      },
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
    syncConsumer = buildM36ChannelMembershipSyncConsumer({
      syncCareTeam: async () => undefined,
      archiveCareTeam: (org, patientId) =>
        setCareTeamChannelArchived(kit.handle.db, org, patientId, true),
      reopenCareTeam: (org, patientId) =>
        setCareTeamChannelArchived(kit.handle.db, org, patientId, false),
      patientIdForAdmission: async (_org, admissionId) =>
        admissionPatient.get(admissionId)?.patientId ?? null,
    });
    reviewConsumer = buildM36PatientLifecycleReviewConsumer({
      alerts: emitter,
      admissionCare: async (_org, admissionId) => {
        const known = admissionPatient.get(admissionId);
        return known ? { patientId: known.patientId, otherAdmissionUnderCare: known.other } : null;
      },
      queueForPatient: review.queueForPatient,
      isFlagOn: review.isEnabled,
    });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await kit?.close();
  });

  describe("1. death never deletes", () => {
    it("queues the open tasks, archives the channel, deletes nothing, and keeps history readable", async () => {
      const { patientId, channelId, taskIds } = await patientWithTasks([assignee, assignee2]);
      const admission = randomUUID();
      admissionPatient.set(admission, { patientId, other: false });
      const before = await counts();

      await dischargeOf(admission, "death");
      await deathOf(patientId);
      const after = await counts();

      for (const table of COUNTED_TABLES) {
        expect(after[table], table).toBeGreaterThanOrEqual(before[table] ?? 0);
      }
      expect(after.messaging_review_item).toBe((before.messaging_review_item ?? 0) + 2);
      for (const taskId of taskIds) {
        expect(await reviewRow(taskId)).toMatchObject({ state: "open", cause: "death" });
      }
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM messaging_review_item WHERE patient_id=$1",
          [patientId],
        ),
      ).toBe(2);

      expect(
        (
          await kit.one<{ is_archived: boolean }>("SELECT is_archived FROM channel WHERE id=$1", [
            channelId,
          ])
        )[0]?.is_archived,
      ).toBe(true);
      expect(await kit.service.canViewChannel(ORG_A, assignee, channelId)).toBe(true);
      const send = await call(
        creator,
        "POST",
        `/api/v1/messaging/channels/${channelId}/messages`,
        { bodyDoc: plainDoc("late note") },
        ORG_A,
        randomUUID(),
      );
      expect({ status: send.statusCode, code: errorCode(send) }).toEqual({
        status: 410,
        code: "CHANNEL_ARCHIVED",
      });

      const messageId = (
        await kit.one<{ id: string }>(
          `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256)
           VALUES ($1,$2,$3,'user','\\x00',repeat('b',64)) RETURNING id`,
          [channelId, ORG_A, creator],
        )
      )[0]?.id as string;
      const newTask = await call(
        creator,
        "POST",
        `/api/v1/messaging/channels/${channelId}/messages/${messageId}/tasks`,
        { assignee_user_id: assignee },
      );
      expect({ status: newTask.statusCode, code: errorCode(newTask) }).toEqual({
        status: 410,
        code: "CHANNEL_ARCHIVED",
      });
    });
  });

  describe("2. bereavement is unaffected", () => {
    it("neither archives the bereavement channel nor queues its task, and posting still works", async () => {
      const patientId = randomUUID();
      const careTeam = await mkChannel(kit, "care_team", patientId, [creator, assignee]);
      const bereavement = (
        await kit.one<{ id: string }>(
          `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class, archives_at)
           VALUES ($1,'bereavement',$2,'bereavement','bereavement', now() + interval '13 months') RETURNING id`,
          [ORG_A, patientId],
        )
      )[0]?.id as string;
      for (const userId of [creator, assignee]) {
        await kit.admin.query(
          `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
           VALUES ($1,$2,$3,'member','manual')`,
          [ORG_A, bereavement, userId],
        );
      }
      const taskOn = async (channelId: string) => {
        const messageId = (
          await kit.one<{ id: string }>(
            `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256)
             VALUES ($1,$2,$3,'user','\\x00',repeat('c',64)) RETURNING id`,
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
      };
      const careTask = await taskOn(careTeam);
      const bereavementTask = await taskOn(bereavement);

      await deathOf(patientId);

      expect(await reviewRow(careTask)).toMatchObject({ state: "open" });
      expect(await reviewRow(bereavementTask)).toBeUndefined();
      expect(
        (
          await kit.one<{ is_archived: boolean }>("SELECT is_archived FROM channel WHERE id=$1", [
            bereavement,
          ])
        )[0]?.is_archived,
      ).toBe(false);
      const post = await call(
        creator,
        "POST",
        `/api/v1/messaging/channels/${bereavement}/messages`,
        { bodyDoc: plainDoc("with sympathy") },
        ORG_A,
        randomUUID(),
      );
      expect(post.statusCode).toBe(201);
    });
  });

  describe("3. the supervisor queue", () => {
    it("lists the open care-team tasks for a messaging.review holder, 403 for everyone else, with fixed-text alerts", async () => {
      const { patientId, taskIds } = await patientWithTasks([assignee]);
      await deathOf(patientId);

      const items = await listItems("open");
      const item = items.find((i) => i.item_id === taskIds[0]);
      expect(item).toMatchObject({
        cause: "death",
        state: "open",
        restricted: false,
        patient_id: patientId,
        patient_display_name: "Ann B.",
        allowed_actions: ["reassign", "close"],
        task: { assignee_user_id: assignee },
      });
      expect((await call(plain, "GET", REVIEW_BASE)).statusCode).toBe(403);
      expect((await call(creator, "GET", REVIEW_BASE)).statusCode).toBe(403);

      const queued = await alertsOf("queued");
      expect(queued.some((a) => a.recipient === supervisor)).toBe(true);
      expect(queued.every((a) => a.message === REVIEW_ALERT_TEXT.queued)).toBe(true);
      const needs = await alertsOf("task_needs_decision");
      expect(needs.some((a) => a.recipient === assignee)).toBe(true);
      expect(needs.every((a) => a.message === REVIEW_ALERT_TEXT.taskNeedsDecision)).toBe(true);
      const dump = JSON.stringify([...queued, ...needs]);
      expect(dump).not.toContain(patientId);
      expect(dump).not.toContain(taskIds[0] as string);
    });
  });

  describe("4. decisions", () => {
    it("reassigns end to end: task event, outbox row with source review, review row resolved", async () => {
      const { patientId, taskIds } = await patientWithTasks([assignee]);
      await deathOf(patientId);
      const taskId = taskIds[0] as string;
      const item = await itemFor(taskId);

      const res = await call(supervisor, "POST", `${REVIEW_BASE}/${item.id}/reassign`, {
        to_user_id: target,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().item).toMatchObject({
        state: "resolved",
        resolution: "reassigned",
        allowed_actions: [],
      });
      expect(
        (
          await kit.one<{ assignee_id: string }>(
            "SELECT assignee_id FROM communication_task WHERE id=$1",
            [taskId],
          )
        )[0]?.assignee_id,
      ).toBe(target);
      expect(
        await kit.one(
          "SELECT actor_user_id, reason_code FROM communication_task_event WHERE task_id=$1 AND event_type='reassigned'",
          [taskId],
        ),
      ).toEqual([{ actor_user_id: supervisor, reason_code: "review" }]);
      const published = await kit.one<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM outbox_event WHERE event_type='m36.task.reassigned' AND payload->>'taskId'=$1",
        [taskId],
      );
      expect(published).toHaveLength(1);
      expect(published[0]?.payload).toMatchObject({ source: "review", toUserId: target });
      expect(await reviewRow(taskId)).toMatchObject({
        state: "resolved",
        resolution: "reassigned",
        reassigned_to_user_id: target,
        resolved_by_user_id: supervisor,
      });

      // The same call is a 200 replay; any other decision is a 409.
      const replay = await call(supervisor, "POST", `${REVIEW_BASE}/${item.id}/reassign`, {
        to_user_id: target,
      });
      expect(replay.statusCode).toBe(200);
      const other = await call(supervisor, "POST", `${REVIEW_BASE}/${item.id}/close`, {
        reason: "duplicate",
      });
      expect({ status: other.statusCode, code: errorCode(other) }).toEqual({
        status: 409,
        code: "REVIEW_ITEM_STATE_CONFLICT",
      });
    });

    it("closes with a reason code: done or cancelled by the code, and a status_changed event", async () => {
      const { patientId, taskIds } = await patientWithTasks([assignee, assignee2]);
      await deathOf(patientId);
      const [doneTask, cancelTask] = taskIds as [string, string];

      const done = await call(
        supervisor,
        "POST",
        `${REVIEW_BASE}/${(await itemFor(doneTask)).id}/close`,
        { reason: "action_taken" },
      );
      const cancelled = await call(
        supervisor,
        "POST",
        `${REVIEW_BASE}/${(await itemFor(cancelTask)).id}/close`,
        { reason: "no_action_needed" },
      );
      expect(done.statusCode).toBe(200);
      expect(cancelled.statusCode).toBe(200);
      expect(
        await kit.one(
          "SELECT status, closed_reason FROM communication_task WHERE id = ANY($1) ORDER BY closed_reason",
          [[doneTask, cancelTask]],
        ),
      ).toEqual([
        { status: "done", closed_reason: "action_taken" },
        { status: "cancelled", closed_reason: "no_action_needed" },
      ]);
      expect(await reviewRow(doneTask)).toMatchObject({
        resolution: "closed",
        resolution_reason: "action_taken",
        resolved_by_user_id: supervisor,
      });
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m36.task.status_changed' AND payload->>'taskId' = ANY($1)",
          [[doneTask, cancelTask]],
        ),
      ).toBe(2);
    });

    it("refuses an ineligible target with 422 and changes nothing", async () => {
      const { patientId, taskIds } = await patientWithTasks([assignee]);
      await deathOf(patientId);
      const taskId = taskIds[0] as string;
      const item = await itemFor(taskId);
      for (const to of [assignee, plain, randomUUID()]) {
        const res = await call(supervisor, "POST", `${REVIEW_BASE}/${item.id}/reassign`, {
          to_user_id: to,
        });
        expect({ status: res.statusCode, code: errorCode(res) }).toEqual({
          status: 422,
          code: "REVIEW_ASSIGNEE_INVALID",
        });
      }
      expect(await reviewRow(taskId)).toMatchObject({ state: "open" });
    });

    it("keeps resolved rows final and gives wardenx_app no DELETE and no rewrite of identity columns", async () => {
      const { patientId, taskIds } = await patientWithTasks([assignee]);
      await deathOf(patientId);
      const taskId = taskIds[0] as string;
      const open = await reviewRow(taskId);
      await asApp(ORG_A, async () => {
        await expect(kit.appConn.query("DELETE FROM messaging_review_item")).rejects.toThrow(
          /permission denied/,
        );
      });
      for (const column of ["patient_id", "item_id", "trigger_ref"]) {
        await asApp(ORG_A, async () => {
          await expect(
            kit.appConn.query(`UPDATE messaging_review_item SET ${column}=gen_random_uuid()`),
          ).rejects.toThrow(/permission denied/);
        });
      }
      await call(supervisor, "POST", `${REVIEW_BASE}/${open?.id}/close`, { reason: "duplicate" });
      await expect(
        kit.admin.query("UPDATE messaging_review_item SET version = 99 WHERE id=$1", [open?.id]),
      ).rejects.toThrow(/messaging_review_item_resolved/);
    });
  });

  describe("5. the task closed elsewhere", () => {
    it("resolves the review as closed_elsewhere when the assignee closes the task herself", async () => {
      const { patientId, taskIds } = await patientWithTasks([assignee]);
      await deathOf(patientId);
      const taskId = taskIds[0] as string;
      const res = await call(assignee, "POST", `/api/v1/messaging/tasks/${taskId}/complete`, {
        reason: "action_taken",
      });
      expect(res.statusCode).toBe(200);
      expect(await reviewRow(taskId)).toMatchObject({
        state: "resolved",
        resolution: "closed_elsewhere",
        resolution_reason: "action_taken",
      });
      const after = await call(
        supervisor,
        "POST",
        `${REVIEW_BASE}/${(await reviewRow(taskId))?.id}/close`,
        {
          reason: "duplicate",
        },
      );
      expect(after.statusCode).toBe(409);
    });
  });

  describe("6. triggers", () => {
    it("transfer-out is cause transfer keyed by the admission; discharge is cause discharge", async () => {
      const a = await patientWithTasks([assignee]);
      const b = await patientWithTasks([assignee]);
      const transfer = randomUUID();
      const discharge = randomUUID();
      admissionPatient.set(transfer, { patientId: a.patientId, other: false });
      admissionPatient.set(discharge, { patientId: b.patientId, other: false });

      await dischargeOf(transfer, "transfer");
      await dischargeOf(discharge, "for_cause");

      expect(await reviewRow(a.taskIds[0] as string)).toMatchObject({
        cause: "transfer",
        trigger_ref: transfer,
      });
      expect(await reviewRow(b.taskIds[0] as string)).toMatchObject({
        cause: "discharge",
        trigger_ref: discharge,
      });
    });

    it("queues the M5-only death, and the M6 death followed by M5's copy converges on one row per task", async () => {
      const m5Only = await patientWithTasks([assignee]);
      await deathOf(m5Only.patientId);
      expect(await reviewRow(m5Only.taskIds[0] as string)).toMatchObject({ cause: "death" });

      const both = await patientWithTasks([assignee, assignee2]);
      const admission = randomUUID();
      admissionPatient.set(admission, { patientId: both.patientId, other: false });
      await dischargeOf(admission, "death");
      await deathOf(both.patientId);
      await deathOf(both.patientId);
      for (const taskId of both.taskIds) {
        expect(
          await kit.count("SELECT count(*)::int AS n FROM messaging_review_item WHERE item_id=$1", [
            taskId,
          ]),
        ).toBe(1);
      }
    });

    it("skips the late discharge of a readmitted patient, but not a death", async () => {
      const { patientId, taskIds } = await patientWithTasks([assignee]);
      const admission = randomUUID();
      admissionPatient.set(admission, { patientId, other: true });
      await dischargeOf(admission, "no_longer_terminal");
      expect(await reviewRow(taskIds[0] as string)).toBeUndefined();
      await dischargeOf(admission, "death");
      expect(await reviewRow(taskIds[0] as string)).toMatchObject({ cause: "death" });
    });
  });

  describe("7. audit", () => {
    it("scrubs patient_id and trigger_ref from the trigger rows", async () => {
      const { patientId, taskIds } = await patientWithTasks([assignee]);
      await deathOf(patientId);
      const row = await reviewRow(taskIds[0] as string);
      await call(supervisor, "POST", `${REVIEW_BASE}/${row?.id}/close`, { reason: "duplicate" });
      const rows = await kit.one<{ event_type: string; before: unknown; after: unknown }>(
        "SELECT event_type, before, after FROM audit_event WHERE resource_kind='messaging_review_item' AND resource_id=$1 ORDER BY created_at",
        [row?.id],
      );
      expect(rows.map((r) => r.event_type)).toEqual(
        expect.arrayContaining(["messaging_review_item.insert", "messaging_review_item.update"]),
      );
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(patientId);
      expect(dump).not.toContain(row?.trigger_ref as string);
    });

    it("lands one list read per disclosed patient and an action read with a non-empty resource id", async () => {
      const [p1, p2] = [await patientWithTasks(), await patientWithTasks()];
      await deathOf(p1.patientId);
      await deathOf(p2.patientId);
      const reader = await kit.seedUser("auditor", ORG_A, REVIEW_KEYS);
      const items = await listItems("open", reader);
      expect(items.length).toBeGreaterThanOrEqual(2);
      const viewed = await kit.one<{ patient: string | null; resource_id: string }>(
        `SELECT context->>'patientId' AS patient, resource_id FROM audit_event
          WHERE organization_id=$1 AND event_type='messaging_review_item.viewed' AND actor_user_id=$2`,
        [ORG_A, reader],
      );
      expect(new Set(viewed.map((v) => v.patient))).toEqual(
        new Set(items.map((i) => i.patient_id)),
      );
      expect(viewed.every((v) => v.resource_id.length > 0)).toBe(true);

      const target1 = await itemFor(p1.taskIds[0] as string);
      await call(supervisor, "POST", `${REVIEW_BASE}/${target1.id}/close`, { reason: "duplicate" });
      const actionRead = await kit.one<{ patient: string | null }>(
        `SELECT context->>'patientId' AS patient FROM audit_event
          WHERE event_type='messaging_review_item.viewed' AND resource_id=$1 AND actor_user_id=$2`,
        [target1.id, supervisor],
      );
      expect(actionRead.map((r) => r.patient)).toEqual([p1.patientId]);
    });
  });

  describe("8. Part 2", () => {
    it("lists a restricted patient's row without the patient and refuses to act on it", async () => {
      const { patientId, taskIds } = await patientWithTasks([assignee]);
      await deathOf(patientId);
      const taskId = taskIds[0] as string;
      const before = await itemFor(taskId);
      expect(before.restricted).toBe(false);

      part2Denied.add(`${supervisor}:${patientId}`);
      try {
        const restricted = (await listItems("all")).find((i) => i.id === before.id) as ReviewItem;
        expect(restricted).toMatchObject({
          restricted: true,
          patient_id: null,
          patient_display_name: null,
          item_id: null,
          cause: null,
          source: null,
          state: "open",
          allowed_actions: [],
        });
        const missing = await call(supervisor, "POST", `${REVIEW_BASE}/${randomUUID()}/close`, {
          reason: "duplicate",
        });
        const act = await call(supervisor, "POST", `${REVIEW_BASE}/${before.id}/close`, {
          reason: "duplicate",
        });
        expect(act.statusCode).toBe(404);
        expect(missing.statusCode).toBe(404);
        const strip = (b: string) => b.replace(/"(requestId|correlationId)":"[^"]*"/g, "");
        expect(strip(act.body)).toBe(strip(missing.body));
        expect(await reviewRow(taskId)).toMatchObject({ state: "open" });
      } finally {
        part2Denied.clear();
      }
    });
  });

  describe("8b. every listed row restricted", () => {
    it("still lands a list read whose resource id is non-empty (nothing is swallowed by the best-effort wrapper)", async () => {
      const { patientId } = await patientWithTasks([assignee]);
      await deathOf(patientId);
      const reader = await kit.seedUser("all-restricted", ORG_A, REVIEW_KEYS);
      const visible = await listItems("open", reader);
      expect(visible.length).toBeGreaterThan(0);
      for (const i of visible) part2Denied.add(`${reader}:${i.patient_id}`);
      const viewedCount = () =>
        kit.count(
          "SELECT count(*)::int AS n FROM audit_event WHERE event_type='messaging_review_item.viewed' AND actor_user_id=$1",
          [reader],
        );
      try {
        const before = await viewedCount();
        const rows = await listItems("open", reader);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.restricted)).toBe(true);
        const landed = await kit.one<{ resource_id: string; patient: string | null }>(
          `SELECT resource_id, context->>'patientId' AS patient FROM audit_event
            WHERE event_type='messaging_review_item.viewed' AND actor_user_id=$1 ORDER BY created_at DESC LIMIT 1`,
          [reader],
        );
        expect(await viewedCount()).toBe(before + 1);
        expect(landed[0]?.resource_id).toBe(rows[0]?.id);
        expect(landed[0]?.patient).toBeNull();
      } finally {
        part2Denied.clear();
      }
    });
  });

  describe("8c. the queue/close race", () => {
    /** Wait until some backend is blocked on a lock (the consumer waiting on the uncommitted close). */
    async function waitForLockWait(): Promise<void> {
      for (let i = 0; i < 100; i++) {
        const n = await kit.count(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'",
        );
        if (n > 0) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("the consumer never waited on the task lock");
    }

    it("never queues a task whose close commits between the read and the insert", async () => {
      const { patientId, taskIds } = await patientWithTasks([assignee]);
      const taskId = taskIds[0] as string;
      await kit.admin.query("BEGIN");
      try {
        await kit.admin.query(
          "UPDATE communication_task SET status='done', closed_reason='action_taken', closed_at=now() WHERE id=$1",
          [taskId],
        );
        const queued = deathOf(patientId);
        await waitForLockWait();
        await kit.admin.query("COMMIT");
        await queued;
      } catch (err) {
        await kit.admin.query("ROLLBACK").catch(() => undefined);
        throw err;
      }

      expect(await reviewRow(taskId)).toBeUndefined();
    });

    it("clears a stranded open row when a supervisor decides it, answering 409", async () => {
      const { patientId, taskIds } = await patientWithTasks([assignee]);
      await deathOf(patientId);
      const taskId = taskIds[0] as string;
      const row = await reviewRow(taskId);
      // Recreate the race outcome: the task closes while the resolving trigger is not running.
      await kit.admin.query(
        "ALTER TABLE communication_task DISABLE TRIGGER trg_communication_task_resolve_review",
      );
      try {
        await kit.admin.query(
          "UPDATE communication_task SET status='done', closed_reason='action_taken', closed_at=now() WHERE id=$1",
          [taskId],
        );
      } finally {
        await kit.admin.query(
          "ALTER TABLE communication_task ENABLE TRIGGER trg_communication_task_resolve_review",
        );
      }
      expect(await reviewRow(taskId)).toMatchObject({ state: "open" });

      const res = await call(supervisor, "POST", `${REVIEW_BASE}/${row?.id}/close`, {
        reason: "duplicate",
      });

      expect(res.statusCode).toBe(409);
      expect(await reviewRow(taskId)).toMatchObject({
        state: "resolved",
        resolution: "closed_elsewhere",
        resolution_reason: "action_taken",
      });
    });
  });

  describe("9. tenant isolation", () => {
    it("shows tenant B nothing of tenant A and answers every foreign id with the uniform 404", async () => {
      const { patientId, taskIds } = await patientWithTasks([assignee]);
      await deathOf(patientId);
      const row = await reviewRow(taskIds[0] as string);

      expect(await listItems("all", supervisorB, ORG_B)).toEqual([]);
      const foreign = await call(
        supervisorB,
        "POST",
        `${REVIEW_BASE}/${row?.id}/close`,
        { reason: "duplicate" },
        ORG_B,
      );
      const missing = await call(
        supervisorB,
        "POST",
        `${REVIEW_BASE}/${randomUUID()}/close`,
        { reason: "duplicate" },
        ORG_B,
      );
      expect(foreign.statusCode).toBe(404);
      const strip = (b: string) => b.replace(/"(requestId|correlationId)":"[^"]*"/g, "");
      expect(strip(foreign.body)).toBe(strip(missing.body));
      expect(
        await asApp(
          ORG_B,
          async () =>
            (await kit.appConn.query("SELECT count(*)::int AS n FROM messaging_review_item"))
              .rows[0].n,
        ),
      ).toBe(0);
      expect(await reviewRow(taskIds[0] as string)).toMatchObject({ state: "open" });
    });
  });
});
