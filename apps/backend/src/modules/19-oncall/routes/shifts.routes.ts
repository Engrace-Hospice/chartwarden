// apps/backend/src/modules/19-oncall/routes/shifts.routes.ts — M19 (§4.1) rows 19-26: the on-call roster
// and the tenant policy.
//
// `on_call_shift` IS THE SINGLE MOST SURVEY-LOAD-BEARING ROW M19 WRITES — it is the CoP 418.100(c)(2)
// proof that a nurse was reachable at 2 a.m. — which is why routes 22 and 23 exist at all: the §4.8 cron
// normally opens and closes shifts, and these are the manual paths for the night the cron did not run.
// Both carry `oncall.write_schedule` and both go through the SAME §2.2.2 machine as the cron, so a manual
// open cannot claim coverage from before the window began (`SHIFT_NOT_YET_STARTED`).
//
// ROUTE 24 (`/oncall/current`) IS KEYED PER PROVIDER ENTITY AND NEVER UNIONED. CoP 418.100(c)(2) is
// per-CCN, so a union across PEs lets one covered entity mask another's dark night (the M19-T06 finding).
// `actors: []` for a PE is a REAL answer — a coverage gap — not an empty result.
//
// THE POLICY PATCH (26) CARRIES STEP-UP because it edits the escalation ladder and the vendor binding:
// §8.3.2 lists "alter the tenant on-call policy to lower mandatory-escalation tiers" as the tampering
// threat, and the platform floor a tenant may only TIGHTEN lives in the protocol catalog next door.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, rejectOffsetPagination, requireIdempotencyKey } from "./concurrency";
import { ABAC_CASELOAD_OR_SCOPE, ABAC_IN_ORG, P, STEP_UP } from "./guards";
import {
  CancelShiftBody,
  CreateShiftBody,
  CurrentOnCallQuery,
  ListShiftsQuery,
  PatchOncallPolicyBody,
  PolicyQuery,
  ShiftIdParams,
  ShiftTransitionBody,
  parse,
  parseQuery,
} from "./m19-typebox";
import type { M19ReadService } from "./read-service";
import type { M19WriteService } from "./write-service";

export interface ShiftRouteDeps {
  readonly readService: M19ReadService;
  readonly writeService: M19WriteService;
}

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();

/**
 * Neither the schedule nor the policy carries patient data — a shift names a MEMBERSHIP and a window, and
 * the policy is org configuration (§3.3's own headers say so). The read-audit declarations are therefore
 * justified waivers rather than emissions: an M4 read row per roster refresh would bury the reads that
 * matter (§8.7.1 classes the shift table `operational`, not `compliance`).
 */
const ROSTER_NO_PHI = {
  none: "on-call roster metadata (window, discipline, membership id) — no patient, no caller, no clinical content",
} as const;

