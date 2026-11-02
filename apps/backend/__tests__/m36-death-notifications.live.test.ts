/**
 * M36 death-notification cascade (builds on ADR-0098, PROPOSED), LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * The real routes over the real database, the REAL catalog-validating outbox publisher (not NOOP_OUTBOX), the REAL `AlertEmitter` with the seeded
 * platform rules, the real board consumer fed synthetic `m5.patient.deceased` / `m6.admission.discharged` events, the real notifications consumer fed
 * the `m36.death_board.opened` row the board actually published, and M40's real BAA register (mdm_baa_record) and decision engine. The only fake is the
 * M2 funeral-link mint/delivery port (it needs a mail provider): the test records what it was asked to send.
 *
 *   1. CASCADE      both death events + redelivery publish ONE opened event; replaying it (twice, with new event ids) creates no second notification,
 *                   alert or sent event; the attending is the named recipient; roles nobody holds fall back to the tenant admins; flag off writes nothing.
 *   2. ACK          the recipient acknowledges explicitly (audit row with the actor, an acked event, acked_at is the database clock, idempotent);
 *                   a stranger is refused; an acknowledged row is final.
 *   3. EXTERNAL     no BAA (or only the policy default n_a) => blocked_no_baa, supervisors alerted, nothing sent, board items stay open; with an executed
 *                   BAA the link is sent once; a repeat never sends a second; the address is not stored.
 *   4. TENANCY      another tenant reads nothing, gets 404s, and cannot write across; the app role cannot delete or plant an acknowledged row.
 *   5. AUDIT        the list read lands a death_board.viewed audit event naming the actor; alert payloads carry no patient id.
 *   6. STALL SWEEP  an old unacknowledged notice escalates to the supervisors exactly once.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:death-notifications:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the chartwarden_* roles.
 */
import { randomUUID } from "node:crypto";
import {
  createPredicateRegistry,
  registerAbacRegistry,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import {
  DEATH_BOARD_FLAG_KEY,
  DEATH_NOTIFICATIONS_FLAG_KEY,
  DEATH_NOTIFICATION_INTERNAL_KINDS,
} from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildFuneralLinkPort } from "../src/bootstrap/death-notification-funeral-link";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M2_OUTBOX_EVENTS, createFuneralDisclosureRecorder } from "../src/modules/02-identity/index";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import { buildDeathBoardDeps } from "../src/modules/36-messaging/death-board/deps";
import { createDbDeathBoardStore } from "../src/modules/36-messaging/death-board/death-board-store";
import { executedBaaGate } from "../src/bootstrap/death-notification-baa-gate";
import { withBoardOpenedEvent } from "../src/modules/36-messaging/death-notification/death-board-opened-store";
import { DEATH_NOTIFICATION_TEXT, deathNotificationCorrelationKey } from "../src/modules/36-messaging/death-notification/death-notification-alerts";
import { buildDeathNotificationDeps } from "../src/modules/36-messaging/death-notification/deps";
import {
  createDrizzleAlertEmitter,
  registerMessagingSeams,
  wireAlertRuleSeed,
} from "../src/modules/36-messaging/index";
import { buildM36DeathBoardConsumer } from "../src/modules/36-messaging/outbox-consumers/death-board";
import { buildM36DeathNotificationsConsumer } from "../src/modules/36-messaging/outbox-consumers/death-notifications";
import { registerDeathBoardRoutes } from "../src/modules/36-messaging/routes/death-board-routes";
import { registerDeathNotificationRoutes } from "../src/modules/36-messaging/routes/death-notification-routes";
import { createDbBaaStore } from "../src/modules/40-mdm/mdm-store-db";
import {
  type LiveKit,
  STAFF_KEYS,
  as,
  bootLiveKit,
  catalogOutbox,
  headerAuth,
} from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-1111000f7101";
const ORG_B = "22222222-2222-4222-8222-2222000f7102";
const BOARDS = "/api/v1/messaging/death-boards";
const NOTICES = "/api/v1/messaging/death-notifications";
const SUPERVISOR_KEYS = [...STAFF_KEYS, "messaging.review", "funeral.invite"];
const INTERNAL_COUNT = DEATH_NOTIFICATION_INTERNAL_KINDS.length;
const FUNERAL_EMAIL = "director@funeral-home.example";

interface NoticeJson {
  id: string;
  recipient_kind: string;
  state: string;
  acked_by: string | null;
  can_ack: boolean;
}

