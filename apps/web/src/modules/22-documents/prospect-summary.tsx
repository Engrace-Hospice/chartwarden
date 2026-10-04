import { type ApiClient, LoadingSpinner, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/22-documents — the F-238 PROSPECT SUMMARY panel of the DocLens review workspace: once a
// review is complete, GET /api/v1/intake/uploads/:id/summary — the reviewer-approved values as one cited
// picture of the prospect plus copyable plain text (built deterministically by the server; no model). The
// render itself is shared from the shell (`ProspectSummaryView`), so the patient chart's Overview and a
// referral's Records tab show the same thing; it is re-exported here.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { type ProspectSummary, ProspectSummaryView } from "../../shell/prospect-summary";

export {
  PatientIntakeSummaries,
  type ProspectCitation,
  type ProspectSummary,
  ProspectSummaryView,
  SHOWS_INTAKE_SUMMARIES,
  citationText,
} from "../../shell/prospect-summary";

export type ProspectSummaryLoad =
  | { readonly state: "ready"; readonly summary: ProspectSummary }
  | { readonly state: "not_complete" }
  | { readonly state: "error"; readonly message: string };

/** Fetch a batch's prospect summary; a 409 is "not complete yet", never an error. */
export async function loadProspectSummary(
  client: ApiClient,
  batchId: string,
): Promise<ProspectSummaryLoad> {
  const r = await client
    .GET("/api/v1/intake/uploads/{id}/summary", { params: { path: { id: batchId } } })
    .catch(() => null);
  const status = r?.response?.status;
  if (status === 409) return { state: "not_complete" };
  const data = r?.data as ProspectSummary | undefined;
  if (
    !r ||
    r.error ||
    !data ||
    typeof data.plainText !== "string" ||
    !Array.isArray(data.patient)
  ) {
    return {
      state: "error",
      message:
        status === 403
          ? "You do not have access to this intake batch's summary."
          : status === 404
            ? "This intake batch is no longer available to you."
            : "The prospect summary could not be loaded.",
    };
  }
  return { state: "ready", summary: data };
}

/** Fetches and renders a batch's prospect summary. Mount it once the review is complete. */
export function ProspectSummaryPanel({ batchId }: { batchId: string }): JSX.Element {
  const client = useApiClient();
  const [load, setLoad] = useState<ProspectSummaryLoad | null>(null);
  const refresh = useCallback(async () => {
    setLoad(await loadProspectSummary(client, batchId));
  }, [client, batchId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="wx-prospect" aria-label="Prospect summary">
      <header className="wx-prospect-head">
        <h2>Prospect summary</h2>
      </header>
      {load === null ? (
        <LoadingSpinner />
      ) : load.state === "ready" ? (
        <ProspectSummaryView summary={load.summary} />
      ) : load.state === "not_complete" ? (
        <p className="wx-row-sub">The summary is available once the review is complete.</p>
      ) : (
        <p className="wx-row-sub" role="alert">
          {load.message}
        </p>
      )}
    </section>
  );
}
