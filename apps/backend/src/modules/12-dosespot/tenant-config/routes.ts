// apps/backend/src/modules/12-dosespot/tenant-config/routes.ts — M12 (ADR-0110): the tenant's own DoseSpot registration.
// `GET|PUT /api/v1/tenant/dosespot`, `POST …/verify`, `POST …/activate`, `POST …/deactivate`.
//
// Gated by its OWN ORG-LEVEL permission pair (the `billing.clearinghouse.*` shape): the read `prescribing.clinic.read`; every
// write `prescribing.clinic.admin` + a FRESH step-up (§D14) + the AI-actor block + `Idempotency-Key`. The pair is bound to the
// org-wide admin roles only (`org_admin`, `administrator`), NOT to the prescriber roster permission: the registration decides
// where every prescription of the organization goes. A first PUT omits `If-Match`; a change carries the version last read
// (428 / 412). The credential is write-only (sealed, never returned). Org and membership binding is server-side.
import { requirePermission, requireStepUp } from "@chartwarden/auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { rejectAiActor } from "../../../bootstrap/reject-ai-actor";
import { MembershipParamsSchema, parse } from "../routes/dosespot-typebox";
import type { PrescriberEnrollmentService } from "./prescriber-enrollment";
import {
  type PreHandler,
  clinicActorOf,
  optionalIfMatch,
  orgOf,
  requireIdempotencyKey,
} from "./route-guards";
import type { DoseSpotClinicRouteService } from "./tenant-service";
import { EnrollPrescriberVendorBodySchema, PutClinicBodySchema } from "./typebox";

export interface TenantDoseSpotRouteDeps {
  readonly clinicService: DoseSpotClinicRouteService;
  /** A prescriber's DoseSpot (vendor) enrolment; absent => that route is not mounted. */
  readonly enrollmentService?: PrescriberEnrollmentService;
  /** Per-user cap on `verify` (a vendor call per request); fail-open like the other route limits. Absent = unlimited. */
  readonly verifyRateLimit?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

const READ = requirePermission("prescribing.clinic.read") as PreHandler;
const ADMIN = requirePermission("prescribing.clinic.admin") as PreHandler;
const ADMIN_STEPUP = requireStepUp("prescribing.clinic.admin") as PreHandler;
const ROSTER = requirePermission("prescribing.admin.roster") as PreHandler;
const ROSTER_STEPUP = requireStepUp("prescribing.admin.roster") as PreHandler;
const NO_AI = rejectAiActor("AI principals cannot change the DoseSpot registration") as PreHandler;
const IDEMPOTENT = requireIdempotencyKey();
const WRITE: readonly PreHandler[] = [ADMIN, ADMIN_STEPUP, NO_AI, IDEMPOTENT];

export function registerTenantDoseSpotRoutes(
  app: FastifyInstance,
  deps: TenantDoseSpotRouteDeps,
): void {
  const { clinicService: service } = deps;
  // The limiter runs AFTER the permission and step-up guards, so a caller who may not verify never spends the tenant's budget.
  const VERIFY: readonly PreHandler[] = deps.verifyRateLimit
    ? [...WRITE, deps.verifyRateLimit]
    : WRITE;

  // GET — what the organization registered (masked: `hasSecret`, never the credential).
  app.get(
    "/api/v1/tenant/dosespot",
    {
      preHandler: [READ],
      config: {
        auditRead: {
          none: "DoseSpot registration and status (never the credential) — no patient data",
        },
      },
    },
    async (request) => service.get(orgOf(request), request.context.userId),
  );

  // PUT — save the environment, clinic id, service clinician and credential. 201 on the first save, 200 on a change.
  app.put("/api/v1/tenant/dosespot", { preHandler: [...WRITE] }, async (request, reply) => {
    const actor = clinicActorOf(request);
    const body = parse(PutClinicBodySchema, request.body);
    const { created, view } = await service.put(actor, body, optionalIfMatch(request));
    return reply.code(created ? 201 : 200).send(view);
  });

  // POST verify — the connection test (a no-PHI token mint): registered -> verified.
  app.post("/api/v1/tenant/dosespot/verify", { preHandler: [...VERIFY] }, async (request) => {
    const { view, test } = await service.verify(clinicActorOf(request));
    return { config: view, test };
  });

  // POST activate — verified -> active: e-prescribing transmits for the organization.
  app.post("/api/v1/tenant/dosespot/activate", { preHandler: [...WRITE] }, async (request) =>
    service.activate(clinicActorOf(request)),
  );

  // POST deactivate — active -> verified: e-prescribing pauses (queued orders wait; new signed orders activate locally).
  app.post("/api/v1/tenant/dosespot/deactivate", { preHandler: [...WRITE] }, async (request) =>
    service.deactivate(clinicActorOf(request)),
  );

  // POST dosespot-enrollment — register a roster prescriber with DoseSpot and record the vendor's id (the link `transmit-newrx`
  // sends under). Needs the roster key (a prescriber, not the clinic, is being enrolled), a fresh step-up and an Idempotency-Key.
  // 409 DOSESPOT_NOT_READY until the registration is verified or active. Never starts EPCS.
  if (deps.enrollmentService) {
    const enrollment = deps.enrollmentService;
    app.post(
      "/api/v1/admin/dosespot-prescribers/:membershipId/dosespot-enrollment",
      { preHandler: [ROSTER, ROSTER_STEPUP, NO_AI, IDEMPOTENT] },
      async (request) => {
        const actor = clinicActorOf(request);
        const { membershipId } = parse(MembershipParamsSchema, request.params);
        const body = parse(EnrollPrescriberVendorBodySchema, request.body);
        return enrollment.enroll(actor, membershipId, body);
      },
    );
  }
}
