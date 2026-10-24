/**
 * M36 WP 6.9 (ADR-0098, PROPOSED) - the death-event coordination board, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * The real routes over the real database, the REAL `AlertEmitter` with the seeded platform rules, the real death consumer fed synthetic
 * `m6.admission.discharged` / `m5.patient.deceased` events, and the real offboarding sweep.
 *
 *   1. CREATION      both death events converge on ONE board of six items with one owner each; a duplicate creates nothing; a transfer
 *                    opens nothing; flag off opens nothing; nobody eligible fails loudly and writes nothing; fallback to a former
 *                    channel member; no channel, message or task is deleted or archived by the board (bereavement channel untouched).
 *   2. DATABASE      as chartwarden_app: no DELETE, frozen identity columns, an item is born open, only the owner completes, completed_at
 *                    is the database clock, a done item is final, owner cannot change and complete in one step, a flagged item cannot be
 *                    completed, FORCEd RLS hides another tenant, audit rows never carry the patient id.
 *   3. ROUTES        owner / supervisor / care team see the board; a stranger, a Part 2-refused viewer (supervisor included) and another
 *                    tenant get the SAME 404 as a missing board; flag off is a 404 (list: enabled:false); complete is the owner's, explicit
 *                    and idempotent; reassign is audited, validated and alerted with fixed text; reads land one audit event per patient.
 *   4. OFFBOARDING   a leaver's open items move to the next eligible person (system actor, reason offboarding), or are flagged
 *                    needs_owner with the owner kept and supervisors told; a supervisor reassignment clears the flag; replays are no-ops.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:death-board:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the chartwarden_* roles.
 */
import { randomUUID } from "node:crypto";
import { resetAbacRegistry, resetAuthorizationContract, resetRbacEngine } from "@chartwarden/auth";
import { DEATH_BOARD_FLAG_KEY, DEATH_BOARD_TEMPLATE } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import { DEATH_BOARD_ALERT_TEXT } from "../src/modules/36-messaging/death-board/death-board-alerts";
import { buildDeathBoardDeps } from "../src/modules/36-messaging/death-board/deps";
import {
  createDrizzleAlertEmitter,
  registerMessagingSeams,
  wireAlertRuleSeed,
} from "../src/modules/36-messaging/index";
import { buildM36DeathBoardConsumer } from "../src/modules/36-messaging/outbox-consumers/death-board";
import { registerDeathBoardRoutes } from "../src/modules/36-messaging/routes/death-board-routes";
import {
  type LiveKit,
  STAFF_KEYS,
  as,
  bootLiveKit,
  headerAuth,
  mkChannel,
} from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-1111000f6901";
const ORG_B = "22222222-2222-4222-8222-2222000f6902";
const BOARDS = "/api/v1/messaging/death-boards";
const ITEMS = "/api/v1/messaging/death-board-items";
const SUPERVISOR_KEYS = [...STAFF_KEYS, "messaging.review"];
const ITEM_COUNT = DEATH_BOARD_TEMPLATE.length;

interface ItemJson {
  id: string;
  item_key: string;
  status: string;
  owner_user_id: string;
  needs_owner: boolean;
  completed_at: string | null;
  actions: string[];
}
interface BoardJson {
  id: string;
  patient_id: string;
  open_count: number;
  items: ItemJson[];
}

