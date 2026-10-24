// apps/backend/src/modules/36-messaging/routes/patient-context-routes.ts — WP 3.1 patient context panel.
//
//   GET /api/v1/messaging/patients/:patientId/context
//
// A projection through the owning modules' seams (see patient-context-service.ts). The route itself needs only
// `messaging.read`; EVERY tile then re-checks the permission of the module that owns its data, on this request:
//   status / care_team / allergies → `patient.read` + `caseload_or_scope` on the patient (the M5 chart-read gate)
//   medications                    → `prescribing.read` + `caseload_or_scope` (the M12 order-read gate)
//   open_tasks                     → the chart-read gate AND the tenant flag `messaging.tasks`; counts the CALLER's own
//                                    active tasks only (a team-wide count would disclose concerns raised in conversations
//                                    the viewer cannot read)
// A tile the caller fails is ABSENT from the response and its seam is never called, so a user without medication
// access cannot fetch the tile through this API. Break-glass is deliberately NOT honoured here: this is a convenience
// projection, and an emergency grant must open the owning module's screen (which audits it), not a side door.
// A caller who may see no tile gets the same empty answer for a missing patient as for a real one (no existence leak).
// KNOWN LIMIT: `auditRead.fields` is static (the read-audit plugin takes one list per route), so the audit row names all
// five tiles even when the caller was shown fewer, and a no-tile 200 is still audited against the param patient id.
// That over-reports disclosure; it never under-reports.
import {
  type GuardHandler,
  composeGuards,
  requireAbac,
  requirePermission,
} from "@chartwarden/auth";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSeam } from "../../../bootstrap/index";
import {
  PATIENT_CONTEXT_TILES,
  type PatientContextPorts,
  type PatientContextTile,
  buildPatientContext,
} from "../patient-context/patient-context-service";
import { PatientConversationParamsSchema, parse } from "./messaging-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const SCOPE = "caseload_or_scope";
const tileGuard = (permission: string): GuardHandler =>
  composeGuards(
    requirePermission(permission),
    requireAbac(permission, SCOPE, {
      getTarget: (request) => ({
        patientId: (request.params as { patientId?: unknown } | undefined)?.patientId,
      }),
      breakGlassBypassable: false,
    }),
  );

const CHART_READ = tileGuard("patient.read");
const TILE_GUARDS: Readonly<Record<PatientContextTile, GuardHandler>> = {
  status: CHART_READ,
  care_team: CHART_READ,
  allergies: CHART_READ,
  medications: tileGuard("prescribing.read"),
  open_tasks: CHART_READ,
};

/** The one tile that also needs a tenant flag; with the flag off it is absent and its source is never read. */
const FLAG_GATED_TILE: PatientContextTile = "open_tasks";

/** True when the guard passes; a 403/404 denial is "not permitted". Anything else (401, a crash) propagates. */
async function permits(guard: GuardHandler, request: FastifyRequest): Promise<boolean> {
  try {
    await guard(request as unknown as Parameters<GuardHandler>[0]);
    return true;
  } catch (err) {
    if (err instanceof ForbiddenError || err instanceof NotFoundError) return false;
    throw err;
  }
}

/** Production ports: every read goes through the owning module's seam (an unbound deny-stub throws ⇒ tile unavailable). */
export const seamPatientContextPorts: PatientContextPorts = {
  findPatient: (organizationId, id) => getSeam("PatientReader").findById({ organizationId, id }),
  careTeamMembers: (organizationId, patientId) =>
    getSeam("CareTeamProvider").careTeamMembers({ organizationId, patientId }),
  activeAllergies: (organizationId, patientId) =>
    getSeam("PatientAllergyReader").activeAllergies({ organizationId, patientId }),
  activeMedications: (organizationId, patientId) =>
    getSeam("MedicationOrderProvider").getActiveMedications(organizationId, patientId),
  // Replaced by the task service in registerMessagingRoutes; reaching this means the tasks are not bound.
  openTaskCount: async () => {
    throw new Error("tasks are not bound");
  },
  now: () => new Date(),
};

export function registerPatientContextRoutes(
  app: FastifyInstance,
  guards: { readonly read: PreHandler },
  ports: PatientContextPorts = seamPatientContextPorts,
  /** The tenant flag `messaging.tasks`. A throw reads as off (fail closed). */
  tasksEnabled: (organizationId: string) => Promise<boolean> = async () => false,
): void {
  app.get(
    "/api/v1/messaging/patients/:patientId/context",
    {
      preHandler: [requireUuidParams("patientId"), guards.read],
      config: {
        auditRead: {
          resourceKind: "patient_context_panel",
          resourceIdParam: "patientId",
          patientIdParam: "patientId",
          fields: ["status", "care_team", "allergies", "medications", "open_tasks"],
        },
      },
    },
    async (request) => {
      const ctx = request.context;
      if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
      const { patientId } = parse(PatientConversationParamsSchema, request.params);

      // Tiles that share a guard (the three chart tiles) are evaluated once, not once per tile.
      const verdicts = new Map<GuardHandler, boolean>();
      const allowed = new Set<PatientContextTile>();
      const tasksOn = await tasksEnabled(ctx.organizationId).catch(() => false);
      for (const tile of PATIENT_CONTEXT_TILES) {
        if (tile === FLAG_GATED_TILE && !tasksOn) continue;
        const guard = TILE_GUARDS[tile];
        if (!verdicts.has(guard)) verdicts.set(guard, await permits(guard, request));
        if (verdicts.get(guard)) allowed.add(tile);
      }
      const context = await buildPatientContext(
        { organizationId: ctx.organizationId, patientId, userId: ctx.userId, allowed },
        {
          ...ports,
          onTileUnavailable: (tile) =>
            request.log.warn({ tile }, "patient context tile unavailable"),
        },
      );
      if (!context) throw new NotFoundError("patient", patientId);
      return context;
    },
  );
}
