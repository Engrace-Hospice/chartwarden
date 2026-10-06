// apps/backend/src/modules/23-billing-medicare/routes/eligibility.routes.ts — M23 (§4.1 eligibility plane).
//
// The HETS 270/271 eligibility surface: force/refresh a check (the write service builds the 270 in-memory
// from the M5-unlocked MBI — NEVER persisted — and enqueues / records the result; 202), list a patient's
// eligibility-check history, and read the latest check (auto-refresh-on-stale: the service reuses a fresh
// cached row and only re-pulls HETS when the staleAt window has lapsed — the patient context read drives the
// `m23.eligibility.refresh_requested` path under the hood). Reads gate `billing.eligibility.read`; the check
// gates `billing.eligibility.check`. Both compose the M5 base `caseload_or_scope` predicate over the patient
// (§4.6 catalog default) + the §D13 AI-block on the mutating check + `Idempotency-Key`. NO MBI digit on any
// field (D13 / §3.6 / §8.7). Org/actor/membership binding is ALWAYS server-side.
//
// `GET /billing/eligibility/hospice-periods` serves the readmission screen: the beneficiary's cross-hospice
// hospice election / benefit-period history from the latest resolved HETS 271 + the computed next benefit
// period (null when HETS cannot settle it). Same `billing.eligibility.read` gate as the other eligibility reads
// (the intake roles hold it by default — INTAKE_DEFAULT_GRANTS / migration 0374), but its scope is `caseload_or_scope`
// OR M6's `admission_intake_scope`: readmission is intake work on a patient who is on nobody's caseload yet.
import type { FastifyInstance } from "fastify";
import { actorOf, rejectAiActor, writeActorOf } from "./actor";
import {
  CheckEligibilityBodySchema,
  HospicePeriodsQuerySchema,
  PatientQuerySchema,
  parse,
} from "./billing-typebox";
import { requireIdempotencyKey } from "./concurrency";
import { CASELOAD_OR_INTAKE_SCOPE, CASELOAD_OR_SCOPE, P } from "./guards";
import type { M23ReadRouteService } from "./read-service";
import type { M23WriteRouteService } from "./write-service";

export interface EligibilityRouteDeps {
  readonly readService: M23ReadRouteService;
  readonly writeService: M23WriteRouteService;
}

const READ = P("billing.eligibility.read");
const READ_ABAC = CASELOAD_OR_SCOPE("billing.eligibility.read");
const READ_ABAC_OR_INTAKE = CASELOAD_OR_INTAKE_SCOPE("billing.eligibility.read");
const CHECK = P("billing.eligibility.check");
const CHECK_ABAC = CASELOAD_OR_SCOPE("billing.eligibility.check");
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 eligibility routes (#22–#23 + the latest-read convenience). */
export function registerEligibilityRoutes(app: FastifyInstance, deps: EligibilityRouteDeps): void {
  const { readService, writeService } = deps;

  // POST /billing/eligibility/check — force/refresh-on-stale a 270/271 round-trip (202). §4.1 #22.
  app.post(
    "/api/v1/billing/eligibility/check",
    { preHandler: [CHECK, CHECK_ABAC, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(CheckEligibilityBodySchema, request.body);
      const res = await writeService.checkEligibility(actor, {
        patientId: body.patientId,
        providerEntityId: body.providerEntityId,
        asOfServiceDate: body.asOfServiceDate,
      });
      return reply.code(202).send(res);
    },
  );

  // GET /billing/eligibility?patientId= — per-patient eligibility-check history. §4.1 #23.
  app.get(
    "/api/v1/billing/eligibility",
    {
      preHandler: [READ, READ_ABAC],
      config: { auditRead: { resourceKind: "eligibility_check", list: true } },
    },
    async (request) => {
      const actor = actorOf(request);
      const { patientId } = parse(PatientQuerySchema, request.query);
      return { items: await readService.listEligibilityChecks(actor, patientId) };
    },
  );

  // GET /billing/eligibility/hospice-periods?patientId=&electionDate= — the latest resolved check's hospice
  // history; with `electionDate`, also the two-tier RHC carry-over a new election on that date starts with.
  app.get(
    "/api/v1/billing/eligibility/hospice-periods",
    {
      preHandler: [READ, READ_ABAC_OR_INTAKE],
      config: { auditRead: { resourceKind: "eligibility_check" } },
    },
    async (request) => {
      const actor = actorOf(request);
      const { patientId, electionDate } = parse(HospicePeriodsQuerySchema, request.query);
      return readService.getHospicePeriods(actor, patientId, electionDate);
    },
  );

  // GET /billing/eligibility/latest?patientId= — the latest check (auto-refresh-on-stale read). §4.1.
  app.get(
    "/api/v1/billing/eligibility/latest",
    { preHandler: [READ, READ_ABAC], config: { auditRead: { resourceKind: "eligibility_check" } } },
    async (request) => {
      const actor = actorOf(request);
      const { patientId } = parse(PatientQuerySchema, request.query);
      return readService.getLatestEligibility(actor, patientId);
    },
  );
}