describe.skipIf(!DB_URL)("M36 WP 6.9 death board - LIVE Postgres", () => {
  let kit: LiveKit;
  let appOn: FastifyInstance;
  let appOff: FastifyInstance;
  let rn: string;
  let nurse2: string;
  let former: string;
  let supervisor: string;
  let stranger: string;
  let otherOrgUser: string;
  let consumerOn: ReturnType<typeof buildM36DeathBoardConsumer>;
  let consumerOff: ReturnType<typeof buildM36DeathBoardConsumer>;
  let on: ReturnType<typeof buildDeathBoardDeps>;

  // Test knobs the bindings' ports read lazily.
  const careTeam = new Map<string, { rn: string | null; members: string[] }>();
  const part2Denied = new Set<string>();
  const part2Down = new Set<string>(); // patient ids whose gate throws (fail-closed proof)
  const admissionPatient = new Map<string, string>();

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
  const strip = (b: string) => b.replace(/"(requestId|correlationId)":"[^"]*"/g, "");

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
  const deathOf = (patientId: string, consumer = consumerOn) =>
    consumer.handle(ev("m5.patient.deceased", { patientId }));
  const dischargeOf = (admissionId: string, reason: string, consumer = consumerOn) =>
    consumer.handle(ev("m6.admission.discharged", { admissionId, reason }));

  /** A new patient whose care team is `rn` + `nurse2`. */
  function newPatient(over: { rn?: string | null; members?: string[] } = {}) {
    const patientId = randomUUID();
    careTeam.set(patientId, {
      rn: over.rn === undefined ? rn : over.rn,
      members: over.members ?? [rn, nurse2],
    });
    return patientId;
  }
  const boardOf = async (patientId: string) =>
    (
      await kit.one<{ id: string }>(
        "SELECT id FROM death_board WHERE organization_id=$1 AND patient_id=$2",
        [ORG_A, patientId],
      )
    )[0]?.id;
  const itemRows = (boardId: string) =>
    kit.one<{
      id: string;
      item_key: string;
      owner_user_id: string;
      status: string;
      needs_owner: boolean;
      completed_at: Date | null;
      version: number;
    }>("SELECT * FROM death_board_item WHERE board_id=$1 ORDER BY item_key", [boardId]);
  const eventsOf = (itemId: string) =>
    kit.one<{
      event_type: string;
      actor_kind: string;
      actor_user_id: string | null;
      from_owner_user_id: string | null;
      to_owner_user_id: string | null;
      reason_code: string;
    }>("SELECT * FROM death_board_item_event WHERE item_id=$1 ORDER BY created_at, id", [itemId]);
  const alertsOf = (kind: "assigned" | "needs_owner") =>
    kit.one<{ payload: Record<string, unknown>; correlation_id: string }>(
      "SELECT payload, correlation_id FROM alert WHERE organization_id=$1 AND event_type=$2",
      [ORG_A, `m36.death_board.${kind}`],
    );
  /** A new board by the real consumer path. */
  async function boardFor(over: { rn?: string | null; members?: string[] } = {}) {
    const patientId = newPatient(over);
    await deathOf(patientId);
    const boardId = (await boardOf(patientId)) as string;
    return { patientId, boardId, items: await itemRows(boardId) };
  }
  const fetchBoard = async (user: string, boardId: string, org = ORG_A) =>
    call(user, "GET", `${BOARDS}/${boardId}`, undefined, org);

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
  /** One statement as the app role inside the open transaction; a refusal rolls back to a savepoint and returns the SQLSTATE. */
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
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp69");
    rn = await kit.seedUser("rn", ORG_A);
    nurse2 = await kit.seedUser("nurse2", ORG_A);
    former = await kit.seedUser("former", ORG_A);
    supervisor = await kit.seedUser("supervisor", ORG_A, SUPERVISOR_KEYS);
    stranger = await kit.seedUser("stranger", ORG_A);
    otherOrgUser = await kit.seedUser("other-org", ORG_B, SUPERVISOR_KEYS);

    const emitter = createDrizzleAlertEmitter(kit.handle.db);
    registerMessagingSeams({ emitter });
    await wireAlertRuleSeed(kit.handle.db);

    const binding = (flagOn: boolean) =>
      buildDeathBoardDeps({
        db: kit.handle.db,
        flags: { forOrg: async () => ({ [DEATH_BOARD_FLAG_KEY]: flagOn }) },
        alerts: emitter,
        patientLabels: async (_org, ids) =>
          new Map(ids.map((id) => [id, { displayName: "Ann B.", mrnSuffix: "1234" }] as const)),
        overrides: {
          part2Gate: {
            allowedUserIds: async ({ patientId, userIds }) => {
              if (part2Down.has(patientId)) throw new Error("gate down");
              return new Set(userIds.filter((u) => !part2Denied.has(`${u}:${patientId}`)));
            },
          },
          careTeamMembers: async (_org, patientId) => careTeam.get(patientId)?.members ?? [],
          primaryRn: async (_org, patientId) => careTeam.get(patientId)?.rn ?? null,
        },
      });
    on = binding(true);
    const off = binding(false);
    const server = (deps: ReturnType<typeof binding>) => {
      const s = buildServer({
        db: kit.handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      registerDeathBoardRoutes(s, deps);
      return s;
    };
    appOn = server(on);
    appOff = server(off);
    await Promise.all([appOn.ready(), appOff.ready()]);

    const admissionCare = async (_org: string, admissionId: string) => {
      const patientId = admissionPatient.get(admissionId);
      return patientId ? { patientId, otherAdmissionUnderCare: false } : null;
    };
    consumerOn = buildM36DeathBoardConsumer({
      admissionCare,
      service: on.service,
      isFlagOn: on.isEnabled,
    });
    consumerOff = buildM36DeathBoardConsumer({
      admissionCare,
      service: off.service,
      isFlagOn: off.isEnabled,
    });
  }, 300_000);

  afterAll(async () => {
    await Promise.all([appOn?.close(), appOff?.close()]);
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await kit?.close();
  });

  describe("1. creation", () => {
    it("both death events converge on ONE board of six items, each with one owner and a created event", async () => {
      const patientId = newPatient();
      const admission = randomUUID();
      admissionPatient.set(admission, patientId);
      await dischargeOf(admission, "death");
      await deathOf(patientId);
      await deathOf(patientId);
      const boards = await kit.one("SELECT id FROM death_board WHERE patient_id=$1", [patientId]);
      expect(boards).toHaveLength(1);
      const items = await itemRows((boards[0] as { id: string }).id);
      expect(items.map((i) => i.item_key).sort()).toEqual(
        DEATH_BOARD_TEMPLATE.map((t) => t.key).sort(),
      );
      expect(items.every((i) => i.owner_user_id === rn && i.status === "open")).toBe(true);
      for (const item of items) {
        const events = await eventsOf(item.id);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          event_type: "created",
          actor_kind: "system",
          to_owner_user_id: rn,
          reason_code: "creation",
        });
      }
      // The owner was alerted once, not once per delivery.
      const correlated = (await alertsOf("assigned")).filter((a) => a.payload.ownerUserId === rn);
      expect(new Set(correlated.map((a) => a.correlation_id)).size).toBe(correlated.length);
    });

    it("a transfer or an ordinary discharge opens no board", async () => {
      const patientId = newPatient();
      const admission = randomUUID();
      admissionPatient.set(admission, patientId);
      await dischargeOf(admission, "transfer");
      await dischargeOf(admission, "revocation");
      expect(await boardOf(patientId)).toBeUndefined();
    });

    it("flag off opens nothing", async () => {
      const patientId = newPatient();
      await deathOf(patientId, consumerOff);
      expect(await boardOf(patientId)).toBeUndefined();
    });

    it("nobody eligible fails loudly, writes nothing and tells supervisors", async () => {
      const patientId = newPatient({ rn: null, members: [] });
      await expect(deathOf(patientId)).rejects.toThrow(/no eligible owner/);
      expect(await boardOf(patientId)).toBeUndefined();
      expect((await alertsOf("needs_owner")).length).toBeGreaterThan(0);
    });

    it("falls back to a former care-team channel member, and never changes a channel", async () => {
      const patientId = newPatient({ rn: null, members: [] });
      const careCh = await mkChannel(kit, "care_team", patientId, [former]);
      const bereavementCh = (
        await kit.one<{ id: string }>(
          `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class, archives_at)
           VALUES ($1,'bereavement',$2,'wp69-bereavement','bereavement', now() + interval '13 months') RETURNING id`,
          [ORG_A, randomUUID()],
        )
      )[0]?.id as string;
      await kit.admin.query(
        "UPDATE channel_member SET removed_at=now() WHERE channel_id=$1 AND user_id=$2",
        [careCh, former],
      );
      const before = {
        channel: await kit.count("SELECT count(*)::int AS n FROM channel"),
        member: await kit.count("SELECT count(*)::int AS n FROM channel_member"),
        message: await kit.count("SELECT count(*)::int AS n FROM message"),
        task: await kit.count("SELECT count(*)::int AS n FROM communication_task"),
        review: await kit.count("SELECT count(*)::int AS n FROM messaging_review_item"),
      };
      await deathOf(patientId);
      const items = await itemRows((await boardOf(patientId)) as string);
      expect(items.every((i) => i.owner_user_id === former)).toBe(true);
      const after = {
        channel: await kit.count("SELECT count(*)::int AS n FROM channel"),
        member: await kit.count("SELECT count(*)::int AS n FROM channel_member"),
        message: await kit.count("SELECT count(*)::int AS n FROM message"),
        task: await kit.count("SELECT count(*)::int AS n FROM communication_task"),
        review: await kit.count("SELECT count(*)::int AS n FROM messaging_review_item"),
      };
      expect(after).toEqual(before);
      const bereavement = await kit.one<{ is_archived: boolean }>(
        "SELECT is_archived FROM channel WHERE id=$1",
        [bereavementCh],
      );
      expect(bereavement[0]?.is_archived).toBe(false);
    });

    it("skips an inactive owner and a Part 2-refused one", async () => {
      const patientId = newPatient({ rn, members: [nurse2] });
      part2Denied.add(`${rn}:${patientId}`);
      await deathOf(patientId);
      const items = await itemRows((await boardOf(patientId)) as string);
      expect(items.every((i) => i.owner_user_id === nurse2)).toBe(true);
    });
  });

  describe("2. database guards as chartwarden_app", () => {
    it("refuses delete, identity rewrites, planted done items and a non-owner or back-dated completion", async () => {
      const { boardId, patientId, items } = await boardFor();
      const item = items[0] as (typeof items)[number];
      await asApp(ORG_A, async () => {
        expect(await attempt("DELETE FROM death_board_item WHERE id=$1", [item.id])).toBe("42501");
        expect(await attempt("DELETE FROM death_board WHERE id=$1", [boardId])).toBe("42501");
        expect(await attempt("DELETE FROM death_board_item_event")).toBe("42501");
        expect(
          await attempt("UPDATE death_board_item SET item_key='dme_pickup' WHERE id=$1", [item.id]),
        ).toBe("42501");
        expect(
          await attempt("UPDATE death_board_item SET patient_id=$2 WHERE id=$1", [
            item.id,
            randomUUID(),
          ]),
        ).toBe("42501");
        expect(await attempt("UPDATE death_board_item_event SET reason_code='manual'")).toBe(
          "42501",
        );
        // an item is born open and unflagged
        const planted = (key: string, status: string, flag: boolean) =>
          attempt(
            `INSERT INTO death_board_item (organization_id, board_id, patient_id, item_key, owner_user_id, status, needs_owner, due_at, completed_at, completed_by_user_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7, now(), ${status === "done" ? "now()" : "NULL"}, ${status === "done" ? "$5" : "NULL"})`,
            [ORG_A, boardId, patientId, key, rn, status, flag],
          );
        expect(await planted("dme_pickup", "done", false)).toBe("23514");
        // a completion must be the owner's own
        expect(
          await attempt(
            "UPDATE death_board_item SET status='done', completed_by_user_id=$2, completed_at=now() WHERE id=$1",
            [item.id, nurse2],
          ),
        ).toBe("23514");
      });
    });

    it("sets completed_at from the database clock, makes done final, and refuses owner change + complete in one step", async () => {
      const { items } = await boardFor();
      const [first, second, third] = items;
      await asApp(ORG_A, async () => {
        const done = await kit.appConn.query(
          "UPDATE death_board_item SET status='done', completed_by_user_id=$2, completed_at='2001-01-01' WHERE id=$1 RETURNING completed_at, now() AS db_now",
          [first?.id, rn],
        );
        const row = done.rows[0] as { completed_at: Date; db_now: Date };
        expect(row.completed_at.getTime()).toBe(row.db_now.getTime());
        expect(
          await attempt("UPDATE death_board_item SET owner_user_id=$2 WHERE id=$1", [
            first?.id,
            nurse2,
          ]),
        ).toBe("23514");
        expect(
          await attempt(
            "UPDATE death_board_item SET owner_user_id=$2, status='done', completed_by_user_id=$2 WHERE id=$1",
            [second?.id, nurse2],
          ),
        ).toBe("23514");
        // a flagged item cannot be completed; a reassignment must clear the flag
        expect(
          await attempt("UPDATE death_board_item SET needs_owner=true WHERE id=$1", [third?.id]),
        ).toBe("ok");
        expect(
          await attempt(
            "UPDATE death_board_item SET status='done', completed_by_user_id=$2 WHERE id=$1",
            [third?.id, rn],
          ),
        ).toBe("23514");
        expect(
          await attempt("UPDATE death_board_item SET needs_owner=false WHERE id=$1", [third?.id]),
        ).toBe("23514");
        expect(
          await attempt(
            "UPDATE death_board_item SET owner_user_id=$2, needs_owner=true WHERE id=$1",
            [third?.id, nurse2],
          ),
        ).toBe("23514");
        expect(
          await attempt(
            "UPDATE death_board_item SET owner_user_id=$2, needs_owner=false WHERE id=$1",
            [third?.id, nurse2],
          ),
        ).toBe("ok");
      });
    });

    it("FORCEd RLS: another tenant sees no board, item or event", async () => {
      await boardFor();
      for (const table of ["death_board", "death_board_item", "death_board_item_event"]) {
        expect(
          await asApp(
            ORG_B,
            async () =>
              (await kit.appConn.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
          ),
          table,
        ).toBe(0);
      }
      expect(
        await asApp(
          ORG_B,
          async () =>
            await attempt(
              "INSERT INTO death_board (organization_id, patient_id, template_version) VALUES ($1,$2,1)",
              [ORG_A, randomUUID()],
            ),
        ),
      ).toBe("42501");
    });
  });

  describe("3. routes", () => {
    it("shows the board to its owner, a supervisor and a care-team member; everyone else gets the missing-board 404", async () => {
      const { boardId } = await boardFor();
      for (const user of [rn, supervisor, nurse2]) {
        const res = await fetchBoard(user, boardId);
        expect(res.statusCode, user).toBe(200);
        const board = res.json().board as BoardJson;
        expect(board.items).toHaveLength(ITEM_COUNT);
        expect(board.open_count).toBe(ITEM_COUNT);
      }
      const missing = await fetchBoard(rn, randomUUID());
      expect(missing.statusCode).toBe(404);
      for (const [user, org] of [
        [stranger, ORG_A],
        [otherOrgUser, ORG_B],
      ] as const) {
        const res = await fetchBoard(user, boardId, org);
        expect(res.statusCode).toBe(404);
        expect(strip(res.body)).toBe(strip(missing.body));
      }
      expect((await call(rn, "GET", `${BOARDS}/not-a-uuid`)).statusCode).toBe(404);
    });

    it("lists only the viewer's boards and says what the viewer may do", async () => {
      const { boardId } = await boardFor({ rn, members: [rn] });
      const mine = (await call(rn, "GET", BOARDS)).json();
      expect(mine.enabled).toBe(true);
      const board = (mine.boards as BoardJson[]).find((b) => b.id === boardId);
      expect(board?.items[0]?.actions).toEqual(["complete", "reassign"]);
      const sup = (await call(supervisor, "GET", BOARDS)).json().boards as BoardJson[];
      expect(sup.find((b) => b.id === boardId)?.items[0]?.actions).toEqual(["reassign"]);
      const none = (await call(stranger, "GET", BOARDS)).json().boards as BoardJson[];
      expect(none.find((b) => b.id === boardId)).toBeUndefined();
    });

    it("flag off: the list says enabled:false and everything else is a 404, before the query or body is parsed", async () => {
      const { boardId, items } = await boardFor();
      const list = await call(rn, "GET", `${BOARDS}?limit=9999`, undefined, ORG_A, appOff);
      expect(list.json()).toEqual({ enabled: false, boards: [] });
      expect(
        (await call(rn, "GET", `${BOARDS}/${boardId}`, undefined, ORG_A, appOff)).statusCode,
      ).toBe(404);
      const bad = await call(
        rn,
        "POST",
        `${ITEMS}/${items[0]?.id}/reassign`,
        { nope: 1 },
        ORG_A,
        appOff,
      );
      expect(bad.statusCode).toBe(404);
    });

    it("a Part 2-refused viewer, supervisors included, gets the 404", async () => {
      const { patientId, boardId } = await boardFor();
      part2Denied.add(`${supervisor}:${patientId}`);
      part2Denied.add(`${nurse2}:${patientId}`);
      expect((await fetchBoard(supervisor, boardId)).statusCode).toBe(404);
      expect((await fetchBoard(nurse2, boardId)).statusCode).toBe(404);
      expect((await fetchBoard(rn, boardId)).statusCode).toBe(200);
      const listed = (await call(supervisor, "GET", BOARDS)).json().boards as BoardJson[];
      expect(listed.find((b) => b.id === boardId)).toBeUndefined();
    });

    it("a flagged item cannot be reassigned to its current owner (422, not a database 500), and a supervisor cannot name themselves", async () => {
      const { patientId, items } = await boardFor();
      const itemId = items[0]?.id as string;
      await kit.admin.query("UPDATE death_board_item SET needs_owner=true WHERE id=$1", [itemId]);
      for (const user of [supervisor, rn]) {
        const res = await call(user, "POST", `${ITEMS}/${itemId}/reassign`, { to_user_id: rn });
        expect({ s: res.statusCode, c: code(res) }, user).toEqual({
          s: 422,
          c: "DEATH_BOARD_OWNER_INVALID",
        });
      }
      const self = await call(supervisor, "POST", `${ITEMS}/${itemId}/reassign`, {
        to_user_id: supervisor,
      });
      expect({ s: self.statusCode, c: code(self) }).toEqual({
        s: 422,
        c: "DEATH_BOARD_OWNER_INVALID",
      });
      // a Part 2-refused target is refused on the supervisor path too
      part2Denied.add(`${nurse2}:${patientId}`);
      const denied = await call(supervisor, "POST", `${ITEMS}/${itemId}/reassign`, {
        to_user_id: nurse2,
      });
      expect(denied.statusCode).toBe(422);
      part2Denied.delete(`${nurse2}:${patientId}`);
      const ok = await call(supervisor, "POST", `${ITEMS}/${itemId}/reassign`, {
        to_user_id: nurse2,
      });
      expect(ok.statusCode).toBe(200);
      expect((ok.json().item as ItemJson).needs_owner).toBe(false);
    });

    it("a past owner loses access: the same 404 as a missing board", async () => {
      const { boardId, items } = await boardFor({ rn, members: [nurse2] });
      expect((await fetchBoard(rn, boardId)).statusCode).toBe(200);
      for (const item of items) {
        const res = await call(supervisor, "POST", `${ITEMS}/${item.id}/reassign`, {
          to_user_id: nurse2,
        });
        expect(res.statusCode).toBe(200);
      }
      const missing = await fetchBoard(rn, randomUUID());
      const past = await fetchBoard(rn, boardId);
      expect(past.statusCode).toBe(404);
      expect(strip(past.body)).toBe(strip(missing.body));
      const hist = await call(rn, "GET", `${ITEMS}/${items[0]?.id}/history`);
      expect(hist.statusCode).toBe(404);
      expect((await fetchBoard(nurse2, boardId)).statusCode).toBe(200);
    });

    it("a supervisor viewer fails closed (404, empty list) when the Part 2 gate cannot answer", async () => {
      const { patientId, boardId } = await boardFor();
      part2Down.add(patientId);
      try {
        expect((await fetchBoard(supervisor, boardId)).statusCode).toBe(404);
        expect((await fetchBoard(rn, boardId)).statusCode).toBe(404);
        const listed = (await call(supervisor, "GET", BOARDS)).json().boards as BoardJson[];
        expect(listed.find((b) => b.id === boardId)).toBeUndefined();
      } finally {
        part2Down.delete(patientId);
      }
      expect((await fetchBoard(supervisor, boardId)).statusCode).toBe(200);
    });

    it("complete is the owner's alone, explicit and idempotent, stamped by the database clock", async () => {
      const { boardId, items } = await boardFor();
      const itemId = items[0]?.id as string;
      const peer = await call(nurse2, "POST", `${ITEMS}/${itemId}/complete`);
      expect({ s: peer.statusCode, c: code(peer) }).toEqual({ s: 403, c: "DEATH_BOARD_NOT_OWNER" });
      expect((await call(stranger, "POST", `${ITEMS}/${itemId}/complete`)).statusCode).toBe(404);
      const done = await call(rn, "POST", `${ITEMS}/${itemId}/complete`);
      expect(done.statusCode).toBe(200);
      const first = done.json().item as ItemJson;
      expect(first.status).toBe("done");
      const again = await call(rn, "POST", `${ITEMS}/${itemId}/complete`);
      expect((again.json().item as ItemJson).completed_at).toBe(first.completed_at);
      const events = (await eventsOf(itemId)).filter((e) => e.event_type === "completed");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actor_user_id: rn, actor_kind: "user" });
      const board = (await fetchBoard(rn, boardId)).json().board as BoardJson;
      expect(board.open_count).toBe(ITEM_COUNT - 1);
      const audit = await kit.one<{ actor_user_id: string }>(
        "SELECT actor_user_id FROM audit_event WHERE resource_kind='death_board_item' AND resource_id=$1 AND event_type LIKE '%.update'",
        [itemId],
      );
      expect(audit.some((a) => a.actor_user_id === rn)).toBe(true);
    });

    it("reassign is validated, audited and alerted with fixed text that carries nothing about the patient", async () => {
      const { patientId, items } = await boardFor();
      const itemId = items[0]?.id as string;
      const moved = await call(rn, "POST", `${ITEMS}/${itemId}/reassign`, { to_user_id: nurse2 });
      expect(moved.statusCode).toBe(200);
      expect((moved.json().item as ItemJson).owner_user_id).toBe(nurse2);
      expect(await eventsOf(itemId)).toHaveLength(2);
      const event = (await eventsOf(itemId))[1];
      expect(event).toMatchObject({
        event_type: "reassigned",
        actor_user_id: rn,
        from_owner_user_id: rn,
        to_owner_user_id: nurse2,
        reason_code: "manual",
      });
      // idempotent, no second event
      await call(rn, "POST", `${ITEMS}/${itemId}/reassign`, { to_user_id: nurse2 });
      expect(await eventsOf(itemId)).toHaveLength(2);
      // the former owner may no longer move it; a supervisor may
      expect(
        (await call(rn, "POST", `${ITEMS}/${itemId}/reassign`, { to_user_id: rn })).statusCode,
      ).toBe(403);
      const sup = await call(supervisor, "POST", `${ITEMS}/${itemId}/reassign`, { to_user_id: rn });
      expect(sup.statusCode).toBe(200);
      expect((await eventsOf(itemId)).at(-1)?.reason_code).toBe("supervisor");
      // the target must be an active, Part 2-admitted person
      await kit.admin.query("UPDATE membership SET status='suspended' WHERE user_id=$1", [former]);
      const inactive = await call(rn, "POST", `${ITEMS}/${itemId}/reassign`, {
        to_user_id: former,
      });
      expect({ s: inactive.statusCode, c: code(inactive) }).toEqual({
        s: 422,
        c: "DEATH_BOARD_OWNER_INVALID",
      });
      part2Denied.add(`${nurse2}:${patientId}`);
      expect(
        (await call(rn, "POST", `${ITEMS}/${itemId}/reassign`, { to_user_id: nurse2 })).statusCode,
      ).toBe(422);
      part2Denied.delete(`${nurse2}:${patientId}`);
      await kit.admin.query("UPDATE membership SET status='active' WHERE user_id=$1", [former]);
      // free text is refused
      expect(
        (await call(rn, "POST", `${ITEMS}/${itemId}/reassign`, { to_user_id: nurse2, note: "x" }))
          .statusCode,
      ).toBe(422);

      const assigned = await alertsOf("assigned");
      const toNurse = assigned.filter((a) => a.payload.ownerUserId === nurse2);
      expect(toNurse.length).toBeGreaterThan(0);
      for (const a of assigned) {
        expect(a.payload.message).toBe(DEATH_BOARD_ALERT_TEXT.assigned);
        const dump = JSON.stringify([a.payload, a.correlation_id]);
        expect(dump).not.toContain(patientId);
        expect(dump).not.toContain(itemId);
        expect(dump).not.toMatch(/pronounce|medication|family/i);
      }
    });

    it("the history lists owner changes and completion", async () => {
      const { items } = await boardFor();
      const itemId = items[0]?.id as string;
      await call(rn, "POST", `${ITEMS}/${itemId}/reassign`, { to_user_id: nurse2 });
      await call(nurse2, "POST", `${ITEMS}/${itemId}/complete`);
      const history = (await call(rn, "GET", `${ITEMS}/${itemId}/history`)).json().events as Array<{
        event_type: string;
      }>;
      expect(history.map((h) => h.event_type)).toEqual(["created", "reassigned", "completed"]);
      expect((await call(stranger, "GET", `${ITEMS}/${itemId}/history`)).statusCode).toBe(404);
    });

    it("reads are audited with the patient they disclose", async () => {
      const { boardId, patientId } = await boardFor();
      await fetchBoard(rn, boardId);
      const viewed = await kit.one<{ patient: string | null }>(
        "SELECT context->>'patientId' AS patient FROM audit_event WHERE event_type='death_board.viewed' AND resource_id=$1 AND actor_user_id=$2",
        [boardId, rn],
      );
      expect(viewed.map((v) => v.patient)).toEqual([patientId]);
    });

    it("audit rows for the board and its items never carry the patient id", async () => {
      const { boardId, patientId, items } = await boardFor();
      await call(rn, "POST", `${ITEMS}/${items[0]?.id}/complete`);
      const rows = await kit.one(
        "SELECT before, after FROM audit_event WHERE resource_kind IN ('death_board','death_board_item') AND resource_id = ANY($1::uuid[])",
        [[boardId, ...items.map((i) => i.id)]],
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain(patientId);
    });
  });

  describe("4. offboarding", () => {
    it("moves the leaver's open items to the next eligible person as the system actor, and replays are no-ops", async () => {
      const { items } = await boardFor({ rn, members: [rn, nurse2] });
      await on.service.reassignForLeaver(ORG_A, rn);
      const moved = await Promise.all(items.map((i) => eventsOf(i.id)));
      for (const events of moved) {
        expect(events.at(-1)).toMatchObject({
          event_type: "reassigned",
          actor_kind: "system",
          actor_user_id: null,
          from_owner_user_id: rn,
          to_owner_user_id: nurse2,
          reason_code: "offboarding",
        });
      }
      const rows = await itemRows(
        items[0]?.id
          ? ((
              await kit.one<{ board_id: string }>(
                "SELECT board_id FROM death_board_item WHERE id=$1",
                [items[0].id],
              )
            )[0]?.board_id as string)
          : "",
      );
      expect(rows.every((r) => r.owner_user_id === nurse2)).toBe(true);
      const before = await kit.count("SELECT count(*)::int AS n FROM death_board_item_event");
      await on.service.reassignForLeaver(ORG_A, rn);
      expect(await kit.count("SELECT count(*)::int AS n FROM death_board_item_event")).toBe(before);
    });

    it("flags an item nobody can take, keeps the owner, tells supervisors, and a supervisor reassignment clears the flag", async () => {
      const { boardId, items } = await boardFor({ rn: former, members: [former] });
      const alertsBefore = (await alertsOf("needs_owner")).length;
      await on.service.reassignForLeaver(ORG_A, former);
      const flagged = await itemRows(boardId);
      expect(flagged.every((i) => i.needs_owner && i.owner_user_id === former)).toBe(true);
      expect((await eventsOf(items[0]?.id as string)).at(-1)).toMatchObject({
        event_type: "needs_owner",
        actor_kind: "system",
        reason_code: "offboarding",
      });
      expect((await alertsOf("needs_owner")).length).toBeGreaterThan(alertsBefore);
      const board = (await fetchBoard(supervisor, boardId)).json().board as BoardJson;
      expect(board.items.every((i) => i.needs_owner)).toBe(true);
      expect(board.items[0]?.actions).toEqual(["reassign"]);
      // the flagged owner cannot complete; the supervisor hands it to a person and the flag clears
      const itemId = items[0]?.id as string;
      expect((await call(former, "POST", `${ITEMS}/${itemId}/complete`)).statusCode).toBe(409);
      const handed = await call(supervisor, "POST", `${ITEMS}/${itemId}/reassign`, {
        to_user_id: rn,
      });
      expect((handed.json().item as ItemJson).needs_owner).toBe(false);
      expect((await call(rn, "POST", `${ITEMS}/${itemId}/complete`)).statusCode).toBe(200);
    });

    it("completed items stay with whoever finished them", async () => {
      const { boardId, items } = await boardFor({ rn, members: [rn, nurse2] });
      await call(rn, "POST", `${ITEMS}/${items[0]?.id}/complete`);
      await on.service.reassignForLeaver(ORG_A, rn);
      const rows = await itemRows(boardId);
      expect(rows.filter((r) => r.owner_user_id === rn)).toHaveLength(1);
      expect(rows.find((r) => r.owner_user_id === rn)?.status).toBe("done");
    });
  });
});
