/**
 * WP 2.5 - server-side drafts, LIVE Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 * Acceptance (spec): a draft is never visible to another user or tenant. Proves: the body is sealed at rest; a colleague
 * in the SAME org (service and raw SQL under their own context, and with no user context) reads nothing; another tenant
 * reads nothing and cannot write into the slot; revision/device conflict; thread drafts are bound to a root in their own
 * channel; audit rows exist for create and delete, carry no body or cipher, and autosave rewrites write none; a root's
 * or channel's deletion and the tenant erase remove drafts; identity columns are not updatable by the app role.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m36:drafts:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient, schema } from "@wardenx/db";
import { type MessageDraftService, eraseTenantMessaging } from "@wardenx/messaging";
import { withOrgContext } from "@wardenx/tenancy";
import { eq } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbDraftService } from "../src/modules/36-messaging/drafts/draft-service-db";
import { createDrizzleMessagingEraseStore } from "../src/modules/36-messaging/erasers/messaging-eraser";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/index";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const KEK = randomBytes(32);
const SECRET = "Mrs Quillfeather asked about the morphine titration";

describe.skipIf(!DB_URL)("WP 2.5 - message drafts - LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let destroyer: { db: DbClient; close: () => Promise<void> };
  let drafts: MessageDraftService;
  let orgA: string;
  let orgB: string;
  let alice: string;
  let bob: string;
  let carol: string; // org B
  let chanA: string;
  let chanA2: string;
  let chanB: string;

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
  const seedChannel = async (orgId: string, title: string) =>
    (
      await admin.query(
        `INSERT INTO channel (organization_id, channel_kind, title, retention_class)
         VALUES ($1,'announcement',$2,'operational') RETURNING id`,
        [orgId, title],
      )
    ).rows[0].id as string;
  const draftRows = async (orgId: string) =>
    (await admin.query("SELECT * FROM message_draft WHERE organization_id=$1", [orgId])).rows;
  const auditOf = async (eventType: string) =>
    (
      await admin.query(
        "SELECT before, after, actor_user_id, resource_id FROM audit_event WHERE event_type=$1 ORDER BY created_at",
        [eventType],
      )
    ).rows;
  const save = (
    userId: string,
    over: Partial<Parameters<MessageDraftService["saveDraft"]>[1]> = {},
  ) =>
    drafts.saveDraft(orgA, {
      userId,
      channelId: chanA,
      body: SECRET,
      deviceId: "dev_1",
      baseRevision: 0,
      ...over,
    });
  const wipe = () => admin.query("DELETE FROM message_draft");
  const sendRoot = (channelId: string, authorUserId: string) =>
    createDbMessagingRouteService(handle.db, { kek: KEK }).sendMessage(orgA, {
      channelId,
      authorUserId,
      body: "root",
      bodyKind: "plain",
    });

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
    orgA = await seedOrg("wp25a");
    orgB = await seedOrg("wp25b");
    alice = await seedUser("wp25-alice@x.test", orgA);
    bob = await seedUser("wp25-bob@x.test", orgA);
    carol = await seedUser("wp25-carol@x.test", orgB);
    chanA = await seedChannel(orgA, "news a");
    chanA2 = await seedChannel(orgA, "news a2");
    chanB = await seedChannel(orgB, "news b");
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wp25_destroyer') THEN
         CREATE ROLE wp25_destroyer LOGIN PASSWORD 'wp25_destroyer_pw' IN ROLE wardenx_destruction; END IF; END $$;`,
    );
    const destroyerUrl = new URL(DB_URL as string);
    destroyerUrl.username = "wp25_destroyer";
    destroyerUrl.password = "wp25_destroyer_pw";
    destroyer = createDbClient({ connectionString: destroyerUrl.toString() });
    drafts = createDbDraftService({ db: handle.db, cipher: createMessageBodyCipher({ kek: KEK }) });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await destroyer?.close();
    if (admin) await admin.end();
  });

  it("round-trips a draft and stores only ciphertext", async () => {
    await wipe();
    const saved = await save(alice, {
      references: [{ kind: "staff", entityId: bob, start: 0, end: 3 }],
    });
    expect(saved?.revision).toBe(1);
    const read = await drafts.getDraft(orgA, { userId: alice, channelId: chanA });
    expect(read?.body).toBe(SECRET);
    expect(read?.references).toEqual([{ kind: "staff", entityId: bob, start: 0, end: 3 }]);
    const [row] = await draftRows(orgA);
    expect(Buffer.from(row.body_cipher).toString("utf8")).not.toContain("morphine");
    expect(Buffer.from(row.body_cipher).byteLength).toBeGreaterThan(29);
  });

  it("is invisible to a colleague in the same org: service, raw SQL as the colleague, and with no user context", async () => {
    await wipe();
    await save(alice);
    expect(await drafts.getDraft(orgA, { userId: bob, channelId: chanA })).toBeNull();
    const asBob = await withOrgContext(handle.db, { organizationId: orgA, userId: bob }, (tx) =>
      tx.select().from(schema.messageDrafts),
    );
    expect(asBob).toEqual([]);
    const noUser = await withOrgContext(handle.db, { organizationId: orgA, userId: "" }, (tx) =>
      tx.select().from(schema.messageDrafts),
    );
    expect(noUser).toEqual([]);
    const asAlice = await withOrgContext(handle.db, { organizationId: orgA, userId: alice }, (tx) =>
      tx.select().from(schema.messageDrafts),
    );
    expect(asAlice).toHaveLength(1);
  });

  it("bob's delete and save never touch alice's draft", async () => {
    await wipe();
    await save(alice);
    await drafts.deleteDraft(orgA, { userId: bob, channelId: chanA });
    await save(bob, { body: "bob text" });
    expect((await drafts.getDraft(orgA, { userId: alice, channelId: chanA }))?.body).toBe(SECRET);
    expect((await drafts.getDraft(orgA, { userId: bob, channelId: chanA }))?.body).toBe("bob text");
  });

  it("is invisible to another tenant, and another tenant cannot write into the slot", async () => {
    await wipe();
    await save(alice);
    // carol's org, and even alice's own id under the wrong org
    expect(await drafts.getDraft(orgB, { userId: carol, channelId: chanA })).toBeNull();
    expect(await drafts.getDraft(orgB, { userId: alice, channelId: chanA })).toBeNull();
    const crossRead = await withOrgContext(
      handle.db,
      { organizationId: orgB, userId: alice },
      (tx) => tx.select().from(schema.messageDrafts),
    );
    expect(crossRead).toEqual([]);
    await expect(
      withOrgContext(handle.db, { organizationId: orgB, userId: alice }, (tx) =>
        tx.insert(schema.messageDrafts).values({
          organizationId: orgA, // not the context org: WITH CHECK refuses
          channelId: chanA,
          userId: alice,
          bodyCipher: Buffer.from("x"),
          deviceId: "d",
        }),
      ),
    ).rejects.toThrow();
    // a draft of carol's in org B is unaffected and invisible to org A
    await drafts.saveDraft(orgB, {
      userId: carol,
      channelId: chanB,
      body: "b",
      deviceId: "d",
      baseRevision: 0,
    });
    expect(await drafts.getDraft(orgA, { userId: carol, channelId: chanB })).toBeNull();
  });

  it("refuses to bind another user's id as the owner (WITH CHECK)", async () => {
    await wipe();
    await expect(
      withOrgContext(handle.db, { organizationId: orgA, userId: bob }, (tx) =>
        tx.insert(schema.messageDrafts).values({
          organizationId: orgA,
          channelId: chanA,
          userId: alice,
          bodyCipher: Buffer.from("x"),
          deviceId: "d",
        }),
      ),
    ).rejects.toThrow();
  });

  it("bumps the revision, lets one device overwrite itself, and conflicts across devices", async () => {
    await wipe();
    const v1 = await save(alice);
    const v2 = await save(alice, { body: "two", baseRevision: v1?.revision ?? 0 });
    expect(v2?.revision).toBe(2);
    // same device, stale base: last writer per device wins
    const v3 = await save(alice, { body: "three", baseRevision: 0 });
    expect(v3?.revision).toBe(3);
    // another device that has not seen revision 3
    await expect(
      save(alice, { deviceId: "dev_2", baseRevision: 1, body: "other" }),
    ).rejects.toMatchObject({
      code: "DRAFT_CONFLICT",
      statusCode: 409,
    });
    expect((await drafts.getDraft(orgA, { userId: alice, channelId: chanA }))?.body).toBe("three");
    // re-based on the server revision, the other device may write
    const v4 = await save(alice, { deviceId: "dev_2", baseRevision: 3, body: "merged" });
    expect(v4).toMatchObject({ revision: 4, deviceId: "dev_2", body: "merged" });
  });

  it("serialises two concurrent first saves from two devices into one draft and one conflict", async () => {
    await wipe();
    const results = await Promise.allSettled([
      save(alice, { deviceId: "dev_a" }),
      save(alice, { deviceId: "dev_b" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await draftRows(orgA)).toHaveLength(1);
  });

  it("treats a blank save as a discard", async () => {
    await wipe();
    await save(alice);
    expect(await save(alice, { body: "   ", baseRevision: 1 })).toBeNull();
    expect(await draftRows(orgA)).toHaveLength(0);
  });

  it("keeps one channel draft and one draft per thread root, and ties a thread draft to a root in its own channel", async () => {
    await wipe();
    const root = await sendRoot(chanA, alice);
    const otherChannelRoot = await sendRoot(chanA2, alice);
    await save(alice);
    await save(alice, { parentMessageId: root.messageId, body: "reply draft" });
    expect(await draftRows(orgA)).toHaveLength(2);
    expect(
      (
        await drafts.getDraft(orgA, {
          userId: alice,
          channelId: chanA,
          parentMessageId: root.messageId,
        })
      )?.body,
    ).toBe("reply draft");
    await expect(
      save(alice, { parentMessageId: otherChannelRoot.messageId }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      save(alice, { parentMessageId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // the composite FK is the backstop even if the service check were bypassed
    await expect(
      admin.query(
        `INSERT INTO message_draft (organization_id, channel_id, user_id, parent_message_id, body_cipher, device_id)
         VALUES ($1,$2,$3,$4,'\\x00','d')`,
        [orgA, chanA, bob, otherChannelRoot.messageId],
      ),
    ).rejects.toThrow(/message_draft_parent_org_channel_fk/);
  });

  it("audits create and delete without the body or the cipher, and does not audit autosave rewrites", async () => {
    await wipe();
    await admin.query("DELETE FROM audit_event WHERE event_type LIKE 'message_draft.%'");
    const v1 = await save(alice);
    await save(alice, { body: `${SECRET} again`, baseRevision: v1?.revision ?? 0 });
    await drafts.deleteDraft(orgA, { userId: alice, channelId: chanA });
    const inserts = await auditOf("message_draft.insert");
    const updates = await auditOf("message_draft.update");
    const deletes = await auditOf("message_draft.delete");
    expect(inserts).toHaveLength(1);
    expect(updates).toHaveLength(0);
    expect(deletes).toHaveLength(1);
    expect(inserts[0].actor_user_id).toBe(alice);
    const everything = JSON.stringify([...inserts, ...deletes]);
    expect(everything).not.toContain("morphine");
    expect(inserts[0].after.body_cipher).toBe("<changed>"); // the scrub placeholder, never the bytes
    expect(deletes[0].before.body_cipher).toBe("<changed>");
  });

  it("does not let the app role rewrite identity columns", async () => {
    await wipe();
    await save(alice);
    await expect(
      withOrgContext(handle.db, { organizationId: orgA, userId: alice }, (tx) =>
        tx
          .update(schema.messageDrafts)
          .set({ userId: bob })
          .where(eq(schema.messageDrafts.userId, alice)),
      ),
    ).rejects.toThrow();
    expect((await draftRows(orgA))[0].user_id).toBe(alice);
  });

  it("removes a thread draft with its root's channel and every draft with the tenant erase", async () => {
    await wipe();
    const orgC = await seedOrg("wp25c");
    const dave = await seedUser("wp25-dave@x.test", orgC);
    const chanC = await seedChannel(orgC, "news c");
    const chanC2 = await seedChannel(orgC, "news c2");
    await drafts.saveDraft(orgC, {
      userId: dave,
      channelId: chanC,
      body: "c",
      deviceId: "d",
      baseRevision: 0,
    });
    await drafts.saveDraft(orgC, {
      userId: dave,
      channelId: chanC2,
      body: "c2",
      deviceId: "d",
      baseRevision: 0,
    });
    await save(alice); // org A must survive org C's erase
    expect(await draftRows(orgC)).toHaveLength(2);

    // WP 2.4 annotations ride the message's composite FK (ON DELETE CASCADE): the tenant erase removes them with it.
    const annotated = await createDbMessagingRouteService(handle.db, { kek: KEK }).sendMessage(
      orgC,
      { channelId: chanC, authorUserId: dave, body: "root", bodyKind: "plain" },
    );
    await admin.query(
      `INSERT INTO message_reaction (organization_id, channel_id, message_id, user_id, emoji) VALUES ($1,$2,$3,$4,'heart')`,
      [orgC, chanC, annotated.messageId, dave],
    );
    await admin.query(
      `INSERT INTO message_pin (organization_id, channel_id, message_id, pinned_by_user_id) VALUES ($1,$2,$3,$4)`,
      [orgC, chanC, annotated.messageId, dave],
    );

    // a channel's removal cascades (composite FK) even through the app-role-invisible rows
    await admin.query("DELETE FROM channel WHERE id=$1", [chanC2]);
    expect(await draftRows(orgC)).toHaveLength(1);

    const store = createDrizzleMessagingEraseStore(destroyer.db, {
      soleTenantUserIds: async () => [],
    });
    await eraseTenantMessaging(orgC, store);
    expect(await draftRows(orgC)).toHaveLength(0);
    for (const table of ["message_reaction", "message_pin"]) {
      const left = await admin.query(`SELECT 1 FROM ${table} WHERE organization_id=$1`, [orgC]);
      expect(left.rows).toHaveLength(0);
    }
    expect(await draftRows(orgA)).toHaveLength(1);
  });
});
