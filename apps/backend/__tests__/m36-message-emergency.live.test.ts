/**
 * M36 ADR-0106 (PROPOSED) - emergency message data model, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Migration 1300 and its guard triggers, with no route in between (the send/ack routes are ADR-0106 A2).
 *
 *   1. DECLARE     only the author of a live message declares it an emergency; the channel is derived and the 15-minute deadline is the database
 *                  clock's, whatever the client sends; one emergency per message.
 *   2. AUDIENCE    written only in the transaction that created the emergency (frozen), never includes the author, never reduced.
 *   3. ACK         only the person themself, once, never withdrawn, nobody else's row; everything else on a row is immutable.
 *   4. IMMUTABLE   the app role cannot update or delete an emergency, nor delete a recipient.
 *   5. TENANCY     org B sees nothing of org A.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:emergency:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the chartwarden_* roles.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LiveKit, bootLiveKit } from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a690001";
const ORG_B = "22222222-2222-4222-8222-22220a690002";
const KEYS = ["messaging.read", "messaging.send"];
const FIFTEEN_MIN_MS = 15 * 60_000;

describe.skipIf(!DB_URL)("M36 ADR-0106 emergency message data model - LIVE Postgres", () => {
  let kit: LiveKit;
  let author: string;
  let alice: string;
  let bob: string;
  let userB: string;
  let channel: string;
  let messageId: string;
  let emergencyId: string;

  const send = async (by: string, body: string): Promise<string> =>
    (await kit.service.sendMessage(ORG_A, { channelId: channel, authorUserId: by, body }))
      .messageId;

  /** Runs `sqlText` as chartwarden_app with the given identity and ALWAYS rolls back. */
  const asUser = async (user: string, sqlText: string, org = ORG_A) => {
    await kit.appConn.query("BEGIN");
    try {
      await kit.appConn.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
        [org, user],
      );
      return await kit.appConn.query(sqlText);
    } finally {
      await kit.appConn.query("ROLLBACK");
    }
  };

  /** One committed transaction: declare + freeze the audience. */
  const declare = async (by: string, forMessage: string, audience: readonly string[]) => {
    await kit.appConn.query("BEGIN");
    try {
      await kit.appConn.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
        [ORG_A, by],
      );
      const inserted = await kit.appConn.query(
        // channel_id and deadline_at are deliberately wrong: the guard must overwrite both.
        `INSERT INTO message_emergency (organization_id, message_id, channel_id, created_by, deadline_at)
         VALUES ($1, $2, $2, $3, now() + interval '99 days') RETURNING id`,
        [ORG_A, forMessage, by],
      );
      const id = inserted.rows[0].id as string;
      for (const user of audience) {
        await kit.appConn.query(
          `INSERT INTO message_emergency_recipient (organization_id, emergency_id, user_id) VALUES ($1, $2, $3)`,
          [ORG_A, id, user],
        );
      }
      await kit.appConn.query("COMMIT");
      return id;
    } catch (error) {
      await kit.appConn.query("ROLLBACK");
      throw error;
    }
  };

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "em1");
    author = await kit.seedUser("author", ORG_A, KEYS);
    alice = await kit.seedUser("alice", ORG_A, KEYS);
    bob = await kit.seedUser("bob", ORG_A, KEYS);
    userB = await kit.seedUser("userb", ORG_B, KEYS);
    channel = (
      await kit.one<{ id: string }>(
        `INSERT INTO channel (organization_id, channel_kind, title, retention_class)
         VALUES ($1,'announcement','Announcements','operational') RETURNING id`,
        [ORG_A],
      )
    )[0]!.id;
    messageId = await send(author, "Patient fall, need help in room 4");
  }, 240_000);

  afterAll(async () => {
    await kit?.close();
  });

  it("declares an emergency whose channel and 15-minute deadline belong to the database, with the audience frozen", async () => {
    emergencyId = await declare(author, messageId, [alice, bob]);
    const row = (
      await kit.one<{ channel_id: string; spread_ms: string }>(
        `SELECT channel_id, (extract(epoch from (deadline_at - created_at)) * 1000)::text AS spread_ms
           FROM message_emergency WHERE id = $1`,
        [emergencyId],
      )
    )[0]!;
    expect(row.channel_id).toBe(channel);
    expect(Number(row.spread_ms)).toBe(FIFTEEN_MIN_MS);
    expect(
      await kit.count(
        `SELECT count(*)::int AS n FROM message_emergency_recipient WHERE emergency_id = $1`,
        [emergencyId],
      ),
    ).toBe(2);
  });

  it("refuses a second emergency for the same message, a non-author, and a forged author", async () => {
    await expect(declare(author, messageId, [alice])).rejects.toThrow(
      /message_emergency_message_unique/,
    );
    const others = await send(alice, "Alice's own message");
    await expect(
      asUser(
        author,
        `INSERT INTO message_emergency (organization_id, message_id, channel_id, created_by)
         VALUES ('${ORG_A}', '${others}', '${channel}', '${author}')`,
      ),
    ).rejects.toThrow(/message_emergency_message/);
    await expect(
      asUser(
        alice,
        `INSERT INTO message_emergency (organization_id, message_id, channel_id, created_by)
         VALUES ('${ORG_A}', '${others}', '${channel}', '${author}')`,
      ),
    ).rejects.toThrow(/message_emergency_actor/);
  });

  it("freezes the audience: not after the fact, never the author, never reduced", async () => {
    await expect(
      asUser(
        author,
        `INSERT INTO message_emergency_recipient (organization_id, emergency_id, user_id)
         VALUES ('${ORG_A}', '${emergencyId}', '${author}')`,
      ),
    ).rejects.toThrow(/message_emergency_recipient_audience/);
    const carol = await kit.seedUser("carol", ORG_A, KEYS);
    await expect(
      asUser(
        author,
        `INSERT INTO message_emergency_recipient (organization_id, emergency_id, user_id)
         VALUES ('${ORG_A}', '${emergencyId}', '${carol}')`,
      ),
    ).rejects.toThrow(/message_emergency_recipient_audience/); // a later transaction cannot add anyone
    await expect(asUser(author, `DELETE FROM message_emergency_recipient`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it("lets only the person themself acknowledge, once, and nothing else on the row change", async () => {
    await expect(
      asUser(
        bob,
        `UPDATE message_emergency_recipient SET acknowledged_at = now() WHERE user_id = '${alice}'`,
      ),
    ).rejects.toThrow(/message_emergency_recipient_self/);
    await expect(
      asUser(
        alice,
        `UPDATE message_emergency_recipient SET user_id = '${bob}' WHERE user_id = '${alice}'`,
      ),
    ).rejects.toThrow(/permission denied/);

    await kit.appConn.query("BEGIN");
    await kit.appConn.query(
      `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
      [ORG_A, alice],
    );
    await kit.appConn.query(
      `UPDATE message_emergency_recipient SET acknowledged_at = now() WHERE user_id = $1`,
      [alice],
    );
    await kit.appConn.query("COMMIT");

    await expect(
      asUser(
        alice,
        `UPDATE message_emergency_recipient SET acknowledged_at = now() WHERE user_id = '${alice}'`,
      ),
    ).rejects.toThrow(/message_emergency_recipient_once/);
    await expect(
      asUser(
        alice,
        `UPDATE message_emergency_recipient SET acknowledged_at = NULL WHERE user_id = '${alice}'`,
      ),
    ).rejects.toThrow(/message_emergency_recipient_once/);
    expect(
      await kit.count(
        `SELECT count(*)::int AS n FROM message_emergency_recipient WHERE emergency_id = $1 AND acknowledged_at IS NOT NULL`,
        [emergencyId],
      ),
    ).toBe(1);
  });

  it("cannot be updated or deleted by the app role", async () => {
    await expect(
      asUser(author, `UPDATE message_emergency SET deadline_at = now() + interval '1 day'`),
    ).rejects.toThrow(/permission denied/);
    await expect(asUser(author, `DELETE FROM message_emergency`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it("is invisible to another tenant", async () => {
    const seen = await asUser(userB, `SELECT id FROM message_emergency`, ORG_B);
    expect(seen.rows).toHaveLength(0);
    const seenRecipients = await asUser(userB, `SELECT id FROM message_emergency_recipient`, ORG_B);
    expect(seenRecipients.rows).toHaveLength(0);
  });
});
