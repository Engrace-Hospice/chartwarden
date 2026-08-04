// apps/backend/src/modules/19-oncall/routes/escalations.routes.ts — M19 (§4.1) rows 15-18: the D7
// escalation ladder over HTTP.
//
// THE INBOX AND THE ROW USE DIFFERENT PREDICATES, and that is §4.7's own split: `escalation_recipient_scope`
// asks "does this actor sit on ANY tier?" (there is no row yet — the downstream filter narrows what they
// see), while `escalation_recipient` asks "is this actor the party THIS page went to?".
//
// `notFoundOnDeny` IS OFF ON BOTH ROW ROUTES — the opposite of the per-call posture next door. A triage
// call id maps 1:1 to "this patient rang the after-hours line" and so hides behind a 404; an ESCALATION id
// discloses nothing to a caller who already holds `triage.read_escalations`, and "not yours" is the answer
// a supervisor scanning a shared inbox actually needs. A 404 would send them hunting for a page that is
// sitting in a colleague's queue.
//
// ROUTE 18 IS WHERE A MANDATORY ROW CAN REACH `resolved` AND THE ONLY PLACE (§2.2.4). A call close may
// auto-resolve an acknowledged non-mandatory row; the four D7 protocols' rows need this explicit write by
// the escalated party, because the whole point is that the agency can prove a named human answered.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, rejectOffsetPagination, requireIdempotencyKey } from "./concurrency";
import { ABAC_CALL_ACTOR, ABAC_ESCALATION_RECIPIENT, ABAC_ESCALATION_SCOPE, P } from "./guards";
import {
  AcknowledgeEscalationBody,
  EscalateBody,
  EscalationIdParams,
  ListEscalationsQuery,
  ResolveEscalationBody,
  TriageCallIdParams,
  parse,
  parseQuery,
} from "./m19-typebox";
import type { M19ReadService } from "./read-service";
import type { M19WriteService } from "./write-service";

export interface EscalationRouteDeps {
  readonly readService: M19ReadService;
  readonly writeService: M19WriteService;
}

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();

export function registerEscalationRoutes(app: FastifyInstance, deps: EscalationRouteDeps): void {
  const { readService, writeService } = deps;

  // 15 — manual escalation on a call. Gated by the CALL's predicate (it is a write ON the call), not by
  //      the escalation ones: the actor raising the page is the clinician working the call, and §7.5's
  //      vendor operator escalating to the agency reaches it through the same route.
  app.post(
    "/api/v1/triage-calls/:triageCallId/escalations",
    { preHandler: [P("triage.escalate"), ABAC_CALL_ACTOR("triage.escalate"), IDEMPOTENT] },
    async (request, reply) => {
      const { triageCallId } = parse(TriageCallIdParams, request.params);
      const body = parse(EscalateBody, request.body);
      const created = await writeService.escalate(writeActorOf(request), triageCallId, {
        expectedVersion: ifMatchVersion(request, body.handOffCall === true),
        ...body,
      });
      return reply.code(201).send(created);
    },
  );

  // 16 — the escalation inbox, per the actor's tier band. `openOnly` defaults TRUE in the read service:
  //      an inbox shows what is outstanding, and a resolved page is history.
  app.get(
    "/api/v1/escalations",
    {
      preHandler: [
        P("triage.read_escalations"),
        ABAC_ESCALATION_SCOPE("triage.read_escalations"),
        NO_OFFSET,
      ],
      config: { auditRead: { resourceKind: "triage_escalation", list: true } },
    },
    async (request) =>
      readService.listEscalations(
        actorOf(request),
        parseQuery(ListEscalationsQuery, request.query),
      ),
  );

  // 17 — acknowledge. This is the write §7.2 waits on: until it lands, the call may take no disposition
  //      other than `escalateUnresolved`.
  app.post(
    "/api/v1/escalations/:escalationId/acknowledge",
    {
      preHandler: [
        P("triage.escalation_ack"),
        ABAC_ESCALATION_RECIPIENT("triage.escalation_ack"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { escalationId } = parse(EscalationIdParams, request.params);
      parse(AcknowledgeEscalationBody, request.body);
      return writeService.acknowledgeEscalation(writeActorOf(request), escalationId, {
        expectedVersion: ifMatchVersion(request, true),
      });
    },
  );

  // 18 — resolve, with the escalated party's own account of what was decided (§4.1: ≥ 30 chars). The
  //      resolution text is §3.6-denylisted, so it is read off the row under ABAC and never out of an
  //      audit log.
  app.post(
    "/api/v1/escalations/:escalationId/resolve",
    {
      preHandler: [
        P("triage.escalation_resolve"),
        ABAC_ESCALATION_RECIPIENT("triage.escalation_resolve"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { escalationId } = parse(EscalationIdParams, request.params);
      const body = parse(ResolveEscalationBody, request.body);
      return writeService.resolveEscalation(writeActorOf(request), escalationId, {
        expectedVersion: ifMatchVersion(request, true),
        ...body,
      });
    },
  );
}
