import { spawnSync } from "node:child_process";
/**
 * M34 + M22 — a platform operator uploads a tenant's signed BAA, LIVE Postgres on the real roles.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m34:baa-document:live   (SUPERUSER url, THROWAWAY database)
 *
 * The route is mounted over the REAL data service and M22's REAL upload pipeline (an in-memory object store stands in for MinIO) on the
 * NOBYPASSRLS `chartwarden_app` tenant pool, behind the REAL guards. The operator's permissions come from the REAL DB grant (migration
 * 1368 bound `tenant_baa_document.upload_platform` to `platform_ops`), not from an in-memory list. What a unit test cannot prove, and this does:
 *   - platform_ops files the BAA for an onboarding tenant: the document + version land in THAT org (visible to its RLS scope and to no other)
 *     under the one kind `tenant_baa`, the object is in the tenant's bucket, the audit row names the operator, tenant, reason, document id
 *     and digest, and the document's own write-audit trigger attributes the insert to the operator;
 *   - it cannot file any other kind: a body that names one is a 422, the generic documents route refuses platform_ops (403) and refuses
 *     the `tenant_baa` kind to a tenant user who does hold `documents.upload` (422), and the DB grant holds no `documents.*` key;
 *   - it cannot read other documents: the generic read routes refuse it (403) for the tenant's own and for the BAA document;
 *   - a tenant user's documents are unaffected: their pre-existing rows are untouched, the other tenant cannot see the BAA, and the
 *     ordinary upload route still works;
 *   - a refused file (type mismatch), an active tenant (409), an unknown tenant (404) store nothing; a failure AFTER the object was stored
 *     takes the object back out and leaves no row; an Idempotency-Key retry replays one upload.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type EffectivePermissionStore,
  createDbEffectivePermissionStore,
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { registerPlatformJob } from "@chartwarden/tenancy";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { m34PlatformBypassAuditor } from "../src/index";
import { createDbDocumentBackend } from "../src/modules/22-documents/documents-route-service-db";
import { deriveTenantBucket } from "../src/modules/22-documents/lifecycle/storage";
import { buildTenantBaaDocumentOnboardingPort } from "../src/modules/22-documents/onboarding-baa-document-port";
import { registerDocumentRoutes } from "../src/modules/22-documents/routes/documents-routes";
import { createServerUploadService } from "../src/modules/22-documents/routes/server-upload";
import { createInMemoryObjectStore } from "../src/modules/22-documents/seams/store";
import {
  buildDrizzleOnboardingDataService,
  buildPlatformTenantResolver,
  mountTenantPlatformRoutes,
} from "../src/modules/34-saas-tenant-platform/index";
import {
  appRoleConnectionString,
  appRoleUrl,
  dropLiveRoles,
  resetPublicSchema,
} from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const PLATFORM_PASSWORD = "platform-live-password-baa-document";
const JOB_ID = "m34-baa-document-live-test";

const PLATFORM_ORG = "a0000000-0000-4000-8000-0000000000a0";
const ORG_A = "a1000000-0000-4000-8000-0000000000a1"; // another tenant, active, with its own document
const ORG_B = "b2000000-0000-4000-8000-0000000000b2"; // the tenant being onboarded
const ORG_D = "d4000000-0000-4000-8000-0000000000d4"; // provisioning
const ORG_X = "e6000000-0000-4000-8000-0000000000e6"; // active: the upload is refused
const OPERATOR = "c3000000-0000-4000-8000-0000000000c3";
const OPERATOR_MEMBERSHIP = "e5000000-0000-4000-8000-0000000000e5";
const ADMIN_ONLY = "c3000000-0000-4000-8000-0000000000c4"; // platform_admin in the DB: no upload key
const ADMIN_ONLY_MEMBERSHIP = "e5000000-0000-4000-8000-0000000000e6";
const TENANT_USER = "c3000000-0000-4000-8000-0000000000c5"; // staff of ORG_B
const TENANT_MEMBERSHIP = "e5000000-0000-4000-8000-0000000000e7";
const DOC_A = "d1000000-0000-4000-8000-0000000000a1";
const DOC_B = "d1000000-0000-4000-8000-0000000000b2";
const REASON = "Signed BAA received from the customer, ticket CHG-7731";

const PDF = Buffer.from("%PDF-1.7\n% synthetic business associate agreement\n");
const PDF_BASE64 = PDF.toString("base64");
const PDF_SHA256 = createHash("sha256").update(PDF).digest("hex");
const BODY = { contentBase64: PDF_BASE64, mimeType: "application/pdf", reason: REASON };

const OPS_HEADERS = {
  "x-test-user": OPERATOR,
  "x-test-org": PLATFORM_ORG,
  "x-test-roles": "platform_ops",
};

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? "");
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const membership = request.headers["x-test-membership"];
  request.context.attributes.membershipId =
    typeof membership === "string" ? membership : OPERATOR_MEMBERSHIP;
  if (request.headers["x-step-up"] === "fresh") request.context.attributes.stepUpRecent = true;
  const kind = request.headers["x-actor-kind"];
  if (typeof kind === "string") request.context.attributes.actorKind = kind;
}

describe.skipIf(!DB_URL)("M34 BAA document upload, LIVE Postgres on the real roles", () => {
  let admin: Client;
  let tenantPool: ReturnType<typeof createDbClient>;
  let platformPool: ReturnType<typeof createDbClient>;
  let server: FastifyInstance;
  let objects: ReturnType<typeof createInMemoryObjectStore>;
  let seq = 0;
  let uploadedDocumentId = "";

  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await admin.query(text, params)).rows as T[];
  const headers = (extra: Record<string, string> = {}) => ({
    ...OPS_HEADERS,
    "x-step-up": "fresh",
    "idempotency-key": `baa-live-${++seq}`,
    ...extra,
  });
  const upload = (slug: string, payload: Record<string, unknown> = BODY, extra = {}) =>
    server.inject({
      method: "POST",
      url: `/api/v1/platform/tenants/${slug}/baa-document`,
      headers: headers(extra),
      payload,
    });
  const errorCode = (res: { json: () => Record<string, unknown> }): unknown => {
    const body = res.json();
    return (body.error as { code?: string } | undefined)?.code ?? body.code;
  };
  const documentsOf = (org: string) =>
    q<{ id: string; aggregate_type: string }>(
      "SELECT id, aggregate_type FROM document WHERE organization_id=$1 ORDER BY id",
      [org],
    );
  const tenantHeaders = (extra: Record<string, string> = {}) => ({
    "x-test-user": TENANT_USER,
    "x-test-org": ORG_B,
    "x-test-roles": "compliance_officer",
    "x-test-membership": TENANT_MEMBERSHIP,
    "idempotency-key": `tenant-live-${++seq}`,
    ...extra,
  });

  /** One query on the REAL `chartwarden_app` role, scoped to `org` exactly as a tenant request is. */
  const asTenant = async <T>(org: string, sql: string): Promise<T[]> => {
    const client = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.org_id', $1, true)", [org]);
      const { rows } = await client.query(sql);
      await client.query("ROLLBACK");
      return rows as T[];
    } finally {
      await client.end();
    }
  };

  const auditRows = (org: string, eventType: string) =>
    q<{
      actor_user_id: string | null;
      actor_role: string | null;
      outcome: string;
      resource_id: string | null;
      context: Record<string, unknown>;
    }>(
      "SELECT actor_user_id, actor_role, outcome, resource_id, context FROM audit_event WHERE organization_id=$1 AND event_type=$2 ORDER BY created_at",
      [org, eventType],
    );

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await admin.query("CREATE SCHEMA IF NOT EXISTS public");
    await dropLiveRoles(admin);
    const migrations = readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort();
    for (const f of migrations) await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    for (const [id, slug] of [
      [PLATFORM_ORG, "cw-platform"],
      [ORG_A, "baa-a"],
      [ORG_B, "baa-b"],
      [ORG_D, "baa-d"],
      [ORG_X, "baa-x"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    }
    for (const [id, email] of [
      [OPERATOR, "ops-baa@test.test"],
      [ADMIN_ONLY, "admin-baa@test.test"],
      [TENANT_USER, "tenant-baa@test.test"],
    ] as const) {
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [id, email]);
    }
    for (const [org, status] of [
      [ORG_A, "active"],
      [ORG_B, "onboarding"],
      [ORG_D, "provisioning"],
      [ORG_X, "active"],
    ] as const) {
      await admin.query(
        "INSERT INTO tenant_account (organization_id, status, legal_business_name, billing_contact_email, breach_notification_email) VALUES ($1,$2,$3,'b@x.test','p@x.test')",
        [org, status, `Tenant ${status}`],
      );
    }
    // A fresh database has no platform-owned role rows (`db:platform-role grant` creates them), so migration 1368 bound nothing.
    // Create them and re-apply it, as a deploy does once they exist.
    for (const key of ["platform_ops", "platform_admin"]) {
      await admin.query(
        `INSERT INTO role (organization_id, key, name, category, scope_level, enabled)
         VALUES (NULL, $1, $1, 'platform_staff'::role_category, 'organization', true)`,
        [key],
      );
    }
    const grantMigration = migrations.find((f) =>
      f.startsWith("1368_m34_tenant_baa_document_permission"),
    ) as string;
    await admin.query(readFileSync(join(MIGRATIONS_DIR, grantMigration), "utf8"));
    for (const [membership, user, role] of [
      [OPERATOR_MEMBERSHIP, OPERATOR, "platform_ops"],
      [ADMIN_ONLY_MEMBERSHIP, ADMIN_ONLY, "platform_admin"],
    ] as const) {
      await admin.query(
        "INSERT INTO membership (id, user_id, organization_id, status) VALUES ($1,$2,$3,'active')",
        [membership, user, PLATFORM_ORG],
      );
      await admin.query(
        `INSERT INTO membership_role (organization_id, membership_id, role_id)
         SELECT $1, $2, id FROM role WHERE organization_id IS NULL AND key = $3`,
        [PLATFORM_ORG, membership, role],
      );
    }
    // A tenant document in each of two tenants: the platform upload must touch neither.
    for (const [doc, org] of [
      [DOC_A, ORG_A],
      [DOC_B, ORG_B],
    ] as const) {
      await admin.query(
        `INSERT INTO document (id, organization_id, retention_class, source_kind, aggregate_type, title, created_by_membership_id)
         VALUES ($1,$2,'compliance','user_upload','other','Existing tenant document',$3)`,
        [doc, org, TENANT_MEMBERSHIP],
      );
    }

    tenantPool = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    const provisioned = spawnSync("bun", ["run", "scripts/db/provision-runtime-roles.ts"], {
      cwd: join(__dirname, "../../.."),
      env: {
        ...process.env,
        PROVISION_DATABASE_URL: DB_URL,
        CHARTWARDEN_PLATFORM_PASSWORD: PLATFORM_PASSWORD,
      },
      encoding: "utf8",
    });
    expect(provisioned.status, provisioned.stderr).toBe(0);
    const platformUrl = new URL(DB_URL as string);
    platformUrl.username = "chartwarden_platform_login";
    platformUrl.password = PLATFORM_PASSWORD;
    platformPool = createDbClient({ connectionString: platformUrl.toString() });

    objects = createInMemoryObjectStore();
    const uploads = createServerUploadService({ db: tenantPool.db, objects: objects.store });
    registerPlatformJob(JOB_ID);
    const service = buildDrizzleOnboardingDataService({
      db: tenantPool.db,
      resolveTenant: buildPlatformTenantResolver({
        platformDb: platformPool.db,
        auditBypass: m34PlatformBypassAuditor,
        platformJobId: JOB_ID,
      }),
      baaDocuments: buildTenantBaaDocumentOnboardingPort(uploads),
    });

    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    // The operator's permissions are the REAL DB grant; the tenant user's (who holds no DB role here) come from a list.
    const fromDb = createDbEffectivePermissionStore(tenantPool.db);
    const fromList = createInMemoryEffectivePermissionStore([
      {
        orgId: ORG_B,
        userId: TENANT_USER,
        grants: [
          {
            roleKey: "compliance_officer",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["documents.upload", "documents.read"],
          },
        ],
      },
    ]).store;
    const composite: EffectivePermissionStore = {
      loadGrants: (orgId, userId) =>
        (orgId === PLATFORM_ORG ? fromDb : fromList).loadGrants(orgId, userId),
    };
    registerEffectivePermissionResolver(composite);
    const reg = createPredicateRegistry();
    reg.register("tenant_lifecycle_platform_ops", async (c) => c.roles.includes("platform_ops"));
    reg.register("step_up_recent", async (c) => c.attributes.stepUpRecent === true);
    registerAbacRegistry(reg);
    server = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    mountTenantPlatformRoutes(server, tenantPool.db, { onboardingData: { service } });
    // The ordinary documents routes, over the SAME upload service: what a tenant user (and a platform_ops user) meets there.
    registerDocumentRoutes(server, {
      service: createDbDocumentBackend(tenantPool.db, {}, uploads).service,
      signedUrl: { mint: async () => ({}) } as never,
    });
  }, 300_000);

  afterAll(async () => {
    await server?.close();
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    await tenantPool?.close();
    await platformPool?.close();
    await admin?.end();
  });

  describe("platform_ops files the BAA for an onboarding tenant", () => {
    it("answers 201 with the document id and what the server verified of the bytes", async () => {
      const res = await upload("baa-b");
      expect(res.statusCode, res.body).toBe(201);
      const view = res.json();
      uploadedDocumentId = view.documentId;
      expect(view).toEqual({
        documentId: uploadedDocumentId,
        mimeType: "application/pdf",
        byteSize: PDF.byteLength,
        sha256Hex: PDF_SHA256,
      });
    });

    it("lands one tenant_baa document with its version in THAT org, in the tenant's bucket, under the operator", async () => {
      const [doc] = await q<Record<string, unknown>>("SELECT * FROM document WHERE id=$1", [
        uploadedDocumentId,
      ]);
      expect(doc).toMatchObject({
        organization_id: ORG_B,
        aggregate_type: "tenant_baa",
        retention_class: "compliance",
        source_kind: "user_upload",
        patient_id: null,
        admission_id: null,
        aggregate_id: null,
        patient_facing: false,
        status: "active",
        created_by_membership_id: OPERATOR_MEMBERSHIP,
      });
      const versions = await q<Record<string, unknown>>(
        "SELECT * FROM document_version WHERE document_id=$1",
        [uploadedDocumentId],
      );
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({
        organization_id: ORG_B,
        mime_type: "application/pdf",
        sha256_hex: PDF_SHA256,
        uploaded_by_membership_id: OPERATOR_MEMBERSHIP,
        id: doc?.active_version_id,
      });
      expect(Number(versions[0]?.byte_size)).toBe(PDF.byteLength);
      const bucket = deriveTenantBucket(ORG_B as never);
      const keys = [...objects.objects.keys()].filter((k) => k.startsWith(`${bucket}/`));
      expect(keys).toHaveLength(1);
      expect(Buffer.from(objects.objects.get(keys[0] as string) as Uint8Array)).toEqual(PDF);
    });

    it("is visible to the tenant's own RLS scope and to no other", async () => {
      const inB = await asTenant<{ id: string }>(
        ORG_B,
        `SELECT id FROM document WHERE id='${uploadedDocumentId}'`,
      );
      expect(inB).toHaveLength(1);
      for (const other of [ORG_A, PLATFORM_ORG]) {
        expect(
          await asTenant(other, `SELECT id FROM document WHERE id='${uploadedDocumentId}'`),
        ).toEqual([]);
        expect(
          await asTenant(
            other,
            `SELECT 1 FROM document_version WHERE document_id='${uploadedDocumentId}'`,
          ),
        ).toEqual([]);
      }
    });

    it("leaves ONE platform audit row naming the operator, tenant, reason, document id and digest, never the bytes, and the document trigger names the operator", async () => {
      const rows = await auditRows(ORG_B, "m34.tenant_onboarding.baa_document_uploaded");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_user_id: OPERATOR,
        actor_role: "platform_ops",
        outcome: "success",
        resource_id: uploadedDocumentId,
      });
      expect(rows[0]?.context).toMatchObject({
        reason: REASON,
        targetOrganizationId: ORG_B,
        operatorMembershipId: OPERATOR_MEMBERSHIP,
        documentKind: "tenant_baa",
        mimeType: "application/pdf",
        sha256Hex: PDF_SHA256,
      });
      expect(JSON.stringify(rows[0])).not.toContain(PDF_BASE64);
      const written = await q<{ actor_user_id: string | null }>(
        "SELECT actor_user_id FROM audit_event WHERE organization_id=$1 AND resource_id=$2 AND event_type <> 'm34.tenant_onboarding.baa_document_uploaded'",
        [ORG_B, uploadedDocumentId],
      );
      expect(written.length).toBeGreaterThan(0);
      expect(written.every((r) => r.actor_user_id === OPERATOR)).toBe(true);
    });

    it("also files for a provisioning tenant", async () => {
      const res = await upload("baa-d");
      expect(res.statusCode, res.body).toBe(201);
      expect((await documentsOf(ORG_D)).map((d) => d.aggregate_type)).toEqual(["tenant_baa"]);
    });

    it("replays an Idempotency-Key retry: ONE document, the same answer", async () => {
      const key = "baa-live-idem";
      const first = await server.inject({
        method: "POST",
        url: "/api/v1/platform/tenants/baa-b/baa-document",
        headers: headers({ "idempotency-key": key }),
        payload: BODY,
      });
      const second = await server.inject({
        method: "POST",
        url: "/api/v1/platform/tenants/baa-b/baa-document",
        headers: headers({ "idempotency-key": key }),
        payload: BODY,
      });
      expect(first.statusCode, first.body).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json()).toEqual(first.json());
      const rows = await q("SELECT 1 FROM document WHERE id=$1", [first.json().documentId]);
      expect(rows).toHaveLength(1);
    });
  });

  describe("it files nothing it should not", () => {
    it("refuses a file whose content is not its declared type: 415, no row, no object", async () => {
      const before = { docs: (await documentsOf(ORG_B)).length, objects: objects.objects.size };
      const res = await upload("baa-b", {
        ...BODY,
        contentBase64: Buffer.from("<html>not a pdf</html>").toString("base64"),
      });
      expect(res.statusCode, res.body).toBe(415);
      expect(errorCode(res)).toBe("UPLOAD_CONTENT_MISMATCH");
      expect((await documentsOf(ORG_B)).length).toBe(before.docs);
      expect(objects.objects.size).toBe(before.objects);
      const failed = await auditRows(ORG_B, "m34.tenant_onboarding.write_failed");
      expect(failed.at(-1)).toMatchObject({ outcome: "denied", actor_user_id: OPERATOR });
      expect(failed.at(-1)?.context).toMatchObject({ errorCode: "UPLOAD_CONTENT_MISMATCH" });
    });

    it("refuses text that is not base64 (422) and a tenant that is active (409, audited), storing nothing", async () => {
      const before = objects.objects.size;
      const bad = await upload("baa-b", { ...BODY, contentBase64: "not base64!!" });
      expect(bad.statusCode, bad.body).toBe(422);
      const active = await upload("baa-x");
      expect(active.statusCode, active.body).toBe(409);
      expect(errorCode(active)).toBe("TENANT_NOT_ONBOARDING");
      expect(await documentsOf(ORG_X)).toEqual([]);
      expect(objects.objects.size).toBe(before);
      expect(await auditRows(ORG_X, "m34.tenant_onboarding.write_refused")).toHaveLength(1);
    });

    it("answers 404 for an unknown tenant", async () => {
      const res = await upload("no-such-tenant");
      expect(res.statusCode).toBe(404);
    });

    it("takes the object back out and leaves no row when the transaction fails AFTER the document was filed", async () => {
      // The audit row is the step after the upload: make exactly that insert fail, as a database error would.
      await admin.query(
        `CREATE FUNCTION baa_live_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'baa live: audit insert refused'; END $$`,
      );
      await admin.query(
        `CREATE TRIGGER baa_live_fail_trg BEFORE INSERT ON audit_event FOR EACH ROW
           WHEN (NEW.event_type = 'm34.tenant_onboarding.baa_document_uploaded') EXECUTE FUNCTION baa_live_fail()`,
      );
      const before = { docs: (await documentsOf(ORG_B)).length, objects: objects.objects.size };
      try {
        const res = await upload("baa-b");
        expect(res.statusCode, res.body).toBe(500);
      } finally {
        await admin.query("DROP TRIGGER baa_live_fail_trg ON audit_event");
        await admin.query("DROP FUNCTION baa_live_fail()");
      }
      expect((await documentsOf(ORG_B)).length).toBe(before.docs);
      expect(objects.objects.size).toBe(before.objects);
    });
  });

  describe("it cannot file any other document kind", () => {
    it("refuses a body that names a kind, a patient or a title (422) and writes nothing", async () => {
      const before = (await documentsOf(ORG_B)).length;
      for (const extra of [
        { aggregateType: "other" },
        { aggregateType: "tenant_baa" },
        { patientId: "44444444-4444-4444-8444-444444444444" },
        { title: "anything" },
      ]) {
        const res = await upload("baa-b", { ...BODY, ...extra });
        expect(res.statusCode, JSON.stringify(extra)).toBe(422);
      }
      expect((await documentsOf(ORG_B)).length).toBe(before);
    });

    it("holds the upload key and NO documents key in its DB grant", async () => {
      const keys = await q<{ permission_key: string }>(
        `SELECT rp.permission_key FROM role_permission rp JOIN role r ON r.id = rp.role_id
          WHERE r.organization_id IS NULL AND r.key = 'platform_ops'
            AND (rp.permission_key LIKE 'documents.%' OR rp.permission_key LIKE 'tenant_baa_document.%')
          ORDER BY rp.permission_key`,
      );
      expect(keys.map((k) => k.permission_key)).toEqual(["tenant_baa_document.upload_platform"]);
      // and no other platform role carries it: the predicate admits platform_ops alone
      const holders = await q<{ key: string }>(
        `SELECT DISTINCT r.key FROM role_permission rp JOIN role r ON r.id = rp.role_id
          WHERE rp.permission_key = 'tenant_baa_document.upload_platform'`,
      );
      expect(holders.map((h) => h.key)).toEqual(["platform_ops"]);
    });

    it("refuses platform_ops the generic documents upload (403): it has no documents.upload", async () => {
      const before = (await documentsOf(ORG_B)).length;
      const res = await server.inject({
        method: "POST",
        url: "/api/v1/documents",
        headers: headers(),
        payload: {
          retentionClass: "compliance",
          aggregateType: "other",
          title: "smuggled",
          mimeType: "application/pdf",
          contentBase64: PDF_BASE64,
        },
      });
      expect(res.statusCode, res.body).toBe(403);
      expect((await documentsOf(ORG_B)).length).toBe(before);
    });

    it("refuses the tenant_baa kind on the generic route even to a tenant user who holds documents.upload (422)", async () => {
      const before = (await documentsOf(ORG_B)).length;
      const res = await server.inject({
        method: "POST",
        url: "/api/v1/documents",
        headers: tenantHeaders(),
        payload: {
          retentionClass: "compliance",
          aggregateType: "tenant_baa",
          title: "a BAA from the tenant side",
          mimeType: "application/pdf",
          contentBase64: PDF_BASE64,
        },
      });
      expect(res.statusCode, res.body).toBe(422);
      expect((await documentsOf(ORG_B)).length).toBe(before);
    });

    it("refuses a platform_admin who holds no upload key (403)", async () => {
      const res = await upload("baa-b", BODY, {
        "x-test-user": ADMIN_ONLY,
        "x-test-membership": ADMIN_ONLY_MEMBERSHIP,
      });
      expect(res.statusCode, res.body).toBe(403);
    });
  });

  describe("it cannot read other documents", () => {
    it("refuses platform_ops the generic reads (403): the tenant's own document, the BAA document and the list", async () => {
      for (const url of [
        `/api/v1/documents/${DOC_B}`,
        `/api/v1/documents/${uploadedDocumentId}`,
        `/api/v1/documents/${DOC_A}`,
        "/api/v1/documents",
      ]) {
        const res = await server.inject({ method: "GET", url, headers: OPS_HEADERS });
        expect(res.statusCode, url).toBe(403);
      }
    });

    it("returns the document id and digest from the upload route, nothing of any other document", async () => {
      const res = await upload("baa-b");
      expect(Object.keys(res.json()).sort()).toEqual([
        "byteSize",
        "documentId",
        "mimeType",
        "sha256Hex",
      ]);
      expect(res.body).not.toContain(DOC_B);
      expect(res.body).not.toContain(DOC_A);
    });
  });

  describe("a tenant user's documents are unaffected", () => {
    it("leaves the tenants' own documents untouched and keeps the other tenant blind to the BAA", async () => {
      const own = await q<{
        id: string;
        title: string;
        status: string;
        active_version_id: string | null;
      }>(
        "SELECT id, title, status, active_version_id FROM document WHERE id = ANY($1) ORDER BY id",
        [[DOC_A, DOC_B]],
      );
      expect(own).toEqual([
        { id: DOC_A, title: "Existing tenant document", status: "active", active_version_id: null },
        { id: DOC_B, title: "Existing tenant document", status: "active", active_version_id: null },
      ]);
      expect((await documentsOf(ORG_A)).map((d) => d.id)).toEqual([DOC_A]);
      const seenFromA = await asTenant<{ aggregate_type: string }>(
        ORG_A,
        "SELECT aggregate_type FROM document",
      );
      expect(seenFromA.map((d) => d.aggregate_type)).toEqual(["other"]);
    });

    it("still takes a tenant user's ordinary upload through the generic route, and lists their documents", async () => {
      const created = await server.inject({
        method: "POST",
        url: "/api/v1/documents",
        headers: tenantHeaders(),
        payload: {
          retentionClass: "compliance",
          aggregateType: "other",
          title: "Tenant's own outside record",
          mimeType: "application/pdf",
          contentBase64: PDF_BASE64,
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const [row] = await q<{
        organization_id: string;
        aggregate_type: string;
        created_by_membership_id: string;
      }>(
        "SELECT organization_id, aggregate_type, created_by_membership_id FROM document WHERE id=$1",
        [created.json().id],
      );
      expect(row).toMatchObject({
        organization_id: ORG_B,
        aggregate_type: "other",
        created_by_membership_id: TENANT_MEMBERSHIP,
      });
      const list = await server.inject({
        method: "GET",
        url: "/api/v1/documents",
        headers: tenantHeaders(),
      });
      expect(list.statusCode, list.body).toBe(200);
    });
  });
});
