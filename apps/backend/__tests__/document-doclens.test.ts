import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
// apps/backend/__tests__/document-doclens.test.ts — M22-T08 the §7.1 W1 DocLens extraction pipeline:
// (1) the PURE pipeline runs end-to-end when the `documents.doclens` flag is injected ON over a FAKE M32
// capability (classify → extract → verify → discrepancy → review → decide → provenance);
// (2) the routes return 503 EXTRACTION_DISABLED with `Retry-After: 0` when the flag is OFF (Phase-1 default);
// (3) the M32 deny-stub (capability_unavailable) lands the job `stalled` (W1 AC, no auto-retry);
// (4) D4 — HIGH-risk candidates disable bulk-approve; rejected candidates emit no commit intent but persist;
// (5) provenance links each committed chart row back to (jobId, fieldPath, sourceDocumentId, sourcePage).
//
// The pure pipeline is exercised directly from @wardenx/intake-extraction (no infra). The route 503 gate is
// exercised through the FULL M1 middleware chain via Fastify `inject` + the REAL Authorization Contract.
import {
  type DocLensCapabilityPort,
  buildProvenance,
  classifyPages,
  denyStubDocLensCapability,
  detectDiscrepancies,
  groupContiguousRuns,
  planCommitIntents,
  runExtractionPipeline,
} from "@wardenx/intake-extraction";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type DocumentFeatureFlagReader,
  createDocLensPipelineService,
  registerDocLensExtractionRoutes,
} from "../src/modules/22-documents/index";

const ORG = "org_a";
const BATCH = "b0000000-0000-4000-8000-0000000000aa";
const JOB = "60000000-0000-4000-8000-000000000001";
const SRC_DOC = "70000000-0000-4000-8000-000000000001";

// ── A fake M32 DocLens capability: a discharge summary spanning pages 1–3, one HIGH-risk med + one LOW-risk
//    demographic + one SUD-flagged med, vision-verifies the high-risk fields. ─────────────────────────────
const fakeCapability: DocLensCapabilityPort = {
  async classifyPages() {
    return {
      status: "ok",
      value: [
        { pageNumber: 1, documentType: "discharge_summary", confidence: 0.96 },
        { pageNumber: 2, documentType: "discharge_summary", confidence: 0.93 },
        { pageNumber: 3, documentType: "lab", confidence: 0.4 }, // below floor → human classification
      ],
    };
  },
  async extract() {
    return {
      status: "ok",
      value: [
        {
          fieldPath: "patient.address",
          value: "12 Oak St",
          riskLevel: "low",
          confidence: 0.98,
          sudDetected: false,
          sourcePageNumber: 1,
        },
        {
          fieldPath: "medications[0].name",
          value: "methadone",
          riskLevel: "high",
          confidence: 0.88,
          sudDetected: true,
          sourcePageNumber: 2,
        },
        {
          fieldPath: "patient.allergy",
          value: "penicillin (anaphylaxis)",
          riskLevel: "high",
          confidence: 0.91,
          sudDetected: false,
          sourcePageNumber: 2,
        },
      ],
    };
  },
  async verify(args) {
    return {
      status: "ok",
      value: args.candidates.map((c) => ({
        fieldPath: c.fieldPath,
        verified: true,
        confidence: 0.95,
      })),
    };
  },
};

