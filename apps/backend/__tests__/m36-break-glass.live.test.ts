/**
 * M36 ADR-0087 (PROPOSED), WP 5.8 - messaging break-glass tables (migration 1140), LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 * S1 proves the database layer; S2-S4 extend this suite with the service, the routes and the review queue.
 *
 *   1. TENANCY    another organisation reads nothing and cannot grant against this organisation's channel.
 *   2. GRANT      insert-only apart from one revoke; the database clock sets granted_at; bounds (24h, justification 20..280, reason set);
 *                 one open grant per (channel, grantee); no DELETE for the app role.
 *   3. REVIEW     a grant cannot commit without its review; the reviewer is never the grantee; completed once, only after the grant ended;
 *                 a concern needs a note.
 *   4. READ TRAIL a read is recorded only against a live grant held by the reader (live, not expired, not revoked, not someone else's).
 *   5. AUDIT      the grant lands an audit_event that omits the justification.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:break-glass:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the chartwarden_* roles.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LiveKit, bootLiveKit, mkChannel } from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a870001";
const ORG_B = "22222222-2222-4222-8222-22220a870002";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a87a1";
const WHY = "Covering the on-call RN for a deteriorating patient";

type Row = Record<string, unknown>;
type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;

describe.skipIf(!DB_URL)("M36 ADR-0087 break-glass tables - LIVE Postgres", () => {
  let kit: LiveKit;
  let grantee: string;
  let reviewer: string;
  let other: string;
  let outsider: string;
  let channel: string;

  const GRANT_SQL = `INSERT INTO message_break_glass_grant
    (organization_id, channel_id, grantee_user_id, reason_code, justification, expires_at)
    VALUES ($1,$2,$3,$4,$5, now() + $6::interval) RETURNING id`;
  const REVIEW_SQL = "INSERT INTO message_break_glass_review (organization_id, grant_id) VALUES ($1,$2)";

  /** Runs `body` as the app role for `user` in `org`; commits when `commit`, else rolls back. Returns the first error message or null. */
  const appTx = async (
    user: string,
    org: string,
    body: (q: Query) => Promise<unknown>,
    commit = false,
  ): Promise<string | null> => {
    await kit.appConn.query("BEGIN");
    try {
      await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [org]);
      await kit.appConn.query("SELECT set_config('app.user_id', $1, true)", [user]);
      await body(async (sql, p = []) => (await kit.appConn.query(sql, p)).rows as Row[]);
      await kit.appConn.query(commit ? "COMMIT" : "ROLLBACK");
      return null;
    } catch (err) {
      await kit.appConn.query("ROLLBACK").catch(() => undefined);
      return (err as Error).message;
    }
  };

  /** Seeds a grant AND its review in one committed transaction as the superuser. */
  const seed = async (user = grantee, ttl = "4 hours", reason = "patient_safety", text = WHY) => {
    await kit.admin.query("BEGIN");
    try {
      const id = (await kit.admin.query(GRANT_SQL, [ORG_A, channel, user, reason, text, ttl])).rows[0]
        .id as string;
      await kit.admin.query(REVIEW_SQL, [ORG_A, id]);
      await kit.admin.query("COMMIT");
      return id;
    } catch (err) {
      await kit.admin.query("ROLLBACK");
      throw err;
    }
  };
  const revoke = (id: string) =>
    kit.one("UPDATE message_break_glass_grant SET revoked_at = now() WHERE id=$1", [id]);
  const drop = (...ids: string[]) =>
    kit.one("DELETE FROM message_break_glass_grant WHERE id = ANY($1)", [ids]);
  const grantAs = (ttl: string, reason: string, text: string, org = ORG_A) =>
    appTx(grantee, org, async (q) => {
      const g = await q(GRANT_SQL, [org, channel, grantee, reason, text, ttl]);
      await q(REVIEW_SQL, [org, g[0].id]);
    });

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "adr87");
    grantee = await kit.seedUser("grantee", ORG_A);
    reviewer = await kit.seedUser("reviewer", ORG_A);
    other = await kit.seedUser("other", ORG_A);
    outsider = await kit.seedUser("outsider", ORG_B);
    channel = await mkChannel(kit, "care_team", PATIENT, [other]);
  }, 120_000);

  afterAll(async () => {
    await kit?.close();
  });

  it("the app role commits a grant with its review; the database clock sets granted_at and clears revoked_at", async () => {
    let id = "";
    const err = await appTx(
      grantee,
      ORG_A,
      async (q) => {
        const g = await q(
          `INSERT INTO message_break_glass_grant
           (organization_id, channel_id, grantee_user_id, reason_code, justification, granted_at, expires_at, revoked_at)
           VALUES ($1,$2,$3,'patient_safety',$4, now() - interval '2 days', now() + interval '1 hour', now()) RETURNING id`,
          [ORG_A, channel, grantee, WHY],
        );
        id = g[0].id as string;
        await q(REVIEW_SQL, [ORG_A, id]);
      },
      true,
    );
    expect(err).toBeNull();
    const [row] = await kit.one<{ ok: boolean; open: boolean }>(
      "SELECT granted_at > now() - interval '1 minute' AS ok, revoked_at IS NULL AS open FROM message_break_glass_grant WHERE id=$1",
      [id],
    );
    expect(row).toEqual({ ok: true, open: true });
    await drop(id);
  });

  it("a grant cannot commit without its review", async () => {
    const err = await appTx(
      grantee,
      ORG_A,
      (q) => q(GRANT_SQL, [ORG_A, channel, grantee, "patient_safety", WHY, "4 hours"]),
      true,
    );
    expect(err).toMatch(/message_break_glass_grant_unreviewed/);
    expect(
      await kit.one("SELECT 1 FROM message_break_glass_grant WHERE grantee_user_id=$1", [grantee]),
    ).toHaveLength(0);
  });

  it("bounds: 24 hours at most, justification 20..280 after trimming, a closed reason set", async () => {
    expect(await grantAs("24 hours", "other", WHY)).toBeNull();
    expect(await grantAs("25 hours", "other", WHY)).toMatch(/message_break_glass_grant_max_window/);
    expect(await grantAs("4 hours", "other", "x".repeat(19))).toMatch(/message_break_glass_grant_justification/);
    expect(await grantAs("4 hours", "other", `   ${"x".repeat(19)}   `)).toMatch(
      /message_break_glass_grant_justification/,
    );
    expect(await grantAs("4 hours", "other", "x".repeat(20))).toBeNull();
    expect(await grantAs("4 hours", "other", "x".repeat(280))).toBeNull();
    expect(await grantAs("4 hours", "other", "x".repeat(281))).toMatch(
      /message_break_glass_grant_justification/,
    );
    expect(await grantAs("4 hours", "because", WHY)).toMatch(/message_break_glass_grant_reason/);
    expect(await grantAs("0 seconds", "other", WHY)).toMatch(/message_break_glass_grant_window/);
  });

  it("insert-only apart from one revoke; no DELETE for the app role", async () => {
    const id = await seed();
    const denied = (sql: string, commit = false) =>
      appTx(grantee, ORG_A, (q) => q(sql, [id]), commit);
    expect(await denied("UPDATE message_break_glass_grant SET justification = 'edited' WHERE id=$1")).toMatch(
      /permission denied/,
    );
    expect(
      await denied("UPDATE message_break_glass_grant SET expires_at = expires_at + interval '1 hour' WHERE id=$1"),
    ).toMatch(/permission denied/);
    expect(await denied("DELETE FROM message_break_glass_grant WHERE id=$1")).toMatch(/permission denied/);
    expect(
      await denied("UPDATE message_break_glass_grant SET revoked_at = now() - interval '5 days' WHERE id=$1", true),
    ).toBeNull();
    const [row] = await kit.one<{ recent: boolean }>(
      "SELECT revoked_at > now() - interval '1 minute' AS recent FROM message_break_glass_grant WHERE id=$1",
      [id],
    );
    expect(row.recent).toBe(true);
    expect(await denied("UPDATE message_break_glass_grant SET revoked_at = now() WHERE id=$1")).toMatch(
      /message_break_glass_grant_revoked/,
    );
    await drop(id);
  });

  it("one open grant per channel and grantee; a revoked one frees the slot", async () => {
    const first = await seed();
    await expect(seed()).rejects.toThrow(/message_break_glass_grant_one_open/);
    await revoke(first);
    const second = await seed();
    await drop(first, second);
  });

  it("another organisation reads nothing and cannot grant against this organisation's channel", async () => {
    const id = await seed();
    let seen = -1;
    await appTx(outsider, ORG_B, async (q) => {
      seen = (await q("SELECT id FROM message_break_glass_grant")).length;
    });
    expect(seen).toBe(0);
    let own = -1;
    await appTx(grantee, ORG_A, async (q) => {
      own = (await q("SELECT id FROM message_break_glass_grant WHERE id=$1", [id])).length;
    });
    expect(own).toBe(1);
    expect(await grantAs("4 hours", "other", WHY, ORG_B)).toMatch(/row-level security|foreign key|violates/i);
    await drop(id);
  });

  it("review: never the grantee, only after the grant ended, completed once, a concern needs a note", async () => {
    const id = await seed();
    const complete = (who: string, outcome: string, note: string | null, commit = false) =>
      appTx(
        who,
        ORG_A,
        (q) =>
          q(
            "UPDATE message_break_glass_review SET reviewer_user_id=$2, reviewed_at=now(), outcome=$3, note=$4 WHERE grant_id=$1",
            [id, who, outcome, note],
          ),
        commit,
      );
    expect(await complete(reviewer, "reviewed", null)).toMatch(/message_break_glass_review_open/);
    await revoke(id);
    expect(await complete(grantee, "reviewed", null)).toMatch(/message_break_glass_review_self/);
    expect(await complete(reviewer, "concern", null)).toMatch(/message_break_glass_review_concern_note/);
    expect(await complete(reviewer, "fine", null)).toMatch(/message_break_glass_review_outcome/);
    expect(await complete(reviewer, "concern", "x".repeat(1001))).toMatch(
      /message_break_glass_review_note_len/,
    );
    expect(
      await appTx(reviewer, ORG_A, (q) =>
        q("UPDATE message_break_glass_review SET created_at = now() WHERE grant_id=$1", [id]),
      ),
    ).toMatch(/permission denied/);
    expect(await complete(reviewer, "concern", "Read a patient the grantee does not treat", true)).toBeNull();
    const [done] = await kit.one<{ outcome: string; by: string }>(
      "SELECT outcome, reviewer_user_id AS by FROM message_break_glass_review WHERE grant_id=$1",
      [id],
    );
    expect(done).toEqual({ outcome: "concern", by: reviewer });
    expect(await complete(reviewer, "reviewed", null)).toMatch(/message_break_glass_review_done/);
    await drop(id);
  });

  it("an expired grant can be reviewed without a revoke (the database clock decides)", async () => {
    const id = await seed(grantee, "1 second");
    await kit.one("SELECT pg_sleep(1.3)");
    const err = await appTx(reviewer, ORG_A, (q) =>
      q(
        "UPDATE message_break_glass_review SET reviewer_user_id=$2, reviewed_at=now(), outcome='reviewed' WHERE grant_id=$1",
        [id, reviewer],
      ),
    );
    expect(err).toBeNull();
    await drop(id);
  });

  it("a read is recorded only against a live grant held by the reader", async () => {
    const id = await seed();
    const record = (who: string, kind = "messages") =>
      appTx(
        who,
        ORG_A,
        (q) =>
          q(
            "INSERT INTO message_break_glass_read (organization_id, grant_id, read_kind, item_count, read_at) VALUES ($1,$2,$3,25, now() - interval '3 days')",
            [ORG_A, id, kind],
          ),
        true,
      );
    expect(await record(grantee)).toBeNull();
    expect(await record(grantee, "thread")).toBeNull();
    expect(await record(other)).toMatch(/message_break_glass_read_grant/);
    expect(await record(grantee, "export")).toMatch(/message_break_glass_read_kind/);
    const [row] = await kit.one<{ n: string; fresh: boolean }>(
      "SELECT count(*) AS n, bool_and(read_at > now() - interval '1 minute') AS fresh FROM message_break_glass_read WHERE grant_id=$1",
      [id],
    );
    expect(row).toEqual({ n: "2", fresh: true });
    expect(
      await appTx(grantee, ORG_A, (q) =>
        q("UPDATE message_break_glass_read SET item_count=1 WHERE grant_id=$1", [id]),
      ),
    ).toMatch(/permission denied/);
    expect(
      await appTx(grantee, ORG_A, (q) => q("DELETE FROM message_break_glass_read WHERE grant_id=$1", [id])),
    ).toMatch(/permission denied/);
    await revoke(id);
    expect(await record(grantee)).toMatch(/message_break_glass_read_grant/);
    await drop(id);
  });

  it("a read cannot be recorded once the grant has expired", async () => {
    const id = await seed(grantee, "1 second");
    await kit.one("SELECT pg_sleep(1.3)");
    const err = await appTx(grantee, ORG_A, (q) =>
      q("INSERT INTO message_break_glass_read (organization_id, grant_id, read_kind) VALUES ($1,$2,'channel')", [
        ORG_A,
        id,
      ]),
    );
    expect(err).toMatch(/message_break_glass_read_grant/);
    await drop(id);
  });

  it("the grant lands an audit_event that omits the justification", async () => {
    const id = await seed();
    const rows = await kit.one<{ event_type: string; after: Record<string, unknown> }>(
      "SELECT event_type, after FROM audit_event WHERE resource_kind='message_break_glass_grant' AND resource_id=$1",
      [id],
    );
    expect(rows.map((r) => r.event_type)).toContain("message_break_glass_grant.insert");
    for (const r of rows) expect(Object.keys(r.after ?? {})).not.toContain("justification");
    await drop(id);
  });

  it("the permissions are in the catalog", async () => {
    const perms = await kit.one<{ key: string; category: string }>(
      "SELECT key, category::text AS category FROM permission WHERE key LIKE 'messaging.break_glass.%' ORDER BY key",
    );
    expect(perms).toEqual([
      { key: "messaging.break_glass.invoke", category: "compliance" },
      { key: "messaging.break_glass.review", category: "compliance" },
    ]);
  });
});
