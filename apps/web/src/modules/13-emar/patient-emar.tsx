// apps/web/src/modules/13-emar — patient eMAR (M13 §4.1/§6.1 #1, Track B / ADR-0030).
// Spec: docs/ui/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Patient Workspace + MAR Grid". The
// bedside default landing surface: a projection of the next-window scheduled doses (the timeline; one row per
// scheduled dose with its pending/administered/missed/cancelled chip) alongside the patient's recent
// administrations (committed / pending-caregiver-review / superseded / voided). The Single-Dose / PRN / Witness
// administration modals (write paths) and the offline on-device queue fill in as their write surfaces harden;
// the SERVER owns the §2.2 lifecycle, the §2.5 late-entry tier, and the §7.2 SUD read gate (SUD-flagged rows
// skipped without a Part 2 release — never a frontend hide, ADR-0030). Reads GET /api/v1/scheduled-doses?patient
// and GET /api/v1/administrations?patient via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  PatientWorkspaceLayout,
  useApiClient,
} from "@wardenx/ui";

interface ScheduledDoseRow {
  id: string;
  patientId: string;
  medicationOrderId: string;
  dueAt: string;
  status: string;
}
interface AdministrationRow {
  id: string;
  patientId: string;
  medicationOrderId: string;
  mode: string;
  status: string;
  actorKind: string;
  administeredAt: string;
  lateEntryTier: string;
  isControlledSubstance: boolean;
  requiresRnReview: boolean;
}

const doseColor: Record<string, string | undefined> = {
  pending: "#374151",
  due_now: "#b45309",
  overdue: "#b91c1c",
  administered: "#15803d",
  missed: "#b91c1c",
  cancelled: "#6b7280",
};
const ts = (v: string): string => v.slice(0, 16).replace("T", " ");

export function PatientEmar(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId } = useParams<{ patientId: string }>();
  const [doses, setDoses] = useState<ScheduledDoseRow[]>([]);
  const [admins, setAdmins] = useState<AdministrationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    const [d, a] = await Promise.all([
      client.GET("/api/v1/scheduled-doses", { params: { query: { patient: patientId } } }),
      client.GET("/api/v1/administrations", { params: { query: { patient: patientId } } }),
    ]);
    if (d.error || a.error) {
      setError("Could not load the eMAR for this patient.");
      setLoading(false);
      return;
    }
    setDoses((d.data ?? []) as ScheduledDoseRow[]);
    setAdmins((a.data ?? []) as AdministrationRow[]);
    setLoading(false);
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const timeline = useMemo(
    () => [...doses].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt)),
    [doses],
  );
  const given = useMemo(
    () => [...admins].sort((a, b) => Date.parse(b.administeredAt) - Date.parse(a.administeredAt)),
    [admins],
  );

  return (
    <PatientWorkspaceLayout banner={<PageHeader title="eMAR" />}>
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading && doses.length === 0 && admins.length === 0 ? (
        <LoadingSpinner />
      ) : (
        <div style={{ display: "grid", gap: "1.5rem" }}>
          <section>
            <h3 style={h3}>Scheduled doses</h3>
            {timeline.length === 0 ? (
              <EmptyState title="No doses scheduled" description="No doses scheduled in this window." />
            ) : (
              <table style={table}>
                <thead>
                  <tr style={tr}>
                    <th style={th}>Due</th>
                    <th style={th}>Order</th>
                    <th style={th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {timeline.map((s) => (
                    <tr key={s.id} style={{ borderTop: "1px solid #f3f4f6" }}>
                      <td style={td}>{ts(s.dueAt)}</td>
                      <td style={td}>{s.medicationOrderId.slice(0, 8)}</td>
                      <td style={{ ...td, color: doseColor[s.status] }}>{s.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section>
            <h3 style={h3}>Administrations</h3>
            {given.length === 0 ? (
              <EmptyState title="No administrations" description="No administrations recorded for this patient." />
            ) : (
              <table style={table}>
                <thead>
                  <tr style={tr}>
                    <th style={th}>Administered</th>
                    <th style={th}>Mode</th>
                    <th style={th}>Status</th>
                    <th style={th}>Tier</th>
                    <th style={th}>Controlled</th>
                  </tr>
                </thead>
                <tbody>
                  {given.map((a) => (
                    <tr
                      key={a.id}
                      onClick={() => navigate(`/patients/${patientId}/administrations/${a.id}`)}
                      style={{ cursor: "pointer", borderTop: "1px solid #f3f4f6" }}
                    >
                      <td style={td}>{ts(a.administeredAt)}</td>
                      <td style={td}>{a.mode}</td>
                      <td style={{ ...td, color: a.requiresRnReview ? "#b45309" : undefined }}>
                        {a.status}
                        {a.requiresRnReview ? " · review" : ""}
                      </td>
                      <td style={{ ...td, color: a.lateEntryTier !== "normal" ? "#b45309" : undefined }}>
                        {a.lateEntryTier}
                      </td>
                      <td style={{ ...td, color: a.isControlledSubstance ? "#b45309" : undefined }}>
                        {a.isControlledSubstance ? "controlled" : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </PatientWorkspaceLayout>
  );
}

const h3 = { fontSize: "0.9rem", fontWeight: 600, margin: "0 0 0.5rem" } as const;
const table = { width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" } as const;
const tr = { textAlign: "left", color: "#6b7280" } as const;
const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
