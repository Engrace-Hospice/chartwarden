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
  registerPredicateIdempotent,
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
  type VerifiedUploadService,
  createDbDocumentRouteService,
  createInMemoryDocumentBackend,
  createSignedUrlService,
  registerDocumentAbacPredicates,
  registerDocumentRoutes,
  registerVerifiedUploadRoutes,
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
  const actorKind = request.headers["x-test-actor-kind"];
  if (typeof actorKind === "string") request.context.attributes.actorKind = actorKind;
  // GAP-066 — the test-local stand-in for the M3 `step_up_recent` predicate reads this flag; production
  // resolves it server-side from the session through M2's seam, never from a header.
  if (request.headers["x-test-step-up"] === "1") request.context.attributes.stepUpRecent = true;
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
const REFERRAL = "66666666-6666-4666-8666-666666666666";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const CAND_HIGH = "e0000000-0000-4000-8000-0000000000e1";
const CAND_LOW = "e0000000-0000-4000-8000-0000000000e2";
const CAND_OTHER_BATCH = "e0000000-0000-4000-8000-0000000000e3";
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
  { userId: "exporter_1", permissions: ["documents.export_phi_bundle"] },
  { userId: "platform_ops_1", permissions: ["documents.admin_retry_render"] },
];

// A single shared backend so the ABAC resolver + caseload stub (registered once, single-owner) stay stable.
const sharedBackend = createInMemoryDocumentBackend({
  documents: [
    { id: DOC, organizationId: ORG, patientId: PATIENT },
    {
      id: "c0000000-0000-4000-8000-0000000000dd",
      organizationId: ORG,
      aggregateType: "referral",
      aggregateId: REFERRAL,
    },
    { id: DOC_B, organizationId: ORG_B, patientId: PATIENT },
    { id: DOC_HOLD, organizationId: ORG, patientId: PATIENT, legalHoldActive: true },
  ],
  batches: [{ id: BATCH, organizationId: ORG, patientId: PATIENT }],
  // F-237 — the stored risk tier the eligibility predicate loads (never the request's say-so).
  candidates: [
    { id: CAND_HIGH, batchId: BATCH, riskLevel: "high" },
    { id: CAND_LOW, batchId: BATCH, riskLevel: "low" },
  ],
});
// Pin DOC's first version to the well-known VERSION id used by the signed-URL test.
const sharedObjectResolver: SignedUrlObjectResolver = {
  async loadObject(args) {
    if (args.versionId === VERSION && args.documentId === DOC && args.organizationId === ORG) {
      return {
        objectKey: `documents/${PATIENT}/other/${DOC}/v1.pdf`,
        externalRecipient: null,
        // F-197 (#248) — not SUD-class; this fixture never exercised the §7.16 mint-time gate.
        patientId: PATIENT,
        isSudClass: false,
      };
    }
    return sharedBackend.objectResolver.loadObject(args);
  },
};

// In-memory caseload: the three reviewer personas cover PATIENT but NOT PATIENT_OFF (no real M5 seam).
const REVIEWERS = ["rn_1", "pa_1", "aide_1", "exporter_1"];
const isInCaseload = async (q: { userId: string; patientId: string }): Promise<boolean> =>
  REVIEWERS.includes(q.userId) && q.patientId === PATIENT;

