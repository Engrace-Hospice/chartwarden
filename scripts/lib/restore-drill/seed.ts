/**
 * Seed for the M36 restore drill: two tenants with messages, edits (revisions) and attachments, written THROUGH the
 * real M36 route stack (Authorization Contract, channel_visibility ABAC, idempotency store, catalog-validating outbox,
 * the real attachment service and scan gate) as the NOBYPASSRLS `chartwarden_app` role, over the real SigV4 S3 adapter
 * against the drill's private MinIO. Only the identity preconditions (organizations, users, memberships) are inserted
 * directly as the superuser, exactly as the live suites do.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { type DbClient, createDbClient } from "@chartwarden/db";
import type { IdempotencyStore } from "@chartwarden/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { buildServer } from "../../../apps/backend/src/bootstrap/index";
import {
  buildBootOutboxCatalog,
  buildTxOutboxPublisher,
} from "../../../apps/backend/src/bootstrap/outbox-persister";
import { createDbIdempotencyStore } from "../../../apps/backend/src/bootstrap/plugins/idempotency-store-db";
import { createM22BackedAttachmentStorage } from "../../../apps/backend/src/m36-attachment-storage";
import {
  type ObjectStorePort,
  createS3ObjectStore,
  createS3TenantStorageProvisioner,
  deriveTenantBucket,
} from "../../../apps/backend/src/modules/22-documents";
import { createDbAnnouncementService } from "../../../apps/backend/src/modules/36-messaging/announcement-service-db";
import { createBuiltinScanner } from "../../../apps/backend/src/modules/36-messaging/attachments/attachment-scanners";
import { createAttachmentService } from "../../../apps/backend/src/modules/36-messaging/attachments/attachment-service-db";
import { M36_OUTBOX_EVENTS } from "../../../apps/backend/src/modules/36-messaging/events-by-m36";
import { CHANNEL_VISIBILITY_PREDICATE } from "../../../apps/backend/src/modules/36-messaging/index";
import { createDbMessagingRouteService } from "../../../apps/backend/src/modules/36-messaging/messaging-route-service-db";
import { registerAttachmentRoutes } from "../../../apps/backend/src/modules/36-messaging/routes/attachment-routes";
import { registerMessagingRoutes } from "../../../apps/backend/src/modules/36-messaging/routes/messaging-routes";
import type { Minio } from "./docker";
import { MINIO_ROOT_PASSWORD, MINIO_ROOT_USER } from "./docker";

export const ORG_A = "a1111111-1111-4111-8111-1111000d0001";
export const ORG_B = "b2222222-2222-4222-8222-2222000d0001";
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const QUARANTINE_AGE_DAYS = 8; // past MESSAGING_ATTACHMENT_RETENTION_DAYS (7)
const KB = 1024;

export interface OrgFixture {
  readonly orgId: string;
  readonly userA: string;
  readonly userB: string;
  readonly channelId: string;
}

export interface World {
  readonly orgs: readonly OrgFixture[];
  readonly store: ObjectStorePort;
  seedBaseline(): Promise<void>;
  seedAfterBackup(): Promise<void>;
  close(): Promise<void>;
}

export interface WorldConfig {
  readonly adminUrl: string;
  readonly appUrl: string;
  readonly destructionUrl: string;
  readonly minio: Minio;
  readonly kek: Buffer;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A PDF-shaped payload (the built-in scanner checks the magic bytes against the declared type) padded to `size`. */
function pdfOfSize(tag: string, size: number): Uint8Array {
  const head = Buffer.from(`%PDF-1.4\n% ${tag}\n`);
  const tail = Buffer.from("\n%%EOF");
  const fillerLength = Math.max(0, size - head.length - tail.length);
  return Buffer.concat([
    head,
    Buffer.from(randomBytes(fillerLength).toString("hex").slice(0, fillerLength)),
    tail,
  ]);
}

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = ["clinical_rn"];
  request.context.locationIds = [];
}

