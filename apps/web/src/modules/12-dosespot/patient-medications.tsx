import {
  Button,
  EmptyState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  PatientWorkspaceLayout,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/12-dosespot — patient medication list (M12 §4.1/§6.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Patient Workspace + Work Queue"
// (medication list, patient chart). Reached from the patient chart "Medications" tab; lists the patient's
// active medications (and, via the status filter, drafts/history) with drug + sig, the §2.2 D2 lifecycle
// status, and the controlled-substance posture. SUD-treatment meds are redacted per the M5 PrivacyFlag
// snapshot SERVER-side (consult of M39 42 CFR Part 2; never a frontend hide, ADR-0030). The prescribe modal
// (the native authoring UI) fills in as its write surface hardens. Reads GET /api/v1/patients/:patientId/
// medications/active and GET /api/v1/medication-orders?patientId via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { MED_ORDER_TONE, controlledLabel, stateLabel } from "./medication-status";
import { loadPatientAdmissions } from "./medications-api";
import { PrescribeModal } from "./prescribe-modal";

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

export function PatientMedications(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId } = useParams<{ patientId: string }>();
  const [items, setItems] = useState<MedRow[]>([]);
  const [admissionId, setAdmissionId] = useState<string | null>(null);
  const [prescribing, setPrescribing] = useState(false);
  const [status, setStatus] = useState("active");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!patientId) return;
    // The admission the new order is documented against. An OPEN one, newest first; a patient with only
    // discharged admissions is not currently under care and prescribing into one would be wrong.
    void loadPatientAdmissions(client, patientId).then((rows) =>
      setAdmissionId(rows.find((a) => a.dischargedAt == null)?.id ?? null),
    );
    setLoading(true);
    setError(null);
    // "active" reads the dedicated active-medications surface; any other status reads the filtered list.
    if (status === "active") {
      const { data, error: err } = await client.GET(
        "/api/v1/patients/{patientId}/medications/active",
        {
          params: { path: { patientId } },
        },
      );
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

  const rows = useMemo(
    () => [...items].sort((a, b) => a.drugName.localeCompare(b.drugName)),
    [items],
  );

  return (
    <PatientWorkspaceLayout
      banner={
        <PageHeader
          title="Medications"
          actions={
            admissionId ? (
              <Button onClick={() => setPrescribing(true)}>Prescribe</Button>
            ) : undefined
          }
        />
      }
      contextHeader={
        <FilterBar
          actions={
            <button type="button" onClick={() => setStatus("active")}>
              Active
            </button>
          }
        >
          <select
            aria-label="Medication status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="active">Active</option>
            <option value="draft">Draft</option>
            <option value="pending_signature">Pending Signature</option>
            <option value="verbal_pending">Verbal Pending</option>
            <option value="discontinued">Discontinued</option>
            <option value="completed">Completed</option>
          </select>
        </FilterBar>
      }
    >
      {patientId && admissionId ? (
        <PrescribeModal
          open={prescribing}
          patientId={patientId}
          admissionId={admissionId}
          onClose={() => setPrescribing(false)}
          onCreated={(order) => navigate(`/medication-orders/${order.id}`)}
        />
      ) : null}
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading && items.length === 0 ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No medications"
          description="No medications for this patient in this view."
        />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Drug</th>
              <th>Class</th>
              <th>Status</th>
              <th>Controlled</th>
              <th>Refills</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr
                key={o.id}
                // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/medication-orders/${o.id}`)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    navigate(`/medication-orders/${o.id}`);
                  }
                }}
                style={{ cursor: "pointer" }}
              >
                <td>
                  {o.drugName} {o.strength} {o.doseForm} · {o.route}
                </td>
                <td>{stateLabel(o.medClass)}</td>
                <td>
                  <StatusPill
                    label={stateLabel(o.status)}
                    tone={MED_ORDER_TONE[o.status] ?? "neutral"}
                  />
                </td>
                <td>
                  {/* §10 — controlled-substance / EPCS is the one place the gold `critical` tone is used. */}
                  {o.isControlledSubstance ? (
                    <StatusPill
                      label={controlledLabel(o.deaSchedule)}
                      tone="critical"
                      glyph="alert"
                    />
                  ) : (
                    <span style={{ color: "var(--color-muted)" }}>—</span>
                  )}
                </td>
                <td className="tabular-nums">{o.refillsRemaining}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PatientWorkspaceLayout>
  );
}
