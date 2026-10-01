// apps/web/src/modules/14-idg — shared name rendering for the IDG screens.
//
// The M14 reads now carry `patient?: { displayName: "First L.", mrnSuffix } | null` on agenda / packets /
// decisions / action items, and `coordinatorMembershipId` on meetings (an id only — names are resolved
// here from GET /orgs/{id}/members, the same read the live surface uses). Both are CONTEXT: when the
// server sent no patient, or the member list is unavailable, the id-prefix fallback is shown so a row is
// never blank and nothing is invented.
import { useApiClient } from "@wardenx/ui";
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

interface MemberRow {
  membershipId: string;
  displayName: string | null;
  email: string | null;
}

/** membershipId → name/email for the org. Empty until (and unless) the read succeeds. */
export function useMemberNames(orgId: string | null | undefined): Map<string, string> {
  const client = useApiClient();
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!orgId) return;
    let active = true;
    void client
      .GET("/api/v1/orgs/{id}/members", { params: { path: { id: orgId }, query: {} } })
      .then((r) => {
        if (!active) return;
        const map = new Map<string, string>();
        const rows = (r.data as { members?: MemberRow[] } | undefined)?.members;
        for (const m of Array.isArray(rows) ? rows : []) {
          const label = m.displayName ?? m.email;
          if (label) map.set(m.membershipId, label);
        }
        setNames(map);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, orgId]);
  return names;
}
