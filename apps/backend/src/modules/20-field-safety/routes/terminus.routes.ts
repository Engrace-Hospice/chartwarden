// apps/backend/src/modules/20-field-safety/routes/terminus.routes.ts - GAP-032: the read surfaces of the SOS
// emergency terminus.
//
//   GET /api/v1/safety/sos/:sosAlertId/psap      the tenant-curated PSAP line for an alert AT the terminus
//   GET /api/v1/safety/sos/:sosAlertId/terminus  the ledger status of each terminus effect (no numbers)
//   GET /api/v1/safety/admin/terminus-readiness  can this deployment actually page / dial / resolve?
//
// FAIL-SAFE WORDING. The emergency instruction is the STATIC "call 911 / your local emergency number" line the
// client always shows, independent of any lookup; the PSAP administrative number returned here is
// supplementary and carries who verified it and when. The platform never dials a PSAP. The number appears
// ONLY in this authenticated response: never in an outbox event, an alert payload or an audit row (spec 8.8.2),
// which carry the `psapJurisdictionId` alone.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
  ConflictError,
  type EmergencyServiceJurisdictionReader,
  NotFoundError,
  type OrgId,
  type PsapJurisdictionSummary,
} from "@wardenx/types";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { TerminusDeps } from "../terminus/deps";
import { countStuckTerminusActions } from "../terminus/ledger";
import { actorOf } from "./actor";
import { ABAC_IN_ORG, ABAC_SOS_RESPONDER, P } from "./guards";
import { SosIdParams, parse } from "./m20-typebox";

const ALERT = schema.safetySosAlert;
const ACTION = schema.safetySosTerminusAction;
const STUCK_AFTER_MS = 120_000;

export const EMERGENCY_LINE_COPY = "Call 911 (or your local emergency number) now.";

export interface TerminusRouteDeps {
  readonly db: DbClient;
  /** Lazy: the registry binds M40's reader at boot; a throw reads as `unavailable`. */
  readonly jurisdictions: () => EmergencyServiceJurisdictionReader;
  /** The terminus effect bag the readiness probe inspects (never its secrets). */
  readonly terminus: () => TerminusDeps | undefined;
  readonly now?: () => Date;
}

export type PsapReason = "resolved" | "none" | "unavailable" | "pending";

export interface PsapResponse {
  readonly sosAlertId: string;
  readonly emergencyLine: string;
  readonly psap: PsapJurisdictionSummary | null;
  readonly reason: PsapReason;
}

export interface TerminusActionView {
  readonly actionKind: string;
  readonly loopIteration: number;
  readonly attemptNo: number;
  readonly status: string;
  readonly outcomeCode: string | null;
  readonly settledAt: string | null;
}

export interface TerminusReadiness {
  readonly opsPagerBound: boolean;
  readonly contactCallerBound: boolean;
  readonly contactDialEnabled: boolean;
  readonly psapReaderBound: boolean;
  readonly stuckActionCount: number;
  readonly degraded: boolean;
  readonly degradedReasons: readonly string[];
}

async function loadTerminusAlert(
  deps: TerminusRouteDeps,
  organizationId: string,
  sosAlertId: string,
): Promise<void> {
  const state = await withOrgContext(deps.db, { organizationId, userId: "" }, async (handle) => {
    const [row] = await (handle as DbClient)
      .select({ lifecycleState: ALERT.lifecycleState })
      .from(ALERT)
      .where(and(eq(ALERT.id, sosAlertId), eq(ALERT.organizationId, organizationId)))
      .limit(1);
    return row?.lifecycleState ?? null;
  });
  if (state === null) throw new NotFoundError("safety_sos_alert", sosAlertId);
  if (state !== "emergency_terminus") {
    throw new ConflictError("the SOS alert is not at the emergency terminus");
  }
}

export async function psapForAlert(
  deps: TerminusRouteDeps,
  organizationId: string,
  sosAlertId: string,
): Promise<PsapResponse> {
  await loadTerminusAlert(deps, organizationId, sosAlertId);
  const latest = await withOrgContext(deps.db, { organizationId, userId: "" }, async (handle) =>
    (handle as DbClient)
      .select({
        status: ACTION.status,
        outcomeCode: ACTION.outcomeCode,
        jurisdictionId: ACTION.jurisdictionId,
      })
      .from(ACTION)
      .where(and(eq(ACTION.sosAlertId, sosAlertId), eq(ACTION.actionKind, "resolve_psap")))
      .orderBy(desc(ACTION.loopIteration)),
  );
  const base = { sosAlertId, emergencyLine: EMERGENCY_LINE_COPY } as const;
  const resolvedRow = latest.find((r) => r.status === "succeeded" && r.jurisdictionId);
  if (resolvedRow?.jurisdictionId) {
    try {
      const summary = await deps
        .jurisdictions()
        .byId(organizationId as OrgId, resolvedRow.jurisdictionId);
      if (summary) return { ...base, psap: summary, reason: "resolved" };
    } catch {
      return { ...base, psap: null, reason: "unavailable" };
    }
    return { ...base, psap: null, reason: "none" };
  }
  const newest = latest[0];
  if (!newest || newest.status === "pending" || newest.status === "attempting") {
    return { ...base, psap: null, reason: "pending" };
  }
  return {
    ...base,
    psap: null,
    reason: newest.outcomeCode === "jurisdiction_none" ? "none" : "unavailable",
  };
}