async function seedIdentities(admin: Client): Promise<Array<{ orgId: string; users: string[] }>> {
  const out: Array<{ orgId: string; users: string[] }> = [];
  for (const [orgId, slug] of [
    [ORG_A, "drill-a"],
    [ORG_B, "drill-b"],
  ] as const) {
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)`,
      [orgId, slug],
    );
    const users: string[] = [];
    for (const n of ["one", "two"]) {
      const id = (
        await admin.query(`INSERT INTO "user" (email, name) VALUES ($1,$2) RETURNING id`, [
          `${slug}-${n}@drill.test`,
          `${slug} ${n}`,
        ])
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
        [id, orgId],
      );
      users.push(id);
    }
    out.push({ orgId, users });
  }
  return out;
}

export async function createWorld(cfg: WorldConfig): Promise<World> {
  const admin = new Client({ connectionString: cfg.adminUrl });
  await admin.connect();
  const identities = await seedIdentities(admin);
  const handle = createDbClient({ connectionString: cfg.appUrl });
  const destroyer = createDbClient({ connectionString: cfg.destructionUrl });

  const s3 = {
    endpoint: cfg.minio.endpoint,
    accessKeyId: MINIO_ROOT_USER,
    secretAccessKey: MINIO_ROOT_PASSWORD,
    forcePathStyle: true,
  };
  const store = createS3ObjectStore(s3);
  const provisioner = createS3TenantStorageProvisioner(s3);
  const storage = createM22BackedAttachmentStorage({
    publicStore: store,
    internalStore: store,
    ensureTenantBucket: (organizationId) =>
      provisioner.ensureTenantPrefixes({ organizationId: organizationId as never, prefixes: [] }),
  });

  const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M36_OUTBOX_EVENTS]));
  const outbox = {
    publish: (tx: unknown, e: Record<string, unknown>) =>
      publisher.publish(tx as never, { ...e, callerModule: "m36" } as never),
  };
  const routeService = createDbMessagingRouteService(handle.db as DbClient, {
    kek: cfg.kek,
    outbox: outbox as never,
  });
  const attachments = createAttachmentService({
    db: handle.db,
    storage,
    scanner: createBuiltinScanner(),
    outbox: outbox as never,
    canViewChannel: routeService.canViewChannel,
    reaperDb: destroyer.db,
  });

  const orgs: OrgFixture[] = [];
  for (const { orgId, users } of identities) {
    const [userA, userB] = users as [string, string];
    orgs.push({
      orgId,
      userA,
      userB,
      channelId: (await routeService.openDm(orgId, userA, userB)).channelId,
    });
  }

  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      identities.flatMap(({ orgId, users }) =>
        users.map((userId) => ({
          orgId,
          userId,
          grants: [
            {
              roleKey: "seed",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["messaging.read", "messaging.send"],
            },
          ],
        })),
      ),
    ).store,
  );
  const registry = createPredicateRegistry();
  registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
    const channelId = typeof target.id === "string" ? target.id : null;
    if (!channelId || !ctx.organizationId || !ctx.userId) return false;
    return routeService.canViewChannel(ctx.organizationId, ctx.userId, channelId);
  });
  registerAbacRegistry(registry);
  const idempotencyStore: IdempotencyStore = createDbIdempotencyStore(handle.db);
  const app: FastifyInstance = buildServer({
    authenticate: headerAuth,
    security: { rateLimitEnabled: false },
    idempotencyStore,
  });
  registerMessagingRoutes(app, {
    service: routeService,
    announcements: createDbAnnouncementService(handle.db),
  });
  registerAttachmentRoutes(app, { service: attachments });

  const headers = (userId: string, orgId: string) => ({
    "x-test-user": userId,
    "x-test-org": orgId,
    "idempotency-key": randomUUID(),
  });

  async function call<T>(
    method: "POST" | "PATCH",
    url: string,
    userId: string,
    orgId: string,
    payload: unknown,
    expected: number,
  ): Promise<T> {
    const res = await app.inject({
      method,
      url,
      headers: headers(userId, orgId),
      payload: payload as never,
    });
    if (res.statusCode !== expected) {
      throw new Error(
        `${method} ${url} -> ${res.statusCode} (wanted ${expected}): ${res.body.slice(0, 300)}`,
      );
    }
    return res.json() as T;
  }

  /** authorize -> real presigned PUT to MinIO -> complete (scan). Returns the attachment id. */
  async function upload(
    org: OrgFixture,
    bytes: Uint8Array,
    contentType = "application/pdf",
  ): Promise<string> {
    const auth = await call<{
      attachmentId: string;
      upload: { url: string; headers: Record<string, string> };
    }>(
      "POST",
      "/api/v1/messaging/attachments/uploads",
      org.userA,
      org.orgId,
      {
        channelId: org.channelId,
        fileName: `drill-${randomUUID().slice(0, 8)}.pdf`,
        contentType,
        byteSize: bytes.length,
        sha256Hex: sha256(bytes),
      },
      201,
    );
    const put = await fetch(auth.upload.url, {
      method: "PUT",
      headers: auth.upload.headers,
      body: Buffer.from(bytes),
    });
    if (!put.ok) throw new Error(`presigned PUT failed: HTTP ${put.status}`);
    await call(
      "POST",
      `/api/v1/messaging/attachments/${auth.attachmentId}/complete`,
      org.userA,
      org.orgId,
      {},
      200,
    );
    return auth.attachmentId;
  }

  async function send(
    org: OrgFixture,
    body: string,
    attachmentIds: string[] = [],
  ): Promise<string> {
    const res = await call<{ messageId: string }>(
      "POST",
      `/api/v1/messaging/channels/${org.channelId}/messages`,
      org.userA,
      org.orgId,
      { body, attachments: attachmentIds.map((attachmentId) => ({ attachmentId })) },
      201,
    );
    return res.messageId;
  }

  const edit = (org: OrgFixture, messageId: string, body: string) =>
    call("PATCH", `/api/v1/messaging/messages/${messageId}`, org.userA, org.orgId, { body }, 200);

  /** A quarantined (EICAR) upload aged past retention, destroyed by the real reaper under the destruction credential. */
  async function quarantineAndReap(org: OrgFixture): Promise<void> {
    const id = await upload(org, Buffer.from(EICAR), "application/pdf");
    await admin.query(
      `UPDATE message_attachment SET scanned_at = now() - make_interval(days => $2) WHERE id = $1 AND scan_state = 'quarantined'`,
      [id, QUARANTINE_AGE_DAYS],
    );
    const result = await attachments.reapOrphansForOrg(org.orgId);
    if (result.reaped < 1 || result.failed > 0) {
      throw new Error(`reaper did not destroy the quarantined object: ${JSON.stringify(result)}`);
    }
  }

  const [orgA, orgB] = orgs as [OrgFixture, OrgFixture];

  return {
    orgs,
    store,
    async seedBaseline() {
      for (const org of orgs) await storage.ensureBucket?.(org.orgId);
      const plan: Array<[OrgFixture, number, number[]]> = [
        [orgA, 10, [1200 * KB, 300 * KB, 20 * KB]],
        [orgB, 5, [64 * KB, 8 * KB]],
      ];
      for (const [org, messages, sizes] of plan) {
        const ids: string[] = [];
        for (let i = 0; i < messages; i += 1) {
          const sizeIdx = i - (messages - sizes.length);
          const attachmentIds =
            sizeIdx >= 0
              ? [await upload(org, pdfOfSize(`seed-${i}`, sizes[sizeIdx] as number))]
              : [];
          ids.push(
            await send(org, `baseline message ${i} for ${org.orgId.slice(0, 4)}`, attachmentIds),
          );
        }
        await edit(org, ids[0] as string, "baseline message 0 (edited once)");
        await edit(org, ids[0] as string, "baseline message 0 (edited twice)");
      }
      await quarantineAndReap(orgA);
    },
    async seedAfterBackup() {
      // The data the backup does not have: this is what the RPO measurement counts as lost.
      await send(orgA, "post-backup A1");
      await send(orgA, "post-backup A2", [await upload(orgA, pdfOfSize("post-backup", 40 * KB))]);
      await send(orgB, "post-backup B1");
    },
    async close() {
      await app.close();
      resetAbacRegistry();
      resetAuthorizationContract();
      resetRbacEngine();
      await handle.close();
      await destroyer.close();
      await admin.end();
    },
  };
}

export { deriveTenantBucket };
