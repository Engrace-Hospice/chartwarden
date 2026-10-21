// apps/web/src/modules/14-idg — shared name rendering for the IDG screens.
//
// The M14 reads now carry `patient?: { displayName: "First L.", mrnSuffix } | null` on agenda / packets /
// decisions / action items, and `coordinatorMembershipId` on meetings (an id only — names are resolved
// here from GET /orgs/{id}/care-team-staff, the same read the live surface uses). Both are CONTEXT: when the
// server sent no patient, or the member list is unavailable, the id-prefix fallback is shown so a row is
// never blank and nothing is invented.
import { type ApiClient, useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";

export interface PatientRef {
  displayName: string;
  mrnSuffix: string | null;
}

/** First 8 characters of an id — the fallback label everywhere a name is unavailable. */
export const shortId = (id: string): string => id.slice(0, 8);

/** "First L." + muted MRN suffix, or the id prefix when the server sent no patient. */
export function PatientLabel({
  patientId,
  patient,
}: {
  patientId: string;
  patient?: PatientRef | null;
}): JSX.Element {
  if (!patient) return <span className="wx-data-md">{shortId(patientId)}</span>;
  return (
    <span>
      <span style={{ fontWeight: 600 }}>{patient.displayName}</span>
      {patient.mrnSuffix ? (
        <span className="wx-row-sub wx-nums">MRN ···{patient.mrnSuffix}</span>
      ) : null}
    </span>
  );
}

/** Plain-text form of the patient label (search haystacks, aria-labels, notices). */
export const patientText = (patientId: string, patient?: PatientRef | null): string =>
  patient?.displayName ?? shortId(patientId);

export interface StaffName {
  membershipId: string;
  userId: string;
  displayName: string | null;
}

/**
 * The org's staff names from GET /orgs/{id}/care-team-staff (patient.assign or idg.read; name and role
 * only). Not `/orgs/{id}/members`, which needs `member.manage` and so left every clinician with id
 * prefixes. Capped at the route's 200-row limit; empty when the read fails — names are context only.
 */
export async function loadStaffNames(client: ApiClient, orgId: string): Promise<StaffName[]> {
  try {
    const r = await client.GET("/api/v1/orgs/{id}/care-team-staff", {
      params: { path: { id: orgId }, query: { limit: 200 } },
    });
    return (r.data?.staff ?? []).map((m) => ({
      membershipId: m.membershipId,
      userId: m.userId,
      displayName: m.displayName ?? null,
    }));
  } catch {
    return [];
  }
}

/** membershipId → name for the org. Empty until (and unless) the read succeeds. */
export function useMemberNames(orgId: string | null | undefined): Map<string, string> {
  const client = useApiClient();
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!orgId) return;
    let active = true;
    void loadStaffNames(client, orgId).then((rows) => {
      if (!active) return;
      const map = new Map<string, string>();
      for (const m of rows) map.set(m.membershipId, m.displayName ?? "Unnamed staff member");
      setNames(map);
    });
    return () => {
      active = false;
    };
  }, [client, orgId]);
  return names;
}
