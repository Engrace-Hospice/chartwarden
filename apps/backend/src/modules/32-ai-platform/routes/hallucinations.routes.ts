// apps/backend/src/modules/32-ai-platform/routes/hallucinations.routes.ts — §4.1 rows R18-R20: D9's
// report → triage loop, and §5.5's widget's server half.
//
// R18 IS THE ONLY WRITE IN THIS MODULE A CLINICIAN MAKES. §4.6 grants `ai.hallucination.report` to all
// clinical roles, and §5.5 puts the button beside every AI-enhanced surface, because a fabrication that
// nobody can report is a fabrication the platform cannot learn about. Everything else here is the AI
// Safety Owner's.
//
// ── THE NARRATIVE IS ENCRYPTED OR THE REPORT IS REFUSED ────────────────────────────────────────────
//
// `ai_hallucination_report.reporter_narrative_cipher` is NOT NULL, §3.4-denylisted and DEK-enveloped
// (§3.6). No module on this platform binds a per-tenant DEK envelope yet, so with the cipher port unbound
// R18 refuses with 503 `AI_REPORT_CIPHER_UNBOUND` — the M20 incident-create posture, and for the same
// reason: writing prose in the clear into a column named `_cipher` would make the §3.7 erasure report a
// destruction that never happened. The clinician sees a real refusal with a real cause rather than a
// report that silently stored her words unprotected.
//
// A NOTE ON WHAT THAT COSTS AND WHY IT IS STILL RIGHT. M20's SOS press deliberately does NOT refuse for
// the same missing key, because refusing a call for help is the one failure that module must not have. A
// hallucination report is not a call for help: the AI output is already on the clinician's screen, she can
// discard it, and the report is the platform's learning signal rather than her escape hatch. The two
// modules answer the same missing key differently on purpose.
//
// ── §5.5's WIDGET IS NOT BUILT THIS WAVE, AND THIS IS THE CONTRACT IT WILL CALL ─────────────────────
//
// §5.5 specifies an `AIReportButton` exported from `packages/ai-platform-ui`. M32's manifest `codePaths`
// are `packages/ai-platform` + `apps/backend/src/modules/32-ai-platform` — no web slice and no UI package
// — so the widget is out of this module's tree (the plan's module header is the authoritative codePaths
// list; the M19 `packages/oncall` precedent is that a plan may forbid a package a spec proposes). R18's
// body below IS the widget's contract: severity, kind, the optional invocation link and a ≤1000-char
// narrative, exactly as §5.5's modal describes it.
import type { FastifyInstance } from "fastify";

import { WardenXError } from "@wardenx/types";

import {
  type AiSafetyServiceDeps,
  fileAiHallucinationReport,
  listAiHallucinationReports,
  triageAiHallucinationReport,
} from "../safety/service";
import { actorOf, locationOf, providerEntityOf, writeActorOf } from "./actor";
import { ABAC_IN_ORG, ABAC_SAFETY_OWNER, P } from "./guards";
import {
  FileHallucinationReportBody,
  HallucinationQueueQuery,
  ReportIdParams,
  TriageHallucinationReportBody,
  parse,
  parseQuery,
} from "./m32-typebox";

/** The DEK envelope R18's narrative goes through. Unbound in Phase 1 (see the header). */
export interface AiReportCipherPort {
  encrypt(organizationId: string, plaintext: string): Promise<Uint8Array>;
}

export interface HallucinationRouteDeps {
  readonly safety: AiSafetyServiceDeps;
  /** `null` ⇒ R18 refuses with 503 rather than writing cleartext into a `_cipher` column. */
  readonly cipher: AiReportCipherPort | null;
}

function cipherUnbound(): never {
  throw new WardenXError(
    "AI_REPORT_CIPHER_UNBOUND",
    "no per-tenant DEK envelope is bound for M32, so the reporter narrative cannot be stored encrypted; writing it in the clear into a column named reporter_narrative_cipher would make the §3.7 erasure a lie",
    503,
  );
}

export function registerHallucinationRoutes(
  app: FastifyInstance,
  deps: HallucinationRouteDeps,
): void {
  const { safety, cipher } = deps;

  // R18 — file a report. A `critical` severity comes back with D16's SEV-1 follow-up PLAN attached, so
  //       the caller (and the §4.8 worker) can see that filing this report is about to stop a capability
  //       platform-wide. The plan is returned, not executed: the kill is the worker's, for the same
  //       reason the kill-switch route does not walk a demotion inline.
  app.post(
    "/api/v1/ai/hallucination-reports",
    { preHandler: [P("ai.hallucination.report"), ABAC_IN_ORG("ai.hallucination.report")] },
    async (request, reply) => {
      const actor = await writeActorOf(request);
      const body = parse(FileHallucinationReportBody, request.body);
      if (cipher === null) cipherUnbound();
      const reporterNarrativeCipher = await cipher.encrypt(
        actor.organizationId,
        body.reporterNarrative,
      );
      const outcome = await fileAiHallucinationReport(safety, {
        organizationId: actor.organizationId,
        providerEntityId: providerEntityOf(request, body.providerEntityId ?? null),
        locationId: locationOf(request),
        invocationId: body.invocationId,
        capabilityId: body.capabilityId,
        reporterMembershipId: actor.membershipId,
        // The reporter's ROLE is stamped from the session's assembled role set, never from the body: it
        // is what a triage review reads to weigh the report, and a caller-supplied role would let a
        // report claim a clinical authority its author does not hold.
        reporterRole: actor.roles[0] ?? "unknown",
        severity: body.severity,
        hallucinationKind: body.hallucinationKind,
        reporterNarrativeCipher,
      });
      return reply.code(201).send(outcome);
    },
  );

  // R19 — the triage queue. Defaults to the two OPEN statuses (`open`, `investigating`) that §3.2.10's
  //       partial index covers: that IS the working set, and a queue that opened on every closed report
  //       ever filed would need a filter before it was usable.
  app.get(
    "/api/v1/ai/hallucination-reports",
    { preHandler: [P("ai.hallucination.triage"), ABAC_SAFETY_OWNER("ai.hallucination.triage")] },
    async (request) => {
      const actor = await actorOf(request);
      const query = parseQuery(HallucinationQueueQuery, request.query);
      return {
        reports: await listAiHallucinationReports(safety, actor.organizationId, {
          capabilityId: query.capabilityId,
          statuses: query.status === undefined ? undefined : [query.status],
        }),
      };
    },
  );

  // R20 — record the triage decision. The FOLLOW-UP the rule computes rides the response for the §4.8
  //       `ai:hallucination-triage-followup` queue; `followUpAction: 'none'` is a RECORDED decision, not
  //       an absent one, so "we decided nothing was needed" stays distinguishable from "the worker never
  //       ran" (AiHallucinationFollowUpAction's own doc-comment).
  app.post(
    "/api/v1/ai/hallucination-reports/:reportId/triage",
    { preHandler: [P("ai.hallucination.triage"), ABAC_SAFETY_OWNER("ai.hallucination.triage")] },
    async (request) => {
      const actor = await writeActorOf(request);
      const { reportId } = parse(ReportIdParams, request.params);
      const body = parse(TriageHallucinationReportBody, request.body);
      return triageAiHallucinationReport(safety, actor.organizationId, reportId, {
        ...body,
        triageOwnerMembershipId: actor.membershipId,
      });
    },
  );
}
