// apps/backend/src/modules/19-oncall/seams/escalation-router.ts - the real M19 `EscalationRouter` (ADR-0057 item 12), TIER 1 ONLY.
//
// M36 asks "who is on call for role R at tier n for patient P as of T, and is there a tier n+1?". Tier 1 is answered from the
// covering `on_call_shift` of the patient's provider entity: the primary membership's user id plus the backup's. Tier >= 2 is
// `unavailable / tier_not_configured` until a human owner defines what `tenant_oncall_policy.escalation_tiers` means for a chat
// request (ADR-0057 item 12: OWNER NOT NAMED, shape undefined). This router never invents a ladder.
//
// FAIL CLOSED, in this order (every refusal is the same typed answer, so a probe learns nothing):
//   1. orgId is an ASSERTION against the ambient request scope (`assertCallerOrg`); an empty ambient org is refused outright here
//      (the sibling providers let the store refuse; this one also resolves a patient by id, so it must be scoped first).
//   2. malformed request -> THROWS (same codes as the in-memory fake: a bug in the caller, not a routing answer).
//   3. role with no discipline mapping, or tier >= 2 -> `unavailable`. Both are patient-independent ON PURPOSE: deciding them
//      before any patient read means they cannot reveal whether a patient exists.
//   4. patient not found in `orgId` (other org, unknown, non-uuid) -> `unavailable / no_route_configured`, never a throw.
//   5. patient found with no provider entity -> the org's only provider entity, else `no_route_configured` (never a guess).
//   6. the provider entity needs a `direct`/`hybrid` `tenant_oncall_policy` row (the coverage-gap watchdog's rule: no policy means
//      no coverage promise to break, `centralized` has no RN shifts by design) and ONE known IANA zone across its locations.
//   7. a covering shift of the mapped discipline -> `resolved`; no covering shift, or every membership dropped -> `coverage_gap`.
// A store/reader failure THROWS and is never mapped to `coverage_gap` / `unavailable`.
//
// Shift windows are absolute instants (`on_call_shift.shift_starts_at/ends_at`), compared in epoch ms: start inclusive, end
// exclusive, so back-to-back shifts neither gap nor overlap. `timeZone` is the provider entity's location zone and is information
// only; it never moves a boundary. Pure read: no write, no outbox.
import { isKnownTimeZone, parseStrictInstant } from "@wardenx/messaging";
import {
  ESCALATION_MAX_TIER,
  type EscalationRouteAnswer,
  type EscalationRouteRequest,
  type EscalationRouter,
  type EscalationUnavailableReason,
  type IsoInstant,
  type OnCallShiftDto,
  type OncallModel,
  type OncallShiftDiscipline,
  type OrgId,
  type ProviderEntityId,
  WardenXError,
} from "@wardenx/types";
import {
  type OncallSeamOrgResolver,
  assertCallerOrg,
  defaultOncallSeamOrgResolver,
} from "./providers";
import type { OncallSeamStore } from "./store";

/** requiredRole (platform role key M36 sends) -> the shift discipline that answers for it. Unknown role: `no_route_configured`. */
export const ESCALATION_DISCIPLINE_BY_ROLE: Readonly<Record<string, OncallShiftDiscipline>> = {
  rn: "clinical_rn",
};

/** Models whose shifts name members; the watchdog's rule (`centralized` is vendor-covered, so an RN gap there is not a gap). */
const MEMBER_MODELS: readonly OncallModel[] = ["direct", "hybrid"];
const COVERING_STATUSES: readonly string[] = ["scheduled", "active"];
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the router needs beyond the shift store. Every method is scoped to the caller's org by RLS; a failure throws. */
export interface EscalationRouterReads {
  /** The patient's provider entity. `null` = the patient does not resolve in `orgId`; `{providerEntityId: null}` = found, none yet. */
  patientProviderEntity(
    orgId: OrgId,
    patientId: string,
  ): Promise<{ readonly providerEntityId: string | null } | null>;
  providerEntityIdsOfOrg(orgId: OrgId): Promise<readonly string[]>;
  /** The provider entity's `tenant_oncall_policy.model`, or null when it has no policy row. */
  policyModel(providerEntityId: ProviderEntityId): Promise<OncallModel | null>;
  /** Distinct IANA zones of the provider entity's locations. */
  timeZones(providerEntityId: ProviderEntityId): Promise<readonly string[]>;
}

function invalid(message: string): WardenXError {
  return new WardenXError("ESCALATION_REQUEST_INVALID", message, 400);
}

