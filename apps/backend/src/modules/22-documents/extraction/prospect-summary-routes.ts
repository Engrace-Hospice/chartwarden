import { type Static, Type } from "@sinclair/typebox";
// apps/backend/src/modules/22-documents/extraction/prospect-summary-routes.ts — the F-238 prospect summary:
//
//   GET /api/v1/intake/uploads/:id/summary   a completed review's reviewer-approved values, grouped into one
//                                            picture of the prospect + a copyable plain-text rendering (PHI)
//
//   GET /api/v1/patients/:patientId/intake-summaries
//                                            every completed review's summary for a patient's chart, newest
//                                            first — the "how did this person arrive" snapshot on the Overview
//
// The batch read is gated and audited exactly like the review workspace read it summarises (`intake.review` + an `auditRead`
// declaration, so the host's read-audit hook records who looked at which batch). 409 REVIEW_NOT_COMPLETE
// until the review is complete. Built deterministically (`prospect-summary.ts`) — no model is involved.
import { type GuardRequest, requireAbac, requirePermission } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parse } from "../routes/documents-typebox";
import type { ProspectSummaryService } from "./prospect-summary-db";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const Citation = Type.Object({
  document: Type.String(),
  documentType: Type.String(),
  page: Type.Integer(),
});
const CodingFlag = Type.Object({
  kind: Type.String(),
  code: Type.String(),
  detail: Type.String(),
  label: Type.String(),
  severity: Type.Union([Type.Literal("critical"), Type.Literal("warning"), Type.Literal("info")]),
});
const Line = Type.Object({
  text: Type.String(),
  edited: Type.Boolean(),
  citations: Type.Array(Citation),
});
const DocLensRole = Type.Union([
  Type.Literal("principal"),
  Type.Literal("secondary"),
  Type.Literal("history"),
  Type.Literal("unspecified"),
]);
const SummaryDocument = Type.Object({
  pageFrom: Type.Integer(),
  pageTo: Type.Integer(),
  documentType: Type.String(),
  documentTypeLabel: Type.String(),
  title: Type.Union([Type.String(), Type.Null()]),
  date: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([
    Type.Literal("included"),
    Type.Literal("other_patient"),
    Type.Literal("duplicate"),
  ]),
  duplicateOfPage: Type.Union([Type.Integer(), Type.Null()]),
});
const NullableString = Type.Union([Type.String(), Type.Null()]);

export const ProspectSummaryResponseSchema = Type.Object({
  batchId: Type.String(),
  reviewId: Type.String(),
  completedAt: NullableString,
  receivedAt: Type.String(),
  sourceChannel: Type.String(),
  filedUnder: Type.Object({
    patientId: NullableString,
    patientName: NullableString,
    referralId: NullableString,
  }),
  patient: Type.Array(
    Type.Object({
      key: Type.Union([
        Type.Literal("legalName"),
        Type.Literal("preferredName"),
        Type.Literal("dateOfBirth"),
        Type.Literal("address"),
        Type.Literal("phoneHome"),
        Type.Literal("phoneMobile"),
        Type.Literal("email"),
      ]),
      label: Type.String(),
      values: Type.Array(
        Type.Object({
          value: Type.String(),
          edited: Type.Boolean(),
          citations: Type.Array(Citation),
        }),
      ),
    }),
  ),
  diagnoses: Type.Array(
    Type.Object({
      description: Type.String(),
      icd10Code: NullableString,
      icd10Source: Type.Union([
        Type.Literal("document"),
        Type.Literal("reviewer_edit"),
        Type.Null(),
      ]),
      role: DocLensRole,
      edited: Type.Boolean(),
      codingFlags: Type.Array(CodingFlag),
      citations: Type.Array(Citation),
    }),
  ),
  medications: Type.Array(Line),
  allergies: Type.Array(Line),
  advanceDirectives: Type.Array(SummaryDocument),
  documents: Type.Array(SummaryDocument),
  withheld: Type.Object({ part2Values: Type.Integer() }),
  notCaptured: Type.Array(Type.String()),
  plainText: Type.String(),
});

export const PatientIntakeSummariesResponseSchema = Type.Object({
  items: Type.Array(ProspectSummaryResponseSchema),
});

// Compile-time pin: the published schema matches what the service returns.
type Conforms<T extends V, V> = T;
type _Summary = Conforms<
  Static<typeof ProspectSummaryResponseSchema>,
  Awaited<ReturnType<ProspectSummaryService["getSummary"]>>
>;

const BatchParams = Type.Object({ id: Type.String({ format: "uuid" }) });
const INTAKE_REVIEW = requirePermission("intake.review") as PreHandler;
// The patient read is a CHART read: `patient.read` + `caseload_or_scope` on the patient (404 on deny, no
// existence leak) — the same gate as the M5 allergy list and the M7 care plan, which carry the same lines.
const PatientParams = Type.Object({ patientId: Type.String({ format: "uuid" }) });
const PATIENT_READ = requirePermission("patient.read") as PreHandler;
const PATIENT_SCOPE = requireAbac("patient.read", "caseload_or_scope", {
  getTarget: (request: GuardRequest) => ({
    patientId: (request.params as { patientId?: unknown } | undefined)?.patientId,
  }),
  notFoundOnDeny: true,
}) as PreHandler;

function organizationOf(request: FastifyRequest): string {
  const ctx = request.context;
  if (!ctx?.organizationId || typeof ctx.userId !== "string" || ctx.userId.length === 0) {
    throw new UnauthorizedError();
  }
  return ctx.organizationId;
}

export function registerDocLensProspectSummaryRoutes(
  app: FastifyInstance,
  service: ProspectSummaryService,
): void {
  app.get(
    "/api/v1/intake/uploads/:id/summary",
    {
      preHandler: [INTAKE_REVIEW],
      config: { auditRead: { resourceKind: "intake_prospect_summary", resourceIdParam: "id" } },
    },
    async (request) => {
      const organizationId = organizationOf(request);
      const { id } = parse(BatchParams, request.params);
      return service.getSummary(organizationId, id);
    },
  );

  app.get(
    "/api/v1/patients/:patientId/intake-summaries",
    {
      preHandler: [PATIENT_READ, PATIENT_SCOPE],
      config: {
        auditRead: { resourceKind: "intake_prospect_summary", patientIdParam: "patientId" },
      },
    },
    async (request) => {
      const organizationId = organizationOf(request);
      const { patientId } = parse(PatientParams, request.params);
      return service.listForPatient(organizationId, patientId);
    },
  );
}
