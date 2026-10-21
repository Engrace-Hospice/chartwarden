// apps/backend/src/modules/32-ai-platform/routes/safety-ops.routes.ts — §4.1 rows R26-R32: evaluation
// runs (D10), the prompt registry (§4.5/§8.5), drift (D11) and backend health.
//
// EVERY ROUTE HERE IS THE AI SAFETY OWNER'S, and every one of them reads or writes PLATFORM-SHARED data.
// None takes an org; none opens `withOrgContext`. That is a deliberate consequence of what these tables
// are: an evaluation run is evidence about a MODEL, a prompt template is the instruction every tenant's
// calls share, a drift finding is a property of the model's behaviour, and a backend's health is a fact
// about a process. Scoping any of them to the caller's agency would hide from one tenant a degradation
// every tenant is exposed to.
//
// ── R29/R30 KEY ON THE CAPABILITY KEY, NOT AN ID, AND R30 IS AN INSERT ─────────────────────────────
//
// §4.5's cache is keyed `(capabilityKey, contentHash)` and D18's queries are prefix matches over the
// template's target columns, so the KEY is the registry's natural handle. R30 is INSERT-AND-DEPRECATE and
// not a status flip: §3.5's immutability trigger rejects an UPDATE that would flip an existing row to
// `active`, so a route that read "activate a version" as "set status = active" would emit a statement the
// trigger refuses with `restrict_violation` — a 500 on the happy path.
//
// ── R29 RETURNS METADATA AND NEVER A TEMPLATE BODY ─────────────────────────────────────────────────
//
// §4.1's own row says so ("template body fetched from git filesystem, not from this route"), and §8.5's
// reason is the one that matters: the body is the platform's prompt-injection surface, it is PR-gated in
// `packages/prompts` with a clinical-reviewer attestation, and an HTTP route that served it would be a
// second distribution channel with none of that review attached.
//
// ── R32 IS `ok` IN SHELL MODE, NOT `degraded` ──────────────────────────────────────────────────────
//
// Phase 1 runs with `ai.full` OFF, so "no healthy backend" is the EXPECTED state. Reporting `degraded`
// for the platform's intended posture would make the health endpoint red on every correctly-working
// deployment — the fastest way to teach an operator to ignore it. `capabilityShellMode` carries the
// nuance instead.
import type { FastifyInstance } from "fastify";

import type { AIPromptRegistry } from "@chartwarden/ai-platform";
import { NotFoundError } from "@chartwarden/types";

import type { AiPromptServiceDeps } from "../prompts/service";
import { activateAiPromptTemplate } from "../prompts/service";
import {
  type AiSafetyServiceDeps,
  listAiEvaluationRuns,
  queueAiEvaluationRun,
  readAiEvaluationRun,
} from "../safety/service";
import { writeActorOf } from "./actor";
import { actorOf } from "./actor";
import { ABAC_SAFETY_OWNER, P, STEP_UP } from "./guards";
import {
  ActivatePromptTemplateBody,
  CapabilityKeyParams,
  DriftQuery,
  EvaluationRunQuery,
  QueueEvaluationRunBody,
  RunIdParams,
  parse,
  parseQuery,
} from "./m32-typebox";
import type { M32ReadService } from "./read-service";

export interface SafetyOpsRouteDeps {
  readonly safety: AiSafetyServiceDeps;
  readonly prompts: AiPromptServiceDeps;
  readonly read: M32ReadService;
  /** The live §4.5 registry R29 reads through. `null` ⇒ R29 refuses (see its handler). */
  readonly promptRegistry: AIPromptRegistry | null;
  readonly now?: () => string;
}

/** §4.1 R31's default window — one day, which is 96 of §4.8's 15-minute sweeps. */
export const M32_DEFAULT_DRIFT_WINDOW_HOURS = 24;

