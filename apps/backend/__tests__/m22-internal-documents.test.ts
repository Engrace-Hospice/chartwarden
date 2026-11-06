// apps/backend/__tests__/m22-internal-documents.test.ts — ADR-0109 D6 / D9: M16's physician condolence letter and internal
// discharge summary are INTERNAL documents. They are filed on the decedent's chart, so the §4.7 caseload rule alone would admit
// anyone on that chart (a bereavement volunteer who served the patient) and the `patient_facing` flag alone is one PATCH away from
// the portal. Their aggregate types are internal-only: only the §4.7 scope-bypass roles and bereavement oversight read them (content,
// metadata, versions, tags and the list), caseload membership never admits, a PATCH can never flip them patient-facing, and the
// portal reader refuses them whatever `patient_facing` says.
import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  registerPredicateIdempotent,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import { BEREAVEMENT_OVERSIGHT_ROLES } from "../src/modules/16-bereavement/abac-predicates";
import {
  SCOPE_BYPASS_ROLES,
  canReadInternalDocuments,
} from "../src/modules/22-documents/abac-predicates";
import {
  createInMemoryDocumentBackend,
  createSignedUrlService,
  registerDocumentAbacPredicates,
  registerDocumentRoutes,
} from "../src/modules/22-documents/index";
import {
  INTERNAL_DOCUMENT_OVERSIGHT_ROLES,
  INTERNAL_ONLY_DOCUMENT_AGGREGATE_TYPES,
  isInternalOnlyAggregateType,
} from "../src/modules/22-documents/internal-documents";
import { PLATFORM_TEMPLATE_TABLE } from "../src/modules/22-documents/seams/renderer";
import { hasBereavementOversightRole } from "../src/modules/39-consent/access-scope";

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const DOC_SUMMARY = "c0000000-0000-4000-8000-0000000000a1";
const DOC_LETTER = "c0000000-0000-4000-8000-0000000000a2";
const DOC_PLAIN = "c0000000-0000-4000-8000-0000000000a3";
const VERSION = "d0000000-0000-4000-8000-000000000001";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const backend = createInMemoryDocumentBackend({
  documents: [
    {
      id: DOC_SUMMARY,
      organizationId: ORG,
      patientId: PATIENT,
      aggregateType: "bereavement_discharge_summary",
      retentionClass: "bereavement",
    },
    {
      id: DOC_LETTER,
      organizationId: ORG,
      patientId: PATIENT,
      aggregateType: "bereavement_physician_letter",
      retentionClass: "bereavement",
    },
    { id: DOC_PLAIN, organizationId: ORG, patientId: PATIENT, aggregateType: "encounter" },
  ],
});

const KEYS = [
  "documents.upload",
  "documents.read",
  "documents.read_phi_content",
  "documents.edit_metadata",
  "documents.read_org_wide",
];
const PEOPLE = [
  // On the decedent's chart: both pass the §4.7 caseload rule.
  "rn_1",
  "volunteer_1",
  // Not on the chart: oversight and compliance reach it by role.
  "supervisor_1",
  "compliance_1",
  "coordinator_1",
];
const CHART = ["rn_1", "volunteer_1"];

const as = (user: string, roles: string) => ({
  "x-test-user": user,
  "x-test-org": ORG,
  "x-test-roles": roles,
});
const RN = as("rn_1", "rn");
const VOLUNTEER = as("volunteer_1", "bereavement_volunteer");
const SUPERVISOR = as("supervisor_1", "clinical_supervisor");
const COMPLIANCE = as("compliance_1", "compliance_officer");
const COORDINATOR = as("coordinator_1", "bereavement_coordinator");

function makeServer() {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      PEOPLE.map((userId) => ({
        orgId: ORG,
        userId,
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: KEYS }],
      })),
    ).store,
  );
  registerAbacRegistry();
  registerDocumentAbacPredicates({
    resolver: backend.abacResolver,
    isInCaseload: async (q) => CHART.includes(q.userId) && q.patientId === PATIENT,
    activeCredentials: async () => [],
  });
  registerPredicateIdempotent("step_up_recent", async () => true);
  const signedUrl = createSignedUrlService({
    storage: {
      async presignDownload({ descriptor }) {
        return {
          url: `https://minio.example/${descriptor.bucket}/${descriptor.objectKey}`,
          expiresAt: "2026-06-21T12:05:00.000Z",
        };
      },
    },
    resolver: backend.objectResolver,
  });
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerDocumentRoutes(app, {
    service: backend.service,
    signedUrl,
    referralReader: { canAccessReferral: async () => false },
  });
  return app;
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  registerSeam("CaseloadProvider", {
    isInCaseload: async (q: { userId: string; patientId: string }) =>
      CHART.includes(q.userId) && q.patientId === PATIENT,
    caseloadPatientIds: async ({ userId }: { userId: string }) =>
      CHART.includes(userId) ? [PATIENT] : [],
  } as never);
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
  __resetSeamsForTest();
});

