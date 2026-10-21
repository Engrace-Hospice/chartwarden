// apps/backend/__tests__/m22-doclens-sud-gate.test.ts — GAP-067: the DocLens review surface must not hand
// decrypted 42 CFR Part 2 content to every `intake.review` holder.
//
// Two layers, because the control is enforced at both (route predicate composes, service layer redacts):
//   1. the pure gate (`sud-content-gate.ts`) the service applies to a loaded workspace / page request;
//   2. the real routes through the full M1 chain via `inject`, with the REAL guards composing
//      `extraction_reviewer_eligible` + `sud_consent_present`, over a fake service that applies the gate.
// No DB: the live-suite cases that exercise the Drizzle service are in f237-doclens-review.live.test.ts.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type {
  ReviewWorkspace,
  ReviewWorkspaceService,
} from "../src/modules/22-documents/extraction/review-workspace";
import { registerDocLensReviewWorkspaceRoutes } from "../src/modules/22-documents/extraction/review-workspace-routes";
import {
  type SudContentAccess,
  type SudStatus,
  assertSudPageReadable,
  redactSudWorkspace,
  resolveSudContentAccess,
} from "../src/modules/22-documents/extraction/sud-content-gate";

const ORG = "org_a";
const BATCH = "b0000000-0000-4000-8000-0000000000aa";
const PATIENT = "11111111-1111-4111-8111-111111111111";

function workspaceFixture(sudStatus: ReviewWorkspace["sud"]["status"]): ReviewWorkspace {
  return {
    batch: {
      id: BATCH,
      status: "in_review",
      sourceChannel: "fax",
      uploadedAt: "2026-10-01T00:00:00.000Z",
      documentId: "d0000000-0000-4000-8000-000000000001",
      patientId: PATIENT,
      patientName: "Doclens, Mae",
      referralId: null,
      identityStatus: null,
      recordsRequestConflict: null,
    },
    sud: {
      status: sudStatus,
      detectorRef: "rules@1",
      resolvedAt: null,
      resolvedByMembershipId: null,
      contentRedacted: false,
      indicators: [
        { page: 2, category: "medication", ruleId: "r1", term: "Methadone", bbox: [1, 2, 3, 4] },
      ],
    },
    pages: [],
    documents: [],
    jobs: [],
    review: null,
    candidates: [
      {
        id: "e1",
        jobId: "j1",
        documentType: "hp",
        fieldPath: "patient.phoneHome",
        description: null,
        riskLevel: "low",
        confidence: 0.99,
        value: "(503) 555-0142",
        page: 1,
        bbox: [0, 0, 1, 1],
        vision: { status: "not_required", observedValue: null },
        sudDetected: false,
        codingFlags: [],
        writebackTarget: true,
        redacted: false,
        decision: null,
      },
      {
        id: "e2",
        jobId: "j1",
        documentType: "hp",
        fieldPath: "medications[0].name",
        description: null,
        riskLevel: "high",
        confidence: 0.9,
        value: "Methadone 20 mg",
        page: 2,
        bbox: [0, 0, 1, 1],
        vision: { status: "disagreed", observedValue: "Methadone 20 mg PO q8h" },
        sudDetected: true,
        codingFlags: [{ kind: "k", code: "F11.20", suggest: [], detail: "opioid dependence" }],
        writebackTarget: false,
        redacted: false,
        decision: {
          id: "dec1",
          decision: "edit",
          editedValue: "Methadone 30 mg",
          reason: "dose per MAR",
          partOfBulkApprove: false,
          decidedAt: "2026-10-01T01:00:00.000Z",
        },
      },
    ],
  };
}

const access = (o: { eligible: boolean; consent: boolean }): SudContentAccess => ({
  reviewerEligible: async () => o.eligible,
  consentPresent: async () => o.consent,
});

