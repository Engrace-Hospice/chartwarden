// apps/backend/src/modules/05-patient/routes/allergy-routes.ts — the M5 patient allergy list (F-238;
// architecture §10.6.6 "Allergies → Module 5").
//
//   GET  /api/v1/patients/:id/allergies                                  every row, every status
//   POST /api/v1/patients/:id/allergies/:allergyId/verify                unverified → verified
//   POST /api/v1/patients/:id/allergies/:allergyId/entered-in-error      unverified|verified → entered_in_error
//
// The list returns UNVERIFIED rows (a DocLens referral line no clinician has confirmed yet) with their
// status: a prescriber must see an unverified allergy, labelled, rather than not see it. Nothing deletes a
// row; entered-in-error keeps it (with who/when/why) for the survey trail.
//
// Guards mirror the chart tabs in patient-routes.ts: `patient.read` / `patient.edit` + M7's
// `caseload_or_scope` on `:id` (404 on deny, no existence leak). The write routes refuse an AI principal
// implicitly — they need a human membership on the request context (the actor whose name the row records).
// Writes run under `withOrgContext` as the acting user, so RLS scopes them and the M4 trigger attributes
// them; a row of another patient or another tenant is a 404.
import { type GuardRequest, requireAbac, requirePermission } from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { UnauthorizedError, ChartWardenError } from "@chartwarden/types";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AllergyParamsSchema,
  EnteredInErrorAllergyBodySchema,
  VerifyAllergyBodySchema,
} from "./allergy-typebox";
import { LooseIdParamsSchema, parse } from "./patient-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const ALG = schema.patientAllergies;
const P = schema.patients;

const READ = requirePermission("patient.read") as PreHandler;
const EDIT = requirePermission("patient.edit") as PreHandler;
const chartScope = (action: string): PreHandler =>
  requireAbac(action, "caseload_or_scope", {
    getTarget: (request: GuardRequest) => ({
      patientId: (request.params as { id?: unknown } | undefined)?.id,
    }),
    notFoundOnDeny: true,
  }) as PreHandler;
const SCOPE_READ = chartScope("patient.read");
const SCOPE_EDIT = chartScope("patient.edit");

const notFound = (what: string) => new ChartWardenError("NOT_FOUND", `${what} not found`, 404);

function actorOf(request: FastifyRequest): {
  organizationId: string;
  userId: string;
  membershipId: string | null;
} {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  const m = ctx.attributes?.membershipId;
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    membershipId: typeof m === "string" && m.length > 0 ? m : null,
  };
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toView(r: typeof ALG.$inferSelect) {
  return {
    id: r.id,
    patientId: r.patientId,
    allergenText: r.allergenText,
    reaction: r.reaction,
    severity: r.severity ?? null,
    verificationStatus: r.verificationStatus,
    source: r.source,
    sourceDocumentId: r.sourceDocumentId,
    sourcePage: r.sourcePage,
    reportedByMembershipId: r.reportedByMembershipId,
    reportedAt: r.reportedAt.toISOString(),
    verifiedByMembershipId: r.verifiedByMembershipId,
    verifiedAt: iso(r.verifiedAt),
    enteredInErrorAt: iso(r.enteredInErrorAt),
  };
}

export interface PatientAllergyRouteDeps {
  readonly db: DbClient;
}

export function registerPatientAllergyRoutes(
  app: FastifyInstance,
  deps: PatientAllergyRouteDeps,
): void {
  const { db } = deps;

  app.get(
    "/api/v1/patients/:id/allergies",
    {
      preHandler: [READ, SCOPE_READ],
      config: {
        auditRead: {
          resourceKind: "patient",
          patientIdParam: "id",
          fields: ["allergies"],
        },
      },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      return withOrgContext(db, { organizationId, userId }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [patient] = await tx.select({ id: P.id }).from(P).where(eq(P.id, id)).limit(1);
        if (!patient) throw notFound("patient");
        const rows = await tx
          .select()
          .from(ALG)
          .where(eq(ALG.patientId, id))
          .orderBy(asc(ALG.reportedAt), asc(ALG.id));
        return { allergies: rows.map(toView) };
      });
    },
  );

  /** Load the row under the patient in the path, or 404 (another patient's / tenant's row is not found). */
  async function loadForUpdate(tx: DbClient, patientId: string, allergyId: string) {
    const [row] = await tx
      .select()
      .from(ALG)
      .where(and(eq(ALG.id, allergyId), eq(ALG.patientId, patientId)))
      .for("update")
      .limit(1);
    if (!row) throw notFound("allergy");
    return row;
  }

  app.post(
    "/api/v1/patients/:id/allergies/:allergyId/verify",
    { preHandler: [EDIT, SCOPE_EDIT] },
    async (request) => {
      const { organizationId, userId, membershipId } = actorOf(request);
      if (!membershipId) throw new UnauthorizedError();
      const { id, allergyId } = parse(AllergyParamsSchema, request.params);
      const body = parse(VerifyAllergyBodySchema, request.body);
      return withOrgContext(db, { organizationId, userId }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const row = await loadForUpdate(tx, id, allergyId);
        if (row.verificationStatus !== "unverified") {
          throw new ChartWardenError(
            "ALLERGY_NOT_UNVERIFIED",
            `allergy is ${row.verificationStatus}; only an unverified allergy can be verified`,
            409,
          );
        }
        const now = new Date();
        const [updated] = await tx
          .update(ALG)
          .set({
            verificationStatus: "verified",
            verifiedByMembershipId: membershipId,
            verifiedAt: now,
            ...(body.reaction !== undefined ? { reaction: body.reaction } : {}),
            ...(body.severity !== undefined ? { severity: body.severity } : {}),
            updatedAt: now,
          })
          .where(eq(ALG.id, allergyId))
          .returning();
        if (!updated) throw notFound("allergy");
        return toView(updated);
      });
    },
  );

  app.post(
    "/api/v1/patients/:id/allergies/:allergyId/entered-in-error",
    { preHandler: [EDIT, SCOPE_EDIT] },
    async (request) => {
      const { organizationId, userId, membershipId } = actorOf(request);
      if (!membershipId) throw new UnauthorizedError();
      const { id, allergyId } = parse(AllergyParamsSchema, request.params);
      const body = parse(EnteredInErrorAllergyBodySchema, request.body);
      return withOrgContext(db, { organizationId, userId }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const row = await loadForUpdate(tx, id, allergyId);
        if (row.verificationStatus === "entered_in_error") {
          throw new ChartWardenError(
            "ALLERGY_ALREADY_ENTERED_IN_ERROR",
            "allergy is already marked entered-in-error",
            409,
          );
        }
        const now = new Date();
        const [updated] = await tx
          .update(ALG)
          .set({
            verificationStatus: "entered_in_error",
            enteredInErrorByMembershipId: membershipId,
            enteredInErrorAt: now,
            enteredInErrorReason: body.reason.trim(),
            updatedAt: now,
          })
          .where(eq(ALG.id, allergyId))
          .returning();
        if (!updated) throw notFound("allergy");
        return toView(updated);
      });
    },
  );
}
