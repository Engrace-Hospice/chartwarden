// apps/backend/src/modules/25-remittance/routes/claim-patient.ts - M25 milestone 7a-1: patient attribution for the
// read-audit trail. A route that surfaces a case tied to ONE claim names that claim's patient in its response
// (`patientId`), so the read-audit plugin can attribute the read (`patientIdPayloadPath`). With no source port bound
// (a slice/test) or no single claim (an audit request over many claims, or none) there is no single patient and the
// value is null: such a read is audited against the resource only.
import type { AppealSourcePorts } from "./appeal-packet-sources";

export async function patientOfClaim(
  sources: AppealSourcePorts | undefined,
  organizationId: string,
  claimId: string | null,
): Promise<string | null> {
  if (!sources || !claimId) return null;
  return (await sources.claims().claimCopyForAppeal(organizationId, claimId))?.patientId ?? null;
}
