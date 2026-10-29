// CW-CLIN-008 — the ordering physician named on a medication draft must be an ACTIVE M40 ExternalPhysician.
// M12 spec §1 (M40 consumption) / §2.1: `prescribing_physician_mdm_id` is the canonical directory record. Prescribing
// AUTHORITY (the DoseSpot roster row) is deliberately NOT checked here: a drafting RN names the physician, and the
// roster is enforced at sign (`requestSignature`) and cosign (`cosignOrder`) against that same id.
import { NotFoundError } from "@chartwarden/types";

/** The slice of M40's `MdmEntityProvider.resolvePhysician` this check needs. */
export interface PhysicianDirectoryPort {
  resolvePhysician(orgId: string, id: string): Promise<{ status: string } | null>;
}

/** Throws a typed 404 unless `mdmId` resolves to an `active` physician (unknown/deactivated/provisional refuse). */
export async function assertPrescribingPhysicianActive(
  directory: PhysicianDirectoryPort,
  organizationId: string,
  mdmId: string,
): Promise<void> {
  const physician = await directory.resolvePhysician(organizationId, mdmId);
  if (physician?.status !== "active")
    throw new NotFoundError(`prescribing physician ${mdmId} is not an active master-data record`);
}
