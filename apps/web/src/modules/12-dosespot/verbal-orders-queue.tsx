// apps/web/src/modules/12-dosespot — verbal medication-orders queue (M12 §4.1/§6.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Work Queue" (verbal-orders). The named
// prescriber's queue of verbal_pending medication orders awaiting their signature within the 48h window
// (42 CFR 418.104(b); the M11 OrderSignatureProvider verbal primitive). Sorted by created (the per-order
// deadline lives on the M11 verbal record). Controlled substances may NOT be ordered verbally in Phase 1
// (D18, `dosespot.epcs` OFF) — they never appear here. The sign step-up fills in as its write surface
// hardens; the SERVER owns the §2.2 D2 status (ADR-0030 — no frontend authz). Reads
// GET /api/v1/medication-orders?status=verbal_pending via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import {
  EmptyState,
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
  prescribingPhysicianMdmId: string;
  createdAt: string;
}

export function VerbalMedicationOrdersQueue(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<MedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/medication-orders", {
      params: { query: { status: "verbal_pending" } },
    });
    if (err) {
      setError("Could not load the verbal medication-orders queue.");
      setLoading(false);
      return;
    }
    setItems((data?.orders ?? []) as MedRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(
    () => [...items].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    [items],
  );

  return (
    <WorkQueueLayout
      header={<PageHeader title="Verbal Medication Orders" />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No verbal medication orders pending"
            description="No verbal medication orders are awaiting signature."
          />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280" }}>
                <th style={th}>Drug</th>
                <th style={th}>Class</th>
                <th style={th}>Named prescriber</th>
                <th style={th}>Recorded</th>
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
                  <td style={td}>{o.prescribingPhysicianMdmId}</td>
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
