// apps/backend/src/modules/41-billing-commercial/services/scope-guard.ts — the data-level scope checks every M41 service applies
// (defense in depth behind the route's RBAC + ABAC pair). A route-level ABAC predicate proves the actor may act on the provider
// entity NAMED in the request; these functions prove the DATA touched is that entity's and that the actor may reach the patient:
//   - the provider entity is in the actor's billing scope (`billingScope`, the same `billingScopeReach` rule M23 applies);
//   - the patient is bound to that provider entity through the M6 admission (`admission.provider_entity_id`), so a scoped actor
//     cannot read or write another entity's patient by pairing it with their own entity id;
//   - the patient is in the actor's caseload (M5 `CaseloadProvider`, the `caseload_membership` source), unless the actor's billing
//     scope is organization-wide (the M23 `claim_in_billing_manager_caseload` rule).
// Absent `billingScope` fails CLOSED: no reach.
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import type { CommercialActor, CommercialClaimSeams } from "./types";

type ScopedActor = Pick<CommercialActor, "organizationId" | "userId" | "billingScope">;
type CaseloadSeam = Pick<CommercialClaimSeams["caseload"], "isInCaseload">;

/** A provider entity outside the actor's scope is reported as absent, never as forbidden (no existence oracle). */
export function assertProviderInScope(actor: ScopedActor, providerEntityId: string): void {
  const scope = actor.billingScope;
  if (!scope || !(scope.all || scope.providerEntityIds.includes(providerEntityId))) {
    throw new NotFoundError("provider entity");
  }
}

/** Organization-wide billing roles and the system principal skip the per-patient axis; everyone else must have the patient. */
export async function assertPatientReachable(
  actor: ScopedActor,
  caseload: CaseloadSeam,
  patientId: string,
): Promise<void> {
  if (actor.billingScope?.all === true) return;
  const ok =
    actor.userId !== "" &&
    (await caseload.isInCaseload({
      organizationId: actor.organizationId,
      userId: actor.userId,
      patientId,
    }));
  if (!ok) throw new NotFoundError("patient");
}

/**
 * The patient's admission (the most recent one overlapping `range`) must belong to `providerEntityId`. An admission with no
 * recorded provider entity cannot be bound, so it is refused rather than guessed.
 */
export async function assertPatientBoundToProvider(
  admission: CommercialClaimSeams["admission"],
  organizationId: string,
  patientId: string,
  providerEntityId: string,
  range: { from: string; to: string },
): Promise<NonNullable<Awaited<ReturnType<CommercialClaimSeams["admission"]["resolveForRange"]>>>> {
  const adm = await admission.resolveForRange(organizationId, patientId, range);
  if (!adm) {
    throw new ChartWardenError(
      "PATIENT_NOT_ELECTED",
      "no hospice admission covers the service window",
      409,
    );
  }
  if (adm.providerEntityId == null || adm.providerEntityId !== providerEntityId) {
    throw new NotFoundError("patient");
  }
  return adm;
}

/** Provider scope, then caseload, for a stored row (claim or authorization) the actor is about to read or change. */
export async function assertRowReachable(
  actor: ScopedActor,
  caseload: CaseloadSeam,
  row: { providerEntityId: string; patientId: string },
): Promise<void> {
  assertProviderInScope(actor, row.providerEntityId);
  await assertPatientReachable(actor, caseload, row.patientId);
}