describe.skipIf(!DB_URL)("M36 death-notification cascade - LIVE Postgres", () => {
  const m2Publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M2_OUTBOX_EVENTS]));
  let kit: LiveKit;
  let appOn: FastifyInstance;
  let appOff: FastifyInstance;
  let rn: string;
  let attending: string;
  let supervisor: string;
  let stranger: string;
  let otherOrgSupervisor: string;
  let boardConsumer: ReturnType<typeof buildM36DeathBoardConsumer>;
  let on: ReturnType<typeof buildDeathNotificationDeps>;
  let off: ReturnType<typeof buildDeathNotificationDeps>;
  let noticeConsumer: ReturnType<typeof buildM36DeathNotificationsConsumer>;

  const careTeam = new Map<string, { rn: string; members: string[] }>();
  const attendingOf = new Map<string, string>();
  // What the REAL funeral-link adapter handed its (faked) store and delivery: the mint input and the delivery, never the token.
  const linkCalls: Array<{ orgId: string; email: string }> = [];
  const linkCreates: Array<Record<string, unknown>> = [];
  const linkRevokes: string[] = [];
  const caseload = new Set<string>(); // `${userId}:${patientId}`; the M3 caseload_membership predicate over it

  const call = (
    user: string,
    method: "GET" | "POST",
    url: string,
    payload?: object,
    org = ORG_A,
    app = appOn,
  ) => app.inject({ method, url, headers: as(user, org), ...(payload ? { payload } : {}) });
  const code = (res: { json(): { error?: { code?: string }; code?: string } }) =>
    res.json().error?.code ?? res.json().code;

  const ev = (
    eventType: string,
    payload: Record<string, unknown>,
    id: DispatchableOutboxEvent["id"] = randomUUID(),
  ): DispatchableOutboxEvent => ({
    id,
    organizationId: ORG_A,
    eventType,
    aggregateKind: "x",
    aggregateId: randomUUID(),
    payload,
    attemptCount: 0,
    createdAt: new Date(),
  });

  const outboxRows = (eventType: string, aggregateId?: string) =>
    kit.one<{ id: string; payload: Record<string, unknown> }>(
      `SELECT id, payload FROM outbox_event WHERE organization_id=$1 AND event_type=$2 ${aggregateId ? "AND aggregate_id=$3" : ""} ORDER BY created_at, id`,
      aggregateId ? [ORG_A, eventType, aggregateId] : [ORG_A, eventType],
    );
  const noticeRows = (boardId: string) =>
    kit.one<{
      id: string;
      recipient_kind: string;
      recipient_ref: string;
      state: string;
      acked_at: Date | null;
      acked_by: string | null;
    }>(
      "SELECT id, recipient_kind, recipient_ref, state, acked_at, acked_by FROM death_notification WHERE board_id=$1 ORDER BY recipient_kind",
      [boardId],
    );
  const alertRows = (like: string) =>
    kit.one<{ id: string; event_type: string; correlation_id: string; payload: object }>(
      "SELECT id, event_type, correlation_id, payload FROM alert WHERE organization_id=$1 AND event_type LIKE $2",
      [ORG_A, like],
    );

  /** Runs the real consumer path: death event -> board (+ opened event in the same tx) -> the opened row the board really published. */
  async function newDeath(flagOn = true) {
    const patientId = randomUUID();
    careTeam.set(patientId, { rn, members: [rn, attending] });
    attendingOf.set(patientId, attending);
    await boardConsumer.handle(ev("m5.patient.deceased", { patientId }));
    const board = (
      await kit.one<{ id: string }>(
        "SELECT id FROM death_board WHERE organization_id=$1 AND patient_id=$2",
        [ORG_A, patientId],
      )
    )[0];
    const boardId = board?.id as string;
    caseload.add(`${supervisor}:${patientId}`);
    const opened = (await outboxRows("m36.death_board.opened", boardId))[0];
    return { patientId, boardId, opened, flagOn };
  }
  const deliverOpened = (opened: { id: string; payload: Record<string, unknown> } | undefined) =>
    noticeConsumer.handle(ev("m36.death_board.opened", opened?.payload ?? {}, opened?.id as DispatchableOutboxEvent["id"]));

  async function asApp<T>(org: string, fn: () => Promise<T>): Promise<T> {
    await kit.appConn.query("BEGIN");
    await kit.appConn.query("SELECT set_config('app.org_id',$1,true)", [org]);
    try {
      return await fn();
    } finally {
      await kit.appConn.query("ROLLBACK");
    }
  }
  async function attempt(sql: string, params: unknown[] = []): Promise<string> {
    await kit.appConn.query("SAVEPOINT s");
    try {
      await kit.appConn.query(sql, params);
      await kit.appConn.query("RELEASE SAVEPOINT s");
      return "ok";
    } catch (e) {
      await kit.appConn.query("ROLLBACK TO SAVEPOINT s");
      return (e as { code?: string }).code ?? "error";
    }
  }

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp69n");
    rn = await kit.seedUser("rn", ORG_A);
    attending = await kit.seedUser("attending", ORG_A);
    supervisor = await kit.seedUser("supervisor", ORG_A, SUPERVISOR_KEYS);
    stranger = await kit.seedUser("stranger", ORG_A);
    otherOrgSupervisor = await kit.seedUser("other-org", ORG_B, SUPERVISOR_KEYS);

    const emitter = createDrizzleAlertEmitter(kit.handle.db);
    registerMessagingSeams({ emitter });
    await wireAlertRuleSeed(kit.handle.db);

    const outbox = catalogOutbox();
    const board = (flagOn: boolean) =>
      buildDeathBoardDeps({
        db: kit.handle.db,
        flags: { forOrg: async () => ({ [DEATH_BOARD_FLAG_KEY]: flagOn }) },
        alerts: emitter,
        patientLabels: async (_org, ids) =>
          new Map(ids.map((id) => [id, { displayName: "Ann B.", mrnSuffix: "1234" }] as const)),
        overrides: {
          // The production wiring: a NEW board publishes `m36.death_board.opened` in its own transaction.
          store: withBoardOpenedEvent(createDbDeathBoardStore(), outbox as never),
          part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
          careTeamMembers: async (_org, patientId) => careTeam.get(patientId)?.members ?? [],
          primaryRn: async (_org, patientId) => careTeam.get(patientId)?.rn ?? null,
        },
      });
    const boardOn = board(true);
    const binding = (flagOn: boolean) =>
      buildDeathNotificationDeps({
        db: kit.handle.db,
        flags: {
          forOrg: async () => ({
            [DEATH_BOARD_FLAG_KEY]: true,
            [DEATH_NOTIFICATIONS_FLAG_KEY]: flagOn,
          }),
        },
        alerts: emitter,
        outbox: outbox as never,
        deathBoard: boardOn.service,
        attendingUserId: async (_org, patientId) => attendingOf.get(patientId) ?? null,
        roleKeysForUser: async () => null,
        isBaaActive: executedBaaGate(() => createDbBaaStore(kit.handle.db)),
        isKnownFuneralHome: async (orgId, entityId) =>
          (await createDbBaaStore(kit.handle.db).baaRecords(orgId, "funeral_home", entityId)).length > 0,
        // The REAL adapter and the REAL M2 recorder (audit_event + the catalog-validating m2 publisher); only the link store and the mail are faked.
        funeralLinks: buildFuneralLinkPort({
          db: kit.handle.db,
          collaborators: {
            create: async (i) => {
              linkCreates.push(i);
              return { linkId: randomUUID(), token: "tok-secret", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
            },
            revoke: async ({ linkId }) => void linkRevokes.push(linkId),
          },
          delivery: { deliver: async (d) => void linkCalls.push({ orgId: d.organizationId, email: d.email }) },
          isDeceased: async () => true,
          sessionTtlSec: 100,
          activeMembershipId: async () => randomUUID(),
          recorder: createFuneralDisclosureRecorder(kit.handle.db, {
            publish: (tx, e) => m2Publisher.publish(tx as never, { ...e, callerModule: "m2" } as never),
          }),
        }),
      });
    registerAbacRegistry(
      createPredicateRegistry({
        caseload_membership: async (ctx, target) => caseload.has(`${ctx.userId}:${String(target.patientId)}`),
      }),
    );
    on = binding(true);
    off = binding(false);
    const server = (n: ReturnType<typeof binding>) => {
      const s = buildServer({
        db: kit.handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      registerDeathBoardRoutes(s, boardOn);
      registerDeathNotificationRoutes(s, { ...n, rateLimit: async () => undefined });
      return s;
    };
    appOn = server(on);
    appOff = server(off);
    await Promise.all([appOn.ready(), appOff.ready()]);

    boardConsumer = buildM36DeathBoardConsumer({
      admissionCare: async () => null,
      service: boardOn.service,
      isFlagOn: boardOn.isEnabled,
    });
    noticeConsumer = buildM36DeathNotificationsConsumer({ service: on.service });
  }, 300_000);

  afterAll(async () => {
    await Promise.all([appOn?.close(), appOff?.close()]);
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await kit?.close();
  });

  describe("1. cascade", () => {
    it("publishes ONE opened event for the board however many death events arrive, and replays create nothing new", async () => {
      const { patientId, boardId, opened } = await newDeath();
      await boardConsumer.handle(ev("m5.patient.deceased", { patientId }));
      await boardConsumer.handle(ev("m5.patient.deceased", { patientId }));
      expect(await outboxRows("m36.death_board.opened", boardId)).toHaveLength(1);
      expect(JSON.stringify(opened?.payload)).not.toContain(patientId);

      await deliverOpened(opened);
      await deliverOpened(opened); // redelivery of the same event
      await noticeConsumer.handle(ev("m36.death_board.opened", opened?.payload ?? {})); // a second event id for the same board
      const rows = await noticeRows(boardId);
      expect(rows).toHaveLength(INTERNAL_COUNT);
      expect(rows.every((r) => r.state === "sent")).toBe(true);
      expect(new Set(rows.map((r) => r.recipient_kind))).toEqual(
        new Set(DEATH_NOTIFICATION_INTERNAL_KINDS),
      );
      expect(await outboxRows("m36.death_notification.sent")).toSatisfy(
        (r: unknown[]) => r.length >= INTERNAL_COUNT,
      );
      const sentForBoard = (await outboxRows("m36.death_notification.sent")).filter(
        (r) => r.payload.boardId === boardId,
      );
      expect(sentForBoard).toHaveLength(INTERNAL_COUNT);
    });

    it("names the attending, uses fixed PHI-free text, and delivers to the attending's inbox", async () => {
      const { patientId, boardId, opened } = await newDeath();
      await deliverOpened(opened);
      const attendingRow = (await noticeRows(boardId)).find((r) => r.recipient_kind === "attending");
      expect(attendingRow?.recipient_ref).toBe(attending);
      const alerts = await alertRows("m36.death_notification.attending");
      const mine = alerts.filter((a) => (a.payload as { recipientUserId?: string }).recipientUserId === attending);
      expect(mine.length).toBeGreaterThan(0);
      expect((mine[0]?.payload as { message: string }).message).toBe(DEATH_NOTIFICATION_TEXT.notice);
      const delivered = await kit.one(
        "SELECT 1 FROM notification_delivery WHERE alert_id=$1 AND recipient_user_id=$2",
        [mine[0]?.id, attending],
      );
      expect(delivered.length).toBeGreaterThan(0);
      for (const a of await alertRows("m36.death_notification.%")) {
        expect(JSON.stringify(a.payload)).not.toContain(patientId);
        expect(a.correlation_id).not.toContain(patientId);
      }
    });

    it("a role nobody holds still reaches someone: the tenant-admin fallback alert is written", async () => {
      const { opened } = await newDeath();
      await deliverOpened(opened);
      const fallbacks = await kit.one(
        "SELECT correlation_id FROM alert WHERE organization_id=$1 AND event_type='m30.alerts.recipient_fallback' AND correlation_id LIKE 'death-notification:%'",
        [ORG_A],
      );
      expect(fallbacks.length).toBeGreaterThan(0);
    });

    it("pharmacy and DME notices (role keys undecided) go straight to the tenant-admin fallback, no role-rule alert", async () => {
      const { boardId, opened } = await newDeath();
      await deliverOpened(opened);
      expect(await alertRows("m36.death_notification.pharmacy_liaison")).toHaveLength(0);
      expect(await alertRows("m36.death_notification.dme_liaison")).toHaveLength(0);
      const rows = await noticeRows(boardId);
      for (const kind of ["pharmacy_liaison", "dme_liaison"]) {
        const row = rows.find((r) => r.recipient_kind === kind);
        expect(row?.state).toBe("sent");
        const key = deathNotificationCorrelationKey(row?.id as string);
        const fb = await kit.one(
          "SELECT 1 FROM alert WHERE organization_id=$1 AND event_type='m30.alerts.recipient_fallback' AND correlation_id=$2",
          [ORG_A, `death-notification:${key}:notice:fb`],
        );
        expect(fb).toHaveLength(1);
      }
    });

    it("flag off writes no notification at all", async () => {
      const { boardId, opened } = await newDeath();
      const offConsumer = buildM36DeathNotificationsConsumer({ service: off.service });
      await offConsumer.handle(ev("m36.death_board.opened", opened?.payload ?? {}, opened?.id as DispatchableOutboxEvent["id"]));
      expect(await noticeRows(boardId)).toHaveLength(0);
    });

    it("a board id from another tenant finds nothing and throws (relay retry)", async () => {
      const { boardId } = await newDeath();
      await expect(
        noticeConsumer.handle({
          ...ev("m36.death_board.opened", { boardId }),
          organizationId: ORG_B,
        }),
      ).rejects.toThrow();
    });
  });

  describe("2. explicit acknowledgment", () => {
    it("the attending acknowledges; the audit row, the acked event and the database clock all land; a repeat is a no-op", async () => {
      const { boardId, opened } = await newDeath();
      await deliverOpened(opened);
      const list = (await call(attending, "GET", `${BOARDS}/${boardId}/notifications`)).json()
        .notifications as NoticeJson[];
      const mine = list.find((n) => n.recipient_kind === "attending") as NoticeJson;
      expect(mine.can_ack).toBe(true);
      expect(list.find((n) => n.recipient_kind === "billing_lead")?.can_ack).toBe(false);

      const res = await call(attending, "POST", `${NOTICES}/${mine.id}/ack`);
      expect(res.statusCode).toBe(200);
      expect(res.json().notification).toMatchObject({ state: "acked", acked_by: attending });
      const row = (await noticeRows(boardId)).find((r) => r.recipient_kind === "attending");
      expect(row?.acked_by).toBe(attending);
      expect(row?.acked_at).toBeInstanceOf(Date);

      const audit = await kit.one(
        "SELECT actor_user_id FROM audit_event WHERE resource_kind='death_notification' AND resource_id=$1 AND event_type='death_notification.update'",
        [mine.id],
      );
      expect(audit.map((a) => (a as { actor_user_id: string }).actor_user_id)).toContain(attending);
      expect(await outboxRows("m36.death_notification.acked", mine.id)).toHaveLength(1);

      const again = await call(attending, "POST", `${NOTICES}/${mine.id}/ack`);
      expect(again.statusCode).toBe(200);
      expect(await outboxRows("m36.death_notification.acked", mine.id)).toHaveLength(1);
    });

    it("refuses someone who is not the recipient, and a board viewer outside the care team gets the uniform 404", async () => {
      const { boardId, opened } = await newDeath();
      await deliverOpened(opened);
      const mine = (await noticeRows(boardId)).find((r) => r.recipient_kind === "attending");
      const rnTry = await call(rn, "POST", `${NOTICES}/${mine?.id}/ack`);
      expect(rnTry.statusCode).toBe(403);
      expect(code(rnTry)).toBe("DEATH_NOTIFICATION_NOT_RECIPIENT");
      expect((await call(stranger, "POST", `${NOTICES}/${mine?.id}/ack`)).statusCode).toBe(404);
      expect((await call(stranger, "GET", `${BOARDS}/${boardId}/notifications`)).statusCode).toBe(404);
    });

    it("a supervisor may acknowledge a role notice; an external notice cannot be acknowledged", async () => {
      const { boardId, opened } = await newDeath();
      await deliverOpened(opened);
      const billing = (await noticeRows(boardId)).find((r) => r.recipient_kind === "billing_lead");
      expect((await call(supervisor, "POST", `${NOTICES}/${billing?.id}/ack`)).statusCode).toBe(200);
    });

    it("flag off: the list answers enabled:false and an ack is a 404", async () => {
      const { boardId } = await newDeath();
      const list = await call(supervisor, "GET", `${BOARDS}/${boardId}/notifications`, undefined, ORG_A, appOff);
      expect(list.json()).toEqual({ enabled: false, notifications: [] });
      expect((await call(supervisor, "POST", `${NOTICES}/${randomUUID()}/ack`, undefined, ORG_A, appOff)).statusCode).toBe(404);
    });

    it("an acknowledged row is final and none can be planted acknowledged or deleted, as the app role", async () => {
      const { boardId, patientId, opened } = await newDeath();
      await deliverOpened(opened);
      const row = (await noticeRows(boardId))[0];
      await call(supervisor, "POST", `${NOTICES}/${row?.id}/ack`);
      await asApp(ORG_A, async () => {
        expect(await attempt("DELETE FROM death_notification WHERE id=$1", [row?.id])).toBe("42501");
        expect(
          await attempt("UPDATE death_notification SET state='sent', acked_at=NULL, acked_by=NULL WHERE id=$1", [row?.id]),
        ).toBe("23514");
        expect(
          await attempt(
            `INSERT INTO death_notification (organization_id, board_id, patient_id, recipient_kind, recipient_ref, state, acked_at, acked_by)
             VALUES ($1,$2,$3,'funeral_home',$4,'acked',now(),$5)`,
            [ORG_A, boardId, patientId, randomUUID(), supervisor],
          ),
        ).toBe("23514");
      });
    });
  });

  describe("3. external funeral-home notice", () => {
    const send = (user: string, boardId: string, entity: string, org = ORG_A) =>
      call(user, "POST", `${BOARDS}/${boardId}/funeral-home`, {
        funeral_home_entity_id: entity,
        recipient_email: FUNERAL_EMAIL,
      }, org);
    /** A funeral home exists for the tenant when M40's register holds a record for it; pending = no executed BAA yet. */
    const registerHome = async (entity: string) => {
      await kit.admin.query(
        `INSERT INTO mdm_baa_record (organization_id, entity_kind, canonical_id, baa_status) VALUES ($1,'funeral_home',$2,'pending')`,
        [ORG_A, entity],
      );
    };
    const executeBaa = (entity: string) =>
      kit.admin.query(
        "UPDATE mdm_baa_record SET baa_status='executed', executed_on='2026-01-01' WHERE organization_id=$1 AND canonical_id=$2",
        [ORG_A, entity],
      );
    const audits = (eventType: string, resourceId: string) =>
      kit.one<{ actor_user_id: string; outcome: string; context: Record<string, unknown> }>(
        "SELECT actor_user_id, outcome, context FROM audit_event WHERE event_type=$1 AND resource_id=$2",
        [eventType, resourceId],
      );

    it("without an executed BAA the notice is blocked_no_baa, a supervisor is alerted, nothing is sent and the board items stay open", async () => {
      const { boardId } = await newDeath();
      const entity = randomUUID();
      await registerHome(entity);
      const before = linkCalls.length;
      const res = await send(supervisor, boardId, entity);
      expect(res.statusCode).toBe(200);
      expect(res.json().notification.state).toBe("blocked_no_baa");
      expect(linkCalls.length).toBe(before);
      const alerts = (await alertRows("m36.death_notification.blocked_no_baa")).filter(
        (a) => (a.payload as { message?: string }).message === DEATH_NOTIFICATION_TEXT.blockedNoBaa,
      );
      expect(alerts.length).toBeGreaterThan(0);
      expect((await outboxRows("m36.death_notification.blocked")).length).toBeGreaterThan(0);
      const open = await kit.count(
        "SELECT count(*)::int AS n FROM death_board_item WHERE board_id=$1 AND status='open'",
        [boardId],
      );
      expect(open).toBe(6);
      // The address is never stored anywhere in the notification row.
      const stored = await kit.one("SELECT to_jsonb(n) AS j FROM death_notification n WHERE board_id=$1", [boardId]);
      expect(JSON.stringify(stored)).not.toContain(FUNERAL_EMAIL);
    });

    it("a blocked disclosure is audited as refused (m2.funeral.invite_refused, denied) with the actor, the funeral home and the patient", async () => {
      const { boardId, patientId } = await newDeath();
      const entity = randomUUID();
      await registerHome(entity);
      await send(supervisor, boardId, entity);
      const rows = await audits("m2.funeral.invite_refused", entity);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_user_id).toBe(supervisor);
      expect(rows[0]?.outcome).toBe("denied");
      expect(rows[0]?.context).toMatchObject({ reason: "no_baa", patientId });
      expect(JSON.stringify(rows)).not.toContain(FUNERAL_EMAIL);
    });

    it("a funeral home the tenant has no record of (junk id) creates no row, sends nothing, answers 404 and is audited as refused", async () => {
      const { boardId, patientId } = await newDeath();
      const junk = randomUUID();
      const before = linkCalls.length;
      const res = await send(supervisor, boardId, junk);
      expect(res.statusCode).toBe(404);
      expect(code(res)).toBe("DEATH_NOTIFICATION_FUNERAL_HOME_UNKNOWN");
      expect(await noticeRows(boardId)).toHaveLength(0);
      expect(linkCalls.length).toBe(before);
      const rows = await audits("m2.funeral.invite_refused", junk);
      expect(rows[0]?.context).toMatchObject({ reason: "unknown_funeral_home", patientId });
      // a record in ANOTHER tenant is not a funeral home here
      const foreign = randomUUID();
      await kit.admin.query(
        `INSERT INTO mdm_baa_record (organization_id, entity_kind, canonical_id, baa_status, executed_on) VALUES ($1,'funeral_home',$2,'executed','2026-01-01')`,
        [ORG_B, foreign],
      );
      expect((await send(supervisor, boardId, foreign)).statusCode).toBe(404);
      expect(await noticeRows(boardId)).toHaveLength(0);
    });

    it("the blocked supervisor alert is deduped per board, so a run of different funeral homes raises one alert", async () => {
      const { boardId } = await newDeath();
      const [a, b] = [randomUUID(), randomUUID()];
      await registerHome(a);
      await registerHome(b);
      await send(supervisor, boardId, a);
      await send(supervisor, boardId, b);
      const key = `death-notification:${deathNotificationCorrelationKey(`${boardId}:funeral_home`)}:m36.death_notification.blocked_no_baa`;
      const rows = (await alertRows("m36.death_notification.blocked_no_baa")).filter((r) => r.correlation_id === key);
      expect(rows).toHaveLength(1);
      expect(await noticeRows(boardId)).toHaveLength(2);
    });

    it("with an executed BAA the link is sent once, a repeat sends no second, and a later BAA unblocks a blocked row", async () => {
      const { patientId, boardId } = await newDeath();
      const entity = randomUUID();
      await registerHome(entity);
      expect((await send(supervisor, boardId, entity)).json().notification.state).toBe("blocked_no_baa");
      await executeBaa(entity);
      const before = linkCalls.length;
      const sent = await send(supervisor, boardId, entity);
      expect(sent.json().notification.state).toBe("sent");
      expect(linkCalls.slice(before)).toEqual([{ orgId: ORG_A, email: FUNERAL_EMAIL }]);
      // the link is bound to the funeral home and the patient, for the redemption-time BAA re-check
      expect(linkCreates.at(-1)).toMatchObject({ kind: "funeral_home", patientId, funeralHomeEntityId: entity });
      await send(supervisor, boardId, entity);
      expect(linkCalls.length).toBe(before + 1);
      const rows = await kit.one(
        "SELECT state FROM death_notification WHERE board_id=$1 AND recipient_kind='funeral_home'",
        [boardId],
      );
      expect(rows).toEqual([{ state: "sent" }]);
    });

    it("a sent disclosure leaves the same M2 trail as /funeral/invite and a row that joins to the patient (entity, link, recipient hash - no address, no token)", async () => {
      const { patientId, boardId } = await newDeath();
      const entity = randomUUID();
      await registerHome(entity);
      await executeBaa(entity);
      expect((await send(supervisor, boardId, entity)).json().notification.state).toBe("sent");
      const row = (
        await kit.one<{ patient_id: string; funeral_home_entity_id: string; link_id: string; recipient_email_hash: string }>(
          "SELECT patient_id, funeral_home_entity_id, link_id, recipient_email_hash FROM death_notification WHERE board_id=$1",
          [boardId],
        )
      )[0];
      expect(row?.patient_id).toBe(patientId);
      expect(row?.funeral_home_entity_id).toBe(entity);
      expect(row?.recipient_email_hash).toMatch(/^[0-9a-f]{64}$/);
      const invited = await audits("m2.funeral.invited", row?.link_id as string);
      expect(invited).toHaveLength(1);
      expect(invited[0]?.actor_user_id).toBe(supervisor);
      expect(invited[0]?.context).toMatchObject({ patientId });
      const events = await kit.one(
        "SELECT payload FROM outbox_event WHERE organization_id=$1 AND event_type='m2.funeral.invited' AND aggregate_id=$2",
        [ORG_A, row?.link_id],
      );
      expect(events).toHaveLength(1);
      const everything = JSON.stringify([row, invited, events]);
      expect(everything).not.toContain(FUNERAL_EMAIL);
      expect(everything).not.toContain("tok-secret");
    });

    it("two concurrent sends mint exactly one link", async () => {
      const { boardId } = await newDeath();
      const entity = randomUUID();
      await registerHome(entity);
      await executeBaa(entity);
      const before = linkCalls.length;
      const results = await Promise.all([send(supervisor, boardId, entity), send(supervisor, boardId, entity), send(supervisor, boardId, entity)]);
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      expect(linkCalls.length).toBe(before + 1);
      expect(await noticeRows(boardId)).toHaveLength(1);
    });

    it("an expired BAA blocks", async () => {
      const { boardId } = await newDeath();
      const entity = randomUUID();
      await kit.admin.query(
        `INSERT INTO mdm_baa_record (organization_id, entity_kind, canonical_id, baa_status, executed_on, expires_on)
         VALUES ($1,'funeral_home',$2,'executed','2020-01-01','2021-01-01')`,
        [ORG_A, entity],
      );
      expect((await send(supervisor, boardId, entity)).json().notification.state).toBe("blocked_no_baa");
    });

    it("needs funeral.invite and sight of the board; the other tenant is refused and no row crosses", async () => {
      const { boardId } = await newDeath();
      expect((await send(attending, boardId, randomUUID())).statusCode).toBe(403);
      expect((await send(otherOrgSupervisor, boardId, randomUUID(), ORG_B)).statusCode).toBe(404);
      expect(
        await kit.count("SELECT count(*)::int AS n FROM death_notification WHERE organization_id=$1", [ORG_B]),
      ).toBe(0);
    });

    it("needs the decedent on the caller's caseload (as /funeral/invite): off the caseload is 403 and nothing is written or sent", async () => {
      const { boardId, patientId } = await newDeath();
      const entity = randomUUID();
      await registerHome(entity);
      await executeBaa(entity);
      caseload.delete(`${supervisor}:${patientId}`);
      const before = linkCalls.length;
      const res = await send(supervisor, boardId, entity);
      expect(res.statusCode).toBe(403);
      expect(linkCalls.length).toBe(before);
      expect(await noticeRows(boardId)).toHaveLength(0);
    });

    it("a malformed body is a validation error before anything is written", async () => {
      const { boardId } = await newDeath();
      const bad = await call(supervisor, "POST", `${BOARDS}/${boardId}/funeral-home`, {
        funeral_home_entity_id: "not-a-uuid",
        recipient_email: "x",
      });
      expect(bad.statusCode).toBeGreaterThanOrEqual(400);
      expect(bad.statusCode).toBeLessThan(500);
      expect(await noticeRows(boardId)).toHaveLength(0);
    });
  });

  describe("4. tenancy as chartwarden_app", () => {
    it("another tenant sees no rows and cannot write one across the boundary", async () => {
      const { boardId, patientId, opened } = await newDeath();
      await deliverOpened(opened);
      await asApp(ORG_B, async () => {
        const seen = await kit.appConn.query("SELECT count(*)::int AS n FROM death_notification");
        expect(seen.rows[0].n).toBe(0);
        expect(
          await attempt(
            `INSERT INTO death_notification (organization_id, board_id, patient_id, recipient_kind, recipient_ref)
             VALUES ($1,$2,$3,'attending',$4)`,
            [ORG_A, boardId, patientId, randomUUID()],
          ),
        ).toBe("42501");
      });
      await asApp(ORG_A, async () => {
        const seen = await kit.appConn.query("SELECT count(*)::int AS n FROM death_notification WHERE board_id=$1", [boardId]);
        expect(seen.rows[0].n).toBe(INTERNAL_COUNT);
      });
      expect((await call(otherOrgSupervisor, "GET", `${BOARDS}/${boardId}/notifications`, undefined, ORG_B)).statusCode).toBe(404);
    });

    it("audit rows for the notification table never carry the patient id", async () => {
      const { boardId, patientId, opened } = await newDeath();
      await deliverOpened(opened);
      const ids = (await noticeRows(boardId)).map((r) => r.id);
      const rows = await kit.one(
        "SELECT before, after FROM audit_event WHERE resource_kind='death_notification' AND resource_id = ANY($1::uuid[])",
        [ids],
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain(patientId);
    });
  });

  describe("5. read audit", () => {
    it("the list read lands a death_board.viewed event naming the reader and the board", async () => {
      const { boardId, patientId, opened } = await newDeath();
      await deliverOpened(opened);
      const res = await call(attending, "GET", `${BOARDS}/${boardId}/notifications`);
      expect(res.statusCode).toBe(200);
      const viewed = await kit.one<{ patient: string | null }>(
        "SELECT context->>'patientId' AS patient FROM audit_event WHERE event_type='death_board.viewed' AND resource_id=$1 AND actor_user_id=$2",
        [boardId, attending],
      );
      expect(viewed.length).toBeGreaterThan(0);
      // HIPAA 164.528 accounting: the read is attributed to the patient (id only, never a name).
      expect(viewed.every((r) => r.patient === patientId)).toBe(true);
    });

    it("a viewer the board refuses (404) leaves no patient-attributed read event and learns nothing", async () => {
      const { boardId, patientId, opened } = await newDeath();
      await deliverOpened(opened);
      const res = await call(stranger, "GET", `${BOARDS}/${boardId}/notifications`);
      expect(res.statusCode).toBe(404);
      expect(JSON.stringify(res.json())).not.toContain(patientId);
      const rows = await kit.one(
        "SELECT 1 FROM audit_event WHERE event_type='death_board.viewed' AND resource_id=$1 AND actor_user_id=$2 AND context->>'patientId' IS NOT NULL",
        [boardId, stranger],
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe("6. stall sweep", () => {
    it("escalates an old unacknowledged notice to the supervisors exactly once", async () => {
      const { boardId, opened } = await newDeath();
      await deliverOpened(opened);
      const rows = await noticeRows(boardId);
      const target = rows.find((r) => r.recipient_kind === "dme_liaison") as (typeof rows)[number];
      await kit.admin.query("UPDATE death_notification SET created_at = now() - interval '3 hours' WHERE id=$1", [target.id]);
      const first = await on.service.flagUnackedForOrg(ORG_A);
      expect(first.examined).toBeGreaterThanOrEqual(1);
      const escalations = () =>
        alertRows("m36.death_notification.unacked").then((r) => r.filter((a) => a.correlation_id.includes("death-notification:")).length);
      const afterFirst = await escalations();
      expect(afterFirst).toBeGreaterThanOrEqual(1);
      await on.service.flagUnackedForOrg(ORG_A);
      expect(await escalations()).toBe(afterFirst);
    });
  });
  describe("7. database backstop as chartwarden_app (legal transitions, actor)", () => {
    const insertSql = `INSERT INTO death_notification (organization_id, board_id, patient_id, recipient_kind, recipient_ref, state)
                       VALUES ($1,$2,$3,$4,$5,$6)`;
    /** Runs `fn` in one app-role transaction as `userId` in ORG_A (app.user_id set), always rolled back. */
    async function asUser<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
      await kit.appConn.query("BEGIN");
      await kit.appConn.query("SELECT set_config('app.org_id',$1,true)", [ORG_A]);
      await kit.appConn.query("SELECT set_config('app.user_id',$1,true)", [userId ?? ""]);
      try {
        return await fn();
      } finally {
        await kit.appConn.query("ROLLBACK");
      }
    }

    it("a notification cannot be born sent, sending or acknowledged", async () => {
      const { boardId, patientId } = await newDeath();
      await asUser(supervisor, async () => {
        for (const state of ["sent", "sending", "acked"]) {
          expect(await attempt(insertSql, [ORG_A, boardId, patientId, "funeral_home", randomUUID(), state])).toBe("23514");
        }
        expect(await attempt(insertSql, [ORG_A, boardId, patientId, "funeral_home", randomUUID(), "pending"])).toBe("ok");
      });
    });

    it("an external notice cannot jump to sent, and a sent one cannot move back; only internal kinds are acknowledged", async () => {
      const { boardId, patientId, opened } = await newDeath();
      await deliverOpened(opened);
      const internal = (await noticeRows(boardId))[0];
      const ref = randomUUID();
      await asUser(supervisor, async () => {
        await kit.appConn.query(insertSql, [ORG_A, boardId, patientId, "funeral_home", ref, "pending"]);
        expect(await attempt("UPDATE death_notification SET state='sent' WHERE recipient_ref=$1", [ref])).toBe("23514");
        expect(await attempt("UPDATE death_notification SET state='acked', acked_by=$2 WHERE recipient_ref=$1", [ref, supervisor])).toBe("23514");
        expect(await attempt("UPDATE death_notification SET state='sending' WHERE recipient_ref=$1", [ref])).toBe("ok");
        // claimed but no link / recipient hash recorded: still refused
        expect(await attempt("UPDATE death_notification SET state='sent' WHERE recipient_ref=$1", [ref])).toBe("23514");
        expect(
          await attempt("UPDATE death_notification SET state='sent', link_id=$2, recipient_email_hash=$3 WHERE recipient_ref=$1", [
            ref,
            randomUUID(),
            "a".repeat(64),
          ]),
        ).toBe("ok");
        expect(await attempt("UPDATE death_notification SET state='pending' WHERE recipient_ref=$1", [ref])).toBe("23514");
        // an internal notice may not be pushed through the external claim
        expect(await attempt("UPDATE death_notification SET state='sending' WHERE id=$1", [internal?.id])).toBe("23514");
      });
    });

    it("acked_by is forced to the session user whatever the client sends, and an acknowledgment without a user is refused", async () => {
      const { boardId, opened } = await newDeath();
      await deliverOpened(opened);
      const row = (await noticeRows(boardId))[0];
      await asUser(supervisor, async () => {
        await kit.appConn.query("UPDATE death_notification SET state='acked', acked_by=$2 WHERE id=$1", [row?.id, attending]);
        const after = await kit.appConn.query("SELECT acked_by FROM death_notification WHERE id=$1", [row?.id]);
        expect(after.rows[0].acked_by).toBe(supervisor);
      });
      await asUser(null, async () => {
        expect(await attempt("UPDATE death_notification SET state='acked', acked_by=$2 WHERE id=$1", [row?.id, attending])).toBe("23514");
      });
    });
  });
});
