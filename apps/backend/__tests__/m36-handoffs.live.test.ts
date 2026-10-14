/**
 * M36 WP 3.5 - clinical handoffs, LIVE Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 * The real route stack (Authorization Contract, `channel_visibility`, the DB route service, the audit plumbing) over the
 * REAL catalog-validating outbox publisher (not NOOP_OUTBOX), so every payload is checked against the catalog schema.
 *
 *   1. IDEMPOTENCY   N concurrent identical offers => 1 handoff, 1 offered event, 1 outbox row.
 *   2. ITEM INDEX    two senders offering the same item => exactly one wins, the loser gets a generic 409.
 *   3. ACCEPT        per-item acceptance; N concurrent accepts => one transition; accountability moves only on acceptance.
 *   4. DEADLINE      accept vs expiry in both orders leaves a consistent closed row; an accepted item keeps its new owner.
 *   5. TASK ITEM     accepting a task item reassigns the task (event row, reason handoff); a refusal changes nothing.
 *   6. BACKSTOPS     the database itself refuses editing a closed handoff / a resolved item / a wrong accountable user.
 *   7. TENANCY       org B reads and mutates nothing of org A (HTTP and raw SQL); a cross-org insert is rejected.
 *   8. GRANTS        wardenx_app has no DELETE and cannot UPDATE identity columns; events are append-only.
 *   9. AUDIT         trigger rows land; patient_id / ref_id are never copied; the read event lands once PER PATIENT.
 *  10. POLICY        tighten-only 15..240, admin permission, DELETE restores the default.
 *  11. FLAG + WIRING off => 404 / disabled list; the boot builds, binds, schedules and reassigns (bound is computing).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m36:handoffs:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the wardenx_* roles.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resetAbacRegistry, resetAuthorizationContract, resetRbacEngine } from "@wardenx/auth";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN_KEYS,
  type LiveKit,
  as,
  bootLiveKit,
  errorCode,
  mkChannel,
  plainDoc,
} from "./_m36-handoff-live-kit";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-1111000f0001";
const ORG_B = "22222222-2222-4222-8222-2222000f0002";
/** Every patient id the suite handed out (a patient is only a pointer here: no `patient` row is needed). */
const USED_PATIENTS: string[] = [];
const BASE = "/api/v1/messaging/handoffs";
const stripIds = (b: string) => b.replace(/"(requestId|correlationId)":"[^"]*"/g, "");

interface ItemRow {
  id: string;
  item_kind: string;
  state: string;
  accountable_user_id: string;
  patient_id: string;
}

