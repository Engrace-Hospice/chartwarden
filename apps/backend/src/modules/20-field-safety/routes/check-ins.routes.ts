// apps/backend/src/modules/20-field-safety/routes/check-ins.routes.ts — M20 (§4.1) rows 1-4: the
// clinician's own "are you OK?" surface (D2).
//
// THE CHECK-IN IS AN ATTESTATION, NOT A PING, AND THAT SHAPES ALL FOUR ROWS. D2 asks "are you OK", not
// "are you there" — which is why an M18 EVV arrival cannot close an unanswered pre-visit obligation
// (M20-T04's finding, encoded in `m20_scis_recorded_fulfilled`), why a non-`ok` status needs a ≥20-char
// note somebody will read, and why the amendment window is FIVE MINUTES and not the rest of the shift.
//
// ROW 1 IS THE ONLY WRITE IN THIS FILE WITHOUT AN `If-Match`. There is no row yet — the post either
// fulfils an obligation or stands alone (`ad_hoc`), and §2.5's optimistic concurrency has nothing to
// compare. The idempotency key is what protects a double-tapped button on one bar of signal.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { rejectOffsetPagination, requireIdempotencyKey } from "./concurrency";
import { ABAC_SELF, ABAC_SELF_OR_SUPERVISOR, P } from "./guards";
import {
  AmendCheckInBody,
  CheckInIdParams,
  CheckInListQuery,
  RecordCheckInBody,
  parse,
  parseQuery,
} from "./m20-typebox";
import type { M20ReadService } from "./read-service";
import type { M20WriteService } from "./write-service";

export interface CheckInRouteDeps {
  readonly readService: M20ReadService;
  readonly writeService: M20WriteService;
}

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();

/**
 * §4.1's Read-Audit column is `yes` on rows 2 and 4.
 *
 * A safety check-in is joinable to a visit and therefore to a served person, and its `concern_note` is
 * §3.6-denylisted free text a supervisor reads. §7.2's suppression scenario turns on precisely that read
 * being audited ("the supervisor can click for the suppression-reason text, which triggers a read-audit at
 * `info`"), so the declaration names the note explicitly rather than waving at "check-in data".
 */
const CHECK_IN_PHI = {
  resourceKind: "safety_check_in",
  fields: ["concern_note", "visit_id", "status"],
} as const;

export function registerCheckInRoutes(app: FastifyInstance, deps: CheckInRouteDeps): void {
  const { readService, writeService } = deps;

  // 1 — record a check-in. `clinician_self`: the attribution column is stamped from the SESSION
  //     (routes/actor.ts), so a caller cannot post an attestation as somebody else whatever they send.
  app.post(
    "/api/v1/safety/check-ins",
    {
      preHandler: [
        P("safety.check_in.create"),
        ABAC_SELF("safety.check_in.create", () => ({})),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const body = parse(RecordCheckInBody, request.body);
      const result = await writeService.recordCheckIn(writeActorOf(request), body);
      return reply.code(201).send(result);
    },
  );

  // 2 — read one. `clinician_self ∨ supervises_clinician`, ONE preHandler (guards.ts rule 1): ANDing the
  //     two would deny everybody, because `m20_sss_no_self_supervision` makes a supervisor who is also the
  //     subject unwritable. 404 on deny — a check-in id is 1:1 with "this clinician was at this visit".
  app.get(
    "/api/v1/safety/check-ins/:checkInId",
    {
      preHandler: [
        P("safety.check_in.read"),
        ABAC_SELF_OR_SUPERVISOR("safety.check_in.read", "checkInId", "checkInId"),
      ],
      config: { auditRead: CHECK_IN_PHI },
    },
    async (request) => {
      const { checkInId } = parse(CheckInIdParams, request.params);
      return readService.getCheckIn(actorOf(request), checkInId);
    },
  );

  // 3 — amend within the 5-minute grace. A correction is a NEW row that supersedes (§2.2.1); the original
  //     stays readable because it is what the supervisor may already have acted on.
  app.patch(
    "/api/v1/safety/check-ins/:checkInId",
    {
      preHandler: [
        P("safety.check_in.amend"),
        ABAC_SELF("safety.check_in.amend", (r) => ({
          checkInId: (r.params as Record<string, string>).checkInId,
        })),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { checkInId } = parse(CheckInIdParams, request.params);
      const body = parse(AmendCheckInBody, request.body);
      return writeService.amendCheckIn(writeActorOf(request), checkInId, body);
    },
  );

  // 4 — the clinician's own day: what she owes and what she has posted. Scoped to the SESSION's
  //     membership inside the read service, so `/me/today` cannot be pointed at a colleague.
  app.get(
    "/api/v1/safety/check-ins/me/today",
    {
      preHandler: [
        P("safety.check_in.read"),
        ABAC_SELF("safety.check_in.read", () => ({})),
        NO_OFFSET,
      ],
      config: { auditRead: CHECK_IN_PHI },
    },
    async (request) =>
      readService.getMyDay(actorOf(request), parseQuery(CheckInListQuery, request.query)),
  );
}
