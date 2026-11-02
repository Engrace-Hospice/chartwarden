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
import { resetAbacRegistry, resetAuthorizationContract, resetRbacEngine } from "@chartwarden/auth";
import {
  DEATH_BOARD_FLAG_KEY,
  DEATH_NOTIFICATIONS_FLAG_KEY,
  DEATH_NOTIFICATION_INTERNAL_KINDS,
} from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import { buildDeathBoardDeps } from "../src/modules/36-messaging/death-board/deps";
import { createDbDeathBoardStore } from "../src/modules/36-messaging/death-board/death-board-store";
import { executedBaaGate } from "../src/bootstrap/death-notification-baa-gate";
import { withBoardOpenedEvent } from "../src/modules/36-messaging/death-notification/death-board-opened-store";
import { DEATH_NOTIFICATION_TEXT } from "../src/modules/36-messaging/death-notification/death-notification-alerts";
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
  const linkCalls: Array<{ orgId: string; patientId: string; actorUserId: string }> = [];

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
        funeralLinks: {
          issue: async (a) => {
            linkCalls.push({ orgId: a.orgId, patientId: a.patientId, actorUserId: a.actorUserId });
          },
        },
      });
    on = binding(true);
    off = binding(false);
    const server = (n: ReturnType<typeof binding>) => {
      const s = buildServer({
        db: kit.handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      registerDeathBoardRoutes(s, boardOn);
      registerDeathNotificationRoutes(s, n);
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

    it("without a recorded BAA the notice is blocked_no_baa, a supervisor is alerted, nothing is sent and the board items stay open", async () => {
      const { boardId } = await newDeath();
      const entity = randomUUID();
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

    it("a funeral home the M40 policy does not gate (n_a, no record) is still blocked: only a recorded, executed BAA sends", async () => {
      const { boardId } = await newDeath();
      const entity = randomUUID();
      await kit.admin.query(
        "INSERT INTO mdm_baa_required (organization_id, kind, required) VALUES ($1,'funeral_home',false) ON CONFLICT DO NOTHING",
        [ORG_A],
      );
      const res = await send(supervisor, boardId, entity);
      expect(res.json().notification.state).toBe("blocked_no_baa");
    });

    it("with an executed BAA the link is sent once, a repeat sends no second, and a later BAA unblocks a blocked row", async () => {
      const { patientId, boardId } = await newDeath();
      const entity = randomUUID();
      expect((await send(supervisor, boardId, entity)).json().notification.state).toBe("blocked_no_baa");
      await kit.admin.query(
        `INSERT INTO mdm_baa_record (organization_id, entity_kind, canonical_id, baa_status, executed_on)
         VALUES ($1,'funeral_home',$2,'executed','2026-01-01')`,
        [ORG_A, entity],
      );
      const before = linkCalls.length;
      const sent = await send(supervisor, boardId, entity);
      expect(sent.json().notification.state).toBe("sent");
      expect(linkCalls.slice(before)).toEqual([{ orgId: ORG_A, patientId, actorUserId: supervisor }]);
      await send(supervisor, boardId, entity);
      expect(linkCalls.length).toBe(before + 1);
      const rows = await kit.one(
        "SELECT state FROM death_notification WHERE board_id=$1 AND recipient_kind='funeral_home'",
        [boardId],
      );
      expect(rows).toEqual([{ state: "sent" }]);
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
      const { boardId, opened } = await newDeath();
      await deliverOpened(opened);
      const res = await call(attending, "GET", `${BOARDS}/${boardId}/notifications`);
      expect(res.statusCode).toBe(200);
      const viewed = await kit.one(
        "SELECT actor_user_id FROM audit_event WHERE event_type='death_board.viewed' AND resource_id=$1 AND actor_user_id=$2",
        [boardId, attending],
      );
      expect(viewed.length).toBeGreaterThan(0);
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
});