describe("M22-T08 DocLens pure pipeline (§7.1 W1) — flag ON over a fake M32", () => {
  it("classifies pages against the confidence floor (low-confidence → human classification)", () => {
    const classified = classifyPages([
      { pageNumber: 1, documentType: "discharge_summary", confidence: 0.96 },
      { pageNumber: 2, documentType: "lab", confidence: 0.4 },
      { pageNumber: 3, documentType: "unknown", confidence: 0.99 },
    ]);
    expect(classified[0]?.needsHumanClassification).toBe(false);
    expect(classified[1]?.needsHumanClassification).toBe(true); // below 0.75
    expect(classified[2]?.needsHumanClassification).toBe(true); // unknown
  });

  it("groups contiguous same-type pages into runs, skipping needs-human pages", () => {
    const runs = groupContiguousRuns(
      classifyPages([
        { pageNumber: 1, documentType: "discharge_summary", confidence: 0.96 },
        { pageNumber: 2, documentType: "discharge_summary", confidence: 0.95 },
        { pageNumber: 3, documentType: "lab", confidence: 0.4 },
      ]),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.documentType).toBe("discharge_summary");
    expect(runs[0]?.pageNumbers).toEqual([1, 2]);
  });

  it("runs the full pipeline to ready_for_review, disables bulk-approve on HIGH-risk, raises the SUD banner", async () => {
    const result = await runExtractionPipeline(fakeCapability, {
      organizationId: ORG,
      batchId: BATCH,
      jobId: JOB,
      pageCount: 3,
      chartValues: [
        { fieldPath: "patient.allergy", value: "penicillin (rash)", targetModule: "m5" },
      ],
    });
    expect(result.status).toBe("ready_for_review");
    if (result.status !== "ready_for_review") return;
    // D4: a HIGH-risk candidate is in scope → "Approve all" is NOT allowed.
    expect(result.review.bulkApproveAllowed).toBe(false);
    // W4: a SUD-flagged candidate → banner.
    expect(result.review.sudDetected).toBe(true);
    // W1 step 6: chart_existing discrepancy on the allergy (rash vs anaphylaxis).
    const disc = result.review.discrepancies.find((d) => d.fieldPath === "patient.allergy");
    expect(disc?.kind).toBe("chart_existing");
    expect(disc?.chartValue).toBe("penicillin (rash)");
    // HIGH-risk candidates carry a vision verdict; low-risk does not.
    const med = result.review.candidates.find((c) => c.fieldPath === "medications[0].name");
    expect(med?.visionVerified).toBe(true);
    const addr = result.review.candidates.find((c) => c.fieldPath === "patient.address");
    expect(addr?.visionVerified).toBeNull();
  });

  it("commits only approved candidates and records provenance (W1 steps 11–12)", async () => {
    const run = await runExtractionPipeline(fakeCapability, {
      organizationId: ORG,
      batchId: BATCH,
      jobId: JOB,
      pageCount: 3,
      chartValues: [],
    });
    if (run.status !== "ready_for_review") throw new Error("expected ready_for_review");
    const chartTargets = [
      { fieldPath: "patient.address", value: null, targetModule: "m5" as const },
      { fieldPath: "medications[0].name", value: null, targetModule: "m12" as const },
      { fieldPath: "patient.allergy", value: null, targetModule: "m5" as const },
    ];
    const decisions = [
      { fieldPath: "patient.address", decision: "approve" as const },
      { fieldPath: "medications[0].name", decision: "reject" as const }, // rejected → no intent
      {
        fieldPath: "patient.allergy",
        decision: "approve_with_edit" as const,
        editedValue: "penicillin (anaphylaxis, confirmed)",
      },
    ];
    const intents = planCommitIntents(run.review.candidates, chartTargets, decisions);
    // The rejected medication emits no intent; the 2 approved ones do.
    expect(intents.map((i) => i.fieldPath).sort()).toEqual(["patient.address", "patient.allergy"]);
    const edited = intents.find((i) => i.fieldPath === "patient.allergy");
    expect(edited?.value).toBe("penicillin (anaphylaxis, confirmed)");
    expect(edited?.targetModule).toBe("m5");

    const provenance = buildProvenance(JOB, SRC_DOC, run.review.candidates, decisions, intents);
    expect(provenance).toHaveLength(2);
    const addrProv = provenance.find((p) => p.fieldPath === "patient.address");
    expect(addrProv).toMatchObject({
      jobId: JOB,
      sourceDocumentId: SRC_DOC,
      sourcePageNumber: 1,
      decision: "approve",
    });
  });

  it("stalls the job when the M32 deny-stub reports the capability unavailable (W1 AC)", async () => {
    const result = await runExtractionPipeline(denyStubDocLensCapability, {
      organizationId: ORG,
      batchId: BATCH,
      jobId: JOB,
      pageCount: 3,
      chartValues: [],
    });
    expect(result.status).toBe("stalled");
    if (result.status === "stalled") expect(result.reason).toBe("capability_unavailable");
  });

  it("detectDiscrepancies ignores fields with no existing chart value", () => {
    const discs = detectDiscrepancies(
      [
        {
          fieldPath: "x",
          value: "a",
          riskLevel: "low",
          confidence: 1,
          sudDetected: false,
          sourcePageNumber: 1,
          visionVerified: null,
        },
      ],
      [{ fieldPath: "x", value: null, targetModule: "m5" }],
    );
    expect(discs).toHaveLength(0);
  });
});

