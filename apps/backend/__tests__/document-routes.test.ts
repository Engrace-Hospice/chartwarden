// apps/backend/__tests__/document-routes.test.ts — M22-T07 route-inventory + §4.6 RBAC gating + §4.7 ABAC
// + cursor pagination + signed-URL issuance + §2.5 If-Match concurrency tests (M22 spec §4.1, §4.2, §4.6, §4.7).
//
// Exercises M22's routes through the FULL M1 middleware chain via Fastify `inject`, no live infra:
// buildServer() mounts the host, registerDocumentRoutes() mounts the §4.1 inventory over the in-memory
// document backend. The REAL Authorization Contract gates every route on the §4.6 keys; a header-auth shim
// populates request.context. The §4.7 predicates M22 owns are registered into the shared registry once
// (single-owner) over a SHARED backend so the resolver + the injected `isInCaseload` are stable across
// tests. Covers: RBAC gating (2xx with key, 403 without), §4.7 ABAC (document_owner_or_caseload,
// extraction_reviewer_eligible, form_template_publish_authority, tenant_template_overlay_edit_authority,
// legal_hold_aware), opaque cursor pagination (next_cursor + has_more), signed-URL mint (≤300s TTL), and
// the overlay If-Match optimistic-concurrency race (412).
import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { DbClient } from "@wardenx/db";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type DocumentRouteService,
  type SignedUrlObjectResolver,
  createDbDocumentRouteService,
  createInMemoryDocumentBackend,
  createSignedUrlService,
  registerDocumentAbacPredicates,
  registerDocumentRoutes,
} from "../src/modules/22-documents/index";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  // actorOf() in documents-routes.ts reads the acting MEMBERSHIP id from here (not ctx.userId) —
  // openReview() writes it into reviewer_membership_id; any non-empty string satisfies it here.
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  // No `x-test-licensure` here any more. It stamped `context.attributes.licensure`, which nothing in
  // production has ever written (F-030) — so the §4.7 high-risk-field gate answered "no" for every
  // reviewer, and the case below asserting an RN may decide passed only because this shim supplied
  // the licence itself. The licence now comes from M17's `CredentialReader`, seeded in CREDENTIALS.
}

/**
 * Active clinical credentials per membership — the shape M17's `CredentialReader` seam returns
 * (suspended / revoked / expired rows are already filtered out by the seam, so anything here is live).
 * The header shim sets `membershipId` = `x-test-user`, so these are keyed by user id.
 */
const CREDENTIALS: Record<string, readonly { kind: string; status: string }[]> = {
  rn_1: [{ kind: "rn", status: "active" }],
  pa_1: [{ kind: "pa", status: "active" }],
  // `aide_1` deliberately absent — an unlicensed reviewer holds no row at all.
};

const ORG = "org_a";
const ORG_B = "org_b";
const DOC = "c0000000-0000-4000-8000-0000000000aa";
const DOC_B = "c0000000-0000-4000-8000-0000000000bb";
const DOC_HOLD = "c0000000-0000-4000-8000-0000000000cc";
const VERSION = "d0000000-0000-4000-8000-000000000001";
const BATCH = "b0000000-0000-4000-8000-0000000000aa";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const PATIENT_OFF = "22222222-2222-4222-8222-222222222222";

/** Everything an intake reviewer needs at the RBAC layer, shared by the three reviewer personas so a
 *  403 in the §4.7 cases below can only ever come from the LICENSURE predicate (F-030). */
const REVIEWER_PERMISSIONS = [
  "documents.upload",
  "documents.read",
  "documents.read_phi_content",
  "documents.edit_metadata",
  "intake.upload",
  "intake.read",
  "intake.confirm_classification",
  "intake.review",
  "intake.discard_batch",
  "documents.read_templates",
];

const PERMISSION_SEED = [
  {
    userId: "rn_1",
    permissions: [
      "documents.upload",
      "documents.read",
      "documents.read_phi_content",
      "documents.edit_metadata",
      "intake.upload",
      "intake.read",
      "intake.confirm_classification",
      "intake.review",
      "intake.discard_batch",
      "documents.read_templates",
    ],
  },
  // Same RBAC grants as rn_1; the difference is the CREDENTIAL each holds (see CREDENTIALS).
  { userId: "pa_1", permissions: REVIEWER_PERMISSIONS },
  { userId: "aide_1", permissions: REVIEWER_PERMISSIONS },
  { userId: "viewer_1", permissions: ["documents.read_templates"] },
  { userId: "platform_1", permissions: ["documents.publish_template"] },
  { userId: "orgadmin_1", permissions: ["documents.manage_overlay", "documents.read_templates"] },
];

