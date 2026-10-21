/**
 * M36 WP 2.7b chunk C2 (ADR-0058, Proposed) - the global search INDEX WRITER, LIVE Postgres as the NOBYPASSRLS
 * `wardenx_app` role (migrations through 1091): lifecycle through the REAL catalog-validating publisher and the REAL outbox
 * dispatcher, FOR SHARE races, padding, reconcile/rebuild, OFF purge, OFF-then-ON, the org-NULL-only platform kill switch,
 * the fail-closed key provider and tenancy. Nothing here enables search anywhere: flags are set per test on a private database.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m36:global-search-writer:live
 * Use a PRIVATE pgvector/pgvector:pg18 container (the suite DROPs the public schema and the app role). For a local PG
 * without pgvector, also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import {
  deriveChannelKey,
  digestExclusion,
  indexTagStrings,
  nameTokenDigest,
  paddedSize,
  tokenizeForSearch,
} from "@chartwarden/messaging";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import {
  type IndexOutcome,
  type IndexWriterDeps,
  createIndexWriter,
} from "../src/modules/36-messaging/global-search/index-writer";
import { buildM36MessageSearchIndexerConsumer } from "../src/modules/36-messaging/global-search/indexer-consumer";
import {
  EXCLUSION_REINDEX_DELAY_MS,
  NAME_ENUMERATION_BUDGET_MS,
  NAME_SYNC_MIN_INTERVAL_MS,
  type PatientNameSource,
  createNameExclusions,
  createNoNameExclusions,
  reindexPendingExclusions,
} from "../src/modules/36-messaging/global-search/name-exclusion";
import {
  GLOBAL_SEARCH_PLATFORM_FLAG_KEY,
  createPlatformSearchFlag,
} from "../src/modules/36-messaging/global-search/platform-flag";
import { createBodyReader } from "../src/modules/36-messaging/global-search/ports";
import { purgeOrgIfRequested } from "../src/modules/36-messaging/global-search/purge";
import {
  type ReconcileDeps,
  reconcileOrg,
} from "../src/modules/36-messaging/global-search/reconcile";
import {
  SearchKeyUnavailableError,
  createLegacyTestSearchKeyProvider,
  createUnavailableSearchKeyProvider,
} from "../src/modules/36-messaging/global-search/search-key-provider";
import { refreshIndexStats } from "../src/modules/36-messaging/global-search/stats";
import { createTenantSearchSettingStore } from "../src/modules/36-messaging/global-search/tenant-setting-store";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import {
  sanitizeRichBodyOrThrow,
  storedBodyFor,
} from "../src/modules/36-messaging/rich-body-codec";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-4111-8111-1111000f0278";
const ORG_B = "22222222-2222-4222-8222-2222000f0278";
const VERSION = "legacy";
/** The sizing rule gives the minimum width to a tiny tenant (security review H2): 150 rows per bucket needs 12 bits at most. */
const TAG_BITS = 12;
const KEK = randomBytes(32);