export function registerSafetyOpsRoutes(app: FastifyInstance, deps: SafetyOpsRouteDeps): void {
  const { safety, prompts, read, promptRegistry } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  // R26 — queue an evaluation run. `status` is NOT an input (§3.2.11 inserts every run `pending`): a body
  //       that could set `passed` would let an operator mint the D10 evidence a stage-3 transition then
  //       cites, which is the one thing the evidence check exists to prevent.
  app.post(
    "/api/v1/ai/evaluations",
    { preHandler: [P("ai.evaluation.run"), ABAC_SAFETY_OWNER("ai.evaluation.run")] },
    async (request, reply) => {
      const actor = await writeActorOf(request);
      const body = parse(QueueEvaluationRunBody, request.body);
      const run = await queueAiEvaluationRun(safety, {
        capabilityId: body.capabilityId,
        backendId: body.backendId,
        datasetVersionRef: body.datasetVersionRef,
        mlflowRunId: body.mlflowRunId,
        stage: body.stage,
        summaryMetrics: body.summaryMetrics ?? {},
        initiatedByMembershipId: actor.membershipId,
      });
      return reply.code(201).send(run);
    },
  );

  // R27 — recent runs.
  app.get(
    "/api/v1/ai/evaluations",
    { preHandler: [P("ai.evaluation.read"), ABAC_SAFETY_OWNER("ai.evaluation.read")] },
    async (request) => {
      const query = parseQuery(EvaluationRunQuery, request.query);
      return {
        runs: await listAiEvaluationRuns(safety, {
          capabilityId: query.capabilityId,
          statuses: query.status === undefined ? undefined : [query.status],
        }),
      };
    },
  );

  // R28 — one run, with its metrics and its MLflow handle. MLflow stays the record of the run itself;
  //       `summary_metrics` is the headline snapshot §3.2.11 keeps so a governance review does not have
  //       to reach into a second system to see why an edge was approved.
  app.get(
    "/api/v1/ai/evaluations/:runId",
    { preHandler: [P("ai.evaluation.read"), ABAC_SAFETY_OWNER("ai.evaluation.read")] },
    async (request) => {
      const { runId } = parse(RunIdParams, request.params);
      return readAiEvaluationRun(safety, runId);
    },
  );

  // R29 — the active template's METADATA (never its body; see the header). `null` from the registry means
  //       the capability genuinely has no active template, which is a 404 and not an empty object: a
  //       consumer that read `{}` as "an active template with no fields" would dispatch against nothing.
  app.get(
    "/api/v1/ai/prompts/:capabilityKey/active",
    { preHandler: [P("ai.prompt.read"), ABAC_SAFETY_OWNER("ai.prompt.read")] },
    async (request) => {
      const { capabilityKey } = parse(CapabilityKeyParams, request.params);
      if (promptRegistry === null) throw new NotFoundError("ai_prompt_template");
      const detail = await promptRegistry.getActivePromptForCapability(capabilityKey);
      if (detail === null) throw new NotFoundError("ai_prompt_template");
      // The registry's detail carries the resolved BODY for the invocation path; the route projects it
      // away. Spreading the object and deleting a field would leave the body one refactor from the wire.
      return {
        capabilityKey,
        templateKey: detail.templateKey,
        version: detail.version,
        contentHash: detail.contentHash,
        outputEntityTargetPrefix: detail.outputEntityTargetPrefix,
        outputTypePrefix: detail.outputTypePrefix,
        gitArtifactPath: detail.gitArtifactPath,
        approvedAt: detail.approvedAt,
        // From `meta`, which is the summary's governance block — the SIBLING of `promptBody`, and the
        // reason the projection is written out field by field rather than as a spread-minus-body: a
        // spread would carry `promptBody` to the wire the moment somebody flattened `meta`.
        inputSchemaRef: detail.meta.inputSchemaRef,
        outputSchemaRef: detail.meta.outputSchemaRef,
        compatibleBackendKeys: detail.meta.compatibleBackendKeys,
        clinicalReviewerAttestation: detail.clinicalReviewerAttestation,
      };
    },
  );

  // R30 — activate a version. STEP-UP (permission-keys.ts): the active template is what every consumer's
  //       D18 boot validator reads, so swapping it is the highest-leverage write in the module. The
  //       ARTIFACT is read and hashed inside the service — the submitted `templateContentHash` is a claim
  //       to verify, not a value to store (m32-typebox.ts absence note 4).
  app.post(
    "/api/v1/ai/prompts/:capabilityKey/activate",
    {
      preHandler: [
        P("ai.prompt.activate"),
        ABAC_SAFETY_OWNER("ai.prompt.activate"),
        STEP_UP("ai.prompt.activate"),
      ],
    },
    async (request, reply) => {
      const actor = await writeActorOf(request);
      const { capabilityKey } = parse(CapabilityKeyParams, request.params);
      const body = parse(ActivatePromptTemplateBody, request.body);
      const row = await activateAiPromptTemplate(prompts, {
        ...body,
        capabilityKey,
        createdByMembershipId: actor.membershipId,
      });
      return reply.code(201).send(row);
    },
  );

  // R31 — drift. M32 owns no drift table (read-service.ts's header): §4.8's sweep publishes
  //       `m32.drift.detected` and writes a `drift_response` EVALUATION RUN, which is the durable record.
  //       The response says so in `source`, so a console cannot mistake an empty list for "no drift" when
  //       it may mean "no sweep has run".
  app.get(
    "/api/v1/ai/drift/recent",
    { preHandler: [P("ai.drift.read"), ABAC_SAFETY_OWNER("ai.drift.read")] },
    async (request) => {
      const actor = await actorOf(request);
      const query = parseQuery(DriftQuery, request.query);
      const withinHours = query.withinHours ?? M32_DEFAULT_DRIFT_WINDOW_HOURS;
      return {
        source: "ai_evaluation_run.stage=drift_response",
        withinHours,
        findings: await read.recentDrift(actor, withinHours),
      };
    },
  );

  // R32 — liveness + per-backend health. §4.1 says "cached 10s"; the cache is a route-level concern and
  //       is left to the platform's HTTP layer rather than reimplemented here, because a per-instance
  //       in-memory cache would make two backend instances disagree about a backend's status for ten
  //       seconds at exactly the moment an operator is refreshing to see whether it came back.
  app.get(
    "/api/v1/ai/health",
    { preHandler: [P("ai.health.read"), ABAC_SAFETY_OWNER("ai.health.read")] },
    async (_request, reply) => {
      const view = await read.health(now());
      return reply.header("cache-control", "private, max-age=10").send(view);
    },
  );
}