describe("GAP-067 — pure SUD content gate", () => {
  it("redacts SUD-detected candidates and the evidence for a viewer without access", () => {
    const out = redactSudWorkspace(workspaceFixture("detected"));
    const sud = out.candidates.find((c) => c.id === "e2");
    expect(sud).toMatchObject({
      value: null,
      redacted: true,
      codingFlags: [],
      vision: { status: "disagreed", observedValue: null },
      decision: { editedValue: null, reason: null },
    });
    expect(out.sud.indicators).toEqual([]);
    expect(out.sud.contentRedacted).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/methadone|F11\.20|opioid/i);
  });

  it("leaves non-SUD candidates in the same batch readable", () => {
    const out = redactSudWorkspace(workspaceFixture("detected"));
    expect(out.candidates.find((c) => c.id === "e1")).toMatchObject({
      value: "(503) 555-0142",
      redacted: false,
    });
  });

  it("does not mutate the loaded workspace", () => {
    const ws = workspaceFixture("confirmed");
    redactSudWorkspace(ws);
    expect(ws.candidates[1]?.value).toBe("Methadone 20 mg");
    expect(ws.sud.indicators).toHaveLength(1);
  });

  it("denies when no access is supplied, and when a probe throws or answers false", async () => {
    const target = { sudStatus: "confirmed", patientId: PATIENT } as const;
    expect(await resolveSudContentAccess(undefined, target)).toBe(false);
    expect(await resolveSudContentAccess(access({ eligible: false, consent: true }), target)).toBe(
      false,
    );
    expect(
      await resolveSudContentAccess(
        {
          reviewerEligible: async () => true,
          consentPresent: async () => {
            throw new Error("consent seam down");
          },
        },
        target,
      ),
    ).toBe(false);
    expect(
      await resolveSudContentAccess(
        {
          reviewerEligible: async () => {
            throw new Error("predicate down");
          },
          consentPresent: async () => true,
        },
        target,
      ),
    ).toBe(false);
    expect(await resolveSudContentAccess(access({ eligible: true, consent: true }), target)).toBe(
      true,
    );
  });

  it("asks the consent probe about the BATCH's patient, never anything else", async () => {
    const seen: string[] = [];
    await resolveSudContentAccess(
      {
        reviewerEligible: async () => true,
        consentPresent: async (patientId) => {
          seen.push(patientId);
          return true;
        },
      },
      { sudStatus: "confirmed", patientId: PATIENT },
    );
    expect(seen).toEqual([PATIENT]);
  });

  // The behaviour matrix (status x licensed-eligible x consent). `true` = Part 2 content readable.
  const MATRIX: ReadonlyArray<readonly [SudStatus, boolean, boolean, boolean]> = [
    // status, eligible, consent, readable
    ["not_detected", false, false, true], // not Part 2 content
    ["not_detected", true, true, true],
    ["rejected", false, false, true], // a false positive is not Part 2 content
    ["rejected", true, false, true],
    ["detected", true, false, true], // adjudicating a detection is internal use: no consent needed
    ["detected", true, true, true],
    ["detected", false, true, false], // consent never substitutes for the licence
    ["detected", false, false, false],
    ["confirmed", true, true, true],
    ["confirmed", true, false, false], // confirmed Part 2 content needs consent on file again
    ["confirmed", false, true, false],
    ["confirmed", false, false, false],
  ];
  it.each(MATRIX)(
    "matrix: %s eligible=%s consent=%s -> readable=%s",
    async (status, eligible, consent, readable) => {
      const target = { sudStatus: status, patientId: PATIENT };
      expect(await resolveSudContentAccess(access({ eligible, consent }), target)).toBe(readable);
    },
  );

  it("a detected batch needs no consent lookup, so a down consent seam cannot blind the adjudicator", async () => {
    const consentCalls: string[] = [];
    const ok = await resolveSudContentAccess(
      {
        reviewerEligible: async () => true,
        consentPresent: async (p) => {
          consentCalls.push(p);
          throw new Error("consent seam down");
        },
      },
      { sudStatus: "detected", patientId: PATIENT },
    );
    expect(ok).toBe(true);
    expect(consentCalls).toEqual([]);
  });

  it("a patientless batch: detected is adjudicable by an eligible reviewer, confirmed is denied", async () => {
    const a = access({ eligible: true, consent: true });
    expect(await resolveSudContentAccess(a, { sudStatus: "detected", patientId: null })).toBe(true);
    expect(await resolveSudContentAccess(a, { sudStatus: "confirmed", patientId: null })).toBe(
      false,
    );
  });

  it("page images: a detected or confirmed batch is refused (403) without access; others pass", () => {
    expect(() => assertSudPageReadable("detected", false)).toThrowError(/Part 2|restricted/i);
    expect(() => assertSudPageReadable("confirmed", false)).toThrowError();
    expect(() => assertSudPageReadable("detected", true)).not.toThrow();
    expect(() => assertSudPageReadable("not_detected", false)).not.toThrow();
    expect(() => assertSudPageReadable("rejected", false)).not.toThrow();
  });
});

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────
interface Persona {
  readonly licensed: boolean;
  readonly consent: boolean;
}

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  request.context.organizationId = ORG;
  request.context.roles = ["rn"];
}

