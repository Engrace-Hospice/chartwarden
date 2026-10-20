/**
 * M36 WP 5.6 S2 (ADR-0086, PROPOSED) - the message legal-hold overlay and its backstop trigger (migration 1138), LIVE Postgres.
 *
 *   1. OVERLAY     the NOBYPASSRLS `wardenx_app` role can record a held message but cannot UPDATE or DELETE the overlay.
 *   2. TENANCY     another organisation reads nothing and cannot write an overlay row against this organisation's message.
 *   3. BACKSTOP    as `wardenx_destruction`, DELETE and a body_cipher UPDATE of a HELD message fail with 23001; an unheld message in the
 *                  same organisation is untouched by the guard; both succeed once the M4 hold is released (the one existing UPDATE).
 *                  The tenant app role's own body_cipher rewrite (an edit) of a held message is refused the same way.
 *   4. ERASER      the M36 tenant eraser refuses cleanly (DegradedError, nothing destroyed) while a hold is active, and proceeds after release.
 *   4b. ERASER     it also refuses for an active hold with ZERO overlay rows (the overlay can lag the live criteria).
 *   4c. GUARD      an overlay row naming ANOTHER tenant's active hold does not make the message undeletable (org-matched join).
 *   5. PERMISSION  messaging.retention.manage is in the catalog table and granted to the three roles.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m36:message-legal-hold:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the wardenx_* roles.
 */
import { withOrgContext } from "@wardenx/tenancy";
import { DegradedError, messagingHoldLockName } from "@wardenx/types";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyLegalHoldInTx } from "../src/modules/04-audit/messaging-hold-workflow";
import { createDrizzleMessagingEraseStore } from "../src/modules/36-messaging/erasers/messaging-eraser";
import { isMessageHeldNow } from "../src/modules/36-messaging/jobs/retention-hold-sql";
import { type LiveKit, bootLiveKit, mkChannel } from "./_m36-handoff-live-kit";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a860001";
const ORG_B = "22222222-2222-4222-8222-22220a860002";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a86a1";
const HELD_ERRCODE = "23001";

