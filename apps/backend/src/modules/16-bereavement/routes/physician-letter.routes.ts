// apps/backend/src/modules/16-bereavement/routes/physician-letter.routes.ts — M16 (ADR-0109 D6) routes 38 / 39 / 40: the physician
// condolence letter review queue.
//
// The letter goes to the patient's INTERNAL attending clinician and a human approves it before anything is disclosed, so every route
// is bereavement oversight only: `bereavement.letter.read` / `bereavement.letter.review` plus `org_scope_bereavement_oversight`. Approve
// and decline are state transitions: `If-Match` is required (428 without it, 412 on a stale version) and so is `Idempotency-Key`.
// Approve may carry a personal note (at most 1000 characters, sealed at rest) and the internal clinician when the care team resolved
// none; it emits `m16.bereavement.document_requested` in the same transaction. Every PHI read declares its M4 read audit.
import { NotFoundError } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, rejectOffsetPagination, requireIdempotencyKey } from "./concurrency";
import { ABAC_OVERSIGHT, P } from "./guards";
import type { M16LetterService } from "./letter-service";
import {
  ApproveLetterBody,
  DeclineLetterBody,
  LetterParams,
  PhysicianLetterListQuerySchema,
  PlanParams,
  parse,
  parseQuery,
} from "./m16-typebox";

export interface LetterRouteDeps {
  readonly letterService: M16LetterService;
}

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();

export function registerBereavementPhysicianLetterRoutes(
  app: FastifyInstance,
  deps: LetterRouteDeps,
): void {
  const { letterService } = deps;

  // 38 — the review queue (`?status=`, oldest due first, cursor-paginated).
  app.get(
    "/api/v1/bereavement/physician-letters",
    {
      preHandler: [
        P("bereavement.letter.read"),
        ABAC_OVERSIGHT("bereavement.letter.read"),
        NO_OFFSET,
      ],
      config: { auditRead: { resourceKind: "bereavement_physician_letter", list: true } },
    },
    async (request) =>
      letterService.listLetters(
        actorOf(request),
        parseQuery(PhysicianLetterListQuerySchema, request.query),
      ),
  );

  // 38 — the plan's letter (404 when the plan has none: a plan opened before letters existed).
  app.get(
    "/api/v1/bereavement/plans/:planId/physician-letter",
    {
      preHandler: [P("bereavement.letter.read"), ABAC_OVERSIGHT("bereavement.letter.read")],
      config: { auditRead: { resourceKind: "bereavement_plan", resourceIdParam: "planId" } },
    },
    async (request) => {
      const { planId } = parse(PlanParams, request.params);
      const letter = await letterService.getLetterForPlan(actorOf(request), planId);
      if (!letter) throw new NotFoundError("physician letter not found");
      return letter;
    },
  );

  // 39 — approve (`pending_review -> approved`) and request the render in the same transaction.
  app.post(
    "/api/v1/bereavement/physician-letters/:letterId/approve",
    {
      preHandler: [
        P("bereavement.letter.review"),
        ABAC_OVERSIGHT("bereavement.letter.review"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { letterId } = parse(LetterParams, request.params);
      const body = parse(ApproveLetterBody, request.body);
      return letterService.approveLetter(writeActorOf(request), letterId, {
        ...body,
        expectedVersion: ifMatchVersion(request, true) as number,
      });
    },
  );

  // 40 — decline (`pending_review -> declined`) with a documented reason.
  app.post(
    "/api/v1/bereavement/physician-letters/:letterId/decline",
    {
      preHandler: [
        P("bereavement.letter.review"),
        ABAC_OVERSIGHT("bereavement.letter.review"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { letterId } = parse(LetterParams, request.params);
      const body = parse(DeclineLetterBody, request.body);
      return letterService.declineLetter(writeActorOf(request), letterId, {
        ...body,
        expectedVersion: ifMatchVersion(request, true) as number,
      });
    },
  );
}