const PERSONAS: Record<string, Persona> = {
  rn_ok: { licensed: true, consent: true },
  rn_no_consent: { licensed: true, consent: false },
  aide_consent: { licensed: false, consent: true },
  rn_seam_down: { licensed: true, consent: true },
};

function makeServer(sudStatus: ReviewWorkspace["sud"]["status"] = "detected") {
  const calls = { consentPatients: [] as string[], renders: 0 };
  const store = createInMemoryEffectivePermissionStore(
    Object.keys(PERSONAS).map((userId) => ({
      orgId: ORG,
      userId,
      grants: [
        { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["intake.review"] },
      ],
    })),
  );
  registerEffectivePermissionResolver(store.store);
  const reg = createPredicateRegistry();
  reg.register("extraction_reviewer_eligible", async (context, target) =>
    target.sudReview === true ? PERSONAS[context.userId]?.licensed === true : false,
  );
  reg.register("sud_consent_present", async (context, target) => {
    if (context.userId === "rn_seam_down") throw new Error("consent seam unavailable");
    calls.consentPatients.push(String(target.patientId));
    return PERSONAS[context.userId]?.consent === true && target.patientId === PATIENT;
  });
  registerAbacRegistry(reg);

  const service = {
    async getWorkspace(_org: string, _id: string, _membership: string, access?: SudContentAccess) {
      const ws = workspaceFixture(sudStatus);
      const allowed = await resolveSudContentAccess(access, {
        sudStatus,
        patientId: ws.batch.patientId,
      });
      return allowed ? ws : redactSudWorkspace(ws);
    },
    async renderPage(
      _org: string,
      _id: string,
      _page: number,
      _correlationId: string,
      access?: SudContentAccess,
    ) {
      assertSudPageReadable(
        sudStatus,
        await resolveSudContentAccess(access, { sudStatus, patientId: PATIENT }),
      );
      calls.renders += 1;
      return { png: new Uint8Array([1]), pageWidth: 1, pageHeight: 1 };
    },
  } as unknown as ReviewWorkspaceService;

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerDocLensReviewWorkspaceRoutes(app, service);
  return { app, calls };
}

