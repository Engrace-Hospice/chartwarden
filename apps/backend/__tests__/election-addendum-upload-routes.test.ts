// FY2027 election statement addendum — the two scanned-paper-copy routes through the full M1 chain (Fastify inject):
//   POST /api/v1/admissions/:id/election-addendum/:addendumId/signature/uploaded-evidence
//   POST /api/v1/admissions/:id/election-addendum/:addendumId/refusal/uploaded-evidence
// Permission gating (the SAME `election_addendum.acknowledge` key as the keyed signature), body validation (422), and
// the exact input handed to the service.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type ElectionAddendumService,
  registerElectionAddendumRoutes,
} from "../src/modules/06-admission/index";

const ORG = "org_a";
const DOC = "6f1c2a52-7d7e-4b9f-8a43-6a1f1f0f0a01";
const VER = "6f1c2a52-7d7e-4b9f-8a43-6a1f1f0f0a02";
const BASE = "/api/v1/admissions/adm_1/election-addendum/ea_1";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = ["rn"];
  request.context.providerEntityIds = [];
  request.context.locationIds = [];
}

const VIEW: Awaited<ReturnType<ElectionAddendumService["attachUploadedAcknowledgement"]>> = {
  id: "ea_1",
  admissionId: "adm_1",
  patientId: "pat_1",
  electionStatementId: null,
  versionNumber: 1,
  trigger: "initial",
  triggerCause: "election",
  triggeredAt: "2026-10-05T00:00:00.000Z",
  status: "signed",
  hospiceName: "Example Hospice",
  patientName: "Test Patient",
  medicalRecordNumber: "MRN-1",
  terminalDiagnosis: [],
  relatedDiagnoses: [],
  items: [],
  noNonCoveredItems: true,
  clinicalExplanation: null,
  guidelineReferences: null,
  dueAt: null,
  furnishedAt: "2026-10-08T12:00:00.000Z",
  furnishMethod: "paper",
  signedAt: "2026-10-09T12:00:00.000Z",
  signerKind: "beneficiary",
  representativeName: null,
  representativeRelationship: null,
  acknowledgementSource: "uploaded",
  acknowledgementDocumentId: DOC,
  acknowledgementDocumentVersionId: VER,
  contentSource: "structured",
  refusedAt: null,
  refusalReason: null,
  signatureNotRequiredReason: null,
  signatureNotRequiredNote: null,
  signatureNotRequiredAt: null,
  documentId: null,
  supersededById: null,
  supersededAt: null,
  createdAt: "2026-10-05T00:00:00.000Z",
  updatedAt: "2026-10-09T12:00:00.000Z",
  version: 4,
};

function makeServer() {
  const grants = (userId: string, permissionKeys: string[]) => ({
    orgId: ORG,
    userId,
    grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      grants("ack_1", ["election_addendum.read", "election_addendum.acknowledge"]),
      grants("writer_1", ["election_addendum.read", "election_addendum.write"]),
    ]).store,
  );
  const registry = createPredicateRegistry();
  registry.register("admission.scope", async () => true);
  registerAbacRegistry(registry);
  const attach = vi.fn<ElectionAddendumService["attachUploadedAcknowledgement"]>(async () => VIEW);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerElectionAddendumRoutes(app, {
    service: { attachUploadedAcknowledgement: attach } as unknown as ElectionAddendumService,
  });
  return { app, attach };
}

const as = (user: string) => ({ "x-test-user": user });

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("POST …/signature/uploaded-evidence", () => {
  it("hands the service the scanned copy, the signer and both dates", async () => {
    const { app, attach } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/signature/uploaded-evidence`,
      headers: as("ack_1"),
      payload: {
        ifVersion: 3,
        documentId: DOC,
        documentVersionId: VER,
        signerKind: "representative",
        representativeName: "Jane Doe",
        representativeRelationship: "Daughter",
        signedAt: "2026-10-09T12:00:00.000Z",
        furnishedAt: "2026-10-08T12:00:00.000Z",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: "ea_1",
      status: "signed",
      acknowledgementSource: "uploaded",
      acknowledgementDocumentId: DOC,
    });
    expect(attach).toHaveBeenCalledWith(
      ORG,
      "adm_1",
      "ea_1",
      3,
      {
        outcome: "signed",
        documentId: DOC,
        documentVersionId: VER,
        signerKind: "representative",
        representativeName: "Jane Doe",
        representativeRelationship: "Daughter",
        signedAt: "2026-10-09T12:00:00.000Z",
        furnishedAt: "2026-10-08T12:00:00.000Z",
      },
      "ack_1",
    );
  });

  it("requires the same acknowledge permission as the keyed signature", async () => {
    const { app, attach } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/signature/uploaded-evidence`,
      headers: as("writer_1"),
      payload: {
        ifVersion: 1,
        documentId: DOC,
        documentVersionId: VER,
        signerKind: "beneficiary",
        signedAt: "2026-10-09T12:00:00.000Z",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(attach).not.toHaveBeenCalled();
  });

  it("rejects a missing signature date and a non-uuid document id", async () => {
    const { app, attach } = makeServer();
    for (const payload of [
      { ifVersion: 1, documentId: DOC, documentVersionId: VER, signerKind: "beneficiary" },
      {
        ifVersion: 1,
        documentId: "doc_1",
        documentVersionId: VER,
        signerKind: "beneficiary",
        signedAt: "2026-10-09T12:00:00.000Z",
      },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: `${BASE}/signature/uploaded-evidence`,
        headers: as("ack_1"),
        payload,
      });
      expect(res.statusCode).toBe(422);
    }
    expect(attach).not.toHaveBeenCalled();
  });
});

describe("POST …/refusal/uploaded-evidence", () => {
  it("hands the service the refusal reason with the scanned copy", async () => {
    const { app, attach } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/refusal/uploaded-evidence`,
      headers: as("ack_1"),
      payload: {
        ifVersion: 2,
        documentId: DOC,
        documentVersionId: VER,
        reason: "Patient declined to sign; noted on the paper copy.",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(attach).toHaveBeenCalledWith(
      ORG,
      "adm_1",
      "ea_1",
      2,
      {
        outcome: "refused",
        documentId: DOC,
        documentVersionId: VER,
        reason: "Patient declined to sign; noted on the paper copy.",
      },
      "ack_1",
    );
  });

  it("rejects a reason shorter than five characters", async () => {
    const { app, attach } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/refusal/uploaded-evidence`,
      headers: as("ack_1"),
      payload: { ifVersion: 2, documentId: DOC, documentVersionId: VER, reason: "no" },
    });
    expect(res.statusCode).toBe(422);
    expect(attach).not.toHaveBeenCalled();
  });
});