describe.skipIf(!DB_URL)("M36 WP 2.7b C2 global search index writer - LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let userA: string;
  let userB: string;
  let channelA: string;
  let channelB: string;

  const cipher = createMessageBodyCipher({ kek: KEK });
  const keys = createLegacyTestSearchKeyProvider(KEK);
  const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M36_OUTBOX_EVENTS]));
  const orgs: ActiveOrgEnumerator = {
    listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
  };

  // ── assembly ──────────────────────────────────────────────────────────────────────────────────────
  const writerDeps = (overrides: Partial<IndexWriterDeps> = {}): IndexWriterDeps => ({
    db: handle.db,
    bodies: createBodyReader(cipher),
    keys,
    exclusions: createNoNameExclusions(),
    platformFlag: createPlatformSearchFlag(handle.db),
    ...overrides,
  });
  const reconcileDeps = (overrides: Partial<ReconcileDeps> = {}): ReconcileDeps => {
    const deps = writerDeps();
    return {
      ...deps,
      writer: createIndexWriter(deps),
      settings: createTenantSearchSettingStore(handle.db),
      batchSize: 3,
      ...overrides,
    };
  };
  const dispatcherFor = (writerOverrides: Partial<IndexWriterDeps> = {}) =>
    createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [
        buildM36MessageSearchIndexerConsumer(createIndexWriter(writerDeps(writerOverrides))),
      ],
      eventCatalog: buildBootOutboxCatalog([M36_OUTBOX_EVENTS]),
      options: { log: () => {}, backoffBaseMs: 1 },
    });

  // ── fixtures ──────────────────────────────────────────────────────────────────────────────────────
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
        `wp27b-c2-${suffix}@x.test`,
        `WP27b C2 ${suffix}`,
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

  /** A real encrypted message (plain or rich) exactly as the write core stores it. */
  async function sendMessage(
    org: string,
    text: string,
    opts: { rich?: unknown; channel?: string } = {},
  ): Promise<string> {
    const channel = opts.channel ?? (org === ORG_A ? channelA : channelB);
    const user = org === ORG_A ? userA : userB;
    const stored = opts.rich
      ? storedBodyFor({ body: "", richBody: sanitizeRichBodyOrThrow(opts.rich).richBody })
      : { plaintext: text, bodyKind: "plain" as const };
    const sealed = await cipher.seal(org, stored.plaintext);
    return (
      await admin.query(
        `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256, body_kind)
         VALUES ($1,$2,$3,'user',$4,$5,$6) RETURNING id`,
        [channel, org, user, sealed.cipher, sealed.sha256, stored.bodyKind],
      )
    ).rows[0].id as string;
  }
  async function editBody(org: string, id: string, text: string) {
    const sealed = await cipher.seal(org, text);
    await admin.query(
      `UPDATE message SET body_cipher=$2, body_sha256=$3, status='edited', edited_at=now() WHERE id=$1`,
      [id, sealed.cipher, sealed.sha256],
    );
  }
  const markDeleted = (id: string) =>
    admin.query(
      `UPDATE message SET status='deleted', deleted_at=now(), edited_at=NULL WHERE id=$1`,
      [id],
    );

  async function setTenantFlag(org: string, enabled: boolean) {
    await admin.query(
      `INSERT INTO tenant_messaging_search_setting (organization_id, enabled, changed_at)
       VALUES ($1,$2,now())
       ON CONFLICT (organization_id) DO UPDATE SET enabled=$2, changed_at=now()`,
      [org, enabled],
    );
  }
  async function setPlatformFlag(
    value: boolean | null,
    extra: { killSwitch?: boolean; expired?: boolean } = {},
  ) {
    await admin.query(`DELETE FROM feature_flag WHERE flag_key=$1 AND organization_id IS NULL`, [
      GLOBAL_SEARCH_PLATFORM_FLAG_KEY,
    ]);
    if (value === null) return;
    await admin.query(
      `INSERT INTO feature_flag (organization_id, flag_key, flag_kind, value_type, value, kill_switch_active, expires_at)
       VALUES (NULL,$1,'product','bool',$2::jsonb,$3,$4)`,
      [
        GLOBAL_SEARCH_PLATFORM_FLAG_KEY,
        JSON.stringify(value),
        extra.killSwitch ?? false,
        extra.expired ? new Date(Date.now() - 3600_000) : null,
      ],
    );
  }
  const enableSearch = async (org: string) => {
    await setTenantFlag(org, true);
    await setPlatformFlag(true);
  };

  // ── observation ───────────────────────────────────────────────────────────────────────────────────
  const storedTags = async (message: string): Promise<number[]> =>
    (
      await admin.query(`SELECT tag FROM message_search_token WHERE message_id=$1 ORDER BY tag`, [
        message,
      ])
    ).rows.map((r) => Number(r.tag));
  const rowCount = async (message: string) => (await storedTags(message)).length;
  const totalRows = async (org: string) =>
    Number(
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM message_search_token WHERE organization_id=$1`,
          [org],
        )
      ).rows[0].n,
    );
  /** The independent oracle: HMAC each tag input with the tenant's search key and keep the top T bits. */
  async function realTagsOf(
    org: string,
    text: string,
    channel?: string,
    excluded?: ReturnType<typeof digestExclusion>,
  ): Promise<number[]> {
    const bits = Number(
      (
        await admin.query(
          `SELECT tag_bits FROM message_search_index_state WHERE organization_id=$1`,
          [org],
        )
      ).rows[0]?.tag_bits ?? TAG_BITS,
    );
    const key = deriveChannelKey(
      await keys.tagKey(org, VERSION),
      VERSION,
      bits,
      channel ?? (org === ORG_A ? channelA : channelB),
    );
    // One tag per tag INPUT (no dedupe by value: two inputs may collide at T bits and the writer stores both).
    return indexTagStrings(tokenizeForSearch(text, excluded)).map(
      (input) =>
        createHmac("sha256", key).update(input, "utf8").digest().readUInt32BE(0) >>> (32 - bits),
    );
  }
  const holdsAll = (stored: readonly number[], expected: readonly number[]) =>
    expected.every((tag) => stored.includes(tag));

  async function publishFor(
    org: string,
    eventName: "m36.message.sent" | "m36.message.edited" | "m36.message.deleted",
    message: string,
  ) {
    const channelId = org === ORG_A ? channelA : channelB;
    await withOrgContext(handle.db, { organizationId: org, userId: "" }, (tx) =>
      publisher.publish(
        tx as never,
        {
          eventName,
          organizationId: org,
          aggregateKind: "message",
          aggregateId: message,
          callerModule: "m36",
          payload: {
            organizationId: org,
            channelId,
            messageId: message,
            at: new Date().toISOString(),
          },
        } as never,
      ),
    );
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wp27b-c2-a','A','A'),($2,'wp27b-c2-b','B','B')`,
      [ORG_A, ORG_B],
    );
    userA = await seedUser("a", ORG_A);
    userB = await seedUser("b", ORG_B);
    channelA = await seedChannel(ORG_A, userA);
    channelB = await seedChannel(ORG_B, userB);
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query(`DELETE FROM message_search_token`);
    await admin.query(`DELETE FROM message_search_index_state`);
    await admin.query(`DELETE FROM tenant_messaging_search_setting`);
    await admin.query(`DELETE FROM feature_flag WHERE flag_key=$1`, [
      GLOBAL_SEARCH_PLATFORM_FLAG_KEY,
    ]);
    await admin.query(`DELETE FROM message`);
  });

  // ── lifecycle through the real publisher + relay ─────────────────────────────────────────────────
  describe("lifecycle (real catalog-validating publisher + real dispatcher)", () => {
    it("send -> indexed; edit -> tokens replaced; delete -> removed by the trigger", async () => {
      await enableSearch(ORG_A);
      const dispatcher = dispatcherFor();
      const id = await sendMessage(ORG_A, "morphine given for breakthrough pain");
      await publishFor(ORG_A, "m36.message.sent", id);
      const sent = await dispatcher.tick();
      expect(sent.delivered).toBeGreaterThanOrEqual(1);

      const first = await storedTags(id);
      // 13 real tags (whole word + the sparse prefix lengths 3/5/8/12 of each token, #436) pad to the next bucket, 16.
      expect(first).toHaveLength(16);
      expect(holdsAll(first, await realTagsOf(ORG_A, "morphine given for breakthrough pain"))).toBe(
        true,
      );
      const state = await admin.query(
        `SELECT key_version, tag_bits FROM message_search_index_state WHERE organization_id=$1`,
        [ORG_A],
      );
      expect(state.rows).toEqual([{ key_version: VERSION, tag_bits: TAG_BITS }]);

      await editBody(ORG_A, id, "oxycodone titrated overnight");
      expect(await rowCount(id)).toBe(0); // the 1091 trigger removed the old tokens in the edit's transaction
      await publishFor(ORG_A, "m36.message.edited", id);
      await dispatcher.tick();
      const edited = await storedTags(id);
      expect(holdsAll(edited, await realTagsOf(ORG_A, "oxycodone titrated overnight"))).toBe(true);
      expect(holdsAll(edited, await realTagsOf(ORG_A, "morphine"))).toBe(false); // the old words are gone

      await markDeleted(id);
      expect(await rowCount(id)).toBe(0);
      await publishFor(ORG_A, "m36.message.deleted", id);
      await dispatcher.tick();
      expect(await rowCount(id)).toBe(0);
    });

    it("an edited event with no body change (attachment edit) is idempotent: same real tags, fresh dummies", async () => {
      await enableSearch(ORG_A);
      const writer = createIndexWriter(writerDeps());
      const id = await sendMessage(ORG_A, "morphine");
      await writer.indexMessage(ORG_A, id);
      const before = await storedTags(id);
      await admin.query(`UPDATE message SET status='edited', edited_at=now() WHERE id=$1`, [id]);
      expect(await rowCount(id)).toBe(16); // sha unchanged: the trigger leaves the rows alone

      expect(await writer.indexMessage(ORG_A, id)).toBe("indexed");
      expect(await writer.indexMessage(ORG_A, id)).toBe("indexed");
      const after = await storedTags(id);
      expect(after).toHaveLength(16);
      expect(holdsAll(after, await realTagsOf(ORG_A, "morphine"))).toBe(true);
      expect(after).not.toEqual(before); // dummies drawn fresh on every replace
    });

    it("a rich body indexes its plain-text projection, never the stored JSON", async () => {
      await enableSearch(ORG_A);
      const doc = {
        schemaVersion: 1,
        doc: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "turned patient every two hours" },
                {
                  type: "text",
                  text: " guide",
                  marks: [{ type: "link", href: "https://hidden.example/x" }],
                },
              ],
            },
          ],
        },
      };
      const id = await sendMessage(ORG_A, "", { rich: doc });
      expect(
        (await admin.query(`SELECT body_kind FROM message WHERE id=$1`, [id])).rows[0].body_kind,
      ).toBe("rich");
      await createIndexWriter(writerDeps()).indexMessage(ORG_A, id);
      const stored = await storedTags(id);
      expect(
        holdsAll(stored, await realTagsOf(ORG_A, "turned patient every two hours guide")),
      ).toBe(true);
      // words that exist only in the raw JSON (node type names, schema keys, the link target) are not indexed
      for (const jsonOnly of ["paragraph", "schemaversion", "marks", "hidden", "example"]) {
        expect(holdsAll(stored, await realTagsOf(ORG_A, jsonOnly))).toBe(false);
      }
    });
  });

  // ── padding ───────────────────────────────────────────────────────────────────────────────────────
  describe("padding", () => {
    it("stores N = max(16, 2^ceil(log2 n)) rows and draws fresh dummies on every replace", async () => {
      await enableSearch(ORG_A);
      const writer = createIndexWriter(writerDeps());
      const short = await sendMessage(ORG_A, "morphine"); // n = 7
      const long = await sendMessage(ORG_A, "alpine bravos cobalt delphi eclair fabric"); // n = 30
      const empty = await sendMessage(ORG_A, "5 mg"); // n = 0
      for (const id of [short, long, empty]) await writer.indexMessage(ORG_A, id);
      expect(await rowCount(short)).toBe(paddedSize(7));
      expect(await rowCount(long)).toBe(32);
      expect(await rowCount(empty)).toBe(16);

      const firstDummies = (await storedTags(empty)).join();
      await writer.indexMessage(ORG_A, empty);
      expect((await storedTags(empty)).join()).not.toBe(firstDummies);
    });
  });

  // ── FOR SHARE races ───────────────────────────────────────────────────────────────────────────────
  describe("concurrent edit/delete vs the indexer (FOR SHARE)", () => {
    const appClient = async () => {
      const c = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await c.connect();
      return c;
    };
    const asOrg = async (c: Client, org: string) => {
      await c.query("BEGIN");
      await c.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
        [org, userA],
      );
    };

    it("a delete that holds the row first wins: the indexer waits, then removes and inserts nothing", async () => {
      await enableSearch(ORG_A);
      const id = await sendMessage(ORG_A, "morphine given");
      const other = await appClient();
      try {
        await asOrg(other, ORG_A);
        await other.query(
          `UPDATE message SET status='deleted', deleted_at=now(), edited_at=NULL WHERE id=$1`,
          [id],
        );
        let settled = false;
        const indexing = createIndexWriter(writerDeps())
          .indexMessage(ORG_A, id)
          .finally(() => {
            settled = true;
          });
        await sleep(400);
        expect(settled).toBe(false); // blocked on the writer's row lock
        await other.query("COMMIT");
        expect(await indexing).toBe("removed");
        expect(await rowCount(id)).toBe(0);
      } finally {
        await other.end();
      }
    });

    it("an edit that arrives mid-index waits for the indexer, whose stale rows its trigger then deletes", async () => {
      await enableSearch(ORG_A);
      const id = await sendMessage(ORG_A, "morphine given");
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: () => void = () => {};
      const reachedBody = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const real = createBodyReader(cipher);
      const gated = createIndexWriter(
        writerDeps({
          bodies: {
            async read(org, body) {
              entered(); // the message row is FOR SHARE locked from here until the transaction ends
              await gate;
              return real.read(org, body);
            },
          },
        }),
      );
      const indexing = gated.indexMessage(ORG_A, id);
      await reachedBody;

      const editor = await appClient();
      try {
        await asOrg(editor, ORG_A);
        const sealed = await cipher.seal(ORG_A, "oxycodone given");
        let editSettled = false;
        const editing = editor
          .query(
            `UPDATE message SET body_cipher=$2, body_sha256=$3, status='edited', edited_at=now() WHERE id=$1`,
            [id, sealed.cipher, sealed.sha256],
          )
          .finally(() => {
            editSettled = true;
          });
        await sleep(400);
        expect(editSettled).toBe(false); // the editor waits behind the indexer's FOR SHARE
        release();
        expect(await indexing).toBe("indexed"); // tokens for the OLD body were committed...
        await editing;
        await editor.query("COMMIT");
        expect(await rowCount(id)).toBe(0); // ...and the edit's trigger removed them: no stale rows

        expect(await createIndexWriter(writerDeps()).indexMessage(ORG_A, id)).toBe("indexed");
        const fresh = await storedTags(id);
        expect(holdsAll(fresh, await realTagsOf(ORG_A, "oxycodone given"))).toBe(true);
        expect(holdsAll(fresh, await realTagsOf(ORG_A, "morphine"))).toBe(false);
      } finally {
        await editor.end();
      }
    });
  });

  // ── flags ─────────────────────────────────────────────────────────────────────────────────────────
  describe("flags and the platform kill switch", () => {
    const attempt = async () => {
      const id = await sendMessage(ORG_A, "morphine");
      const outcome = await createIndexWriter(writerDeps()).indexMessage(ORG_A, id);
      return { outcome, rows: await rowCount(id) };
    };

    it("defaults OFF everywhere: no row, no flag -> nothing is written", async () => {
      expect(await attempt()).toEqual({ outcome: "skipped_off", rows: 0 });
    });

    it("tenant ON but platform flag absent/false -> nothing; platform ON but tenant OFF -> nothing", async () => {
      await setTenantFlag(ORG_A, true);
      expect(await attempt()).toEqual({ outcome: "skipped_off", rows: 0 });
      await setPlatformFlag(false);
      expect(await attempt()).toEqual({ outcome: "skipped_off", rows: 0 });
      await setPlatformFlag(true);
      await setTenantFlag(ORG_A, false);
      expect(await attempt()).toEqual({ outcome: "skipped_off", rows: 0 });
    });

    it("a tenant-scoped feature_flag row for the platform key can NEVER enable indexing", async () => {
      await setTenantFlag(ORG_A, true);
      // no platform row at all, and a tenant row saying true
      await admin.query(
        `INSERT INTO feature_flag (organization_id, flag_key, flag_kind, value_type, value)
         VALUES ($1,$2,'product','bool','true'::jsonb)`,
        [ORG_A, GLOBAL_SEARCH_PLATFORM_FLAG_KEY],
      );
      expect(await attempt()).toEqual({ outcome: "skipped_off", rows: 0 });
      // platform row explicitly false: the tenant row still must not win
      await setPlatformFlag(false);
      expect(await attempt()).toEqual({ outcome: "skipped_off", rows: 0 });
      // control: forOrg-style merging WOULD have enabled it, the direct read does not
      expect((await createPlatformSearchFlag(handle.db).read(ORG_A)).enabled).toBe(false);
      await admin.query(`DELETE FROM feature_flag WHERE organization_id=$1`, [ORG_A]);
    });

    it("honours kill_switch_active and expiry exactly like every other flag", async () => {
      await setTenantFlag(ORG_A, true);
      await setPlatformFlag(true, { killSwitch: true });
      expect(await attempt()).toEqual({ outcome: "skipped_off", rows: 0 });
      await setPlatformFlag(true, { expired: true });
      expect(await attempt()).toEqual({ outcome: "skipped_off", rows: 0 });
      await setPlatformFlag(true);
      expect((await attempt()).outcome).toBe("indexed");
    });

    it("an unreadable platform flag THROWS (the caller fails closed), it is never read as 'off'", async () => {
      await setTenantFlag(ORG_A, true);
      const dead = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      await dead.close();
      const id = await sendMessage(ORG_A, "morphine");
      await expect(
        createIndexWriter(
          writerDeps({ platformFlag: createPlatformSearchFlag(dead.db) }),
        ).indexMessage(ORG_A, id),
      ).rejects.toThrow();
      expect(await rowCount(id)).toBe(0);
    });

    it("the unavailable key provider fails closed, directly and through the relay (event retried, nothing written)", async () => {
      await enableSearch(ORG_A);
      const id = await sendMessage(ORG_A, "morphine");
      const unavailable = { keys: createUnavailableSearchKeyProvider() };
      await expect(
        createIndexWriter(writerDeps(unavailable)).indexMessage(ORG_A, id),
      ).rejects.toBeInstanceOf(SearchKeyUnavailableError);
      await publishFor(ORG_A, "m36.message.sent", id);
      const summary = await dispatcherFor(unavailable).tick();
      expect(summary.retried + summary.deadLettered).toBeGreaterThanOrEqual(1);
      expect(await rowCount(id)).toBe(0);
      await admin.query(`DELETE FROM outbox_event WHERE event_type LIKE 'm36.message.%'`);
    });
  });

  // ── per-channel keys, name exclusion, T sizing, old-version cleanup ─────────────────────────────────
  describe("ADR-0058 product-owner decisions (per-channel keys, name exclusion, H2 sizing, M1 cleanup)", () => {
    const nameSource = (fragments: string[]): PatientNameSource => ({
      fragmentsPage: async (_org, after) =>
        after === null
          ? { fragments: [...fragments], nextAfterId: null }
          : { fragments: [], nextAfterId: null },
    });
    const drainReconcile = async (deps: ReconcileDeps) => {
      let result = await reconcileOrg(deps, ORG_A);
      for (let i = 0; i < 8 && result.state !== "ready"; i += 1)
        result = await reconcileOrg(deps, ORG_A);
      return result;
    };

    it("the same text in two channels stores unrelated tags, each under its own channel key and channel_id", async () => {
      await enableSearch(ORG_A);
      const second = (
        await admin.query(
          `INSERT INTO channel (organization_id, channel_kind, dm_participant_key, title, retention_class)
           VALUES ($1,'dm',$2,'DM2','care_related') RETURNING id`,
          [ORG_A, `${userA}:peer2`],
        )
      ).rows[0].id as string;
      const text = "morphine given for breakthrough pain";
      const one = await sendMessage(ORG_A, text);
      const two = await sendMessage(ORG_A, text, { channel: second });
      const writer = createIndexWriter(writerDeps());
      await writer.indexMessage(ORG_A, one);
      await writer.indexMessage(ORG_A, two);
      const channelOf = async (id: string) =>
        (
          await admin.query(
            `SELECT DISTINCT channel_id FROM message_search_token WHERE message_id=$1`,
            [id],
          )
        ).rows;
      expect(await channelOf(one)).toEqual([{ channel_id: channelA }]);
      expect(await channelOf(two)).toEqual([{ channel_id: second }]);
      expect(holdsAll(await storedTags(one), await realTagsOf(ORG_A, text, channelA))).toBe(true);
      expect(holdsAll(await storedTags(two), await realTagsOf(ORG_A, text, second))).toBe(true);
      const real = new Set(await realTagsOf(ORG_A, text, channelA));
      const overlap = (await realTagsOf(ORG_A, text, second)).filter((t) => real.has(t));
      expect(overlap.length).toBeLessThanOrEqual(2); // chance collisions at T=12 only; a shared key would overlap on all 13
      // L1: the plaintext label equals the message's real channel on every indexed row (it is deliberately not an FK)
      const mismatched = (
        await admin.query(
          `SELECT count(*)::int AS n FROM message_search_token t JOIN message m ON m.id = t.message_id
            WHERE t.organization_id = m.organization_id AND t.channel_id <> m.channel_id`,
        )
      ).rows[0].n;
      expect(mismatched).toBe(0);
    });

    it("a patient / contact name is never tagged (whole word or prefix); the state holds keyed digests, not names", async () => {
      await enableSearch(ORG_A);
      const exclusions = createNameExclusions({
        db: handle.db,
        keys,
        names: nameSource(["Astrid", "Lindqvist-Okafor", "J"]),
      });
      const writer = createIndexWriter(writerDeps({ exclusions }));
      const text = "Mrs Lindqvist and Astrid need morphine";
      const id = await sendMessage(ORG_A, text);
      expect(await writer.indexMessage(ORG_A, id)).toBe("indexed");

      const searchKey = await keys.tagKey(ORG_A, VERSION);
      const excluded = digestExclusion(
        searchKey,
        new Set(["lindqvist", "okafor", "astrid"].map((t) => nameTokenDigest(searchKey, t))),
      );
      const stored = await storedTags(id);
      const channelKeyTags = async (word: string) => realTagsOf(ORG_A, word);
      for (const name of ["lindqvist", "astrid"]) {
        const nameTags = await channelKeyTags(name); // whole word + prefix tags
        // the words 'lindqvist' / 'astrid' alone would yield their whole-word and prefix tags; none may be stored as a REAL tag.
        expect(holdsAll(stored, nameTags)).toBe(false);
      }
      expect(holdsAll(stored, await realTagsOf(ORG_A, text, undefined, excluded))).toBe(true);
      expect(holdsAll(stored, await realTagsOf(ORG_A, "morphine"))).toBe(true);

      const state = (
        await admin.query(
          `SELECT excluded_name_digests::text AS d, exclusion_synced_at FROM message_search_index_state WHERE organization_id=$1`,
          [ORG_A],
        )
      ).rows[0];
      expect(state.exclusion_synced_at).not.toBeNull();
      expect(state.d).not.toMatch(/lindqvist|okafor|astrid/i);
      expect((state.d.match(/[0-9a-f]{16}/g) ?? []).length).toBe(3);
    });

    it("fails closed: with no name source nothing is indexed (the error propagates, no row is written)", async () => {
      await enableSearch(ORG_A);
      const id = await sendMessage(ORG_A, "morphine");
      const writer = createIndexWriter(
        writerDeps({ exclusions: createNameExclusions({ db: handle.db, keys }) }),
      );
      await expect(writer.indexMessage(ORG_A, id)).rejects.toThrow(/no name source/);
      expect(await rowCount(id)).toBe(0);
    });

    // The reindex delay and the sync throttle are measured on the DATABASE clock: tests age the column instead of a fake clock.
    const backdate = (column: "exclusion_pending_since" | "exclusion_synced_at", ms: number) =>
      admin.query(
        `UPDATE message_search_index_state SET ${column} = now() - make_interval(secs => $2::double precision) WHERE organization_id=$1`,
        [ORG_A, ms / 1000],
      );
    const pendingCount = async () =>
      Number(
        (
          await admin.query(
            `SELECT cardinality(exclusion_pending) AS n FROM message_search_index_state WHERE organization_id=$1`,
            [ORG_A],
          )
        ).rows[0].n,
      );
    const reindexDepsFor = (
      exclusions: ReturnType<typeof createNameExclusions>,
      indexMessage: (org: string, id: string) => Promise<IndexOutcome>,
    ) => ({ db: handle.db, keys, exclusions, indexMessage });

    it("a digest added late restarts the delay for ALL pending digests (no early reindex or clear)", async () => {
      await enableSearch(ORG_A);
      const fragments: string[] = [];
      const exclusions = createNameExclusions({
        db: handle.db,
        keys,
        names: nameSource(fragments),
      });
      const writer = createIndexWriter(writerDeps({ exclusions }));
      const a = await sendMessage(ORG_A, "Quirke asked about morphine");
      const b = await sendMessage(ORG_A, "Zamora asked about lorazepam");
      await writer.indexMessage(ORG_A, a);
      await writer.indexMessage(ORG_A, b);
      const deps = reindexDepsFor(exclusions, (org, id) => writer.indexMessage(org, id));

      fragments.push("Quirke");
      await exclusions.sync(ORG_A, VERSION);
      await backdate("exclusion_pending_since", EXCLUSION_REINDEX_DELAY_MS - 1000); // 1 s short of due
      fragments.push("Zamora"); // a second name arrives just before the first would have been reindexed
      await exclusions.sync(ORG_A, VERSION);

      expect(await reindexPendingExclusions(deps, ORG_A, VERSION, TAG_BITS)).toBe(0);
      expect(await pendingCount()).toBe(2); // nothing cleared early
      expect(holdsAll(await storedTags(b), await realTagsOf(ORG_A, "zamora"))).toBe(true);

      await backdate("exclusion_pending_since", EXCLUSION_REINDEX_DELAY_MS + 1000);
      expect(await reindexPendingExclusions(deps, ORG_A, VERSION, TAG_BITS)).toBe(2);
      expect(await pendingCount()).toBe(0);
      expect(holdsAll(await storedTags(b), await realTagsOf(ORG_A, "zamora"))).toBe(false);
    });

    it("a rewrite that is skipped (skipped_stale) leaves the digest pending for the next pass", async () => {
      await enableSearch(ORG_A);
      const fragments: string[] = [];
      const exclusions = createNameExclusions({
        db: handle.db,
        keys,
        names: nameSource(fragments),
      });
      const writer = createIndexWriter(writerDeps({ exclusions }));
      const id = await sendMessage(ORG_A, "Quirke asked about morphine");
      await writer.indexMessage(ORG_A, id);
      fragments.push("Quirke");
      await exclusions.sync(ORG_A, VERSION);
      await backdate("exclusion_pending_since", EXCLUSION_REINDEX_DELAY_MS + 1000);

      const stale = reindexDepsFor(exclusions, async () => "skipped_stale");
      await reindexPendingExclusions(stale, ORG_A, VERSION, TAG_BITS);
      expect(await pendingCount()).toBe(1);

      const real = reindexDepsFor(exclusions, (org, m) => writer.indexMessage(org, m));
      expect(await reindexPendingExclusions(real, ORG_A, VERSION, TAG_BITS)).toBe(1);
      expect(await pendingCount()).toBe(0);
    });

    it("the tick re-reads the names at most once per NAME_SYNC_MIN_INTERVAL_MS (database clock)", async () => {
      await enableSearch(ORG_A);
      let pages = 0;
      const exclusions = createNameExclusions({
        db: handle.db,
        keys,
        names: {
          fragmentsPage: async () => {
            pages += 1;
            return { fragments: ["Astrid"], nextAfterId: null };
          },
        },
      });
      await exclusions.syncIfDue(ORG_A, VERSION);
      await exclusions.syncIfDue(ORG_A, VERSION);
      expect(pages).toBe(1);
      await backdate("exclusion_synced_at", NAME_SYNC_MIN_INTERVAL_MS + 1000);
      await exclusions.syncIfDue(ORG_A, VERSION);
      expect(pages).toBe(2);
    });

    /** A source whose every page eats the whole enumeration budget; page 2 (never reached) holds `unreached`. */
    const slowSource = (
      first: string[],
      unreached: string[],
      tick: () => void,
    ): PatientNameSource => ({
      fragmentsPage: async (_org, after) => {
        tick();
        return after === null
          ? { fragments: [...first], nextAfterId: "more" }
          : { fragments: [...unreached], nextAfterId: null };
      },
    });

    it("a name enumeration over its time budget applies what it read and is not marked synced (fails closed)", async () => {
      await enableSearch(ORG_A);
      let clock = 0;
      const exclusions = createNameExclusions({
        db: handle.db,
        keys,
        names: slowSource(["Astrid"], ["Unreached"], () => {
          clock += NAME_ENUMERATION_BUDGET_MS;
        }),
        now: () => clock,
      });
      expect(await exclusions.sync(ORG_A, VERSION)).toMatchObject({ added: 1, complete: false });
      const state = (
        await admin.query(
          `SELECT exclusion_synced_at, cardinality(excluded_name_digests) AS n FROM message_search_index_state WHERE organization_id=$1`,
          [ORG_A],
        )
      ).rows[0];
      expect(state).toEqual({ exclusion_synced_at: null, n: 1 });
      await expect(exclusions.currentReadOnly(ORG_A, VERSION)).rejects.toThrow(/not been synced/);
    });

    it("pending digests the cut-off enumeration could not see are NOT treated as orphans", async () => {
      await enableSearch(ORG_A);
      const fragments = ["Astrid", "Quirke"];
      const full = createNameExclusions({ db: handle.db, keys, names: nameSource(fragments) });
      await full.sync(ORG_A, VERSION);
      await backdate("exclusion_pending_since", EXCLUSION_REINDEX_DELAY_MS + 1000);
      let clock = 0;
      const cut = createNameExclusions({
        db: handle.db,
        keys,
        names: slowSource(["Astrid"], ["Quirke"], () => {
          clock += NAME_ENUMERATION_BUDGET_MS;
        }),
        now: () => clock,
      });
      await reindexPendingExclusions(
        reindexDepsFor(cut, async () => "indexed"),
        ORG_A,
        VERSION,
        TAG_BITS,
      );
      expect(await pendingCount()).toBe(1); // astrid was read and done; quirke was never read, so it stays pending
    });

    it("the query path only reads: a never-synced tenant fails closed and no state row is created", async () => {
      await enableSearch(ORG_A);
      const exclusions = createNameExclusions({
        db: handle.db,
        keys,
        names: nameSource(["Astrid"]),
      });
      await expect(exclusions.currentReadOnly(ORG_A, VERSION)).rejects.toThrow(/not been synced/);
      const rows = await admin.query(
        `SELECT 1 FROM message_search_index_state WHERE organization_id=$1`,
        [ORG_A],
      );
      expect(rows.rowCount).toBe(0);
      await exclusions.syncIfDue(ORG_A, VERSION); // what the first maintenance tick does
      await expect(exclusions.currentReadOnly(ORG_A, VERSION)).resolves.toBeDefined();
    });

    it("a NEW name is added grow-only, and only the messages that carry it are rewritten (after the cache delay)", async () => {
      await enableSearch(ORG_A);
      const clock = Date.now();
      const fragments = ["Astrid"];
      const exclusions = createNameExclusions({
        db: handle.db,
        keys,
        names: nameSource(fragments),
        now: () => clock,
      });
      const writer = createIndexWriter(writerDeps({ exclusions }));
      const carrier = await sendMessage(ORG_A, "Quirke asked about morphine");
      const bystander = await sendMessage(ORG_A, "lorazepam anxiety plan");
      await writer.indexMessage(ORG_A, carrier);
      await writer.indexMessage(ORG_A, bystander);
      const quirke = await realTagsOf(ORG_A, "quirke");
      expect(holdsAll(await storedTags(carrier), quirke)).toBe(true);
      const bystanderBefore = await storedTags(bystander);

      fragments.push("Quirke"); // a patient named Quirke is admitted
      expect(await exclusions.sync(ORG_A, VERSION)).toMatchObject({ added: 1 });
      expect(await exclusions.sync(ORG_A, VERSION)).toMatchObject({ added: 0 }); // idempotent
      const reindexDeps = {
        db: handle.db,
        keys,
        exclusions,
        indexMessage: (org: string, id: string) => writer.indexMessage(org, id),
        now: () => clock,
      };
      // too early: a replica that has not refreshed its cache could still index the name behind the pass
      expect(await reindexPendingExclusions(reindexDeps, ORG_A, VERSION, TAG_BITS)).toBe(0);
      await backdate("exclusion_pending_since", 3 * 60_000);
      expect(await reindexPendingExclusions(reindexDeps, ORG_A, VERSION, TAG_BITS)).toBe(1);
      expect(holdsAll(await storedTags(carrier), quirke)).toBe(false);
      expect(await storedTags(bystander)).toEqual(bystanderBefore); // untouched: not rewritten
      const pending = (
        await admin.query(
          `SELECT exclusion_pending, exclusion_pending_since FROM message_search_index_state WHERE organization_id=$1`,
          [ORG_A],
        )
      ).rows[0];
      expect(pending).toEqual({ exclusion_pending: [], exclusion_pending_since: null });
      // grow-only: the patient is renamed away, the old name stays excluded
      fragments.splice(0, fragments.length, "Astrid");
      await exclusions.sync(ORG_A, VERSION);
      const digests = (
        await admin.query(
          `SELECT cardinality(excluded_name_digests) AS n FROM message_search_index_state WHERE organization_id=$1`,
          [ORG_A],
        )
      ).rows[0].n;
      expect(digests).toBe(2);
    });

    it("sizes T from the stored rows (H2): a new tiny index is 12 bits; a stored width 2+ bits off is rebuilt, 1 bit off is not", async () => {
      await enableSearch(ORG_A);
      await admin.query(`DELETE FROM message_search_index_state`);
      await sendMessage(ORG_A, "morphine given");
      await sendMessage(ORG_A, "family visited");
      const deps = reconcileDeps();
      expect((await drainReconcile(deps)).state).toBe("ready");
      const bits = async () =>
        Number(
          (
            await admin.query(
              `SELECT tag_bits FROM message_search_index_state WHERE organization_id=$1`,
              [ORG_A],
            )
          ).rows[0].tag_bits,
        );
      expect(await bits()).toBe(12);

      await admin.query(
        `UPDATE message_search_index_state SET tag_bits=13, reconciled_at=NULL, status='stale'`,
      );
      await admin.query(`DELETE FROM message_search_token`);
      expect((await drainReconcile(deps)).state).toBe("ready"); // 13 vs rule 12: one bit off is left alone
      expect(await bits()).toBe(13);

      await admin.query(
        `UPDATE message_search_index_state SET tag_bits=18, reconciled_at=NULL, status='stale'`,
      );
      await admin.query(`DELETE FROM message_search_token`);
      const resized = await reconcileOrg(deps, ORG_A);
      for (let i = 0; i < 8 && (await bits()) !== 12; i += 1) await reconcileOrg(deps, ORG_A);
      expect(await bits()).toBe(12);
      expect(resized.state === "building" || resized.state === "ready").toBe(true);
      expect((await drainReconcile(deps)).state).toBe("ready");
    });

    it("M1: when the active version is ready, every OTHER version's rows and state are removed in the same step", async () => {
      await enableSearch(ORG_A);
      const id = await sendMessage(ORG_A, "morphine given");
      await createIndexWriter(writerDeps()).indexMessage(ORG_A, id);
      await admin.query(
        `INSERT INTO message_search_index_state (organization_id, key_version) VALUES ($1,'old-v0')`,
        [ORG_A],
      );
      await admin.query(
        `INSERT INTO message_search_token (organization_id,key_version,channel_id,tag,message_id)
         SELECT $1,'old-v0',$2,g,$3 FROM generate_series(1,16) g`,
        [ORG_A, channelA, id],
      );
      await admin.query(
        `UPDATE message_search_index_state SET status='stale' WHERE key_version=$1`,
        [VERSION],
      );
      expect((await drainReconcile(reconcileDeps())).state).toBe("ready");
      const left = await admin.query(
        `SELECT key_version, count(*)::int AS n FROM message_search_token WHERE organization_id=$1 GROUP BY 1`,
        [ORG_A],
      );
      expect(left.rows).toEqual([{ key_version: VERSION, n: 16 }]);
      const states = await admin.query(
        `SELECT key_version FROM message_search_index_state WHERE organization_id=$1`,
        [ORG_A],
      );
      expect(states.rows).toEqual([{ key_version: VERSION }]);
    });
  });

  // ── tenancy ───────────────────────────────────────────────────────────────────────────────────────
  describe("tenancy", () => {
    it("an org A event never writes org B, even when its payload names a message of org B", async () => {
      await enableSearch(ORG_A);
      await setTenantFlag(ORG_B, true);
      const aMessage = await sendMessage(ORG_A, "morphine");
      const bMessage = await sendMessage(ORG_B, "morphine");
      await publishFor(ORG_A, "m36.message.sent", bMessage); // envelope org A, message id from org B
      await dispatcherFor().tick();
      expect(await rowCount(bMessage)).toBe(0);
      expect(await totalRows(ORG_B)).toBe(0);

      await publishFor(ORG_A, "m36.message.sent", aMessage);
      await publishFor(ORG_B, "m36.message.sent", bMessage);
      await dispatcherFor().tick();
      expect(await rowCount(aMessage)).toBe(16);
      expect(await rowCount(bMessage)).toBe(16);
      expect(
        (
          await admin.query(
            `SELECT DISTINCT organization_id FROM message_search_token WHERE message_id=$1`,
            [bMessage],
          )
        ).rows,
      ).toEqual([{ organization_id: ORG_B }]);
      // same word, two tenants, different keys: the stored real tags differ
      expect(await realTagsOf(ORG_A, "morphine")).not.toEqual(await realTagsOf(ORG_B, "morphine"));
    });
  });

  // ── reconcile / rebuild ───────────────────────────────────────────────────────────────────────────
  describe("reconcile", () => {
    const bodies = [
      "morphine given for breakthrough pain",
      "family visited this afternoon",
      "oxycodone titrated overnight",
      "turned and repositioned",
      "alpine bravos cobalt delphi eclair fabric",
      "no dose recorded",
      "lorazepam anxiety plan",
    ];

    async function seedAll(): Promise<Map<string, string>> {
      const byId = new Map<string, string>();
      for (const text of bodies) byId.set(await sendMessage(ORG_A, text), text);
      return byId;
    }

    it("rebuilding after the table is truncated reproduces every message's real tags and goes ready", async () => {
      await enableSearch(ORG_A);
      const byId = await seedAll();
      const deps = reconcileDeps();
      let result = await reconcileOrg(deps, ORG_A);
      for (let i = 0; i < 6 && result.state !== "ready"; i += 1)
        result = await reconcileOrg(deps, ORG_A);
      expect(result.state).toBe("ready");
      for (const [id, text] of byId) {
        expect(holdsAll(await storedTags(id), await realTagsOf(ORG_A, text))).toBe(true);
      }
      const ready = (
        await admin.query(
          `SELECT status, reconciled_at, distinct_tags, head_buckets, stats_at FROM message_search_index_state WHERE organization_id=$1`,
          [ORG_A],
        )
      ).rows[0];
      expect(ready.status).toBe("ready");
      expect(ready.reconciled_at).not.toBeNull();
      expect(ready.distinct_tags).toBeGreaterThan(0);
      expect(ready.head_buckets).toEqual([]);
      expect(ready.stats_at).not.toBeNull();

      // the REAL stored tags before (dummies excluded by construction: compare membership of the expected set)
      await admin.query(`TRUNCATE message_search_token`);
      await admin.query(`DELETE FROM message_search_index_state`);
      expect(await totalRows(ORG_A)).toBe(0);

      let rebuilt = await reconcileOrg(deps, ORG_A);
      for (let i = 0; i < 6 && rebuilt.state !== "ready"; i += 1)
        rebuilt = await reconcileOrg(deps, ORG_A);
      expect(rebuilt.state).toBe("ready");
      for (const [id, text] of byId) {
        const stored = await storedTags(id);
        expect(stored).toHaveLength(paddedSize((await realTagsOf(ORG_A, text)).length));
        expect(holdsAll(stored, await realTagsOf(ORG_A, text))).toBe(true);
      }
    });

    it("resumes from the checkpoint and is bounded per run (maxBatches)", async () => {
      await enableSearch(ORG_A);
      await seedAll();
      const deps = reconcileDeps({ batchSize: 2, maxBatches: 1 });
      const first = await reconcileOrg(deps, ORG_A);
      expect(first.state).toBe("building");
      expect(first.indexed).toBe(2);
      const checkpoint = (
        await admin.query(
          `SELECT checkpoint_message_id FROM message_search_index_state WHERE organization_id=$1`,
          [ORG_A],
        )
      ).rows[0].checkpoint_message_id;
      expect(checkpoint).not.toBeNull();
      const second = await reconcileOrg(deps, ORG_A);
      expect(second.indexed).toBe(2); // continued after the checkpoint, did not redo the first two
    });

    it("deletes the rows of ineligible messages and reports drift until it is repaired", async () => {
      await enableSearch(ORG_A);
      const byId = await seedAll();
      const deps = reconcileDeps();
      let result = await reconcileOrg(deps, ORG_A);
      for (let i = 0; i < 6 && result.state !== "ready"; i += 1)
        result = await reconcileOrg(deps, ORG_A);
      expect(result.state).toBe("ready");

      // a message deleted while its hook could not run: stray rows for a tombstoned message (simulated)
      const victim = [...byId.keys()][1] as string;
      await markDeleted(victim);
      await admin.query(
        `INSERT INTO message_search_token (organization_id,key_version,channel_id,tag,message_id)
         SELECT $1,$2,$4,g,$3 FROM generate_series(1,16) g`,
        [ORG_A, VERSION, victim, channelA],
      );
      await admin.query(`UPDATE message_search_index_state SET status='stale'`);
      let again = await reconcileOrg(deps, ORG_A);
      for (let i = 0; i < 6 && again.state !== "ready"; i += 1)
        again = await reconcileOrg(deps, ORG_A);
      expect(again.state).toBe("ready");
      expect(await rowCount(victim)).toBe(0);
    });

    it("computes head buckets (bucket numbers only) from rows above HEAD_BUCKET_ROWS", async () => {
      await enableSearch(ORG_A);
      const id = await sendMessage(ORG_A, "morphine");
      await createIndexWriter(writerDeps()).indexMessage(ORG_A, id);
      await admin.query(
        `INSERT INTO message_search_token (organization_id,key_version,channel_id,tag,message_id)
         SELECT $1,$2,$4,777,$3 FROM generate_series(1,5001)`,
        [ORG_A, VERSION, id, channelA],
      );
      const stats = await refreshIndexStats(handle.db, ORG_A, VERSION);
      expect(stats.headBuckets).toEqual([`${channelA}:777`]);
      expect(stats.totalRows).toBeGreaterThan(5001);
      expect(stats.distinctTags).toBeGreaterThan(1);
      const row = (
        await admin.query(
          `SELECT head_buckets, distinct_tags FROM message_search_index_state WHERE organization_id=$1`,
          [ORG_A],
        )
      ).rows[0];
      expect(row.head_buckets).toEqual([`${channelA}:777`]);
    });

    it("OFF-then-ON: a message sent and a message deleted while OFF are repaired before the index is ready again", async () => {
      await enableSearch(ORG_A);
      const byId = await seedAll();
      const deps = reconcileDeps();
      let result = await reconcileOrg(deps, ORG_A);
      for (let i = 0; i < 6 && result.state !== "ready"; i += 1)
        result = await reconcileOrg(deps, ORG_A);
      expect(result.state).toBe("ready");
      expect((await reconcileOrg(deps, ORG_A)).state).toBe("ready"); // trusted while nothing changed

      await setTenantFlag(ORG_A, false);
      const sentWhileOff = await sendMessage(ORG_A, "haloperidol agitation");
      const deletedWhileOff = [...byId.keys()][0] as string;
      await markDeleted(deletedWhileOff);
      expect(await createIndexWriter(writerDeps()).indexMessage(ORG_A, sentWhileOff)).toBe(
        "skipped_off",
      );
      expect((await reconcileOrg(deps, ORG_A)).state).toBe("off");
      expect(await rowCount(sentWhileOff)).toBe(0);
      expect(await rowCount(deletedWhileOff)).toBe(0); // the delete hook ran although the flag was OFF

      await setTenantFlag(ORG_A, true);
      let back = await reconcileOrg(deps, ORG_A);
      expect(back.state === "building" || back.state === "ready").toBe(true); // a ready index is NOT trusted after a flip
      for (let i = 0; i < 6 && back.state !== "ready"; i += 1)
        back = await reconcileOrg(deps, ORG_A);
      expect(back.state).toBe("ready");
      expect(
        holdsAll(await storedTags(sentWhileOff), await realTagsOf(ORG_A, "haloperidol agitation")),
      ).toBe(true);
      expect(await rowCount(deletedWhileOff)).toBe(0);
    });

    it("never goes ready while the platform kill switch is off, and a platform flip invalidates a ready index", async () => {
      await enableSearch(ORG_A);
      await seedAll();
      const deps = reconcileDeps();
      let result = await reconcileOrg(deps, ORG_A);
      for (let i = 0; i < 6 && result.state !== "ready"; i += 1)
        result = await reconcileOrg(deps, ORG_A);
      expect(result.state).toBe("ready");

      await setPlatformFlag(false);
      expect((await reconcileOrg(deps, ORG_A)).state).toBe("off");
      await setPlatformFlag(true);
      await sleep(5);
      const added = await sendMessage(ORG_A, "baclofen spasm");
      let back = await reconcileOrg(deps, ORG_A);
      for (let i = 0; i < 6 && back.state !== "ready"; i += 1)
        back = await reconcileOrg(deps, ORG_A);
      expect(back.state).toBe("ready");
      expect(await rowCount(added)).toBe(16);
    });
  });

  // ── re-verification keeps 'ready'; flips; expiry; locks; no leaks ────────────────────────────────
  describe("re-verification, flips and failure hygiene", () => {
    const BULK = 450;
    const BULK_TEXT = "bulk sample text for the synthetic set";
    const rowsFor = async (text: string) => paddedSize((await realTagsOf(ORG_A, text)).length);
    const buildingEvents = async () =>
      Number(
        (
          await admin.query(
            `SELECT count(*)::int AS n FROM audit_event
              WHERE organization_id=$1 AND event_type='message_search_index_state.update'
                AND after->>'status'='building'`,
            [ORG_A],
          )
        ).rows[0].n,
      );
    const stateRow = async () =>
      (
        await admin.query(
          `SELECT status, reconciled_at FROM message_search_index_state WHERE organization_id=$1`,
          [ORG_A],
        )
      ).rows[0];
    const untilReady = async (deps: ReconcileDeps) => {
      let result = await reconcileOrg(deps, ORG_A);
      for (let i = 0; i < 20 && result.state !== "ready"; i += 1)
        result = await reconcileOrg(deps, ORG_A);
      expect(result.state).toBe("ready");
    };
    async function readyBulkTenant(): Promise<ReconcileDeps> {
      await enableSearch(ORG_A);
      const sealed = await cipher.seal(ORG_A, BULK_TEXT);
      await admin.query(
        `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256, body_kind)
         SELECT $1,$2,$3,'user',$4,$5,'plain' FROM generate_series(1,$6)`,
        [channelA, ORG_A, userA, sealed.cipher, sealed.sha256, BULK],
      );
      const deps = reconcileDeps({ batchSize: 200 });
      await untilReady(deps);
      expect(await totalRows(ORG_A)).toBe(BULK * (await rowsFor(BULK_TEXT)));
      return deps;
    }

    it("a 24 h expiry re-verifies WITHOUT ever leaving ready (no 'building' write), and refreshes reconciled_at", async () => {
      const deps = await readyBulkTenant();
      const baseline = await buildingEvents();
      expect(baseline).toBeGreaterThan(0); // the audit trail does record a 'building' write, so the zero below is meaningful
      await admin.query(
        `UPDATE message_search_index_state SET reconciled_at = now() - interval '25 hours' WHERE organization_id=$1`,
        [ORG_A],
      );
      const before = (await stateRow()).reconciled_at as Date;
      const result = await reconcileOrg(deps, ORG_A);
      expect(result).toEqual({ state: "ready", indexed: 0, removed: 0 });
      const after = await stateRow();
      expect(after.status).toBe("ready");
      expect((after.reconciled_at as Date).getTime()).toBeGreaterThan(before.getTime());
      expect(await buildingEvents()).toBe(baseline);
    }, 120_000);

    it("real drift found by the re-verify DOES demote to building, then the sweep repairs it", async () => {
      const deps = await readyBulkTenant();
      const baseline = await buildingEvents();
      const victim = (
        await admin.query(`SELECT id FROM message ORDER BY created_at, id OFFSET 300 LIMIT 1`)
      ).rows[0].id as string;
      await admin.query(`DELETE FROM message_search_token WHERE message_id=$1`, [victim]);
      await admin.query(
        `UPDATE message_search_index_state SET reconciled_at = now() - interval '25 hours' WHERE organization_id=$1`,
        [ORG_A],
      );
      const demoted = await reconcileOrg({ ...deps, maxBatches: 0 }, ORG_A);
      expect(demoted.state).toBe("building");
      expect((await stateRow()).status).toBe("building");
      expect(await buildingEvents()).toBeGreaterThan(baseline);
      await untilReady(deps);
      expect(await rowCount(victim)).toBe(await rowsFor(BULK_TEXT));
    }, 120_000);

    it("a flip WITHOUT bumping changed_at is not re-verified (documents the C4 dependency)", async () => {
      await enableSearch(ORG_A);
      const deps = reconcileDeps();
      await sendMessage(ORG_A, "morphine");
      await untilReady(deps);
      await admin.query(
        `UPDATE tenant_messaging_search_setting SET enabled=false WHERE organization_id=$1`,
        [ORG_A],
      );
      const sentWhileOff = await sendMessage(ORG_A, "haloperidol agitation");
      await admin.query(
        `UPDATE tenant_messaging_search_setting SET enabled=true WHERE organization_id=$1`,
        [ORG_A],
      );
      expect(await reconcileOrg(deps, ORG_A)).toEqual({ state: "ready", indexed: 0, removed: 0 });
      expect(await rowCount(sentWhileOff)).toBe(0); // missed, and still trusted: the route MUST bump changed_at
    });

    it("a flip WITH changed_at bumped invalidates ready: drift is found, repaired, ready again", async () => {
      await enableSearch(ORG_A);
      const deps = reconcileDeps();
      await sendMessage(ORG_A, "morphine");
      await untilReady(deps);
      await setTenantFlag(ORG_A, false);
      const sentWhileOff = await sendMessage(ORG_A, "haloperidol agitation");
      await setTenantFlag(ORG_A, true); // bumps changed_at
      const result = await reconcileOrg(deps, ORG_A);
      if (result.state !== "ready") await untilReady(deps);
      expect(await rowCount(sentWhileOff)).toBe(await rowsFor("haloperidol agitation"));
      expect((await stateRow()).status).toBe("ready");
    });

    it("an OFF update waits for an in-flight index write to commit, and the write lands before the OFF", async () => {
      await enableSearch(ORG_A);
      const id = await sendMessage(ORG_A, "morphine given");
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: () => void = () => {};
      const reachedBody = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const real = createBodyReader(cipher);
      const indexing = createIndexWriter(
        writerDeps({
          bodies: {
            async read(org, body) {
              entered();
              await gate;
              return real.read(org, body);
            },
          },
        }),
      ).indexMessage(ORG_A, id);
      await reachedBody;
      const admin2 = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await admin2.connect();
      try {
        await admin2.query("BEGIN");
        await admin2.query(
          `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
          [ORG_A, userA],
        );
        let flipped = false;
        const flip = admin2
          .query(
            `UPDATE tenant_messaging_search_setting SET enabled=false, purge_requested_at=now(), changed_at=now() WHERE organization_id=$1`,
            [ORG_A],
          )
          .finally(() => {
            flipped = true;
          });
        await sleep(400);
        expect(flipped).toBe(false);
        release();
        expect(await indexing).toBe("indexed");
        await flip;
        await admin2.query("COMMIT");
        expect(await rowCount(id)).toBe(16);
        expect((await purgeOrgIfRequested(handle.db, ORG_A)).state).toBe("completed");
        expect(await rowCount(id)).toBe(0);
      } finally {
        await admin2.end();
      }
    });

    it("skipped_stale is reported through onError with ids and a fixed reason only; no body, token or tag in any error", async () => {
      await enableSearch(ORG_A);
      const sentinel = "zyxwvutsr";
      const id = await sendMessage(ORG_A, `${sentinel} quixotic`);
      await admin.query(`UPDATE message SET body_sha256 = repeat('a', 64) WHERE id=$1`, [id]);
      const reports: unknown[] = [];
      const outcome = await createIndexWriter(
        writerDeps({ onError: (info) => reports.push(info) }),
      ).indexMessage(ORG_A, id);
      expect(outcome).toBe("skipped_stale");
      expect(reports).toEqual([
        { organizationId: ORG_A, messageId: id, reason: "digest_mismatch" },
      ]);
      expect(await rowCount(id)).toBe(0);

      const tagValues = (await realTagsOf(ORG_A, sentinel)).map(String);
      const failure = await createIndexWriter(
        writerDeps({ keys: createUnavailableSearchKeyProvider() }),
      )
        .indexMessage(ORG_A, id)
        .catch((error: unknown) => error as Error);
      const dump = JSON.stringify([
        reports,
        String((failure as Error).message),
        (failure as Error).stack,
      ]);
      expect(dump).not.toContain(sentinel);
      expect(dump).not.toContain("quixotic");
      for (const tag of tagValues) expect(dump).not.toContain(`"tag":${tag}`);
    });
  });

  // ── OFF purge ─────────────────────────────────────────────────────────────────────────────────────
  describe("OFF purge", () => {
    async function indexedTenant() {
      await enableSearch(ORG_A);
      const deps = reconcileDeps();
      for (const text of ["morphine one", "oxycodone two", "lorazepam three"])
        await sendMessage(ORG_A, text);
      let result = await reconcileOrg(deps, ORG_A);
      for (let i = 0; i < 6 && result.state !== "ready"; i += 1)
        result = await reconcileOrg(deps, ORG_A);
      expect(result.state).toBe("ready");
      expect(await totalRows(ORG_A)).toBe(48);
    }

    it("deletes the tenant's rows in batches, resumably, idempotently, and audits completion", async () => {
      await indexedTenant();
      const otherTenantRows = await totalRows(ORG_B);
      await admin.query(
        `UPDATE tenant_messaging_search_setting SET enabled=false, purge_requested_at=now(), changed_at=now() WHERE organization_id=$1`,
        [ORG_A],
      );

      const partial = await purgeOrgIfRequested(handle.db, ORG_A, { batchRows: 10, maxBatches: 1 });
      expect(partial).toEqual({ state: "resumable", deleted: 10 });
      expect(await totalRows(ORG_A)).toBe(38);
      expect(
        (
          await admin.query(
            `SELECT purge_completed_at FROM tenant_messaging_search_setting WHERE organization_id=$1`,
            [ORG_A],
          )
        ).rows[0].purge_completed_at,
      ).toBeNull();

      const done = await purgeOrgIfRequested(handle.db, ORG_A, { batchRows: 10 });
      expect(done.state).toBe("completed");
      expect(await totalRows(ORG_A)).toBe(0);
      expect(await totalRows(ORG_B)).toBe(otherTenantRows);
      expect(
        (
          await admin.query(
            `SELECT count(*)::int AS n FROM message_search_index_state WHERE organization_id=$1`,
            [ORG_A],
          )
        ).rows[0].n,
      ).toBe(0);
      const audited = await admin.query(
        `SELECT 1 FROM audit_event
          WHERE organization_id=$1 AND event_type='tenant_messaging_search_setting.update'
            AND after->>'purge_completed_at' IS NOT NULL`,
        [ORG_A],
      );
      expect(audited.rowCount).toBeGreaterThanOrEqual(1);

      expect(await purgeOrgIfRequested(handle.db, ORG_A)).toEqual({ state: "none", deleted: 0 }); // idempotent
    });

    it("does not purge a tenant that is switched ON, even with a stale purge request", async () => {
      await indexedTenant();
      await admin.query(
        `UPDATE tenant_messaging_search_setting SET purge_requested_at=now() WHERE organization_id=$1`,
        [ORG_A],
      );
      expect((await purgeOrgIfRequested(handle.db, ORG_A)).state).toBe("none");
      expect(await totalRows(ORG_A)).toBe(48);
    });
  });
});
