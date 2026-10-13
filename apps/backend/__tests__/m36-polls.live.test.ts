/**
 * WP 2.10 - polls (non-clinical, single choice, named votes), LIVE Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 * Acceptance (spec): poll creation in a `care_team` channel is rejected. Proves: care_team / bereavement refusal writes
 * nothing; a poll is a real message (sealed question, receipt fan-out) with sealed option labels; one vote per user,
 * a changed vote is an UPDATE that lands an audit row naming the actor; a closed poll rejects votes; only the author
 * or a manager closes; option-count and text bounds (2..10, plain text, no markup); a retry with the same
 * clientMessageId is a replay (one message, one poll); a removed member can neither vote nor read; another tenant
 * can neither read nor vote nor see rows (service and raw SQL); a vote cannot name another poll's option (composite FK);
 * the app role cannot edit a poll's identity columns or delete a vote.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m36:polls:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 *
 * Membership for the care_team case is stubbed true (`canViewChannel`): the rule under test is the channel KIND, and a
 * real care_team visibility check needs the patient seams. The kind check runs on the real channel row.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/index";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import {
  type MessagePollService,
  createDbPollService,
} from "../src/modules/36-messaging/polls/poll-service-db";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const KEK = randomBytes(32);
const QUESTION = "Which Friday lunch do we order?";

describe.skipIf(!DB_URL)("WP 2.10 - message polls - LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let polls: MessagePollService;
  let alwaysMember: MessagePollService;
  let orgA: string;
  let orgB: string;
  let alice: string; // author, member
  let bob: string; // member
  let carol: string; // org B
  let dave: string; // member, later removed
  let chan: string; // location channel, alice + bob + dave
  let careTeam: string;
  let bereavement: string;

  async function applyMigrations() {
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }
  const seedOrg = async (slug: string) =>
    (
      await admin.query(
        "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,$1,$1) RETURNING id",
        [slug],
      )
    ).rows[0].id as string;
  const seedUser = async (email: string, orgId: string) => {
    const id = (
      await admin.query(`INSERT INTO "user" (email, name) VALUES ($1,$1) RETURNING id`, [email])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [id, orgId],
    );
    return id;
  };
  const seedChannel = async (orgId: string, kind: string, title: string) =>
    (
      await admin.query(
        `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [orgId, kind, randomUUID(), title, kind === "bereavement" ? "bereavement" : "care_related"],
      )
    ).rows[0].id as string;
  const addMember = (orgId: string, channelId: string, userId: string) =>
    admin.query(
      `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
       VALUES ($1,$2,$3,'member','manual')`,
      [orgId, channelId, userId],
    );
  const create = (over: Partial<Parameters<MessagePollService["createPoll"]>[1]> = {}) =>
    polls.createPoll(orgA, {
      userId: alice,
      channelId: chan,
      question: QUESTION,
      options: ["Pizza", "Salad", "Soup"],
      ...over,
    });
  const count = async (table: string, orgId = orgA) =>
    Number(
      (
        await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id=$1`, [
          orgId,
        ])
      ).rows[0].n,
    );
  const auditOf = async (eventType: string) =>
    (
      await admin.query(
        "SELECT before, after, actor_user_id FROM audit_event WHERE event_type=$1 ORDER BY created_at",
        [eventType],
      )
    ).rows;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    await applyMigrations();
    orgA = await seedOrg("wp210a");
    orgB = await seedOrg("wp210b");
    alice = await seedUser("wp210-alice@x.test", orgA);
    bob = await seedUser("wp210-bob@x.test", orgA);
    dave = await seedUser("wp210-dave@x.test", orgA);
    carol = await seedUser("wp210-carol@x.test", orgB);
    chan = await seedChannel(orgA, "location", "Front desk");
    careTeam = await seedChannel(orgA, "care_team", "Care team");
    bereavement = await seedChannel(orgA, "bereavement", "Bereavement");
    for (const user of [alice, bob, dave]) await addMember(orgA, chan, user);
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    const cipher = createMessageBodyCipher({ kek: KEK });
    const routes = createDbMessagingRouteService(handle.db, { kek: KEK });
    polls = createDbPollService({ db: handle.db, canViewChannel: routes.canViewChannel, cipher });
    alwaysMember = createDbPollService({ db: handle.db, canViewChannel: async () => true, cipher });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("refuses a poll in a care_team or bereavement channel (422) and writes nothing", async () => {
    for (const channelId of [careTeam, bereavement]) {
      await expect(
        alwaysMember.createPoll(orgA, {
          userId: alice,
          channelId,
          question: QUESTION,
          options: ["a", "b"],
        }),
      ).rejects.toMatchObject({ code: "POLL_NOT_ALLOWED_IN_PATIENT_CHANNEL", statusCode: 422 });
    }
    expect(await count("message_poll")).toBe(0);
    const msgs = await admin.query("SELECT 1 FROM message WHERE channel_id = ANY($1::uuid[])", [
      [careTeam, bereavement],
    ]);
    expect(msgs.rows).toHaveLength(0);
  });

  it("creates a poll as a real message: sealed question and options, receipts for the other members", async () => {
    const made = await create();
    expect(made.poll.options.map((o) => o.label)).toEqual(["Pizza", "Salad", "Soup"]);
    expect(made.poll).toMatchObject({
      closed: false,
      totalVotes: 0,
      myOptionId: null,
      canClose: true,
    });
    const [row] = (
      await admin.query("SELECT body_cipher, author_user_id FROM message WHERE id=$1", [
        made.messageId,
      ])
    ).rows;
    expect(row.author_user_id).toBe(alice);
    expect(Buffer.from(row.body_cipher).toString("utf8")).not.toContain("Friday");
    const opts = (
      await admin.query("SELECT label_cipher FROM message_poll_option WHERE organization_id=$1", [
        orgA,
      ])
    ).rows;
    expect(opts.length).toBeGreaterThanOrEqual(3);
    for (const o of opts)
      expect(Buffer.from(o.label_cipher).toString("utf8")).not.toMatch(/Pizza|Salad|Soup/);
    const receipts = await admin.query("SELECT user_id FROM message_receipt WHERE message_id=$1", [
      made.messageId,
    ]);
    expect(receipts.rows.map((r) => r.user_id).sort()).toEqual([bob, dave].sort());
    expect((await auditOf("message_poll.insert")).length).toBeGreaterThan(0);
  });

  it("enforces option-count and text bounds with a 422 and writes nothing", async () => {
    const before = await count("message_poll");
    const bad = [
      { options: ["only one"] },
      { options: Array.from({ length: 11 }, (_, i) => `o${i}`) },
      { options: ["a", "A"] },
      { options: ["<script>alert(1)</script>", "b"] },
      { options: ["a", "x".repeat(101)] },
      { question: "   " },
      { question: "q".repeat(301) },
    ];
    for (const over of bad) {
      await expect(create(over)).rejects.toMatchObject({ statusCode: 422 });
    }
    expect(await count("message_poll")).toBe(before);
    const ten = await create({ options: Array.from({ length: 10 }, (_, i) => `choice ${i}`) });
    expect(ten.poll.options).toHaveLength(10);
  });

  it("is idempotent on the client message id: a retry returns the original, one message and one poll", async () => {
    const clientMessageId = randomUUID();
    const first = await create({ clientMessageId });
    const polls0 = await count("message_poll");
    const messages0 = await count("message");
    const retry = await create({ clientMessageId });
    expect(retry.messageId).toBe(first.messageId);
    expect(retry.poll.pollId).toBe(first.poll.pollId);
    expect(await count("message_poll")).toBe(polls0);
    expect(await count("message")).toBe(messages0);
  });

  it("allows one vote per user, changing it updates the same row and audits the actor", async () => {
    const made = await create();
    const [pizza, salad] = made.poll.options.map((o) => o.optionId);
    const target = { userId: bob, channelId: chan, messageId: made.messageId };
    const v1 = await polls.vote(orgA, { ...target, optionId: pizza! });
    expect(v1.poll).toMatchObject({ myOptionId: pizza, totalVotes: 1 });
    await polls.vote(orgA, { ...target, optionId: pizza! }); // same option: no-op
    const v2 = await polls.vote(orgA, { ...target, optionId: salad! });
    expect(v2.poll).toMatchObject({ myOptionId: salad, totalVotes: 1 });
    const rows = await admin.query(
      "SELECT option_id FROM message_poll_vote WHERE poll_id=$1 AND user_id=$2",
      [made.poll.pollId, bob],
    );
    expect(rows.rows).toHaveLength(1);
    const updates = (await auditOf("message_poll_vote.update")).filter(
      (a) => a.after.poll_id === made.poll.pollId,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].actor_user_id).toBe(bob);
    expect(updates[0].before.option_id).toBe(pizza);
    expect(updates[0].after.option_id).toBe(salad);
    await polls.vote(orgA, {
      userId: alice,
      channelId: chan,
      messageId: made.messageId,
      optionId: salad!,
    });
    const detail = await polls.getPoll(orgA, {
      userId: alice,
      channelId: chan,
      messageId: made.messageId,
    });
    expect(detail.voters[salad!]?.map((v) => v.displayName).sort()).toEqual(
      ["wp210-alice@x.test", "wp210-bob@x.test"].sort(),
    );
    expect(detail.myOptionId).toBe(salad);
  });

  it("closes (author or manager only), is idempotent, and a closed poll rejects votes", async () => {
    const made = await create();
    const [opt] = made.poll.options.map((o) => o.optionId);
    const target = { channelId: chan, messageId: made.messageId };
    await expect(
      polls.closePoll(orgA, { ...target, userId: bob, canManage: false }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await polls.vote(orgA, { ...target, userId: bob, optionId: opt! });
    const manager = await polls.closePoll(orgA, { ...target, userId: dave, canManage: true });
    expect(manager.poll.closed).toBe(true);
    const again = await polls.closePoll(orgA, { ...target, userId: alice, canManage: false });
    expect(again.poll.closedAt).toBe(manager.poll.closedAt);
    await expect(
      polls.vote(orgA, { ...target, userId: alice, optionId: opt! }),
    ).rejects.toMatchObject({ code: "POLL_CLOSED", statusCode: 409 });
    await expect(
      polls.vote(orgA, { ...target, userId: bob, optionId: made.poll.options[1]!.optionId }),
    ).rejects.toMatchObject({ code: "POLL_CLOSED" });
    expect((await auditOf("message_poll.update")).length).toBeGreaterThan(0);
  });

  it("refuses an option of another poll (422) even though the id exists in the tenant", async () => {
    const one = await create();
    const two = await create();
    await expect(
      polls.vote(orgA, {
        userId: bob,
        channelId: chan,
        messageId: one.messageId,
        optionId: two.poll.options[0]!.optionId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_POLL_OPTION", statusCode: 422 });
  });

  it("a deleted message's poll is a 404 for every member: no options, no named voters", async () => {
    const made = await create();
    await polls.vote(orgA, {
      userId: bob,
      channelId: chan,
      messageId: made.messageId,
      optionId: made.poll.options[0]!.optionId,
    });
    await admin.query("UPDATE message SET status='deleted' WHERE id=$1", [made.messageId]);
    for (const userId of [alice, bob, dave]) {
      await expect(
        polls.getPoll(orgA, { userId, channelId: chan, messageId: made.messageId }),
      ).rejects.toMatchObject({ statusCode: 404 });
    }
  });

  it("the database refuses a vote inserted or changed on a closed poll, even around the service", async () => {
    const made = await create();
    const [first, second] = made.poll.options.map((o) => o.optionId);
    await polls.vote(orgA, {
      userId: bob,
      channelId: chan,
      messageId: made.messageId,
      optionId: first!,
    });
    await polls.closePoll(orgA, {
      userId: alice,
      channelId: chan,
      messageId: made.messageId,
      canManage: false,
    });
    const asApp = (statement: string) =>
      withOrgContext(handle.db, { organizationId: orgA, userId: dave }, (tx) =>
        tx.execute(sql.raw(statement)),
      );
    await expect(
      asApp(
        `INSERT INTO message_poll_vote (organization_id, poll_id, option_id, user_id)
         VALUES ('${orgA}','${made.poll.pollId}','${first}','${dave}')`,
      ),
    ).rejects.toThrow();
    await expect(
      asApp(
        `UPDATE message_poll_vote SET option_id='${second}', updated_at=now()
         WHERE poll_id='${made.poll.pollId}' AND user_id='${bob}'`,
      ),
    ).rejects.toThrow();
    const stored = await admin.query(
      "SELECT option_id FROM message_poll_vote WHERE poll_id=$1 ORDER BY user_id",
      [made.poll.pollId],
    );
    expect(stored.rows.map((r) => r.option_id)).toEqual([first]);
  });

  it("a removed member can neither read nor vote", async () => {
    const made = await create();
    const target = { userId: dave, channelId: chan, messageId: made.messageId };
    await polls.getPoll(orgA, target); // a member reads
    await admin.query(
      "UPDATE channel_member SET removed_at = now() WHERE channel_id=$1 AND user_id=$2",
      [chan, dave],
    );
    await expect(polls.getPoll(orgA, target)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      polls.vote(orgA, { ...target, optionId: made.poll.options[0]!.optionId }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(polls.closePoll(orgA, { ...target, canManage: true })).rejects.toMatchObject({
      statusCode: 404,
    });
    await admin.query(
      "UPDATE channel_member SET removed_at = NULL WHERE channel_id=$1 AND user_id=$2",
      [chan, dave],
    );
  });

  it("is invisible to another tenant: service calls 404 and raw SQL as org B sees no rows", async () => {
    const made = await create();
    const optionId = made.poll.options[0]!.optionId;
    const asCarol = { userId: carol, channelId: chan, messageId: made.messageId };
    await expect(polls.getPoll(orgB, asCarol)).rejects.toMatchObject({ statusCode: 404 });
    await expect(polls.vote(orgB, { ...asCarol, optionId })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(polls.closePoll(orgB, { ...asCarol, canManage: true })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(alwaysMember.vote(orgB, { ...asCarol, optionId })).rejects.toMatchObject({
      statusCode: 404,
    });
    for (const table of [schema.messagePolls, schema.messagePollOptions, schema.messagePollVotes]) {
      const seen = await withOrgContext(handle.db, { organizationId: orgB, userId: carol }, (tx) =>
        tx.select().from(table),
      );
      expect(seen).toEqual([]);
    }
    // org B cannot insert a poll row for org A either (WITH CHECK)
    await expect(
      withOrgContext(handle.db, { organizationId: orgB, userId: carol }, (tx) =>
        tx.insert(schema.messagePolls).values({
          organizationId: orgA,
          channelId: chan,
          messageId: made.messageId,
          createdByUserId: carol,
        }),
      ),
    ).rejects.toThrow();
  });

  it("the app role cannot rewrite a poll's identity, delete a vote, or change an option", async () => {
    const made = await create();
    await polls.vote(orgA, {
      userId: bob,
      channelId: chan,
      messageId: made.messageId,
      optionId: made.poll.options[0]!.optionId,
    });
    const run = (statement: string) =>
      withOrgContext(handle.db, { organizationId: orgA, userId: alice }, (tx) =>
        tx.execute(sql.raw(statement)),
      );
    const id = made.poll.pollId;
    await expect(
      run(`UPDATE message_poll SET created_by_user_id = '${bob}' WHERE id='${id}'`),
    ).rejects.toThrow();
    await expect(
      run(`UPDATE message_poll SET message_id = gen_random_uuid() WHERE id='${id}'`),
    ).rejects.toThrow();
    await expect(run(`DELETE FROM message_poll_vote WHERE poll_id='${id}'`)).rejects.toThrow();
    await expect(
      run(`UPDATE message_poll_option SET position = 9 WHERE poll_id='${id}'`),
    ).rejects.toThrow();
    await expect(run(`DELETE FROM message_poll WHERE id='${id}'`)).rejects.toThrow();
  });

  it("deleting the message removes its poll, options and votes", async () => {
    const made = await create();
    await polls.vote(orgA, {
      userId: bob,
      channelId: chan,
      messageId: made.messageId,
      optionId: made.poll.options[0]!.optionId,
    });
    await admin.query("DELETE FROM message WHERE id=$1", [made.messageId]);
    for (const table of ["message_poll", "message_poll_option", "message_poll_vote"]) {
      const left = await admin.query(
        `SELECT 1 FROM ${table} WHERE ${table === "message_poll" ? "id" : "poll_id"}=$1`,
        [made.poll.pollId],
      );
      expect(left.rows).toHaveLength(0);
    }
  });
});
