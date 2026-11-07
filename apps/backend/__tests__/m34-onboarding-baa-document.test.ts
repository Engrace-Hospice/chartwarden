// M34 — `POST /api/v1/platform/tenants/:orgSlug/baa-document`: a platform operator uploads the signed BAA for a tenant that is still
// onboarding. The guard stack through the REAL guards (its OWN permission, `tenant_lifecycle_platform_ops`, step-up, AI-actor block,
// Idempotency-Key, reason, the body's shape and size), and the service's status lock, audit row and object clean-up over a stubbed
// database. The live suite (m22-tenant-baa-document.live.test.ts) proves the same on the real roles, rows and RLS.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import { ChartWardenError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type {
  OnboardingBaaDocumentPort,
  OnboardingBaaDocumentUpload,
} from "../src/bootstrap/onboarding-baa-document-port";
import {
  type OnboardingDataService,
  type OnboardingOperator,
  buildDrizzleOnboardingDataService,
  mountTenantPlatformRoutes,
} from "../src/modules/34-saas-tenant-platform/index";
import { ONBOARDING_DATA_AUDIT_EVENTS } from "../src/modules/34-saas-tenant-platform/routes/platform/onboarding-data-audit";

const PLATFORM_ORG = "11111111-1111-4111-8111-111111111111";
const TARGET_ORG = "22222222-2222-4222-8222-222222222222";
const OPERATOR_USER = "ops-user";
const MEMBERSHIP = "30000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "50000000-0000-4000-8000-000000000001";
const KEY = "tenant_baa_document.upload_platform";
const URL = "/api/v1/platform/tenants/tenant-b/baa-document";
const PDF_BASE64 = Buffer.from("%PDF-1.7 synthetic agreement").toString("base64");
const BODY = {
  contentBase64: PDF_BASE64,
  mimeType: "application/pdf",
  reason: "  BAA signed, ticket CHG-2001  ",
};

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? "");
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.attributes.membershipId = MEMBERSHIP;
  if (request.headers["x-step-up"] === "fresh") request.context.attributes.stepUpRecent = true;
  const kind = request.headers["x-actor-kind"];
  if (typeof kind === "string") request.context.attributes.actorKind = kind;
}

interface UploadCall {
  readonly op: OnboardingOperator;
  readonly orgSlug: string;
  readonly input: { readonly contentBase64: string; readonly mimeType: string };
  readonly reason: string;
}

function recordingService(calls: UploadCall[]): OnboardingDataService {
  return {
    uploadBaaDocument: async (
      op: OnboardingOperator,
      orgSlug: string,
      input: UploadCall["input"],
      reason: string,
    ) => {
      calls.push({ op, orgSlug, input, reason });
      return {
        documentId: DOCUMENT_ID,
        mimeType: input.mimeType,
        byteSize: 28,
        sha256Hex: "a".repeat(64),
      };
    },
  } as unknown as OnboardingDataService;
}

const grant = (userId: string, roleKey: string, permissionKeys: readonly string[]) => ({
  orgId: PLATFORM_ORG,
  userId,
  grants: [{ roleKey, enabled: true, expiresAt: null, permissionKeys: [...permissionKeys] }],
});

function makeServer(calls: UploadCall[]) {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      grant(OPERATOR_USER, "platform_ops", [KEY]),
      // a tenant administrator holds no platform key
      { orgId: TARGET_ORG, userId: "tenant-admin", grants: [] },
      // a platform role that is NOT platform_ops: holds the key, fails the predicate
      grant("support-user", "platform_ops", [KEY]),
      // the broad keys an operator already holds: neither is this key, and `documents.upload` opens nothing here
      grant("broad-user", "platform_ops", [
        "tenant_onboarding_data.write_platform",
        "tenant_clearinghouse.write_platform",
        "documents.upload",
      ]),
    ]).store,
  );
  const reg = createPredicateRegistry();
  reg.register("tenant_lifecycle_platform_ops", async (c) => c.roles.includes("platform_ops"));
  reg.register("step_up_recent", async (c) => c.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountTenantPlatformRoutes(app, {} as DbClient, {
    onboardingData: { service: recordingService(calls) },
  });
  return app;
}