// A single shared backend so the ABAC resolver + caseload stub (registered once, single-owner) stay stable.
const sharedBackend = createInMemoryDocumentBackend({
  documents: [
    { id: DOC, organizationId: ORG, patientId: PATIENT },
    { id: DOC_B, organizationId: ORG_B, patientId: PATIENT },
    { id: DOC_HOLD, organizationId: ORG, patientId: PATIENT, legalHoldActive: true },
  ],
  batches: [{ id: BATCH, organizationId: ORG, patientId: PATIENT }],
});
// Pin DOC's first version to the well-known VERSION id used by the signed-URL test.
const sharedObjectResolver: SignedUrlObjectResolver = {
  async loadObject(args) {
    if (args.versionId === VERSION && args.documentId === DOC && args.organizationId === ORG) {
      return { objectKey: `documents/${PATIENT}/other/${DOC}/v1.pdf`, externalRecipient: null };
    }
    return sharedBackend.objectResolver.loadObject(args);
  },
};

// In-memory caseload: the three reviewer personas cover PATIENT but NOT PATIENT_OFF (no real M5 seam).
const REVIEWERS = ["rn_1", "pa_1", "aide_1"];
const isInCaseload = async (q: { userId: string; patientId: string }): Promise<boolean> =>
  REVIEWERS.includes(q.userId) && q.patientId === PATIENT;

function makeServer(service: DocumentRouteService = sharedBackend.service) {
  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.flatMap((s) =>
      [ORG, ORG_B].map((org) => ({
        orgId: org,
        userId: s.userId,
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions },
        ],
      })),
    ),
  );
  registerEffectivePermissionResolver(grantStore.store);
  registerAbacRegistry();
  // Idempotent (single-owner): registered against the shared backend's resolver + caseload stub.
  registerDocumentAbacPredicates({
    resolver: sharedBackend.abacResolver,
    isInCaseload,
    activeCredentials: async ({ membershipId }) => CREDENTIALS[membershipId] ?? [],
  });

  const signedUrl = createSignedUrlService({
    storage: {
      async presignDownload({ descriptor }) {
        return {
          url: `https://minio.example/${descriptor.bucket}/${descriptor.objectKey}?X-Amz-Expires=${descriptor.ttlSeconds}`,
          expiresAt: "2026-06-21T12:05:00.000Z",
        };
      },
    },
    resolver: sharedObjectResolver,
  });

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerDocumentRoutes(app, { service, signedUrl });
  return { app };
}

const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn" };
/** A physician assistant — a licence the platform could not represent at all before 0221 (F-030). */
const PA = { "x-test-user": "pa_1", "x-test-org": ORG, "x-test-roles": "rn" };
/** Same grants, same caseload, NO credential row: the one thing that differs is the licence. */
const AIDE = { "x-test-user": "aide_1", "x-test-org": ORG, "x-test-roles": "aide" };
const VIEWER = { "x-test-user": "viewer_1", "x-test-org": ORG, "x-test-roles": "auditor" };
const PLATFORM = {
  "x-test-user": "platform_1",
  "x-test-org": ORG,
  "x-test-roles": "platform_admin",
};
const ORG_ADMIN = { "x-test-user": "orgadmin_1", "x-test-org": ORG, "x-test-roles": "org_admin" };

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("M22-T07 — document routes (§4.1, §4.6 RBAC gating)", () => {
  it("POST /documents uploads a document for an authorized caller (201)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/documents",
      headers: RN,
      payload: {
        retentionClass: "clinical_record",
        aggregateType: "encounter",
        title: "Visit note",
        patientId: PATIENT,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("active");
    expect(res.json().id).toMatch(/^c0000000-/);
  });

  it("403 when the caller lacks documents.upload", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/documents",
      headers: VIEWER,
      payload: { retentionClass: "clinical_record", aggregateType: "encounter", title: "x" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 503 and does not touch the DB when production object storage is unavailable", async () => {
    const untouchedDb = new Proxy(
      {},
      {
        get() {
          throw new Error("unavailable upload must not touch the database");
        },
      },
    ) as DbClient;
    const { app } = makeServer(createDbDocumentRouteService(untouchedDb));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/documents",
      headers: RN,
      payload: {
        retentionClass: "clinical_record",
        aggregateType: "encounter",
        title: "Visit note",
        patientId: PATIENT,
      },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: "DEGRADED" } });
  });

  it("a cross-tenant document is a non-leaking 404", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: `/api/v1/documents/${DOC_B}`, headers: RN });
    expect(res.statusCode).toBe(404);
  });
});

