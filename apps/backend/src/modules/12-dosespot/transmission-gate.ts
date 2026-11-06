// apps/backend/src/modules/12-dosespot/transmission-gate.ts — the sign-time decision "queue this signed order for e-prescribing,
// or activate it locally (F-058)?" (tenant onboarding slice 4, ADR-0110).
//
// Before: a SYNCHRONOUS boolean that only asked whether the tenant had a config. A signed order from a prescriber with no DoseSpot
// link was queued and then failed permanently as `prescriber_not_enrolled`. Now the decision reads, inside the SIGNING transaction
// (RLS-scoped, no credential opened), both halves: the org's DoseSpot is LIVE (an `active` registration; an org with no row only
// through the env fallback; a row that is not active never transmits, whatever the env says) AND the signing prescriber is
// linked to DoseSpot. Either missing => the order activates locally, exactly as for an unconfigured tenant.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, isNull } from "drizzle-orm";

const R = schema.dosespotClinicRegistrations;
const P = schema.dosespotPrescribers;

export interface TransmissionFacts {
  /** The org's registration status, or null when it has no row. */
  readonly registrationStatus: string | null;
  /** The org has no row and is served by the env fallback (`DOSESPOT_TENANT_CONFIGS`). */
  readonly envFallback: boolean;
  /** The signing prescriber's DoseSpot id, or null when not linked (or revoked). */
  readonly prescriberVendorId: string | null;
}

export function decideTransmission(f: TransmissionFacts): boolean {
  const live = f.registrationStatus === null ? f.envFallback : f.registrationStatus === "active";
  return live && f.prescriberVendorId !== null;
}

/** The sign path's gate: `true` => enqueue the transmission in the signing transaction. */
export type TransmissionGate = (
  tx: DbClient,
  organizationId: string,
  prescriberMembershipId: string,
) => Promise<boolean>;

export function createTransmissionGate(deps: {
  /** Is this org (with no row of its own) served by the env fallback? */
  readonly envFallbackFor: (organizationId: string) => Promise<boolean>;
}): TransmissionGate {
  return async (tx, organizationId, prescriberMembershipId) => {
    const [registration] = await tx
      .select({ status: R.status })
      .from(R)
      .where(eq(R.organizationId, organizationId))
      .limit(1);
    const registrationStatus = registration?.status ?? null;
    const [prescriber] = await tx
      .select({ id: P.dosespotPrescriberId })
      .from(P)
      .where(
        and(
          eq(P.organizationId, organizationId),
          eq(P.membershipId, prescriberMembershipId),
          isNull(P.revokedAt),
        ),
      )
      .limit(1);
    return decideTransmission({
      registrationStatus,
      envFallback: registrationStatus === null && (await deps.envFallbackFor(organizationId)),
      prescriberVendorId: prescriber?.id ?? null,
    });
  };
}