const OPS = {
  "x-test-user": OPERATOR_USER,
  "x-test-org": PLATFORM_ORG,
  "x-test-roles": "platform_ops",
};
let keySeq = 0;
const key = (): string => `baa-k-${++keySeq}`;
const fresh = (): Record<string, string> => ({
  ...OPS,
  "x-step-up": "fresh",
  "idempotency-key": key(),
});

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("POST baa-document: the guard stack", () => {
  it("refuses a tenant admin, an operator holding only the broad keys, a non-platform_ops role, a stale step-up, an AI actor and a missing key", async () => {
    const calls: UploadCall[] = [];
    const app = makeServer(calls);
    const send = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: URL, headers, payload: BODY });
    const asUser = (user: string, org: string, roles: string) => ({
      "x-test-user": user,
      "x-test-org": org,
      "x-test-roles": roles,
      "x-step-up": "fresh",
      "idempotency-key": key(),
    });

    expect((await send(asUser("tenant-admin", TARGET_ORG, "org_admin"))).statusCode).toBe(403);
    // the broad onboarding keys and `documents.upload` do not open this door: it has its own key
    expect((await send(asUser("broad-user", PLATFORM_ORG, "platform_ops"))).statusCode).toBe(403);
    expect(
      (await send(asUser("support-user", PLATFORM_ORG, "platform_support_t2"))).statusCode,
    ).toBe(403);
    const stale = await send({ ...OPS, "idempotency-key": key() });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error?.code ?? stale.json().code).toBe("STEP_UP_REQUIRED");
    expect((await send({ ...fresh(), "x-actor-kind": "ai_agent" })).statusCode).toBe(403);
    const { "idempotency-key": _omit, ...noKey } = fresh();
    const missingKey = await send(noKey);
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json().error?.code ?? missingKey.json().code).toBe(
      "IDEMPOTENCY_KEY_REQUIRED",
    );

    expect(calls).toEqual([]);
    await app.close();
  });

  it("answers 401 with no session", async () => {
    const calls: UploadCall[] = [];
    const app = makeServer(calls);
    const res = await app.inject({ method: "POST", url: URL, payload: BODY });
    expect(res.statusCode).toBe(401);
    expect(calls).toEqual([]);
    await app.close();
  });
});

describe("POST baa-document: the reason and the body", () => {
  it("requires a reason of 8-500 characters after normalising, and screens it for a patient identifier", async () => {
    const calls: UploadCall[] = [];
    const app = makeServer(calls);
    const { reason: _drop, ...noReason } = BODY;
    for (const payload of [
      noReason,
      { ...BODY, reason: "short" },
      { ...BODY, reason: " ".repeat(20) },
      { ...BODY, reason: "x".repeat(501) },
      { ...BODY, reason: "patient 078-05-1120 asked for it" },
    ]) {
      const res = await app.inject({ method: "POST", url: URL, headers: fresh(), payload });
      expect(res.statusCode, JSON.stringify((payload as { reason?: string }).reason ?? null)).toBe(
        422,
      );
    }
    expect(calls).toEqual([]);
    await app.close();
  });

  it("takes only the bytes and their type: a body that names a document kind, a patient or an extra field is a 422", async () => {
    const calls: UploadCall[] = [];
    const app = makeServer(calls);
    for (const extra of [
      { aggregateType: "other" },
      { aggregateId: DOCUMENT_ID },
      { patientId: DOCUMENT_ID },
      { retentionClass: "clinical_record" },
      { title: "anything" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: fresh(),
        payload: { ...BODY, ...extra },
      });
      expect(res.statusCode, JSON.stringify(extra)).toBe(422);
    }
    const { contentBase64: _bytes, ...noBytes } = BODY;
    expect(
      (await app.inject({ method: "POST", url: URL, headers: fresh(), payload: noBytes }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: "POST",
          url: URL,
          headers: fresh(),
          payload: { ...BODY, mimeType: "text/html" },
        })
      ).statusCode,
    ).toBe(422);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("refuses a body over the upload limit before it is parsed (413)", async () => {
    const calls: UploadCall[] = [];
    const app = makeServer(calls);
    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: fresh(),
      payload: { ...BODY, contentBase64: "A".repeat(Math.ceil((26 * 1024 * 1024 * 4) / 3)) },
    });
    expect(res.statusCode).toBe(413);
    expect(calls).toEqual([]);
    await app.close();
  });
});