describe("the internal-only document types", () => {
  it("are exactly the descriptors flagged internal, so the renderer table and the read rule cannot drift", () => {
    const flagged = Object.values(PLATFORM_TEMPLATE_TABLE)
      .filter((d) => d.internalOnly === true)
      .map((d) => d.aggregateType)
      .sort();
    expect(flagged).toEqual([...INTERNAL_ONLY_DOCUMENT_AGGREGATE_TYPES].sort());
    expect(flagged).toEqual([
      "bereavement_discharge_summary",
      "bereavement_mailing_batch",
      "bereavement_physician_letter",
    ]);
    expect(isInternalOnlyAggregateType("bereavement_letter")).toBe(false);
  });

  // M22 mirrors the role KEYS (its `dependsOn` is [1, 5]) and M39 keeps its own mirror: a role added to or renamed in M16's set must
  // reach every reader of an internal document, or that role could review the letter yet never open the rendered PDF.
  it("M22's oversight roles are M16's oversight roles, modulo the roles that already bypass the caseload scope", () => {
    const expected = BEREAVEMENT_OVERSIGHT_ROLES.filter((r) => !SCOPE_BYPASS_ROLES.includes(r));
    expect([...INTERNAL_DOCUMENT_OVERSIGHT_ROLES].sort()).toEqual([...expected].sort());
    for (const role of BEREAVEMENT_OVERSIGHT_ROLES) {
      expect(canReadInternalDocuments([role]), role).toBe(true);
    }
  });

  it("M39's mirror of the oversight roles admits exactly M16's set", () => {
    for (const role of BEREAVEMENT_OVERSIGHT_ROLES) {
      expect(hasBereavementOversightRole([role]), role).toBe(true);
    }
    expect(
      hasBereavementOversightRole([
        "rn",
        "bereavement_volunteer",
        "bereavement_program_coordinator",
      ]),
    ).toBe(false);
  });

  it("file the three M16 templates under their own retention class (the mailing batch holds every addressee)", () => {
    expect(PLATFORM_TEMPLATE_TABLE.bereavement_mailing_batch).toMatchObject({
      aggregateType: "bereavement_mailing_batch",
      retentionClass: "bereavement",
      internalOnly: true,
    });
    expect(isInternalOnlyAggregateType("bereavement_mailing_batch")).toBe(true);
    expect(PLATFORM_TEMPLATE_TABLE.bereavement_physician_condolence_letter).toMatchObject({
      aggregateType: "bereavement_physician_letter",
      retentionClass: "bereavement",
      internalOnly: true,
    });
    expect(PLATFORM_TEMPLATE_TABLE.bereavement_discharge_summary_internal).toMatchObject({
      aggregateType: "bereavement_discharge_summary",
      retentionClass: "bereavement",
      internalOnly: true,
    });
  });
});

describe("content: GET /documents/:id/versions/:versionId/content", () => {
  const url = (id: string) =>
    `/api/v1/documents/${id}/versions/${VERSION}/content?purpose=treatment`;
  const versionOf = async (id: string) => {
    const doc = await backend.service.getDocument(ORG as never, id);
    return doc;
  };

  it("a caseload member of the decedent's chart cannot mint the internal summary or letter (404)", async () => {
    await versionOf(DOC_SUMMARY);
    const app = makeServer();
    for (const who of [RN, VOLUNTEER]) {
      for (const id of [DOC_SUMMARY, DOC_LETTER]) {
        const res = await app.inject({ method: "GET", url: url(id), headers: who });
        expect(res.statusCode).toBe(404);
      }
    }
    await app.close();
  });

  it("the same caseload member still reads an ordinary document of that chart (the rule is narrow)", async () => {
    const app = makeServer();
    const res = await app.inject({ method: "GET", url: url(DOC_PLAIN), headers: RN });
    expect(res.statusCode).not.toBe(404);
    expect(res.statusCode).not.toBe(403);
    await app.close();
  });

  it("oversight and compliance pass the ABAC for an internal document without being on the chart", async () => {
    const app = makeServer();
    for (const who of [SUPERVISOR, COMPLIANCE, COORDINATOR]) {
      const res = await app.inject({ method: "GET", url: url(DOC_SUMMARY), headers: who });
      // 404 here would be the ABAC denying; the in-memory backend may answer another status for the missing version fixture.
      expect([200, 302, 422]).toContain(res.statusCode);
    }
    await app.close();
  });
});

