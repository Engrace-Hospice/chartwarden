/**
 * M36 Phase 3 gate - simulated hospice cases that cross work packages, LIVE Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 * The single-WP live suites already prove each rule on its own. These two scenarios prove the rules still hold when the
 * work packages run together on one patient, over the REAL route stack, the REAL catalog-validating outbox publisher, the
 * REAL `AlertEmitter` with the seeded platform-default rules, the REAL outbox dispatcher and the REAL M36 consumers fed the
 * real event shapes (the M5/M6 services themselves are not run; their events are).
 *
 *   E. A PATIENT DIES with an open communication task, a pending handoff offer (one item already accepted), a care-team
 *      channel and a bereavement channel (Workflows B and E): nothing is deleted, the care channel is archived and still
 *      readable, the bereavement channel is untouched and still accepts posts, the open task is in the supervisor queue,
 *      the pending handoff item stays with the SENDER, and when the deadline passes the sender and the supervisor are
 *      alerted while the accepted item stays with the recipient.
 *   R. A CLINICIAN'S ASSIGNMENT ENDS (reassignment-updates-access): against a real patient_assignment roster the clinician
 *      is denied the channel BEFORE any consumer runs; the consumer then queues the clinician's open task for a supervisor
 *      and leaves the task itself untouched.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:phase3-gate:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the wardenx_* roles.
 */
import { randomUUID } from "node:crypto";
import { resetAbacRegistry, resetAuthorizationContract, resetRbacEngine } from "@chartwarden/auth";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { buildServer, getSeam } from "../src/bootstrap/index";
import {
  type DispatchableOutboxEvent,
  createOutboxDispatcher,
} from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog } from "../src/bootstrap/outbox-persister";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { registerPatientSeams } from "../src/modules/05-patient/index";
import {
  createDrizzleCareTeamStore,
  createDrizzlePatientReaderStore,
} from "../src/modules/05-patient/seams/drizzle-stores";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { buildCareTeamReviewRouter } from "../src/modules/36-messaging/care-team-sync/binding";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import {
  createDrizzleAlertEmitter,
  registerMessagingSeams,
  wireAlertRuleSeed,
} from "../src/modules/36-messaging/index";
import { setCareTeamChannelArchived } from "../src/modules/36-messaging/messaging-provider-db";
import { buildM36ChannelMembershipSyncConsumer } from "../src/modules/36-messaging/outbox-consumers/channel-membership-sync";
import {
  HANDOFF_NOTIFICATION_TEXT,
  buildM36HandoffNotificationsConsumer,
} from "../src/modules/36-messaging/outbox-consumers/handoff-notifications";
import { buildM36PatientLifecycleReviewConsumer } from "../src/modules/36-messaging/outbox-consumers/patient-lifecycle-review";
import { buildReviewDeps } from "../src/modules/36-messaging/review/deps";
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
const ORG_A = "11111111-1111-4111-8111-1111000f3a01";
const ORG_B = "22222222-2222-4222-8222-2222000f3a02";
const REVIEW_BASE = "/api/v1/messaging/review-items";
const HANDOFF_BASE = "/api/v1/messaging/handoffs";
const REVIEW_KEYS = [...STAFF_KEYS, "messaging.review"];
const COUNTED_TABLES = [
  "message",
  "channel_member",
  "channel",
  "communication_task",
  "communication_task_event",
  "clinical_handoff",
  "clinical_handoff_item",
  "clinical_handoff_event",
  "messaging_review_item",
];

interface ReviewItem {
  id: string;
  cause: string | null;
  state: string;
  item_id: string | null;
}
interface ItemRow {
  id: string;
  patient_id: string;
  state: string;
  accountable_user_id: string;
}

