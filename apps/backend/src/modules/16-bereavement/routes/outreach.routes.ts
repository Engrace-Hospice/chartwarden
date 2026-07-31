// apps/backend/src/modules/16-bereavement/routes/outreach.routes.ts — M16 (§4.1) routes 20–25: the
// per-touchpoint §2.4 lifecycle.
//
// The `bereavement_outreach` row is the scheduled future INTENT; `bereavement_contact_log` is the record
// that the touchpoint happened (or didn't). That split is why one outreach ("mail the anniversary letter")
// can produce three contact-log rows — one per addressee — all referencing a single M22-rendered document,
// and it is why `complete` writes BOTH.
//
// D15 lives on route 21: `in_person_visit` is the ONLY kind backed by an M8 encounter, and every other kind
// must NOT carry a `source_encounter_id`. Both directions are DB CHECKs on the contact log as well; the
// TypeBox union plus the §2.4 guard turn the constraint into a 422 with a code the UI can render, instead
// of a raw PG violation surfacing at the end of a long transaction.
//
// Route 19 (the plan's touchpoint LIST) lives in `./plans.routes.ts` because it is plan-scoped; everything
// here addresses one `:outreachId`.
import type { FastifyInstance } from "fastify";
import { writeActorOf } from "./actor";
import { ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { ABAC_WINDOW_OUTREACH, P } from "./guards";
import {
  CancelOutreachBody,
  CompleteOutreachBody,
  LateAttemptBody,
  OutreachOutcomeBody,
  OutreachParams,
  StartOutreachBody,
  parse,
} from "./m16-typebox";
import type { M16WriteService } from "./write-service";

export interface OutreachRouteDeps {
  readonly writeService: M16WriteService;
}

const IDEMPOTENT = requireIdempotencyKey();

export function registerBereavementOutreachRoutes(
  app: FastifyInstance,
  deps: OutreachRouteDeps,
): void {
  const { writeService } = deps;

  // 20 — scheduled → in_progress (the counselor picks up the phone / opens the M8 draft / queues the M22
  //      letter). §4.1 scopes it to "self-assigned or counselor", which the window predicate already is.
  app.post(
    "/api/v1/bereavement/outreach/:outreachId/start",
    {
      preHandler: [
        P("bereavement.outreach.start"),
        ABAC_WINDOW_OUTREACH("bereavement.outreach.start"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { outreachId } = parse(OutreachParams, request.params);
      parse(StartOutreachBody, request.body);
      return writeService.startOutreach(writeActorOf(request), outreachId, ifMatchVersion(request));
    },
  );

  // 21 — in_progress → completed. Writes the `bereavement_contact_log` row in the SAME transaction, which
  //      is what makes §2.4's "completion means at least one contact-log row exists" guard true by
  //      construction rather than by convention.
  app.post(
    "/api/v1/bereavement/outreach/:outreachId/complete",
    {
      preHandler: [
        P("bereavement.outreach.complete"),
        ABAC_WINDOW_OUTREACH("bereavement.outreach.complete"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { outreachId } = parse(OutreachParams, request.params);
      const body = parse(CompleteOutreachBody, request.body);
      return writeService.completeOutreach(writeActorOf(request), outreachId, {
        expectedVersion: ifMatchVersion(request, true),
        ...body,
      });
    },
  );

  // 22 — the survivor declined THIS touchpoint. Not an opt-out: the forward schedule continues untouched,
  //      and no plan-level D6 evaluation runs.
  app.post(
    "/api/v1/bereavement/outreach/:outreachId/decline",
    {
      preHandler: [
        P("bereavement.outreach.complete"),
        ABAC_WINDOW_OUTREACH("bereavement.outreach.complete"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { outreachId } = parse(OutreachParams, request.params);
      const body = parse(OutreachOutcomeBody, request.body);
      return writeService.declineOutreach(writeActorOf(request), outreachId, {
        expectedVersion: ifMatchVersion(request, true),
        ...body,
      });
    },
  );

  // 23 — no response after retries. Feeds the §2.3 three-strikes `markUnreachable` proposal.
  app.post(
    "/api/v1/bereavement/outreach/:outreachId/no-response",
    {
      preHandler: [
        P("bereavement.outreach.complete"),
        ABAC_WINDOW_OUTREACH("bereavement.outreach.complete"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { outreachId } = parse(OutreachParams, request.params);
      const body = parse(OutreachOutcomeBody, request.body);
      return writeService.noResponseOutreach(writeActorOf(request), outreachId, {
        expectedVersion: ifMatchVersion(request, true),
        ...body,
      });
    },
  );

  // 24 — cancel a scheduled touchpoint (a reason is mandatory, §2.4).
  app.post(
    "/api/v1/bereavement/outreach/:outreachId/cancel",
    {
      preHandler: [
        P("bereavement.outreach.cancel"),
        ABAC_WINDOW_OUTREACH("bereavement.outreach.cancel"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { outreachId } = parse(OutreachParams, request.params);
      const body = parse(CancelOutreachBody, request.body);
      return writeService.cancelOutreach(writeActorOf(request), outreachId, {
        expectedVersion: ifMatchVersion(request, true),
        ...body,
      });
    },
  );

  // 25 — missed → in_progress inside the 7-day late grace. Audit-flagged, but NOT a compliance failure:
  //      §2.4 gives the counselor the grace window, and treating a late attempt as a miss would report a
  //      failure the agency actually prevented.
  app.post(
    "/api/v1/bereavement/outreach/:outreachId/late-attempt",
    {
      preHandler: [
        P("bereavement.outreach.late_attempt"),
        ABAC_WINDOW_OUTREACH("bereavement.outreach.late_attempt"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { outreachId } = parse(OutreachParams, request.params);
      parse(LateAttemptBody, request.body);
      return writeService.lateAttemptOutreach(writeActorOf(request), outreachId, {
        expectedVersion: ifMatchVersion(request, true),
      });
    },
  );
}
