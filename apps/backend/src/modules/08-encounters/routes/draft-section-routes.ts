// apps/backend/src/modules/08-encounters/routes/draft-section-routes.ts — the visit-note draft and its section resolution (ADR-0114, PR C2b1).
//
//   GET /api/v1/encounters/:encounterId/draft                       the draft for the SESSION viewer, every section with its state   encounter.read
//   PUT /api/v1/encounters/:encounterId/draft/sections/:sectionId   confirm or deselect one section against the content seen          encounter.author
//   GET /api/v1/encounters/:encounterId/addenda/:addendumId/draft   (PR E2, VN-D30) the draft of the SIGNED note as an amending addendum's
//                                                                   author sees it: only the sections the addendum names               encounter.read
//   PUT /api/v1/encounters/:encounterId/addenda/:addendumId/draft/sections/:sectionId   the addendum's author confirms or deselects one   encounter.addendum_author
//
// Both also need the read key of each SOURCE domain the draft is compiled from (SOURCE_DOMAIN_READS): the care plan (M7), the medication
// orders (M12) and the scored scales (M9) reach the draft through seams that apply no permission check of their own, so without them a role
// holding only `encounter.read` would read goal text, medication names and scores it cannot read through those modules. Requiring them on the
// route, rather than dropping the sections a caller lacks, keeps ONE draft per patient and visit: a section hash is never computed from fewer
// sources for one viewer than for another, so a confirmation cannot be matched against a fuller view than the one its author saw. (The sign
// recomputes the draft for the signer without these keys, which is the same full draft; only Part 2 redaction differs per viewer, by design.)
//
// Both answer 404 when the tenant has the draft switched off (the service decides, before it reads anything), and for an encounter that is not
// the caller's tenant. The viewer is the server-assembled session (roles, active membership), never request input: the draft is computed per
// reader so 42 CFR Part 2 redaction holds (VN-D10). The PUT carries the permission and ABAC chain of the selections save
// (`encounter.author`, caseload scope) with the author's own rule (`is_author`, not author-or-supervisor: the signer must be who confirmed, C2),
// minus the `If-Match` version (the section's content hash is the optimistic lock), plus the AI-principal refusal: an AI may not confirm what
// it drafted a note from. A stale hash or corpus version is 409
// `DRAFT_SECTION_STALE`; a draft that cannot be computed is 503 `DRAFT_UNAVAILABLE`.
import { requireAbac, requirePermission } from "@chartwarden/auth";
import {
  type PreHandler,
  actorOf,
  rejectAiActor,
  writeActorOf,
} from "@chartwarden/shared/route-kit";
import type { TObject } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DraftService } from "../drafting/draft-service";
import { auditContextOf } from "./audit-context";
import {
  AmendmentDraftParamsSchema,
  AmendmentSectionParamsSchema,
  DraftParamsSchema,
  DraftSectionParamsSchema,
  ResolveSectionSchema,
} from "./draft-section-typebox";
import { parse } from "./encounters-typebox";

export interface DraftSectionRouteDeps {
  readonly service: DraftService;
}

/** The sibling routes' read keys: M7 `GET /care-plan/...`, M12 `GET /medication-orders`, M9 `GET /patients/:id/scales/:type/series`. */
const SOURCE_DOMAIN_READS = ["care_plan.read", "prescribing.read", "assessment.read_trend"].map(
  (key) => requirePermission(key) as PreHandler,
);
const READ = requirePermission("encounter.read") as PreHandler;
const AUTHOR = requirePermission("encounter.author") as PreHandler;
const ADDENDUM_AUTHOR = requirePermission("encounter.addendum_author") as PreHandler;
/** Only the addendum's own author resolves the sections it amends (the same predicate the addendum's selections, finalize and sign carry). */
const IS_ADDENDUM_AUTHOR = requireAbac(
  "encounter.addendum_author",
  "is_addendum_author",
) as PreHandler;
const NO_AI = rejectAiActor(
  "AI principals cannot confirm or deselect a visit-note section (D13)",
) as PreHandler;
// The same `encounter.scope` caseload guard the selections routes carry; `notFoundOnDeny` keeps a cross-tenant or out-of-caseload denial
// the same answer as an absent encounter.
const SCOPE_FOR = (action: string): PreHandler =>
  requireAbac(action, "encounter.scope", { notFoundOnDeny: true }) as PreHandler;
/**
 * Confirming a section is the AUTHOR's act, a supervisor's included (C2): the note is signed by its author alone, and the sign refuses a note
 * the signer has not resolved, so a confirmation by anyone else would let the author sign a draft they never opened. (The addendum's PUT
 * carries `is_addendum_author` for the same reason.) A supervisor reads the draft; they do not confirm it for the author.
 */