export async function terminusActionsForAlert(
  deps: TerminusRouteDeps,
  organizationId: string,
  sosAlertId: string,
): Promise<{ readonly sosAlertId: string; readonly actions: readonly TerminusActionView[] }> {
  const rows = await withOrgContext(deps.db, { organizationId, userId: "" }, async (handle) =>
    (handle as DbClient)
      .select({
        actionKind: ACTION.actionKind,
        loopIteration: ACTION.loopIteration,
        attemptNo: ACTION.attemptNo,
        status: ACTION.status,
        outcomeCode: ACTION.outcomeCode,
        settledAt: ACTION.settledAt,
      })
      .from(ACTION)
      .where(and(eq(ACTION.sosAlertId, sosAlertId), eq(ACTION.organizationId, organizationId)))
      .orderBy(desc(ACTION.loopIteration), ACTION.actionKind),
  );
  return {
    sosAlertId,
    actions: rows.map((r) => ({ ...r, settledAt: r.settledAt?.toISOString() ?? null })),
  };
}

export async function terminusReadiness(
  deps: TerminusRouteDeps,
  organizationId: string,
): Promise<TerminusReadiness> {
  const now = (deps.now ?? (() => new Date()))();
  const bag = deps.terminus();
  const stuck = await withOrgContext(deps.db, { organizationId, userId: "" }, (handle) =>
    countStuckTerminusActions(handle as DbClient, organizationId, now, STUCK_AFTER_MS),
  );
  let psapReaderBound = false;
  try {
    deps.jurisdictions();
    psapReaderBound = bag?.jurisdictions !== undefined;
  } catch {
    psapReaderBound = false;
  }
  // DEGRADED = the chain cannot do its job right now: nobody can be paged, or work is stuck. A deliberate
  // OFF switch (contact auto-dial) or a catalog nobody has filled yet is reported by its own flag, not as
  // an outage.
  const reasons = [
    ...(bag?.pager === undefined ? ["ops_pager_unbound"] : []),
    ...(stuck > 0 ? ["unsettled_actions"] : []),
  ];
  return {
    opsPagerBound: bag?.pager !== undefined,
    contactCallerBound: bag?.caller !== undefined,
    contactDialEnabled: bag?.dialEnabled === true,
    psapReaderBound,
    stuckActionCount: stuck,
    degraded: reasons.length > 0,
    degradedReasons: reasons,
  };
}

export function registerTerminusRoutes(app: FastifyInstance, deps: TerminusRouteDeps): void {
  app.get(
    "/api/v1/safety/sos/:sosAlertId/psap",
    {
      preHandler: [P("safety.sos.read"), ABAC_SOS_RESPONDER("safety.sos.read")],
      config: {
        auditRead: {
          resourceKind: "safety_sos_alert",
          resourceIdParam: "sosAlertId",
          fields: ["psap_jurisdiction_id"],
        },
      },
    },
    async (request) => {
      const { sosAlertId } = parse(SosIdParams, request.params);
      return psapForAlert(deps, actorOf(request).organizationId, sosAlertId);
    },
  );

  app.get(
    "/api/v1/safety/sos/:sosAlertId/terminus",
    {
      preHandler: [P("safety.sos.read"), ABAC_SOS_RESPONDER("safety.sos.read")],
      config: {
        auditRead: {
          resourceKind: "safety_sos_alert",
          resourceIdParam: "sosAlertId",
          fields: ["terminus_action_status"],
        },
      },
    },
    async (request) => {
      const { sosAlertId } = parse(SosIdParams, request.params);
      return terminusActionsForAlert(deps, actorOf(request).organizationId, sosAlertId);
    },
  );

  app.get(
    "/api/v1/safety/admin/terminus-readiness",
    {
      preHandler: [P("safety_policy.read"), ABAC_IN_ORG("safety_policy.read")],
      config: {
        auditRead: { none: "operational readiness flags only; no PHI and no contact detail" },
      },
    },
    async (request) => terminusReadiness(deps, actorOf(request).organizationId),
  );
}
