/**
 * M36 ADR-0083 (PROPOSED), slice G1 - the one-thread read grant table (migration 1132), LIVE Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 *   1. TENANCY     another organisation reads nothing and cannot insert a grant for this org's rows.
 *   2. GUARD       insert-only apart from one revoke: no other column moves, a revoke happens once, no DELETE for the app role,
 *                  granted_at / revoked_at are the database clock whatever the caller sends.
 *   3. SHAPE       one LIVE grant per (request, grantee) (a revoked one does not count), reason CHECK, expires_at > granted_at.
 *   4. EXPIRY      the SQL helper judges expiry on now(): live, expired, revoked.
 *   5. AUDIT       the grant and its revoke each land an audit_event.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m36:thread-grant:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the wardenx_* roles.
 */
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findActiveThreadGrant } from "../src/modules/36-messaging/thread-grant/active-grant";
import { type LiveKit, bootLiveKit, mkChannel } from "./_m36-handoff-live-kit";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a830001";
const ORG_B = "22222222-2222-4222-8222-22220a830002";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a83a1";

describe.skipIf(!DB_URL)("M36 ADR-0083 G1 thread access grant - LIVE Postgres", () => {
  let kit: LiveKit;
  let author: string;
  let assignee: string;
  let outsider: string;
  let channel: string;
  let rootMessage: string;
  let requestId: string;

  /** Runs `sql` as the NOBYPASSRLS app role in a rolled-back transaction; returns the error message or null. */
  const asApp = async (sql: string, params: unknown[] = [], org = ORG_A) => {
    await kit.appConn.query("BEGIN");
    try {
      await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [org]);
      await kit.appConn.query("SELECT set_config('app.user_id', $1, true)", [author]);
      const res = await kit.appConn.query(sql, params);
      return { error: null as string | null, rows: res.rows as Record<string, unknown>[] };
    } catch (err) {
      return { error: (err as Error).message, rows: [] as Record<string, unknown>[] };
    } finally {
      await kit.appConn.query("ROLLBACK");
    }
  };
  const INSERT = `INSERT INTO message_thread_access_grant
    (organization_id, channel_id, root_message_id, request_id, grantee_user_id, reason, expires_at)
    VALUES ($1,$2,$3,$4,$5,$6, now() + $7::interval) RETURNING id`;
  const grant = (grantee = assignee, reason = "escalated", ttl = "4 hours", org = ORG_A) =>
    asApp(INSERT, [org, channel, rootMessage, requestId, grantee, reason, ttl], org);
  /** Seeds a live grant as the superuser (committed) so several statements can look at it. */
  const seedGrant = async (grantee: string, ttl = "4 hours") =>
    (
      await kit.one<{ id: string }>(INSERT, [
        ORG_A,
        channel,
        rootMessage,
        requestId,
        grantee,
        "escalated",
        ttl,
      ])
    )[0].id;
  const drop = (...ids: string[]) =>
    kit.one("DELETE FROM message_thread_access_grant WHERE id = ANY($1)", [ids]);

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "adr83");
    author = await kit.seedUser("author", ORG_A);
    assignee = await kit.seedUser("assignee", ORG_A);
    outsider = await kit.seedUser("outsider", ORG_B);
    channel = await mkChannel(kit, "care_team", PATIENT, [author, assignee]);
    rootMessage = (
      await kit.one<{ id: string }>(
        `INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256)
         VALUES ($1,$2,$3,'user', '\\x01'::bytea, $4) RETURNING id`,
        [ORG_A, channel, author, "a".repeat(64)],
      )
    )[0].id;
    requestId = (
      await kit.one<{ id: string }>(
        `INSERT INTO message_acknowledgment_request
         (organization_id, message_id, channel_id, patient_id, ack_class, requester_user_id, assigned_user_id, requested_at, window_started_at, deadline_at)
         VALUES ($1,$2,$3,$4,'important',$5,$6, now(), now(), now() + interval '60 minutes') RETURNING id`,
        [ORG_A, rootMessage, channel, PATIENT, author, assignee],
      )
    )[0].id;
  }, 120_000);

  afterAll(async () => {
    await kit?.close();
  });

  it("the app role can insert a grant, and the database clock sets granted_at whatever the caller sends", async () => {
    const res = await asApp(
      `INSERT INTO message_thread_access_grant
       (organization_id, channel_id, root_message_id, request_id, grantee_user_id, reason, granted_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,'reassigned', now() - interval '2 days', now() + interval '1 hour') RETURNING granted_at, now() AS db_now`,
      [ORG_A, channel, rootMessage, requestId, assignee],
    );
    expect(res.error).toBeNull();
    expect(res.rows[0].granted_at).toEqual(res.rows[0].db_now);
  });

  it("another organisation reads nothing and cannot grant against this organisation's rows", async () => {
    const id = await seedGrant(assignee);
    expect(
      (await asApp("SELECT id FROM message_thread_access_grant", [], ORG_B)).rows,
    ).toHaveLength(0);
    expect(
      (await asApp("SELECT id FROM message_thread_access_grant WHERE id=$1", [id])).rows,
    ).toHaveLength(1);
    expect((await grant(outsider, "escalated", "4 hours", ORG_B)).error).toMatch(
      /row-level security|foreign key/i,
    );
    await drop(id);
  });

  it("refuses a reason outside the closed set and a window that does not end after it starts", async () => {
    expect((await grant(assignee, "because")).error).toMatch(/message_thread_grant_reason/);
    expect((await grant(assignee, "escalated", "-1 minute")).error).toMatch(
      /message_thread_grant_window/,
    );
    expect((await grant(assignee, "escalated", "0 seconds")).error).toMatch(
      /message_thread_grant_window/,
    );
  });

  it("allows one LIVE grant per (request, grantee); a revoked one does not count", async () => {
    const id = await seedGrant(assignee);
    await expect(seedGrant(assignee)).rejects.toThrow(/message_thread_grant_one_live/);
    expect((await grant(assignee)).error).toMatch(/message_thread_grant_one_live/);
    expect((await grant(author)).error).toBeNull();
    await kit.one("UPDATE message_thread_access_grant SET revoked_at = now() WHERE id=$1", [id]);
    expect((await grant(assignee)).error).toBeNull();
    await drop(id);
  });

  it("the only change is revoking: any other column is refused, a revoke happens once, and revoked_at is the database clock", async () => {
    const id = await seedGrant(assignee);
    for (const set of [
      "expires_at = expires_at + interval '1 day'",
      `grantee_user_id = '${author}'`,
      "reason = 'reassigned'",
      "granted_at = now() - interval '1 day'",
      "revoked_at = NULL",
    ]) {
      const res = await asApp(`UPDATE message_thread_access_grant SET ${set} WHERE id=$1`, [id]);
      expect(res.error, set).not.toBeNull();
    }
    const revoke = await asApp(
      "UPDATE message_thread_access_grant SET revoked_at = now() - interval '5 days' WHERE id=$1 RETURNING revoked_at, now() AS db_now",
      [id],
    );
    expect(revoke.error).toBeNull();
    expect(revoke.rows[0].revoked_at).toEqual(revoke.rows[0].db_now);
    // Commit a revoke; a second revoke is then refused (the trigger fires for every role).
    await kit.one("UPDATE message_thread_access_grant SET revoked_at = now() WHERE id=$1", [id]);
    const again = await asApp(
      "UPDATE message_thread_access_grant SET revoked_at = now() WHERE id=$1",
      [id],
    );
    expect(again.error).toMatch(/message_thread_grant_revoked/);
    await drop(id);
  });

  it("the app role cannot delete a grant", async () => {
    const id = await seedGrant(assignee);
    expect(
      (await asApp("DELETE FROM message_thread_access_grant WHERE id=$1", [id])).error,
    ).toMatch(/permission denied/);
    await drop(id);
  });

  it("the SQL helper judges expiry and revocation on the database clock", async () => {
    const q = { orgId: ORG_A, requestId, granteeUserId: assignee };
    const find = () =>
      withOrgContext(kit.handle.db, systemOrgContext(ORG_A), (tx) => findActiveThreadGrant(tx, q));
    const live = await seedGrant(assignee, "1 hour");
    expect((await find())?.id).toBe(live);
    await kit.one("UPDATE message_thread_access_grant SET revoked_at = now() WHERE id=$1", [live]);
    expect(await find()).toBeNull();
    const shortLived = await seedGrant(assignee, "1 second");
    expect((await find())?.id).toBe(shortLived);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await find()).toBeNull();
    await drop(live, shortLived);
  });

  it("lands an audit row for the grant and for its revoke", async () => {
    const id = await seedGrant(assignee);
    await kit.one("UPDATE message_thread_access_grant SET revoked_at = now() WHERE id=$1", [id]);
    const rows = await kit.one<{ event_type: string }>(
      "SELECT event_type FROM audit_event WHERE resource_kind='message_thread_access_grant' AND resource_id=$1 ORDER BY event_type",
      [id],
    );
    expect(rows.map((r) => r.event_type)).toEqual([
      "message_thread_access_grant.insert",
      "message_thread_access_grant.update",
    ]);
    await drop(id);
  });
});
