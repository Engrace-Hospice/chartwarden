// The care-team conversation's patient header (moved out of conversation-thread.tsx unchanged in WP 2.2, to keep that
// file under the line ceiling). The hook owns its staleness: an effect cleanup drops an answer for a previous patient.
// (It cannot share the thread's generation: the thread's reset effect runs after this one and bumps it, which dropped
// every reply: WP 2.11 D1.)
import { useApiClient } from "@wardenx/ui";
import { useEffect, useState } from "react";
import type { ChannelSummary, PatientHeaderInfo } from "./messaging-types";

export function usePatientHeader(channel: Pick<ChannelSummary, "kind" | "subjectId">) {
  const client = useApiClient();
  const [patient, setPatient] = useState<PatientHeaderInfo | null>(null);
  useEffect(() => {
    // The hook owns the header: any change of channel kind or subject drops the previous patient first.
    setPatient(null);
    if (channel.kind !== "care_team" || !channel.subjectId) return;
    let stale = false;
    void client
      .GET("/api/v1/patients/{id}", { params: { path: { id: channel.subjectId } } })
      .then(({ data, error }) => {
        if (stale) return;
        setPatient(error || !data ? null : (data as PatientHeaderInfo));
      })
      // A failed read leaves no patient header: the thread falls back to its plain title and subtitle.
      .catch(() => {
        if (!stale) setPatient(null);
      });
    return () => {
      stale = true;
    };
  }, [channel.kind, channel.subjectId, client]);
  return [patient, setPatient] as const;
}
