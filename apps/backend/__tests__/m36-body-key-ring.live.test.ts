/**
 * WP 2.13 / ADR-0058 P1 — message bodies on the M34 wrapped-DEK ring, LIVE Postgres as the NOBYPASSRLS `wardenx_app`.
 *
 * Proves, over a real tenant_key_ring + the real M34 TenantKeyProvider (not a stub):
 *   - the generated `body_envelope_version` marker (1 legacy / 2 ring) and both schemes readable through one service;
 *   - new writes under `ring` (send, edit) record the scheme; an edit keeps the replaced body as an append-only revision;
 *   - the app role still cannot rewrite a revision; the one audited re-seal function refuses another org, a non-legacy
 *     source and a stale ciphertext;
 *   - the backfill: dry run writes nothing, resumable after a stop, idempotent, tenant-scoped, plaintext hash checked and
 *     preserved (hash_verify clean across it), a tampered row is reported and never re-sealed, a concurrent edit is not
 *     lost and nothing is sealed twice;
 *   - one tenant's ring cannot open another's bodies; a rotation keeps old bodies readable; destroying the ring (the M34
 *     shred function) makes every ring-sealed body unreadable while legacy-sealed ones stay readable until backfilled;
 *   - the boot counts + the fail-closed legacy-key check.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m36:body-key-ring:live
 * Use a PRIVATE container (the suite DROPs ROLEs); never the shared cluster.
 */
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { bodyEnvelopeScheme, messageBodySha256 } from "@chartwarden/messaging";
import { __resetModule34SeamsForTest } from "@chartwarden/saas-tenant-platform";
import { registerPlatformJob, systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACTIVE_KEK_ENV,
  createPlatformKekAdapter,
  loadPlatformKekRing,
} from "../src/bootstrap/tenant-kek";
import { m34PlatformBypassAuditor } from "../src/index";
import {
  getTenantKeyProvider,
  registerLiveM34Seams,
  validateModule34Seams,
} from "../src/modules/34-saas-tenant-platform/index";
import {
  BodyKeyUnavailableError,
  createRingDekCache,
  invalidateMessageBodyKeys,
  setMessageBodyKeyProvider,
} from "../src/modules/36-messaging/body-key-ring";
import {
  LegacyBodyKeyMissingError,
  M36_BODY_LEGACY_COUNT_JOB_ID,
  assertLegacyBodyKeyAvailable,
  countLegacyBodiesAllTenants,
} from "../src/modules/36-messaging/body-legacy-key-check";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/index";
import { backfillBodiesForOrg } from "../src/modules/36-messaging/jobs/body-backfill";
import { runHashVerifyForOrg } from "../src/modules/36-messaging/jobs/integrity-jobs";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import { appRoleConnectionString } from "./_live-app-role";

// these suites run hash_verify only; the retention scan is not exercised
const NO_MESSAGE_HOLDS = {
  activeHolds: async () => [],
  openCertificate: async () => ({ id: "", created: false }),
};

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "tenant_platform_writer",
  "wp213_resealer",
  "wardenx_m36_reseal",
];
const KEK = randomBytes(32);
const ORG_A = "11111111-1111-4111-8111-1111111136a1";
const ORG_B = "22222222-2222-4222-8222-2222222236b2";
const PLATFORM_KEK = "kek-1:Y2ktdGVuYW50LWtlay10ZXN0LTAxMjM0NTY3ODlhYmM=";

type Row = { id: string; body_cipher: Buffer; body_sha256: string; v: number };