describe("POST baa-document: what reaches the service", () => {
  it("answers 201 with the document the server filed; the operator is the session and the reason is normalised", async () => {
    const calls: UploadCall[] = [];
    const app = makeServer(calls);
    const res = await app.inject({ method: "POST", url: URL, headers: fresh(), payload: BODY });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({
      documentId: DOCUMENT_ID,
      mimeType: "application/pdf",
      byteSize: 28,
      sha256Hex: "a".repeat(64),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      orgSlug: "tenant-b",
      input: { contentBase64: PDF_BASE64, mimeType: "application/pdf" },
      reason: "BAA signed, ticket CHG-2001",
      op: { userId: OPERATOR_USER, membershipId: MEMBERSHIP, organizationId: PLATFORM_ORG },
    });
    await app.close();
  });
});

// ── the service over a stubbed database ─────────────────────────────────────────────────────────────────

interface InsertedRow {
  readonly table: unknown;
  readonly values: Record<string, unknown>;
}
const resolveTenant = async (slug: string) =>
  slug === "tenant-b" ? { organizationId: TARGET_ORG } : null;

function stubDb(tenantStatus: string | null, options: { failInserts?: boolean } = {}) {
  const inserts: InsertedRow[] = [];
  const select = () => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () =>
          table === schema.tenantAccount && tenantStatus !== null
            ? [{ id: "acct-1", status: tenantStatus }]
            : [],
      }),
    }),
  });
  const tx: Record<string, unknown> = {
    select,
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        if (options.failInserts) throw new Error("audit insert refused");
        inserts.push({ table, values });
      },
    }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
    execute: async () => undefined,
  };
  const db = { select, transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  return { db: db as unknown as DbClient, inserts, tx };
}

const OPERATOR: OnboardingOperator = {
  userId: "a0000000-0000-4000-8000-000000000001",
  membershipId: MEMBERSHIP,
  organizationId: PLATFORM_ORG,
  roles: ["platform_ops"],
  stepUpRecent: true,
  request: {
    correlationId: "corr-1",
    requestId: "req-1",
    route: "POST /api/v1/platform/tenants/:orgSlug/baa-document",
  },
};
const INPUT = { contentBase64: PDF_BASE64, mimeType: "application/pdf" };
const REASON = "BAA signed, ticket CHG-2001";

function fakePort(overrides: Partial<OnboardingBaaDocumentPort> = {}) {
  const discard = vi.fn(async () => undefined);
  const upload = vi.fn(
    async (): Promise<OnboardingBaaDocumentUpload> => ({
      resourceId: DOCUMENT_ID,
      view: {
        documentId: DOCUMENT_ID,
        mimeType: "application/pdf",
        byteSize: 28,
        sha256Hex: "b".repeat(64),
      },
      detail: {
        documentKind: "tenant_baa",
        mimeType: "application/pdf",
        byteSize: 28,
        sha256Hex: "b".repeat(64),
      },
      discard,
    }),
  );
  return { port: { upload, ...overrides } as OnboardingBaaDocumentPort, upload, discard };
}

