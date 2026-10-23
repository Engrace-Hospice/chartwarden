// apps/admin/src/modules/34-saas-platform — name / MRN lookup that fills the DSAR queue's patient filter (#672).
// Backed by GET /api/v1/patients/messaging-search: tenant-scoped in SQL, narrowed to the actor's caseload unless
// they hold an org-wide scope role, and projected to the minimum needed to tell two patients apart. Seeing a
// patient here grants nothing; the DSAR routes still authorize the job. An actor without `patient.read` gets
// "Lookup unavailable." from the field and falls back to typing the id.
import { EntityLookupField, useApiClient } from "@chartwarden/ui";
import type { EntityLookupLoadInput, EntityLookupLoadResult } from "@chartwarden/ui";
import { useCallback, useState } from "react";
import type { JSX } from "react";

const MIN_QUERY_CHARS = 2;

export function PatientFinder({
  value,
  onPick,
}: {
  value: string;
  onPick: (patientId: string) => void;
}): JSX.Element {
  const client = useApiClient();
  // Only an id that came from a pick shows in this field; a pasted id lives in the raw "Patient id" field.
  const [picked, setPicked] = useState("");
  const loadOptions = useCallback(
    async ({ query, limit }: EntityLookupLoadInput): Promise<EntityLookupLoadResult> => {
      const { data, error } = await client.GET("/api/v1/patients/messaging-search", {
        params: { query: { q: query, limit } },
      });
      if (error) throw error;
      return {
        options: (data?.patients ?? []).map((p) => ({
          id: p.patientId,
          label: p.displayName,
          searchLabel: p.displayName,
          description: p.medicalRecordNumber ? `MRN ${p.medicalRecordNumber}` : undefined,
        })),
        nextCursor: null,
      };
    },
    [client],
  );
  return (
    <EntityLookupField
      label="Find patient"
      placeholder="Name or MRN"
      hint="Pick a patient to fill the id filter."
      value={picked !== "" && picked === value ? picked : ""}
      onChange={(id) => {
        setPicked(id);
        onPick(id);
      }}
      noMatchesContent="No match among the patients you can see. Paste the patient id below."
      loadOptions={loadOptions}
      minQueryLength={MIN_QUERY_CHARS}
      pageSize={10}
    />
  );
}
