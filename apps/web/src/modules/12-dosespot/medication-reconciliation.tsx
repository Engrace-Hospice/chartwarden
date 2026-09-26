import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  PatientWorkspaceLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/12-dosespot — medication-history reconciliation (M12 §4.1/§6.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Patient Workspace + Work Queue"
// (medication reconciliation). The MedHx pulled from DoseSpot is shown as a worksheet: drug + source. Each
// row carries a carry_forward | discontinue | document_only action (POST .../reconcile) — carry_forward opens
// the prescribe modal pre-filled — which fills in as its write surface hardens. The SERVER enforces the
// caseload ABAC + SUD redaction (ADR-0030 — no frontend authz). Reads GET /api/v1/patients/:patientId/
// medications/history via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { stateLabel } from "./medication-status";

interface HistoryRow {
  id: string;
  drugName: string;
  source: string;
}

export function MedicationReconciliation(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
  const [items, setItems] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET(
      "/api/v1/patients/{patientId}/medications/history",
      {
        params: { path: { patientId } },
      },
    );
    if (err) {
      setError("Could not load the medication history.");
      setLoading(false);
      return;
    }
    setItems((data?.records ?? []) as HistoryRow[]);
    setLoading(false);
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <PatientWorkspaceLayout banner={<PageHeader title="Medication Reconciliation" />}>
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading && items.length === 0 ? (
        <LoadingSpinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No medication history"
          description="No DoseSpot medication-history records for this patient."
        />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Drug</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td>{r.drugName}</td>
                <td>{stateLabel(r.source)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PatientWorkspaceLayout>
  );
}
