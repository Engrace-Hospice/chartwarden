/**
 * M36 WP 1.5 — attachments via M22, LIVE Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 * The real route stack (real Authorization Contract + `channel_visibility` ABAC + the Postgres IdempotencyStore + the
 * catalog-validating transactional outbox publisher) over a fake in-memory object store (never the shared MinIO) and
 * the deterministic built-in scanner (EICAR + type mismatch) behind a switch that simulates the scanner being down.
 *
 * Exit criteria proved here: an infected sample is never delivered to any member; a pending one is invisible to every
 * recipient; a revoked member / another org / a non-member cannot fetch (same answer as a random id); every successful
 * open writes exactly one attachment_access_event; signed access expires; cross-user / cross-org / re-binding on send
 * is rejected; authorize and complete replay idempotently; the scan sweep is wired into the composition root.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m36:attachments:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { type DbClient, createDbClient } from "@wardenx/db";
import type { IdempotencyStore } from "@wardenx/shared";
import { DegradedError } from "@wardenx/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import {
  ATTACHMENT_UPLOAD_TTL_SECONDS,
  ERASE_UPLOAD_URL_GRACE_MS,
  EXPIRED_SCAN_RETRY_INTERVAL_MS,
  MAX_INLINE_SCAN_ATTEMPTS,
  MAX_OPEN_UPLOADS_PER_USER,
  MAX_ORG_SCAN_FAILURES_PER_TICK,
  MAX_PENDING_SCAN_AGE_MS,
  MAX_QUARANTINED_UPLOADS_PER_USER,
  OBJECT_MISSING_MIN_SPAN_MS,
  ORPHAN_UPLOAD_GRACE_MS,
  QUARANTINED_UPLOAD_WINDOW_MS,
  SCAN_RETRY_BASE_MS,
  SCAN_RETRY_MAX_MS,
  SCAN_UNAVAILABLE_ATTEMPTS,
  UNBOUND_UPLOAD_REAP_AGE_MS,
  eraseLockName,
} from "../src/modules/36-messaging/attachments/attachment-policy";
import type {
  AttachmentStoragePort,
  ScanPort,
} from "../src/modules/36-messaging/attachments/attachment-ports";
import { createInlineScanGate } from "../src/modules/36-messaging/attachments/attachment-scan-gate";
import { attachmentScanTick } from "../src/modules/36-messaging/attachments/attachment-scan-worker";
import { createBuiltinScanner } from "../src/modules/36-messaging/attachments/attachment-scanners";
import { createAttachmentService } from "../src/modules/36-messaging/attachments/attachment-service-db";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { registerAttachmentRoutes } from "../src/modules/36-messaging/routes/attachment-routes";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const KEK = randomBytes(32);
const ORG_A = "11111111-1111-4111-8111-1111000f0005";
const ORG_B = "22222222-2222-4222-8222-2222000f0005";
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const SECRET_FILE_NAME = "WP15-Jane-Doe-hospice-intake.pdf";
const NEVER_LEAK = [
  "objectKey",
  "object_key",
  "documentRef",
  "document_ref",
  "sha256Hex",
  "messaging/",
];

const pdfBytes = (tag: string, extra = "") =>
  new TextEncoder().encode(`%PDF-1.4\n% ${tag}\n${extra}\n%%EOF`);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = ["clinical_rn"];
  request.context.locationIds = [];
}

/** A fake M22-shaped object store: PUTs are simulated by the test, GET URLs expire against the test clock. */
function createFakeStorage(clock: { now: number }) {
  const objects = new Map<string, { bytes: Uint8Array; mime: string }>();
  const ttlsRequested: number[] = [];
  const downloadMimeTypes: string[] = [];
  const destroyed: string[] = [];
  /** Every presignUpload call (the size the PUT was bound to). */
  const presigned: { objectKey: string; byteSize: number }[] = [];
  /** Ordered log of storage calls that matter for sequencing (ensureBucket before presignUpload). */
  const calls: string[] = [];
  const ensureFailure = { on: false };
  /** Failure injection for destroyObject: a key containing this text throws (a store that cannot reach MinIO). */
  const destroyFailure = { onKeyIncluding: null as string | null, keys: new Set<string>() };
  /** Failure injection for readBytes: every read for this org throws (a tenant bucket answering 5xx). */
  const readFailure = { forOrg: null as string | null };
  /** Called with the object key just before the object is destroyed (to observe what still exists at that moment). */
  const destroyHook: { before: ((objectKey: string) => Promise<void>) | null } = { before: null };
  const key = (org: string, objectKey: string) => `${org}/${objectKey}`;
  const port: AttachmentStoragePort = {
    async ensureBucket() {
      calls.push("ensureBucket");
      if (ensureFailure.on) throw new DegradedError("attachment-storage", "unavailable");
    },
    async presignUpload({ organizationId, objectKey, byteSize, ttlSeconds }) {
      calls.push("presignUpload");
      presigned.push({ objectKey, byteSize });
      return {
        url: `https://objects.test/put/${key(organizationId, objectKey)}?sig=put`,
        headers: { "x-amz-checksum-sha256": "enforced" },
        expiresAt: new Date(clock.now + ttlSeconds * 1000).toISOString(),
      };
    },
    async inspect({ organizationId, objectKey }) {
      const found = objects.get(key(organizationId, objectKey));
      return found
        ? { byteSize: found.bytes.length, mimeType: found.mime, sha256Hex: sha256(found.bytes) }
        : null;
    },
    async readBytes({ organizationId, objectKey }) {
      if (readFailure.forOrg === organizationId) throw new Error("bucket answered 503");
      return objects.get(key(organizationId, objectKey))?.bytes ?? null;
    },
    async destroyObject({ organizationId, objectKey }) {
      await destroyHook.before?.(objectKey);
      if (destroyFailure.keys.has(objectKey)) throw new Error("object store unreachable");
      if (destroyFailure.onKeyIncluding && objectKey.includes(destroyFailure.onKeyIncluding)) {
        throw new Error("object store unreachable");
      }
      objects.delete(key(organizationId, objectKey));
      destroyed.push(objectKey);
    },
    async presignDownload({ organizationId, objectKey, mimeType, ttlSeconds }) {
      ttlsRequested.push(ttlSeconds);
      downloadMimeTypes.push(mimeType);
      const expires = clock.now + ttlSeconds * 1000;
      return {
        url: `https://objects.test/get/${key(organizationId, objectKey)}?exp=${expires}`,
        expiresAt: new Date(expires).toISOString(),
      };
    },
  };
  return {
    port,
    objects,
    ttlsRequested,
    downloadMimeTypes,
    destroyed,
    presigned,
    calls,
    ensureFailure,
    destroyFailure,
    readFailure,
    destroyHook,
    /** The client's PUT to the presigned target. */
    put(org: string, objectKey: string, bytes: Uint8Array, mime = "application/pdf") {
      objects.set(key(org, objectKey), { bytes, mime });
    },
    /** What the object store does with a presigned GET: refuse once the signature has expired. */
    fetchUrl(url: string): 200 | 403 {
      const exp = Number(new URL(url).searchParams.get("exp"));
      return clock.now <= exp ? 200 : 403;
    },
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const VOLATILE_KEYS = new Set(["requestId", "correlationId", "timestamp", "traceId"]);
/** Status + body with ids and per-request fields masked, so a real id and a random id compare exactly. */
function shape(res: { statusCode: number; body: string }): string {
  let body: unknown = res.body;
  try {
    body = JSON.parse(res.body);
  } catch {
    // non-JSON: compared verbatim
  }
  const scrub = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(scrub)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([k]) => !VOLATILE_KEYS.has(k))
              .map(([k, x]) => [k, scrub(x)]),
          )
        : typeof v === "string"
          ? v.replace(UUID, "<id>")
          : v;
  return `${res.statusCode} ${JSON.stringify(scrub(body))}`;
}