const IS_AUTHOR = requireAbac("encounter.author", "is_author") as PreHandler;
/** A malformed id is a 422 BEFORE the scope predicate casts it to a uuid (that cast would be a 500). */
const PARAMS_VALID = (schema: TObject): PreHandler =>
  (async (request: FastifyRequest) => {
    parse(schema, request.params);
  }) as unknown as PreHandler;

export function registerDraftSectionRoutes(
  app: FastifyInstance,
  deps: DraftSectionRouteDeps,
): void {
  const { service } = deps;

  app.get(
    "/api/v1/encounters/:encounterId/draft",
    {
      preHandler: [
        READ,
        ...SOURCE_DOMAIN_READS,
        PARAMS_VALID(DraftParamsSchema),
        SCOPE_FOR("encounter.read"),
      ],
      config: {
        // A chart open of the patient's own record: accountable against the patient named in the response (§164.528). Names only.
        auditRead: {
          resourceKind: "encounter_draft",
          resourceIdParam: "encounterId",
          patientIdPayloadPath: "patientId",
          fields: [
            "sections",
            "state",
            "text",
            "contentHash",
            "corpusVersion",
            "part2Derived",
            "origins",
          ],
        },
      },
    },
    async (request) => {
      const { encounterId } = parse(DraftParamsSchema, request.params);
      const actor = actorOf(request);
      return service.getDraft(
        {
          organizationId: actor.organizationId,
          userId: actor.userId,
          roles: actor.roles,
          membershipId: actor.membershipId,
        },
        encounterId,
      );
    },
  );

  app.put(
    "/api/v1/encounters/:encounterId/draft/sections/:sectionId",
    {
      preHandler: [
        AUTHOR,
        ...SOURCE_DOMAIN_READS,
        NO_AI,
        PARAMS_VALID(DraftSectionParamsSchema),
        SCOPE_FOR("encounter.author"),
        IS_AUTHOR,
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const { encounterId, sectionId } = parse(DraftSectionParamsSchema, request.params);
      const body = parse(ResolveSectionSchema, request.body);
      return service.resolveSection(
        {
          organizationId: actor.organizationId,
          userId: actor.userId,
          roles: actor.roles,
          membershipId: actor.membershipId,
        },
        encounterId,
        sectionId,
        body,
        auditContextOf(request),
      );
    },
  );
  // ── PR E2 (VN-D30): amending a signed note through the addendum path ─────────────────────────────────────────────────────────────────
  app.get(
    "/api/v1/encounters/:encounterId/addenda/:addendumId/draft",
    {
      preHandler: [
        READ,
        ...SOURCE_DOMAIN_READS,
        PARAMS_VALID(AmendmentDraftParamsSchema),
        SCOPE_FOR("encounter.read"),
      ],
      config: {
        auditRead: {
          resourceKind: "encounter_amendment_draft",
          resourceIdParam: "addendumId",
          patientIdPayloadPath: "patientId",
          fields: [
            "sections",
            "state",
            "text",
            "contentHash",
            "corpusVersion",
            "part2Derived",
            "origins",
          ],
        },
      },
    },
    async (request) => {
      const { encounterId, addendumId } = parse(AmendmentDraftParamsSchema, request.params);
      const actor = actorOf(request);
      return service.getAmendmentDraft(
        {
          organizationId: actor.organizationId,
          userId: actor.userId,
          roles: actor.roles,
          membershipId: actor.membershipId,
        },
        encounterId,
        addendumId,
      );
    },
  );

  app.put(
    "/api/v1/encounters/:encounterId/addenda/:addendumId/draft/sections/:sectionId",
    {
      preHandler: [
        ADDENDUM_AUTHOR,
        ...SOURCE_DOMAIN_READS,
        NO_AI,
        PARAMS_VALID(AmendmentSectionParamsSchema),
        SCOPE_FOR("encounter.addendum_author"),
        IS_ADDENDUM_AUTHOR,
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const { encounterId, addendumId, sectionId } = parse(
        AmendmentSectionParamsSchema,
        request.params,
      );
      const body = parse(ResolveSectionSchema, request.body);
      return service.resolveAmendmentSection(
        {
          organizationId: actor.organizationId,
          userId: actor.userId,
          roles: actor.roles,
          membershipId: actor.membershipId,
        },
        encounterId,
        addendumId,
        sectionId,
        body,
        auditContextOf(request),
      );
    },
  );
}