function makeServer(
  service: DocumentRouteService = sharedBackend.service,
  referralReader: {
    canAccessReferral(input: {
      organizationId: string;
      userId: string;
      referralId: string;
    }): Promise<boolean>;
    getReferralSubject?(input: {
      organizationId: string;
      referralId: string;
    }): Promise<{ patientId: string | null } | null>;
  } = {
    async canAccessReferral(input) {
      return input.organizationId === ORG && input.referralId === REFERRAL;
    },
  },
) {
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

  registerPredicateIdempotent(
    "step_up_recent",
    async (context) => context.attributes.stepUpRecent === true,
  );

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
  registerDocumentRoutes(app, { service, signedUrl, referralReader });
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
const STEP_UP_FRESH = { "x-test-step-up": "1" };
/** Holds the RBAC key and the org_admin ABAC role, but NO fresh step-up (GAP-066). */
const ORG_ADMIN_STALE = {
  "x-test-user": "orgadmin_1",
  "x-test-org": ORG,
  "x-test-roles": "org_admin",
};
const ORG_ADMIN = { ...ORG_ADMIN_STALE, ...STEP_UP_FRESH };
const EXPORTER_STALE = { "x-test-user": "exporter_1", "x-test-org": ORG, "x-test-roles": "rn" };
const PLATFORM_OPS_STALE = {
  "x-test-user": "platform_ops_1",
  "x-test-org": ORG,
  "x-test-roles": "platform_admin",
};

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

/** GAP-068 — the bytes every upload now carries (a tiny PDF; the in-memory backend ignores them). */
const UPLOAD_CONTENT = {
  mimeType: "application/pdf",
  contentBase64: Buffer.from("%PDF-1.7 route test").toString("base64"),
} as const;

describe("M22-T07 — document routes (§4.1, §4.6 RBAC gating)", () => {
  it("DELETE /document-uploads/:id returns an idempotency-safe abort body", async () => {
    const uploadId = "b6032e5c-c3c6-4d6c-8ece-452b39b29733";
    const aborted: string[] = [];
    const verifiedUpload: VerifiedUploadService = {
      async initiate() {
        throw new Error("not used");
      },
      async complete() {
        throw new Error("not used");
      },
      async abort(args) {
        aborted.push(args.uploadId);
      },
    };
    const { app } = makeServer();
    registerVerifiedUploadRoutes(app, verifiedUpload);

    const first = await app.inject({
      method: "DELETE",
      url: `/api/v1/document-uploads/${uploadId}`,
      headers: { ...RN, "idempotency-key": "abort-upload-1" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ aborted: true });

    const replay = await app.inject({
      method: "DELETE",
      url: `/api/v1/document-uploads/${uploadId}`,
      headers: { ...RN, "idempotency-key": "abort-upload-1" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ aborted: true });
    expect(aborted).toEqual([uploadId]);
  });

  it("POST /documents uploads a document for an authorized caller (201)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/documents",
      headers: { ...RN, "idempotency-key": "gap068-up-1" },
      payload: {
        ...UPLOAD_CONTENT,
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

  it("POST /documents and /documents/:id/versions require an Idempotency-Key (GAP-068 follow-up)", async () => {
    const { app } = makeServer();
    const body = {
      ...UPLOAD_CONTENT,
      retentionClass: "clinical_record",
      aggregateType: "encounter",
      title: "x",
    };
    const noKey = await app.inject({
      method: "POST",
      url: "/api/v1/documents",
      headers: RN,
      payload: body,
    });
    expect(noKey.statusCode).toBe(400);
    const versionNoKey = await app.inject({
      method: "POST",
      url: "/api/v1/documents/c0000000-0000-4000-8000-000000000001/versions",
      headers: RN,
      payload: { ...UPLOAD_CONTENT },
    });
    expect(versionNoKey.statusCode).toBe(400);
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
      headers: { ...RN, "idempotency-key": "gap068-up-3" },
      payload: {
        ...UPLOAD_CONTENT,
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
      url: `/api/v1/intake/reviews/${reviewId}/decisions`,
      // A DIFFERENT PERSON holding no credential row — and holding the SAME `intake.review` grant as
      // the RN, so this 403 can only be the licensure predicate. It used to be `rn_1` sending a
      // different `x-test-roles` header with the licensure header omitted; a licence belongs to a
      // membership, not to a request header, so that is no longer a way to be unlicensed.
      headers: { ...AIDE, "idempotency-key": "dc-1" },
      payload: { candidateId: CAND_HIGH, decision: "approve", sourceViewConfirmed: true },
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
      url: `/api/v1/intake/reviews/${reviewId}/decisions`,
      headers: { ...RN, "idempotency-key": "dc-2" },
      payload: { candidateId: CAND_HIGH, decision: "approve", sourceViewConfirmed: true },
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
      url: `/api/v1/intake/reviews/${reviewId}/decisions`,
      headers: { ...PA, "idempotency-key": "dc-3" },
      payload: { candidateId: CAND_HIGH, decision: "approve", sourceViewConfirmed: true },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("F-237 — the candidate's risk tier is the server's, not the request's", () => {
  async function openReviewAs(headers: Record<string, string>, key: string) {
    const { app } = makeServer();
    const review = await app.inject({
      method: "POST",
      url: `/api/v1/intake/uploads/${BATCH}/review`,
      headers: { ...headers, "idempotency-key": key },
      payload: {},
    });
    return { app, reviewId: review.json().id as string };
  }

  it("a client-sent ?riskLevel=low does not lift the licence check on a high-risk candidate (403)", async () => {
    const { app, reviewId } = await openReviewAs(AIDE, "f237-rv-1");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/intake/reviews/${reviewId}/decisions?riskLevel=low`,
      headers: { ...AIDE, "idempotency-key": "f237-dc-1" },
      payload: { candidateId: CAND_HIGH, decision: "approve", sourceViewConfirmed: true },
    });
    expect(res.statusCode).toBe(403);
  });

  it("an unlicensed reviewer may decide a LOW-risk candidate (201)", async () => {
    const { app, reviewId } = await openReviewAs(AIDE, "f237-rv-2");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/intake/reviews/${reviewId}/decisions`,
      headers: { ...AIDE, "idempotency-key": "f237-dc-2" },
      payload: { candidateId: CAND_LOW, decision: "approve", sourceViewConfirmed: true },
    });
    expect(res.statusCode).toBe(201);
  });

  it("a candidate that is not this review's batch's is refused even for a licensed reviewer (403)", async () => {
    const { app, reviewId } = await openReviewAs(RN, "f237-rv-3");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/intake/reviews/${reviewId}/decisions`,
      headers: { ...RN, "idempotency-key": "f237-dc-3" },
      payload: { candidateId: CAND_OTHER_BATCH, decision: "approve", sourceViewConfirmed: true },
    });
    expect(res.statusCode).toBe(403);
  });

  it("bulk-approve is refused when the scope holds a high-risk candidate, whatever ?anyHighRisk says", async () => {
    const { app, reviewId } = await openReviewAs(RN, "f237-rv-4");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/intake/reviews/${reviewId}/decisions:bulk-approve?anyHighRisk=false`,
      headers: { ...RN, "idempotency-key": "f237-bk-1" },
      payload: { candidateIds: [CAND_LOW, CAND_HIGH] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("bulk-approve of low-risk candidates only is allowed (201)", async () => {
    const { app, reviewId } = await openReviewAs(RN, "f237-rv-5");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/intake/reviews/${reviewId}/decisions:bulk-approve`,
      headers: { ...RN, "idempotency-key": "f237-bk-2" },
      payload: { candidateIds: [CAND_LOW] },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("F-238 — intake records filed against a referral (a prospect's older records)", () => {
  const referralReader = {
    async canAccessReferral(input: { organizationId: string; referralId: string }) {
      return input.organizationId === ORG && input.referralId === REFERRAL;
    },
    async getReferralSubject(input: { organizationId: string; referralId: string }) {
      return input.organizationId === ORG && input.referralId === REFERRAL
        ? { patientId: PATIENT }
        : null;
    },
  };
  const post = (app: ReturnType<typeof makeServer>["app"], body: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/v1/intake/uploads",
      headers: RN,
      payload: { sourceChannel: "fax", ...body },
    });

  it("the batch takes the patient the referral resolved to", async () => {
    const { app } = makeServer(sharedBackend.service, referralReader);
    const res = await post(app, { referralId: REFERRAL });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ patientId: PATIENT, referralId: REFERRAL });
  });

  it("naming a different patient than the referral's is a 409, never a silent override", async () => {
    const { app } = makeServer(sharedBackend.service, referralReader);
    const res = await post(app, { referralId: REFERRAL, patientId: PATIENT_OFF });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("REFERRAL_PATIENT_CONFLICT");
  });

  it("a referral the caller cannot see is not found", async () => {
    const { app } = makeServer(sharedBackend.service, referralReader);
    const res = await post(app, { referralId: "77777777-7777-4777-8777-777777777777" });
    expect(res.statusCode).toBe(404);
  });

  describe("GET /intake/referral-batches — the referral's Records tab", () => {
    const OTHER_REFERRAL = "77777777-7777-4777-8777-777777777777";
    const seeded = () =>
      createInMemoryDocumentBackend({
        batches: [
          {
            id: "b1000000-0000-4000-8000-000000000001",
            organizationId: ORG,
            patientId: PATIENT,
            referralId: REFERRAL,
            sourceChannel: "fax",
            sudStatus: "detected",
            identityStatus: "possible",
            status: "extraction_complete",
            pages: 12,
            createdAt: "2026-10-01T10:00:00.000Z",
          },
          // Same patient as the referral resolved to, but never filed against it: NOT included.
          {
            id: "b1000000-0000-4000-8000-000000000002",
            organizationId: ORG,
            patientId: PATIENT,
            referralId: null,
          },
          // Another referral's records.
          {
            id: "b1000000-0000-4000-8000-000000000003",
            organizationId: ORG,
            patientId: null,
            referralId: OTHER_REFERRAL,
          },
          // Another tenant's batch that happens to name the same referral id.
          {
            id: "b1000000-0000-4000-8000-000000000004",
            organizationId: ORG_B,
            patientId: null,
            referralId: REFERRAL,
          },
        ],
      });
    const list = (app: ReturnType<typeof makeServer>["app"], qs: string, headers = RN) =>
      app.inject({ method: "GET", url: `/api/v1/intake/referral-batches${qs}`, headers });

    it("returns only the batches filed against this referral, in this tenant", async () => {
      const { app } = makeServer(seeded().service, referralReader);
      const res = await list(app, `?referralId=${REFERRAL}`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items.map((i: { id: string }) => i.id)).toEqual([
        "b1000000-0000-4000-8000-000000000001",
      ]);
      expect(body.items[0]).toMatchObject({
        referralId: REFERRAL,
        patientId: PATIENT,
        sourceChannel: "fax",
        sudStatus: "detected",
        identityStatus: "possible",
        status: "extraction_complete",
        pages: 12,
        review: null,
      });
      expect(body.hasMore).toBe(false);
    });

    it("a batch uploaded with referralId shows up on that referral's list", async () => {
      const backend = createInMemoryDocumentBackend({});
      const { app } = makeServer(backend.service, referralReader);
      const created = await post(app, { referralId: REFERRAL, sourceChannel: "email_ingest" });
      expect(created.statusCode).toBe(201);
      const res = await list(app, `?referralId=${REFERRAL}`);
      expect(res.json().items).toEqual([
        expect.objectContaining({
          id: created.json().id,
          referralId: REFERRAL,
          sourceChannel: "email_ingest",
        }),
      ]);
    });

    it("a referral the caller cannot see is not found (nothing listed)", async () => {
      const { app } = makeServer(seeded().service, referralReader);
      const res = await list(app, `?referralId=${OTHER_REFERRAL}`);
      expect(res.statusCode).toBe(404);
    });

    it("referralId is required and must be a uuid", async () => {
      const { app } = makeServer(seeded().service, referralReader);
      expect((await list(app, "")).statusCode).toBe(422);
      expect((await list(app, "?referralId=nope")).statusCode).toBe(422);
    });

    it("requires intake.read", async () => {
      const { app } = makeServer(seeded().service, referralReader);
      const res = await list(app, `?referralId=${REFERRAL}`, VIEWER);
      expect(res.statusCode).toBe(403);
    });
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
  it("filters documents by referral aggregate id after validating referral access", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/documents?aggregateType=referral&aggregateId=${REFERRAL}`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0]).toMatchObject({
      aggregateType: "referral",
      aggregateId: REFERRAL,
      patientId: null,
    });
  });

  it("does not leak referral documents when referral access validation fails", async () => {
    const { app } = makeServer(sharedBackend.service, {
      async canAccessReferral() {
        return false;
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/documents?aggregateType=referral&aggregateId=${REFERRAL}`,
      headers: RN,
    });
    expect(res.statusCode).toBe(404);
  });

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
          ...UPLOAD_CONTENT,
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

describe("M22 Phase 1 — document link metadata action", () => {
  it("attaches a referral document to a patient/admission without creating a new version", async () => {
    const backend = createInMemoryDocumentBackend({
      documents: [
        {
          id: DOC,
          organizationId: ORG,
          patientId: null,
          admissionId: null,
          aggregateType: "referral",
          aggregateId: REFERRAL,
        },
      ],
    });
    const { app } = makeServer(backend.service);
    const before = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${DOC}`,
      headers: RN,
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().versionsCount).toBe(1);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${DOC}/links`,
      headers: { ...RN, "idempotency-key": "doc-link-1" },
      payload: {
        patientId: PATIENT,
        admissionId: "55555555-5555-4555-8555-555555555555",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: DOC,
      patientId: PATIENT,
      admissionId: "55555555-5555-4555-8555-555555555555",
      aggregateType: "referral",
      aggregateId: REFERRAL,
      versionsCount: 1,
    });
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

// F-060 (#153) — `document_tag` had two writers and no reader. These prove the loop CLOSES: a tag
// survives a reload, and the id the DELETE needs is obtainable from a fresh read rather than only
// from the POST response a caller held until it navigated away.
describe("M22-T07 — F-060 document tags are readable, and therefore removable", () => {
  it("POST /documents/:id/tags answers 201 with the created tag — id included", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${DOC}/tags`,
      headers: RN,
      payload: { tagKind: "structured", tagKey: "f060-created", tagValue: "IIA" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      tagKind: "structured",
      tagKey: "f060-created",
      tagValue: "IIA",
    });
    expect(typeof res.json().id).toBe("string");
    expect(res.json().addedAt).toEqual(expect.any(String));
  });

  it("GET /documents/:id/tags lists a tag written by an earlier request (the read that did not exist)", async () => {
    const { app } = makeServer();
    await app.inject({
      method: "POST",
      url: `/api/v1/documents/${DOC}/tags`,
      headers: RN,
      payload: { tagKind: "free", tagKey: "f060-listed", tagValue: "note" },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${DOC}/tags`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
    const found = res.json().items.find((t: { tagKey: string }) => t.tagKey === "f060-listed") as
      | { tagValue: string }
      | undefined;
    expect(found).toBeDefined();
    expect(found?.tagValue).toBe("note");
  });

  it("a tag added, then re-read, can be DELETEd by the id that read returned", async () => {
    const { app } = makeServer();
    await app.inject({
      method: "POST",
      url: `/api/v1/documents/${DOC}/tags`,
      headers: RN,
      payload: { tagKind: "structured", tagKey: "f060-roundtrip", tagValue: "x" },
    });
    // The reload a caller does: the POST response is gone, the id comes from the LIST.
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${DOC}/tags`,
      headers: RN,
    });
    const tag = listed
      .json()
      .items.find((t: { tagKey: string }) => t.tagKey === "f060-roundtrip") as { id: string };
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/documents/${DOC}/tags/${tag.id}`,
      headers: RN,
    });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${DOC}/tags`,
      headers: RN,
    });
    expect(after.json().items.some((t: { tagKey: string }) => t.tagKey === "f060-roundtrip")).toBe(
      false,
    );
  });

  it("tags supplied at creation are persisted, not validated and discarded", async () => {
    const { app } = makeServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/documents",
      headers: { ...RN, "idempotency-key": "gap068-up-4" },
      payload: {
        ...UPLOAD_CONTENT,
        retentionClass: "clinical_record",
        aggregateType: "encounter",
        title: "Born with tags",
        patientId: PATIENT,
        tags: [
          { tagKind: "structured", tagKey: "f060-at-birth", tagValue: "yes" },
          { tagKind: "free", tagKey: "f060-at-birth-2" },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${created.json().id}/tags`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(2);
    expect(
      res
        .json()
        .items.map((t: { tagKey: string }) => t.tagKey)
        .sort(),
    ).toEqual(["f060-at-birth", "f060-at-birth-2"]);
    // A bare key carries a null value on the wire — not the absent field the DTO would not type.
    const bare = res
      .json()
      .items.find((t: { tagKey: string }) => t.tagKey === "f060-at-birth-2") as {
      tagValue: string | null;
    };
    expect(bare.tagValue).toBeNull();
  });

  it("GET /documents?tagKey= runs the cross-document query the org_key index was built for", async () => {
    const { app } = makeServer();
    const tagged = await app.inject({
      method: "POST",
      url: "/api/v1/documents",
      headers: { ...RN, "idempotency-key": "gap068-up-5" },
      payload: {
        ...UPLOAD_CONTENT,
        retentionClass: "clinical_record",
        aggregateType: "encounter",
        title: "Findable by tag",
        patientId: PATIENT,
        tags: [{ tagKind: "structured", tagKey: "f060-filter", tagValue: "match" }],
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/documents",
      headers: { ...RN, "idempotency-key": "gap068-up-6" },
      payload: {
        ...UPLOAD_CONTENT,
        retentionClass: "clinical_record",
        aggregateType: "encounter",
        title: "Same key, other value",
        patientId: PATIENT,
        tags: [{ tagKind: "structured", tagKey: "f060-filter", tagValue: "other" }],
      },
    });
    const byKey = await app.inject({
      method: "GET",
      url: "/api/v1/documents?tagKey=f060-filter",
      headers: RN,
    });
    expect(byKey.statusCode).toBe(200);
    expect(byKey.json().items).toHaveLength(2);
    // `tagValue` narrows WITHIN the key rather than spanning unrelated ones.
    const byValue = await app.inject({
      method: "GET",
      url: "/api/v1/documents?tagKey=f060-filter&tagValue=match",
      headers: RN,
    });
    expect(byValue.json().items).toHaveLength(1);
    expect(byValue.json().items[0].id).toBe(tagged.json().id);
  });

  it("403 when the caller lacks documents.read, and a cross-tenant document's tags are a 404", async () => {
    const { app } = makeServer();
    const denied = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${DOC}/tags`,
      headers: VIEWER,
    });
    expect(denied.statusCode).toBe(403);
    const crossTenant = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${DOC_B}/tags`,
      headers: RN,
    });
    expect(crossTenant.statusCode).toBe(404);
  });
});

describe("F-235 — POST /intake/reviews/:id/complete guards (the chart-writeback commit route)", () => {
  async function openReview(app: ReturnType<typeof makeServer>["app"], key: string) {
    const review = await app.inject({
      method: "POST",
      url: `/api/v1/intake/uploads/${BATCH}/review`,
      headers: { ...RN, "idempotency-key": key },
      payload: {},
    });
    return review.json().id as string;
  }

  it("refuses a completion without an Idempotency-Key (400)", async () => {
    const { app } = makeServer();
    const reviewId = await openReview(app, "f235-rv-1");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/intake/reviews/${reviewId}/complete`,
      headers: RN,
      payload: { attestationConfirmed: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code ?? res.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("refuses an AI principal even with every grant (403) — §7.3.2 never auto-commits", async () => {
    const { app } = makeServer();
    const reviewId = await openReview(app, "f235-rv-2");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/intake/reviews/${reviewId}/complete`,
      headers: { ...RN, "x-test-actor-kind": "ai_agent", "idempotency-key": "f235-cp-2" },
      payload: { attestationConfirmed: true },
    });
    expect(res.statusCode).toBe(403);
  });

  it("completes for a human reviewer with the key (200)", async () => {
    const { app } = makeServer();
    const reviewId = await openReview(app, "f235-rv-3");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/intake/reviews/${reviewId}/complete`,
      headers: { ...RN, "x-test-actor-kind": "user", "idempotency-key": "f235-cp-3" },
      payload: { attestationConfirmed: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("complete");
  });
});

// GAP-066 — the route comments claimed step-up on the §164.524 export, the overlay publish and the admin
// render retry, but none of the three composed `requireStepUp`. A holder of the RBAC key (and, for the
// overlay, the org_admin role) with no fresh step-up must be refused with STEP_UP_REQUIRED; a fresh one passes.
describe("M22 GAP-066 — step-up on PHI export, overlay publish and render retry", () => {
  const exportRequest = (headers: Record<string, string>) => ({
    method: "POST" as const,
    url: `/api/v1/documents/${DOC}/export-phi-bundle`,
    headers: { ...headers, "idempotency-key": "gap066-export" },
    payload: { patientId: PATIENT, purpose: "patient_access" },
  });
  const overlayRequest = (headers: Record<string, string>) => ({
    method: "PUT" as const,
    url: "/api/v1/tenant-overlays/election_statement",
    headers: { ...headers, "if-match": "0", "idempotency-key": "gap066-overlay" },
    payload: { branding: { letterhead: { orgName: "Acme Hospice", addressLines: ["1 Main St"] } } },
  });
  const retryRequest = (headers: Record<string, string>) => ({
    method: "POST" as const,
    url: "/api/v1/admin/form-fills/c0000000-0000-4000-8000-0000000000f1/retry",
    headers: { ...headers, "idempotency-key": "gap066-retry" },
    payload: {},
  });

  it("export-phi-bundle without a fresh step-up is refused with STEP_UP_REQUIRED", async () => {
    const { app } = makeServer();
    const res = await app.inject(exportRequest(EXPORTER_STALE));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("STEP_UP_REQUIRED");
  });

  it("export-phi-bundle with a fresh step-up passes", async () => {
    const { app } = makeServer();
    const res = await app.inject(exportRequest({ ...EXPORTER_STALE, ...STEP_UP_FRESH }));
    expect(res.statusCode).toBeLessThan(300);
  });

  it("the overlay PUT without a fresh step-up is refused with STEP_UP_REQUIRED", async () => {
    const { app } = makeServer();
    const res = await app.inject(overlayRequest(ORG_ADMIN_STALE));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("STEP_UP_REQUIRED");
  });

  it("the overlay PUT with a fresh step-up passes", async () => {
    // A private backend: the shared one keeps its overlay version across tests, so If-Match "0" would 412.
    const { app } = makeServer(createInMemoryDocumentBackend().service);
    const res = await app.inject(overlayRequest(ORG_ADMIN));
    expect(res.statusCode).toBe(200);
  });

  it("the admin render retry without a fresh step-up is refused with STEP_UP_REQUIRED", async () => {
    const { app } = makeServer();
    const res = await app.inject(retryRequest(PLATFORM_OPS_STALE));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("STEP_UP_REQUIRED");
  });

  it("the admin render retry with a fresh step-up passes", async () => {
    const { app } = makeServer();
    const res = await app.inject(retryRequest({ ...PLATFORM_OPS_STALE, ...STEP_UP_FRESH }));
    expect(res.statusCode).toBe(200);
  });
});