describe.skipIf(!DB_URL)("M36 WP 1.5 attachments — LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  /** A login that is actually `wardenx_destruction`: the only credential that may DELETE message_attachment. */
  let destroyer: { db: DbClient; close: () => Promise<void> };
  let routeService: ReturnType<typeof createDbMessagingRouteService>;
  let app: FastifyInstance;
  let storage: ReturnType<typeof createFakeStorage>;
  let attachments: ReturnType<typeof createAttachmentService>;
  // Rows are stamped by the database clock, the service reads this one: a hard-coded date makes every
  // "ages out after 24 h" assertion depend on the wall clock being before that date + 1 min.
  const clock = { now: Date.now() };
  const scanner = { down: false };
  /** A failed scan is retried with exponential backoff: move the fake clock past the longest wait so the sweep is due. */
  const pastBackoff = () => {
    clock.now += SCAN_RETRY_MAX_MS + 1_000;
  };
  const scanErrors: unknown[] = [];
  let u1: string; // uploader / sender
  let u2: string; // recipient
  let outsider: string; // in org A, member of no relevant channel
  let bUser: string; // org B
  let dm: string; // u1 <-> u2
  let dm2: string; // u1 <-> outsider

  const flakyScanner: ScanPort = {
    name: "builtin-signature",
    async scan(input) {
      if (scanner.down) throw new Error("scanner unreachable");
      return createBuiltinScanner().scan(input);
    },
  };

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
        `wp15-${suffix}@x.test`,
        `WP15 ${suffix}`,
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [id, organizationId],
    );
    return id;
  };

  const as = (userId: string, org = ORG_A, key?: string) => ({
    "x-test-user": userId,
    "x-test-org": org,
    ...(key ? { "idempotency-key": key } : {}),
  });
  const count = async (sql: string, params: unknown[] = []) =>
    (await admin.query(sql, params)).rows[0].n as number;

  const authorize = (
    userId: string,
    channelId: string,
    bytes: Uint8Array,
    over: Record<string, unknown> = {},
    org = ORG_A,
    key: string = randomUUID(),
  ) =>
    app.inject({
      method: "POST",
      url: "/api/v1/messaging/attachments/uploads",
      headers: as(userId, org, key),
      payload: {
        channelId,
        fileName: SECRET_FILE_NAME,
        contentType: "application/pdf",
        byteSize: bytes.length,
        sha256Hex: sha256(bytes),
        ...over,
      },
    });
  const complete = (userId: string, id: string, org = ORG_A, key: string = randomUUID()) =>
    app.inject({
      method: "POST",
      url: `/api/v1/messaging/attachments/${id}/complete`,
      headers: as(userId, org, key),
      payload: {},
    });
  const access = (userId: string, id: string, org = ORG_A) =>
    app.inject({
      method: "GET",
      url: `/api/v1/messaging/attachments/${id}/access`,
      headers: as(userId, org),
    });
  const statusOf = (userId: string, id: string, org = ORG_A) =>
    app.inject({
      method: "GET",
      url: `/api/v1/messaging/attachments/${id}`,
      headers: as(userId, org),
    });
  const send = (
    userId: string,
    channelId: string,
    attachmentIds: string[],
    org = ORG_A,
    body = "see attached",
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/messaging/channels/${channelId}/messages`,
      headers: as(userId, org, randomUUID()),
      payload: { body, attachments: attachmentIds.map((attachmentId) => ({ attachmentId })) },
    });
  const list = (userId: string, channelId: string, org = ORG_A) =>
    app.inject({
      method: "GET",
      url: `/api/v1/messaging/channels/${channelId}/messages?limit=100`,
      headers: as(userId, org),
    });

  /** authorize -> client PUT -> complete. Returns the attachment id and the complete response. */
  async function uploaded(
    userId: string,
    channelId: string,
    bytes: Uint8Array,
    opts: { complete?: boolean; over?: Record<string, unknown> } = {},
  ) {
    const res = await authorize(userId, channelId, bytes, opts.over);
    expect(res.statusCode).toBe(201);
    const { attachmentId } = res.json() as { attachmentId: string };
    const row = (
      await admin.query(`SELECT object_key FROM message_attachment WHERE id=$1`, [attachmentId])
    ).rows[0];
    storage.put(ORG_A, row.object_key, bytes);
    const done = opts.complete === false ? null : await complete(userId, attachmentId);
    return { attachmentId, done };
  }

  const attachmentsOf = (res: { json(): unknown }, messageId: string) =>
    ((
      res.json() as { messages: Array<{ messageId: string; attachments?: unknown[] }> }
    ).messages.find((m) => m.messageId === messageId)?.attachments ?? []) as Array<{
      attachmentId: string;
      availability: string;
      fileName: string;
    }>;

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  /** A port call that never answers by itself and tears down `cleanupMs` AFTER the abort signal fires (a socket closing). */
  const stopsOnAbort = (
    signal: AbortSignal | undefined,
    cleanupMs: number,
    onStopped: () => void,
  ): Promise<never> =>
    new Promise<never>((_, reject) => {
      signal?.addEventListener("abort", () => {
        setTimeout(() => {
          onStopped();
          reject(new Error("work torn down"));
        }, cleanupMs);
      });
    });
  /** Two fresh members of ORG_A and the DM between them (no per-user history, so caps and quotas start at zero). */
  async function freshUploader(tag: string, org = ORG_A) {
    const user = await seedUser(`${tag}-a`, org);
    const other = await seedUser(`${tag}-b`, org);
    const channel = (await routeService.openDm(org, user, other)).channelId;
    return { user, other, channel };
  }
  /** authorize through a service directly, then simulate the client PUT. */
  async function directUpload(
    svc: ReturnType<typeof createAttachmentService>,
    who: { user: string; channel: string },
    bytes: Uint8Array,
    org = ORG_A,
  ) {
    const auth = await svc.authorize(org, {
      userId: who.user,
      channelId: who.channel,
      fileName: "r.pdf",
      contentType: "application/pdf",
      byteSize: bytes.length,
      sha256Hex: sha256(bytes),
    });
    const key = (
      await admin.query(`SELECT object_key FROM message_attachment WHERE id=$1`, [
        auth.attachmentId,
      ])
    ).rows[0].object_key as string;
    storage.put(org, key, bytes);
    return { attachmentId: auth.attachmentId, key };
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
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wp15-a','A','A'),($2,'wp15-b','B','B')`,
      [ORG_A, ORG_B],
    );
    u1 = await seedUser("u1", ORG_A);
    u2 = await seedUser("u2", ORG_A);
    outsider = await seedUser("out", ORG_A);
    bUser = await seedUser("b", ORG_B);
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wp15_destroyer') THEN
         CREATE ROLE wp15_destroyer LOGIN PASSWORD 'wp15_destroyer_pw' IN ROLE wardenx_destruction; END IF; END $$;`,
    );
    const destroyerUrl = new URL(DB_URL as string);
    destroyerUrl.username = "wp15_destroyer";
    destroyerUrl.password = "wp15_destroyer_pw";
    destroyer = createDbClient({ connectionString: destroyerUrl.toString() });

    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M36_OUTBOX_EVENTS]));
    const outbox = {
      publish: (tx: unknown, e: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...e, callerModule: "m36" } as never),
    };
    routeService = createDbMessagingRouteService(handle.db, { kek: KEK, outbox: outbox as never });
    dm = (await routeService.openDm(ORG_A, u1, u2)).channelId;
    dm2 = (await routeService.openDm(ORG_A, u1, outsider)).channelId;

    storage = createFakeStorage(clock);
    attachments = createAttachmentService({
      db: handle.db,
      storage: storage.port,
      scanner: flakyScanner,
      outbox: outbox as never,
      canViewChannel: routeService.canViewChannel,
      now: () => new Date(clock.now),
      onScanError: (_ctx, error) => scanErrors.push(error),
      reaperDb: destroyer.db,
      userRequestsPerMinute: 1_000_000, // the suite authorizes hundreds of files per minute; the rate-limit tests build their own
    });

    const grants = createInMemoryEffectivePermissionStore(
      [
        [ORG_A, u1],
        [ORG_A, u2],
        [ORG_A, outsider],
        [ORG_B, bUser],
      ].map(([orgId, userId]) => ({
        orgId: orgId as string,
        userId: userId as string,
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["messaging.read", "messaging.send"],
          },
        ],
      })),
    );
    registerEffectivePermissionResolver(grants.store);
    const registry = createPredicateRegistry();
    registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return routeService.canViewChannel(ctx.organizationId, ctx.userId, channelId);
    });
    registerAbacRegistry(registry);
    const idempotencyStore: IdempotencyStore = createDbIdempotencyStore(handle.db);
    app = buildServer({
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore,
    });
    registerMessagingRoutes(app, { service: routeService });
    registerAttachmentRoutes(app, { service: attachments });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await handle?.close();
    await destroyer?.close();
    await admin?.end();
  });

  // The per-user open-upload cap counts every unbound upload, and the earlier tests leave many behind: start each test
  // from none (the cap tests below build their own state).
  beforeEach(async () => {
    await admin.query(`DELETE FROM message_attachment WHERE message_id IS NULL`);
    scanErrors.length = 0;
  });

  describe("authorize / complete", () => {
    it("authorize returns a presigned PUT and a pending, unattached status - and leaks no storage detail", async () => {
      const bytes = pdfBytes("authorize");
      const res = await authorize(u1, dm, bytes);
      expect(res.statusCode).toBe(201);
      const body = res.json() as {
        attachmentId: string;
        upload: { method: string; url: string; headers: Record<string, string>; expiresAt: string };
        status: { scanState: string; availability: string; attached: boolean };
      };
      expect(body.upload.method).toBe("PUT");
      expect(body.upload.url).toContain("https://objects.test/put/");
      expect(Date.parse(body.upload.expiresAt)).toBeGreaterThan(clock.now);
      expect(body.status).toMatchObject({
        scanState: "pending",
        availability: "uploading",
        attached: false,
      });
      const row = (
        await admin.query(`SELECT * FROM message_attachment WHERE id=$1`, [body.attachmentId])
      ).rows[0];
      expect(row.organization_id).toBe(ORG_A);
      expect(row.uploaded_by).toBe(u1);
      expect(row.message_id).toBeNull();
      expect(row.document_ref).toBeNull();
      expect(row.object_key).toBe(`messaging/${dm}/${body.attachmentId}`);
      expect(row.object_key).not.toContain(SECRET_FILE_NAME);
    });

    it("rejects a disallowed type (415), an oversize file (422), a bad checksum (422) and a path in the name (422)", async () => {
      const bytes = pdfBytes("policy");
      expect(
        (await authorize(u1, dm, bytes, { contentType: "application/x-msdownload" })).statusCode,
      ).toBe(415);
      expect((await authorize(u1, dm, bytes, { byteSize: 25_000_001 })).statusCode).toBe(422);
      expect((await authorize(u1, dm, bytes, { sha256Hex: "nope" })).statusCode).toBe(422);
      expect((await authorize(u1, dm, bytes, { fileName: "../../etc/passwd" })).statusCode).toBe(
        422,
      );
    });

    it("complete before the bytes landed is 409, with mismatched bytes is 422, and never marks the row completed", async () => {
      const bytes = pdfBytes("mismatch");
      const { attachmentId } = (await (await authorize(u1, dm, bytes)).json()) as {
        attachmentId: string;
      };
      expect((await complete(u1, attachmentId)).statusCode).toBe(409);
      const row = (
        await admin.query(`SELECT object_key FROM message_attachment WHERE id=$1`, [attachmentId])
      ).rows[0];
      // H1: the PUT was signed for exactly the declared size
      expect(storage.presigned.find((p) => p.objectKey === row.object_key)?.byteSize).toBe(
        bytes.length,
      );
      storage.put(ORG_A, row.object_key, pdfBytes("something else"));
      expect((await complete(u1, attachmentId)).statusCode).toBe(422);
      // H1: a mismatching object is destroyed at once, not left in the bucket
      expect(storage.destroyed).toContain(row.object_key);
      expect(storage.objects.has(`${ORG_A}/${row.object_key}`)).toBe(false);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM message_attachment WHERE id=$1 AND completed_at IS NOT NULL`,
          [attachmentId],
        ),
      ).toBe(0);
    });

    it("authorize and complete require an Idempotency-Key", async () => {
      const bytes = pdfBytes("nokey");
      const noKey = await app.inject({
        method: "POST",
        url: "/api/v1/messaging/attachments/uploads",
        headers: as(u1),
        payload: {
          channelId: dm,
          fileName: "a.pdf",
          contentType: "application/pdf",
          byteSize: bytes.length,
          sha256Hex: sha256(bytes),
        },
      });
      expect(noKey.statusCode).toBe(400);
      expect(JSON.stringify(noKey.json())).toContain("IDEMPOTENCY_KEY_REQUIRED");
      const done = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/attachments/${randomUUID()}/complete`,
        headers: as(u1),
        payload: {},
      });
      expect(done.statusCode).toBe(400);
    });

    it("M1: the presigned PUT URL is never stored in the idempotency table", async () => {
      const bytes = pdfBytes("no-capture");
      const key = randomUUID();
      const res = await authorize(u1, dm, bytes, {}, ORG_A, key);
      expect(res.statusCode).toBe(201);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM idempotency_key WHERE key=$1 OR response_body::text LIKE '%objects.test/put%'`,
          [key],
        ),
      ).toBe(0);
    });

    it("M1: retrying the same authorize (a fresh key) re-signs the open row: one row, one slot, one quota charge", async () => {
      const bytes = pdfBytes("retry-same");
      const before = await count(`SELECT count(*)::int AS n FROM message_attachment`);
      const first = await authorize(u1, dm, bytes);
      const second = await authorize(u1, dm, bytes);
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json().attachmentId).toBe(first.json().attachmentId);
      expect(second.json().upload.url).toContain("objects.test/put");
      expect(await count(`SELECT count(*)::int AS n FROM message_attachment`)).toBe(before + 1);
      // a different file is still a new row
      const other = await authorize(u1, dm, pdfBytes("retry-other"));
      expect(other.json().attachmentId).not.toBe(first.json().attachmentId);
    });

    it("M1: a retry is not reused once the row's upload window is nearly over", async () => {
      const bytes = pdfBytes("retry-late");
      const first = await authorize(u1, dm, bytes);
      clock.now += (ATTACHMENT_UPLOAD_TTL_SECONDS - 30) * 1000;
      const second = await authorize(u1, dm, bytes);
      expect(second.statusCode).toBe(201);
      expect(second.json().attachmentId).not.toBe(first.json().attachmentId);
    });

    it("M2: the bucket is ensured before the signing, and a failing ensure is a generic 503 with no row", async () => {
      const bytes = pdfBytes("ensure-order");
      storage.calls.length = 0;
      const ok = await authorize(u1, dm, bytes);
      expect(ok.statusCode).toBe(201);
      expect(storage.calls).toEqual(["ensureBucket", "presignUpload"]);

      const before = await count(`SELECT count(*)::int AS n FROM message_attachment`);
      storage.ensureFailure.on = true;
      try {
        const bad = await authorize(u1, dm, pdfBytes("ensure-fails"));
        expect(bad.statusCode).toBe(503);
        expect(storage.calls.at(-1)).toBe("ensureBucket"); // never reached signing
      } finally {
        storage.ensureFailure.on = false;
      }
      expect(await count(`SELECT count(*)::int AS n FROM message_attachment`)).toBe(before);
    });

    it("a replayed authorize (same key) returns the original and writes one row; a replayed complete is stable", async () => {
      const bytes = pdfBytes("replay");
      const key = randomUUID();
      const before = await count(`SELECT count(*)::int AS n FROM message_attachment`);
      const first = await authorize(u1, dm, bytes, {}, ORG_A, key);
      const second = await authorize(u1, dm, bytes, {}, ORG_A, key);
      expect(first.statusCode).toBe(201);
      expect(second.json().attachmentId).toBe(first.json().attachmentId);
      expect(await count(`SELECT count(*)::int AS n FROM message_attachment`)).toBe(before + 1);

      const id = first.json().attachmentId as string;
      const row = (await admin.query(`SELECT object_key FROM message_attachment WHERE id=$1`, [id]))
        .rows[0];
      storage.put(ORG_A, row.object_key, bytes);
      const completeKey = randomUUID();
      const c1 = await complete(u1, id, ORG_A, completeKey);
      const c2 = await complete(u1, id, ORG_A, completeKey);
      const c3 = await complete(u1, id, ORG_A, randomUUID()); // a fresh key is idempotent at the service too
      expect(c1.statusCode).toBe(200);
      expect(c2.json()).toEqual(c1.json());
      expect(c3.json().scanState).toBe("clean");
      expect(
        await count(
          `SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m36.attachment.cleared' AND aggregate_id=$1`,
          [id],
        ),
      ).toBe(1);
    });

    it("only the uploader can complete or poll status; others get the random-id answer", async () => {
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("owner"), { complete: false });
      const random = randomUUID();
      expect(shape(await complete(u2, attachmentId))).toBe(shape(await complete(u2, random)));
      expect(shape(await statusOf(u2, attachmentId))).toBe(shape(await statusOf(u2, random)));
      expect((await statusOf(u1, attachmentId)).statusCode).toBe(200);
    });

    it("a stranger cannot authorize into a channel: the answer for a random channel id", async () => {
      const bytes = pdfBytes("stranger");
      const real = await authorize(outsider, dm, bytes);
      const random = await authorize(outsider, randomUUID(), bytes);
      expect(real.statusCode).toBe(404);
      expect(shape(real)).toBe(shape(random));
      expect(shape(await authorize(bUser, dm, bytes, {}, ORG_B))).toBe(shape(random));
    });
  });

  describe("scan gating: clean is delivered", () => {
    it("a clean attachment is visible to the recipient, opens with a short signed URL, and every open is exactly one event", async () => {
      const bytes = pdfBytes("clean");
      const { attachmentId, done } = await uploaded(u1, dm, bytes);
      expect(done?.json().scanState).toBe("clean");
      const sent = await send(u1, dm, [attachmentId]);
      expect(sent.statusCode).toBe(201);
      const messageId = sent.json().messageId as string;

      const view = await list(u2, dm);
      expect(attachmentsOf(view, messageId)).toEqual([
        expect.objectContaining({
          attachmentId,
          availability: "available",
          fileName: SECRET_FILE_NAME,
        }),
      ]);
      for (const leak of NEVER_LEAK) expect(view.body).not.toContain(leak);

      const before = await count(
        `SELECT count(*)::int AS n FROM attachment_access_event WHERE attachment_id=$1`,
        [attachmentId],
      );
      const open = await access(u2, attachmentId);
      expect(open.statusCode).toBe(200);
      expect(open.headers["cache-control"]).toBe("no-store");
      const opened = open.json() as { url: string; expiresAt: string; fileName: string };
      expect(opened.url).toContain("https://objects.test/get/");
      expect(storage.fetchUrl(opened.url)).toBe(200);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM attachment_access_event WHERE attachment_id=$1`,
          [attachmentId],
        ),
      ).toBe(before + 1);
      const event = (
        await admin.query(
          `SELECT * FROM attachment_access_event WHERE attachment_id=$1 ORDER BY occurred_at DESC LIMIT 1`,
          [attachmentId],
        )
      ).rows[0];
      expect(event).toMatchObject({
        organization_id: ORG_A,
        user_id: u2,
        action: "open",
        reason: null,
      });
      await access(u1, attachmentId); // the sender opening their own file is an open too
      expect(
        await count(
          `SELECT count(*)::int AS n FROM attachment_access_event WHERE attachment_id=$1 AND action='open'`,
          [attachmentId],
        ),
      ).toBe(before + 2);
      // and the M4 write-audit trigger recorded each event
      expect(
        await count(
          `SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='attachment_access_event' AND after->>'attachment_id'=$1`,
          [attachmentId],
        ),
      ).toBe(before + 2);
    });

    it("signed access expires: the URL lives <= 120 s and is refused after", async () => {
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("expiry"));
      const sent = await send(u1, dm, [attachmentId]);
      expect(sent.statusCode).toBe(201);
      const opened = (await access(u2, attachmentId)).json() as { url: string; expiresAt: string };
      expect(Math.max(...storage.ttlsRequested)).toBeLessThanOrEqual(120);
      expect(Date.parse(opened.expiresAt) - clock.now).toBeLessThanOrEqual(120_000);
      expect(storage.fetchUrl(opened.url)).toBe(200);
      clock.now += 121_000;
      expect(storage.fetchUrl(opened.url)).toBe(403);
      // a fresh open re-authorizes and mints a new URL
      expect(
        storage.fetchUrl(((await access(u2, attachmentId)).json() as { url: string }).url),
      ).toBe(200);
    });

    it("an unattached clean upload can be previewed by its uploader only", async () => {
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("preview"));
      expect((await access(u1, attachmentId)).statusCode).toBe(200);
      const random = randomUUID();
      const denied = await access(u2, attachmentId);
      expect(shape(denied)).toBe(shape(await access(u2, random)));
      expect(
        await count(
          `SELECT count(*)::int AS n FROM attachment_access_event WHERE attachment_id=$1 AND action='denied' AND reason='not_attached'`,
          [attachmentId],
        ),
      ).toBe(1);
    });
  });

  describe("scan gating: pending is invisible", () => {
    it("pending is accepted on send, hidden from every recipient, shown to the uploader as scanning, and appears once clean", async () => {
      scanner.down = true;
      const { attachmentId, done } = await uploaded(u1, dm, pdfBytes("pending"));
      scanner.down = false;
      expect(done?.json()).toMatchObject({ scanState: "pending", availability: "scanning" });
      expect(scanErrors.length).toBeGreaterThan(0); // the failed scan was reported, not swallowed into "clean"

      const sent = await send(u1, dm, [attachmentId]);
      expect(sent.statusCode).toBe(201);
      const messageId = sent.json().messageId as string;

      expect(attachmentsOf(await list(u2, dm), messageId)).toEqual([]);
      expect(attachmentsOf(await list(u1, dm), messageId)).toEqual([
        expect.objectContaining({ attachmentId, availability: "scanning" }),
      ]);
      const random = randomUUID();
      const blocked = await access(u2, attachmentId);
      expect(shape(blocked)).toBe(shape(await access(u2, random)));
      expect(
        await count(
          `SELECT count(*)::int AS n FROM attachment_access_event WHERE attachment_id=$1 AND action='open'`,
          [attachmentId],
        ),
      ).toBe(0);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM attachment_access_event WHERE attachment_id=$1 AND action='denied' AND reason='not_clean'`,
          [attachmentId],
        ),
      ).toBe(1);
      expect(shape(await access(u1, attachmentId))).toBe(shape(await access(u1, random))); // even the uploader: not until clean

      // the sweep (the worker's tick body) clears it
      pastBackoff();
      const tick = await attachmentScanTick({
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        service: attachments,
      });
      expect(tick.clean).toBeGreaterThanOrEqual(1);
      expect(attachmentsOf(await list(u2, dm), messageId)).toEqual([
        expect.objectContaining({ attachmentId, availability: "available" }),
      ]);
      expect((await access(u2, attachmentId)).statusCode).toBe(200);
    });

    it("a scanner outage never produces a clean verdict and the sweep defers instead of failing", async () => {
      scanner.down = true;
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("outage"));
      pastBackoff();
      const tick = await attachmentScanTick({
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        service: attachments,
      });
      scanner.down = false;
      expect(tick.deferred).toBeGreaterThanOrEqual(1);
      expect(tick.clean + tick.quarantined).toBe(0);
      const row = (
        await admin.query(`SELECT scan_state, scanned_at FROM message_attachment WHERE id=$1`, [
          attachmentId,
        ])
      ).rows[0];
      expect(row).toEqual({ scan_state: "pending", scanned_at: null });
    });

    it("no scanner bound at all: nothing ever leaves pending", async () => {
      const noScanner = createAttachmentService({
        db: handle.db,
        storage: storage.port,
        canViewChannel: routeService.canViewChannel,
      });
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("noscanner"), { complete: false });
      const row = (
        await admin.query(`SELECT object_key FROM message_attachment WHERE id=$1`, [attachmentId])
      ).rows[0];
      expect(row.object_key).toBeTruthy();
      expect(await noScanner.scanPendingForOrg(ORG_A)).toEqual({
        clean: 0,
        quarantined: 0,
        deferred: 0,
        scannerFailures: 0,
        storeFailures: 0,
        scanUnavailable: 0,
      });
    });
  });

  describe("infected sample (EICAR) is never delivered", () => {
    it("quarantined at complete: cannot be sent, opened, listed, or learned about except by the uploader's own status", async () => {
      const bytes = pdfBytes("eicar-1", EICAR);
      const { attachmentId, done } = await uploaded(u1, dm, bytes);
      expect(done?.json()).toMatchObject({ scanState: "quarantined", availability: "blocked" });

      const bound = await send(u1, dm, [attachmentId]);
      expect(bound.statusCode).toBe(422);
      expect(bound.json().error?.code ?? bound.json().code).toBe("ATTACHMENT_NOT_BINDABLE");
      expect(shape(await access(u2, attachmentId))).toBe(shape(await access(u2, randomUUID())));
      expect(shape(await access(u1, attachmentId))).toBe(shape(await access(u1, randomUUID())));
      expect((await statusOf(u1, attachmentId)).json().availability).toBe("blocked");
      expect(
        await count(
          `SELECT count(*)::int AS n FROM attachment_access_event WHERE attachment_id=$1 AND action='open'`,
          [attachmentId],
        ),
      ).toBe(0);
    });

    it("sent while still pending, then scanned infected: never visible to the recipient or the sender, one event, one audit row", async () => {
      scanner.down = true;
      const bytes = pdfBytes("eicar-2", EICAR);
      const { attachmentId } = await uploaded(u1, dm, bytes);
      scanner.down = false;
      const sent = await send(u1, dm, [attachmentId]);
      expect(sent.statusCode).toBe(201);
      const messageId = sent.json().messageId as string;

      pastBackoff();
      await attachmentScanTick({
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        service: attachments,
      });

      for (const viewer of [u1, u2]) {
        const view = await list(viewer, dm);
        expect(attachmentsOf(view, messageId)).toEqual([]);
        expect(view.body).not.toContain(attachmentId);
        const mine = (view.json() as { messages: unknown[] }).messages.filter(
          (m) => (m as { messageId: string }).messageId === messageId,
        );
        expect(JSON.stringify(mine)).not.toContain(SECRET_FILE_NAME);
        expect(shape(await access(viewer, attachmentId))).toBe(
          shape(await access(viewer, randomUUID())),
        );
      }
      expect(
        await count(
          `SELECT count(*)::int AS n FROM attachment_access_event WHERE attachment_id=$1 AND action='open'`,
          [attachmentId],
        ),
      ).toBe(0);

      const events = (
        await admin.query(
          `SELECT payload FROM outbox_event WHERE event_type='m36.attachment.quarantined' AND aggregate_id=$1`,
          [attachmentId],
        )
      ).rows;
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        organizationId: ORG_A,
        attachmentId,
        channelId: dm,
        messageId,
        signature: "Eicar-Test-Signature",
      });
      expect(JSON.stringify(events[0].payload)).not.toContain(SECRET_FILE_NAME);
      const audits = (
        await admin.query(
          `SELECT severity, context FROM audit_event WHERE event_type='m36.attachment.quarantined' AND resource_id=$1`,
          [attachmentId],
        )
      ).rows;
      expect(audits).toHaveLength(1);
      expect(audits[0].severity).toBe("critical");
      expect(JSON.stringify(audits[0].context)).not.toContain(SECRET_FILE_NAME);
      // the generic row-level audit never carries the file name either
      expect(
        await count(
          `SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='message_attachment' AND (before::text LIKE '%Jane%' OR after::text LIKE '%Jane%')`,
        ),
      ).toBe(0);
    });

    it("a verdict is final: the database refuses quarantined -> clean and clean -> pending", async () => {
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("eicar-3", EICAR));
      await expect(
        admin.query(`UPDATE message_attachment SET scan_state='clean' WHERE id=$1`, [attachmentId]),
      ).rejects.toThrow(/final/);
      const clean = await uploaded(u1, dm, pdfBytes("final-clean"));
      await expect(
        admin.query(
          `UPDATE message_attachment SET scan_state='pending', scanned_at=NULL WHERE id=$1`,
          [clean.attachmentId],
        ),
      ).rejects.toThrow(/final/);
    });

    it("a file whose bytes are not its declared type is quarantined", async () => {
      const { done } = await uploaded(u1, dm, new TextEncoder().encode("MZ pretend executable"), {
        over: { contentType: "application/pdf" },
      });
      expect(done?.json().scanState).toBe("quarantined");
    });
  });

  describe("access is re-authorized on every open", () => {
    it("a removed member gets the answer for a random id, immediately", async () => {
      const room = (await routeService.openDm(ORG_A, u1, outsider)).channelId; // dm2
      expect(room).toBe(dm2);
      const { attachmentId } = await uploaded(u1, dm2, pdfBytes("revoked"));
      expect((await send(u1, dm2, [attachmentId])).statusCode).toBe(201);
      expect((await access(outsider, attachmentId)).statusCode).toBe(200);
      await admin.query(
        `UPDATE channel_member SET removed_at=now() WHERE channel_id=$1 AND user_id=$2`,
        [dm2, outsider],
      );
      const denied = await access(outsider, attachmentId);
      expect(shape(denied)).toBe(shape(await access(outsider, randomUUID())));
      expect(denied.statusCode).toBe(404);
      // and the removed member cannot list the channel either (the same refusal a random channel gets)
      expect(shape(await list(outsider, dm2))).toBe(shape(await list(outsider, randomUUID())));
    });

    it("another org and an in-org non-member get the answer for a random id (status too)", async () => {
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("idor"));
      expect((await send(u1, dm, [attachmentId])).statusCode).toBe(201);
      const random = randomUUID();
      for (const [who, org] of [
        [bUser, ORG_B],
        [outsider, ORG_A],
      ] as const) {
        const real = await access(who, attachmentId, org);
        expect(real.statusCode).toBe(404);
        expect(shape(real)).toBe(shape(await access(who, random, org)));
        expect(shape(await statusOf(who, attachmentId, org))).toBe(
          shape(await statusOf(who, random, org)),
        );
        expect(shape(await complete(who, attachmentId, org))).toBe(
          shape(await complete(who, random, org)),
        );
        expect(real.body).not.toContain(SECRET_FILE_NAME);
      }
      expect(
        await count(
          `SELECT count(*)::int AS n FROM attachment_access_event WHERE attachment_id=$1 AND user_id IN ($2,$3)`,
          [attachmentId, bUser, outsider],
        ),
      ).toBe(0);
    });

    it("a deleted message's attachment is not openable (and the denial is logged)", async () => {
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("deleted"));
      const sent = await send(u1, dm, [attachmentId]);
      const messageId = sent.json().messageId as string;
      expect((await access(u2, attachmentId)).statusCode).toBe(200);
      const del = await app.inject({
        method: "DELETE",
        url: `/api/v1/messaging/messages/${messageId}`,
        headers: as(u1),
      });
      expect(del.statusCode).toBe(204);
      expect((await access(u2, attachmentId)).statusCode).toBe(404);
      expect(attachmentsOf(await list(u2, dm), messageId)).toEqual([]);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM attachment_access_event WHERE attachment_id=$1 AND action='denied' AND reason='message_deleted'`,
          [attachmentId],
        ),
      ).toBe(1);
    });
  });

  describe("binding on send", () => {
    it("rejects another user's, another org's, an already-bound, a wrong-channel, an unfinished and a made-up attachment with one uniform 422", async () => {
      const mine = await uploaded(u1, dm, pdfBytes("bind-mine"));
      const wrongChannel = await uploaded(u1, dm2, pdfBytes("bind-wrong-channel"));
      const unfinished = await uploaded(u1, dm, pdfBytes("bind-unfinished"), { complete: false });
      const messagesBefore = await count(`SELECT count(*)::int AS n FROM message`);

      const attempts = [
        send(u2, dm, [mine.attachmentId]), // someone else's upload
        send(bUser, dm, [mine.attachmentId], ORG_B), // another org (also not even a member)
        send(u1, dm, [wrongChannel.attachmentId]),
        send(u1, dm, [unfinished.attachmentId]),
        send(u1, dm, [randomUUID()]),
        send(u1, dm, [mine.attachmentId, mine.attachmentId]), // duplicate in one send
      ];
      const results = await Promise.all(attempts);
      const bindFailures = [results[0], results[2], results[3], results[4], results[5]] as Array<
        (typeof results)[number]
      >;
      for (const res of bindFailures) expect(res.statusCode).toBe(422);
      expect(new Set(bindFailures.map(shape)).size).toBe(1); // no oracle: every reason answers the same
      // org B cannot even address org A's channel: the refusal a random channel id gets
      expect(shape(results[1] as (typeof results)[number])).toBe(
        shape(await send(bUser, randomUUID(), [mine.attachmentId], ORG_B)),
      );
      expect(await count(`SELECT count(*)::int AS n FROM message`)).toBe(messagesBefore); // each refusal rolled the message back

      expect((await send(u1, dm, [mine.attachmentId])).statusCode).toBe(201);
      const again = await send(u1, dm, [mine.attachmentId]);
      expect(again.statusCode).toBe(422); // already bound to a message
    });

    it("the old client-supplied-metadata shape is refused, never trusted", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${dm}/messages`,
        headers: as(u1, ORG_A, randomUUID()),
        payload: {
          body: "x",
          attachments: [
            { storageKey: "k", fileName: "f.pdf", contentType: "application/pdf", byteSize: 1 },
          ],
        },
      });
      expect(res.statusCode).toBe(422);
    });

    it("the database itself refuses a cross-tenant link and a second binding", async () => {
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("db-backstop"));
      const sent = await send(u1, dm, [attachmentId]);
      const otherMessage = (await send(u1, dm, [], ORG_A, "another")).json().messageId as string;
      await expect(
        admin.query(`UPDATE message_attachment SET message_id=$1 WHERE id=$2`, [
          otherMessage,
          attachmentId,
        ]),
      ).rejects.toThrow(/already bound/);
      expect(sent.statusCode).toBe(201);
      // org B row pointing at an org A message: the composite FK refuses it
      await expect(
        admin.query(
          `INSERT INTO message_attachment (organization_id, channel_id, message_id, uploaded_by, mime_type, byte_size, filename)
           VALUES ($1,$2,$3,$4,'application/pdf',1,'x.pdf')`,
          [ORG_B, dm, otherMessage, bUser],
        ),
      ).rejects.toThrow(/foreign key|violates/i);
    });
  });

  describe("RLS as the real wardenx_app role", () => {
    async function asApp<T>(org: string | null, fn: (c: Client) => Promise<T>): Promise<T> {
      const c = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await c.connect();
      try {
        await c.query("BEGIN");
        if (org) await c.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
        const out = await fn(c);
        await c.query("ROLLBACK");
        return out;
      } finally {
        await c.end();
      }
    }

    it("connects as a non-superuser, non-BYPASSRLS role; message_attachment and the access log are FORCEd", async () => {
      const me = await asApp(
        ORG_A,
        async (c) =>
          (await c.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`))
            .rows[0],
      );
      expect(me).toEqual({ rolsuper: false, rolbypassrls: false });
      const forced = (
        await admin.query(
          `SELECT relname FROM pg_class WHERE relname IN ('message_attachment','attachment_access_event') AND relrowsecurity AND relforcerowsecurity`,
        )
      ).rows;
      expect(forced.map((r) => r.relname).sort()).toEqual([
        "attachment_access_event",
        "message_attachment",
      ]);
    });

    it("org B sees none of org A's attachments or opens; with no org context nothing is readable", async () => {
      expect(await count(`SELECT count(*)::int AS n FROM message_attachment`)).toBeGreaterThan(0);
      for (const table of ["message_attachment", "attachment_access_event"]) {
        expect(
          await asApp(
            ORG_B,
            async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
          ),
        ).toBe(0);
        expect(
          await asApp(
            null,
            async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
          ),
        ).toBe(0);
      }
    });

    it("an INSERT carrying another org's organization_id is rejected by WITH CHECK", async () => {
      await expect(
        asApp(ORG_B, (c) =>
          c.query(
            `INSERT INTO message_attachment (organization_id, channel_id, uploaded_by, mime_type, byte_size, filename)
             VALUES ($1,$2,$3,'application/pdf',1,'x.pdf')`,
            [ORG_A, dm, u1],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it("the access log is append-only for the app role: no UPDATE, no DELETE", async () => {
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("append-only"));
      await access(u1, attachmentId);
      await expect(
        asApp(ORG_A, (c) => c.query(`UPDATE attachment_access_event SET reason='x'`)),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        asApp(ORG_A, (c) => c.query(`DELETE FROM attachment_access_event`)),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe("tenant erase", () => {
    it("is keyed on organization_id: unbound uploads and the access log go too", async () => {
      const { createDrizzleMessagingEraseStore } = await import(
        "../src/modules/36-messaging/erasers/messaging-eraser"
      );
      const orgC = "33333333-3333-4333-8333-3333000f0005";
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wp15-c','C','C')`,
        [orgC],
      );
      const cUser = await seedUser("c1", orgC);
      const cUser2 = await seedUser("c2", orgC);
      const cDm = (await routeService.openDm(orgC, cUser, cUser2)).channelId;
      const ins = await admin.query(
        `INSERT INTO message_attachment (organization_id, channel_id, uploaded_by, mime_type, byte_size, filename)
         VALUES ($1,$2,$3,'application/pdf',1,'orphan.pdf') RETURNING id`,
        [orgC, cDm, cUser],
      );
      await admin.query(
        `INSERT INTO attachment_access_event (organization_id, attachment_id, user_id, action, reason) VALUES ($1,$2,$3,'denied','not_clean')`,
        [orgC, ins.rows[0].id, cUser],
      );
      // The erase credential is wardenx_destruction: the app role has no DELETE on message_attachment (1075).
      const store = createDrizzleMessagingEraseStore(destroyer.db);
      await store.deleteStructuralRows(orgC);
      expect(
        await count(`SELECT count(*)::int AS n FROM message_attachment WHERE organization_id=$1`, [
          orgC,
        ]),
      ).toBe(0);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM attachment_access_event WHERE organization_id=$1`,
          [orgC],
        ),
      ).toBe(0);
    });
  });

  describe("tenant erase destroys the BYTES (H1)", () => {
    let seq = 0;
    async function orgWithObjects(n: number) {
      const { createDrizzleMessagingEraseStore } = await import(
        "../src/modules/36-messaging/erasers/messaging-eraser"
      );
      seq += 1;
      const org = `44444444-4444-4444-8444-4444000f${String(seq).padStart(4, "0")}`;
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'E','E')`,
        [org, `wp15-erase-${seq}`],
      );
      const e1 = await seedUser(`erase-a${seq}`, org);
      const e2 = await seedUser(`erase-b${seq}`, org);
      const ch = (await routeService.openDm(org, e1, e2)).channelId;
      const keys: string[] = [];
      for (let i = 0; i < n; i += 1) {
        const id = randomUUID();
        const objectKey = `messaging/${ch}/${id}`;
        await admin.query(
          `INSERT INTO message_attachment (id, organization_id, channel_id, uploaded_by, mime_type, byte_size, filename, object_key, sha256_hex)
           VALUES ($1,$2,$3,$4,'application/pdf',5,'phi.pdf',$5,$6)`,
          [id, org, ch, e1, objectKey, "a".repeat(64)],
        );
        storage.put(org, objectKey, pdfBytes(`erase-${seq}-${i}`));
        keys.push(objectKey);
      }
      const rows = () =>
        count(`SELECT count(*)::int AS n FROM message_attachment WHERE organization_id=$1`, [org]);
      return { org, keys, rows, createDrizzleMessagingEraseStore };
    }

    it("destroys every object and then deletes the rows", async () => {
      const { org, keys, rows, createDrizzleMessagingEraseStore } = await orgWithObjects(3);
      const before = storage.destroyed.length;
      const store = createDrizzleMessagingEraseStore(destroyer.db, {
        attachmentStorage: storage.port,
      });
      await store.deleteStructuralRows(org);
      expect(storage.destroyed.slice(before).sort()).toEqual([...keys].sort());
      for (const k of keys) expect(storage.objects.has(`${org}/${k}`)).toBe(false);
      expect(await rows()).toBe(0);
    });

    it("a store failure mid-way throws with every row (every key) still in place; the retry completes", async () => {
      const { org, keys, rows, createDrizzleMessagingEraseStore } = await orgWithObjects(3);
      const store = createDrizzleMessagingEraseStore(destroyer.db, {
        attachmentStorage: storage.port,
      });
      storage.destroyFailure.onKeyIncluding = keys[1] as string;
      await expect(store.deleteStructuralRows(org)).rejects.toThrow(/unreachable/);
      expect(await rows()).toBe(3); // nothing deleted: the pointers survive, so the erase is retryable
      expect(storage.objects.has(`${org}/${keys[1]}`)).toBe(true);

      storage.destroyFailure.onKeyIncluding = null;
      await store.deleteStructuralRows(org);
      expect(await rows()).toBe(0);
      for (const k of keys) expect(storage.objects.has(`${org}/${k}`)).toBe(false);
    });

    it("attachments present and no object store bound: throws a typed DEGRADED error, deletes nothing", async () => {
      const { org, rows, createDrizzleMessagingEraseStore } = await orgWithObjects(2);
      const store = createDrizzleMessagingEraseStore(destroyer.db); // no attachmentStorage
      await expect(store.deleteStructuralRows(org)).rejects.toMatchObject({ code: "DEGRADED" });
      expect(await rows()).toBe(2);
    });

    it("without the destruction credential (no DELETE grant) it refuses BEFORE destroying any byte", async () => {
      const { org, keys, rows, createDrizzleMessagingEraseStore } = await orgWithObjects(3);
      const before = storage.destroyed.length;
      const store = createDrizzleMessagingEraseStore(handle.db, {
        attachmentStorage: storage.port,
      });
      await expect(store.deleteStructuralRows(org)).rejects.toMatchObject({ code: "DEGRADED" });
      expect(storage.destroyed.length).toBe(before); // nothing destroyed: no row left pointing at nothing
      for (const k of keys) expect(storage.objects.has(`${org}/${k}`)).toBe(true);
      expect(await rows()).toBe(3);
    });

    it("a role with the DELETE grant but no matching RLS policy is refused by the real-delete probe BEFORE any byte is destroyed", async () => {
      await admin.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wp15_selectonly') THEN
           CREATE ROLE wp15_selectonly LOGIN PASSWORD 'wp15_selectonly_pw'; END IF; END $$;`,
      );
      // A standalone role (a member of wardenx_app would inherit its FOR ALL policy): granted SELECT and the row-removal
      // privilege, but its only policy is a SELECT one, so the privilege check passes while RLS hides every row from it.
      await admin.query(`GRANT USAGE ON SCHEMA public TO wp15_selectonly`);
      await admin.query(`GRANT SELECT, DELETE ON message_attachment TO wp15_selectonly`);
      await admin.query(
        `CREATE POLICY wp15_selectonly_read ON message_attachment FOR SELECT TO wp15_selectonly
           USING (organization_id = current_setting('app.org_id', true)::uuid)`,
      );
      const url = new URL(DB_URL as string);
      url.username = "wp15_selectonly";
      url.password = "wp15_selectonly_pw";
      const odd = createDbClient({ connectionString: url.toString() });
      try {
        const { org, keys, rows, createDrizzleMessagingEraseStore } = await orgWithObjects(2);
        const before = storage.destroyed.length;
        const store = createDrizzleMessagingEraseStore(odd.db, { attachmentStorage: storage.port });
        await expect(store.deleteStructuralRows(org)).rejects.toMatchObject({ code: "DEGRADED" });
        expect(storage.destroyed.length).toBe(before); // nothing destroyed
        for (const k of keys) expect(storage.objects.has(`${org}/${k}`)).toBe(true);
        expect(await rows()).toBe(2);
      } finally {
        await odd.close();
        await admin.query(`DROP POLICY wp15_selectonly_read ON message_attachment`);
        await admin.query(`REVOKE ALL ON message_attachment FROM wp15_selectonly`);
      }
    });

    it("an upload that lands while the erase is running has its bytes destroyed too (no orphaned object)", async () => {
      const { org, keys, rows, createDrizzleMessagingEraseStore } = await orgWithObjects(2);
      const channel = (
        await admin.query(
          `SELECT channel_id FROM message_attachment WHERE organization_id=$1 LIMIT 1`,
          [org],
        )
      ).rows[0].channel_id as string;
      const uploader = (
        await admin.query(
          `SELECT uploaded_by FROM message_attachment WHERE organization_id=$1 LIMIT 1`,
          [org],
        )
      ).rows[0].uploaded_by as string;
      const lateId = randomUUID();
      const lateKey = `messaging/${channel}/${lateId}`;
      let injected = false;
      storage.destroyHook.before = async () => {
        if (injected) return;
        injected = true;
        storage.put(org, lateKey, pdfBytes("late-upload"));
        await admin.query(
          `INSERT INTO message_attachment (id, organization_id, channel_id, uploaded_by, mime_type, byte_size, filename, object_key, sha256_hex)
           VALUES ($1,$2,$3,$4,'application/pdf',5,'late.pdf',$5,$6)`,
          [lateId, org, channel, uploader, lateKey, "a".repeat(64)],
        );
      };
      try {
        const store = createDrizzleMessagingEraseStore(destroyer.db, {
          attachmentStorage: storage.port,
        });
        await store.deleteStructuralRows(org);
      } finally {
        storage.destroyHook.before = null;
      }
      expect(injected).toBe(true);
      expect(await rows()).toBe(0);
      expect(storage.objects.has(`${org}/${lateKey}`)).toBe(false);
      for (const k of keys) expect(storage.objects.has(`${org}/${k}`)).toBe(false);
    });

    it("the refusing port (MINIO_* unset) is loud too: the erase fails, the rows stay", async () => {
      const { createRefusingAttachmentStorage } = await import("../src/m36-attachment-storage");
      const { org, rows, createDrizzleMessagingEraseStore } = await orgWithObjects(1);
      const store = createDrizzleMessagingEraseStore(destroyer.db, {
        attachmentStorage: createRefusingAttachmentStorage(),
      });
      await expect(store.deleteStructuralRows(org)).rejects.toMatchObject({ code: "DEGRADED" });
      expect(await rows()).toBe(1);
    });
  });

  describe("least privilege for the app role (M1)", () => {
    async function asApp<T>(org: string, fn: (c: Client) => Promise<T>): Promise<T> {
      const c = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await c.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
        const out = await fn(c);
        await c.query("ROLLBACK");
        return out;
      } finally {
        await c.end();
      }
    }

    it("wardenx_app cannot DELETE message_attachment or attachment_access_event", async () => {
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("no-delete"));
      await access(u1, attachmentId);
      await expect(asApp(ORG_A, (c) => c.query(`DELETE FROM message_attachment`))).rejects.toThrow(
        /permission denied/i,
      );
      await expect(
        asApp(ORG_A, (c) => c.query(`DELETE FROM attachment_access_event`)),
      ).rejects.toThrow(/permission denied/i);
      // ...and the tenant eraser on the APP credential is refused up front (preflight), not silently run
      const { createDrizzleMessagingEraseStore } = await import(
        "../src/modules/36-messaging/erasers/messaging-eraser"
      );
      await expect(
        createDrizzleMessagingEraseStore(handle.db, {
          attachmentStorage: storage.port,
        }).deleteStructuralRows(ORG_A),
      ).rejects.toMatchObject({ code: "DEGRADED" });
    });

    it("UPDATE is a column grant: identity columns (file name, object key, checksum, channel) cannot be rewritten", async () => {
      await uploaded(u1, dm, pdfBytes("no-rewrite"), { complete: false });
      for (const set of [
        `filename='x.pdf'`,
        `object_key='messaging/other/key'`,
        `sha256_hex='${"b".repeat(64)}'`,
        `mime_type='text/plain'`,
        `byte_size=1`,
        `uploaded_by='${u2}'`,
      ]) {
        await expect(
          asApp(ORG_A, (c) => c.query(`UPDATE message_attachment SET ${set}`)),
        ).rejects.toThrow(/permission denied/i);
      }
    });

    it("cannot go pending -> clean without a completed upload (the guard trigger, not just the app)", async () => {
      await uploaded(u1, dm, pdfBytes("no-fast-clean"), { complete: false });
      await expect(
        asApp(ORG_A, (c) =>
          c.query(
            `UPDATE message_attachment SET scan_state='clean', scanned_at=now() WHERE completed_at IS NULL`,
          ),
        ),
      ).rejects.toThrow(/clean before its upload is completed/i);
    });

    it("a bind may only point at a message in the attachment's own channel", async () => {
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("cross-channel"));
      const otherChannelMessage = (await send(u1, dm2, [], ORG_A, "elsewhere")).json()
        .messageId as string;
      await expect(
        asApp(ORG_A, (c) =>
          c.query(`UPDATE message_attachment SET message_id=$1 WHERE id=$2`, [
            otherChannelMessage,
            attachmentId,
          ]),
        ),
      ).rejects.toThrow(/own channel/i);
    });

    it("the legitimate app updates still work: complete, bind on send, settle", async () => {
      const { attachmentId, done } = await uploaded(u1, dm, pdfBytes("legit"));
      expect(done?.json()).toMatchObject({ scanState: "clean" });
      expect((await send(u1, dm, [attachmentId])).statusCode).toBe(201);
    });
  });

  describe("open-upload cap (M3)", () => {
    it("the 21st open upload is a typed 429; finishing and sending one frees a slot; expired unfinished ones do not count", async () => {
      const open = (i: number) => authorize(u2, dm, pdfBytes(`cap-${i}`));
      const first = await uploaded(u2, dm, pdfBytes("cap-first"));
      for (let i = 1; i < 20; i += 1) expect((await open(i)).statusCode).toBe(201);
      const over = await open(20);
      expect(over.statusCode).toBe(429);
      expect(over.json()).toMatchObject({ error: { code: "TOO_MANY_OPEN_UPLOADS" } });
      // the cap is per user
      expect((await authorize(u1, dm, pdfBytes("cap-other-user"))).statusCode).toBe(201);
      // sending one frees a slot
      expect((await send(u2, dm, [first.attachmentId])).statusCode).toBe(201);
      expect((await open(21)).statusCode).toBe(201);
      expect((await open(22)).statusCode).toBe(429);
      // unfinished uploads whose URL expired no longer count
      clock.now += (ATTACHMENT_UPLOAD_TTL_SECONDS + 60) * 1000;
      try {
        expect((await open(23)).statusCode).toBe(201);
      } finally {
        clock.now -= (ATTACHMENT_UPLOAD_TTL_SECONDS + 60) * 1000;
      }
    });

    it("quarantined rows and rows older than the reap age do not count toward the OPEN cap (no permanent lock-out if the reaper is unbound)", async () => {
      const insert = (state: "pending" | "quarantined", createdAgoMs: number, n: number) =>
        admin.query(
          `INSERT INTO message_attachment (organization_id, channel_id, uploaded_by, mime_type, byte_size, filename,
             object_key, sha256_hex, completed_at, created_at, scan_state, scanned_at, scan_signature)
           SELECT $1::uuid,$2::uuid,$3::uuid,'application/pdf',5,'c.pdf','messaging/'||$2::text||'/'||gen_random_uuid(), repeat('a',64),
             $4::timestamptz, $4::timestamptz, $5, CASE WHEN $5='pending' THEN NULL ELSE $4::timestamptz END,
             CASE WHEN $5='pending' THEN NULL ELSE 'test-sig' END
           FROM generate_series(1,$6)`,
          [ORG_A, dm, u2, new Date(clock.now - createdAgoMs).toISOString(), state, n],
        );
      await insert("quarantined", 60_000, MAX_QUARANTINED_UPLOADS_PER_USER - 1);
      await insert("pending", UNBOUND_UPLOAD_REAP_AGE_MS + 3_600_000, 20);
      expect((await authorize(u2, dm, pdfBytes("cap-after-dead-rows"))).statusCode).toBe(201);
      // ...while live finished-unbound rows still count
      await insert("pending", 60_000, MAX_OPEN_UPLOADS_PER_USER - 1);
      expect((await authorize(u2, dm, pdfBytes("cap-live-rows"))).statusCode).toBe(429);
    });

    it("an authorize -> upload EICAR -> complete loop is capped: 20 flagged unbound rows per user per 24 h, then 429 until they age out", async () => {
      const eicar = new TextEncoder().encode(EICAR);
      for (let i = 0; i < MAX_QUARANTINED_UPLOADS_PER_USER; i += 1) {
        const res = await authorize(u2, dm, eicar, { contentType: "text/plain" });
        expect(res.statusCode).toBe(201);
        const id = (res.json() as { attachmentId: string }).attachmentId;
        const key = (
          await admin.query(`SELECT object_key FROM message_attachment WHERE id=$1`, [id])
        ).rows[0].object_key as string;
        storage.put(ORG_A, key, eicar, "text/plain");
        const done = await complete(u2, id);
        expect(done.json()).toMatchObject({ scanState: "quarantined" });
      }
      // Flagged rows no longer count toward the OPEN cap, but they have their own 24 h cap.
      const blocked = await authorize(u2, dm, eicar, { contentType: "text/plain" });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ error: { code: "TOO_MANY_QUARANTINED_UPLOADS" } });
      // The cap is per user, and a time bound (no lock-out forever if the reaper credential is missing).
      expect((await authorize(u1, dm, pdfBytes("flag-other-user"))).statusCode).toBe(201);
      // created_at is the DB's real clock while `now` is the fake one: age by a whole extra day so the test does not depend
      // on the time of day it runs.
      const aging = QUARANTINED_UPLOAD_WINDOW_MS * 2;
      clock.now += aging;
      try {
        expect((await authorize(u2, dm, pdfBytes("flag-aged-out"))).statusCode).toBe(201);
      } finally {
        clock.now -= aging;
      }
    });

    it("flagged files that were already bound to a message still count toward the 24 h cap (send-before-the-sweep cannot dodge it)", async () => {
      const boundUser = await seedUser("bound-flag-1", ORG_A);
      const boundOther = await seedUser("bound-flag-2", ORG_A);
      const boundDm = (await routeService.openDm(ORG_A, boundUser, boundOther)).channelId;
      const sent = await routeService.sendMessage(ORG_A, {
        channelId: boundDm,
        authorUserId: boundUser,
        body: "bound flagged",
      });
      await admin.query(
        `INSERT INTO message_attachment (organization_id, channel_id, uploaded_by, message_id, mime_type, byte_size, filename,
           object_key, sha256_hex, completed_at, created_at, scan_state, scanned_at, scan_signature)
         SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,'application/pdf',5,'b.pdf','messaging/'||$2::text||'/'||gen_random_uuid(), repeat('a',64),
           $5::timestamptz, $5::timestamptz, 'quarantined', $5::timestamptz, 'test-sig'
         FROM generate_series(1,$6)`,
        [
          ORG_A,
          boundDm,
          boundUser,
          sent.messageId,
          new Date(clock.now).toISOString(),
          MAX_QUARANTINED_UPLOADS_PER_USER,
        ],
      );
      const direct = createAttachmentService({
        db: handle.db,
        storage: storage.port,
        canViewChannel: routeService.canViewChannel,
        now: () => new Date(clock.now),
        userRequestsPerMinute: 1_000_000,
      });
      const bytes = pdfBytes("after-bound-flagged");
      await expect(
        direct.authorize(ORG_A, {
          userId: boundUser,
          channelId: boundDm,
          fileName: "r.pdf",
          contentType: "application/pdf",
          byteSize: bytes.length,
          sha256Hex: sha256(bytes),
        }),
      ).rejects.toMatchObject({ code: "TOO_MANY_QUARANTINED_UPLOADS", statusCode: 429 });
    });

    it("authorize and complete are rate limited per user (429 RATE_LIMITED); the limit is per user, not shared", async () => {
      // Fresh users: the limit counts every row a user created in the last minute, and u1/u2 have many from earlier tests.
      const rateUser = await seedUser("rate-1", ORG_A);
      const rateOther = await seedUser("rate-2", ORG_A);
      const rateDm = (await routeService.openDm(ORG_A, rateUser, rateOther)).channelId;
      const limited = createAttachmentService({
        db: handle.db,
        storage: storage.port,
        canViewChannel: routeService.canViewChannel,
        now: () => new Date(clock.now),
        userRequestsPerMinute: 3,
      });
      const input = (user: string, tag: string, channelId = rateDm) => {
        const bytes = pdfBytes(tag);
        return {
          userId: user,
          channelId,
          fileName: "r.pdf",
          contentType: "application/pdf",
          byteSize: bytes.length,
          sha256Hex: sha256(bytes),
        };
      };
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        ids.push((await limited.authorize(ORG_A, input(rateUser, `rate-${i}`))).attachmentId);
      }
      await expect(limited.authorize(ORG_A, input(rateUser, "rate-over"))).rejects.toMatchObject({
        code: "RATE_LIMITED",
        statusCode: 429,
      });
      expect(
        (await limited.authorize(ORG_A, input(rateOther, "rate-other"))).attachmentId,
      ).toBeTruthy();
      for (let i = 0; i < 3; i += 1) {
        await limited
          .complete(ORG_A, { userId: rateUser, attachmentId: ids[0] as string })
          .catch(() => undefined);
      }
      await expect(
        limited.complete(ORG_A, { userId: rateUser, attachmentId: ids[0] as string }),
      ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    });

    it("complete after the upload TTL is refused (410 UPLOAD_EXPIRED): expired rows cannot be revived past the open cap", async () => {
      const { attachmentId } = await uploaded(u2, dm, pdfBytes("late-complete"), {
        complete: false,
      });
      clock.now += (ATTACHMENT_UPLOAD_TTL_SECONDS + 1) * 1000;
      try {
        const late = await complete(u2, attachmentId);
        expect(late.statusCode).toBe(410);
        expect(late.json()).toMatchObject({ error: { code: "UPLOAD_EXPIRED" } });
      } finally {
        clock.now -= (ATTACHMENT_UPLOAD_TTL_SECONDS + 1) * 1000;
      }
      expect(
        await count(
          `SELECT count(*)::int AS n FROM message_attachment WHERE id=$1 AND completed_at IS NOT NULL`,
          [attachmentId],
        ),
      ).toBe(0);
      // within the TTL it still completes
      const fresh = await uploaded(u2, dm, pdfBytes("in-time-complete"));
      expect(fresh.done?.statusCode).toBe(200);
    });

    it("racing authorizes cannot slip past the cap", async () => {
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) => authorize(u2, dm, pdfBytes(`cap-race-${i}`))),
      );
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(20);
      expect(results.filter((r) => r.statusCode === 429)).toHaveLength(10);
    });
  });

  describe("orphan reaper (M3)", () => {
    const advance = (ms: number) => {
      clock.now += ms;
      return () => {
        clock.now -= ms;
      };
    };
    const pastGrace = ORPHAN_UPLOAD_GRACE_MS + ATTACHMENT_UPLOAD_TTL_SECONDS * 1000 + 1000;
    const exists = async (id: string) =>
      (await count(`SELECT count(*)::int AS n FROM message_attachment WHERE id=$1`, [id])) === 1;
    const keyOf = async (id: string) =>
      (await admin.query(`SELECT object_key FROM message_attachment WHERE id=$1`, [id])).rows[0]
        .object_key as string;

    it("destroys the object, then the row, of an abandoned upload; a live one and a bound one survive", async () => {
      const abandoned = await uploaded(u1, dm, pdfBytes("reap-abandoned"), { complete: false });
      const abandonedKey = await keyOf(abandoned.attachmentId);
      const bound = await uploaded(u1, dm, pdfBytes("reap-bound"));
      expect((await send(u1, dm, [bound.attachmentId])).statusCode).toBe(201);
      const restore = advance(pastGrace);
      try {
        const live = await uploaded(u1, dm, pdfBytes("reap-live"), { complete: false });
        const result = await attachments.reapOrphansForOrg(ORG_A);
        expect(result).toEqual({ reaped: 1, failed: 0 });
        expect(await exists(abandoned.attachmentId)).toBe(false);
        expect(storage.destroyed).toContain(abandonedKey);
        expect(storage.objects.has(`${ORG_A}/${abandonedKey}`)).toBe(false);
        expect(await exists(live.attachmentId)).toBe(true);
        expect(await exists(bound.attachmentId)).toBe(true);
      } finally {
        restore();
      }
    });

    it("a row whose object cannot be destroyed is kept (not orphaned bytes); the next run completes it", async () => {
      const abandoned = await uploaded(u1, dm, pdfBytes("reap-retry"), { complete: false });
      const key = await keyOf(abandoned.attachmentId);
      const restore = advance(pastGrace);
      try {
        storage.destroyFailure.onKeyIncluding = key;
        expect(await attachments.reapOrphansForOrg(ORG_A)).toEqual({ reaped: 0, failed: 1 });
        expect(await exists(abandoned.attachmentId)).toBe(true);
        storage.destroyFailure.onKeyIncluding = null;
        expect(await attachments.reapOrphansForOrg(ORG_A)).toEqual({ reaped: 1, failed: 0 });
        expect(await exists(abandoned.attachmentId)).toBe(false);
      } finally {
        storage.destroyFailure.onKeyIncluding = null;
        restore();
      }
    });

    it("a finished upload nobody sent for 7 days is reaped; at 6 days a send already refuses it", async () => {
      const stale = await uploaded(u1, dm, pdfBytes("reap-stale"));
      const aging = await uploaded(u1, dm, pdfBytes("reap-aging"));
      await admin.query(
        `UPDATE message_attachment SET created_at = now() - interval '8 days' WHERE id=$1`,
        [stale.attachmentId],
      );
      await admin.query(
        `UPDATE message_attachment SET created_at = now() - interval '6 days 1 hour' WHERE id=$1`,
        [aging.attachmentId],
      );
      expect((await send(u1, dm, [aging.attachmentId])).statusCode).toBe(422);
      expect(await attachments.reapOrphansForOrg(ORG_A)).toEqual({ reaped: 1, failed: 0 });
      expect(await exists(stale.attachmentId)).toBe(false);
      expect(await exists(aging.attachmentId)).toBe(true); // reaped on day 7, not before
    });

    it("25 permanently failing rows cannot starve the rows behind them: the reaper draws a different batch each tick", async () => {
      const insertAbandoned = async (n: number, failing: boolean) => {
        for (let i = 0; i < n; i += 1) {
          const id = randomUUID();
          const key = `messaging/${dm}/${id}`;
          await admin.query(
            `INSERT INTO message_attachment (id, organization_id, channel_id, uploaded_by, mime_type, byte_size, filename, object_key, sha256_hex, upload_expires_at, created_at)
             VALUES ($1,$2,$3,$4,'application/pdf',5,'a.pdf',$5,$6, now() - interval '2 days', now() - interval '${failing ? 3 : 2} days')`,
            [id, ORG_A, dm, u1, key, "a".repeat(64)],
          );
          storage.put(ORG_A, key, pdfBytes(`starve-${id}`));
          if (failing) storage.destroyFailure.keys.add(key);
        }
      };
      await insertAbandoned(25, true); // older: the old createdAt ordering picked exactly these 25 every tick
      await insertAbandoned(5, false);
      const restore = advance(pastGrace);
      try {
        let reaped = 0;
        for (let run = 0; run < 12 && reaped < 5; run += 1) {
          reaped += (await attachments.reapOrphansForOrg(ORG_A)).reaped;
        }
        expect(reaped).toBe(5);
        expect(
          await count(
            `SELECT count(*)::int AS n FROM message_attachment WHERE organization_id=$1 AND message_id IS NULL`,
            [ORG_A],
          ),
        ).toBe(25); // the failing rows are still there (retryable), the healthy ones are gone
      } finally {
        storage.destroyFailure.keys.clear();
        restore();
      }
    });

    it("without the destruction credential the reaper is a no-op (it never uses the app role)", async () => {
      const noReaper = createAttachmentService({
        db: handle.db,
        storage: storage.port,
        canViewChannel: routeService.canViewChannel,
        now: () => new Date(clock.now),
      });
      const abandoned = await uploaded(u1, dm, pdfBytes("reap-noop"), { complete: false });
      const restore = advance(pastGrace);
      try {
        expect(await noReaper.reapOrphansForOrg(ORG_A)).toEqual({ reaped: 0, failed: 0 });
        expect(await exists(abandoned.attachmentId)).toBe(true);
      } finally {
        restore();
      }
    });

    it("runs from the scheduled tick (the worker's body), not only by hand", async () => {
      const abandoned = await uploaded(u1, dm, pdfBytes("reap-tick"), { complete: false });
      const restore = advance(pastGrace);
      try {
        const tick = await attachmentScanTick({
          activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
          service: attachments,
        });
        expect(tick.reap.reaped).toBe(1);
        expect(await exists(abandoned.attachmentId)).toBe(false);
      } finally {
        restore();
      }
    });

    it("a hung destroy is ABORTED at its deadline: the row is kept for the next tick and the reap is not wedged", async () => {
      const abandoned = await uploaded(u1, dm, pdfBytes("reap-hung"), { complete: false });
      const key = await keyOf(abandoned.attachmentId);
      let stopped = false;
      const hangOne: AttachmentStoragePort = {
        ...storage.port,
        destroyObject: (args) =>
          args.objectKey === key
            ? stopsOnAbort(args.signal, 20, () => {
                stopped = true;
              })
            : storage.port.destroyObject(args),
      };
      const svc = createAttachmentService({
        db: handle.db,
        storage: hangOne,
        canViewChannel: routeService.canViewChannel,
        now: () => new Date(clock.now),
        reaperDb: destroyer.db,
        storageDeadlineMs: 60,
      });
      const restore = advance(pastGrace);
      try {
        const started = Date.now();
        const out = await svc.reapOrphansForOrg(ORG_A);
        expect(out.failed).toBeGreaterThanOrEqual(1);
        expect(stopped).toBe(true); // torn down, not abandoned to run on
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(await exists(abandoned.attachmentId)).toBe(true); // object not confirmed gone => the pointer stays
      } finally {
        restore();
      }
    });

    it("the reap has a time slice: zero starts nothing, a spent slice stops after the first destroy (which always runs)", async () => {
      await uploaded(u1, dm, pdfBytes("reap-slice-1"), { complete: false });
      await uploaded(u1, dm, pdfBytes("reap-slice-2"), { complete: false });
      const base = clock.now;
      const ticking: AttachmentStoragePort = {
        ...storage.port,
        destroyObject: async (args) => {
          clock.now += 5_000; // each destroy "takes" 5 s of the service's clock
          return storage.port.destroyObject(args);
        },
      };
      const svc = createAttachmentService({
        db: handle.db,
        storage: ticking,
        canViewChannel: routeService.canViewChannel,
        now: () => new Date(clock.now),
        reaperDb: destroyer.db,
      });
      clock.now += pastGrace;
      try {
        expect(await svc.reapOrphansForOrg(ORG_A, { budgetMs: 0 })).toEqual({
          reaped: 0,
          failed: 0,
        });
        const out = await svc.reapOrphansForOrg(ORG_A, { budgetMs: 1_000, limit: 25 });
        expect(out).toEqual({ reaped: 1, failed: 0 });
      } finally {
        clock.now = base;
      }
    });
  });

  describe("scan sweep resilience (M3)", () => {
    const tick = { n: 0 };
    const orgCtxs = new Map<string, { channel: string; user: string }>();
    /** (channel, uploader) for an org: A is the suite's own; any other org is seeded on first use. */
    const orgCtx = async (org: string): Promise<{ channel: string; user: string }> => {
      if (org === ORG_A) return { channel: dm, user: u1 };
      const known = orgCtxs.get(org);
      if (known) return known;
      if (org !== ORG_B) {
        await admin.query(
          `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'X','X') ON CONFLICT DO NOTHING`,
          [org, `wp15-x-${org.slice(0, 4)}${org.slice(-4)}`],
        );
      }
      const tag = `${org.slice(0, 4)}${org.slice(-4)}`;
      const first = org === ORG_B ? bUser : await seedUser(`x1-${tag}`, org);
      const other = await seedUser(`x2-${tag}`, org);
      const made = {
        channel: (await routeService.openDm(org, first, other)).channelId,
        user: first,
      };
      orgCtxs.set(org, made);
      return made;
    };
    const orgN = (n: number) => `55555555-5555-4555-8555-5555000f${String(n).padStart(4, "0")}`;
    /** A completed, still-pending row inserted directly (no inline scan), with its bytes in the fake store. */
    async function pendingRow(
      tag: string,
      opts: {
        completedAgoMs?: number;
        attempts?: number;
        org?: string;
        noObject?: boolean;
        lastAttemptAgoMs?: number;
        missingCount?: number;
        missingFirstAgoMs?: number;
      } = {},
    ) {
      const org = opts.org ?? ORG_A;
      const { channel, user: uploader } = await orgCtx(org);
      const bytes = pdfBytes(tag);
      const id = randomUUID();
      const objectKey = `messaging/${channel}/${id}`;
      if (!opts.noObject) storage.put(org, objectKey, bytes);
      tick.n += 1;
      await admin.query(
        `INSERT INTO message_attachment (id, organization_id, channel_id, uploaded_by, mime_type, byte_size, filename,
           object_key, sha256_hex, completed_at, scan_attempts, last_scan_attempt_at, object_missing_count, first_object_missing_at)
         VALUES ($1,$2,$3,$4,'application/pdf',$5,'p.pdf',$6,$7, $8::timestamptz, $9, $10::timestamptz, $11, $12::timestamptz)`,
        [
          id,
          org,
          channel,
          uploader,
          bytes.length,
          objectKey,
          sha256(bytes),
          new Date(clock.now - (opts.completedAgoMs ?? 60_000) + tick.n).toISOString(),
          opts.attempts ?? 0,
          opts.lastAttemptAgoMs === undefined
            ? null
            : new Date(clock.now - opts.lastAttemptAgoMs).toISOString(),
          opts.missingCount ?? 0,
          opts.missingFirstAgoMs === undefined
            ? null
            : new Date(clock.now - opts.missingFirstAgoMs).toISOString(),
        ],
      );
      return id;
    }
    const stateOf = async (id: string) =>
      (
        await admin.query(
          `SELECT scan_state, scan_signature, scan_attempts, object_missing_count FROM message_attachment WHERE id=$1`,
          [id],
        )
      ).rows[0] as {
        scan_state: string;
        scan_signature: string | null;
        scan_attempts: number;
        object_missing_count: number;
      };
    const poison = (tag: string): ScanPort => ({
      name: "poison-test",
      async scan(input) {
        if (Buffer.from(input.bytes).toString().includes(tag)) throw new Error("scanner choked");
        return createBuiltinScanner().scan(input);
      },
    });
    const service = (scanner: ScanPort) =>
      createAttachmentService({
        db: handle.db,
        storage: storage.port,
        scanner,
        canViewChannel: routeService.canViewChannel,
        now: () => new Date(clock.now),
      });

    it("a poison row goes to the back of the line instead of starving the rows behind it", async () => {
      const bad = await pendingRow("POISON-row"); // oldest: the old ordering would retry it forever
      const ok1 = await pendingRow("fine-1");
      const ok2 = await pendingRow("fine-2");
      const svc = service(poison("POISON"));
      const restore: Array<() => void> = [];
      try {
        const step = async () => {
          clock.now += 1000;
          restore.push(() => {
            clock.now -= 1000;
          });
          return svc.scanPendingForOrg(ORG_A, { limit: 1 });
        };
        expect(await step()).toMatchObject({ deferred: 1, clean: 0 }); // the poison row, first by age
        expect(await step()).toMatchObject({ clean: 1 }); // now behind it: fine-1
        expect(await step()).toMatchObject({ clean: 1 }); // fine-2
      } finally {
        for (const r of restore) r();
      }
      expect((await stateOf(ok1)).scan_state).toBe("clean");
      expect((await stateOf(ok2)).scan_state).toBe("clean");
      expect(await stateOf(bad)).toMatchObject({ scan_state: "pending", scan_attempts: 1 });
    });

    const EMPTY = {
      clean: 0,
      quarantined: 0,
      deferred: 0,
      scannerFailures: 0,
      storeFailures: 0,
      scanUnavailable: 0,
    };
    const tickOf = (
      svc: ReturnType<typeof service>,
      orgs: string[],
      extra: { nowMs?: () => number; budgetMs?: number } = {},
    ) =>
      attachmentScanTick({
        activeOrgs: {
          listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })),
        } as never,
        service: svc,
        ...extra,
      });

    it("no cross-org coupling: a hostile org (2 poison files) + an org with a broken bucket cannot stop healthy orgs sorted after them, tick after tick", async () => {
      const [hostile, orgC, orgD] = [orgN(7), orgN(1), orgN(2)];
      await pendingRow("POISON-a1", { org: hostile });
      await pendingRow("POISON-a2", { org: hostile });
      await pendingRow("POISON-a3", { org: hostile });
      const brokenB = await pendingRow("fine-but-bucket-down", { org: ORG_B });
      const cOk = await pendingRow("fine-c", { org: orgC });
      const dOk = await pendingRow("fine-d", { org: orgD });
      storage.readFailure.forOrg = ORG_B;
      try {
        const svc = service(poison("POISON"));
        // Every rotation of the order, poison org first or last: C and D are scanned in the FIRST tick regardless.
        for (const order of [
          [hostile, ORG_B, orgC, orgD],
          [orgD, orgC, ORG_B, hostile],
        ]) {
          pastBackoff();
          const result = await tickOf(svc, order);
          // A: 2 scanner failures (its cap), B: 1 store failure (one row) - charged to those orgs alone.
          expect(result.scannerFailures).toBe(MAX_ORG_SCAN_FAILURES_PER_TICK);
          expect(result.storeFailures).toBe(1);
        }
        expect((await stateOf(cOk)).scan_state).toBe("clean");
        expect((await stateOf(dOk)).scan_state).toBe("clean");
        expect((await stateOf(brokenB)).scan_state).toBe("pending"); // fail closed
        // A third tick: the poison org's next failure does not "re-open" anything for anyone (there is nothing shared).
        const cNext = await pendingRow("fine-c-2", { org: orgC });
        pastBackoff();
        const again = await tickOf(svc, [hostile, ORG_B, orgC, orgD]);
        expect(again.scannerFailures).toBe(MAX_ORG_SCAN_FAILURES_PER_TICK);
        expect((await stateOf(cNext)).scan_state).toBe("clean");
      } finally {
        storage.readFailure.forOrg = null;
      }
      // The tenant's bucket recovers: its own file is scanned next tick (a store failure never marked anything final).
      pastBackoff();
      expect(await tickOf(service(poison("POISON")), [ORG_B])).toMatchObject({ clean: 1 });
      expect((await stateOf(brokenB)).scan_state).toBe("clean");
    });

    it("store failures (tenant bucket) and scanner failures are counted apart, each charged to its own org's cap", async () => {
      await pendingRow("store-down-1", { org: ORG_B });
      await pendingRow("store-down-2", { org: ORG_B });
      await pendingRow("store-down-3", { org: ORG_B });
      await pendingRow("scanner-down-1", { org: orgN(8) });
      storage.readFailure.forOrg = ORG_B;
      try {
        const svc = service({
          name: "down",
          async scan() {
            throw new Error("clamd unreachable");
          },
        });
        expect(await svc.scanPendingForOrg(ORG_B)).toEqual({
          ...EMPTY,
          deferred: MAX_ORG_SCAN_FAILURES_PER_TICK,
          storeFailures: MAX_ORG_SCAN_FAILURES_PER_TICK,
        });
        expect(await svc.scanPendingForOrg(orgN(8))).toEqual({
          ...EMPTY,
          deferred: 1,
          scannerFailures: 1,
        });
      } finally {
        storage.readFailure.forOrg = null;
      }
    });

    it("a total clamd outage fails closed (everything stays pending, nothing delivered), costs a bounded number of attempts per tick, and recovers on the very next tick", async () => {
      const orgs = [orgN(9), ORG_B, orgN(3)];
      const ids: string[] = [];
      for (const org of orgs)
        for (let i = 0; i < 4; i += 1)
          ids.push(await pendingRow(`outage-${org.slice(-4)}-${i}`, { org }));
      let calls = 0;
      const down = service({
        name: "down",
        async scan() {
          calls += 1;
          throw new Error("connect ECONNREFUSED 127.0.0.1:3310");
        },
      });
      const out = await tickOf(down, orgs);
      expect(calls).toBe(orgs.length * MAX_ORG_SCAN_FAILURES_PER_TICK); // bounded: org cap x orgs
      expect(out).toMatchObject({
        clean: 0,
        quarantined: 0,
        scannerFailures: calls,
        storeFailures: 0,
      });
      for (const id of ids) expect((await stateOf(id)).scan_state).toBe("pending");
      // No cooldown to wait out: the scanner is back, the next tick scans (the 2 least-recently-attempted rows per org first).
      const up = service(createBuiltinScanner());
      pastBackoff();
      const first = await tickOf(up, orgs);
      expect(first.clean).toBe(orgs.length * 4); // limit is 50/org: all four rows each
      for (const id of ids) expect((await stateOf(id)).scan_state).toBe("clean");
    });

    it("a hung scanner is abandoned at the per-scan deadline (a scanner failure), and a hung bucket read the same (a store failure)", async () => {
      await pendingRow("hang-1", { org: orgN(12) });
      await pendingRow("hang-2", { org: orgN(12) });
      const hung = createAttachmentService({
        db: handle.db,
        storage: storage.port,
        scanner: { name: "hung", scan: () => new Promise(() => undefined) },
        canViewChannel: routeService.canViewChannel,
        now: () => new Date(clock.now),
        scanDeadlineMs: 60,
        abortGraceMs: 50, // this scanner ignores the abort signal: the backstop gives up on it
      });
      const started = Date.now();
      expect(await hung.scanPendingForOrg(orgN(12))).toMatchObject({
        deferred: 2,
        scannerFailures: 2,
        storeFailures: 0,
      });
      expect(Date.now() - started).toBeLessThan(5_000);
      const slowStore: AttachmentStoragePort = {
        ...storage.port,
        readBytes: () => new Promise(() => undefined),
      };
      const hungStore = createAttachmentService({
        db: handle.db,
        storage: slowStore,
        scanner: createBuiltinScanner(),
        canViewChannel: routeService.canViewChannel,
        now: () => new Date(clock.now),
        scanDeadlineMs: 60,
        abortGraceMs: 50,
      });
      pastBackoff(); // the first service's two failures put both rows on retry backoff
      expect(await hungStore.scanPendingForOrg(orgN(12))).toMatchObject({
        storeFailures: 2,
        scannerFailures: 0,
      });
    });

    it("the tick has a wall-clock budget and the starting org rotates: a slow, always-failing org cannot starve the others", async () => {
      const slowMs = 20_000;
      const budgetMs = 25_000;
      const [orgC, orgD, orgE] = [orgN(4), orgN(5), orgN(6)];
      await pendingRow("POISON-slow-1", { org: orgN(11) });
      await pendingRow("POISON-slow-2", { org: orgN(11) });
      const healthy = [
        await pendingRow("fine-c", { org: orgC }),
        await pendingRow("fine-d", { org: orgD }),
        await pendingRow("fine-e", { org: orgE }),
      ];
      // Every scan "takes" 20 s of fake wall time; the poison org's scans also fail.
      const svc = service({
        name: "slow",
        async scan(input) {
          clock.now += slowMs;
          if (Buffer.from(input.bytes).toString().includes("POISON"))
            throw new Error("scanner choked");
          return createBuiltinScanner().scan(input);
        },
      });
      const base = clock.now;
      try {
        for (let n = 0; n < 4; n += 1) {
          clock.now = base + n * 61 * 60_000; // 61 min apart: the rotation offset advances by one each tick (61 mod 4 = 1)
          const startedAt = clock.now;
          await tickOf(svc, [orgN(11), orgC, orgD, orgE], { nowMs: () => clock.now, budgetMs });
          // Never starts a scan after the budget: at most budget + one scan of overrun.
          expect(clock.now - startedAt).toBeLessThanOrEqual(budgetMs + slowMs);
        }
      } finally {
        clock.now = base;
      }
      for (const id of healthy) expect((await stateOf(id)).scan_state).toBe("clean");
    });

    it("inline scans are bounded: over the in-flight cap the row is left pending for the sweep (not an error), and a released slot scans", async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      let open!: () => void;
      const gateOpen = new Promise<void>((resolve) => {
        open = resolve;
      });
      const blocking: ScanPort = {
        name: "blocking",
        async scan(input) {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await gateOpen;
          inFlight -= 1;
          return createBuiltinScanner().scan(input);
        },
      };
      const svc = createAttachmentService({
        db: handle.db,
        storage: storage.port,
        scanner: blocking,
        canViewChannel: routeService.canViewChannel,
        now: () => new Date(clock.now),
        inlineScanGate: createInlineScanGate(4, 2),
        userRequestsPerMinute: 1_000_000,
      });
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        ids.push(
          (await uploaded(u1, dm, pdfBytes(`inline-${i}`), { complete: false })).attachmentId,
        );
      }
      const calls = ids.map((id) => svc.complete(ORG_A, { userId: u1, attachmentId: id }));
      await new Promise((r) => setTimeout(r, 400));
      expect(maxInFlight).toBe(2); // per-org cap: the third is not even attempted
      open();
      const statuses = await Promise.all(calls);
      expect(statuses.filter((x) => x.scanState === "clean")).toHaveLength(2);
      const skipped = statuses.find((x) => x.scanState === "pending");
      expect(skipped).toBeDefined();
      const skippedId = skipped?.attachmentId as string;
      expect((await stateOf(skippedId)).scan_attempts).toBe(0); // no claim was taken
      // The sweep picks it up.
      await svc.scanPendingForOrg(ORG_A);
      expect((await stateOf(skippedId)).scan_state).toBe("clean");
    });

    it("a user hammering /complete on a scanner-error file gets bounded inline attempts and does not delay another org's scanning", async () => {
      const poisonId = await pendingRow("POISON-hammer");
      const bOk = await pendingRow("fine-b", { org: ORG_B });
      let poisonCalls = 0;
      const base = poison("POISON");
      const svc = service({
        ...base,
        async scan(input) {
          if (Buffer.from(input.bytes).toString().includes("POISON")) poisonCalls += 1;
          return base.scan(input);
        },
      });
      for (let i = 0; i < 12; i += 1) {
        const status = await svc.complete(ORG_A, { userId: u1, attachmentId: poisonId });
        expect(status.scanState).toBe("pending"); // fail closed, never an error to the caller
      }
      expect(poisonCalls).toBe(MAX_INLINE_SCAN_ATTEMPTS); // bounded: not one scan per request
      expect((await stateOf(poisonId)).scan_attempts).toBe(MAX_INLINE_SCAN_ATTEMPTS);
      expect(await svc.scanPendingForOrg(ORG_B)).toMatchObject({ clean: 1 });
      expect((await stateOf(bOk)).scan_state).toBe("clean");
    });

    it("after a long outage a row past the 24 h cap is still SCANNED (clean files become clean, not quarantined unscanned)", async () => {
      const dayAndMore = MAX_PENDING_SCAN_AGE_MS + 3_600_000;
      const stuck = await pendingRow("stuck", { completedAgoMs: dayAndMore, attempts: 5 });
      const infected = await pendingRow("stuck-eicar", {
        completedAgoMs: dayAndMore,
        attempts: 5,
      });
      await admin.query(`UPDATE message_attachment SET mime_type='image/png' WHERE id=$1`, [
        infected,
      ]); // bytes are a PDF: the built-in scanner reports a real verdict (type mismatch)
      const result = await service(createBuiltinScanner()).scanPendingForOrg(ORG_A);
      expect(result).toMatchObject({ clean: 1, quarantined: 1 });
      expect((await stateOf(stuck)).scan_state).toBe("clean");
      expect(await stateOf(infected)).toMatchObject({
        scan_state: "quarantined",
        scan_signature: "content-type-mismatch",
      });
    });

    it("a row the scanner still cannot judge past 24 h stays pending (shown blocked, never deliverable, never quarantined), retried hourly", async () => {
      const dayAndMore = MAX_PENDING_SCAN_AGE_MS + 3_600_000;
      const stuck = await pendingRow("stuck-down", { completedAgoMs: dayAndMore, attempts: 5 });
      let calls = 0;
      const svc = service({
        name: "down",
        async scan() {
          calls += 1;
          throw new Error("clamd unreachable");
        },
      });
      await svc.scanPendingForOrg(ORG_A);
      expect(calls).toBe(1);
      expect(await stateOf(stuck)).toMatchObject({ scan_state: "pending", scan_signature: null });
      const status = await svc.status(ORG_A, { userId: u1, attachmentId: stuck });
      expect(status).toMatchObject({ scanState: "pending", availability: "blocked" });
      await expect(svc.access(ORG_A, { userId: u1, attachmentId: stuck })).rejects.toThrow();
      await svc.scanPendingForOrg(ORG_A); // within the hour: not retried
      expect(calls).toBe(1);
      clock.now += EXPIRED_SCAN_RETRY_INTERVAL_MS + 1000;
      try {
        await svc.scanPendingForOrg(ORG_A);
        expect(calls).toBe(2);
      } finally {
        clock.now -= EXPIRED_SCAN_RETRY_INTERVAL_MS + 1000;
      }
      // The scanner recovers: a REAL verdict still settles it (the verdict-final invariant is untouched).
      clock.now += 3 * EXPIRED_SCAN_RETRY_INTERVAL_MS;
      try {
        await service(createBuiltinScanner()).scanPendingForOrg(ORG_A);
      } finally {
        clock.now -= 3 * EXPIRED_SCAN_RETRY_INTERVAL_MS;
      }
      expect((await stateOf(stuck)).scan_state).toBe("clean");
    });

    it("object-missing needs >= 3 CONSECUTIVE 404s spanning >= 15 min; scanner outages (scan_attempts) never count; any good read resets it", async () => {
      // After a long outage scan_attempts is huge, and one transient 404 must NOT finalise a legitimate file.
      const afterOutage = await pendingRow("miss-after-outage", { noObject: true, attempts: 50 });
      // Third miss but only a minute into the run: not yet.
      const tooSoon = await pendingRow("miss-too-soon", {
        noObject: true,
        missingCount: 2,
        missingFirstAgoMs: 60_000,
      });
      // Third miss, 16 minutes in: final.
      const gone = await pendingRow("miss-gone", {
        noObject: true,
        missingCount: 2,
        missingFirstAgoMs: OBJECT_MISSING_MIN_SPAN_MS + 60_000,
      });
      // The object is back: the run of misses is over (and the file scans clean).
      const recovered = await pendingRow("miss-recovered", {
        missingCount: 2,
        missingFirstAgoMs: OBJECT_MISSING_MIN_SPAN_MS + 60_000,
      });
      const svc = service(createBuiltinScanner());
      const first = await svc.scanPendingForOrg(ORG_A);
      expect(first).toMatchObject({ quarantined: 1, clean: 1, deferred: 2 });
      expect(await stateOf(afterOutage)).toMatchObject({
        scan_state: "pending",
        object_missing_count: 1,
        scan_attempts: 51, // counted once, by the sweep path
      });
      expect(await stateOf(tooSoon)).toMatchObject({
        scan_state: "pending",
        object_missing_count: 3,
      });
      expect(await stateOf(gone)).toMatchObject({
        scan_state: "quarantined",
        scan_signature: "object-missing",
      });
      expect(await stateOf(recovered)).toMatchObject({
        scan_state: "clean",
        object_missing_count: 0,
      });
      // a 404 is a per-row outcome, not a failure of either kind
      expect(first).toMatchObject({ scannerFailures: 0, storeFailures: 0 });
      // time passes: the same row finally finalises once its run spans 15 minutes
      clock.now += OBJECT_MISSING_MIN_SPAN_MS + 1_000;
      try {
        expect(await svc.scanPendingForOrg(ORG_A, { limit: 50 })).toMatchObject({ quarantined: 1 });
      } finally {
        clock.now -= OBJECT_MISSING_MIN_SPAN_MS + 1_000;
      }
      expect((await stateOf(tooSoon)).scan_state).toBe("quarantined");
      expect((await stateOf(afterOutage)).scan_state).toBe("pending"); // only 2 misses so far
    });

    it("an inline complete that sees one 404 counts one attempt (not two) and one miss", async () => {
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("inline-miss"), { complete: false });
      const key = (
        await admin.query(`SELECT object_key FROM message_attachment WHERE id=$1`, [attachmentId])
      ).rows[0].object_key as string;
      // Lands, completes (inspect ok), then vanishes before the inline read.
      const flaky: AttachmentStoragePort = { ...storage.port, readBytes: async () => null };
      const svc = createAttachmentService({
        db: handle.db,
        storage: flaky,
        scanner: createBuiltinScanner(),
        canViewChannel: routeService.canViewChannel,
        now: () => new Date(clock.now),
        userRequestsPerMinute: 1_000_000,
      });
      const done = await svc.complete(ORG_A, { userId: u1, attachmentId });
      expect(done.scanState).toBe("pending");
      expect(key).toContain("messaging/");
      expect(await stateOf(attachmentId)).toMatchObject({
        scan_attempts: 1,
        object_missing_count: 1,
      });
    });

    describe("hardening: aborted calls, fair shares, retry backoff", () => {
      it("a hung scanner is ABORTED at the deadline: the work is torn down before the sweep moves on", async () => {
        await pendingRow("abort-scan", { org: orgN(13) });
        let stopped = false;
        const svc = createAttachmentService({
          db: handle.db,
          storage: storage.port,
          scanner: {
            name: "coop",
            scan: ({ signal }) =>
              stopsOnAbort(signal, 30, () => {
                stopped = true;
              }),
          },
          canViewChannel: routeService.canViewChannel,
          now: () => new Date(clock.now),
          scanDeadlineMs: 60,
        });
        expect(await svc.scanPendingForOrg(orgN(13))).toMatchObject({
          scannerFailures: 1,
          storeFailures: 0,
        });
        expect(stopped).toBe(true); // already stopped when the sweep returned, not at the 30 s socket timeout
      });

      it("a hung bucket read is ABORTED the same way (a store failure)", async () => {
        await pendingRow("abort-read", { org: orgN(13) });
        let stopped = false;
        const svc = createAttachmentService({
          db: handle.db,
          storage: {
            ...storage.port,
            readBytes: ({ signal }) =>
              stopsOnAbort(signal, 30, () => {
                stopped = true;
              }),
          },
          scanner: createBuiltinScanner(),
          canViewChannel: routeService.canViewChannel,
          now: () => new Date(clock.now),
          scanDeadlineMs: 60,
        });
        pastBackoff();
        expect(await svc.scanPendingForOrg(orgN(13))).toMatchObject({ storeFailures: 1 });
        expect(stopped).toBe(true);
      });

      it("the inline gate slot is held until the aborted scan has STOPPED (not released at the deadline while work still runs)", async () => {
        const who = await freshUploader("slot");
        const gate = createInlineScanGate(1, 1);
        let stopped = false;
        const svc = createAttachmentService({
          db: handle.db,
          storage: storage.port,
          scanner: {
            name: "coop",
            scan: ({ signal }) =>
              stopsOnAbort(signal, 300, () => {
                stopped = true;
              }),
          },
          canViewChannel: routeService.canViewChannel,
          now: () => new Date(clock.now),
          scanDeadlineMs: 100,
          inlineScanGate: gate,
          userRequestsPerMinute: 1_000_000,
        });
        const { attachmentId } = await directUpload(svc, who, pdfBytes("slot"));
        const call = svc.complete(ORG_A, { userId: who.user, attachmentId });
        await sleep(250); // past the 100 ms deadline, before the 300 ms teardown has finished
        expect(stopped).toBe(false);
        expect(gate.tryAcquire(ORG_A)).toBeNull(); // the work is still running, so the slot is still taken
        const status = await call;
        expect(stopped).toBe(true);
        expect(status.scanState).toBe("pending"); // fail closed
        const free = gate.tryAcquire(ORG_A);
        expect(free).not.toBeNull();
        free?.();
      });

      it("a hung object-store inspect in complete is aborted at its deadline: a typed 503, not a hung request", async () => {
        const who = await freshUploader("inspect");
        let stopped = false;
        const svc = createAttachmentService({
          db: handle.db,
          storage: {
            ...storage.port,
            inspect: ({ signal }) =>
              stopsOnAbort(signal, 10, () => {
                stopped = true;
              }),
          },
          scanner: createBuiltinScanner(),
          canViewChannel: routeService.canViewChannel,
          now: () => new Date(clock.now),
          storageDeadlineMs: 60,
          userRequestsPerMinute: 1_000_000,
        });
        const { attachmentId } = await directUpload(svc, who, pdfBytes("inspect"));
        await expect(svc.complete(ORG_A, { userId: who.user, attachmentId })).rejects.toMatchObject(
          {
            code: "DEGRADED",
          },
        );
        expect(stopped).toBe(true);
      });

      it("a tiny slice still starts the org's first due scan; a zero slice starts none", async () => {
        const org = orgN(14);
        for (let i = 0; i < 3; i += 1) await pendingRow(`slice-${i}`, { org });
        let calls = 0;
        const base = clock.now;
        const svc = service({
          name: "slow",
          async scan(input) {
            calls += 1;
            clock.now += 5_000;
            return createBuiltinScanner().scan(input);
          },
        });
        try {
          expect(await svc.scanPendingForOrg(org, { budgetMs: 0 })).toMatchObject({ clean: 0 });
          expect(calls).toBe(0);
          expect(await svc.scanPendingForOrg(org, { budgetMs: 1_000 })).toMatchObject({ clean: 1 });
          expect(calls).toBe(1); // the first scan always starts; the slice is spent after it
        } finally {
          clock.now = base;
        }
      });

      it("the tick gives EVERY org with pending work its share however slow each scan is (deterministic fair share, not rotation luck)", async () => {
        const orgs = [orgN(15), orgN(16), orgN(17)];
        for (const org of orgs)
          for (let i = 0; i < 4; i += 1) await pendingRow(`share-${i}`, { org });
        const base = clock.now;
        const svc = service({
          name: "slow",
          async scan(input) {
            clock.now += 10_000; // every scan "takes" 10 s
            return createBuiltinScanner().scan(input);
          },
        });
        try {
          await attachmentScanTick({
            activeOrgs: {
              listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })),
            } as never,
            service: svc,
            nowMs: () => clock.now,
            budgetMs: 60_000, // 3 orgs => a 20 s slice each => 2 scans each (the old greedy loop gave the first org 4 and the last 0)
            reapBudgetMs: 3_000,
          });
        } finally {
          clock.now = base;
        }
        for (const org of orgs) {
          expect(
            await count(
              `SELECT count(*)::int AS n FROM message_attachment WHERE organization_id=$1 AND scan_state='clean'`,
              [org],
            ),
          ).toBe(2);
        }
      });

      it("a row nobody can judge backs off exponentially (1, 2, 4 ... capped at 60 min), is never hot-looped, surfaces scan-unavailable past the ceiling, and is NEVER clean or quarantined by it", async () => {
        const org = orgN(18);
        const id = await pendingRow("backoff", { org });
        let calls = 0;
        const unavailable: number[] = [];
        const svc = createAttachmentService({
          db: handle.db,
          storage: storage.port,
          scanner: {
            name: "down",
            async scan() {
              calls += 1;
              throw new Error("clamd unreachable");
            },
          },
          canViewChannel: routeService.canViewChannel,
          now: () => new Date(clock.now),
          onScanUnavailable: ({ attempts }) => unavailable.push(attempts),
        });
        const waitFor = (attempt: number) =>
          Math.min(SCAN_RETRY_BASE_MS * 2 ** (attempt - 1), SCAN_RETRY_MAX_MS);
        const base = clock.now;
        try {
          for (let attempt = 1; attempt <= SCAN_UNAVAILABLE_ATTEMPTS + 2; attempt += 1) {
            const before = calls;
            const out = await svc.scanPendingForOrg(org);
            expect(calls).toBe(before + 1); // due: tried exactly once
            expect(out.scanUnavailable).toBe(attempt >= SCAN_UNAVAILABLE_ATTEMPTS ? 1 : 0);
            clock.now += waitFor(attempt) - 1_000; // just inside the wait...
            await svc.scanPendingForOrg(org);
            expect(calls).toBe(before + 1); // ...not retried
            clock.now += 2_000; // wait elapsed
          }
          expect(waitFor(SCAN_UNAVAILABLE_ATTEMPTS + 2)).toBe(SCAN_RETRY_MAX_MS); // the slow, bounded cadence
          expect(unavailable[0]).toBe(SCAN_UNAVAILABLE_ATTEMPTS);
          expect(await stateOf(id)).toMatchObject({ scan_state: "pending", scan_signature: null });
          expect(
            (await admin.query(`SELECT scanned_at FROM message_attachment WHERE id=$1`, [id]))
              .rows[0].scanned_at,
          ).toBeNull();
          // the scanner recovers: a REAL verdict still settles it (verdict-final is untouched)
          expect(await service(createBuiltinScanner()).scanPendingForOrg(org)).toMatchObject({
            clean: 1,
          });
        } finally {
          clock.now = base;
        }
      });
    });
  });

  // Mutation check done by hand: removing `.for("update")` from bindAttachmentsInTx does NOT fail this test. The bind is
  // atomic without it, through two later layers - the UPDATE's own `message_id IS NULL` predicate (the loser re-checks it
  // after the winner commits and updates 0 rows) and the 1075 guard trigger. The row lock is defence in depth (the loser
  // fails at the read, not the write). This test therefore pins the OUTCOME, whichever layer provides it.
  describe("concurrency on bind", () => {
    it("two racing sends of the SAME attachment: exactly one wins, the loser gets the uniform 422, one message row", async () => {
      for (let round = 0; round < 5; round += 1) {
        const { attachmentId } = await uploaded(u1, dm, pdfBytes(`race-${round}`));
        const before = await count(`SELECT count(*)::int AS n FROM message WHERE channel_id=$1`, [
          dm,
        ]);
        const [a, b] = await Promise.all([
          send(u1, dm, [attachmentId], ORG_A, `race-a-${round}`),
          send(u1, dm, [attachmentId], ORG_A, `race-b-${round}`),
        ]);
        expect([a.statusCode, b.statusCode].sort()).toEqual([201, 422]);
        const loser = a.statusCode === 422 ? a : b;
        const missing = await send(u1, dm, [randomUUID()], ORG_A, "never");
        expect(shape(loser)).toBe(shape(missing)); // the same answer a made-up id gets
        expect(
          await count(`SELECT count(*)::int AS n FROM message WHERE channel_id=$1`, [dm]),
        ).toBe(before + 1);
        expect(
          await count(
            `SELECT count(*)::int AS n FROM message_attachment WHERE id=$1 AND message_id IS NOT NULL`,
            [attachmentId],
          ),
        ).toBe(1);
      }
    });
  });

  describe("response hardening", () => {
    it("authorize and complete responses are no-store (they carry bearer URLs / private state)", async () => {
      const bytes = pdfBytes("no-store");
      const res = await authorize(u1, dm, bytes);
      expect(res.statusCode).toBe(201);
      expect(res.headers["cache-control"]).toBe("no-store");
      const { attachmentId } = res.json() as { attachmentId: string };
      const row = (
        await admin.query(`SELECT object_key FROM message_attachment WHERE id=$1`, [attachmentId])
      ).rows[0];
      storage.put(ORG_A, row.object_key, bytes);
      const done = await complete(u1, attachmentId);
      expect(done.statusCode).toBe(200);
      expect(done.headers["cache-control"]).toBe("no-store");
    });

    it("the signed download is requested as an attachment of the stored allowlisted type", async () => {
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("dl-type"));
      expect((await send(u1, dm, [attachmentId])).statusCode).toBe(201);
      storage.downloadMimeTypes.length = 0;
      expect((await access(u2, attachmentId)).statusCode).toBe(200);
      expect(storage.downloadMimeTypes).toEqual(["application/pdf"]);
    });
  });

  describe("hardening: the late-upload race at tenant erase (migration 1076)", () => {
    let seqE = 0;
    async function erasable() {
      seqE += 1;
      const org = `66666666-6666-4666-8666-6666000f${String(seqE).padStart(4, "0")}`;
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'R','R')`,
        [org, `wp15-race-${seqE}`],
      );
      const who = await freshUploader(`race${seqE}`, org);
      const svc = createAttachmentService({
        db: handle.db,
        storage: storage.port,
        scanner: createBuiltinScanner(),
        canViewChannel: routeService.canViewChannel,
        now: () => new Date(clock.now),
        userRequestsPerMinute: 1_000_000,
      });
      const { createDrizzleMessagingEraseStore } = await import(
        "../src/modules/36-messaging/erasers/messaging-eraser"
      );
      const eraserAt = (atMs: number, db = destroyer.db) =>
        createDrizzleMessagingEraseStore(db, {
          attachmentStorage: storage.port,
          now: () => new Date(atMs),
        });
      const flagged = () =>
        count(`SELECT count(*)::int AS n FROM messaging_erase_block WHERE organization_id=$1`, [
          org,
        ]);
      const rows = () =>
        count(`SELECT count(*)::int AS n FROM message_attachment WHERE organization_id=$1`, [org]);
      return { org, who, svc, eraserAt, flagged, rows };
    }

    it("the eraser flags the tenant FIRST: authorize and complete refuse from then on, upload URLs already minted must expire before anything is destroyed, then nothing is orphaned", async () => {
      const { org, who, svc, eraserAt, flagged, rows } = await erasable();
      const pending = await directUpload(svc, who, pdfBytes("race-pending"), org); // URL minted, not yet completed
      const ttlEnd = clock.now + ATTACHMENT_UPLOAD_TTL_SECONDS * 1000;

      // 1. Erase while a minted URL is still valid: refused, retryable, NOTHING destroyed, but the door is already shut.
      const before = storage.destroyed.length;
      await expect(eraserAt(clock.now).deleteStructuralRows(org)).rejects.toMatchObject({
        code: "DEGRADED",
      });
      expect(await flagged()).toBe(1);
      expect(storage.destroyed.length).toBe(before);
      expect(await rows()).toBe(1);
      await expect(directUpload(svc, who, pdfBytes("race-late"), org)).rejects.toMatchObject({
        code: "TENANT_ERASURE_IN_PROGRESS",
        statusCode: 409,
      });
      await expect(
        svc.complete(org, { userId: who.user, attachmentId: pending.attachmentId }),
      ).rejects.toMatchObject({ code: "TENANT_ERASURE_IN_PROGRESS", statusCode: 409 });
      expect(await rows()).toBe(1); // the refused authorize created nothing

      // 2. The client PUTs inside the URL's life (after the first erase attempt): that object must not survive the erase.
      storage.put(org, pending.key, pdfBytes("race-put-after-flag"));

      // 3. Once every minted URL has expired (plus the skew grace) the erase destroys the bytes, then the rows.
      await eraserAt(ttlEnd + ERASE_UPLOAD_URL_GRACE_MS + 1_000).deleteStructuralRows(org);
      expect(storage.objects.has(`${org}/${pending.key}`)).toBe(false);
      expect(await rows()).toBe(0);
    });

    it("the race itself: an authorize in flight when the eraser tries to flag the tenant makes the eraser WAIT, and its row is then seen (never missed)", async () => {
      const { org, who, eraserAt, flagged, rows } = await erasable();
      // An authorize that has taken the shared lock and inserted its row but not committed (what authorize does).
      const inflight = new Client({ connectionString: DB_URL });
      await inflight.connect();
      try {
        await inflight.query("BEGIN");
        await inflight.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`, [
          eraseLockName(org),
        ]);
        const id = randomUUID();
        const key = `messaging/${who.channel}/${id}`;
        await inflight.query(
          `INSERT INTO message_attachment (id, organization_id, channel_id, uploaded_by, mime_type, byte_size, filename, object_key, sha256_hex, upload_expires_at)
           VALUES ($1,$2,$3,$4,'application/pdf',5,'x.pdf',$5,$6,$7)`,
          [
            id,
            org,
            who.channel,
            who.user,
            key,
            "a".repeat(64),
            new Date(clock.now + 600_000).toISOString(),
          ],
        );
        let settled = false;
        const erase = eraserAt(clock.now).deleteStructuralRows(org);
        erase.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await sleep(500);
        expect(settled).toBe(false); // blocked on the exclusive lock: it cannot flag past an in-flight authorize
        expect(await flagged()).toBe(0);
        await inflight.query("COMMIT");
        // The row the authorize committed is now visible to the eraser: its URL is still valid, so it refuses (retryable)
        // instead of deleting a row whose object could still land.
        await expect(erase).rejects.toMatchObject({ code: "DEGRADED" });
        expect(await flagged()).toBe(1);
        expect(await rows()).toBe(1);
      } finally {
        await inflight.query("ROLLBACK").catch(() => undefined);
        await inflight.end();
      }
    });

    it("a misconfigured eraser run (no destruction credential) is refused BEFORE it flags the tenant: it must not lock a live org out of uploads", async () => {
      const { org, who, svc, eraserAt, flagged } = await erasable();
      const { attachmentId } = await directUpload(svc, who, pdfBytes("race-misconfig"), org);
      await expect(eraserAt(clock.now, handle.db).deleteStructuralRows(org)).rejects.toMatchObject({
        code: "DEGRADED",
      });
      expect(await flagged()).toBe(0);
      // still accepting work: the upload completes (and scans clean), it is not refused as "erasing"
      await expect(svc.complete(org, { userId: who.user, attachmentId })).resolves.toMatchObject({
        scanState: "clean",
      });
    });

    it("the flag cannot be cleared by the app role (insert-only), and is isolated per tenant", async () => {
      const { org, eraserAt } = await erasable();
      await eraserAt(clock.now).deleteStructuralRows(org); // no attachments: flags and finishes
      const c = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await c.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
        await expect(c.query(`DELETE FROM messaging_erase_block`)).rejects.toThrow(
          /permission denied/i,
        );
        await c.query("ROLLBACK");
        await c.query("BEGIN");
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
        const other = await c.query(`SELECT count(*)::int AS n FROM messaging_erase_block`);
        expect(other.rows[0].n).toBe(0); // ORG_A sees none of other tenants' flags
        await c.query("ROLLBACK");
      } finally {
        await c.end();
      }
    });
  });

  describe("hardening: retention of flagged / deleted-message objects and the quota semantics (M4, A)", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const iso = (offsetMs: number) => new Date(clock.now + offsetMs).toISOString();
    const quotaSvc = (userBytes: number) =>
      createAttachmentService({
        db: handle.db,
        storage: storage.port,
        scanner: createBuiltinScanner(),
        canViewChannel: routeService.canViewChannel,
        now: () => new Date(clock.now),
        userRequestsPerMinute: 1_000_000,
        quota: { orgBytes: 1_000_000_000, userBytes },
        reaperDb: destroyer.db,
      });
    /** A bound, completed attachment row (state given) with a stored object, scanned `scannedAgoMs` ago. */
    async function boundRow(
      who: { user: string; channel: string },
      messageId: string,
      state: "clean" | "quarantined",
      scannedAgoMs: number,
      byteSize = 3000,
    ) {
      const key = `messaging/${who.channel}/${randomUUID()}`;
      const ins = await admin.query(
        `INSERT INTO message_attachment (organization_id, channel_id, uploaded_by, message_id, mime_type, byte_size, filename,
           object_key, sha256_hex, completed_at, scan_state, scanned_at, scan_signature, upload_expires_at, created_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'application/pdf',$5,'m4.pdf',$6, repeat('a',64),
           $7::timestamptz, $8::text, $7::timestamptz, CASE WHEN $8::text='quarantined' THEN 'sig' ELSE NULL END, $7::timestamptz, now() - interval '3 days')
         RETURNING id`,
        [ORG_A, who.channel, who.user, messageId, byteSize, key, iso(-scannedAgoMs), state],
      );
      storage.objects.set(`${ORG_A}/${key}`, {
        bytes: new Uint8Array(byteSize),
        mime: "application/pdf",
      });
      return { id: ins.rows[0].id as string, key };
    }
    const destroyedAt = async (id: string) =>
      (await admin.query(`SELECT object_destroyed_at FROM message_attachment WHERE id=$1`, [id]))
        .rows[0].object_destroyed_at as Date | null;
    const rowExists = async (id: string) =>
      (await count(`SELECT count(*)::int AS n FROM message_attachment WHERE id=$1`, [id])) === 1;

    it("M4: a quarantined file bound to a message keeps its row but its OBJECT is destroyed after the retention window, not before", async () => {
      const who = await freshUploader("m4-quarantine");
      const sent = await routeService.sendMessage(ORG_A, {
        channelId: who.channel,
        authorUserId: who.user,
        body: "m4",
      });
      const fresh = await boundRow(who, sent.messageId, "quarantined", 2 * DAY);
      const old = await boundRow(who, sent.messageId, "quarantined", 8 * DAY);
      const svc = quotaSvc(1_000_000);
      expect(await svc.reapOrphansForOrg(ORG_A)).toEqual({ reaped: 1, failed: 0 });
      expect(storage.destroyed).toContain(old.key);
      expect(storage.objects.has(`${ORG_A}/${old.key}`)).toBe(false);
      expect(await destroyedAt(old.id)).not.toBeNull();
      expect(await rowExists(old.id)).toBe(true); // kept for audit
      expect(storage.objects.has(`${ORG_A}/${fresh.key}`)).toBe(true);
      expect(await destroyedAt(fresh.id)).toBeNull();
      // idempotent: nothing left to do
      expect(await svc.reapOrphansForOrg(ORG_A)).toEqual({ reaped: 0, failed: 0 });
    });

    it("M4: only the destruction credential can stamp object_destroyed_at (the app role cannot)", async () => {
      const { sql: dsql } = await import("drizzle-orm");
      const denied = await handle.db
        .execute(dsql`UPDATE message_attachment SET object_destroyed_at = now() WHERE false`)
        .then(
          () => null,
          (e: { cause?: { message?: string } }) => e.cause?.message ?? "",
        );
      expect(denied).toMatch(/permission denied/i);
      await destroyer.db.execute(
        dsql`UPDATE message_attachment SET object_destroyed_at = object_destroyed_at WHERE false`,
      );
    });

    it("M4: a destroy that fails leaves the row unmarked, so the next run retries it", async () => {
      const who = await freshUploader("m4-retry");
      const sent = await routeService.sendMessage(ORG_A, {
        channelId: who.channel,
        authorUserId: who.user,
        body: "m4r",
      });
      const row = await boundRow(who, sent.messageId, "quarantined", 9 * DAY);
      storage.destroyFailure.onKeyIncluding = row.key;
      try {
        expect(await quotaSvc(1_000_000).reapOrphansForOrg(ORG_A)).toEqual({
          reaped: 0,
          failed: 1,
        });
        expect(await destroyedAt(row.id)).toBeNull();
      } finally {
        storage.destroyFailure.onKeyIncluding = null;
      }
      expect(await quotaSvc(1_000_000).reapOrphansForOrg(ORG_A)).toEqual({ reaped: 1, failed: 0 });
      expect(await destroyedAt(row.id)).not.toBeNull();
    });

    it("A: a clean file on a message deleted longer ago than the window has its object destroyed too; a recently deleted one does not", async () => {
      const who = await freshUploader("a-deleted");
      const mk = async () => {
        const sent = await routeService.sendMessage(ORG_A, {
          channelId: who.channel,
          authorUserId: who.user,
          body: "a",
        });
        const row = await boundRow(who, sent.messageId, "clean", 30 * DAY);
        await routeService.deleteMessage(ORG_A, { userId: who.user, messageId: sent.messageId });
        return row;
      };
      const longGone = await mk();
      const justNow = await mk();
      await admin.query(
        `UPDATE message SET deleted_at = $2::timestamptz WHERE id = (SELECT message_id FROM message_attachment WHERE id=$1)`,
        [longGone.id, iso(-8 * DAY)],
      );
      expect(await quotaSvc(1_000_000).reapOrphansForOrg(ORG_A)).toEqual({ reaped: 1, failed: 0 });
      expect(await destroyedAt(longGone.id)).not.toBeNull();
      expect(await destroyedAt(justNow.id)).toBeNull();
      expect(await rowExists(longGone.id)).toBe(true);
    });

    it("A: quota stops counting a row only once its object is destroyed; rows on deleted messages still count until then", async () => {
      const who = await freshUploader("a-quota");
      const svc = quotaSvc(10_000);
      const live = await routeService.sendMessage(ORG_A, {
        channelId: who.channel,
        authorUserId: who.user,
        body: "live",
      });
      const gone = await routeService.sendMessage(ORG_A, {
        channelId: who.channel,
        authorUserId: who.user,
        body: "gone",
      });
      await boundRow(who, live.messageId, "clean", DAY); // counts: 3000
      await boundRow(who, live.messageId, "quarantined", DAY); // counts: 3000 (bytes still in the bucket)
      const destroyedRow = await boundRow(who, live.messageId, "quarantined", DAY);
      await admin.query(`UPDATE message_attachment SET object_destroyed_at = now() WHERE id=$1`, [
        destroyedRow.id,
      ]); // no longer counts
      await boundRow(who, gone.messageId, "clean", DAY); // on a deleted message, object still stored: STILL counts, 3000
      await routeService.deleteMessage(ORG_A, { userId: who.user, messageId: gone.messageId });
      // used = 9000 of 10000: a 1000 fits, a 1001 does not
      await expect(
        svc.authorize(ORG_A, {
          userId: who.user,
          channelId: who.channel,
          fileName: "q.pdf",
          contentType: "application/pdf",
          byteSize: 1_001,
          sha256Hex: "c".repeat(64),
        }),
      ).rejects.toMatchObject({ statusCode: 413 });
      await svc.authorize(ORG_A, {
        userId: who.user,
        channelId: who.channel,
        fileName: "q.pdf",
        contentType: "application/pdf",
        byteSize: 1_000,
        sha256Hex: "d".repeat(64),
      });
    });

    it("A: upload, send, delete cannot be repeated to hoard bytes: authorize stays 413 until the retention pass destroys the object, then succeeds", async () => {
      const who = await freshUploader("a-hoard");
      const svc = quotaSvc(3_000);
      const sent = await routeService.sendMessage(ORG_A, {
        channelId: who.channel,
        authorUserId: who.user,
        body: "hoard",
      });
      const row = await boundRow(who, sent.messageId, "clean", 30 * DAY);
      await routeService.deleteMessage(ORG_A, { userId: who.user, messageId: sent.messageId });
      const again = () =>
        svc.authorize(ORG_A, {
          userId: who.user,
          channelId: who.channel,
          fileName: "h.pdf",
          contentType: "application/pdf",
          byteSize: 1_000,
          sha256Hex: "f".repeat(64),
        });
      await expect(again()).rejects.toMatchObject({ statusCode: 413 });
      expect(await svc.reapOrphansForOrg(ORG_A)).toEqual({ reaped: 0, failed: 0 }); // deleted just now: inside the window
      await expect(again()).rejects.toMatchObject({ statusCode: 413 });
      await admin.query(
        `UPDATE message SET deleted_at = $2::timestamptz WHERE id = (SELECT message_id FROM message_attachment WHERE id=$1)`,
        [row.id, iso(-8 * DAY)],
      );
      expect(await svc.reapOrphansForOrg(ORG_A)).toEqual({ reaped: 1, failed: 0 });
      expect((await again()).attachmentId).toBeTruthy();
    });

    it("A: a PENDING (never scanned) file bound to a long-deleted message is destroyed too, and counts until then", async () => {
      const who = await freshUploader("a-pending");
      const svc = quotaSvc(1_000_000);
      const sent = await routeService.sendMessage(ORG_A, {
        channelId: who.channel,
        authorUserId: who.user,
        body: "pend",
      });
      const row = await boundRow(who, sent.messageId, "clean", 30 * DAY);
      await admin.query(
        `ALTER TABLE message_attachment DISABLE TRIGGER message_attachment_guard_trg`,
      );
      try {
        await admin.query(
          `UPDATE message_attachment SET scan_state='pending', scanned_at=NULL WHERE id=$1`,
          [row.id],
        );
      } finally {
        await admin.query(
          `ALTER TABLE message_attachment ENABLE TRIGGER message_attachment_guard_trg`,
        );
      }
      await routeService.deleteMessage(ORG_A, { userId: who.user, messageId: sent.messageId });
      expect(await svc.reapOrphansForOrg(ORG_A)).toEqual({ reaped: 0, failed: 0 });
      await admin.query(`UPDATE message SET deleted_at = $2::timestamptz WHERE id=$1`, [
        sent.messageId,
        iso(-8 * DAY),
      ]);
      expect(await svc.reapOrphansForOrg(ORG_A)).toEqual({ reaped: 1, failed: 0 });
      expect(storage.destroyed).toContain(row.key);
      expect(await destroyedAt(row.id)).not.toBeNull();
    });

    it("A: the 413 message says what is true (no 'expire' promise) and names the retention", async () => {
      const who = await freshUploader("a-text");
      const svc = quotaSvc(500);
      const err = await svc
        .authorize(ORG_A, {
          userId: who.user,
          channelId: who.channel,
          fileName: "q.pdf",
          contentType: "application/pdf",
          byteSize: 501,
          sha256Hex: "e".repeat(64),
        })
        .catch((e: Error) => e);
      expect((err as Error).message).not.toMatch(/expire/i);
      expect((err as Error).message).toMatch(/destroyed/i);
    });
  });

  describe("hardening: fail-closed verdicts, realtime hints, bind lock order, seam guard (L1, B, C, F)", () => {
    const hintCount = (messageId: string) =>
      count(
        `SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m36.message.edited' AND aggregate_id=$1`,
        [messageId],
      );

    it("L1: a scanner that answers anything but an explicit clean/infected verdict leaves the row pending (never clean)", async () => {
      const who = await freshUploader("l1-verdict");
      const weird = createAttachmentService({
        db: handle.db,
        storage: storage.port,
        scanner: { name: "weird", scan: async () => ({ verdict: "unknown" }) as never },
        canViewChannel: routeService.canViewChannel,
        now: () => new Date(clock.now),
        userRequestsPerMinute: 1_000_000,
      });
      const up = await directUpload(weird, who, pdfBytes("l1-weird"));
      const status = await weird.complete(ORG_A, {
        userId: who.user,
        attachmentId: up.attachmentId,
      });
      expect(status.scanState).toBe("pending");
      expect(
        await count(
          `SELECT count(*)::int AS n FROM message_attachment WHERE id=$1 AND scan_state='pending'`,
          [up.attachmentId],
        ),
      ).toBe(1);
    });

    it("B: when a bound attachment settles (clean or quarantined) the message gets the same 'edited' realtime hint; an unbound one does not", async () => {
      scanner.down = true;
      const good = await uploaded(u1, dm, pdfBytes("b-clean"));
      const bad = await uploaded(u1, dm, pdfBytes("b-eicar", EICAR));
      const lone = await uploaded(u1, dm, pdfBytes("b-unbound"));
      scanner.down = false;
      const m1 = (await send(u1, dm, [good.attachmentId])).json().messageId as string;
      const m2 = (await send(u1, dm, [bad.attachmentId])).json().messageId as string;
      expect(await hintCount(m1)).toBe(0);
      const eventsBefore = await count(
        `SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m36.message.edited'`,
      );
      pastBackoff();
      await attachmentScanTick({
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        service: attachments,
      });
      expect(await hintCount(m1)).toBe(1);
      expect(await hintCount(m2)).toBe(1);
      expect(lone.attachmentId).toBeTruthy();
      // the unbound file settled too (clean) but announced nothing: no message to refresh
      const eventsAfter = await count(
        `SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m36.message.edited'`,
      );
      expect(eventsAfter - eventsBefore).toBe(2);
      // ids only: the payload carries no body, name or signature
      const payload = JSON.stringify(
        (
          await admin.query(
            `SELECT payload FROM outbox_event WHERE event_type='m36.message.edited' AND aggregate_id=$1`,
            [m2],
          )
        ).rows[0].payload,
      );
      expect(payload).not.toMatch(/sig|eicar|\.pdf|signature/i);
    });

    it("C: concurrent sends naming overlapping attachments in opposite orders never deadlock (one wins, one is refused)", async () => {
      const who = await freshUploader("c-lock");
      for (let i = 0; i < 6; i += 1) {
        const a = await directUpload(attachments, who, pdfBytes(`c-a-${i}`));
        const b = await directUpload(attachments, who, pdfBytes(`c-b-${i}`));
        await attachments.complete(ORG_A, { userId: who.user, attachmentId: a.attachmentId });
        await attachments.complete(ORG_A, { userId: who.user, attachmentId: b.attachmentId });
        const attempt = (ids: string[]) =>
          routeService
            .sendMessage(ORG_A, {
              channelId: who.channel,
              authorUserId: who.user,
              body: "",
              attachments: ids.map((attachmentId) => ({ attachmentId })),
            })
            .then(
              () => "sent",
              (e: { code?: string }) => e.code ?? "error",
            );
        const outcomes = await Promise.all([
          attempt([a.attachmentId, b.attachmentId]),
          attempt([b.attachmentId, a.attachmentId]),
        ]);
        expect(outcomes.sort()).toEqual(["ATTACHMENT_NOT_BINDABLE", "sent"]);
      }
    });

    it("F: the provider seam refuses a blank message with no attachments; a blank body with an attachment is stored as empty text", async () => {
      const { createDbMessagingProvider } = await import(
        "../src/modules/36-messaging/messaging-provider-db"
      );
      const provider = createDbMessagingProvider(handle.db, { kek: KEK });
      const who = await freshUploader("f-seam");
      const before = await count(`SELECT count(*)::int AS n FROM message WHERE channel_id=$1`, [
        who.channel,
      ]);
      for (const body of ["", "   \n\t "]) {
        await expect(
          provider.sendMessage(ORG_A, { channelId: who.channel, authorUserId: who.user, body }),
        ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      }
      expect(
        await count(`SELECT count(*)::int AS n FROM message WHERE channel_id=$1`, [who.channel]),
      ).toBe(before);
      const up = await directUpload(attachments, who, pdfBytes("f-attach"));
      await attachments.complete(ORG_A, { userId: who.user, attachmentId: up.attachmentId });
      const sent = await provider.sendMessage(ORG_A, {
        channelId: who.channel,
        authorUserId: who.user,
        body: "  ",
        attachments: [{ attachmentId: up.attachmentId }],
      });
      expect(sent.messageId).toBeTruthy();
    });
  });

  describe("hardening: audit trail ignores scan-sweep bookkeeping (D)", () => {
    it("retry bookkeeping writes no audit_event; completion and the verdict do", async () => {
      const auditUpdates = (id: string) =>
        count(
          `SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='message_attachment' AND resource_id=$1 AND event_type='message_attachment.update'`,
          [id],
        );
      scanner.down = true;
      const up = await uploaded(u1, dm, pdfBytes("audit-noise"));
      scanner.down = false;
      // complete stamped completed_at (audited); the failed inline attempt only bumped scan_attempts (not audited)
      expect(
        (
          await admin.query(`SELECT scan_attempts FROM message_attachment WHERE id=$1`, [
            up.attachmentId,
          ])
        ).rows[0].scan_attempts,
      ).toBeGreaterThan(0);
      expect(await auditUpdates(up.attachmentId)).toBe(1);
      scanner.down = true;
      pastBackoff();
      await attachmentScanTick({
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        service: attachments,
      });
      scanner.down = false;
      expect(await auditUpdates(up.attachmentId)).toBe(1);
      pastBackoff();
      await attachmentScanTick({
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        service: attachments,
      });
      expect(await auditUpdates(up.attachmentId)).toBe(2); // the clean verdict is audited
    });
  });

  describe("hardening: total stored-bytes quota (per user and per org)", () => {
    const quotaService = (quota: { orgBytes: number; userBytes: number }) =>
      createAttachmentService({
        db: handle.db,
        storage: storage.port,
        scanner: createBuiltinScanner(),
        canViewChannel: routeService.canViewChannel,
        now: () => new Date(clock.now),
        userRequestsPerMinute: 1_000_000,
        quota,
      });
    const authorizeBytes = (
      svc: ReturnType<typeof createAttachmentService>,
      who: { user: string; channel: string },
      byteSize: number,
      org = ORG_A,
    ) =>
      svc.authorize(org, {
        userId: who.user,
        channelId: who.channel,
        fileName: "q.pdf",
        contentType: "application/pdf",
        byteSize,
        sha256Hex: "b".repeat(64),
      });

    it("a user over their allowance gets a typed 413 ATTACHMENT_QUOTA_EXCEEDED (scope user); exactly filling it is allowed", async () => {
      const who = await freshUploader("quota-user");
      const svc = quotaService({ orgBytes: 1_000_000_000, userBytes: 1_000 });
      await authorizeBytes(svc, who, 600);
      await expect(authorizeBytes(svc, who, 401)).rejects.toMatchObject({
        code: "ATTACHMENT_QUOTA_EXCEEDED",
        statusCode: 413,
        details: [{ field: "scope", message: "user" }],
      });
      await authorizeBytes(svc, who, 400); // 600 + 400 = exactly 1000
      await expect(authorizeBytes(svc, who, 1)).rejects.toMatchObject({ statusCode: 413 });
    });

    it("an org over its allowance is refused for EVERY user of it (scope organization); another org is unaffected", async () => {
      const a = await freshUploader("quota-org-a");
      const b = await freshUploader("quota-org-b");
      const svc = quotaService({ orgBytes: 1_000_000, userBytes: 1_000_000 });
      // fill most of ORG_A (the suite's earlier rows count too): read what is used, leave exactly 500 bytes of room
      const used = await count(
        `SELECT COALESCE(SUM(byte_size),0)::bigint AS n FROM message_attachment
          WHERE organization_id=$1 AND (completed_at IS NOT NULL OR upload_expires_at > $2::timestamptz)
            AND object_destroyed_at IS NULL`,
        [ORG_A, new Date(clock.now).toISOString()],
      );
      const tight = quotaService({ orgBytes: Number(used) + 500, userBytes: 1_000_000 });
      await authorizeBytes(tight, a, 300);
      await expect(authorizeBytes(tight, b, 300)).rejects.toMatchObject({
        code: "ATTACHMENT_QUOTA_EXCEEDED",
        statusCode: 413,
        details: [{ field: "scope", message: "organization" }],
      });
      await authorizeBytes(tight, b, 200);
      // a different tenant has its own allowance
      const orgB = await authorizeBytes(
        svc,
        {
          user: bUser,
          channel: (await routeService.openDm(ORG_B, bUser, await seedUser("quota-b2", ORG_B)))
            .channelId,
        },
        900_000,
        ORG_B,
      );
      expect(orgB.attachmentId).toBeTruthy();
    });

    it("counts a BOUND file that is still pending (the old caps never saw it), quarantined files, and live unfinished uploads; not expired unfinished ones", async () => {
      const who = await freshUploader("quota-count");
      const svc = quotaService({ orgBytes: 1_000_000_000, userBytes: 10_000 });
      const sent = await routeService.sendMessage(ORG_A, {
        channelId: who.channel,
        authorUserId: who.user,
        body: "bound pending",
      });
      const insert = (
        state: string,
        bound: boolean,
        completed: boolean,
        expiresAgoMs: number | null,
      ) =>
        admin.query(
          `INSERT INTO message_attachment (organization_id, channel_id, uploaded_by, message_id, mime_type, byte_size, filename,
             object_key, sha256_hex, completed_at, scan_state, scanned_at, scan_signature, upload_expires_at, created_at)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'application/pdf',3000,'c.pdf','messaging/'||$2::uuid::text||'/'||gen_random_uuid(), repeat('a',64),
             $5::timestamptz, $6::text, CASE WHEN $6::text='pending' THEN NULL ELSE now() END, CASE WHEN $6::text='quarantined' THEN 'sig' ELSE NULL END, $7::timestamptz, now() - interval '3 days')`,
          [
            ORG_A,
            who.channel,
            who.user,
            bound ? sent.messageId : null,
            completed ? new Date(clock.now).toISOString() : null,
            state,
            expiresAgoMs === null ? null : new Date(clock.now - expiresAgoMs).toISOString(),
          ],
        );
      await insert("pending", true, true, null); // bound + pending + completed: 3000
      await insert("quarantined", false, true, null); // quarantined: 3000 (the bytes are still in the bucket)
      await insert("pending", false, false, -600_000); // unfinished, URL still live (expires in 10 min): 3000
      await insert("pending", false, false, 3_600_000); // unfinished, URL expired an hour ago: NOT counted
      // used = 9000 of 10000: a 1000 fits, a 1001 does not
      await expect(authorizeBytes(svc, who, 1_001)).rejects.toMatchObject({ statusCode: 413 });
      await authorizeBytes(svc, who, 1_000);
    });

    it("freed on reap/erase: a reaped upload stops counting", async () => {
      const who = await freshUploader("quota-free");
      const svc = quotaService({ orgBytes: 1_000_000_000, userBytes: 500 });
      const first = await authorizeBytes(svc, who, 500);
      await expect(authorizeBytes(svc, who, 1)).rejects.toMatchObject({ statusCode: 413 });
      await admin.query(`DELETE FROM message_attachment WHERE id=$1`, [first.attachmentId]); // what the reaper/eraser do
      await authorizeBytes(svc, who, 500);
    });

    it("over the HTTP route: 413 with the standard error envelope and the quota code", async () => {
      // 90 x 25 MB quarantined rows (old enough to be outside every other cap) put `u2` over the 2 GiB default.
      await admin.query(
        `INSERT INTO message_attachment (organization_id, channel_id, uploaded_by, mime_type, byte_size, filename,
           object_key, sha256_hex, completed_at, scan_state, scanned_at, scan_signature, created_at)
         SELECT $1::uuid,$2::uuid,$3::uuid,'application/pdf',25000000,'big.pdf','messaging/'||$2::text||'/'||gen_random_uuid(), repeat('a',64),
           now() - interval '3 days','quarantined', now() - interval '3 days','sig', now() - interval '3 days'
         FROM generate_series(1,90)`,
        [ORG_A, dm, u2],
      );
      try {
        const res = await authorize(u2, dm, pdfBytes("over-quota"));
        expect(res.statusCode).toBe(413);
        expect(res.json()).toMatchObject({ error: { code: "ATTACHMENT_QUOTA_EXCEEDED" } });
        expect(res.json().error.correlationId).toBeTruthy();
        // another user of the same org still uploads (their own allowance is untouched)
        expect((await authorize(u1, dm, pdfBytes("other-user-ok"))).statusCode).toBe(201);
      } finally {
        await admin.query(
          `DELETE FROM message_attachment WHERE uploaded_by=$1 AND byte_size=25000000`,
          [u2],
        );
      }
    });
  });

  describe("attachment-only messages (WP 1.5 follow-up)", () => {
    const post = (
      userId: string,
      channelId: string,
      payload: Record<string, unknown>,
      key = randomUUID(),
    ) =>
      app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${channelId}/messages`,
        headers: as(userId, ORG_A, key),
        payload,
      });
    const edit = (userId: string, messageId: string, payload: Record<string, unknown>) =>
      app.inject({
        method: "PATCH",
        url: `/api/v1/messaging/messages/${messageId}`,
        headers: as(userId),
        payload,
      });
    const lastPreview = async (userId: string, channelId: string) =>
      (
        (
          await app.inject({
            method: "GET",
            url: "/api/v1/messaging/channels",
            headers: as(userId),
          })
        ).json() as {
          channels: Array<{ channelId: string; lastMessage: { preview: string } | null }>;
        }
      ).channels.find((c) => c.channelId === channelId)?.lastMessage?.preview;
    const bodyOf = (res: { json(): unknown }, messageId: string) =>
      (res.json() as { messages: Array<{ messageId: string; body: string }> }).messages.find(
        (m) => m.messageId === messageId,
      )?.body;
    const messageCount = () =>
      count(`SELECT count(*)::int AS n FROM message WHERE organization_id=$1`, [ORG_A]);

    it("a send with no body and a clean attachment is 201 and shows to the recipient with an empty body", async () => {
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("att-only"));
      const sent = await post(u1, dm, { attachments: [{ attachmentId }] });
      expect(sent.statusCode).toBe(201);
      const messageId = sent.json().messageId as string;
      const seen = await list(u2, dm);
      expect(bodyOf(seen, messageId)).toBe("");
      expect(attachmentsOf(seen, messageId)).toEqual([
        expect.objectContaining({ attachmentId, availability: "available" }),
      ]);
    });

    it("an explicit empty or whitespace body with an attachment is also accepted", async () => {
      const a = await uploaded(u1, dm, pdfBytes("att-empty-1"));
      const b = await uploaded(u1, dm, pdfBytes("att-empty-2"));
      expect(
        (await post(u1, dm, { body: "", attachments: [{ attachmentId: a.attachmentId }] }))
          .statusCode,
      ).toBe(201);
      expect(
        (await post(u1, dm, { body: "  \n ", attachments: [{ attachmentId: b.attachmentId }] }))
          .statusCode,
      ).toBe(201);
    });

    it("no text and no attachment is a validation error (422, as every other schema violation) and writes nothing", async () => {
      const before = await messageCount();
      for (const payload of [
        {},
        { body: "" },
        { body: "   \n\t" },
        { attachments: [] },
        { body: " ", attachments: [] },
      ]) {
        const res = await post(u1, dm, payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(422);
      }
      expect(await messageCount()).toBe(before);
    });

    it("an unbindable (quarantined) attachment stays a 422 and leaves no message behind", async () => {
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("att-eicar", EICAR));
      const before = await messageCount();
      const res = await post(u1, dm, { attachments: [{ attachmentId }] });
      expect(res.statusCode).toBe(422);
      expect(res.json().error?.code ?? res.json().code).toBe("ATTACHMENT_NOT_BINDABLE");
      expect(await messageCount()).toBe(before);
    });

    it("the channel-list preview names a clean file, counts several, and never names a still-scanning one to a recipient", async () => {
      const one = await uploaded(u1, dm, pdfBytes("prev-1"));
      expect(
        (await post(u1, dm, { attachments: [{ attachmentId: one.attachmentId }] })).statusCode,
      ).toBe(201);
      expect(await lastPreview(u2, dm)).toBe(`\u{1F4CE} ${SECRET_FILE_NAME}`);
      const x = await uploaded(u1, dm, pdfBytes("prev-2"));
      const y = await uploaded(u1, dm, pdfBytes("prev-3"));
      await post(u1, dm, {
        attachments: [{ attachmentId: x.attachmentId }, { attachmentId: y.attachmentId }],
      });
      expect(await lastPreview(u2, dm)).toBe("\u{1F4CE} 2 attachments");

      scanner.down = true;
      const pending = await uploaded(u1, dm, pdfBytes("prev-4"));
      scanner.down = false;
      expect(
        (await post(u1, dm, { attachments: [{ attachmentId: pending.attachmentId }] })).statusCode,
      ).toBe(201);
      expect(await lastPreview(u2, dm)).toBe("\u{1F4CE} Attachment");
      expect(await lastPreview(u1, dm)).toBe(`\u{1F4CE} ${SECRET_FILE_NAME}`);
    });

    it("text wins over the attachment label in the preview", async () => {
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("prev-text"));
      await post(u1, dm, { body: "see attached", attachments: [{ attachmentId }] });
      expect(await lastPreview(u2, dm)).toBe("see attached");
    });

    it("same Idempotency-Key replays one attachment-only message; a reused clientMessageId under a fresh key does too", async () => {
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("att-replay"));
      const key = randomUUID();
      const clientMessageId = randomUUID();
      const payload = { attachments: [{ attachmentId }], clientMessageId };
      const first = await post(u1, dm, payload, key);
      const again = await post(u1, dm, payload, key);
      const fresh = await post(u1, dm, payload, randomUUID());
      expect(first.statusCode).toBe(201);
      expect(again.json().messageId).toBe(first.json().messageId);
      expect(fresh.statusCode).toBe(201);
      expect(fresh.json().messageId).toBe(first.json().messageId);
      expect(
        await count(`SELECT count(*)::int AS n FROM message WHERE client_message_id=$1`, [
          clientMessageId,
        ]),
      ).toBe(1);
    });

    it("edit keeps the attachments: can add text, and can clear text only while an attachment remains", async () => {
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("att-edit"));
      const messageId = (await post(u1, dm, { attachments: [{ attachmentId }] })).json()
        .messageId as string;
      expect((await edit(u1, messageId, { body: "added caption" })).statusCode).toBe(200);
      let seen = await list(u2, dm);
      expect(bodyOf(seen, messageId)).toBe("added caption");
      expect(attachmentsOf(seen, messageId)).toHaveLength(1);
      expect((await edit(u1, messageId, { body: "" })).statusCode).toBe(200);
      seen = await list(u2, dm);
      expect(bodyOf(seen, messageId)).toBe("");
      expect(attachmentsOf(seen, messageId)).toHaveLength(1);
      expect(
        await count(`SELECT count(*)::int AS n FROM message_revision WHERE message_id=$1`, [
          messageId,
        ]),
      ).toBe(2);
    });

    it("editing a message with no attachment to empty text is a validation error (422) and changes nothing", async () => {
      const messageId = (await post(u1, dm, { body: "plain words" })).json().messageId as string;
      expect((await edit(u1, messageId, { body: "  " })).statusCode).toBe(422);
      expect(bodyOf(await list(u2, dm), messageId)).toBe("plain words");
      expect(
        await count(`SELECT count(*)::int AS n FROM message_revision WHERE message_id=$1`, [
          messageId,
        ]),
      ).toBe(0);
    });

    const hiddenOf = (res: { json(): unknown }, messageId: string) =>
      (
        res.json() as { messages: Array<{ messageId: string; hiddenAttachmentCount?: number }> }
      ).messages.find((m) => m.messageId === messageId)?.hiddenAttachmentCount;

    it("tells a recipient that files exist but are not visible yet (still scanning), without ids or names", async () => {
      scanner.down = true;
      const pending = await uploaded(u1, dm, pdfBytes("hid-pending"));
      scanner.down = false;
      const messageId = (
        await post(u1, dm, { attachments: [{ attachmentId: pending.attachmentId }] })
      ).json().messageId as string;
      const forRecipient = await list(u2, dm);
      expect(hiddenOf(forRecipient, messageId)).toBe(1);
      expect(attachmentsOf(forRecipient, messageId)).toEqual([]);
      const row = (forRecipient.json() as { messages: Array<{ messageId: string }> }).messages.find(
        (m) => m.messageId === messageId,
      );
      expect(JSON.stringify(row)).not.toContain(pending.attachmentId);
      expect(JSON.stringify(row)).not.toContain(SECRET_FILE_NAME);
      // the uploader sees the file itself, so nothing is hidden from them
      expect(hiddenOf(await list(u1, dm), messageId)).toBe(0);
    });

    it("a file quarantined after the send is hidden from everyone with the same neutral count", async () => {
      scanner.down = true;
      const bad = await uploaded(u1, dm, pdfBytes("hid-eicar", EICAR));
      scanner.down = false;
      const messageId = (
        await post(u1, dm, { attachments: [{ attachmentId: bad.attachmentId }] })
      ).json().messageId as string;
      pastBackoff(); // the failed inline scan above put the row on a retry backoff: make the sweep due
      await attachmentScanTick({
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        service: attachments,
      });
      for (const viewer of [u1, u2]) {
        const view = await list(viewer, dm);
        expect(hiddenOf(view, messageId)).toBe(1);
        expect(view.body).not.toContain(bad.attachmentId);
        expect(view.body).not.toMatch(/quarantin|malware|infect/i);
      }
    });

    it("counts only hidden files; text messages, visible files and tombstones report none", async () => {
      const clean = await uploaded(u1, dm, pdfBytes("hid-clean"));
      scanner.down = true;
      const pending = await uploaded(u1, dm, pdfBytes("hid-mixed"));
      scanner.down = false;
      const mixed = (
        await post(u1, dm, {
          attachments: [
            { attachmentId: clean.attachmentId },
            { attachmentId: pending.attachmentId },
          ],
        })
      ).json().messageId as string;
      const plain = (await post(u1, dm, { body: "hello" })).json().messageId as string;
      const view = await list(u2, dm);
      expect(hiddenOf(view, mixed)).toBe(1);
      expect(attachmentsOf(view, mixed)).toHaveLength(1);
      expect(hiddenOf(view, plain) ?? 0).toBe(0);

      const gone = await uploaded(u1, dm, pdfBytes("hid-del"));
      const goneId = (
        await post(u1, dm, { attachments: [{ attachmentId: gone.attachmentId }] })
      ).json().messageId as string;
      await app.inject({
        method: "DELETE",
        url: `/api/v1/messaging/messages/${goneId}`,
        headers: as(u1),
      });
      expect(hiddenOf(await list(u2, dm), goneId) ?? 0).toBe(0);
    });

    it("deleting an attachment-only message tombstones it: no body, no attachments, 'Message deleted' preview", async () => {
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("att-del"));
      const messageId = (await post(u1, dm, { attachments: [{ attachmentId }] })).json()
        .messageId as string;
      const del = await app.inject({
        method: "DELETE",
        url: `/api/v1/messaging/messages/${messageId}`,
        headers: as(u1),
      });
      expect(del.statusCode).toBeLessThan(300);
      const seen = await list(u2, dm);
      expect(bodyOf(seen, messageId)).toBe("");
      expect(attachmentsOf(seen, messageId)).toEqual([]);
      expect(await lastPreview(u2, dm)).toBe("Message deleted");
    });
  });

  // WP 1.8 / SG-03: the M36 read routes that surface message, attachment or alert content each leave a row in the
  // audit trail. `app` above has no `db` (the emitter is inert without one), so this builds the same routes on a
  // server that has the real wardenx_app handle. The single-resource reads carry the resource id (a missing
  // `resourceIdParam` makes the audit insert fail on the uuid cast and the best-effort emitter swallows it).
  describe("read-audit emission (WP 1.8)", () => {
    let auditApp: FastifyInstance;
    beforeAll(async () => {
      auditApp = buildServer({
        db: handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
        idempotencyStore: createDbIdempotencyStore(handle.db),
      });
      registerMessagingRoutes(auditApp, { service: routeService });
      registerAttachmentRoutes(auditApp, { service: attachments });
      await auditApp.ready();
    });
    afterAll(async () => {
      await auditApp?.close();
    });

    const readEvents = async (eventType: string, resourceId: string | null) =>
      (
        await admin.query(
          `SELECT resource_id::text AS rid FROM audit_event
            WHERE organization_id=$1 AND event_type=$2 AND actor_user_id=$3
              AND ($4::text IS NULL OR resource_id::text=$4)`,
          [ORG_A, eventType, u2, resourceId],
        )
      ).rows as Array<{ rid: string | null }>;

    it("every message/attachment/alert read lands a read event, with the resource id on single-resource reads", async () => {
      const { attachmentId } = await uploaded(u1, dm, pdfBytes("wp18-read"));
      const sent = await send(u1, dm, [attachmentId], ORG_A, "wp18 body");
      expect(sent.statusCode).toBe(201);
      const rootId = sent.json().messageId as string;
      const get = (url: string) => auditApp.inject({ method: "GET", url, headers: as(u2) });
      const cases: Array<{ url: string; eventType: string; resourceId: string | null }> = [
        {
          url: "/api/v1/messaging/channels",
          eventType: "messaging_channel.list_viewed",
          resourceId: null,
        },
        {
          url: `/api/v1/messaging/channels/${dm}`,
          eventType: "messaging_channel.viewed",
          resourceId: dm,
        },
        {
          url: `/api/v1/messaging/channels/${dm}/messages`,
          eventType: "message.list_viewed",
          resourceId: null,
        },
        {
          url: `/api/v1/messaging/channels/${dm}/mention-candidates?q=a`,
          eventType: "message_mention_candidate.viewed",
          resourceId: dm,
        },
        {
          url: `/api/v1/messaging/attachments/${attachmentId}/access`,
          eventType: "message_attachment.viewed",
          resourceId: attachmentId,
        },
        { url: "/api/v1/alerts/inbox", eventType: "alert.list_viewed", resourceId: null },
        // WP 2.4: the pin list decrypts bodies, so it is an aggregate list read like the channel history
        {
          url: `/api/v1/messaging/channels/${dm}/pins`,
          eventType: "message.list_viewed",
          resourceId: null,
        },
        // WP 2.2: the thread read names its root message (a missing resourceIdParam would be swallowed silently)
        {
          url: `/api/v1/messaging/channels/${dm}/messages/${rootId}/thread`,
          eventType: "message.viewed",
          resourceId: rootId,
        },
      ];
      for (const c of cases) {
        const before = (await readEvents(c.eventType, c.resourceId)).length;
        const res = await get(c.url);
        expect(res.statusCode, c.url).toBe(200);
        const after = await readEvents(c.eventType, c.resourceId);
        expect(after.length, `${c.url} left no ${c.eventType} event`).toBe(before + 1);
        if (c.resourceId) expect(after.at(-1)?.rid).toBe(c.resourceId);
      }
    });
  });

  describe("wiring (bound is not computing)", () => {
    it("the composition root mounts the routes with a binding and registers + schedules the scan sweep", () => {
      const root = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
      expect(root).toContain("attachments: m36AttachmentBinding");
      expect(root).toContain("registerM36AttachmentScanWorker(");
      expect(root).toContain("scheduleM36AttachmentScanJobs(");
      expect(root).toContain("buildM36AttachmentBinding(process.env");
      // H1: the eraser is handed the storage port; M3: the reaper is handed the only credential that may delete rows
      expect(root).toContain("attachmentStorage: buildM36AttachmentStorage(process.env)");
      expect(root).toContain("reaperDb: destructionDbHandle?.db");
    });
  });
});