describe("M22-T08 DocLens pipeline service — the flag gate (default OFF → EXTRACTION_DISABLED)", () => {
  it("throws EXTRACTION_DISABLED (503) when no flag reader is wired (Phase-1 default)", async () => {
    const svc = createDocLensPipelineService({ capability: fakeCapability });
    await expect(
      svc.runBatch({
        organizationId: ORG,
        batchId: BATCH,
        jobId: JOB,
        pageCount: 3,
        chartValues: [],
      }),
    ).rejects.toMatchObject({ code: "EXTRACTION_DISABLED", statusCode: 503 });
  });

  it("runs the pipeline when the flag reader reports documents.doclens=true", async () => {
    const flags: DocumentFeatureFlagReader = {
      async forOrg() {
        return { "documents.doclens": true };
      },
    };
    const svc = createDocLensPipelineService({ capability: fakeCapability, flags });
    const res = await svc.runBatch({
      organizationId: ORG,
      batchId: BATCH,
      jobId: JOB,
      pageCount: 3,
      chartValues: [],
    });
    expect(res.status).toBe("ready_for_review");
  });

  it("still throws EXTRACTION_DISABLED when the flag map omits documents.doclens", async () => {
    const flags: DocumentFeatureFlagReader = {
      async forOrg() {
        return { "ai.full": true };
      },
    };
    const svc = createDocLensPipelineService({ capability: fakeCapability, flags });
    await expect(
      svc.runBatch({
        organizationId: ORG,
        batchId: BATCH,
        jobId: JOB,
        pageCount: 3,
        chartValues: [],
      }),
    ).rejects.toMatchObject({ code: "EXTRACTION_DISABLED", statusCode: 503 });
  });
});

describe("M22-T08 DocLens extraction routes — 503 EXTRACTION_DISABLED when the flag is OFF", () => {
  const RUN = `/api/v1/intake/uploads/${BATCH}/extraction/run`;
  const COMMIT = `/api/v1/intake/jobs/${JOB}/extraction/commit`;

  function headerAuth(request: FastifyRequest): void {
    const user = request.headers["x-test-user"];
    if (typeof user !== "string" || user.length === 0) return;
    request.context.userId = user;
    // extraction-routes.ts's actorOf() reads the acting MEMBERSHIP id from here (not ctx.userId).
    request.context.attributes.membershipId = user;
    const org = request.headers["x-test-org"];
    request.context.organizationId = typeof org === "string" ? org : "";
    const roles = request.headers["x-test-roles"];
    request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  }

  beforeEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
  });
  afterEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
  });

  function server(flags?: DocumentFeatureFlagReader) {
    const grantStore = createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "rn_1",
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["intake.review"] },
        ],
      },
    ]);
    registerEffectivePermissionResolver(grantStore.store);
    registerAbacRegistry();
    const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    const pipeline = createDocLensPipelineService({ capability: fakeCapability, flags });
    registerDocLensExtractionRoutes(app, { pipeline, flags });
    return app;
  }

  const authed = (extra: Record<string, string> = {}) => ({
    "x-test-user": "rn_1",
    "x-test-org": ORG,
    "x-test-roles": "rn",
    ...extra,
  });

  it("returns 503 EXTRACTION_DISABLED with Retry-After: 0 on run when no flag reader (Phase-1 default)", async () => {
    const app = server();
    const res = await app.inject({
      method: "POST",
      url: RUN,
      headers: authed(),
      payload: { jobId: JOB, pageCount: 3 },
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("0");
    expect(res.json().error.code).toBe("EXTRACTION_DISABLED");
    await app.close();
  });

  it("returns 503 EXTRACTION_DISABLED on commit when the flag is OFF", async () => {
    const app = server({
      async forOrg() {
        return { "documents.doclens": false };
      },
    });
    const res = await app.inject({
      method: "POST",
      url: COMMIT,
      headers: authed(),
      payload: { sourceDocumentId: SRC_DOC, decisions: [] },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("EXTRACTION_DISABLED");
    await app.close();
  });

  it("still enforces the Authorization Contract (403 without intake.review) before the flag gate", async () => {
    const app = server();
    const res = await app.inject({
      method: "POST",
      url: RUN,
      headers: authed({ "x-test-user": "nobody" }),
      payload: { jobId: JOB, pageCount: 3 },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("reaches the pipeline (202) when the flag is injected ON", async () => {
    const app = server({
      async forOrg() {
        return { "documents.doclens": true };
      },
    });
    const res = await app.inject({
      method: "POST",
      url: RUN,
      headers: authed(),
      payload: { jobId: JOB, pageCount: 3 },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("ready_for_review");
    await app.close();
  });
});
