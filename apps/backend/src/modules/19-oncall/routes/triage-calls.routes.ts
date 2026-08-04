// apps/backend/src/modules/19-oncall/routes/triage-calls.routes.ts — M19 (§4.1) rows 1-14 plus the §2.7
// paper-re-entry: the triage-call surface, which is the §2.2.1 call machine driven over HTTP.
//
// EVERY STATE TRANSITION REQUIRES `If-Match` (§2.5). That is stricter than most modules, and §2.5's own
// case is why: a supervisor opens the call while the RN is answering question 4, and without the stamp the
// supervisor's disposition silently overwrites two answers — including, in the worst case, a red-flag one.
// The create routes do not require it (there is no row to have read), and neither does a list.
//
// THE PER-CALL ABAC CELL IS ONE PREDICATE CHOSEN BY SESSION CLASS (`guards.ts` `ABAC_CALL_ACTOR`), not two
// guards ANDed — see routes/guards.ts rule 1 for why ANDing them would deny every caller.
//
// ROUTE 14's THREE GATES ARE ALL DISTINCT AND ALL REQUIRED: the `triage.read_transcript` permission (not
// `triage.read`), the M2 step-up, and a per-access M4 audit row. §4.1's Notes name all three, and the
// audit declaration below is an EMISSION config rather than a waiver precisely because §8.7.2 gives the
// decrypt its own business-event row.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, rejectOffsetPagination, requireIdempotencyKey } from "./concurrency";
import {
  ABAC_CALL_ACTOR,
  ABAC_CASELOAD_OR_SCOPE,
  ABAC_IN_ORG,
  ABAC_ONCALL_ELIGIBLE,
  P,
  STEP_UP,
} from "./guards";
import {
  AbandonCallBody,
  AnswerCorrectionParams,
  ApplyProtocolBody,
  AwaitingCallbackBody,
  CorrectAnswerBody,
  DocumentCallBody,
  IdentifyPatientBody,
  ListTriageCallsQuery,
  OpenTriageCallBody,
  PaperReentryBody,
  RecordAnswerBody,
  SelectDispositionBody,
  TriageCallIdParams,
  parse,
  parseQuery,
} from "./m19-typebox";
import type { M19ReadService } from "./read-service";
import type { M19WriteService } from "./write-service";

export interface TriageCallRouteDeps {
  readonly readService: M19ReadService;
  readonly writeService: M19WriteService;
}

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();

/** The M4 read-audit declaration every PHI triage-call read carries (§8.1 / M4 §2.5). */
const CALL_READ = { resourceKind: "triage_call", resourceIdParam: "triageCallId" } as const;

