// apps/web/src/modules/12-dosespot — prescriber medication sign inbox (M12 §4.1/§6.1, Track B / ADR-0030).
// Spec: docs/ui/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Work Queue" (sign inbox). The
// prescriber's queue of medication orders awaiting their signature (status pending_signature), KPI'd by
// controlled-vs-standard, sorted by created. A controlled order signs through the EPCS 2FA path (W-MR-02) —
// surfaced here as a badge; the actual sign step-up (and the verbal-pending section) fill in as their write
// surfaces harden. The SERVER owns the authoritative §2.2 D2 status (ADR-0030 — no frontend authz). Reads
// GET /api/v1/medication-orders?status=pending_signature via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import {
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  useApiClient,
  WorkQueueLayout,
} from "@wardenx/ui";

interface MedRow {
  id: string;
  patientId: string;
  medClass: string;
  status: string;
  drugName: string;
  strength: string;
  isControlledSubstance: boolean;
  deaSchedule: string | null;
  createdAt: string;
}

export function MedicationSignInbox(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<MedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/medication-orders", {
      params: { query: { status: "pending_signature" } },
    });
    if (err) {
      setError("Could not load the medication sign inbox.");
      setLoading(false);
      return;
    }
    setItems((data?.orders ?? []) as MedRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(
    () => ({
      total: items.length,
      controlled: items.filter((o) => o.isControlledSubstance).length,
    }),
    [items],
  );

  const rows = useMemo(
    () => [...items].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    [items],
  );

  return (
    <WorkQueueLayout
      header={<PageHeader title="Medications Awaiting Signature" />}
      kpis={
        <KpiStrip>
          <KpiCard label="Awaiting signature" value={counts.total} />
          <KpiCard label="Controlled (EPCS)" value={counts.controlled} />
        </KpiStrip>
      }
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : rows.length === 0 ? (
          <EmptyState title="No medications awaiting signature" description="The sign inbox is clear." />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280" }}>
                <th style={th}>Drug</th>
                <th style={th}>Class</th>
                <th style={th}>Controlled</th>
                <th style={th}>Created</th>
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
                    {o.drugName} {o.strength}
                  </td>
                  <td style={td}>{o.medClass}</td>
                  <td style={{ ...td, color: o.isControlledSubstance ? "#b45309" : undefined }}>
                    {o.isControlledSubstance ? `C-${o.deaSchedule ?? "?"} · EPCS` : "—"}
                  </td>
                  <td style={td}>{o.createdAt.slice(0, 16).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}

const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
