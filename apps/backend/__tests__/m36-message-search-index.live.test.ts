/**
 * M36 WP 2.7b chunk C1 (ADR-0058, Proposed) - the global search index STORAGE, LIVE Postgres as the NOBYPASSRLS
 * `wardenx_app` role (migration 1091). Nothing reads or writes these tables in product code yet; this proves the schema:
 * cross-tenant RLS, no UPDATE grant, the same-transaction removal hook (delete, edit, but NOT a cipher-only re-wrap),
 * cascade on message delete, an audit trail that carries message ids and never a tag, and exactly four token columns.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m36:search-index:live
 * Use a PRIVATE pgvector/pgvector:pg18 container (the suite DROPs the public schema and the app role). For a local PG
 * without pgvector, also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomInt } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteSearchTokens } from "../src/modules/36-messaging/message-search-tokens";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-4111-8111-1111000f0277";
const ORG_B = "22222222-2222-4222-8222-2222000f0277";
const VERSION = "v1";
const TAGS_PER_MESSAGE = 16;

describe.skipIf(!DB_URL)("M36 WP 2.7b C1 search index storage - LIVE Postgres", () => {
  let admin: Client;
  let app: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let userA: string;
  let userB: string;
  let channelA: string;
  let channelB: string;

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

  const seedUser = async (suffix: string, organizationId: string) => {
    const id = (
      await admin.query(`INSERT INTO "user" (email, name) VALUES ($1,$2) RETURNING id`, [
        `wp27b-${suffix}@x.test`,
        `WP27b ${suffix}`,
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [id, organizationId],
    );
    return id;
  };

  const seedChannel = async (org: string, user: string) =>
    (
      await admin.query(
        `INSERT INTO channel (organization_id, channel_kind, dm_participant_key, title, retention_class)
         VALUES ($1,'dm',$2,'DM','care_related') RETURNING id`,
        [org, `${user}:peer`],
      )
    ).rows[0].id as string;

  const seedMessage = async (org: string, channel: string, user: string) =>
    (
      await admin.query(
        `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256, body_kind)
         VALUES ($1,$2,$3,'user',$4,$5,'plain') RETURNING id`,
        [channel, org, user, Buffer.from([1]), "a".repeat(64)],
      )
    ).rows[0].id as string;

  /** Seed one message with a padded-size set of token rows (superuser insert: the audit trigger still fires). */
  async function seedIndexedMessage(org: string, channel: string, user: string): Promise<string> {
    const message = await seedMessage(org, channel, user);
    await admin.query(
      `INSERT INTO message_search_token (organization_id, key_version, channel_id, tag, message_id)
       SELECT $1, $2, $4, (random() * 1048575)::int, $3 FROM generate_series(1, ${TAGS_PER_MESSAGE})`,
      [org, VERSION, message, channel],
    );
    return message;
  }

  const tokenCount = async (message: string) =>
    Number(
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM message_search_token WHERE message_id=$1`,
          [message],
        )
      ).rows[0].n,
    );

  /** Run `fn` on the wardenx_app connection with the tenant GUCs set; always rolled back unless `commit`. */
  async function asApp<T>(
    org: string | null,
    user: string,
    fn: () => Promise<T>,
    commit = false,
  ): Promise<T> {
    await app.query("BEGIN");
    try {
      await app.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
        [org ?? "", user],
      );
      const out = await fn();
      await app.query(commit ? "COMMIT" : "ROLLBACK");
      return out;
    } catch (error) {
      await app.query("ROLLBACK");
      throw error;
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wp27b-a','A','A'),($2,'wp27b-b','B','B')`,
      [ORG_A, ORG_B],
    );
    userA = await seedUser("a", ORG_A);
    userB = await seedUser("b", ORG_B);
    channelA = await seedChannel(ORG_A, userA);
    channelB = await seedChannel(ORG_B, userB);
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    app = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await app.connect();
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    await app?.end();
    await admin?.end();
  });

  describe("shape", () => {
    it("the token table has exactly the five columns (org, version, channel, tag, message) and no surrogate key", async () => {
      const cols = (
        await admin.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema='public' AND table_name='message_search_token' ORDER BY column_name`,
        )
      ).rows.map((r) => r.column_name);
      expect(cols).toEqual(["channel_id", "key_version", "message_id", "organization_id", "tag"]);
      const pk = await admin.query(
        `SELECT 1 FROM pg_constraint WHERE conrelid='message_search_token'::regclass AND contype='p'`,
      );
      expect(pk.rowCount).toBe(0);
    });

    it("tag is range-checked to 0 <= tag < 2^20", async () => {
      const m = await seedMessage(ORG_A, channelA, userA);
      for (const bad of [-1, 1048576]) {
        await expect(
          admin.query(
            `INSERT INTO message_search_token (organization_id,key_version,channel_id,tag,message_id) VALUES ($1,$2,$5,$3,$4)`,
            [ORG_A, VERSION, bad, m, channelA],
          ),
        ).rejects.toThrow(/message_search_token_tag_range/);
      }
      await admin.query(
        `INSERT INTO message_search_token (organization_id,key_version,channel_id,tag,message_id) VALUES ($1,$2,$4,1048575,$3)`,
        [ORG_A, VERSION, m, channelA],
      );
      expect(await tokenCount(m)).toBe(1);
    });

    it("all three tables are RLS-enabled and FORCEd; the setting defaults OFF", async () => {
      const r = await admin.query(
        `SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS frc FROM pg_class
          WHERE relname IN ('message_search_token','message_search_index_state','tenant_messaging_search_setting')`,
      );
      expect(r.rowCount).toBe(3);
      expect(r.rows.every((x) => x.rls && x.frc)).toBe(true);
      await admin.query(
        `INSERT INTO tenant_messaging_search_setting (organization_id) VALUES ($1)`,
        [ORG_A],
      );
      const row = (
        await admin.query(
          `SELECT enabled FROM tenant_messaging_search_setting WHERE organization_id=$1`,
          [ORG_A],
        )
      ).rows[0];
      expect(row.enabled).toBe(false);
      await admin.query(`DELETE FROM tenant_messaging_search_setting WHERE organization_id=$1`, [
        ORG_A,
      ]);
    });
  });

  describe("grants", () => {
    it("wardenx_app has no UPDATE on the token table (and no TRUNCATE)", async () => {
      const m = await seedIndexedMessage(ORG_A, channelA, userA);
      const priv = (
        await admin.query(
          `SELECT has_table_privilege('wardenx_app','message_search_token','UPDATE') AS u,
                  has_table_privilege('wardenx_app','message_search_token','TRUNCATE') AS t,
                  has_table_privilege('wardenx_app','message_search_token','INSERT') AS i,
                  has_table_privilege('wardenx_app','message_search_token','DELETE') AS d`,
        )
      ).rows[0];
      expect(priv).toEqual({ u: false, t: false, i: true, d: true });
      await expect(
        asApp(ORG_A, userA, () =>
          app.query(`UPDATE message_search_token SET tag = 1 WHERE message_id=$1`, [m]),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it("the wardenx_platform carrier has no privilege, table or column level, on the index state or token tables (L2)", async () => {
      // The carrier is created by scripts/db/provision-runtime-roles.ts, not by a migration: make the check non-vacuous here.
      await admin.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wardenx_platform') THEN CREATE ROLE wardenx_platform NOLOGIN; END IF;
      END $$`);
      const rows = (
        await admin.query(
          `SELECT t AS table_name,
                  has_table_privilege('wardenx_platform', t, 'SELECT') AS table_select,
                  has_any_column_privilege('wardenx_platform', t, 'SELECT') AS column_select
             FROM unnest(ARRAY['message_search_index_state','message_search_token']) t`,
        )
      ).rows;
      expect(rows).toEqual([
        { table_name: "message_search_index_state", table_select: false, column_select: false },
        { table_name: "message_search_token", table_select: false, column_select: false },
      ]);
      // and the provisioning script never grants them
      const provision = readFileSync(
        join(__dirname, "../../../scripts/db/provision-runtime-roles.ts"),
        "utf8",
      );
      expect(provision).not.toMatch(/message_search_(token|index_state)/);
    });

    it("wardenx_app cannot DELETE the setting row (switch OFF, never remove)", async () => {
      const priv = (
        await admin.query(
          `SELECT has_table_privilege('wardenx_app','tenant_messaging_search_setting','DELETE') AS d,
                  has_table_privilege('wardenx_app','tenant_messaging_search_setting','UPDATE') AS u`,
        )
      ).rows[0];
      expect(priv).toEqual({ d: false, u: true });
    });
  });

  describe("RLS cross-tenant isolation as wardenx_app", () => {
    it("org B sees none of org A's tokens, cannot delete them, and cannot forge a row into org A", async () => {
      const m = await seedIndexedMessage(ORG_A, channelA, userA);
      const seenByA = await asApp(ORG_A, userA, async () =>
        Number(
          (
            await app.query(
              `SELECT count(*)::int AS n FROM message_search_token WHERE message_id=$1`,
              [m],
            )
          ).rows[0].n,
        ),
      );
      expect(seenByA).toBe(TAGS_PER_MESSAGE);
      const seenByB = await asApp(ORG_B, userB, async () =>
        Number((await app.query(`SELECT count(*)::int AS n FROM message_search_token`)).rows[0].n),
      );
      // org B holds none of org A's rows (it has no indexed message of its own at this point)
      expect(seenByB).toBe(0);
      const deletedByB = await asApp(
        ORG_B,
        userB,
        async () =>
          (await app.query(`DELETE FROM message_search_token WHERE message_id=$1`, [m])).rowCount,
      );
      expect(deletedByB).toBe(0);
      await expect(
        asApp(ORG_B, userB, () =>
          app.query(
            `INSERT INTO message_search_token (organization_id,key_version,channel_id,tag,message_id) VALUES ($1,$2,$4,5,$3)`,
            [ORG_A, VERSION, m, channelA],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      expect(await tokenCount(m)).toBe(TAGS_PER_MESSAGE);
    });

    it("a composite FK refuses org B rows that point at org A's message", async () => {
      const m = await seedMessage(ORG_A, channelA, userA);
      await expect(
        asApp(ORG_B, userB, () =>
          app.query(
            `INSERT INTO message_search_token (organization_id,key_version,channel_id,tag,message_id) VALUES ($1,$2,$4,5,$3)`,
            [ORG_B, VERSION, m, channelA],
          ),
        ),
      ).rejects.toThrow(/message_search_token_message_org_fk/);
    });

    it("an unset or empty org GUC matches nothing instead of throwing", async () => {
      await seedIndexedMessage(ORG_A, channelA, userA);
      const n = await asApp(null, userA, async () =>
        Number((await app.query(`SELECT count(*)::int AS n FROM message_search_token`)).rows[0].n),
      );
      expect(n).toBe(0);
    });

    it("the index-state and setting tables are tenant-isolated too", async () => {
      await admin.query(
        `INSERT INTO message_search_index_state (organization_id, key_version, head_buckets) VALUES ($1,$2,'{7,9}')`,
        [ORG_A, VERSION],
      );
      await admin.query(
        `INSERT INTO tenant_messaging_search_setting (organization_id) VALUES ($1)`,
        [ORG_A],
      );
      const seen = await asApp(ORG_B, userB, async () => ({
        state: (await app.query(`SELECT 1 FROM message_search_index_state`)).rowCount,
        setting: (await app.query(`SELECT 1 FROM tenant_messaging_search_setting`)).rowCount,
      }));
      expect(seen).toEqual({ state: 0, setting: 0 });
      const own = await asApp(ORG_A, userA, async () => ({
        state: (await app.query(`SELECT 1 FROM message_search_index_state`)).rowCount,
        setting: (await app.query(`SELECT 1 FROM tenant_messaging_search_setting`)).rowCount,
      }));
      expect(own).toEqual({ state: 1, setting: 1 });
    });
  });

  describe("removal hook (same transaction as the state change)", () => {
    it("a delete tombstone removes the message's tokens, and only that message's", async () => {
      const gone = await seedIndexedMessage(ORG_A, channelA, userA);
      const kept = await seedIndexedMessage(ORG_A, channelA, userA);
      await asApp(
        ORG_A,
        userA,
        async () => {
          await app.query(`UPDATE message SET status='deleted', deleted_at=now() WHERE id=$1`, [
            gone,
          ]);
          // visible inside the SAME transaction: the hook is not deferred to a worker
          const inTx = (
            await app.query(
              `SELECT count(*)::int AS n FROM message_search_token WHERE message_id=$1`,
              [gone],
            )
          ).rows[0].n;
          expect(inTx).toBe(0);
        },
        true,
      );
      expect(await tokenCount(gone)).toBe(0);
      expect(await tokenCount(kept)).toBe(TAGS_PER_MESSAGE);
    });

    it("a body_sha256 change (an edit) removes the tokens", async () => {
      const m = await seedIndexedMessage(ORG_A, channelA, userA);
      await asApp(
        ORG_A,
        userA,
        () => app.query(`UPDATE message SET body_sha256=$2 WHERE id=$1`, [m, "b".repeat(64)]),
        true,
      );
      expect(await tokenCount(m)).toBe(0);
    });

    it("a cipher-only update (a key-ring re-wrap) leaves the tokens alone", async () => {
      const m = await seedIndexedMessage(ORG_A, channelA, userA);
      await asApp(
        ORG_A,
        userA,
        () =>
          app.query(`UPDATE message SET body_cipher=$2 WHERE id=$1`, [m, Buffer.from([9, 9, 9])]),
        true,
      );
      expect(await tokenCount(m)).toBe(TAGS_PER_MESSAGE);
      // and an unchanged-digest rewrite of the digest itself is not an edit either
      await asApp(
        ORG_A,
        userA,
        () => app.query(`UPDATE message SET body_sha256=body_sha256 WHERE id=$1`, [m]),
        true,
      );
      expect(await tokenCount(m)).toBe(TAGS_PER_MESSAGE);
    });

    it("runs without consulting any tenant flag (the setting row is absent and the hook still deletes)", async () => {
      await admin.query(`DELETE FROM tenant_messaging_search_setting WHERE organization_id=$1`, [
        ORG_A,
      ]);
      const m = await seedIndexedMessage(ORG_A, channelA, userA);
      await asApp(
        ORG_A,
        userA,
        () => app.query(`UPDATE message SET status='deleted', deleted_at=now() WHERE id=$1`, [m]),
        true,
      );
      expect(await tokenCount(m)).toBe(0);
    });

    it("deleteSearchTokens removes one message's rows through the real tenant context, idempotently", async () => {
      const m = await seedIndexedMessage(ORG_A, channelA, userA);
      const other = await seedIndexedMessage(ORG_A, channelA, userA);
      const removed = await withOrgContext(
        handle.db,
        { organizationId: ORG_A, userId: userA },
        (tx) => deleteSearchTokens(tx, ORG_A, m),
      );
      expect(removed).toBe(TAGS_PER_MESSAGE);
      expect(await tokenCount(m)).toBe(0);
      expect(await tokenCount(other)).toBe(TAGS_PER_MESSAGE);
      const again = await withOrgContext(
        handle.db,
        { organizationId: ORG_A, userId: userA },
        (tx) => deleteSearchTokens(tx, ORG_A, m),
      );
      expect(again).toBe(0);
      // another tenant's context cannot remove them
      const cross = await withOrgContext(
        handle.db,
        { organizationId: ORG_B, userId: userB },
        (tx) => deleteSearchTokens(tx, ORG_B, other),
      );
      expect(cross).toBe(0);
      expect(await tokenCount(other)).toBe(TAGS_PER_MESSAGE);
    });

    it("the roles able to UPDATE message are exactly the known set (a new one must be reviewed against the hook)", async () => {
      const r = await admin.query(
        `SELECT rolname FROM pg_roles WHERE rolname LIKE 'wardenx\\_%' AND rolsuper = false
            AND (has_table_privilege(rolname, 'message', 'UPDATE')
              OR has_any_column_privilege(rolname, 'message', 'UPDATE')) ORDER BY rolname`,
      );
      expect(r.rows.map((x) => x.rolname)).toEqual(["wardenx_app", "wardenx_destruction"]);
    });

    it("fires as wardenx_destruction (the erase path rewrites cipher and digest)", async () => {
      const m = await seedIndexedMessage(ORG_A, channelA, userA);
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL ROLE wardenx_destruction");
        await admin.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
        const r = await admin.query(
          `UPDATE message SET body_cipher=$2, body_sha256=$3 WHERE id=$1`,
          [m, Buffer.alloc(0), "0".repeat(64)],
        );
        expect(r.rowCount).toBe(1);
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      expect(await tokenCount(m)).toBe(0);
    });

    it("does not depend on the updater's own token privileges or org GUC (SECURITY DEFINER)", async () => {
      const m = await seedIndexedMessage(ORG_A, channelA, userA);
      await admin.query(`DROP ROLE IF EXISTS wx_c1_msg_updater`);
      await admin.query(`CREATE ROLE wx_c1_msg_updater NOLOGIN`);
      await admin.query(`GRANT USAGE ON SCHEMA public TO wx_c1_msg_updater`);
      await admin.query(`GRANT SELECT, UPDATE ON message TO wx_c1_msg_updater`);
      await admin.query(
        `CREATE POLICY wx_c1_tmp ON message FOR ALL TO wx_c1_msg_updater USING (true) WITH CHECK (true)`,
      );
      try {
        await admin.query("BEGIN");
        await admin.query("SET LOCAL ROLE wx_c1_msg_updater");
        // no app.org_id, no privilege on message_search_token at all
        const r = await admin.query(
          `UPDATE message SET status='deleted', deleted_at=now() WHERE id=$1`,
          [m],
        );
        expect(r.rowCount).toBe(1);
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      } finally {
        await admin.query(`DROP POLICY wx_c1_tmp ON message`);
        await admin.query(`REVOKE ALL ON message FROM wx_c1_msg_updater`);
        await admin.query(`REVOKE USAGE ON SCHEMA public FROM wx_c1_msg_updater`);
        await admin.query(`DROP ROLE wx_c1_msg_updater`);
      }
      expect(await tokenCount(m)).toBe(0);
    });

    it("the trigger WHEN fires on the transition to deleted, not on every update of an already-deleted row", async () => {
      const def = (
        await admin.query(
          `SELECT pg_get_triggerdef(oid) AS d FROM pg_trigger WHERE tgname='trg_message_search_token_purge'`,
        )
      ).rows[0].d as string;
      expect(def).toMatch(/old\.status IS DISTINCT FROM 'deleted'/);
      expect(def).toMatch(/body_sha256 IS DISTINCT FROM old\.body_sha256/);
      expect(def).not.toMatch(/body_cipher/);
    });

    it("deleting the message cascades to its tokens", async () => {
      const m = await seedIndexedMessage(ORG_B, channelB, userB);
      expect(await tokenCount(m)).toBe(TAGS_PER_MESSAGE);
      await admin.query(`DELETE FROM message WHERE id=$1`, [m]);
      expect(await tokenCount(m)).toBe(0);
    });
  });

  describe("audit", () => {
    it("a token insert audits message ids and counts only: one statement, one row, no tag, no key version", async () => {
      const m = await seedMessage(ORG_A, channelA, userA);
      const sentinel = randomInt(900_000, 1_000_000);
      const sentinelVersion = "kvsentinel9";
      await asApp(
        ORG_A,
        userA,
        () =>
          app.query(
            `INSERT INTO message_search_token (organization_id,key_version,channel_id,tag,message_id)
             SELECT $1, $2, $5, $3, $4 FROM generate_series(1, ${TAGS_PER_MESSAGE})`,
            [ORG_A, sentinelVersion, sentinel, m, channelA],
          ),
        true,
      );
      const rows = (
        await admin.query(
          `SELECT * FROM audit_event WHERE resource_kind='message_search_token' AND resource_id=$1`,
          [m],
        )
      ).rows;
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.event_type).toBe("message_search_token.insert");
      expect(row.actor_user_id).toBe(userA);
      expect(row.before).toBeNull();
      expect(row.after).toBeNull();
      expect(row.context).toEqual({
        row_count: TAGS_PER_MESSAGE,
        message_count: 1,
        message_ids: [m],
      });
      // the whole serialised row, and every audit_event row of this org, carries neither value nor a tag/key_version key
      const everything = JSON.stringify(
        (await admin.query(`SELECT * FROM audit_event WHERE organization_id=$1`, [ORG_A])).rows,
      );
      for (const forbidden of [String(sentinel), sentinelVersion, '"tag"', '"key_version"']) {
        expect(JSON.stringify(row)).not.toContain(forbidden);
      }
      // every audit row of the org: the sentinel tag and version never appear (other tables' audit context may name a
      // key_version legitimately, so the key NAME is checked on the token row only)
      expect(everything).not.toContain(String(sentinel));
      expect(everything).not.toContain(sentinelVersion);
    });

    it("a token delete audits ids and counts only; a multi-message statement lists each id", async () => {
      const m1 = await seedIndexedMessage(ORG_A, channelA, userA);
      const m2 = await seedIndexedMessage(ORG_A, channelA, userA);
      await asApp(
        ORG_A,
        userA,
        () =>
          app.query(`DELETE FROM message_search_token WHERE message_id = ANY($1::uuid[])`, [
            [m1, m2],
          ]),
        true,
      );
      const rows = (
        await admin.query(
          `SELECT * FROM audit_event WHERE event_type='message_search_token.delete'
             AND context->'message_ids' @> $1::jsonb`,
          [JSON.stringify([m1, m2])],
        )
      ).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].resource_id).toBeNull();
      expect(rows[0].context.row_count).toBe(TAGS_PER_MESSAGE * 2);
      expect(rows[0].context.message_count).toBe(2);
    });

    it("the audit function never references the tag column", async () => {
      const def = (
        await admin.query(
          `SELECT pg_get_functiondef('audit_phi_write_message_search_token()'::regprocedure) AS d`,
        )
      ).rows[0].d as string;
      expect(def).not.toMatch(/\btag\b/i);
      expect(def).not.toMatch(/key_version/i);
    });

    it("the index-state audit images scrub head_buckets", async () => {
      await admin.query(
        `INSERT INTO message_search_index_state (organization_id, key_version, head_buckets) VALUES ($1,'v9','{123456,654321}')
           ON CONFLICT DO NOTHING`,
        [ORG_B],
      );
      await admin.query(
        `UPDATE message_search_index_state SET status='ready', head_buckets='{111111}' WHERE organization_id=$1 AND key_version='v9'`,
        [ORG_B],
      );
      const rows = (
        await admin.query(
          `SELECT before, after FROM audit_event WHERE resource_kind='message_search_index_state' AND organization_id=$1`,
          [ORG_B],
        )
      ).rows;
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const text = JSON.stringify(rows);
      expect(text).not.toMatch(/123456|654321|111111/);
      expect(text).toContain("<changed>");
    });

    it("the index-state audit images scrub the excluded-name digests and the pending digests too", async () => {
      await admin.query(
        `INSERT INTO message_search_index_state (organization_id, key_version, excluded_name_digests, exclusion_pending)
         VALUES ($1,'v8','{aaaabbbbccccdddd}','{1111222233334444}') ON CONFLICT DO NOTHING`,
        [ORG_B],
      );
      await admin.query(
        `UPDATE message_search_index_state SET status='ready', excluded_name_digests='{eeeeffff00001111}', exclusion_pending='{5555666677778888}'
          WHERE organization_id=$1 AND key_version='v8'`,
        [ORG_B],
      );
      const rows = (
        await admin.query(
          `SELECT before, after FROM audit_event WHERE resource_kind='message_search_index_state' AND organization_id=$1`,
          [ORG_B],
        )
      ).rows;
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(rows)).not.toMatch(
        /aaaabbbbccccdddd|1111222233334444|eeeeffff00001111|5555666677778888/,
      );
    });

    it("the setting audit records actor, old and new image", async () => {
      await admin.query(
        `INSERT INTO tenant_messaging_search_setting (organization_id) VALUES ($1)`,
        [ORG_B],
      );
      await asApp(
        ORG_B,
        userB,
        () =>
          app.query(
            `UPDATE tenant_messaging_search_setting SET enabled=true, changed_by_user_id=$2, changed_at=now() WHERE organization_id=$1`,
            [ORG_B, userB],
          ),
        true,
      );
      const row = (
        await admin.query(
          `SELECT actor_user_id, before, after FROM audit_event
            WHERE resource_kind='tenant_messaging_search_setting' AND organization_id=$1 AND event_type LIKE '%update'`,
          [ORG_B],
        )
      ).rows[0];
      expect(row.actor_user_id).toBe(userB);
      expect(row.before.enabled).toBe(false);
      expect(row.after.enabled).toBe(true);
      expect(row.after.changed_by_user_id).toBe(userB);
    });
  });
});
