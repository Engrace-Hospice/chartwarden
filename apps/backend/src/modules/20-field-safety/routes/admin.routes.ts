// apps/backend/src/modules/20-field-safety/routes/admin.routes.ts — M20 (§4.1) rows 18-25: the tenant
// policy, the paging subscriptions and the advisory polygons.
//
// These are the three CONFIGURATION surfaces, and none of them holds patient data: a policy version is a
// set of thresholds, a subscription names two memberships and a scope, and a polygon is a geography with
// a ≤200-character advisory. Their read-audit declarations are therefore justified WAIVERS rather than
// emissions — an M4 read row per policy refresh would bury the reads that matter (§8.8.1 classes these
// tables `operational`/`compliance`, not `phi`).
//
// ── THE POLICY PATCH IS THE MOST CONSEQUENTIAL WRITE IN THE MODULE ────────────────────────────────
//
// It changes how long a clinician in distress goes unwatched. Hence: `safety_policy.edit` in the
// `compliance` category (DON / Comp Off only, §6), `requireStepUp` on top (§4.1's "∧ step-up"), an
// `editReason` of ≥30 characters (§2.2.4), a D4 band + ladder validation that returns a 422 naming the
// knob, and a NEW VERSION ROW rather than an UPDATE — because every other M20 row pins the version it was
// written under, and an UPDATE would retroactively rewrite what was in force during a 2026 incident.
//
// ── DELETING A SUBSCRIPTION SUCCEEDS EVEN WHEN IT UNCOVERS SOMEBODY ───────────────────────────────
//
// Row 22 is a DELETE that always works and reports what it left uncovered (§2.2.5's
// `wouldDeactivationCreateGap`, surfaced as `coverageGapsCreated`). Refusing would leave a departed
// supervisor's row in place, which is the `all_subscriptions_deactivated` failure one step earlier — a
// configuration that LOOKS complete and pages a membership that will not answer. The DON learns at the
// only moment the gap is cheap to fix, and the §7.8 watchdog wakes them anyway if they ignored it.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, rejectOffsetPagination, requireIdempotencyKey } from "./concurrency";
import { ABAC_IN_ORG, ABAC_SUPERVISOR, P, STEP_UP } from "./guards";
import {
  AreaIdParams,
  CreateHighRiskAreaBody,
  CreateSubscriptionBody,
  HighRiskAreaListQuery,
  PatchHighRiskAreaBody,
  PatchPolicyBody,
  PolicyQuery,
  SubscriptionIdParams,
  SubscriptionListQuery,
  parse,
  parseQuery,
} from "./m20-typebox";
import type { M20ReadService } from "./read-service";
import type { M20WriteService } from "./write-service";

export interface AdminRouteDeps {
  readonly readService: M20ReadService;
  readonly writeService: M20WriteService;
}

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();

const POLICY_NO_PHI = {
  none: "org-level safety configuration (cadences, overdue thresholds, SOS SLAs, after-hours window) — no patient and no clinician record",
} as const;

const SUBSCRIPTION_NO_PHI = {
  none: "workforce paging configuration (supervisor membership, clinician membership, scope selector, alert kinds) — no patient data",
} as const;

