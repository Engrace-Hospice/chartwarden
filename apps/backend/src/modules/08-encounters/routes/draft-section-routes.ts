// apps/backend/src/modules/08-encounters/routes/draft-section-routes.ts — the visit-note draft and its section resolution (ADR-0114, PR C2b1).
//
//   GET /api/v1/encounters/:encounterId/draft                       the draft for the SESSION viewer, every section with its state   encounter.read
//   PUT /api/v1/encounters/:encounterId/draft/sections/:sectionId   confirm or deselect one section against the content seen          encounter.author
//   GET /api/v1/encounters/:encounterId/addenda/:addendumId/draft   (PR E2, VN-D30) the draft of the SIGNED note as an amending addendum's
//                                                                   author sees it: only the sections the addendum names; the addendum's
//                                                                   author alone (403 for anyone else, an absent addendum included)    encounter.read
//   PUT /api/v1/encounters/:encounterId/addenda/:addendumId/draft/sections/:sectionId   the addendum's author confirms or deselects one   encounter.addendum_author
//
// All four also need the read key of each SOURCE domain the template's draft is compiled from: the care plan (M7), the medication orders (M12)
// and the scored scales (M9) reach the draft through seams that apply no permission check of their own, so without them a role holding only
// `encounter.read` would read goal text, medication names and scores it cannot read through those modules. Until S3 these were static
// preHandlers asking all three of every draft; the keys now follow the sources the template reads (an aide's draft reads the care plan alone),
// so the SERVICE asks them by template (`source-reads.ts`), after the switch and the tenant are known and before any source is read.
// Requiring them, rather than dropping the sections a caller lacks, keeps ONE draft per patient and visit: a section hash is never computed from
// fewer sources for one viewer than for another, so a confirmation cannot be matched against a fuller view than the one its author saw. (The
// sign recomputes the draft for the signer without these keys, which is the same full draft; only Part 2 redaction differs per viewer, by design.)
// Since S2 a recertification or face-to-face draft also reads the admission's benefit period, level of care, face-to-face and certification
// (M6), through seams with no check of their own either. M6 guards each with its own key (`election.read`, `loc.read`, `f2f.read`,
// `cti.read`), and only the service knows the template, so IT refuses 403 a caller of such an encounter who lacks one (finalize, sign and an
// addendum's finalize and sign, which recompute the draft, ask the same keys: encounters-routes.ts `permissionsOf`)
// (`assertMayReadAdmissionFacts`): the check is by template, the same for every viewer, so the one-draft rule holds and a routine visit's
// draft needs no key it did not before.
//
// Both answer 404 when the tenant has the draft switched off (the service decides, before it reads anything), and for an encounter that is not
// the caller's tenant. The viewer is the server-assembled session (roles, active membership), never request input: the draft is computed per
// reader so 42 CFR Part 2 redaction holds (VN-D10). The PUT carries the permission and ABAC chain of the selections save
// (`encounter.author`, caseload scope) with the author's own rule (`is_author`, not author-or-supervisor: the signer must be who confirmed, C2),
// minus the `If-Match` version (the section's content hash is the optimistic lock), plus the AI-principal refusal: an AI may not confirm what
// it drafted a note from. A stale hash or corpus version is 409
// `DRAFT_SECTION_STALE`; a draft that cannot be computed is 503 `DRAFT_UNAVAILABLE`.
import { requireAbac, requirePermission, resolveActorPermissions } from "@chartwarden/auth";
import {
  type PreHandler,
  actorOf,
  rejectAiActor,
  writeActorOf,
} from "@chartwarden/shared/route-kit";
import { UnauthorizedError } from "@chartwarden/types";
import type { TObject } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DraftCaller, DraftService } from "../drafting/draft-service";
import { auditContextOf } from "./audit-context";
import {
  AmendmentDraftParamsSchema,
  AmendmentSectionParamsSchema,
  DisciplinePlanElementParamsSchema,
  DraftParamsSchema,
  DraftSectionParamsSchema,
  ResolveSectionSchema,
  SetDisciplinePlanElementSchema,
} from "./draft-section-typebox";
import { parse } from "./encounters-typebox";

export interface DraftSectionRouteDeps {
  readonly service: DraftService;
}

/**
 * The caller as the service sees it: the server-assembled session plus the permissions it resolves to. The service, which knows the template,
 * decides which of the admission's read keys (M6) the draft of that template needs (`assertMayReadAdmissionFacts`).
 */
