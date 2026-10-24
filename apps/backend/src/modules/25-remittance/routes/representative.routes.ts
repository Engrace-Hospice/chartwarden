// apps/backend/src/modules/25-remittance/routes/representative.routes.ts - M25 milestone 13a routes: the organization's appointment
// FORM VERSIONS (`representative_form.configure`; nothing is seeded) and the APPOINTMENT OF REPRESENTATIVE record
// (`representative.read` / `.manage`; a SECOND person activates or revokes on `representative.verify` plus a step-up). An
// appointment is recorded from a claim: the patient and provider entity come from the claim, never the body. Every change is
// If-Match (409 when stale) and every mutation requires an Idempotency-Key. Every PHI read emits a read-audit event keyed on its
// own id and attributed to the patient. Nothing here writes a portal, consent or caregiver record.
import { NotFoundError } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { INSTRUMENT_KINDS, REPRESENTATIVE_BOUNDS, REPRESENTATIVE_KINDS } from "../domain";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { P, STEP_UP } from "./guards";
import { uuidParam } from "./later-tier.routes";
import { parse } from "./m25-typebox";
import type { RepresentativeService } from "./representative-service";

export interface RepresentativeRouteDeps {
  readonly representativeService: RepresentativeService;
}

const DAY = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const NULLABLE_STRING = Type.Union([Type.String(), Type.Null()]);
const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const optionalNullable = <T extends ReturnType<typeof Type.String>>(t: T) =>
  Type.Optional(Type.Union([t, Type.Null()]));
const NOTE = Type.String({ maxLength: REPRESENTATIVE_BOUNDS.noteMax });
const SHORT = Type.String({ maxLength: REPRESENTATIVE_BOUNDS.nameMax });

export const RepresentativeFormVersionRequestSchema = Type.Object({
  /** The organization's own name for this version. */
  label: Type.String({ minLength: 1, maxLength: REPRESENTATIVE_BOUNDS.elementLabelMax }),
  /** Form identifier and edition exactly as the SME entered them; ChartWarden does not know or validate them. */
  formIdentifier: optionalNullable(SHORT),
  editionText: optionalNullable(SHORT),
  /** Where this version came from (mandatory: a version nobody can trace is not recorded). */
  sourceNote: Type.String({ minLength: 1, maxLength: REPRESENTATIVE_BOUNDS.noteMax }),
  verifiedOn: optionalNullable(DAY),
  requiredElements: Type.Array(Type.String({ maxLength: REPRESENTATIVE_BOUNDS.elementLabelMax }), {
    maxItems: REPRESENTATIVE_BOUNDS.elementsMax,
  }),
});

export const RepresentativeFormVersionViewSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  formIdentifier: NULLABLE_STRING,
  editionText: NULLABLE_STRING,
  sourceNote: Type.String(),
  verifiedOn: NULLABLE_STRING,
  verifiedByMembershipId: NULLABLE_STRING,
  requiredElements: Type.Array(Type.String()),
  retiredAt: NULLABLE_STRING,
  version: Type.Integer(),
});
export const RepresentativeFormVersionPageSchema = Type.Object({
  items: Type.Array(RepresentativeFormVersionViewSchema),
});

export const AppointmentDraftRequestSchema = Type.Object({
  instrumentKind: literals(INSTRUMENT_KINDS),
  formVersionId: optionalNullable(Type.String({ format: "uuid" })),
  instrumentNote: optionalNullable(NOTE),
  representativeName: Type.String({ minLength: 1, maxLength: REPRESENTATIVE_BOUNDS.nameMax }),
  relationshipLabel: optionalNullable(SHORT),
  representativeKind: literals(REPRESENTATIVE_KINDS),
  beneficiarySignedOn: optionalNullable(DAY),
  representativeSignedOn: optionalNullable(DAY),
  /** Typed from the signed document; never computed. Needs validitySourceNote. */
  validThroughOn: optionalNullable(DAY),
  validitySourceNote: optionalNullable(NOTE),
});

export const AppointmentPatchRequestSchema = Type.Object({
  instrumentNote: optionalNullable(NOTE),
  representativeName: Type.Optional(
    Type.String({ minLength: 1, maxLength: REPRESENTATIVE_BOUNDS.nameMax }),
  ),
  relationshipLabel: optionalNullable(SHORT),
  representativeKind: Type.Optional(literals(REPRESENTATIVE_KINDS)),
  beneficiarySignedOn: optionalNullable(DAY),
  representativeSignedOn: optionalNullable(DAY),
  validThroughOn: optionalNullable(DAY),
  validitySourceNote: optionalNullable(NOTE),
});

export const AppointmentDocumentRequestSchema = Type.Object({
  documentId: Type.String({ format: "uuid" }),
  /** The version the person uploaded; it must be the document's active version. */
  documentVersionId: Type.String({ format: "uuid" }),
});

export const AppointmentElementsRequestSchema = Type.Object({
  /** The checklist labels the person has confirmed; the rest read as missing. */
  confirmedLabels: Type.Array(Type.String({ maxLength: REPRESENTATIVE_BOUNDS.elementLabelMax }), {
    maxItems: REPRESENTATIVE_BOUNDS.elementsMax,
  }),
});

export const AppointmentRevokeRequestSchema = Type.Object({
  revokedOn: DAY,
  note: Type.String({ minLength: 1, maxLength: REPRESENTATIVE_BOUNDS.noteMax }),
});