describe("M22-T07 — §4.7 document_owner_or_caseload (signed-URL content route)", () => {
  it("mints a short-TTL signed URL for a caseload caller (200, ttl clamped ≤300s)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${DOC}/versions/${VERSION}/content?purpose=treatment&ttlSeconds=3600`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().documentVersionId).toBe(VERSION);
    expect(res.json().url).toContain("X-Amz-Expires=300"); // floor clamps the requested 3600 → 300
  });

  it("denies content for a caller off the patient's caseload (404 — existence non-leak)", async () => {
    const { app } = makeServer();
    // off_user holds the permission but is NOT on PATIENT's caseload.
    const grantStore = createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "off_user",
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["documents.read_phi_content"],
          },
        ],
      },
    ]);
    registerEffectivePermissionResolver(grantStore.store);
    registerAbacRegistry();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${DOC}/versions/${VERSION}/content?purpose=treatment`,
      headers: { "x-test-user": "off_user", "x-test-org": ORG, "x-test-roles": "clinical" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("M22-T07 — §4.7 legal_hold_aware (metadata edit blocked under hold)", () => {
  it("a metadata PATCH is refused while an active legal hold exists (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/documents/${DOC_HOLD}`,
      headers: { ...RN, "idempotency-key": "lh-1" },
      payload: { title: "renamed" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a metadata PATCH succeeds on a document with no hold (200)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/documents/${DOC}`,
      headers: { ...RN, "idempotency-key": "lh-2" },
      payload: { title: "renamed" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe("renamed");
  });
});

describe("M22-T07 — §4.7 extraction_reviewer_eligible (per-candidate decision)", () => {
  it("a non-licensed reviewer is refused on a high-risk candidate (403)", async () => {
    const { app } = makeServer();
    const review = await app.inject({
      method: "POST",
      url: `/api/v1/intake/uploads/${BATCH}/review`,
      headers: { ...AIDE, "idempotency-key": "rv-1" },
      payload: {},
    });
    const reviewId = review.json().id as string;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/intake/reviews/${reviewId}/decisions?riskLevel=high`,
      // A DIFFERENT PERSON holding no credential row — and holding the SAME `intake.review` grant as
      // the RN, so this 403 can only be the licensure predicate. It used to be `rn_1` sending a
      // different `x-test-roles` header with the licensure header omitted; a licence belongs to a
      // membership, not to a request header, so that is no longer a way to be unlicensed.
      headers: { ...AIDE, "idempotency-key": "dc-1" },
      payload: { candidateId: PATIENT, decision: "approve", sourceViewConfirmed: true },
    });
    expect(res.statusCode).toBe(403);
  });

  it("an RN-licensed reviewer may decide a high-risk candidate (201)", async () => {
    const { app } = makeServer();
    const review = await app.inject({
      method: "POST",
      url: `/api/v1/intake/uploads/${BATCH}/review`,
      headers: { ...RN, "idempotency-key": "rv-2" },
      payload: {},
    });
    const reviewId = review.json().id as string;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/intake/reviews/${reviewId}/decisions?riskLevel=high`,
      headers: { ...RN, "idempotency-key": "dc-2" },
      payload: { candidateId: PATIENT, decision: "approve", sourceViewConfirmed: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().decisionId).toMatch(/^a0000000-/);
  });

  it("a PA-licensed reviewer may decide a high-risk candidate (201) — 0221's new credential value", async () => {
    // §4.7 names {RN, NP, PA, MD, DO}. `pa` was not in `credential_discipline` at all until migration
    // 0221, so a physician assistant could not be recorded as licensed — this arm could never have
    // opened for one even after the read was fixed. (`md` covers MD *and* DO: same level, one value,
    // which is what `VISIT_PURPOSE_DISCIPLINES` has always meant by "MD/DO or NP".)
    const { app } = makeServer();
    const review = await app.inject({
      method: "POST",
      url: `/api/v1/intake/uploads/${BATCH}/review`,
      headers: { ...PA, "idempotency-key": "rv-3" },
      payload: {},
    });
    const reviewId = review.json().id as string;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/intake/reviews/${reviewId}/decisions?riskLevel=high`,
      headers: { ...PA, "idempotency-key": "dc-3" },
      payload: { candidateId: PATIENT, decision: "approve", sourceViewConfirmed: true },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("M22-T07 — §4.7 publish authority predicates", () => {
  it("a tenant org_admin cannot publish a platform template version (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/form-templates/election_statement/versions",
      headers: { ...ORG_ADMIN, "x-test-roles": "org_admin", "idempotency-key": "pt-1" },
      payload: { versionLabel: "v2" },
    });
    // org_admin lacks documents.publish_template → 403 at the RBAC layer (form_template_publish_authority also denies).
    expect(res.statusCode).toBe(403);
  });

  it("a platform_admin publishes a platform template version (201)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/form-templates/election_statement/versions",
      headers: { ...PLATFORM, "idempotency-key": "pt-2" },
      payload: { versionLabel: "v2" },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("M22-T07 — cursor pagination (§4.1 / SD-052)", () => {
  it("a paginated list returns next_cursor + has_more and the cursor pages forward", async () => {
    const backend = createInMemoryDocumentBackend({});
    // seed 3 documents via the upload route so the in-memory list has > one page.
    const { app } = makeServer(backend.service);
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "POST",
        url: "/api/v1/documents",
        headers: { ...RN, "idempotency-key": `pg-${i}` },
        payload: {
          retentionClass: "clinical_record",
          aggregateType: "encounter",
          title: `doc ${i}`,
          patientId: PATIENT,
        },
      });
    }
    const page1 = await app.inject({
      method: "GET",
      url: "/api/v1/documents?limit=2",
      headers: RN,
    });
    expect(page1.statusCode).toBe(200);
    expect(page1.json().items.length).toBe(2);
    expect(page1.json().hasMore).toBe(true);
    expect(page1.json().nextCursor).toBeTruthy();

    const page2 = await app.inject({
      method: "GET",
      url: `/api/v1/documents?limit=2&cursor=${encodeURIComponent(page1.json().nextCursor)}`,
      headers: RN,
    });
    expect(page2.statusCode).toBe(200);
    expect(page2.json().items.length).toBe(1);
    expect(page2.json().hasMore).toBe(false);
    expect(page2.json().nextCursor).toBeNull();
  });

  it("a malformed cursor is rejected with 400 (never silently pages from start)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/documents?cursor=not-a-cursor!!!",
      headers: RN,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("M22-T07 — §2.5 overlay If-Match optimistic concurrency", () => {
  it("a stale If-Match on the overlay PUT is refused with 412", async () => {
    const { app } = makeServer();
    // first publish at version 0 succeeds → bumps to 1.
    const first = await app.inject({
      method: "PUT",
      url: "/api/v1/tenant-overlays/election_statement",
      headers: { ...ORG_ADMIN, "if-match": "0", "idempotency-key": "ov-1" },
      payload: {
        branding: { letterhead: { orgName: "Acme Hospice", addressLines: ["1 Main St"] } },
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().version).toBe(1);

    // a stale If-Match (still 0) is refused.
    const stale = await app.inject({
      method: "PUT",
      url: "/api/v1/tenant-overlays/election_statement",
      headers: { ...ORG_ADMIN, "if-match": "0", "idempotency-key": "ov-2" },
      payload: {
        branding: { letterhead: { orgName: "Acme Hospice", addressLines: ["1 Main St"] } },
      },
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.json().error.code).toBe("VERSION_MISMATCH");
  });

  it("428 when the overlay PUT omits the If-Match header", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/tenant-overlays/election_statement",
      headers: { ...ORG_ADMIN, "idempotency-key": "ov-3" },
      payload: {
        branding: { letterhead: { orgName: "Acme Hospice", addressLines: ["1 Main St"] } },
      },
    });
    expect(res.statusCode).toBe(428);
  });
});