const as = (user: string) => ({ "x-test-user": user });
const workspaceUrl = `/api/v1/intake/uploads/${BATCH}/workspace`;
const imageUrl = `/api/v1/intake/uploads/${BATCH}/pages/1/image`;

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("GAP-067 — DocLens review routes compose the Part 2 need-to-know check", () => {
  it("a licensed reviewer with Part 2 consent on file sees a confirmed batch's SUD values and evidence", async () => {
    const { app, calls } = makeServer("confirmed");
    const res = await app.inject({ method: "GET", url: workspaceUrl, headers: as("rn_ok") });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sud.contentRedacted).toBe(false);
    expect(body.sud.indicators).toHaveLength(1);
    expect(body.candidates[1].value).toBe("Methadone 20 mg");
    // The predicate is asked about the BATCH's patient (server-derived), not a client-supplied one.
    expect(calls.consentPatients).toEqual([PATIENT]);
  });

  it("a licensed reviewer with NO consent sees a PENDING detection (adjudicating it is internal use)", async () => {
    const { app, calls } = makeServer("detected");
    const res = await app.inject({
      method: "GET",
      url: workspaceUrl,
      headers: as("rn_no_consent"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sud.contentRedacted).toBe(false);
    expect(res.json().candidates[1].value).toBe("Methadone 20 mg");
    expect(calls.consentPatients).toEqual([]);
  });

  it("a licensed reviewer with NO consent gets a CONFIRMED batch's SUD values and evidence redacted", async () => {
    const { app } = makeServer("confirmed");
    const res = await app.inject({
      method: "GET",
      url: workspaceUrl,
      headers: as("rn_no_consent"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sud).toMatchObject({ contentRedacted: true, indicators: [] });
    expect(res.json().candidates[1]).toMatchObject({ value: null, redacted: true });
    expect(res.body).not.toMatch(/methadone/i);
    // Non-SUD fields on the same batch remain available for review.
    expect(res.json().candidates[0].value).toBe("(503) 555-0142");
  });

  it("a licensed reviewer WITH consent reads a confirmed batch", async () => {
    const { app } = makeServer("confirmed");
    const res = await app.inject({ method: "GET", url: workspaceUrl, headers: as("rn_ok") });
    expect(res.json().candidates[1].value).toBe("Methadone 20 mg");
  });

  it("an unlicensed reviewer is redacted even when consent is on file, pending or confirmed", async () => {
    const { app } = makeServer("detected");
    const res = await app.inject({ method: "GET", url: workspaceUrl, headers: as("aide_consent") });
    expect(res.statusCode).toBe(200);
    expect(res.json().candidates[1].value).toBeNull();
  });

  it("fails closed (redacts a confirmed batch) when the consent seam throws", async () => {
    const { app } = makeServer("confirmed");
    const res = await app.inject({ method: "GET", url: workspaceUrl, headers: as("rn_seam_down") });
    expect(res.statusCode).toBe(200);
    expect(res.json().sud.contentRedacted).toBe(true);
    expect(res.body).not.toMatch(/methadone/i);
  });

  it("the page image of a CONFIRMED batch is a 403 without consent, and never rendered", async () => {
    const { app, calls } = makeServer("confirmed");
    const res = await app.inject({ method: "GET", url: imageUrl, headers: as("rn_no_consent") });
    expect(res.statusCode).toBe(403);
    expect(calls.renders).toBe(0);
  });

  it("the page image of a PENDING detection renders for a licensed reviewer without consent", async () => {
    const { app, calls } = makeServer("detected");
    const res = await app.inject({ method: "GET", url: imageUrl, headers: as("rn_no_consent") });
    expect(res.statusCode).toBe(200);
    expect(calls.renders).toBe(1);
  });

  it("the page image of a PENDING detection is still a 403 for an unlicensed reviewer", async () => {
    const { app, calls } = makeServer("detected");
    const res = await app.inject({ method: "GET", url: imageUrl, headers: as("aide_consent") });
    expect(res.statusCode).toBe(403);
    expect(calls.renders).toBe(0);
  });

  it("the page image of a SUD-flagged batch renders for a licensed reviewer with consent", async () => {
    const { app, calls } = makeServer("detected");
    const res = await app.inject({ method: "GET", url: imageUrl, headers: as("rn_ok") });
    expect(res.statusCode).toBe(200);
    expect(calls.renders).toBe(1);
  });

  it("the page image of a non-SUD batch is unaffected", async () => {
    const { app } = makeServer("not_detected");
    const res = await app.inject({ method: "GET", url: imageUrl, headers: as("rn_no_consent") });
    expect(res.statusCode).toBe(200);
  });
});
