/**
 * M36 ADR-0082 slice S1 - message_afterhours_triage_link (migration 1132), LIVE Postgres as the NOBYPASSRLS `wardenx_app` role, plus the
 * caller-supplied outbox event id through the REAL catalog-validating publisher and the real `outbox_event` insert.
 *   1. TENANCY    a row is invisible to another tenant and a context with no tenant; a cross-tenant insert is refused by WITH CHECK;
 *                 RLS is ENABLEd and FORCEd.
 *   2. UNIQUE     one row per message (a retry converges) and per source outbox event.
 *   3. GUARD      only triage_call_id/outcome move, once, NULL -> value, for the app role AND a superuser; identity is fixed; the CHECK
 *                 ties a call id to opened/coalesced; the app role has no UPDATE on any other column.
 *   4. EVENT ID   the id the caller chose is the id of the committed outbox_event row, in the same transaction as the link insert; a
 *                 rollback leaves neither.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:afterhours-link:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the wardenx_* roles.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { catalogOutbox } from "./_m36-handoff-live-kit";
import { type LiveKit, STAFF_KEYS, bootLiveKit, mkChannel } from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-1111130a0001";
const ORG_B = "22222222-2222-4222-8222-2222130a0002";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000130a00a1";

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;

describe.skipIf(!DB_URL)("M36 ADR-0082 S1 after-hours triage link - LIVE Postgres", () => {
  let kit: LiveKit;
  let alice: string;
  let bob: string;
  let channel: string;

  async function asApp<T>(org: string | null, fn: (q: Query) => Promise<T>): Promise<T> {
    await kit.appConn.query("BEGIN");
    try {
      await kit.appConn.query("SELECT set_config('app.org_id',$1,true)", [org ?? ""]);
      return await fn((sql, p) => kit.appConn.query(sql, p));
    } finally {
      await kit.appConn.query("ROLLBACK");
    }
  }
  const sqlError = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (e) {
      return e as { code?: string; message: string };
    }
  };
  const newRequest = async () => {
    const messageId = (
      await kit.service.sendMessage(ORG_A, { channelId: channel, authorUserId: alice, body: "x" })
    ).messageId;
    const requestId = (
      await kit.admin.query(
        `INSERT INTO message_acknowledgment_request
           (organization_id, message_id, channel_id, patient_id, ack_class, requester_user_id, assigned_user_id, deadline_at)
         VALUES ($1,$2,$3,$4,'important',$5,$6, now() + interval '60 minutes') RETURNING id`,
        [ORG_A, messageId, channel, PATIENT, alice, bob],
      )
    ).rows[0].id as string;
    return { messageId, requestId };
  };
  const insertLink = (q: Query, org: string, m: { messageId: string; requestId: string }, ev = randomUUID()) =>
    q(
      `INSERT INTO message_afterhours_triage_link (organization_id, message_id, request_id, source_outbox_event_id)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [org, m.messageId, m.requestId, ev],
    );

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "s1ah");
    alice = await kit.seedUser("alice", ORG_A, STAFF_KEYS);
    bob = await kit.seedUser("bob", ORG_A, STAFF_KEYS);
    channel = await mkChannel(kit, "care_team", PATIENT, [alice, bob]);
  }, 120_000);
  afterAll(async () => {
    await kit?.close();
  });

  it("RLS is enabled and forced", async () => {
    const r = await kit.admin.query(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='message_afterhours_triage_link'",
    );
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("isolates tenants and refuses a cross-tenant or tenantless write", async () => {
    const m = await newRequest();
    const evA = randomUUID();
    await kit.admin.query(
      `INSERT INTO message_afterhours_triage_link (organization_id,message_id,request_id,source_outbox_event_id) VALUES ($1,$2,$3,$4)`,
      [ORG_A, m.messageId, m.requestId, evA],
    );
    expect(
      (await asApp(ORG_A, (q) => q("SELECT 1 FROM message_afterhours_triage_link"))).rowCount,
    ).toBe(1);
    expect(
      (await asApp(ORG_B, (q) => q("SELECT 1 FROM message_afterhours_triage_link"))).rowCount,
    ).toBe(0);
    expect(
      (await asApp(null, (q) => q("SELECT 1 FROM message_afterhours_triage_link"))).rowCount,
    ).toBe(0);
    const m2 = await newRequest();
    expect((await asApp(ORG_B, (q) => sqlError(insertLink(q, ORG_A, m2))))?.code).toBe("42501");
    expect((await asApp(null, (q) => sqlError(insertLink(q, ORG_A, m2))))?.code).toBe("42501");
  });

  it("keeps one row per message and per source event", async () => {
    const m = await newRequest();
    const ev = randomUUID();
    await asApp(ORG_A, async (q) => {
      await insertLink(q, ORG_A, m, ev);
      await q("SAVEPOINT s1");
      expect((await sqlError(insertLink(q, ORG_A, m)))?.code).toBe("23505");
      await q("ROLLBACK TO s1");
      const m2 = await newRequest();
      expect((await sqlError(insertLink(q, ORG_A, m2, ev)))?.code).toBe("23505");
    });
  });

  it("lets only triage_call_id and outcome move, once, NULL to a value", async () => {
    const m = await newRequest();
    const call = randomUUID();
    await asApp(ORG_A, async (q) => {
      await insertLink(q, ORG_A, m);
      const upd = (set: string, params: unknown[] = []) =>
        q(`UPDATE message_afterhours_triage_link SET ${set} WHERE message_id = '${m.messageId}'`, params);
      // A call id without an outcome, or with no_coverage, breaks the CHECK; an outcome 'opened' needs the call id.
      for (const set of [
        `triage_call_id = '${call}'`,
        `outcome = 'opened'`,
        `outcome = 'no_coverage', triage_call_id = '${call}'`,
        `outcome = 'bogus'`,
      ]) {
        await q("SAVEPOINT s");
        expect((await sqlError(upd(set)))?.code).toBe("23514");
        await q("ROLLBACK TO s");
      }
      // Other columns are not even grantable to the app role.
      await q("SAVEPOINT s");
      expect((await sqlError(upd(`request_id = '${randomUUID()}'`)))?.code).toBe("42501");
      await q("ROLLBACK TO s");
      expect((await upd(`outcome = 'opened', triage_call_id = '${call}'`)).rowCount).toBe(1);
      // Once: a second write (even the same value) is refused.
      await q("SAVEPOINT s");
      expect((await sqlError(upd(`outcome = 'coalesced'`)))?.code).toBe("23514");
      await q("ROLLBACK TO s");
      const row = (await q("SELECT outcome, triage_call_id FROM message_afterhours_triage_link WHERE message_id = $1", [m.messageId])).rows[0];
      expect(row).toEqual({ outcome: "opened", triage_call_id: call });
    });
  });

  it("refuses the same changes for a superuser (the guard is a trigger), and fixes identity", async () => {
    const m = await newRequest();
    await kit.admin.query(
      `INSERT INTO message_afterhours_triage_link (organization_id,message_id,request_id,source_outbox_event_id) VALUES ($1,$2,$3,$4)`,
      [ORG_A, m.messageId, m.requestId, randomUUID()],
    );
    const where = `WHERE message_id = '${m.messageId}'`;
    expect(
      (await sqlError(kit.admin.query(`UPDATE message_afterhours_triage_link SET source_outbox_event_id = '${randomUUID()}' ${where}`)))?.message,
    ).toMatch(/message_afterhours_triage_link_immutable/);
    await kit.admin.query(`UPDATE message_afterhours_triage_link SET outcome = 'no_coverage' ${where}`);
    expect(
      (await sqlError(kit.admin.query(`UPDATE message_afterhours_triage_link SET outcome = 'no_coverage' ${where}`)))?.message,
    ).toMatch(/message_afterhours_triage_link_final/);
  });

  it("stores the caller-chosen event id as the committed outbox_event id, atomically with the link", async () => {
    const m = await newRequest();
    const eventId = randomUUID();
    const outbox = catalogOutbox();
    const payload = {
      messageId: m.messageId,
      requestId: m.requestId,
      patientId: PATIENT,
      occurredAt: new Date().toISOString(),
    };
    const publish = (tx: unknown, id: string) =>
      outbox.publish(tx, {
        eventName: "m36.afterhours_triage.requested",
        organizationId: ORG_A,
        aggregateKind: "message",
        aggregateId: m.messageId,
        payload,
        eventId: id,
      });
    const run = async (rollback: boolean) => {
      await kit.handle.db.transaction(async (tx) => {
        await tx.execute(`SELECT set_config('app.org_id','${ORG_A}',true)` as never);
        await publish(tx, eventId);
        await tx.execute(
          `INSERT INTO message_afterhours_triage_link (organization_id,message_id,request_id,source_outbox_event_id) VALUES ('${ORG_A}','${m.messageId}','${m.requestId}','${eventId}')` as never,
        );
        if (rollback) throw new Error("rollback");
      });
    };
    await expect(run(true)).rejects.toThrow("rollback");
    expect(await kit.count("SELECT count(*)::int AS n FROM outbox_event WHERE id = $1", [eventId])).toBe(0);
    expect(await kit.count("SELECT count(*)::int AS n FROM message_afterhours_triage_link WHERE message_id = $1", [m.messageId])).toBe(0);
    await run(false);
    expect(await kit.count("SELECT count(*)::int AS n FROM outbox_event WHERE id = $1 AND event_type='m36.afterhours_triage.requested'", [eventId])).toBe(1);
    expect(await kit.count("SELECT count(*)::int AS n FROM message_afterhours_triage_link WHERE source_outbox_event_id = $1", [eventId])).toBe(1);
  });
});