const AREA_NO_PHI = {
  none: "advisory geography and a tenant-authored ≤200-character message — no patient, no clinician, no visit",
} as const;

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  const { readService, writeService } = deps;

  // 18 — the effective policy. §2.2.4's `asOf` is the REPLAY arm: a 2031 review of a 2026 incident has to
  //      read the 2026 thresholds, and reading today's would turn a policy that tightened into a
  //      regression that never happened.
  app.get(
    "/api/v1/safety/policy",
    {
      preHandler: [P("safety_policy.read"), ABAC_IN_ORG("safety_policy.read")],
      config: { auditRead: POLICY_NO_PHI },
    },
    async (request) => {
      const { asOf } = parseQuery(PolicyQuery, request.query);
      return readService.getPolicy(actorOf(request), asOf);
    },
  );

  // 19 — edit the policy (step-up; see the header).
  app.patch(
    "/api/v1/safety/policy",
    {
      preHandler: [
        P("safety_policy.edit"),
        ABAC_SUPERVISOR("safety_policy.edit"),
        STEP_UP("safety_policy.edit"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const body = parse(PatchPolicyBody, request.body);
      return writeService.patchPolicy(writeActorOf(request), {
        ...body,
        expectedVersion: ifMatchVersion(request),
      });
    },
  );

  // 20 — who watches whom (§2.2.5 / D8). Dashboard VISIBILITY is RBAC+ABAC and deliberately independent:
  //      a supervisor may SEE a board she is not paged for, and D8 exists because the inverse — visible
  //      to everyone, paged by nobody — is the failure §7.8 wakes the DON about.
  app.get(
    "/api/v1/safety/supervisor-subscriptions",
    {
      preHandler: [
        P("safety_supervisor.read"),
        ABAC_SUPERVISOR("safety_supervisor.read"),
        NO_OFFSET,
      ],
      config: { auditRead: SUBSCRIPTION_NO_PHI },
    },
    async (request) =>
      readService.listSubscriptions(
        actorOf(request),
        parseQuery(SubscriptionListQuery, request.query),
      ),
  );

  // 21 — add one. The scope-selector pairing (§3.3's `m20_sss_scope_integrity`) and the vacation-forward
  //      pairing are re-checked in the service so the DON is told WHICH selector is missing rather than
  //      shown a constraint name.
  app.post(
    "/api/v1/safety/supervisor-subscriptions",
    {
      preHandler: [
        P("safety_supervisor.edit"),
        ABAC_SUPERVISOR("safety_supervisor.edit"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const body = parse(CreateSubscriptionBody, request.body);
      const created = await writeService.createSubscription(writeActorOf(request), body);
      return reply.code(201).send(created);
    },
  );

  // 22 — deactivate one, and say what it uncovered (see the header). A soft deactivation, never a DELETE
  //      of the row: §3.7's retention keeps the paging configuration as evidence of who was watching whom
  //      on the night an incident happened.
  app.delete(
    "/api/v1/safety/supervisor-subscriptions/:subscriptionId",
    {
      preHandler: [
        P("safety_supervisor.edit"),
        ABAC_SUPERVISOR("safety_supervisor.edit"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { subscriptionId } = parse(SubscriptionIdParams, request.params);
      return writeService.deleteSubscription(writeActorOf(request), subscriptionId);
    },
  );

  // 23 — the advisory polygons in force. `includeExpired` defaults FALSE: the pre-visit advisory must
  //      never surface a polygon that was retired last winter, and the editor asks for history explicitly.
  app.get(
    "/api/v1/safety/high-risk-areas",
    {
      preHandler: [
        P("safety.high_risk_area.read"),
        ABAC_IN_ORG("safety.high_risk_area.read"),
        NO_OFFSET,
      ],
      config: { auditRead: AREA_NO_PHI },
    },
    async (request) =>
      readService.listHighRiskAreas(
        actorOf(request),
        parseQuery(HighRiskAreaListQuery, request.query),
      ),
  );

  // 24 — draw one (§7.6's closing act). M20-F07: no PostGIS, so ring closure and the ≥4-point minimum are
  //      validated in app code at the moment the Compliance Officer draws it — not on the night a
  //      clinician is standing in it.
  app.post(
    "/api/v1/safety/high-risk-areas",
    {
      preHandler: [
        P("safety.high_risk_area.create"),
        ABAC_SUPERVISOR("safety.high_risk_area.create"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const body = parse(CreateHighRiskAreaBody, request.body);
      const created = await writeService.createHighRiskArea(writeActorOf(request), body);
      return reply.code(201).send(created);
    },
  );

  // 25 — edit or retire one. Retiring is `effectiveTo`, never a delete: an incident review has to be able
  //      to ask what advisory was in force on the day.
  app.patch(
    "/api/v1/safety/high-risk-areas/:areaId",
    {
      preHandler: [
        P("safety.high_risk_area.edit"),
        ABAC_SUPERVISOR("safety.high_risk_area.edit"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { areaId } = parse(AreaIdParams, request.params);
      const body = parse(PatchHighRiskAreaBody, request.body);
      return writeService.patchHighRiskArea(writeActorOf(request), areaId, body);
    },
  );
}