describe.skipIf(!DB_URL)("M36 WP 3.5 clinical handoffs - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  let offApp: FastifyInstance;
  let binding: ReturnType<LiveKit["build"]>["handoffs"];
  let sender: string;
  let receiver: string;
  let other: string;
  let outsider: string;
  let admin1: string;
  let orgBUser: string;
  const nextPatient = () => {
    const id = randomUUID();
    USED_PATIENTS.push(id);
    return id;
  };

  const call = (
    server: FastifyInstance,
    user: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: object,
    org = ORG_A,
  ) =>
    server.inject({
      method,
      url,
      headers: as(user, org),
      ...(payload ? { payload } : {}),
    });
  const offer = (
    from: string,
    to: string,
    items: Array<{ kind: string; ref_id: string; patient_id: string }>,
    server = app,
  ) => call(server, from, "POST", BASE, { to_user_id: to, items });
  const anchor = (patient: string) => ({ kind: "patient", ref_id: patient, patient_id: patient });
  /** A fresh sender with its own caseload so tests never collide on the one-pending item index. */
  async function fresh(patients: string[]) {
    const from = await kit.seedUser("snd", ORG_A);
    const to = await kit.seedUser("rcv", ORG_A);
    kit.caseload.set(from, patients);
    return { from, to };
  }
  const itemsOf = (handoffId: string) =>
    kit.one<ItemRow>(
      "SELECT id, item_kind, state, accountable_user_id, patient_id FROM clinical_handoff_item WHERE handoff_id=$1 ORDER BY item_kind, id",
      [handoffId],
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
  const outboxCount = (eventName: string, aggregateId: string) =>
    kit.count(
      "SELECT count(*)::int AS n FROM outbox_event WHERE event_type=$1 AND aggregate_id=$2",
      [eventName, aggregateId],
    );
  const makeDue = (handoffId: string) =>
    kit.admin.query(
      "UPDATE clinical_handoff SET offered_at = now() - interval '5 hours', expires_at = now() - interval '1 minute' WHERE id=$1",
      [handoffId],
    );
  async function offered(patients: string[]) {
    const { from, to } = await fresh(patients);
    const res = await offer(from, to, patients.map(anchor));
    expect(res.statusCode).toBe(201);
    return { from, to, id: res.json().handoff.id as string, handoff: res.json().handoff };
  }
  const accept = (user: string, id: string, itemIds: string[]) =>
    call(app, user, "POST", `${BASE}/${id}/accept`, { item_ids: itemIds });
  const firstItemId = async (handoffId: string) => ((await itemsOf(handoffId))[0] as ItemRow).id;
  const holder = (i: ItemRow, to: string) =>
    i.accountable_user_id === to ? "recipient" : "sender";

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp35h");
    sender = await kit.seedUser("sender", ORG_A);
    receiver = await kit.seedUser("receiver", ORG_A);
    other = await kit.seedUser("other", ORG_A);
    outsider = await kit.seedUser("outsider", ORG_A);
    admin1 = await kit.seedUser("admin", ORG_A, ADMIN_KEYS);
    orgBUser = await kit.seedUser("b", ORG_B);
    const on = kit.build(true);
    app = on.server;
    binding = on.handoffs;
    offApp = kit.build(false).server;
    await app.ready();
    await offApp.ready();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await offApp?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await kit?.close();
  });

  describe("offer and idempotency", () => {
    it("creates an offered handoff whose items stay with the sender and publishes one PHI-free catalog-valid event", async () => {
      const p = nextPatient();
      const { from, to, id, handoff } = await offered([p]);
      expect(handoff).toMatchObject({ state: "offered", from_user_id: from, to_user_id: to });
      expect(await handoffRow(id)).toMatchObject({ state: "offered", from_user_id: from });
      const items = await itemsOf(id);
      expect(items.map((i) => [i.state, i.accountable_user_id])).toEqual([["pending", from]]);
      expect(await eventTypes(id)).toEqual(["offered"]);
      const [row] = await kit.one<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM outbox_event WHERE event_type='m36.handoff.offered' AND aggregate_id=$1",
        [id],
      );
      expect(Object.keys(row?.payload ?? {}).sort()).toEqual([
        "at",
        "expiresAt",
        "fromUserId",
        "handoffId",
        "itemCount",
        "organizationId",
        "toUserId",
      ]);
      expect(JSON.stringify(row)).not.toContain(p);
    });

    it("N concurrent identical offers leave exactly one handoff, one offered event and one outbox row", async () => {
      const p = nextPatient();
      const { from, to } = await fresh([p]);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => offer(from, to, [anchor(p)])),
      );
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(7);
      const ids = new Set(results.map((r) => r.json().handoff.id as string));
      expect(ids.size).toBe(1);
      const id = [...ids][0] as string;
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM clinical_handoff WHERE from_user_id=$1 AND to_user_id=$2",
          [from, to],
        ),
      ).toBe(1);
      expect(await eventTypes(id)).toEqual(["offered"]);
      expect(await outboxCount("m36.handoff.offered", id)).toBe(1);
    });

    it("lets exactly one of two senders win the same item and gives the loser a generic 409 with no data", async () => {
      const p = nextPatient();
      const a = await fresh([p]);
      const b = await fresh([p]);
      const [ra, rb] = await Promise.all([
        offer(a.from, a.to, [anchor(p)]),
        offer(b.from, b.to, [anchor(p)]),
      ]);
      expect([ra.statusCode, rb.statusCode].sort()).toEqual([201, 409]);
      const loser = ra.statusCode === 409 ? ra : rb;
      expect(errorCode(loser)).toBe("HANDOFF_ITEM_CONFLICT");
      expect(loser.json().handoff).toBeUndefined();
      expect(loser.body).not.toContain(p);
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM clinical_handoff_item WHERE item_kind='patient' AND ref_id=$1 AND state='pending'",
          [p],
        ),
      ).toBe(1);
    });

    it("refuses an off-caseload patient and an ineligible recipient with uniform 422s and writes nothing", async () => {
      const p = nextPatient();
      const { from, to } = await fresh([p]);
      const offCaseload = await offer(from, to, [anchor(nextPatient())]);
      expect(offCaseload.statusCode).toBe(422);
      expect(errorCode(offCaseload)).toBe("HANDOFF_ITEM_INVALID");
      kit.noPermissions.add(to);
      const noPerm = await offer(from, to, [anchor(p)]);
      kit.noPermissions.delete(to);
      kit.part2Denied.add(`${to}:${p}`);
      const part2 = await offer(from, to, [anchor(p)]);
      kit.part2Denied.delete(`${to}:${p}`);
      for (const res of [noPerm, part2]) {
        expect(res.statusCode).toBe(422);
        expect(errorCode(res)).toBe("HANDOFF_RECIPIENT_INVALID");
      }
      expect(stripIds(noPerm.body)).toBe(stripIds(part2.body));
      expect(
        await kit.count("SELECT count(*)::int AS n FROM clinical_handoff WHERE from_user_id=$1", [
          from,
        ]),
      ).toBe(0);
    });
  });

  describe("accept, decline and accountability", () => {
    it("moves accountability only for the accepted items; a partial accept leaves the handoff offered", async () => {
      const { to, id } = await offered([nextPatient(), nextPatient()]);
      const [first, second] = (await itemsOf(id)) as [ItemRow, ItemRow];
      const res = await accept(to, id, [first.id]);
      expect(res.statusCode).toBe(200);
      expect(res.json().handoff).toMatchObject({ state: "offered" });
      expect((await itemsOf(id)).map((i) => [i.state, holder(i, to)]).sort()).toEqual([
        ["accepted", "recipient"],
        ["pending", "sender"],
      ]);
      expect(await outboxCount("m36.handoff.accepted", id)).toBe(1);
      const last = await accept(to, id, [second.id]);
      expect(last.json().handoff).toMatchObject({
        state: "accepted",
        closed_reason: "all_resolved",
      });
      expect((await itemsOf(id)).every((i) => i.accountable_user_id === to)).toBe(true);
    });

    it("N concurrent accepts of the same items produce one transition, one event and one outbox row", async () => {
      const { to, id } = await offered([nextPatient()]);
      const itemId = await firstItemId(id);
      const results = await Promise.all(Array.from({ length: 6 }, () => accept(to, id, [itemId])));
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      expect((await eventTypes(id)).filter((t) => t === "items_accepted")).toHaveLength(1);
      expect(await outboxCount("m36.handoff.accepted", id)).toBe(1);
      expect((await handoffRow(id))?.state).toBe("accepted");
    });

    it("keeps declined items with the sender, closes the handoff and publishes one unaccepted event", async () => {
      const { from, to, id } = await offered([nextPatient(), nextPatient()]);
      const partial = await call(app, to, "POST", `${BASE}/${id}/decline`, {
        item_ids: [await firstItemId(id)],
      });
      expect(partial.json().handoff.state).toBe("offered");
      expect(await outboxCount("m36.handoff.unaccepted", id)).toBe(0);
      const rest = await call(app, to, "POST", `${BASE}/${id}/decline`);
      expect(rest.json().handoff).toMatchObject({ state: "declined" });
      expect(
        (await itemsOf(id)).every((i) => i.state === "declined" && i.accountable_user_id === from),
      ).toBe(true);
      expect(await outboxCount("m36.handoff.unaccepted", id)).toBe(1);
      const again = await call(app, to, "POST", `${BASE}/${id}/decline`);
      expect(again.statusCode).toBe(200);
      expect(await outboxCount("m36.handoff.unaccepted", id)).toBe(1);
    });

    it("lets only the sender cancel, only the recipient accept, and answers a stranger like a random id", async () => {
      const { from, to, id } = await offered([nextPatient()]);
      const itemId = await firstItemId(id);
      expect((await call(app, to, "POST", `${BASE}/${id}/cancel`)).statusCode).toBe(403);
      expect((await accept(from, id, [itemId])).statusCode).toBe(403);
      const stranger = await call(app, outsider, "GET", `${BASE}/${id}`);
      const random = await call(app, outsider, "GET", `${BASE}/${randomUUID()}`);
      expect(stranger.statusCode).toBe(404);
      expect(stripIds(stranger.body)).toBe(stripIds(random.body));
      const cancelled = await call(app, from, "POST", `${BASE}/${id}/cancel`);
      expect(cancelled.json().handoff).toMatchObject({ state: "cancelled" });
      expect(
        (await itemsOf(id)).every((i) => i.state === "cancelled" && i.accountable_user_id === from),
      ).toBe(true);
      expect(await outboxCount("m36.handoff.unaccepted", id)).toBe(0);
    });
  });

  describe("deadline (accept versus expiry)", () => {
    it("refuses an accept past the deadline before the tick runs, then the tick expires it", async () => {
      const { from, to, id } = await offered([nextPatient()]);
      const itemId = await firstItemId(id);
      await makeDue(id);
      const late = await accept(to, id, [itemId]);
      expect(late.statusCode).toBe(409);
      expect(errorCode(late)).toBe("HANDOFF_STATE_CONFLICT");
      const swept = await binding.expireDue(ORG_A);
      expect(swept.expired).toBeGreaterThanOrEqual(1);
      expect(await handoffRow(id)).toMatchObject({ state: "expired", closed_reason: "deadline" });
      expect((await itemsOf(id)).map((i) => [i.state, i.accountable_user_id])).toEqual([
        ["expired", from],
      ]);
      expect(await outboxCount("m36.handoff.unaccepted", id)).toBe(1);
    });

    it("a repeat offer to the same person settles an open offer past its deadline instead of returning the dead one", async () => {
      const p = nextPatient();
      const { from, to, id } = await offered([p]);
      await makeDue(id);
      const again = await offer(from, to, [anchor(p)]);
      expect(again.statusCode).toBe(201);
      expect(again.json().handoff.id).not.toBe(id);
      expect(await handoffRow(id)).toMatchObject({ state: "expired", closed_reason: "deadline" });
      expect((await itemsOf(id)).map((i) => i.state)).toEqual(["expired"]);
      expect(await outboxCount("m36.handoff.unaccepted", id)).toBe(1);
    });

    it("keeps an already-accepted item with the recipient when the rest expires", async () => {
      const { to, id } = await offered([nextPatient(), nextPatient()]);
      await accept(to, id, [await firstItemId(id)]);
      await makeDue(id);
      await binding.expireDue(ORG_A);
      expect((await itemsOf(id)).map((i) => [i.state, holder(i, to)]).sort()).toEqual([
        ["accepted", "recipient"],
        ["expired", "sender"],
      ]);
      expect((await handoffRow(id))?.state).toBe("expired");
    });

    it("a concurrent accept and tick on a due handoff end in one consistent closed row", async () => {
      const { to, id } = await offered([nextPatient()]);
      const itemId = await firstItemId(id);
      await makeDue(id);
      const [acc] = await Promise.all([accept(to, id, [itemId]), binding.expireDue(ORG_A)]);
      expect(acc.statusCode).toBe(409);
      expect(await handoffRow(id)).toMatchObject({ state: "expired" });
      expect((await itemsOf(id)).map((i) => i.state)).toEqual(["expired"]);
    });

    it("a tick that finds nothing due leaves an accepted handoff untouched", async () => {
      const { to, id } = await offered([nextPatient()]);
      await accept(to, id, [await firstItemId(id)]);
      await binding.expireDue(ORG_A);
      expect((await handoffRow(id))?.state).toBe("accepted");
    });
  });

  describe("task items", () => {
    async function taskFor(assignee: string, channelMembers: string[]) {
      const patient = nextPatient();
      const ch = await mkChannel(kit, "care_team", patient, channelMembers);
      const post = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${ch}/messages`,
        headers: as(other, ORG_A, randomUUID()),
        payload: { bodyDoc: plainDoc("please follow up") } as object,
      });
      expect(post.statusCode).toBe(201);
      const conv = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${ch}/messages/${post.json().messageId}/tasks`,
        headers: as(other, ORG_A),
        payload: { assignee_user_id: assignee } as object,
      });
      expect(conv.statusCode).toBe(201);
      return { patient, taskId: conv.json().task.id as string };
    }
    const assigneeOf = async (taskId: string) =>
      (
        await kit.one<{ assignee_id: string }>(
          "SELECT assignee_id FROM communication_task WHERE id=$1",
          [taskId],
        )
      )[0]?.assignee_id;

    it("reassigns the task to the acceptor in the same transaction, with a handoff reassigned event", async () => {
      const from = await kit.seedUser("tsnd", ORG_A);
      const to = await kit.seedUser("trcv", ORG_A);
      const { patient, taskId } = await taskFor(from, [other, from, to]);
      kit.caseload.set(from, [patient]);
      const res = await offer(from, to, [
        anchor(patient),
        { kind: "task", ref_id: taskId, patient_id: patient },
      ]);
      expect(res.statusCode).toBe(201);
      const id = res.json().handoff.id as string;
      const taskItem = (await itemsOf(id)).find((r) => r.item_kind === "task") as ItemRow;
      const done = await accept(to, id, [taskItem.id]);
      expect(done.statusCode).toBe(200);
      expect(await assigneeOf(taskId)).toBe(to);
      const [ev] = await kit.one<{ actor_user_id: string; reason_code: string }>(
        "SELECT actor_user_id, reason_code FROM communication_task_event WHERE task_id=$1 AND event_type='reassigned'",
        [taskId],
      );
      expect(ev).toEqual({ actor_user_id: to, reason_code: "handoff" });
      expect(await outboxCount("m36.task.reassigned", taskId)).toBe(0);
    });

    it("refuses with 422 and changes nothing when the receiver cannot view the task's channel", async () => {
      const from = await kit.seedUser("tsnd2", ORG_A);
      const to = await kit.seedUser("trcv2", ORG_A);
      const { patient, taskId } = await taskFor(from, [other, from]);
      kit.caseload.set(from, [patient]);
      const res = await offer(from, to, [
        anchor(patient),
        { kind: "task", ref_id: taskId, patient_id: patient },
      ]);
      const id = res.json().handoff.id as string;
      const refused = await accept(
        to,
        id,
        (await itemsOf(id)).map((r) => r.id),
      );
      expect(refused.statusCode).toBe(422);
      expect(errorCode(refused)).toBe("HANDOFF_ITEM_NOT_TRANSFERABLE");
      expect(
        (await itemsOf(id)).every((i) => i.state === "pending" && i.accountable_user_id === from),
      ).toBe(true);
      expect(await assigneeOf(taskId)).toBe(from);
    });
  });

  describe("database backstops", () => {
    it("refuses, even via raw SQL, editing a closed handoff or a resolved item", async () => {
      const { to, id } = await offered([nextPatient()]);
      const itemId = await firstItemId(id);
      await accept(to, id, [itemId]);
      await expect(
        kit.admin.query("UPDATE clinical_handoff SET version = version + 1 WHERE id=$1", [id]),
      ).rejects.toThrow(/clinical_handoff_closed/);
      await expect(
        kit.admin.query("UPDATE clinical_handoff_item SET state='declined' WHERE id=$1", [itemId]),
      ).rejects.toThrow(/clinical_handoff_item_final/);
    });

    it("refuses an accepted item whose accountable user is not the recipient, and any other change of accountability", async () => {
      const { from, to, id } = await offered([nextPatient()]);
      const itemId = await firstItemId(id);
      await expect(
        kit.admin.query(
          "UPDATE clinical_handoff_item SET state='accepted', accountable_user_id=$2, resolved_at=now() WHERE id=$1",
          [itemId, from],
        ),
      ).rejects.toThrow(/clinical_handoff_item_accountability/);
      await expect(
        kit.admin.query(
          "UPDATE clinical_handoff_item SET state='declined', accountable_user_id=$2, resolved_at=now() WHERE id=$1",
          [itemId, to],
        ),
      ).rejects.toThrow(/clinical_handoff_item_accountability/);
      expect((await itemsOf(id))[0]).toMatchObject({ state: "pending", accountable_user_id: from });
    });

    it("refuses, even via raw SQL, inserting an item that is not pending or not owned by the sender", async () => {
      const { from, to, id } = await offered([nextPatient()]);
      const insert = (state: string, owner: string) =>
        kit.admin.query(
          `INSERT INTO clinical_handoff_item (organization_id, handoff_id, patient_id, item_kind, ref_id, state, accountable_user_id)
             SELECT organization_id, handoff_id, patient_id, 'visit', gen_random_uuid(), $2, $3
               FROM clinical_handoff_item WHERE handoff_id=$1 LIMIT 1`,
          [id, state, owner],
        );
      await expect(insert("accepted", from)).rejects.toThrow(/clinical_handoff_item_insert_state/);
      await expect(insert("pending", to)).rejects.toThrow(
        /clinical_handoff_item_insert_accountability/,
      );
      await expect(insert("pending", from)).resolves.toBeDefined();
    });

    it("has a plain (organization_id, handoff_id) index on the items for the cascade lookup", async () => {
      const rows = await kit.one<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename='clinical_handoff_item'
           AND indexdef LIKE '%(organization_id, handoff_id)%' AND indexdef NOT LIKE '%WHERE%'`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("tenancy (as wardenx_app)", () => {
    it("lets org B read, accept, cancel and list nothing of org A over HTTP", async () => {
      const { id } = await offered([nextPatient()]);
      const itemId = await firstItemId(id);
      const asB = (method: "GET" | "POST", url: string, payload?: object) =>
        call(app, orgBUser, method, url, payload, ORG_B);
      expect((await asB("GET", `${BASE}/${id}`)).statusCode).toBe(404);
      expect((await asB("POST", `${BASE}/${id}/accept`, { item_ids: [itemId] })).statusCode).toBe(
        404,
      );
      expect((await asB("POST", `${BASE}/${id}/cancel`)).statusCode).toBe(404);
      expect((await asB("GET", `${BASE}?scope=incoming&state=all`)).json()).toEqual({
        enabled: true,
        handoffs: [],
      });
      expect((await handoffRow(id))?.state).toBe("offered");
    });

    it("sees none of org A under org B's GUC and rejects a cross-org insert", async () => {
      await offered([nextPatient()]);
      await kit.appConn.query("BEGIN");
      try {
        await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_B]);
        for (const table of [
          "clinical_handoff",
          "clinical_handoff_item",
          "clinical_handoff_event",
        ]) {
          const { rows } = await kit.appConn.query(`SELECT count(*)::int AS n FROM ${table}`);
          expect(rows[0].n).toBe(0);
        }
        await expect(
          kit.appConn.query(
            `INSERT INTO clinical_handoff (organization_id, from_user_id, to_user_id, expires_at)
             VALUES ($1,$2,$3, now() + interval '1 hour')`,
            [ORG_A, randomUUID(), randomUUID()],
          ),
        ).rejects.toThrow(/row-level security/);
      } finally {
        await kit.appConn.query("ROLLBACK");
      }
    });
  });

  describe("grants", () => {
    it("gives wardenx_app no DELETE, no UPDATE of identity columns, and keeps events append-only", async () => {
      const { id } = await offered([nextPatient()]);
      const denied = async (sql: string) => {
        await kit.appConn.query("BEGIN");
        try {
          await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
          await expect(kit.appConn.query(sql, [id])).rejects.toThrow(/permission denied/);
        } finally {
          await kit.appConn.query("ROLLBACK");
        }
      };
      await denied("DELETE FROM clinical_handoff WHERE id=$1");
      await denied("DELETE FROM clinical_handoff_item WHERE handoff_id=$1");
      await denied("DELETE FROM clinical_handoff_event WHERE handoff_id=$1");
      await denied("UPDATE clinical_handoff SET from_user_id = to_user_id WHERE id=$1");
      await denied("UPDATE clinical_handoff SET to_user_id = from_user_id WHERE id=$1");
      await denied(
        "UPDATE clinical_handoff_item SET patient_id = gen_random_uuid() WHERE handoff_id=$1",
      );
      await denied(
        "UPDATE clinical_handoff_item SET ref_id = gen_random_uuid() WHERE handoff_id=$1",
      );
      await denied("UPDATE clinical_handoff_event SET reason_code='x' WHERE handoff_id=$1");
    });
  });

  describe("audit", () => {
    it("writes trigger rows and never copies the patient id or the item reference", async () => {
      const { to, id } = await offered([nextPatient(), nextPatient()]);
      await accept(to, id, [await firstItemId(id)]);
      const types = new Set(
        (
          await kit.one<{ event_type: string }>(
            "SELECT event_type FROM audit_event WHERE resource_id=$1 OR resource_kind='clinical_handoff_item'",
            [id],
          )
        ).map((r) => r.event_type),
      );
      expect(types.has("clinical_handoff.insert")).toBe(true);
      expect(types.has("clinical_handoff.update")).toBe(true);
      expect(types.has("clinical_handoff_item.insert")).toBe(true);
      const dump = JSON.stringify(
        await kit.one(
          "SELECT before, after FROM audit_event WHERE resource_kind IN ('clinical_handoff','clinical_handoff_item','clinical_handoff_event')",
        ),
      );
      for (const patient of USED_PATIENTS) expect(dump).not.toContain(patient);
    });

    it("lands one read event PER PATIENT with the handoff id as the resource id, for the participant who opened it", async () => {
      const [p1, p2] = [nextPatient(), nextPatient()];
      const { to, id } = await offered([p1, p2]);
      const reads = () =>
        kit.one<{ patient: string | null }>(
          `SELECT context->>'patientId' AS patient FROM audit_event
            WHERE organization_id=$1 AND event_type='clinical_handoff.viewed' AND resource_id=$2 AND actor_user_id=$3`,
          [ORG_A, id, to],
        );
      expect(await reads()).toHaveLength(0);
      expect((await call(app, to, "GET", `${BASE}/${id}`)).statusCode).toBe(200);
      expect((await reads()).map((r) => r.patient).sort()).toEqual([p1, p2].sort());
    });

    it("lands read events for the PHI-bearing POSTs too: offer, prefill, accept and cancel, one per patient", async () => {
      const [p1, p2] = [nextPatient(), nextPatient()];
      const { from, to, id } = await offered([p1, p2]);
      const reads = (user: string, kind = "clinical_handoff") =>
        kit.one<{ patient: string | null }>(
          `SELECT context->>'patientId' AS patient FROM audit_event
            WHERE organization_id=$1 AND event_type=$4 AND resource_id=$2 AND actor_user_id=$3`,
          [ORG_A, id, user, `${kind}.viewed`],
        );
      // The offer itself disclosed both patients' labels to the sender.
      expect((await reads(from)).map((r) => r.patient).sort()).toEqual([p1, p2].sort());
      // Accepting one item answers the handoff (both patients) to the recipient.
      expect((await accept(to, id, [await firstItemId(id)])).statusCode).toBe(200);
      expect((await reads(to)).map((r) => r.patient).sort()).toEqual([p1, p2].sort());
      // Prefill is a read of open work for the named patients, accounted against each of them.
      const pf = await call(app, from, "POST", `${BASE}/prefill`, { patient_ids: [p1, p2] });
      expect(pf.statusCode).toBe(200);
      const prefillReads = await kit.one<{ patient: string | null }>(
        `SELECT context->>'patientId' AS patient FROM audit_event
          WHERE organization_id=$1 AND event_type='clinical_handoff_prefill.viewed' AND actor_user_id=$2`,
        [ORG_A, from],
      );
      expect(prefillReads.map((r) => r.patient).sort()).toEqual([p1, p2].sort());
      // Cancel (a remaining pending item's sender) answers the handoff too.
      const cancelled = await call(app, from, "POST", `${BASE}/${id}/cancel`);
      expect(cancelled.statusCode).toBe(200);
      expect(await reads(from)).toHaveLength(4); // offer (2 patients) + cancel (2 patients)
    });

    it("records a list read with a count and no patient", async () => {
      const { to } = await offered([nextPatient()]);
      const res = await call(app, to, "GET", `${BASE}?scope=incoming`);
      expect(res.statusCode).toBe(200);
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM audit_event WHERE event_type='clinical_handoff.list_viewed' AND actor_user_id=$1",
          [to],
        ),
      ).toBeGreaterThanOrEqual(1);
    });
  });

  describe("policy", () => {
    const URL = "/api/v1/messaging/template-admin/handoff-policy";

    it("is tighten-only 15..240, needs the manage permission, and DELETE restores the platform default", async () => {
      expect((await call(app, sender, "PUT", URL, { expiry_minutes: 60 })).statusCode).toBe(403);
      for (const bad of [14, 241, 9999, 30.5]) {
        const res = await call(app, admin1, "PUT", URL, { expiry_minutes: bad });
        expect({ bad, s: res.statusCode, c: errorCode(res) }).toEqual({
          bad,
          s: 422,
          c: "HANDOFF_POLICY_INVALID",
        });
      }
      const put = await call(app, admin1, "PUT", URL, { expiry_minutes: 60 });
      expect(put.json()).toEqual({
        expiry_minutes: 60,
        platform_max_minutes: 240,
        customised: true,
      });
      expect((await call(app, sender, "GET", `${BASE}/policy`)).json().expiry_minutes).toBe(60);
      const reset = await call(app, admin1, "DELETE", URL);
      expect(reset.json()).toEqual({
        expiry_minutes: 240,
        platform_max_minutes: 240,
        customised: false,
      });
    });

    it("clamps a hand-edited row longer than the platform ceiling on read", async () => {
      await kit.admin.query(
        "ALTER TABLE tenant_handoff_policy DROP CONSTRAINT tenant_handoff_policy_expiry",
      );
      try {
        await kit.admin.query(
          `INSERT INTO tenant_handoff_policy (organization_id, expiry_minutes, configured_by_user_id)
           VALUES ($1, 9000, $2) ON CONFLICT (organization_id) DO UPDATE SET expiry_minutes = 9000`,
          [ORG_A, admin1],
        );
        expect((await call(app, sender, "GET", `${BASE}/policy`)).json().expiry_minutes).toBe(240);
      } finally {
        await kit.admin.query("TRUNCATE tenant_handoff_policy");
        await kit.admin.query(
          "ALTER TABLE tenant_handoff_policy ADD CONSTRAINT tenant_handoff_policy_expiry CHECK (expiry_minutes BETWEEN 15 AND 240)",
        );
      }
    });
  });

  describe("flag, caseload, prefill and wiring", () => {
    it("is 404 on the write, single, caseload, prefill and policy routes and an empty disabled list while the flag is off", async () => {
      const p = nextPatient();
      const { from, to } = await fresh([p]);
      expect((await offer(from, to, [anchor(p)], offApp)).statusCode).toBe(404);
      const { id } = await offered([nextPatient()]);
      expect((await call(offApp, receiver, "GET", `${BASE}/${id}`)).statusCode).toBe(404);
      expect((await call(offApp, from, "GET", `${BASE}/caseload`)).statusCode).toBe(404);
      expect((await call(offApp, from, "GET", `${BASE}/policy`)).statusCode).toBe(404);
      expect(
        (await call(offApp, from, "POST", `${BASE}/prefill`, { patient_ids: [p] })).statusCode,
      ).toBe(404);
      expect((await call(offApp, receiver, "GET", BASE)).json()).toEqual({
        enabled: false,
        handoffs: [],
      });
    });

    it("answers caseload and a pure-read prefill for the caller's own patients only", async () => {
      const p = nextPatient();
      const { from } = await fresh([p]);
      const caseload = await call(app, from, "GET", `${BASE}/caseload`);
      expect(caseload.json().patients).toEqual([
        { patient_id: p, display_name: "Ann B.", mrn_suffix: "1234" },
      ]);
      const before = await kit.count("SELECT count(*)::int AS n FROM clinical_handoff");
      const ok = await call(app, from, "POST", `${BASE}/prefill`, { patient_ids: [p] });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().patients[0].items).toContainEqual({ kind: "patient", ref_id: p });
      const stranger = await call(app, from, "POST", `${BASE}/prefill`, {
        patient_ids: [nextPatient()],
      });
      expect(stranger.statusCode).toBe(422);
      expect(await kit.count("SELECT count(*)::int AS n FROM clinical_handoff")).toBe(before);
    });

    it("has the composition root build, mount, consume, schedule and reassign (bound is computing)", () => {
      const root = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
      expect(root).toContain("buildHandoffDeps({");
      expect(root).toContain("handoffs: m36Handoffs");
      expect(root).toContain("buildM36HandoffNotificationsConsumer({");
      expect(root).toContain("registerM36HandoffExpiryWorker({");
      expect(root).toContain("scheduleM36HandoffExpiryJobs(");
      expect(root).toContain("combineReassignments([");
      expect(root).toContain("m36Handoffs?.reassignForLeaver");
      const mount = readFileSync(join(__dirname, "../src/modules/36-messaging/index.ts"), "utf8");
      expect(mount).toContain("handoffs: opts.handoffs");
    });
  });
});