describe("service: uploadBaaDocument", () => {
  it("files on the transaction scoped to the tenant and writes one audit row naming the operator, the tenant, the reason and the document", async () => {
    const { db, inserts, tx } = stubDb("onboarding");
    const { port, upload } = fakePort();
    const service = buildDrizzleOnboardingDataService({ db, resolveTenant, baaDocuments: port });

    const view = await service.uploadBaaDocument(OPERATOR, "tenant-b", INPUT, REASON);

    expect(view).toMatchObject({ documentId: DOCUMENT_ID });
    expect(upload).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        organizationId: TARGET_ORG,
        operatorUserId: OPERATOR.userId,
        operatorMembershipId: MEMBERSHIP,
      }),
      INPUT,
    );
    const audit = inserts.filter(
      (i) => i.values.eventType === ONBOARDING_DATA_AUDIT_EVENTS.baaDocumentUploaded,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.values).toMatchObject({
      outcome: "success",
      organizationId: TARGET_ORG,
      actorUserId: OPERATOR.userId,
      actorRole: "platform_ops",
      context: expect.objectContaining({
        reason: REASON,
        targetOrganizationId: TARGET_ORG,
        operatorMembershipId: MEMBERSHIP,
        documentKind: "tenant_baa",
        sha256Hex: "b".repeat(64),
      }),
    });
    // the bytes never reach the audit row
    expect(JSON.stringify(audit[0]?.values)).not.toContain(PDF_BASE64);
  });

  it("accepts only provisioning and onboarding: every other status is a 409, audited, and nothing is filed", async () => {
    for (const status of schema.tenantAccountStatus.enumValues) {
      const { db, inserts } = stubDb(status);
      const { port, upload } = fakePort();
      const service = buildDrizzleOnboardingDataService({ db, resolveTenant, baaDocuments: port });
      const attempt = service.uploadBaaDocument(OPERATOR, "tenant-b", INPUT, REASON);
      if (status === "provisioning" || status === "onboarding") {
        await expect(attempt, status).resolves.toBeDefined();
        continue;
      }
      await expect(attempt, status).rejects.toMatchObject({
        statusCode: 409,
        code: "TENANT_NOT_ONBOARDING",
      });
      expect(upload, status).not.toHaveBeenCalled();
      expect(
        inserts.map((i) => i.values.eventType),
        status,
      ).toEqual([ONBOARDING_DATA_AUDIT_EVENTS.writeRefused]);
    }
  });

  it("answers 503 when no document adapter is bound, 404 for an unknown tenant, and audits a refused file as write_failed", async () => {
    const unbound = buildDrizzleOnboardingDataService({
      db: stubDb("onboarding").db,
      resolveTenant,
    });
    await expect(
      unbound.uploadBaaDocument(OPERATOR, "tenant-b", INPUT, REASON),
    ).rejects.toMatchObject({ statusCode: 503, code: "ONBOARDING_BAA_DOCUMENTS_UNBOUND" });

    const { port } = fakePort();
    const service = buildDrizzleOnboardingDataService({
      db: stubDb("onboarding").db,
      resolveTenant,
      baaDocuments: port,
    });
    await expect(
      service.uploadBaaDocument(OPERATOR, "no-such-tenant", INPUT, REASON),
    ).rejects.toMatchObject({ statusCode: 404 });

    const refused = stubDb("onboarding");
    const refusing = fakePort({
      upload: async () => {
        throw new ChartWardenError(
          "UPLOAD_CONTENT_MISMATCH",
          "document content does not match the declared MIME type",
          415,
        );
      },
    });
    const refusingService = buildDrizzleOnboardingDataService({
      db: refused.db,
      resolveTenant,
      baaDocuments: refusing.port,
    });
    await expect(
      refusingService.uploadBaaDocument(OPERATOR, "tenant-b", INPUT, REASON),
    ).rejects.toMatchObject({ statusCode: 415 });
    expect(refused.inserts).toHaveLength(1);
    expect(refused.inserts[0]?.values).toMatchObject({
      eventType: ONBOARDING_DATA_AUDIT_EVENTS.writeFailed,
      outcome: "denied",
      context: expect.objectContaining({
        attemptedEvent: ONBOARDING_DATA_AUDIT_EVENTS.baaDocumentUploaded,
        errorCode: "UPLOAD_CONTENT_MISMATCH",
      }),
    });
  });

  it("takes the stored object back out when the transaction fails AFTER the document was filed (the rows roll back, the object would not)", async () => {
    const { db } = stubDb("onboarding", { failInserts: true });
    const { port, discard } = fakePort();
    const service = buildDrizzleOnboardingDataService({ db, resolveTenant, baaDocuments: port });

    await expect(service.uploadBaaDocument(OPERATOR, "tenant-b", INPUT, REASON)).rejects.toThrow(
      "audit insert refused",
    );

    expect(discard).toHaveBeenCalledOnce();
  });

  it("discards nothing when the file itself was refused (nothing was stored)", async () => {
    const { db } = stubDb("onboarding");
    const refusing = fakePort({
      upload: async () => {
        throw new ChartWardenError("UPLOAD_SIZE_INVALID", "too big", 422);
      },
    });
    const service = buildDrizzleOnboardingDataService({
      db,
      resolveTenant,
      baaDocuments: refusing.port,
    });
    await expect(
      service.uploadBaaDocument(OPERATOR, "tenant-b", INPUT, REASON),
    ).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(refusing.discard).not.toHaveBeenCalled();
  });
});