describe.skipIf(!DB_URL)("WP 2.13 — message bodies on the M34 ring — LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let platformHandle: { db: DbClient; close: () => Promise<void> };
  /** Logs in as a member of wardenx_m36_reseal: the only credential that may re-seal a revision (migration 1090). */
  let resealHandle: { db: DbClient; close: () => Promise<void> };
  const accountOf: Record<string, string> = {};
  let kekAdapter: ReturnType<typeof createPlatformKekAdapter>;
  let cache: ReturnType<typeof createRingDekCache>;
  let legacyCipher: ReturnType<typeof createMessageBodyCipher>;
  let ringCipher: ReturnType<typeof createMessageBodyCipher>;
  let legacyService: ReturnType<typeof createDbMessagingRouteService>;
  let ringService: ReturnType<typeof createDbMessagingRouteService>;
  const users: Record<string, string> = {};

  async function applyMigrations() {
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let text = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        text = text.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        text = text.replace(/\bvector\(\d+\)/g, "text");
        text = text.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(text);
    }
  }

  async function seedOrg(org: string, slug: string) {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
      [org, slug],
    );
    accountOf[org] = (
      await admin.query(
        `INSERT INTO tenant_account (organization_id, legal_business_name, billing_contact_email, breach_notification_email)
         VALUES ($1,$2,'b@wp213.example','x@wp213.example') RETURNING id`,
        [org, `${slug} LLC`],
      )
    ).rows[0].id as string;
    const wrapped = await kekAdapter.mintAndWrapDek({ organizationId: org });
    await platformHandle.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.dek_kek_wrapped_ciphertext_b64', ${wrapped.wrappedCiphertextB64}, true), set_config('app.dek_kek_id', ${wrapped.kekId}, true)`,
      );
      await tx.execute(sql`SELECT m34_provision_tenant_key_ring(${accountOf[org]})`);
    });
  }

  async function seedUser(key: string, org: string) {
    const id = (
      await admin.query(`INSERT INTO "user" (email, name) VALUES ($1,$1) RETURNING id`, [
        `${key}@wp213.test`,
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [id, org],
    );
    users[key] = id;
    return id;
  }

  const rowsOf = async (table: "message" | "message_revision", org: string): Promise<Row[]> =>
    (
      await admin.query(
        `SELECT id, body_cipher, body_sha256, body_envelope_version AS v FROM ${table} WHERE organization_id=$1 ORDER BY id`,
        [org],
      )
    ).rows as Row[];
  const legacyCount = async (table: "message" | "message_revision", org: string) =>
    (
      await admin.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE organization_id=$1 AND body_envelope_version=1`,
        [org],
      )
    ).rows[0].n as number;
  /** Every row of the org opens and still matches its stored plaintext hash. */
  const allRowsVerify = async (org: string) => {
    for (const table of ["message", "message_revision"] as const) {
      for (const r of await rowsOf(table, org)) {
        const plain = await ringCipher.open(org, r.body_cipher);
        expect(messageBodySha256(plain)).toBe(r.body_sha256);
      }
    }
  };
  const dmOf = (svc: typeof legacyService, org: string, a: string, b: string) =>
    svc.openDm(org, users[a] as string, users[b] as string);
  const send = (
    svc: typeof legacyService,
    org: string,
    channelId: string,
    author: string,
    body: string,
  ) =>
    svc.sendMessage(org, {
      channelId,
      authorUserId: users[author] as string,
      body,
      bodyKind: "plain",
    });
  const edit = (
    svc: typeof legacyService,
    org: string,
    who: string,
    messageId: string,
    body: string,
  ) => svc.editMessage(org, { userId: users[who] as string, messageId, body });
  const backfill = (org: string, opts: Parameters<typeof backfillBodiesForOrg>[2] = {}) =>
    backfillBodiesForOrg({ db: handle.db, cipher: ringCipher, resealDb: resealHandle.db }, org, {
      pauseMs: 0,
      ...opts,
    });

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
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    await admin.query("ALTER ROLE wardenx_admin LOGIN BYPASSRLS PASSWORD 'wp213_platform'");
    // The same COLUMN grants scripts/db/provision-runtime-roles.ts gives wardenx_platform (this suite's platform login
    // stands in as wardenx_admin, the m34 live-suite precedent): the scheme marker only, never the ciphertext.
    await admin.query(
      'GRANT SELECT ("organization_id", "body_envelope_version") ON "message", "message_revision" TO wardenx_admin',
    );
    await admin.query(
      'GRANT SELECT ("organization_id", "label_envelope_version") ON "message_poll_option" TO wardenx_admin',
    );
    // The platform login's audited bypass entry (migration 0187 grants the writer to wardenx_app only).
    await admin.query(
      "GRANT EXECUTE ON FUNCTION audit_writer_insert_platform_event(text, text, uuid, text, text, text, jsonb, text) TO wardenx_admin",
    );
    const platformUrl = new URL(DB_URL as string);
    platformUrl.username = "wardenx_admin";
    platformUrl.password = "wp213_platform";
    platformHandle = createDbClient({ connectionString: platformUrl.toString() });
    await admin.query(
      "CREATE ROLE wp213_resealer LOGIN NOBYPASSRLS PASSWORD 'wp213_resealer' IN ROLE wardenx_m36_reseal",
    );
    const resealUrl = new URL(DB_URL as string);
    resealUrl.username = "wp213_resealer";
    resealUrl.password = "wp213_resealer";
    resealHandle = createDbClient({ connectionString: resealUrl.toString() });

    const ring = loadPlatformKekRing({ [ACTIVE_KEK_ENV]: PLATFORM_KEK } as NodeJS.ProcessEnv);
    if (!ring) throw new Error("expected a KEK ring");
    kekAdapter = createPlatformKekAdapter(ring);
    await seedOrg(ORG_A, "wp213a");
    await seedOrg(ORG_B, "wp213b");
    for (const [k, o] of [
      ["a1", ORG_A],
      ["a2", ORG_A],
      ["b1", ORG_B],
      ["b2", ORG_B],
    ] as const) {
      await seedUser(k, o);
    }

    __resetModule34SeamsForTest();
    registerLiveM34Seams({
      db: handle.db,
      auditBypass: m34PlatformBypassAuditor,
      kekUnwrap: kekAdapter,
      keyRingDb: platformHandle.db,
    });
    validateModule34Seams();
    cache = createRingDekCache(getTenantKeyProvider());
    setMessageBodyKeyProvider(() => getTenantKeyProvider());
    legacyCipher = createMessageBodyCipher({ kek: KEK, ringCache: cache, sealScheme: "legacy" });
    ringCipher = createMessageBodyCipher({ kek: KEK, ringCache: cache, sealScheme: "ring" });
    legacyService = createDbMessagingRouteService(handle.db, { kek: KEK, cipher: legacyCipher });
    ringService = createDbMessagingRouteService(handle.db, { kek: KEK, cipher: ringCipher });
  }, 300_000);

  afterAll(async () => {
    await handle?.close();
    await platformHandle?.close();
    await resealHandle?.close();
    setMessageBodyKeyProvider(undefined);
    await admin?.end();
    __resetModule34SeamsForTest();
  });

  it("marks each row's key scheme (generated from the ciphertext) and reads BOTH schemes through one service", async () => {
    const dm = await dmOf(legacyService, ORG_A, "a1", "a2");
    const oldMsg = await send(legacyService, ORG_A, dm.channelId, "a1", "written before P1");
    const newMsg = await send(ringService, ORG_A, dm.channelId, "a1", "written on the ring");
    const rows = await rowsOf("message", ORG_A);
    expect(rows.find((r) => r.id === oldMsg.messageId)?.v).toBe(1);
    expect(rows.find((r) => r.id === newMsg.messageId)?.v).toBe(2);
    expect(
      bodyEnvelopeScheme(rows.find((r) => r.id === newMsg.messageId)?.body_cipher as Buffer),
    ).toBe("ring");
    // the plaintext hash is scheme-independent
    expect(rows[0]?.body_sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const svc of [legacyService, ringService]) {
      const page = await svc.listMessages(ORG_A, {
        channelId: dm.channelId,
        userId: users.a2 as string,
      });
      expect(page.messages.map((m) => m.body)).toEqual([
        "written before P1",
        "written on the ring",
      ]);
    }
  });

  it("a ring-write edit seals the head on the ring and keeps the replaced body as an append-only revision", async () => {
    const dm = await dmOf(ringService, ORG_A, "a1", "a2");
    const m = await send(legacyService, ORG_A, dm.channelId, "a1", "v1 legacy");
    await edit(ringService, ORG_A, "a1", m.messageId, "v2 ring");
    await edit(ringService, ORG_A, "a1", m.messageId, "v3 ring");
    const head = (await rowsOf("message", ORG_A)).find((r) => r.id === m.messageId) as Row;
    expect(head.v).toBe(2);
    const revs = (
      await admin.query(
        `SELECT revision_no, body_envelope_version AS v FROM message_revision WHERE message_id=$1 ORDER BY revision_no`,
        [m.messageId],
      )
    ).rows;
    expect(revs).toEqual([
      { revision_no: 1, v: 1 }, // the original: a verbatim copy of what the head held
      { revision_no: 2, v: 2 },
    ]);
    await allRowsVerify(ORG_A);
  });

  it("the app role still cannot rewrite a revision; the audited re-seal function is the only door and is guarded", async () => {
    const [rev] = (
      await admin.query(
        `SELECT id, body_cipher FROM message_revision WHERE organization_id=$1 AND body_envelope_version=1 LIMIT 1`,
        [ORG_A],
      )
    ).rows as Array<{ id: string; body_cipher: Buffer }>;
    expect(rev).toBeDefined();
    const asApp = <T>(org: string, fn: (tx: DbClient) => Promise<T>) =>
      withOrgContext(handle.db, systemOrgContext(org), (tx) => fn(tx as unknown as DbClient));
    // ordinary code: no UPDATE on message_revision, whatever it tries
    await expect(
      asApp(ORG_A, (tx) =>
        tx.execute(
          sql`UPDATE message_revision SET body_cipher = ${rev?.body_cipher} WHERE id = ${rev?.id}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/i) } });
    const sealed = (
      await ringCipher.sealRing(ORG_A, await legacyCipher.open(ORG_A, rev?.body_cipher as Buffer))
    ).cipher;
    const callVia = (
      h: { db: DbClient },
      org: string,
      id: string,
      oldC: Buffer,
      newC: Buffer,
      sessionOrg = ORG_A,
    ) =>
      withOrgContext(h.db, systemOrgContext(sessionOrg), (tx) =>
        (tx as unknown as DbClient).execute(
          sql`SELECT m36_reseal_message_revision(${org}::uuid, ${id}::uuid, ${oldC}::bytea, ${newC}::bytea) AS ok`,
        ),
      );
    // HIGH fix: the request-path role has NO execute on it, so garbage that merely starts with 0x02 is refused outright
    const garbage = Buffer.concat([Buffer.from([2]), randomBytes(60)]);
    await expect(
      callVia(handle, ORG_A, rev?.id as string, rev?.body_cipher as Buffer, garbage),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/permission denied for function/i) },
    });
    expect(
      (
        await admin.query(`SELECT body_envelope_version AS v FROM message_revision WHERE id=$1`, [
          rev?.id,
        ])
      ).rows[0].v,
    ).toBe(1);
    // the dedicated credential still validates the envelope shape: garbage, wrong length, empty label
    const call = (org: string, id: string, oldC: Buffer, newC: Buffer, sessionOrg = ORG_A) =>
      callVia(resealHandle, org, id, oldC, newC, sessionOrg);
    for (const bad of [
      garbage,
      Buffer.concat([
        Buffer.from([2, 2]),
        Buffer.from("v1"),
        randomBytes((rev?.body_cipher.length as number) + 2),
      ]),
      Buffer.concat([Buffer.from([2, 0]), randomBytes((rev?.body_cipher.length as number) + 1)]),
      Buffer.concat([
        Buffer.from([2, 2]),
        Buffer.from("v!"),
        randomBytes((rev?.body_cipher.length as number) + 1),
      ]),
    ]) {
      await expect(
        call(ORG_A, rev?.id as string, rev?.body_cipher as Buffer, bad),
      ).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/malformed ring envelope|only a legacy/) },
      });
    }
    // another org than the session is bound to
    await expect(
      call(ORG_B, rev?.id as string, rev?.body_cipher as Buffer, sealed),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/does not match the session/) },
    });
    // the session is org B but the row is org A's: matches nothing (RLS), nothing changes
    const crossTenant = await call(
      ORG_B,
      rev?.id as string,
      rev?.body_cipher as Buffer,
      sealed,
      ORG_B,
    );
    expect((crossTenant as unknown as { rows: Array<{ ok: boolean }> }).rows[0]?.ok).toBe(false);
    // only legacy -> ring: ring -> ring and legacy -> legacy are refused
    await expect(call(ORG_A, rev?.id as string, sealed, sealed)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/only a legacy/) },
    });
    await expect(
      call(ORG_A, rev?.id as string, rev?.body_cipher as Buffer, rev?.body_cipher as Buffer),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/only a legacy/) } });
    // a value too short for get_byte raises the INTENDED error (explicit nesting, no reliance on OR short-circuit)
    await expect(call(ORG_A, rev?.id as string, Buffer.from([1]), sealed)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/only a legacy/) },
    });
    // a stale ciphertext (compare-and-swap) changes nothing
    const stale = await call(
      ORG_A,
      rev?.id as string,
      Buffer.concat([Buffer.from([1]), randomBytes((rev?.body_cipher.length as number) - 1)]),
      sealed,
    );
    expect((stale as unknown as { rows: Array<{ ok: boolean }> }).rows[0]?.ok).toBe(false);
    expect(
      (
        await admin.query(`SELECT body_envelope_version AS v FROM message_revision WHERE id=$1`, [
          rev?.id,
        ])
      ).rows[0].v,
    ).toBe(1);
  });

  it("backfill: dry run writes nothing, a stopped run resumes, a re-run is a no-op, hashes and plaintext survive, hash_verify stays clean", async () => {
    const dm = await dmOf(legacyService, ORG_A, "a1", "a2");
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1)
      ids.push(
        (await send(legacyService, ORG_A, dm.channelId, "a1", `legacy body ${i}`)).messageId,
      );
    for (const id of ids.slice(0, 4))
      await edit(legacyService, ORG_A, "a1", id, "edited under legacy");
    const before = {
      message: await legacyCount("message", ORG_A),
      revision: await legacyCount("message_revision", ORG_A),
    };
    expect(before.message).toBeGreaterThanOrEqual(12);
    expect(before.revision).toBeGreaterThanOrEqual(4);
    const hashesBefore = new Map(
      (await rowsOf("message", ORG_A)).map((r) => [r.id, r.body_sha256]),
    );

    const dry = await backfill(ORG_A, { dryRun: true, batchSize: 5 });
    expect(dry.dryRun).toBe(true);
    expect(dry.tables.message.wouldMigrate).toBe(before.message);
    expect(dry.tables.message_revision.wouldMigrate).toBe(before.revision);
    expect(dry.complete).toBe(false);
    expect(await legacyCount("message", ORG_A)).toBe(before.message); // nothing written

    // a run that stops early (maxRows) leaves a consistent half-migrated tenant, and says so
    const part = await backfill(ORG_A, { batchSize: 5, maxRows: 7 });
    expect(part.stoppedBy).toBe("max_rows");
    expect(part.complete).toBe(false);
    expect(part.tables.message.migrated).toBe(7);
    expect(part.remainingLegacy.message).toBe(before.message - 7);
    await allRowsVerify(ORG_A); // mixed-scheme rows all open and verify

    // resume: finishes, reports completion by count
    const rest = await backfill(ORG_A, { batchSize: 5 });
    expect(rest.complete).toBe(true);
    expect(rest.remainingLegacy).toEqual({
      message: 0,
      message_revision: 0,
      message_poll_option: 0,
    });
    expect(await legacyCount("message", ORG_A)).toBe(0);
    expect(await legacyCount("message_revision", ORG_A)).toBe(0);
    const all = await rowsOf("message", ORG_A);
    expect(all.every((r) => r.v === 2)).toBe(true);
    for (const r of all)
      if (hashesBefore.has(r.id)) expect(r.body_sha256).toBe(hashesBefore.get(r.id));
    await allRowsVerify(ORG_A);

    // idempotent: nothing left to do
    const again = await backfill(ORG_A, { batchSize: 5 });
    expect(again.tables.message.scanned + again.tables.message_revision.scanned).toBe(0);
    expect(again.complete).toBe(true);

    // hash_verify (heads AND revisions) is clean across the migration
    const verify = await runHashVerifyForOrg(
      {
        db: handle.db,
        cipher: ringCipher,
        messageHolds: NO_MESSAGE_HOLDS,
        sampleLimit: 1000,
        randomSampleSize: 100,
      },
      ORG_A,
    );
    expect(verify.scanned).toBeGreaterThan(0);
    expect(verify.mismatched).toBe(0);

    // audit: one batch row per committed batch and one run summary with the completion evidence
    const runRows = (
      await admin.query(
        `SELECT context FROM audit_event WHERE event_type='m36.body_backfill.run' AND organization_id=$1 ORDER BY created_at`,
        [ORG_A],
      )
    ).rows;
    expect(runRows.at(-1)?.context).toMatchObject({
      complete: true,
      remainingLegacy: { message: 0, message_revision: 0, message_poll_option: 0 },
    });
    expect(
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM audit_event WHERE event_type='m36.body_backfill.batch' AND organization_id=$1`,
          [ORG_A],
        )
      ).rows[0].n,
    ).toBeGreaterThan(2);
  });

  it("backfill is tenant-scoped: running it for org B leaves org A's legacy rows alone, and B's ring cannot open A's bodies", async () => {
    const dmA = await dmOf(legacyService, ORG_A, "a1", "a2");
    const dmB = await dmOf(legacyService, ORG_B, "b1", "b2");
    await send(legacyService, ORG_A, dmA.channelId, "a1", "A legacy");
    await send(legacyService, ORG_B, dmB.channelId, "b1", "B legacy 1");
    await send(legacyService, ORG_B, dmB.channelId, "b1", "B legacy 2");
    const aBefore = await legacyCount("message", ORG_A);
    expect(aBefore).toBe(1);
    const report = await backfill(ORG_B);
    expect(report.complete).toBe(true);
    expect(report.tables.message.migrated).toBe(2);
    expect(await legacyCount("message", ORG_A)).toBe(aBefore); // untouched
    // cross-tenant: org A cannot decrypt org B's ring body, whichever ring DEK it holds
    const bRing = (await rowsOf("message", ORG_B))[0] as Row;
    expect(bRing.v).toBe(2);
    await expect(ringCipher.open(ORG_A, bRing.body_cipher)).rejects.toThrow();
    // and org B's own row opens
    expect(messageBodySha256(await ringCipher.open(ORG_B, bRing.body_cipher))).toBe(
      bRing.body_sha256,
    );
  });

  it("a concurrent edit during the backfill is not lost and nothing is sealed twice (compare-and-swap)", async () => {
    const dm = await dmOf(legacyService, ORG_A, "a1", "a2");
    const m1 = await send(legacyService, ORG_A, dm.channelId, "a1", "will be edited mid-run");
    await send(legacyService, ORG_A, dm.channelId, "a1", "untouched sibling");
    let fired = false;
    const first = await backfill(ORG_A, {
      beforeWrite: async (table) => {
        if (fired || table !== "message") return;
        fired = true;
        await edit(
          legacyService,
          ORG_A,
          "a1",
          m1.messageId,
          "edited while the backfill held the old bytes",
        );
      },
    });
    expect(first.tables.message.skippedConcurrent).toBe(1);
    expect(first.tables.message.migrated).toBeGreaterThanOrEqual(1);
    // the edit survived: the head reads as the edited text, still legacy, never overwritten by the stale re-seal
    const page = await legacyService.listMessages(ORG_A, {
      channelId: dm.channelId,
      userId: users.a2 as string,
    });
    expect(page.messages.find((x) => x.messageId === m1.messageId)?.body).toBe(
      "edited while the backfill held the old bytes",
    );
    expect(first.complete).toBe(false);
    const second = await backfill(ORG_A);
    expect(second.complete).toBe(true);
    expect(second.tables.message.skippedConcurrent).toBe(0);
    await allRowsVerify(ORG_A);
    const head = (await rowsOf("message", ORG_A)).find((r) => r.id === m1.messageId) as Row;
    expect(head.v).toBe(2);
  });

  it("a row whose plaintext hash does not match is reported, audited and never re-sealed", async () => {
    const dm = await dmOf(legacyService, ORG_A, "a1", "a2");
    const m = await send(legacyService, ORG_A, dm.channelId, "a1", "tampered");
    await admin.query(`UPDATE message SET body_sha256=$2 WHERE id=$1`, [
      m.messageId,
      "f".repeat(64),
    ]);
    const report = await backfill(ORG_A);
    expect(report.tables.message.hashMismatch).toBe(1);
    expect(report.tables.message.migrated).toBe(0);
    expect(report.complete).toBe(false);
    expect(report.remainingLegacy.message).toBe(1);
    expect((await rowsOf("message", ORG_A)).find((r) => r.id === m.messageId)?.v).toBe(1);
    expect(
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM audit_event WHERE event_type='m36.integrity.hash_mismatch' AND resource_id=$1`,
          [m.messageId],
        )
      ).rows[0].n,
    ).toBe(1);
    await admin.query(`DELETE FROM message WHERE id=$1`, [m.messageId]);
  });

  it("backfill skips a message under an active legal hold (migration 1138 guard), counts it, and migrates the rest", async () => {
    const dm = await dmOf(legacyService, ORG_A, "a1", "a2");
    const held = await send(legacyService, ORG_A, dm.channelId, "a1", "held legacy body");
    const free = await send(legacyService, ORG_A, dm.channelId, "a1", "free legacy body");
    const holdId = (
      await admin.query(
        `INSERT INTO legal_hold (organization_id, name, criteria, reason, applied_by)
         VALUES ($1,'wp56-backfill','{"channelIds":[]}'::jsonb,'backfill vs hold suite',$2) RETURNING id`,
        [ORG_A, users.a1],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO legal_hold_message (organization_id, legal_hold_id, message_id) VALUES ($1,$2,$3)`,
      [ORG_A, holdId, held.messageId],
    );
    const report = await backfill(ORG_A);
    expect(report.tables.message.skippedLegalHold).toBe(1);
    expect(report.tables.message.migrated).toBeGreaterThanOrEqual(1);
    expect(report.complete).toBe(false);
    expect(report.remainingLegacy.message).toBe(1);
    const rows = await rowsOf("message", ORG_A);
    expect(rows.find((r) => r.id === held.messageId)?.v).toBe(1);
    expect(rows.find((r) => r.id === free.messageId)?.v).toBe(2);
    expect(
      (
        await admin.query(
          `SELECT coalesce(sum((context->>'skippedLegalHold')::int),0)::int AS n FROM audit_event
            WHERE event_type='m36.body_backfill.batch' AND resource_id=$1`,
          [report.runId],
        )
      ).rows[0].n,
    ).toBe(1);
    await admin.query(`UPDATE legal_hold SET status='released', released_at=now() WHERE id=$1`, [
      holdId,
    ]);
    const after = await backfill(ORG_A);
    expect(after.tables.message.skippedLegalHold).toBe(0);
    expect(after.complete).toBe(true);
    expect((await rowsOf("message", ORG_A)).find((r) => r.id === held.messageId)?.v).toBe(2);
  });

  it("rotation: a new DEK version seals new bodies, old ring bodies stay readable by their recorded version", async () => {
    const dm = await dmOf(ringService, ORG_A, "a1", "a2");
    const pre = await send(ringService, ORG_A, dm.channelId, "a1", "sealed under v1");
    const preRow = (await rowsOf("message", ORG_A)).find((r) => r.id === pre.messageId) as Row;
    const old = (
      await admin.query(
        `SELECT encode(current_dek_kek_wrapped_ciphertext,'base64') AS w, current_dek_kek_id AS k FROM tenant_key_ring WHERE organization_id=$1`,
        [ORG_A],
      )
    ).rows[0] as { w: string; k: string };
    const next = await kekAdapter.mintAndWrapDek({ organizationId: ORG_A });
    await admin.query(
      `UPDATE tenant_key_ring SET current_dek_version='v2',
         current_dek_kek_wrapped_ciphertext=decode($2,'base64'), current_dek_kek_id=$3,
         prior_dek_versions=$4::jsonb, dek_last_rotated_at=now()
       WHERE organization_id=$1`,
      [
        ORG_A,
        next.wrappedCiphertextB64,
        next.kekId,
        JSON.stringify([
          {
            version: "v1",
            kekWrappedCiphertext: old.w,
            kekId: old.k,
            rotatedAt: new Date().toISOString(),
          },
        ]),
      ],
    );
    cache.invalidate(ORG_A);
    const post = await send(ringService, ORG_A, dm.channelId, "a1", "sealed under v2");
    const postRow = (await rowsOf("message", ORG_A)).find((r) => r.id === post.messageId) as Row;
    expect(postRow.body_cipher.subarray(2, 4).toString("ascii")).toBe("v2");
    expect(preRow.body_cipher.subarray(2, 4).toString("ascii")).toBe("v1");
    const page = await ringService.listMessages(ORG_A, {
      channelId: dm.channelId,
      userId: users.a2 as string,
      limit: 200,
    });
    const bodies = page.messages.map((x) => x.body);
    expect(bodies).toContain("sealed under v1");
    expect(bodies).toContain("sealed under v2");
    await allRowsVerify(ORG_A);
  });

  it("boot signals: cross-tenant legacy counts over the platform column grant, and the fail-closed key check", async () => {
    registerPlatformJob(M36_BODY_LEGACY_COUNT_JOB_ID);
    const dmB = await dmOf(legacyService, ORG_B, "b1", "b2");
    await send(legacyService, ORG_B, dmB.channelId, "b1", "one more legacy row for the count");
    const expected = (
      await admin.query(`SELECT count(*)::int AS n FROM message WHERE body_envelope_version=1`)
    ).rows[0].n as number;
    const counts = await countLegacyBodiesAllTenants({
      platformDb: platformHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M36_BODY_LEGACY_COUNT_JOB_ID,
    });
    expect(counts.message).toBe(expected);
    expect(expected).toBeGreaterThan(0);
    const keyOk = Buffer.alloc(32, 1).toString("base64");
    expect(
      assertLegacyBodyKeyAvailable(counts, {
        NODE_ENV: "production",
        MESSAGING_ENCRYPTION_KEY: keyOk,
      }).state,
    ).toBe("legacy_rows_key_present");
    expect(() => assertLegacyBodyKeyAvailable(counts, { NODE_ENV: "production" })).toThrow(
      LegacyBodyKeyMissingError,
    );
    expect(assertLegacyBodyKeyAvailable(counts, { NODE_ENV: "development" }).state).toBe(
      "legacy_rows_key_missing",
    );
    // nothing legacy left: the key may be absent (the retired state)
    expect(
      assertLegacyBodyKeyAvailable(
        { message: 0, message_revision: 0, message_poll_option: 0 },
        { NODE_ENV: "production" },
      ).state,
    ).toBe("ring_only");
  });

  it("crypto-shred: destroying the ring makes every ring-sealed body unreadable; legacy-sealed rows are NOT shredded; the backfill refuses", async () => {
    const dmB = await dmOf(ringService, ORG_B, "b1", "b2");
    const ringMsg = await send(ringService, ORG_B, dmB.channelId, "b1", "to be shredded");
    const legacyRowB = await send(
      legacyService,
      ORG_B,
      dmB.channelId,
      "b1",
      "legacy row survives the shred",
    );
    const ringRow = (await rowsOf("message", ORG_B)).find((r) => r.id === ringMsg.messageId) as Row;
    expect(await ringCipher.open(ORG_B, ringRow.body_cipher)).toBe("to be shredded");
    const sharedCipher = createMessageBodyCipher({ sealScheme: "ring" });
    expect(await sharedCipher.open(ORG_B, ringRow.body_cipher)).toBe("to be shredded"); // warms the shared cache

    const certId = (
      await admin.query(
        `INSERT INTO destruction_certificate (organization_id, data_class, record_count, date_range_start, date_range_end, method, status)
         VALUES ($1,'saas_tenant_platform_class',1, now() - interval '2 years', now() - interval '1 year','crypto_erase','approved') RETURNING id`,
        [ORG_B],
      )
    ).rows[0].id as string;
    await admin.query("UPDATE tenant_account SET status='destruction_pending' WHERE id=$1", [
      accountOf[ORG_B],
    ]);
    await admin.query("SELECT set_config('app.destroyed_by_membership_id',$1,false)", [
      "33333333-3333-4333-8333-333333330453",
    ]);
    await admin.query("SELECT m34_destroy_tenant_key_ring($1,$2)", [accountOf[ORG_B], certId]);
    // An in-process cipher on the SHARED cache (what production uses) opened this body before the destroy:
    // it keeps working inside the TTL until the shred hook drops the cache, and fails the instant it does.
    expect(await sharedCipher.open(ORG_B, ringRow.body_cipher)).toBe("to be shredded");
    invalidateMessageBodyKeys(); // index.ts destroyTenantKeyRing calls exactly this right after the destroy commits
    await expect(sharedCipher.open(ORG_B, ringRow.body_cipher)).rejects.toBeInstanceOf(
      BodyKeyUnavailableError,
    );
    cache.invalidate(ORG_B);

    await expect(ringCipher.open(ORG_B, ringRow.body_cipher)).rejects.toThrow(/destroyed/i);
    // reads never degrade to an empty or placeholder body: the key error reaches the caller (503), not a blank message
    await expect(
      ringService.listMessages(ORG_B, { channelId: dmB.channelId, userId: users.b2 as string }),
    ).rejects.toBeInstanceOf(BodyKeyUnavailableError);
    // a DESTROYED ring is the authorised shred: hash_verify skips the tenant's bodies (no mismatch, no endless retry)
    const verifyDeps = {
      db: handle.db,
      cipher: ringCipher,
      messageHolds: NO_MESSAGE_HOLDS,
      sampleLimit: 1000,
      randomSampleSize: 100,
    };
    const mismatchCount = async (org: string) =>
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM audit_event WHERE event_type='m36.integrity.hash_mismatch' AND organization_id=$1",
          [org],
        )
      ).rows[0].n as number;
    const mismatchesBefore = await mismatchCount(ORG_B);
    const shredded = await runHashVerifyForOrg(verifyDeps, ORG_B);
    expect(shredded.mismatched).toBe(0);
    expect(shredded.skippedDeletedTenant).toBeGreaterThan(0);
    expect(await mismatchCount(ORG_B)).toBe(mismatchesBefore);
    // ...but a plain key OUTAGE (live ring, provider down) fails the run: not tampering, and not silently passed
    const outage = createMessageBodyCipher({
      ringCache: createRingDekCache({
        dekForOrg: async () => {
          throw new Error("platform pool down");
        },
        dekForOrgVersion: async () => {
          throw new Error("platform pool down");
        },
      }),
    });
    const mismatchesA = await mismatchCount(ORG_A);
    await expect(
      runHashVerifyForOrg({ ...verifyDeps, cipher: outage }, ORG_A),
    ).rejects.toBeInstanceOf(BodyKeyUnavailableError);
    expect(await mismatchCount(ORG_A)).toBe(mismatchesA);
    const legacy = (await rowsOf("message", ORG_B)).find(
      (r) => r.id === legacyRowB.messageId,
    ) as Row;
    // the documented gap: a legacy-sealed body (and any backup of one) is readable with MESSAGING_ENCRYPTION_KEY alone
    expect(await legacyCipher.open(ORG_B, legacy.body_cipher)).toBe(
      "legacy row survives the shred",
    );
    await expect(backfill(ORG_B)).rejects.toThrow(/destroyed/i);
  });
  it("poll option labels ride the same backfill: legacy label -> ring, exact plaintext, other orgs untouched, app role cannot re-seal", async () => {
    const dm = await dmOf(legacyService, ORG_A, "a1", "a2");
    const carrier = await send(legacyService, ORG_A, dm.channelId, "a1", "poll carrier");
    const poll = (
      await admin.query(
        `INSERT INTO message_poll (organization_id, channel_id, message_id, created_by_user_id)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [ORG_A, dm.channelId, carrier.messageId, users.a1],
      )
    ).rows[0].id as string;
    const labels = ["Option one", "Option two", "Zwei \u00fcber \u{1F44D}"];
    const legacyLabels = await Promise.all(labels.map((l) => legacyCipher.seal(ORG_A, l)));
    for (const [i, sealed] of legacyLabels.entries()) {
      await admin.query(
        `INSERT INTO message_poll_option (organization_id, poll_id, position, label_cipher) VALUES ($1,$2,$3,$4)`,
        [ORG_A, poll, i, sealed.cipher],
      );
    }
    const versions = async (org: string) =>
      (
        await admin.query(
          `SELECT label_envelope_version AS v, count(*)::int AS n FROM message_poll_option WHERE organization_id=$1 GROUP BY 1`,
          [org],
        )
      ).rows;
    expect(await versions(ORG_A)).toEqual([{ v: 1, n: 3 }]);

    // the request-path role may not re-seal a label (EXECUTE is the operator carrier's alone)
    const opt = (
      await admin.query(
        `SELECT id, label_cipher FROM message_poll_option WHERE organization_id=$1 AND position=0`,
        [ORG_A],
      )
    ).rows[0] as { id: string; label_cipher: Buffer };
    await expect(
      withOrgContext(handle.db, systemOrgContext(ORG_A), (tx) =>
        (tx as unknown as DbClient).execute(
          sql`SELECT m36_reseal_poll_option(${ORG_A}::uuid, ${opt.id}::uuid, ${opt.label_cipher}::bytea, ${Buffer.concat([Buffer.from([2]), randomBytes(60)])}::bytea)`,
        ),
      ),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/permission denied for function/i) },
    });

    const dry = await backfill(ORG_A, { dryRun: true });
    expect(dry.tables.message_poll_option.wouldMigrate).toBe(3);
    expect(dry.remainingLegacy.message_poll_option).toBe(3);
    expect(await versions(ORG_A)).toEqual([{ v: 1, n: 3 }]);

    const run = await backfill(ORG_A);
    expect(run.tables.message_poll_option).toMatchObject({ scanned: 3, migrated: 3, failed: 0 });
    expect(run.remainingLegacy.message_poll_option).toBe(0);
    expect(run.complete).toBe(true);
    expect(await versions(ORG_A)).toEqual([{ v: 2, n: 3 }]);
    const after = (
      await admin.query(
        `SELECT label_cipher FROM message_poll_option WHERE organization_id=$1 ORDER BY position`,
        [ORG_A],
      )
    ).rows as { label_cipher: Buffer }[];
    expect(await Promise.all(after.map((r) => ringCipher.open(ORG_A, r.label_cipher)))).toEqual(
      labels,
    );
    // re-running is a no-op
    const again = await backfill(ORG_A);
    expect(again.tables.message_poll_option.scanned).toBe(0);
  });
});