describe.skipIf(!DB_URL)("M36 Phase 3 gate - simulated hospice cases - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let handoffs: ReturnType<LiveKit["build"]>["handoffs"];
  let syncConsumer: ReturnType<typeof buildM36ChannelMembershipSyncConsumer>;
  let reviewConsumer: ReturnType<typeof buildM36PatientLifecycleReviewConsumer>;
  let supervisor: string;
  let creator: string;
  let assignee: string;
  let sender: string;
  let receiver: string;

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
  const counts = async () =>
    Object.fromEntries(
      await Promise.all(
        COUNTED_TABLES.map(
          async (t) => [t, await kit.count(`SELECT count(*)::int AS n FROM ${t}`)] as const,
        ),
      ),
    );
  // Through the real route, so the body is a sealed envelope the channel listing can open.
  const insertMessage = async (channelId: string) => {
    const sent = await call(
      creator,
      "POST",
      `/api/v1/messaging/channels/${channelId}/messages`,
      { bodyDoc: plainDoc("task source") },
      ORG_A,
      randomUUID(),
    );
    expect(sent.statusCode).toBe(201);
    return (
      await kit.one<{ id: string }>(
        "SELECT id FROM message WHERE channel_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1",
        [channelId],
      )
    )[0]?.id as string;
  };
  async function openTask(channelId: string, assigneeId: string): Promise<string> {
    const messageId = await insertMessage(channelId);
    const res = await call(
      creator,
      "POST",
      `/api/v1/messaging/channels/${channelId}/messages/${messageId}/tasks`,
      { assignee_user_id: assigneeId },
    );
    expect(res.statusCode, res.body).toBe(201);
    return res.json().task.id as string;
  }
  const taskRow = async (taskId: string) =>
    JSON.stringify(
      (await kit.one("SELECT * FROM communication_task WHERE id=$1", [taskId]))[0] ?? null,
    );
  const reviewRow = async (taskId: string) =>
    (
      await kit.one<Record<string, unknown>>(
        "SELECT * FROM messaging_review_item WHERE item_id=$1 ORDER BY created_at",
        [taskId],
      )
    )[0];
  const supervisorQueue = async () =>
    (await call(supervisor, "GET", `${REVIEW_BASE}?state=open&limit=100`)).json()
      .items as ReviewItem[];
  const itemsOf = (handoffId: string) =>
    kit.one<ItemRow>(
      "SELECT id, patient_id, state, accountable_user_id FROM clinical_handoff_item WHERE handoff_id=$1 ORDER BY id",
      [handoffId],
    );
  const drain = async () => {
    await dispatcher.tick();
    await dispatcher.tick();
  };

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "p3gate");
    supervisor = await kit.seedUser("supervisor", ORG_A, REVIEW_KEYS);
    creator = await kit.seedUser("creator", ORG_A);
    assignee = await kit.seedUser("assignee", ORG_A);
    sender = await kit.seedUser("sender", ORG_A);
    receiver = await kit.seedUser("receiver", ORG_A);

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

    registerPatientSeams({
      db: kit.handle.db,
      careTeam: { store: createDrizzleCareTeamStore(kit.handle.db) },
      readerStore: createDrizzlePatientReaderStore(kit.handle.db),
    });
    const built = kit.build(true);
    await built.server.close();
    handoffs = built.handoffs;
    const review = buildReviewDeps({
      db: kit.handle.db,
      flags: { forOrg: async () => ({ "messaging.tasks": true }) },
      outbox: catalogOutbox() as never,
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
      tasks: built.tasks,
      handoffs: built.handoffs,
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
      patientIdForAdmission: async () => null,
      // The roster is the REAL M5 CareTeamProvider over the real patient_assignment table.
      routeForReview: buildCareTeamReviewRouter({
        db: kit.handle.db,
        careTeamMembers: (organizationId, patientId) =>
          getSeam("CareTeamProvider").careTeamMembers({ organizationId, patientId }),
        alerts: emitter,
        isFlagOn: async () => true,
      }),
    });
    reviewConsumer = buildM36PatientLifecycleReviewConsumer({
      alerts: emitter,
      admissionCare: async () => null,
      queueForPatient: review.queueForPatient,
      isFlagOn: review.isEnabled,
    });
    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }],
    };
    dispatcher = createOutboxDispatcher({
      db: kit.handle.db,
      orgs,
      consumers: [
        buildM36HandoffNotificationsConsumer({
          alerts: emitter,
          stillOffered: handoffs.stillOffered,
          markNeedsAttention: handoffs.markNeedsAttention,
          isActiveUser: handoffs.isActiveUser,
        }),
      ],
      eventCatalog: buildBootOutboxCatalog([M36_OUTBOX_EVENTS]),
      options: { log: () => {} },
    });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await kit?.close();
  });

  describe("E. a patient dies with a task, a pending handoff and a bereavement channel", () => {
    it("deletes nothing, queues the task, archives only the care channel, keeps the handoff item with the sender and alerts at the deadline", async () => {
      // Arrange: patient P (dies) and patient Q (lives), both on the sender's caseload.
      const dying = randomUUID();
      const living = randomUUID();
      kit.caseload.set(sender, [dying, living]);
      const careChannel = await mkChannel(kit, "care_team", dying, [creator, assignee]);
      const bereavement = (
        await kit.one<{ id: string }>(
          `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class, archives_at)
           VALUES ($1,'bereavement',$2,'bereavement','bereavement', now() + interval '13 months') RETURNING id`,
          [ORG_A, dying],
        )
      )[0]?.id as string;
      for (const userId of [creator, assignee]) {
        await kit.admin.query(
          `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
           VALUES ($1,$2,$3,'member','manual')`,
          [ORG_A, bereavement, userId],
        );
      }
      const taskId = await openTask(careChannel, assignee);
      const offer = await call(sender, "POST", HANDOFF_BASE, {
        to_user_id: receiver,
        items: [dying, living].map((p) => ({ kind: "patient", ref_id: p, patient_id: p })),
      });
      expect(offer.statusCode).toBe(201);
      const handoffId = offer.json().handoff.id as string;
      const livingItem = (await itemsOf(handoffId)).find((i) => i.patient_id === living) as ItemRow;
      const accepted = await call(receiver, "POST", `${HANDOFF_BASE}/${handoffId}/accept`, {
        item_ids: [livingItem.id],
      });
      expect(accepted.statusCode).toBe(200);
      const before = await counts();

      // Act: the death reaches both M36 consumers, in dispatcher order.
      const death = ev("m5.patient.deceased", { patientId: dying });
      await syncConsumer.handle(death);
      await reviewConsumer.handle(death);

      // Assert: nothing deleted anywhere.
      const after = await counts();
      for (const table of COUNTED_TABLES) {
        expect(after[table], table).toBeGreaterThanOrEqual(before[table] ?? 0);
      }
      // The care channel is archived but still readable by a member; a send is refused (410).
      expect(
        (
          await kit.one<{ is_archived: boolean }>("SELECT is_archived FROM channel WHERE id=$1", [
            careChannel,
          ])
        )[0]?.is_archived,
      ).toBe(true);
      expect(await kit.service.canViewChannel(ORG_A, assignee, careChannel)).toBe(true);
      const listed = await call(
        assignee,
        "GET",
        `/api/v1/messaging/channels/${careChannel}/messages`,
      );
      expect(listed.statusCode).toBe(200);
      const late = await call(
        creator,
        "POST",
        `/api/v1/messaging/channels/${careChannel}/messages`,
        { bodyDoc: plainDoc("late note") },
        ORG_A,
        randomUUID(),
      );
      expect({ status: late.statusCode, code: errorCode(late) }).toEqual({
        status: 410,
        code: "CHANNEL_ARCHIVED",
      });
      // The bereavement channel is unaffected and still accepts a post.
      expect(
        (
          await kit.one<{ is_archived: boolean }>("SELECT is_archived FROM channel WHERE id=$1", [
            bereavement,
          ])
        )[0]?.is_archived,
      ).toBe(false);
      const condolence = await call(
        creator,
        "POST",
        `/api/v1/messaging/channels/${bereavement}/messages`,
        { bodyDoc: plainDoc("with sympathy") },
        ORG_A,
        randomUUID(),
      );
      expect(condolence.statusCode).toBe(201);
      // The open task is in the supervisor queue and the task row itself is not changed by routing.
      expect(await reviewRow(taskId)).toMatchObject({ state: "open", cause: "death" });
      expect((await supervisorQueue()).some((i) => i.item_id === taskId)).toBe(true);
      expect(JSON.parse(await taskRow(taskId))).toMatchObject({ status: "open" });
      // The pending handoff item is untouched by the death: still offered, still the sender's.
      const dyingItem = (await itemsOf(handoffId)).find((i) => i.patient_id === dying) as ItemRow;
      expect(dyingItem).toMatchObject({ state: "pending", accountable_user_id: sender });

      // Act: the deadline passes and the expiry tick runs.
      await kit.admin.query(
        "UPDATE clinical_handoff SET offered_at = now() - interval '5 hours', expires_at = now() - interval '1 minute' WHERE id=$1",
        [handoffId],
      );
      await handoffs.expireDue(ORG_A);
      await drain();

      // Assert: the unaccepted item stays with the sender, the accepted one with the recipient, both alerted.
      const settled = await itemsOf(handoffId);
      expect(settled.find((i) => i.patient_id === dying)).toMatchObject({
        state: "expired",
        accountable_user_id: sender,
      });
      expect(settled.find((i) => i.patient_id === living)).toMatchObject({
        state: "accepted",
        accountable_user_id: receiver,
      });
      const alerts = await kit.one<{ event_type: string; recipient: string; message: string }>(
        `SELECT a.event_type, nd.recipient_user_id AS recipient, a.payload->>'message' AS message
           FROM alert a JOIN notification_delivery nd ON nd.alert_id = a.id
          WHERE a.correlation_id LIKE $1`,
        [`handoff:${handoffId}:%`],
      );
      expect(alerts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event_type: "m36.handoff.unaccepted",
            recipient: sender,
            message: HANDOFF_NOTIFICATION_TEXT.unaccepted,
          }),
          expect.objectContaining({
            event_type: "m36.handoff.supervisor_review",
            recipient: supervisor,
            message: HANDOFF_NOTIFICATION_TEXT.supervisorReview,
          }),
        ]),
      );
    });
  });

  describe("R. a clinician's assignment ends", () => {
    it("denies the channel before any consumer runs, then queues the open task for a supervisor", async () => {
      // Arrange: a real patient, a real roster, a care-team channel and an open task on the clinician who will leave.
      const patientId = (
        await kit.one<{ id: string }>(
          `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
           VALUES ($1,'MRN-P3GATE','Gate','Patient','1990-01-01','F','active') RETURNING id`,
          [ORG_A],
        )
      )[0]?.id as string;
      const roles: Array<[string, string]> = [
        [creator, "primary_rn"],
        [assignee, "case_manager_msw"],
      ];
      for (const [userId, role] of roles) {
        await kit.admin.query(
          `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
           VALUES ($1,$2,$3,$4,CURRENT_DATE)`,
          [patientId, ORG_A, userId, role],
        );
      }
      const channelId = await mkChannel(kit, "care_team", patientId, [creator, assignee]);
      // Roster-sourced members (a `manual` row is an admin override and is deliberately never revoked by the roster).
      await kit.admin.query("UPDATE channel_member SET source='auto' WHERE channel_id=$1", [
        channelId,
      ]);
      const taskId = await openTask(channelId, assignee);
      expect(await kit.service.canViewChannel(ORG_A, assignee, channelId)).toBe(true);
      const taskBefore = await taskRow(taskId);

      // Act 1: the assignment ends. No consumer has run yet.
      await kit.admin.query(
        `UPDATE patient_assignment SET unassigned_at = CURRENT_DATE
          WHERE patient_id=$1 AND clinician_user_id=$2 AND unassigned_at IS NULL`,
        [patientId, assignee],
      );

      // Assert 1: access is already gone (visibility predicate and the route), and nothing is queued yet.
      expect(await kit.service.canViewChannel(ORG_A, assignee, channelId)).toBe(false);
      const real = await call(assignee, "GET", `/api/v1/messaging/channels/${channelId}/messages`);
      const random = await call(
        assignee,
        "GET",
        `/api/v1/messaging/channels/${randomUUID()}/messages`,
      );
      expect(real.statusCode).toBe(random.statusCode);
      expect(real.statusCode).not.toBe(200);
      expect(await reviewRow(taskId)).toBeUndefined();

      // Act 2: the outbox consumer runs with the real event shape.
      await syncConsumer.handle(
        ev("m5.patient.assignment_ended", {
          patientId,
          organizationId: ORG_A,
          clinicianUserId: assignee,
          role: "case_manager_msw",
        }),
      );

      // Assert 2: the open task is in the supervisor queue, untouched; access stays denied.
      expect(await reviewRow(taskId)).toMatchObject({
        state: "open",
        source: "care_team_change",
        cause: "care_team_removed",
        subject_user_id: assignee,
      });
      expect((await supervisorQueue()).some((i) => i.item_id === taskId)).toBe(true);
      expect(await taskRow(taskId)).toBe(taskBefore);
      expect(await kit.service.canViewChannel(ORG_A, assignee, channelId)).toBe(false);
    });
  });
});