function parseRequest(request: EscalationRouteRequest): number {
  if (
    !Number.isSafeInteger(request.tier) ||
    request.tier < 1 ||
    request.tier > ESCALATION_MAX_TIER
  ) {
    throw invalid(`tier must be an integer 1..${ESCALATION_MAX_TIER}`);
  }
  if (!request.patientId || !request.requiredRole) throw invalid("patient and role are required");
  try {
    return parseStrictInstant(request.asOf);
  } catch {
    throw invalid("asOf must be an ISO-8601 date-time with an explicit offset");
  }
}

async function providerEntityOf(
  reads: EscalationRouterReads,
  orgId: OrgId,
  patientId: string,
): Promise<string | null> {
  if (!UUID_PATTERN.test(patientId)) return null;
  const patient = await reads.patientProviderEntity(orgId, patientId);
  if (patient === null) return null;
  if (patient.providerEntityId !== null) return patient.providerEntityId;
  const all = await reads.providerEntityIdsOfOrg(orgId);
  return all.length === 1 ? (all[0] ?? null) : null;
}

function covers(shift: OnCallShiftDto, discipline: OncallShiftDiscipline, asOfMs: number): boolean {
  return (
    shift.discipline === discipline &&
    COVERING_STATUSES.includes(shift.status) &&
    shift.externalActorId === null &&
    Date.parse(shift.shiftStartsAt) <= asOfMs &&
    asOfMs < Date.parse(shift.shiftEndsAt)
  );
}

/** Primary then backup per shift (active shifts first, as the store orders them), de-duplicated; unresolved memberships dropped. */
async function userIdsOf(
  store: OncallSeamStore,
  shifts: readonly OnCallShiftDto[],
): Promise<readonly string[]> {
  const membershipIds = shifts.flatMap((s) =>
    [s.primaryOnCallMembershipId, s.backupMembershipId].filter((id): id is string => id !== null),
  );
  if (membershipIds.length === 0) return [];
  const byMembership = await store.userIdsForMemberships(membershipIds);
  const userIds = membershipIds.flatMap((id) => {
    const userId = byMembership.get(id);
    return userId === undefined ? [] : [userId];
  });
  return [...new Set(userIds)];
}

export function createEscalationRouter(
  store: OncallSeamStore,
  reads: EscalationRouterReads,
  orgOf: OncallSeamOrgResolver = defaultOncallSeamOrgResolver,
): EscalationRouter {
  return {
    async resolveTier(orgId, request): Promise<EscalationRouteAnswer> {
      assertCallerOrg(orgOf, orgId as OrgId);
      if (orgOf() === "") {
        throw new WardenXError(
          "TRIAGE_SEAM_ORG_MISMATCH",
          "escalation routing requires an organization scope",
          403,
        );
      }
      const asOfMs = parseRequest(request);
      const base = { tier: request.tier, asOf: request.asOf, source: "m19" } as const;
      const unavailable = (reason: EscalationUnavailableReason): EscalationRouteAnswer => ({
        kind: "unavailable",
        reason,
        ...base,
      });

      const discipline = Object.hasOwn(ESCALATION_DISCIPLINE_BY_ROLE, request.requiredRole)
        ? ESCALATION_DISCIPLINE_BY_ROLE[request.requiredRole]
        : undefined;
      if (discipline === undefined) return unavailable("no_route_configured");
      if (request.tier >= 2) return unavailable("tier_not_configured");

      const peId = await providerEntityOf(reads, orgId as OrgId, request.patientId);
      if (peId === null) return unavailable("no_route_configured");
      const providerEntityId = peId as ProviderEntityId;
      const model = await reads.policyModel(providerEntityId);
      if (model === null || !MEMBER_MODELS.includes(model))
        return unavailable("no_route_configured");
      const zones = await reads.timeZones(providerEntityId);
      const [timeZone] = zones;
      if (zones.length !== 1 || timeZone === undefined || !isKnownTimeZone(timeZone))
        return unavailable("no_route_configured");

      const asOfIso = new Date(asOfMs).toISOString() as IsoInstant;
      const shifts = (
        await store.shiftsCoveringForProviderEntity(providerEntityId, asOfIso)
      ).filter((s) => covers(s, discipline, asOfMs));
      const [head, ...rest] = await userIdsOf(store, shifts);
      if (head === undefined) return { kind: "coverage_gap", nextTier: null, timeZone, ...base };
      return { kind: "resolved", userIds: [head, ...rest], nextTier: null, timeZone, ...base };
    },
  };
}
