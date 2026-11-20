// apps/backend/src/modules/08-encounters/findings/findings-routes.ts — WF09: the visit findings routes of module 8.
//
//   GET /api/v1/encounters/:encounterId/adl             the ADL record, or null              encounter.read
//   PUT /api/v1/encounters/:encounterId/adl             replace the ADL record               vitals.author
//   GET /api/v1/encounters/:encounterId/nutrition       the nutrition record, or null        encounter.read
//   PUT /api/v1/encounters/:encounterId/nutrition       replace the nutrition record         vitals.author
//   GET /api/v1/encounters/:encounterId/weight-history  { current, prior, history }          encounter.read
//
// Concurrency: a PUT replaces the whole record, so every GET and PUT answers the record's `version` (also as the `ETag` header; 0
// when none is recorded) and a PUT accepts an OPTIONAL `If-Match: <version>`. Absent, the PUT behaves as before; present and no
// longer current, it is 409 STALE_VERSION and writes nothing (the convention of `optionalIfMatchVersionOf` in the route kit).
// The writes are a clinician's act: an AI principal is refused (403, D13).
//
// The guards are the vitals routes' own: a read is `encounter.read` behind the `encounter.scope` caseload predicate, a write is
// `vitals.author` (ADLs, nutrition and weight are per-visit measurements recorded like vitals, so they share the key) behind
// `encounter.scope` and `is_author_or_supervisor`. The vitals route file keeps those constants private, so they are rebuilt here
// from the same exported building blocks. Org and actor come from the server-assembled request context, never the body.
import { requireAbac, requirePermission } from "@chartwarden/auth";
import { ADL_ITEMS } from "@chartwarden/hearthnote";
import {
  type PreHandler,
  membershipActorOf,
  optionalIfMatchVersionOf,
  parse,
  rejectAiActor,
} from "@chartwarden/shared/route-kit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { FindingsService } from "./findings-service";
import {
  FindingsAdlInputSchema,
  FindingsEncounterParamsSchema,
  FindingsNutritionInputSchema,
  parseBody,
} from "./findings-typebox";

export interface FindingsRouteDeps {
  readonly service: FindingsService;
}

const READ = requirePermission("encounter.read") as PreHandler;
const AUTHOR = requirePermission("vitals.author") as PreHandler;

/** A malformed encounter id is a 422 BEFORE the scope predicate resolves it (a non-uuid would otherwise reach a uuid cast). */
const PARAMS_UUID = (async (request: FastifyRequest) => {
  parse(FindingsEncounterParamsSchema, request.params);
}) as unknown as PreHandler;

// `notFoundOnDeny`: an out-of-caseload or cross-tenant encounter reads the same as an absent one (the platform's non-leak rule).
const SCOPE_FOR = (action: string): PreHandler =>
  requireAbac(action, "encounter.scope", { notFoundOnDeny: true }) as PreHandler;
const IS_AUTHOR_OR_SUPERVISOR = (action: string): PreHandler =>
  requireAbac(action, "is_author_or_supervisor") as PreHandler;

const READ_GUARDS = [READ, PARAMS_UUID, SCOPE_FOR("encounter.read")];
const NO_AI = rejectAiActor(
  "AI principals cannot record a visit's ADLs or nutrition (a clinician's finding)",
) as PreHandler;
const WRITE_GUARDS = [
  NO_AI,
  AUTHOR,
  PARAMS_UUID,
  SCOPE_FOR("vitals.author"),
  IS_AUTHOR_OR_SUPERVISOR("vitals.author"),
];

const encounterIdOf = (request: FastifyRequest): string =>
  parse(FindingsEncounterParamsSchema, request.params).encounterId;

/**
 * The `GET` read-audit configs: the encounter id is the resource id; field NAMES only, never values. The patient comes from the
 * response (`patientId`, which every view carries), so the read is attributed to the patient in the §164.528 accounting. A record
 * that does not exist yet answers `null`, which discloses nothing and so names no patient.
 */
const readAudit = (resourceKind: string, fields: readonly string[]) => ({
  auditRead: {
    resourceKind,
    resourceIdParam: "encounterId",
    patientIdPayloadPath: "patientId",
    fields,
  },
});

/** The record's version as the `ETag` header (a strong, quoted integer; `If-Match` takes it back, quotes or not). */
function withEtag<T extends { readonly version: number } | null>(
  reply: FastifyReply,
  record: T,
): T {
  reply.header("etag", `"${record?.version ?? 0}"`);
  return record;
}

export function registerFindingsRoutes(app: FastifyInstance, deps: FindingsRouteDeps): void {
  const { service } = deps;

  app.get(
    "/api/v1/encounters/:encounterId/adl",
    {
      preHandler: READ_GUARDS,
      config: readAudit("encounter_adl", [...ADL_ITEMS, "bladder", "bowel", "devices"]),
    },
    async (request, reply) => {
      const { organizationId } = membershipActorOf(request);
      return withEtag(reply, await service.getAdl(organizationId, encounterIdOf(request)));
    },
  );

  app.put(
    "/api/v1/encounters/:encounterId/adl",
    { preHandler: WRITE_GUARDS },
    async (request, reply) => {
      const { organizationId, userId: actorMembershipId } = membershipActorOf(request);
      const body = parseBody(FindingsAdlInputSchema, request.body);
      const ifMatch = optionalIfMatchVersionOf(request);
      return withEtag(
        reply,
        await service.putAdl(
          organizationId,
          encounterIdOf(request),
          body,
          actorMembershipId,
          ifMatch,
        ),
      );
    },
  );

  app.get(
    "/api/v1/encounters/:encounterId/nutrition",
    {
      preHandler: READ_GUARDS,
      config: readAudit("encounter_nutrition", [
        "appetite",
        "mealIntakePercent",
        "fluidIntake",
        "swallowing",
        "support",
      ]),
    },
    async (request, reply) => {
      const { organizationId } = membershipActorOf(request);
      return withEtag(reply, await service.getNutrition(organizationId, encounterIdOf(request)));
    },
  );

  app.put(
    "/api/v1/encounters/:encounterId/nutrition",
    { preHandler: WRITE_GUARDS },
    async (request, reply) => {
      const { organizationId, userId: actorMembershipId } = membershipActorOf(request);
      const body = parseBody(FindingsNutritionInputSchema, request.body);
      const ifMatch = optionalIfMatchVersionOf(request);
      return withEtag(
        reply,
        await service.putNutrition(
          organizationId,
          encounterIdOf(request),
          body,
          actorMembershipId,
          ifMatch,
        ),
      );
    },
  );

  // Weight is a vitals measurement, so reading its history is a read of `vitals` (the vitals GET's own audit kind).
  app.get(
    "/api/v1/encounters/:encounterId/weight-history",
    {
      preHandler: READ_GUARDS,
      config: readAudit("vitals", ["weight", "weightUnit"]),
    },
    async (request) => {
      const { organizationId } = membershipActorOf(request);
      return service.getWeightHistory(organizationId, encounterIdOf(request));
    },
  );
}