export const AppointmentViewSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  recordedFromClaimId: Type.String(),
  instrumentKind: Type.String(),
  formVersionId: NULLABLE_STRING,
  formLabel: NULLABLE_STRING,
  instrumentNote: NULLABLE_STRING,
  representativeName: Type.String(),
  relationshipLabel: NULLABLE_STRING,
  representativeKind: Type.String(),
  beneficiarySignedOn: NULLABLE_STRING,
  representativeSignedOn: NULLABLE_STRING,
  validThroughOn: NULLABLE_STRING,
  validitySourceNote: NULLABLE_STRING,
  elements: Type.Array(Type.Object({ label: Type.String(), state: Type.String() })),
  documentId: NULLABLE_STRING,
  documentVersionId: NULLABLE_STRING,
  state: Type.String(),
  status: Type.String(),
  recordedByMembershipId: Type.String(),
  verifiedByMembershipId: NULLABLE_STRING,
  verifiedAt: NULLABLE_STRING,
  revokedOn: NULLABLE_STRING,
  revocationNote: NULLABLE_STRING,
  version: Type.Integer(),
});
export const ClaimAppointmentsSchema = Type.Object({
  claimId: Type.String(),
  patientId: Type.String(),
  items: Type.Array(AppointmentViewSchema),
});
export const RepresentativeVersionedResultSchema = Type.Object({
  id: Type.String(),
  version: Type.Integer(),
});

export function registerRepresentativeRoutes(
  app: FastifyInstance,
  deps: RepresentativeRouteDeps,
): void {
  const { representativeService: svc } = deps;
  const READ = P("representative.read");
  const MANAGE = P("representative.manage");
  const VERIFY = P("representative.verify");
  const VERIFY_STEPUP = STEP_UP("representative.verify");
  const CONFIGURE = P("representative_form.configure");
  const IDEMPOTENT = requireIdempotencyKey();
  const claimId = (request: { params?: unknown }) => uuidParam(request, "claimId", "claim");
  const apptId = (request: { params?: unknown }) =>
    uuidParam(request, "id", "representative appointment");

  // ── the organization's appointment form versions (config; no patient data) ──────────────────────────────
  app.get("/api/v1/representative-form-versions", { preHandler: [READ] }, async (request, reply) =>
    reply.send(await svc.listFormVersions(actorOf(request))),
  );
  app.post(
    "/api/v1/representative-form-versions",
    { preHandler: [CONFIGURE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(RepresentativeFormVersionRequestSchema, request.body);
      return reply.code(201).send(await svc.createFormVersion(writeActorOf(request), body));
    },
  );
  app.post(
    "/api/v1/representative-form-versions/:id/retire",
    { preHandler: [CONFIGURE, IDEMPOTENT] },
    async (request, reply) =>
      reply.send(
        await svc.retireFormVersion(
          writeActorOf(request),
          uuidParam(request, "id", "representative form version"),
          ifMatchVersion(request),
        ),
      ),
  );

  // ── appointments, recorded from a claim ─────────────────────────────────────────────────────────────────
  app.get(
    "/api/v1/claims/:claimId/representative-appointments",
    {
      preHandler: [READ],
      config: {
        auditRead: {
          resourceKind: "claim_representative_appointments",
          resourceIdParam: "claimId",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request, reply) =>
      reply.send(await svc.listForClaim(actorOf(request), claimId(request))),
  );
  app.post(
    "/api/v1/claims/:claimId/representative-appointments",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(AppointmentDraftRequestSchema, request.body);
      return reply
        .code(201)
        .send(await svc.createDraft(writeActorOf(request), claimId(request), body));
    },
  );
  app.get(
    "/api/v1/representative-appointments/:id",
    {
      preHandler: [READ],
      config: {
        auditRead: {
          resourceKind: "representative_appointment",
          resourceIdParam: "id",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request, reply) => {
      const found = await svc.getAppointment(actorOf(request), apptId(request));
      if (!found) throw new NotFoundError("representative appointment");
      return reply.send(found);
    },
  );
  app.patch(
    "/api/v1/representative-appointments/:id",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(AppointmentPatchRequestSchema, request.body);
      return reply.send(
        await svc.updateDraft(
          writeActorOf(request),
          apptId(request),
          body,
          ifMatchVersion(request),
        ),
      );
    },
  );
  app.put(
    "/api/v1/representative-appointments/:id/document",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(AppointmentDocumentRequestSchema, request.body);
      return reply.send(
        await svc.attachDocument(
          writeActorOf(request),
          apptId(request),
          body,
          ifMatchVersion(request),
        ),
      );
    },
  );
  app.put(
    "/api/v1/representative-appointments/:id/elements",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(AppointmentElementsRequestSchema, request.body);
      return reply.send(
        await svc.confirmElements(
          writeActorOf(request),
          apptId(request),
          body.confirmedLabels,
          ifMatchVersion(request),
        ),
      );
    },
  );

  // The SECOND person with a fresh step-up activates; the database refuses recorder = activator atomically.
  app.post(
    "/api/v1/representative-appointments/:id/activate",
    { preHandler: [VERIFY, VERIFY_STEPUP, IDEMPOTENT] },
    async (request, reply) =>
      reply.send(
        await svc.activate(writeActorOf(request), apptId(request), ifMatchVersion(request)),
      ),
  );
  // Revocation shares the permission and step-up but is never blocked by a second person.
  app.post(
    "/api/v1/representative-appointments/:id/revoke",
    { preHandler: [VERIFY, VERIFY_STEPUP, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(AppointmentRevokeRequestSchema, request.body);
      return reply.send(
        await svc.revoke(writeActorOf(request), apptId(request), body, ifMatchVersion(request)),
      );
    },
  );
}