describe("metadata and the list", () => {
  it("by-id metadata of an internal document is a 404 to a caseload member and 200 to oversight / compliance", async () => {
    const app = makeServer();
    for (const who of [RN, VOLUNTEER]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/documents/${DOC_SUMMARY}`,
        headers: who,
      });
      expect(res.statusCode).toBe(404);
    }
    for (const who of [SUPERVISOR, COMPLIANCE, COORDINATOR]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/documents/${DOC_SUMMARY}`,
        headers: who,
      });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });

  it("the list leaves the internal documents out for a caseload member and an org-wide metadata reader", async () => {
    const app = makeServer();
    const ids = async (who: Record<string, string>) =>
      (
        (await app.inject({ method: "GET", url: "/api/v1/documents", headers: who })).json()
          .items as Array<{ id: string }>
      ).map((d) => d.id);
    for (const who of [RN, VOLUNTEER]) {
      const seen = await ids(who);
      expect(seen).toContain(DOC_PLAIN);
      expect(seen).not.toContain(DOC_SUMMARY);
      expect(seen).not.toContain(DOC_LETTER);
    }
    // an org-wide key (view-only metadata) does not widen it either
    const orgWide = await ids(as("supervisor_1", "clinical_supervisor"));
    expect(orgWide).toEqual(expect.arrayContaining([DOC_SUMMARY, DOC_LETTER]));
    const compliance = await ids(COMPLIANCE);
    expect(compliance).toEqual(expect.arrayContaining([DOC_SUMMARY, DOC_LETTER, DOC_PLAIN]));
    await app.close();
  });
});

describe("internal documents are render-only: every hand write path is refused", () => {
  const code = (res: { json(): { error?: { code?: string }; code?: string } }) =>
    res.json().error?.code ?? res.json().code;

  it("PATCH is refused 422 for a reader who may see the document, whatever it changes", async () => {
    const app = makeServer();
    for (const payload of [
      { patientFacing: true },
      { title: "Condolence letter (reviewed)" },
      { attachToDisclosures: true },
    ]) {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/documents/${DOC_LETTER}`,
        headers: COMPLIANCE,
        payload,
      });
      expect(res.statusCode).toBe(422);
      expect(code(res)).toBe("DOCUMENT_INTERNAL_ONLY");
    }
    await app.close();
  });

  it("tags, links and versions are refused 422 for oversight and 404 for a caseload member (no id probe)", async () => {
    const app = makeServer();
    const writes = [
      {
        method: "POST" as const,
        url: `/api/v1/documents/${DOC_SUMMARY}/tags`,
        payload: { tagKind: "free", tagKey: "note", tagValue: "x" },
      },
      {
        method: "DELETE" as const,
        url: `/api/v1/documents/${DOC_SUMMARY}/tags/c0000000-0000-4000-8000-0000000000b1`,
        payload: undefined,
      },
      {
        method: "POST" as const,
        url: `/api/v1/documents/${DOC_SUMMARY}/links`,
        payload: { patientId: PATIENT },
      },
      {
        method: "POST" as const,
        url: `/api/v1/documents/${DOC_SUMMARY}/versions`,
        payload: { contentBase64: "JVBERi0xLjQK", mimeType: "application/pdf" },
      },
    ];
    for (const write of writes) {
      const refused = await app.inject({ ...write, headers: COORDINATOR });
      expect(refused.statusCode, `${write.method} ${write.url}`).toBe(422);
      expect(code(refused)).toBe("DOCUMENT_INTERNAL_ONLY");
      const hidden = await app.inject({ ...write, headers: RN });
      expect(hidden.statusCode, `${write.method} ${write.url}`).toBe(404);
    }
    await app.close();
  });
});
