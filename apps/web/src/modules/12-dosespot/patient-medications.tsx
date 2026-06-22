// apps/web/src/modules/12-dosespot — patient medication list (M12 §4.1/§6.1, Track B / ADR-0030).
// Spec: docs/ui/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Patient Workspace + Work Queue"
// (medication list, patient chart). Reached from the patient chart "Medications" tab; lists the patient's
// active medications (and, via the status filter, drafts/history) with drug + sig, the §2.2 D2 lifecycle
// status, and the controlled-substance posture. SUD-treatment meds are redacted per the M5 PrivacyFlag
// snapshot SERVER-side (consult of M39 42 CFR Part 2; never a frontend hide, ADR-0030). The prescribe modal
// (the native authoring UI) fills in as its write surface hardens. Reads GET /api/v1/patients/:patientId/
// medications/active and GET /api/v1/medication-orders?patientId via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  EmptyState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  PatientWorkspaceLayout,
  useApiClient,
} from "@wardenx/ui";

interface MedRow {
  id: string;
  patientId: string;
  medClass: string;
  status: string;
  drugName: string;
  strength: string;
  doseForm: string;
  route: string;
  isControlledSubstance: boolean;
  deaSchedule: string | null;
  refillsRemaining: number;
}

const statusColor: Record<string, string | undefined> = {
  active: "#15803d",
  verbal_pending: "#b45309",
  pending_signature: "#b45309",
  discontinued: "#6b7280",
  completed: "#6b7280",
};

export function PatientMedications(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId } = useParams<{ patientId: string }>();
  const [items, setItems] = useState<MedRow[]>([]);
  const [status, setStatus] = useState("active");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    // "active" reads the dedicated active-medications surface; any other status reads the filtered list.
    if (status === "active") {
      const { data, error: err } = await client.GET("/api/v1/patients/{patientId}/medications/active", {
        params: { path: { patientId } },
      });
      if (err) {
        setError("Could not load medications for this patient.");
        setLoading(false);
        return;
      }
      setItems((data?.orders ?? []) as MedRow[]);
      setLoading(false);
      return;
    }
    const { data, error: err } = await client.GET("/api/v1/medication-orders", {
      params: { query: { patientId, status } },
    });
    if (err) {
      setError("Could not load medications for this patient.");
      setLoading(false);
      return;
    }
    setItems((data?.orders ?? []) as MedRow[]);
    setLoading(false);
  }, [client, patientId, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => [...items].sort((a, b) => a.drugName.localeCompare(b.drugName)), [items]);

  return (
    <PatientWorkspaceLayout
      banner={<PageHeader title="Medications" />}
      contextHeader={
        <FilterBar
          actions={
            <button type="button" onClick={() => setStatus("active")}>
              Active
            </button>
          }
        >
          <select aria-label="Medication status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Active</option>
            <option value="draft">draft</option>
            <option value="pending_signature">pending_signature</option>
            <option value="verbal_pending">verbal_pending</option>
            <option value="discontinued">discontinued</option>
            <option value="completed">completed</option>
          </select>
        </FilterBar>
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading && items.length === 0 ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState title="No medications" description="No medications for this patient in this view." />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280" }}>
              <th style={th}>Drug</th>
              <th style={th}>Class</th>
              <th style={th}>Status</th>
              <th style={th}>Controlled</th>
              <th style={th}>Refills</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr
                key={o.id}
                onClick={() => navigate(`/medication-orders/${o.id}`)}
                style={{ cursor: "pointer", borderTop: "1px solid #f3f4f6" }}
              >
                <td style={td}>
                  {o.drugName} {o.strength} {o.doseForm} · {o.route}
                </td>
                <td style={td}>{o.medClass}</td>
                <td style={{ ...td, color: statusColor[o.status] }}>{o.status}</td>
                <td style={{ ...td, color: o.isControlledSubstance ? "#b45309" : undefined }}>
                  {o.isControlledSubstance ? `C-${o.deaSchedule ?? "?"}` : "—"}
                </td>
                <td style={td}>{o.refillsRemaining}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PatientWorkspaceLayout>
  );
}

const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
