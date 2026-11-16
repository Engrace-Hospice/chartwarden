// apps/backend/src/modules/10-hope/routes/hope-route-guards.ts — the small request-side helpers the M10 route
// registrar (`hope-routes.ts`) composes: the caseload narrowing of the org-wide SFV worklist, the amendment
// attribution check, the late-deadline override body rules, the raw-body attestation check and the request facts a
// signature audit row records. Split out so the registrar stays a route inventory. No helper here reads a header:
// the request facts come off `request.context`, which the platform fills at the edge.
import { hasOrgWideScope } from "@chartwarden/auth";
import { assertAuthorBoundToActor, requireAttestation } from "@chartwarden/hope";
import { ROUTE_FORMATS } from "@chartwarden/shared/route-kit";
import { type HopeRfaKind, ValidationError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import type { HopeRouteService, HopeSignatureRequestFacts } from "./service";

/**
 * The patients on a clinician's caseload (GAP-182). `userId` is the M2 USER id (what
 * `patient_assignment.clinician_user_id` keys on).
 */
export type CaseloadLookup = (q: {
  organizationId: string;
  userId: string;
}) => Promise<readonly string[]>;

/**
 * GAP-182 — the caseload narrowing the org-wide HOPE SFV worklist applies. Org-wide scope
 * roles are unrestricted (`null`); everyone else sees their caseload plus the one patient a pinned
 * session names. Fail-CLOSED: a caseload that cannot be resolved narrows to the session patient (or nothing).
 */
export async function listScopeOf(
  request: FastifyRequest,
  lookup: CaseloadLookup,
): Promise<readonly string[] | null> {
  const ctx = request.context;
  if (hasOrgWideScope(ctx.roles)) return null;
  const pinned = ctx.attributes?.sessionPatientId;
  const sessionIds = typeof pinned === "string" && pinned.length > 0 ? [pinned] : [];
  if (!ctx.userId) return sessionIds;
  try {
    const caseload = await lookup({ organizationId: ctx.organizationId, userId: ctx.userId });
    return [...new Set([...caseload, ...sessionIds])];
  } catch (err) {
    request.log.warn({ err }, "HOPE caseload lookup failed — narrowing to the session patient");
    return sessionIds;
  }
}

/**
 * #850: the correct body accepts the SFV author union (RN/NP/MD/LPN/LVN) because the record's RFA kind is
 * only known server-side. The claimed attribution must clear the per-RFA floor AND be one of the ACTOR's own
 * role-derived disciplines, for every RFA kind and every claimed value (never the body's word). An
 * unresolvable id falls to the strict (non-SFV) floor.
 */
export async function assertAmendmentAttribution(
  service: HopeRouteService,
  request: FastifyRequest,
  organizationId: string,
  assessmentId: string,
  claimed: string,
): Promise<void> {
  const facts = await service.loadAssessment(organizationId, assessmentId);
  const rfaKind = (facts?.rfaKind ?? "02_huv1") as HopeRfaKind;
  assertAuthorBoundToActor(rfaKind, claimed, request.context?.roles ?? []);
}

// GAP-015 — `adminOverride` used to be a body boolean any `hope.timepoint.write` holder could set, and it
// lifts the HQRP hard cutoff (`M10_TIMEPOINT_EXPIRED` / `M10_SFV_PAST_DUE`). The catalog defined the gating
// permission `hope.admin.late_deadline_override` and nothing referenced it. Now a request that asks for the
// override must hold that permission (403 otherwise) AND state a justification (422) — which the service
// records on a critical audit event when the override is actually used. The flag only ever ADDS a gate.
// Fail closed on the RAW value: the handler's `parse()` runs `Value.Convert`, which coerces "true"/1 to
// `true` AFTER this gate has run, so a strict `=== true` here let `adminOverride: "true"` skip the permission.
export const adminOverrideRequested = (body: unknown): boolean => {
  const raw = (body as { adminOverride?: unknown } | null | undefined)?.adminOverride;
  return raw !== undefined && raw !== null && raw !== false;
};
export function requireOverrideJustification(body: {
  readonly adminOverride?: boolean;
  readonly adminOverrideJustification?: string;
}): void {
  if (body.adminOverride === true && !body.adminOverrideJustification) {
    throw new ValidationError("an admin deadline override needs a justification", [
      {
        field: "adminOverrideJustification",
        code: "REQUIRED",
        message: "adminOverrideJustification is required with adminOverride",
      },
    ]);
  }
}

/**
 * The attestation, read off the RAW request body BEFORE `parse`: `parse` runs TypeBox `Value.Convert`, which
 * turns `"true"`, `"TRUE"`, `1` and `"1"` into `true` ahead of the schema check, so the typed
 * `attestationConfirmed: true` alone would accept a value the signer never sent as a boolean. Fastify hands
 * the handler the plain JSON body (these routes declare no Fastify schema, so nothing coerces it earlier).
 */
export const requireStrictAttestation = (body: unknown): void =>
  requireAttestation(
    (body as { attestationConfirmed?: unknown } | null | undefined)?.attestationConfirmed,
  );

/**
 * What the signature audit row records about the request, as the request context captured it at the edge (never read
 * off a header here: these describe the caller for the audit trail and decide nothing about authorization). The
 * request id is `request.id`, exactly as the read-audit rows fill `request_id` (a per-process counter). The request's
 * correlation id rides along as a TRACE HINT: a client can choose it (`x-correlation-id`, kept when it is a safe short
 * token), so it ties a row to a request's other records but is never evidence. The session user is only passed when it
 * is a uuid (the `actor_user_id` column is one); the system principal's literal id is not, and stays null.
 * Every uuid `ctx.userId` is a real `user` row: the only other principal, the machine credential, is the literal
 * "system" (`authenticate.ts`), interactive ids come from a Better Auth session snapshot, and AI principals are refused
 * by `rejectAiActor` before a signing route runs, so the `actor_user_id` FK cannot fail on a signature.
 */
export const signatureRequestFacts = (request: FastifyRequest): HopeSignatureRequestFacts => ({
  requestId: request.id,
  ...(request.context?.correlationId ? { correlationId: request.context.correlationId } : {}),
  ...(request.context?.userId && ROUTE_FORMATS.uuid?.(request.context.userId)
    ? { actorUserId: request.context.userId }
    : {}),
  ...(request.context?.ip ? { sourceIp: request.context.ip } : {}),
  ...(request.context?.userAgent ? { userAgent: request.context.userAgent } : {}),
});