export function registerShiftRoutes(app: FastifyInstance, deps: ShiftRouteDeps): void {
  const { readService, writeService } = deps;

  // 19 — the schedule (cursor-paginated).
  app.get(
    "/api/v1/oncall/shifts",
    {
      preHandler: [
        P("oncall.read_schedule"),
        ABAC_CASELOAD_OR_SCOPE("oncall.read_schedule"),
        NO_OFFSET,
      ],
      config: { auditRead: ROSTER_NO_PHI },
    },
    async (request) =>
      readService.listShifts(actorOf(request), parseQuery(ListShiftsQuery, request.query)),
  );

  // 20 — manual create (Hybrid / Centralized, and the Direct-model backfill the §4.5 sync does not cover).
  //      `policy_snapshot` is NOT a body field: D7 pins it from the tenant policy, and a caller-supplied
  //      snapshot would be a caller-supplied answer to "which ladder was in effect that night".
  app.post(
    "/api/v1/oncall/shifts",
    { preHandler: [P("oncall.write_schedule"), ABAC_IN_ORG("oncall.write_schedule"), IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(CreateShiftBody, request.body);
      const created = await writeService.createShift(writeActorOf(request), body);
      return reply.code(201).send(created);
    },
  );

  // 21 — cancel with a reason. NO outbox event: a shift that never activated was never in M36's `on_call`
  //      channel, so a `cancelled` emit would ask M36 to remove a member it never added. The hole the
  //      cancellation leaves is the coverage-gap watchdog's finding, on its own 30-minute cadence.
  app.patch(
    "/api/v1/oncall/shifts/:shiftId/cancel",
    { preHandler: [P("oncall.write_schedule"), ABAC_IN_ORG("oncall.write_schedule"), IDEMPOTENT] },
    async (request) => {
      const { shiftId } = parse(ShiftIdParams, request.params);
      const body = parse(CancelShiftBody, request.body);
      return writeService.cancelShift(writeActorOf(request), shiftId, {
        expectedVersion: ifMatchVersion(request, true),
        ...body,
      });
    },
  );

  // 22 — manual open. Pins the D7 policy snapshot and emits `m19.oncall_shift.activated`, the SINGLE
  //      canonical shift-open topic M36's channel synchronizer and M20's SOS path both subscribe to.
  app.post(
    "/api/v1/oncall/shifts/:shiftId/open",
    { preHandler: [P("oncall.write_schedule"), ABAC_IN_ORG("oncall.write_schedule"), IDEMPOTENT] },
    async (request) => {
      const { shiftId } = parse(ShiftIdParams, request.params);
      parse(ShiftTransitionBody, request.body);
      return writeService.openShift(writeActorOf(request), shiftId, {
        expectedVersion: ifMatchVersion(request, true),
      });
    },
  );

  // 23 — manual close. Emits `m19.oncall_shift.completed`, which removes the departing actor from M36's
  //      channel; messages sent during their tenure stay attributed to them (§4.5).
  app.post(
    "/api/v1/oncall/shifts/:shiftId/close",
    { preHandler: [P("oncall.write_schedule"), ABAC_IN_ORG("oncall.write_schedule"), IDEMPOTENT] },
    async (request) => {
      const { shiftId } = parse(ShiftIdParams, request.params);
      parse(ShiftTransitionBody, request.body);
      return writeService.closeShift(writeActorOf(request), shiftId, {
        expectedVersion: ifMatchVersion(request, true),
      });
    },
  );

  // 24 — who is on call NOW, per ProviderEntity, with the per-PE RN coverage verdict beside each.
  app.get(
    "/api/v1/oncall/current",
    {
      preHandler: [P("oncall.read_schedule"), ABAC_CASELOAD_OR_SCOPE("oncall.read_schedule")],
      config: { auditRead: ROSTER_NO_PHI },
    },
    async (request) =>
      readService.getCurrentOnCall(actorOf(request), parseQuery(CurrentOnCallQuery, request.query)),
  );

  // 25 — the tenant policy for one ProviderEntity. NOT auto-created on read: D7 pins this row onto every
  //      shift that opens, and a default invented at read time would be pinned as though the tenant had
  //      chosen it.
  app.get(
    "/api/v1/oncall/policy",
    {
      preHandler: [P("oncall.read_policy"), ABAC_IN_ORG("oncall.read_policy")],
      config: {
        auditRead: {
          none: "org-level after-hours configuration (model, escalation ladder, SLA targets, AI feature gates) — no patient data",
        },
      },
    },
    async (request) => {
      const { providerEntityId } = parseQuery(PolicyQuery, request.query);
      return readService.getPolicy(actorOf(request), providerEntityId);
    },
  );

  // 26 — edit the policy (step-up; §8.3.2). A `hybrid` / `centralized` selection on a deployment where the
  //      D3 flag is off is REFUSED rather than accepted-and-ignored: a tenant must never believe a vendor
  //      is answering their nights when none is.
  app.patch(
    "/api/v1/oncall/policy",
    {
      preHandler: [
        P("oncall.admin_policy"),
        ABAC_IN_ORG("oncall.admin_policy"),
        STEP_UP("oncall.admin_policy"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { providerEntityId } = parseQuery(PolicyQuery, request.query);
      const body = parse(PatchOncallPolicyBody, request.body);
      return writeService.patchPolicy(writeActorOf(request), {
        expectedVersion: ifMatchVersion(request, true),
        providerEntityId,
        ...body,
      });
    },
  );
}