describe.skipIf(!DB_URL)("M36 WP 5.6 S2 message legal hold - LIVE Postgres", () => {
  let kit: LiveKit;
  let author: string;
  let channel: string;
  let holdId: string;

  type Outcome = { error: string | null; code: string | null; rows: Record<string, unknown>[] };
  /** Runs `sql` as `role` in a rolled-back (or committed) transaction on a connection that is not the superuser. */
  const asRole = async (
    role: "app" | "destruction",
    sql: string,
    params: unknown[] = [],
    org = ORG_A,
    commit = false,
  ): Promise<Outcome> => {
    const conn = role === "app" ? kit.appConn : kit.admin;
    await conn.query("BEGIN");
    try {
      if (role === "destruction") await conn.query("SET LOCAL ROLE wardenx_destruction");
      await conn.query("SELECT set_config('app.org_id', $1, true)", [org]);
      await conn.query("SELECT set_config('app.user_id', $1, true)", [author]);
      const res = await conn.query(sql, params);
      await conn.query(commit ? "COMMIT" : "ROLLBACK");
      return { error: null, code: null, rows: res.rows as Record<string, unknown>[] };
    } catch (err) {
      await conn.query("ROLLBACK");
      return {
        error: (err as Error).message,
        code: (err as { code?: string }).code ?? null,
        rows: [],
      };
    }
  };

  const mkMessage = async (): Promise<string> =>
    (
      await kit.one<{ id: string }>(
        `INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256)
         VALUES ($1,$2,$3,'user', '\\x0102'::bytea, $4) RETURNING id`,
        [ORG_A, channel, author, "a".repeat(64)],
      )
    )[0].id;
  const hold = (messageId: string, legalHoldId = holdId) =>
    asRole(
      "app",
      "INSERT INTO legal_hold_message (organization_id, legal_hold_id, message_id) VALUES ($1,$2,$3) RETURNING id",
      [ORG_A, legalHoldId, messageId],
      ORG_A,
      true,
    );
  const setHoldStatus = (status: "active" | "released") =>
    kit.one(
      "UPDATE legal_hold SET status = $2::legal_hold_status, released_at = CASE WHEN $2::text = 'released' THEN now() END WHERE id = $1",
      [holdId, status],
    );
  const DELETE = "DELETE FROM message WHERE id = $1";
  const SHRED = "UPDATE message SET body_cipher = '\\x'::bytea WHERE id = $1";

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "adr86");
    author = await kit.seedUser("author", ORG_A);
    channel = await mkChannel(kit, "care_team", PATIENT, [author]);
    holdId = (
      await kit.one<{ id: string }>(
        `INSERT INTO legal_hold (organization_id, name, criteria, reason, applied_by)
         VALUES ($1, 'wp56-s2', '{"channelIds":[]}'::jsonb, 'litigation hold for the S2 suite', $2) RETURNING id`,
        [ORG_A, author],
      )
    )[0].id;
  }, 120_000);

  afterAll(async () => {
    await kit?.close();
  });

  it("the app role records a held message but cannot update or delete the overlay", async () => {
    const m = await mkMessage();
    const ins = await hold(m);
    expect(ins.error).toBeNull();
    const id = ins.rows[0].id as string;
    expect(
      (await asRole("app", "UPDATE legal_hold_message SET held_at = now() WHERE id=$1", [id]))
        .error,
    ).toMatch(/permission denied/);
    expect((await asRole("app", "DELETE FROM legal_hold_message WHERE id=$1", [id])).error).toMatch(
      /permission denied/,
    );
    // One row per (hold, message).
    expect((await hold(m)).code).toBe("23505");
  });

  it("another organisation reads nothing and cannot write an overlay row against this organisation's message", async () => {
    const m = await mkMessage();
    await hold(m);
    expect((await asRole("app", "SELECT id FROM legal_hold_message", [], ORG_B)).rows).toHaveLength(
      0,
    );
    expect(
      (await asRole("app", "SELECT id FROM legal_hold_message WHERE message_id=$1", [m])).rows,
    ).toHaveLength(1);
    const forged = await asRole(
      "app",
      "INSERT INTO legal_hold_message (organization_id, legal_hold_id, message_id) VALUES ($1,$2,$3)",
      [ORG_B, "00000000-0000-4000-8000-000000000b86", m],
      ORG_B,
    );
    expect(forged.error, "forged").toMatch(/foreign key|row-level security/i);
    expect(
      (await asRole("destruction", "SELECT id FROM legal_hold_message", [], ORG_B)).rows,
    ).toHaveLength(0);
  });

  it("refuses DELETE and a body_cipher UPDATE of a held message with 23001, and lets an unheld one through", async () => {
    await setHoldStatus("active");
    const held = await mkMessage();
    const free = await mkMessage();
    await hold(held);
    const del = await asRole("destruction", DELETE, [held]);
    expect(del.code).toBe(HELD_ERRCODE);
    expect(del.error).toMatch(/active legal hold/);
    expect((await asRole("destruction", SHRED, [held])).code).toBe(HELD_ERRCODE);
    // The tenant's own edit (a body_cipher rewrite by the app role) is refused the same way.
    expect(
      (await asRole("app", "UPDATE message SET body_cipher = '\\x03'::bytea WHERE id=$1", [held]))
        .code,
    ).toBe(HELD_ERRCODE);
    // A column the guard does not watch still changes (soft-delete bookkeeping is not a body rewrite).
    expect(
      (
        await asRole(
          "app",
          "UPDATE message SET status='deleted', deleted_at=now() WHERE id=$1 RETURNING id",
          [held],
        )
      ).error,
    ).toBeNull();
    // The unheld message in the same organisation is untouched by the guard.
    expect((await asRole("destruction", SHRED, [free])).rows).toHaveLength(0);
    expect((await asRole("destruction", `${DELETE} RETURNING id`, [free])).rows).toHaveLength(1);
    // Still there: nothing above committed a change to the held row.
    expect(await kit.count("SELECT count(*)::int AS n FROM message WHERE id=$1", [held])).toBe(1);
  });

  it("succeeds after release, and a re-applied hold refuses again", async () => {
    await setHoldStatus("active");
    const m = await mkMessage();
    await hold(m);
    expect((await asRole("destruction", DELETE, [m])).code).toBe(HELD_ERRCODE);
    await setHoldStatus("released");
    expect((await asRole("destruction", SHRED, [m])).error).toBeNull();
    expect((await asRole("destruction", `${DELETE} RETURNING id`, [m])).rows).toHaveLength(1);
    // The overlay rows stay as history until the message is gone: the cascade removed this one with the message.
    await setHoldStatus("active");
    const again = await mkMessage();
    await hold(again);
    expect((await asRole("destruction", DELETE, [again])).code).toBe(HELD_ERRCODE);
  });

  it("the tenant eraser refuses cleanly while a hold is active, destroys nothing, and proceeds after release", async () => {
    await setHoldStatus("active");
    const m = await mkMessage();
    await hold(m);
    const store = createDrizzleMessagingEraseStore(kit.handle.db);
    const before = await kit.count(
      "SELECT count(*)::int AS n FROM message WHERE organization_id=$1 AND octet_length(body_cipher) > 0",
      [ORG_A],
    );
    await expect(store.destroyTenantDek(ORG_A)).rejects.toBeInstanceOf(DegradedError);
    await expect(store.deleteStructuralRows(ORG_A)).rejects.toBeInstanceOf(DegradedError);
    expect(
      await kit.count(
        "SELECT count(*)::int AS n FROM message WHERE organization_id=$1 AND octet_length(body_cipher) > 0",
        [ORG_A],
      ),
    ).toBe(before);
    await setHoldStatus("released");
    const done = await store.destroyTenantDek(ORG_A);
    expect(done.bodiesRendered).toBe(before);
  });

  it("the tenant eraser also refuses for an active hold with no overlay rows (overlay lag), and proceeds after release", async () => {
    await setHoldStatus("released");
    const bare = (
      await kit.one<{ id: string }>(
        `INSERT INTO legal_hold (organization_id, name, criteria, reason, applied_by)
         VALUES ($1, 'wp56-no-overlay', '{"resourceKinds":["message"],"origin":"messaging_governance"}'::jsonb, 'overlay not yet materialised', $2) RETURNING id`,
        [ORG_A, author],
      )
    )[0].id;
    expect(
      await kit.count("SELECT count(*)::int AS n FROM legal_hold_message WHERE legal_hold_id=$1", [
        bare,
      ]),
    ).toBe(0);
    const store = createDrizzleMessagingEraseStore(kit.handle.db);
    await expect(store.destroyTenantDek(ORG_A)).rejects.toBeInstanceOf(DegradedError);
    await expect(store.deleteStructuralRows(ORG_A)).rejects.toBeInstanceOf(DegradedError);
    await kit.one("UPDATE legal_hold SET status='released', released_at=now() WHERE id=$1", [bare]);
    await expect(store.destroyTenantDek(ORG_A)).resolves.toBeDefined();
  });

  it("an overlay row naming another tenant's active hold does not make the message undeletable", async () => {
    await setHoldStatus("released");
    const authorB = await kit.seedUser("author-b", ORG_B);
    const foreign = (
      await kit.one<{ id: string }>(
        `INSERT INTO legal_hold (organization_id, name, criteria, reason, applied_by)
         VALUES ($1, 'other-tenant', '{"channelIds":[]}'::jsonb, 'another tenant hold', $2) RETURNING id`,
        [ORG_B, authorB],
      )
    )[0].id;
    const m = await mkMessage();
    expect((await hold(m, foreign)).error).toBeNull();
    expect((await asRole("destruction", `${DELETE} RETURNING id`, [m])).rows).toHaveLength(1);
  });

  it("an edit of a message covered by an active hold with NO overlay row is refused 409 MESSAGE_UNDER_LEGAL_HOLD (live predicate, not only the overlay)", async () => {
    await setHoldStatus("released");
    const held = await mkChannel(kit, "care_team", "aaaaaaaa-aaaa-4aaa-8aaa-0000000a86a2", [
      author,
    ]);
    const other = await mkChannel(kit, "care_team", "aaaaaaaa-aaaa-4aaa-8aaa-0000000a86a3", [
      author,
    ]);
    const hold = (
      await kit.one<{ id: string }>(
        `INSERT INTO legal_hold (organization_id, name, criteria, reason, applied_by)
         VALUES ($1, 'wp56-edit-lag', $2::jsonb, 'hold placed before the message exists', $3) RETURNING id`,
        [ORG_A, JSON.stringify({ channelIds: [held] }), author],
      )
    )[0].id;
    // Posted AFTER the hold was applied: no scan has run, so there is no overlay row.
    const posted = await kit.service.sendMessage(ORG_A, {
      channelId: held,
      authorUserId: author,
      body: "before",
    });
    const free = await kit.service.sendMessage(ORG_A, {
      channelId: other,
      authorUserId: author,
      body: "before",
    });
    expect(
      await kit.count("SELECT count(*)::int AS n FROM legal_hold_message WHERE legal_hold_id=$1", [
        hold,
      ]),
    ).toBe(0);
    await expect(
      kit.service.editMessage(ORG_A, {
        userId: author,
        messageId: posted.messageId,
        body: "after",
      }),
    ).rejects.toMatchObject({ code: "MESSAGE_UNDER_LEGAL_HOLD", statusCode: 409 });
    // A message the hold does not cover still edits; and the held one edits once the hold is released.
    await expect(
      kit.service.editMessage(ORG_A, { userId: author, messageId: free.messageId, body: "after" }),
    ).resolves.toBeDefined();
    await kit.one("UPDATE legal_hold SET status='released', released_at=now() WHERE id=$1", [hold]);
    await expect(
      kit.service.editMessage(ORG_A, {
        userId: author,
        messageId: posted.messageId,
        body: "after",
      }),
    ).resolves.toBeDefined();
  });

  const HOLD_LOCK = "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))";
  const stillPending = async (p: Promise<unknown>): Promise<boolean> => {
    let done = false;
    p.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    await new Promise((r) => setTimeout(r, 600));
    return !done;
  };

  it("ERASER RACE (barriered): a hold applied concurrently with the erase makes the erase wait, then refuse; nothing is destroyed through the gap", async () => {
    await setHoldStatus("released");
    const m = await mkMessage();
    const rival = new Client({ connectionString: DB_URL });
    await rival.connect();
    try {
      // The apply is in flight: it holds the hold lock EXCLUSIVELY and its active row is not yet visible to anyone else.
      await rival.query("BEGIN");
      await rival.query(HOLD_LOCK, [messagingHoldLockName(ORG_A)]);
      const racing = (
        await rival.query(
          `INSERT INTO legal_hold (organization_id, name, criteria, reason, applied_by)
           VALUES ($1,'wp56-race','{"channelIds":[]}'::jsonb,'hold racing the erase',$2) RETURNING id`,
          [ORG_A, author],
        )
      ).rows[0].id as string;
      const erase = createDrizzleMessagingEraseStore(kit.handle.db).destroyTenantDek(ORG_A);
      expect(
        await stillPending(erase),
        "the erase must wait for the in-flight apply, not race it",
      ).toBe(true);
      await rival.query("COMMIT");
      await expect(erase).rejects.toBeInstanceOf(DegradedError);
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM message WHERE id=$1 AND octet_length(body_cipher) > 0",
          [m],
        ),
      ).toBe(1);
      await kit.one("UPDATE legal_hold SET status='released', released_at=now() WHERE id=$1", [
        racing,
      ]);
    } finally {
      await rival.end();
    }
  });

  it("APPLY RACE (barriered): applying a hold waits for an in-flight erase transaction (shared hold lock), then commits", async () => {
    await setHoldStatus("released");
    const eraserTx = new Client({ connectionString: DB_URL });
    await eraserTx.connect();
    try {
      await eraserTx.query("BEGIN");
      await eraserTx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [
        messagingHoldLockName(ORG_A),
      ]);
      const applying = withOrgContext(
        kit.handle.db as never,
        { organizationId: ORG_A, userId: author },
        (tx) =>
          applyLegalHoldInTx(
            tx as never,
            {},
            { organizationId: ORG_A, userId: author, correlationId: "wp56-apply-race" },
            {
              organizationId: ORG_A,
              userId: author,
              name: "wp56-apply-race",
              criteria: { channelIds: [channel] },
              reason: "apply must wait for the erase",
              matchedRecordCount: 0,
            },
          ),
      );
      expect(await stillPending(applying), "apply must wait for the in-flight erase").toBe(true);
      await eraserTx.query("COMMIT");
      const row = (await applying) as { id: string };
      await kit.one("UPDATE legal_hold SET status='released', released_at=now() WHERE id=$1", [
        row.id,
      ]);
    } finally {
      await eraserTx.end();
    }
  });

  it("EDIT RACE (barriered): a hold apply waits for an in-flight edit-path hold check (shared hold lock), then commits", async () => {
    await setHoldStatus("released");
    const m = await mkMessage();
    let releaseEdit: () => void = () => {};
    const editMayCommit = new Promise<void>((r) => {
      releaseEdit = r;
    });
    let checkDone: () => void = () => {};
    const checked = new Promise<void>((r) => {
      checkDone = r;
    });
    // The edit tx runs the hold check (taking the shared lock), then stays open until released.
    const editing = withOrgContext(
      kit.handle.db as never,
      { organizationId: ORG_A, userId: author },
      async (tx) => {
        const held = await isMessageHeldNow(tx as never, ORG_A, m);
        checkDone();
        await editMayCommit;
        return held;
      },
    );
    await checked;
    const applying = withOrgContext(
      kit.handle.db as never,
      { organizationId: ORG_A, userId: author },
      (tx) =>
        applyLegalHoldInTx(
          tx as never,
          {},
          { organizationId: ORG_A, userId: author, correlationId: "wp56-edit-race" },
          {
            organizationId: ORG_A,
            userId: author,
            name: "wp56-edit-race",
            criteria: { channelIds: [channel] },
            reason: "apply must wait for the edit",
            matchedRecordCount: 0,
          },
        ),
    );
    try {
      expect(await stillPending(applying), "apply must wait for the in-flight edit").toBe(true);
    } finally {
      releaseEdit();
    }
    expect(await editing).toBe(false);
    const row = (await applying) as { id: string };
    await kit.one("UPDATE legal_hold SET status='released', released_at=now() WHERE id=$1", [
      row.id,
    ]);
  });

  it("registers messaging.retention.manage in the permission table (compliance category)", async () => {
    expect(
      await kit.one(
        "SELECT category, resource, action FROM permission WHERE key='messaging.retention.manage'",
      ),
    ).toEqual([{ category: "compliance", resource: "message_retention", action: "manage" }]);
  });
});