export function registerTriageCallRoutes(app: FastifyInstance, deps: TriageCallRouteDeps): void {
  const { readService, writeService } = deps;

  // 1 — open a new triage call. `oncall_eligible` gates it (§4.1 row 1); the covering shift and the
  //     `source` are BOTH resolved server-side (see m19-typebox's `OpenableSource`).
  app.post(
    "/api/v1/triage-calls",
    { preHandler: [P("triage.open"), ABAC_ONCALL_ELIGIBLE("triage.open"), IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(OpenTriageCallBody, request.body);
      const created = await writeService.openTriageCall(writeActorOf(request), body);
      return reply.code(201).send(created);
    },
  );

  // 2 — the supervisor board / caseload list (cursor-paginated; `openOnly` is the §3.4 board view).
  app.get(
    "/api/v1/triage-calls",
    {
      preHandler: [P("triage.read"), ABAC_CASELOAD_OR_SCOPE("triage.read"), NO_OFFSET],
      config: { auditRead: { resourceKind: "triage_call", list: true } },
    },
    async (request) =>
      readService.listTriageCalls(
        actorOf(request),
        parseQuery(ListTriageCallsQuery, request.query),
      ),
  );

  // 3 — the full call, with answers, escalations and the state-history narrative. A VENDOR session gets
  //     the PHI-minimized projection — a different TYPE, not a filtered one (§8.3.1).
  app.get(
    "/api/v1/triage-calls/:triageCallId",
    {
      preHandler: [P("triage.read"), ABAC_CALL_ACTOR("triage.read")],
      config: { auditRead: CALL_READ },
    },
    async (request) => {
      const { triageCallId } = parse(TriageCallIdParams, request.params);
      return readService.getTriageCall(actorOf(request), triageCallId);
    },
  );

  // 4 — resolve the caller to a served person. This is the step §7.1 runs before any encounter can open:
  //     M8 requires patient AND admission NOT NULL, and both are nullable on `triage_call` until now.
  app.post(
    "/api/v1/triage-calls/:triageCallId/identify-patient",
    { preHandler: [P("triage.write"), ABAC_CALL_ACTOR("triage.write"), IDEMPOTENT] },
    async (request) => {
      const { triageCallId } = parse(TriageCallIdParams, request.params);
      const body = parse(IdentifyPatientBody, request.body);
      return writeService.identifyPatient(writeActorOf(request), triageCallId, {
        expectedVersion: ifMatchVersion(request, true),
        ...body,
      });
    },
  );

  // 5 — pin the protocol (D4) and, when the catalog row demands it, write the D7 mandatory escalation in
  //     the SAME transaction. `aiOverrideReason` is required only above the D12 confidence floor.
  app.post(
    "/api/v1/triage-calls/:triageCallId/apply-protocol",
    { preHandler: [P("triage.write"), ABAC_CALL_ACTOR("triage.write"), IDEMPOTENT] },
    async (request) => {
      const { triageCallId } = parse(TriageCallIdParams, request.params);
      const body = parse(ApplyProtocolBody, request.body);
      return writeService.applyProtocol(writeActorOf(request), triageCallId, {
        expectedVersion: ifMatchVersion(request, true),
        ...body,
      });
    },
  );

  // 6 — append one answer. `red_flag_hit` is computed SERVER-side (D5) and is deliberately absent from
  //     the request body: a client that could assert it could assert its absence.
  app.post(
    "/api/v1/triage-calls/:triageCallId/answers",
    { preHandler: [P("triage.write"), ABAC_CALL_ACTOR("triage.write"), IDEMPOTENT] },
    async (request, reply) => {
      const { triageCallId } = parse(TriageCallIdParams, request.params);
      const body = parse(RecordAnswerBody, request.body);
      const result = await writeService.recordAnswer(writeActorOf(request), triageCallId, {
        expectedVersion: ifMatchVersion(request, true),
        ...body,
      });
      return reply.code(201).send(result);
    },
  );

  // 7 — append a CORRECTION (§2.2.3 amend-by-append). The original row is preserved: a "no" later
  //     corrected to "yes" means the call HAD a red flag, and that is what a suppression investigation
  //     reads.
  app.patch(
    "/api/v1/triage-calls/:triageCallId/answers/:answerId/correct",
    { preHandler: [P("triage.write"), ABAC_CALL_ACTOR("triage.write"), IDEMPOTENT] },
    async (request) => {
      const { triageCallId, answerId } = parse(AnswerCorrectionParams, request.params);
      const body = parse(CorrectAnswerBody, request.body);
      return writeService.correctAnswer(writeActorOf(request), triageCallId, answerId, {
        expectedVersion: ifMatchVersion(request, true),
        ...body,
      });
    },
  );

  // 8 — close the walk. Both §2.3 gates run in the machine: every required question answered, and no
  //     red-flag escalation still open.
  app.post(
    "/api/v1/triage-calls/:triageCallId/complete-protocol",
    { preHandler: [P("triage.write"), ABAC_CALL_ACTOR("triage.write"), IDEMPOTENT] },
    async (request) => {
      const { triageCallId } = parse(TriageCallIdParams, request.params);
      return writeService.completeProtocol(writeActorOf(request), triageCallId, {
        expectedVersion: ifMatchVersion(request, true),
      });
    },
  );

  // 9 — park on a callback. The call stays in `TRIAGE_CALL_OPEN_STATES`, so it keeps its place on the
  //     supervisor board while the §4.8 SLA detector watches the clock.
  app.post(
    "/api/v1/triage-calls/:triageCallId/awaiting-callback",
    { preHandler: [P("triage.write"), ABAC_CALL_ACTOR("triage.write"), IDEMPOTENT] },
    async (request) => {
      const { triageCallId } = parse(TriageCallIdParams, request.params);
      const body = parse(AwaitingCallbackBody, request.body);
      return writeService.markAwaitingCallback(writeActorOf(request), triageCallId, {
        expectedVersion: ifMatchVersion(request, true),
        ...body,
      });
    },
  );

  // 10 — resume the same walk at the server's own cursor. No answer is discarded and none is re-asked.
  app.post(
    "/api/v1/triage-calls/:triageCallId/resume",
    { preHandler: [P("triage.write"), ABAC_CALL_ACTOR("triage.write"), IDEMPOTENT] },
    async (request) => {
      const { triageCallId } = parse(TriageCallIdParams, request.params);
      return writeService.resumeAfterCallback(writeActorOf(request), triageCallId, {
        expectedVersion: ifMatchVersion(request, true),
      });
    },
  );

  // 11 — select the disposition (D6). ONE route for both §2.2.1 edges into
  //      `documented_pending_encounter`: the service picks `selectDisposition` from `disposition_pending`
  //      and `resolveEscalation` from `escalated_unresolved`, so a clinician acting on the medical
  //      director's guidance at 2 a.m. does not have to know which of two routes their call is behind.
  app.post(
    "/api/v1/triage-calls/:triageCallId/disposition",
    { preHandler: [P("triage.disposition"), ABAC_CALL_ACTOR("triage.disposition"), IDEMPOTENT] },
    async (request) => {
      const { triageCallId } = parse(TriageCallIdParams, request.params);
      const body = parse(SelectDispositionBody, request.body);
      return writeService.selectDisposition(writeActorOf(request), triageCallId, {
        expectedVersion: ifMatchVersion(request, true),
        dispositionData: body.dispositionData,
      });
    },
  );

  // 12 — invoke M8's `EncounterCreator` (D8). The call does NOT reach `documented` here: that transition
  //      is the `m8.encounter.signed` consumer's, so the record advances when the encounter is SIGNED.
  app.post(
    "/api/v1/triage-calls/:triageCallId/document",
    { preHandler: [P("triage.write"), ABAC_CALL_ACTOR("triage.write"), IDEMPOTENT] },
    async (request) => {
      const { triageCallId } = parse(TriageCallIdParams, request.params);
      const body = parse(DocumentCallBody, request.body);
      return writeService.documentCall(writeActorOf(request), triageCallId, {
        expectedVersion: ifMatchVersion(request, false),
        ...body,
      });
    },
  );

  // 13 — the caller disconnected. A mandatory escalation still blocks (§2.2.4): "the caller hung up" is
  //      not an answer to "did a human respond to the suicidal-ideation page?".
  app.post(
    "/api/v1/triage-calls/:triageCallId/abandon",
    {
      preHandler: [
        P("triage.close_abandoned"),
        ABAC_CALL_ACTOR("triage.close_abandoned"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { triageCallId } = parse(TriageCallIdParams, request.params);
      const body = parse(AbandonCallBody, request.body);
      return writeService.abandonCall(writeActorOf(request), triageCallId, {
        expectedVersion: ifMatchVersion(request, true),
        ...body,
      });
    },
  );

  // 14 — decrypt the transcript. Distinct permission + step-up + a per-access M4 audit row (§8.7.2's
  //      `triage.transcript_decrypted`). A vendor session is refused inside the read service too, because
  //      this method decrypts and a decrypt with no in-agency actor behind it is §8.3.4's disclosure.
  app.get(
    "/api/v1/triage-calls/:triageCallId/transcript-decrypt",
    {
      preHandler: [
        P("triage.read_transcript"),
        ABAC_CALL_ACTOR("triage.read_transcript"),
        STEP_UP("triage.read_transcript"),
      ],
      config: {
        auditRead: { resourceKind: "triage_call_transcript", resourceIdParam: "triageCallId" },
      },
    },
    async (request) => {
      const { triageCallId } = parse(TriageCallIdParams, request.params);
      return readService.getTranscript(actorOf(request), triageCallId);
    },
  );

  // §2.7 — the BCP paper-origin re-entry. NOT in §4.1's table: §4.6 adds the `triage.paper_reentry`
  // permission with no route to spend it on, and a permission nobody can exercise is one that gets granted
  // and forgotten. Step-up is composed because §4.6 says so and because §8.3.2 lists the back-dated
  // `opened_at` as the way a coverage gap gets hidden.
  app.post(
    "/api/v1/triage-calls/paper-reentry",
    {
      preHandler: [
        P("triage.paper_reentry"),
        ABAC_IN_ORG("triage.paper_reentry"),
        STEP_UP("triage.paper_reentry"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const body = parse(PaperReentryBody, request.body);
      const created = await writeService.reenterPaperCall(writeActorOf(request), body);
      return reply.code(201).send(created);
    },
  );

  // §2.7 — the DON's outstanding re-entry worklist (what the paper-reentry route above is filed against).
  app.get(
    "/api/v1/triage-calls/paper-reentry/worklist",
    {
      preHandler: [P("triage.paper_reentry"), ABAC_IN_ORG("triage.paper_reentry")],
      config: {
        auditRead: {
          none: "outage-window scheduling metadata (shift window, expiry, assignee) — no patient, no caller, no clinical content",
        },
      },
    },
    async (request) => readService.listPaperReentryWorklist(actorOf(request)),
  );
}