async function callerOf<Membership extends string | null>(
  request: FastifyRequest,
  actor: Pick<DraftCaller, "organizationId" | "userId" | "roles"> & {
    readonly membershipId: Membership;
  },
): Promise<DraftCaller & { readonly membershipId: Membership }> {
  // The whole request context, as `requirePermission` resolves it, so a session class that holds its permissions apart from the membership
  // (portal, funeral home) is resolved here the same way as at the route guard.
  const context = request.context;
  if (!context) throw new UnauthorizedError();
  return {
    organizationId: actor.organizationId,
    userId: actor.userId,
    roles: actor.roles,
    membershipId: actor.membershipId,
    permissions: await resolveActorPermissions(context),
  };
}

const READ = requirePermission("encounter.read") as PreHandler;
const AUTHOR = requirePermission("encounter.author") as PreHandler;
const ADDENDUM_AUTHOR = requirePermission("encounter.addendum_author") as PreHandler;
/** Only the addendum's own author resolves the sections it amends (the same predicate the addendum's selections, finalize and sign carry). */
const IS_ADDENDUM_AUTHOR = requireAbac(
  "encounter.addendum_author",
  "is_addendum_author",
) as PreHandler;
/**
 * And only the author READS that draft: it shows the sections the addendum names, which says what it amends, and a free addendum has none. Anyone
 * else, the note's author and a supervisor included, is refused 403 whether the addendum is free, amending or absent (the predicate fails closed
 * on an absent one), so the refusal cannot be probed for which addenda name sections. Their own view of the note is the note view.
 */
const IS_ADDENDUM_AUTHOR_TO_READ = requireAbac(
  "encounter.read",
  "is_addendum_author",
) as PreHandler;
const NO_AI = rejectAiActor(
  "AI principals cannot confirm or deselect a visit-note section (D13)",
) as PreHandler;
const NO_AI_ELEMENT = rejectAiActor(
  "AI principals cannot keep or leave out an element of a visit-note plan (D13)",
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
      preHandler: [READ, PARAMS_VALID(DraftParamsSchema), SCOPE_FOR("encounter.read")],
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
      return service.getDraft(await callerOf(request, actor), encounterId);
    },
  );

  app.put(
    "/api/v1/encounters/:encounterId/draft/sections/:sectionId",
    {
      preHandler: [
        AUTHOR,
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
        await callerOf(request, actor),
        encounterId,
        sectionId,
        body,
        auditContextOf(request),
      );
    },
  );
  // ── S4b (VN-D60): which of the discipline's goals and interventions a social-work or chaplain visit keeps ─────────────────────────────────
  app.get(
    "/api/v1/encounters/:encounterId/discipline-plan-elements",
    {
      preHandler: [READ, PARAMS_VALID(DraftParamsSchema), SCOPE_FOR("encounter.read")],
      config: {
        // The goal and intervention wording of the patient's plan: accountable against the patient named in the response (§164.528). Names only.
        auditRead: {
          resourceKind: "encounter_discipline_plan_elements",
          resourceIdParam: "encounterId",
          patientIdPayloadPath: "patientId",
          fields: ["elements", "elementId", "kind", "text", "kept"],
        },
      },
    },
    async (request) => {
      const { encounterId } = parse(DraftParamsSchema, request.params);
      const actor = actorOf(request);
      return service.getDisciplinePlanElements(await callerOf(request, actor), encounterId);
    },
  );

  app.put(
    "/api/v1/encounters/:encounterId/discipline-plan-elements/:elementId",
    {
      preHandler: [
        AUTHOR,
        NO_AI_ELEMENT,
        PARAMS_VALID(DisciplinePlanElementParamsSchema),
        SCOPE_FOR("encounter.author"),
        IS_AUTHOR,
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const { encounterId, elementId } = parse(DisciplinePlanElementParamsSchema, request.params);
      const body = parse(SetDisciplinePlanElementSchema, request.body);
      return service.setDisciplinePlanElement(
        await callerOf(request, actor),
        encounterId,
        elementId,
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
        PARAMS_VALID(AmendmentDraftParamsSchema),
        SCOPE_FOR("encounter.read"),
        IS_ADDENDUM_AUTHOR_TO_READ,
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
      return service.getAmendmentDraft(await callerOf(request, actor), encounterId, addendumId);
    },
  );

  app.put(
    "/api/v1/encounters/:encounterId/addenda/:addendumId/draft/sections/:sectionId",
    {
      preHandler: [
        ADDENDUM_AUTHOR,
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
        await callerOf(request, actor),
        encounterId,
        addendumId,
        sectionId,
        body,
        auditContextOf(request),
      );
    },
  );
}
