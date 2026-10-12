// The care-team conversation's patient header (moved out of conversation-thread.tsx unchanged in WP 2.2, to keep that
// file under the line ceiling). A stale answer after a channel switch is dropped by the thread's generation.
import { useApiClient } from "@wardenx/ui";
import { useEffect, useState } from "react";
import type { MutableRefObject } from "react";
import type { ChannelSummary, PatientHeaderInfo } from "./messaging-types";

export function usePatientHeader(
  channel: Pick<ChannelSummary, "kind" | "subjectId">,
  generationRef: MutableRefObject<number>,
) {
  const client = useApiClient();
  const [patient, setPatient] = useState<PatientHeaderInfo | null>(null);
  useEffect(() => {
    if (channel.kind !== "care_team" || !channel.subjectId) return;
    const generation = generationRef.current;
    void client
      .GET("/api/v1/patients/{id}", { params: { path: { id: channel.subjectId } } })
      .then(({ data, error }) => {
        if (generation !== generationRef.current) return;
        setPatient(error || !data ? null : (data as PatientHeaderInfo));
      });
  }, [channel.kind, channel.subjectId, client, generationRef]);
  return [patient, setPatient] as const;
}
