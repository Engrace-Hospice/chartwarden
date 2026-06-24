// apps/web/src/modules/12-dosespot — refill inbox (M12 §4.1/§6.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Work Queue" (refill inbox). The
// prescriber / clinical-supervisor queue of pending refill requests (§2.7 D9), sorted by request age (a proxy
// for SLA priority — the SERVER owns the authoritative 48h-warn / 72h-critical SLA, §2.7). The refill_inbox_scope
// ABAC predicate narrows the list server-side to the caller's caseload OR the orders they prescribe (ADR-0030 —
// no frontend authz; the patient name is SUD-consent-gated server-side). The approve/deny actions live on the
// detail screen as their write surface hardens. Reads GET /api/v1/refills via the typed client.
// Leaves only (@wardenx/ui).
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

interface RefillRow {
  id: string;
  patientId: string;
  sourceMedicationOrderId: string;
  status: string;
  requestedAt: string;
}

const WARN_HOURS = 48;
const CRITICAL_HOURS = 72;

// Pure SLA-age cue — the SERVER owns the authoritative SLA; this is a UX hint sorted by request age (§2.7 D9).
function slaCue(requestedAt: string, nowMs: number): { label: string; color?: string } {
  const hours = Math.floor((nowMs - Date.parse(requestedAt)) / (60 * 60 * 1000));
  const label = `${hours}h`;
  if (hours >= CRITICAL_HOURS) return { label, color: "#b91c1c" };
  if (hours >= WARN_HOURS) return { label, color: "#b45309" };
  return { label };
}

export function RefillInbox(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<RefillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/refills", {});
    if (err) {
      setError("Could not load the refill inbox.");
      setLoading(false);
      return;
    }
    setItems((data?.refills ?? []) as RefillRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const nowMs = Date.now();
  const counts = useMemo(
    () => ({
      total: items.length,
      critical: items.filter(
        (r) => nowMs - Date.parse(r.requestedAt) >= CRITICAL_HOURS * 3600_000,
      ).length,
    }),
    [items, nowMs],
  );

  const rows = useMemo(
    () => [...items].sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt)),
    [items],
  );

  return (
    <WorkQueueLayout
      header={<PageHeader title="Refill Inbox" />}
      kpis={
        <KpiStrip>
          <KpiCard label="Pending refills" value={counts.total} />
          <KpiCard label="SLA critical (72h+)" value={counts.critical} />
        </KpiStrip>
      }
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : rows.length === 0 ? (
          <EmptyState title="No pending refills" description="The refill inbox is clear." />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280" }}>
                <th style={th}>Source order</th>
                <th style={th}>Status</th>
                <th style={th}>Requested</th>
                <th style={th}>Age</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const c = slaCue(r.requestedAt, nowMs);
                return (
                  <tr
                    key={r.id}
                    onClick={() => navigate(`/refills/${r.id}`)}
                    style={{ cursor: "pointer", borderTop: "1px solid #f3f4f6" }}
                  >
                    <td style={td}>{r.sourceMedicationOrderId.slice(0, 8)}</td>
                    <td style={td}>{r.status}</td>
                    <td style={td}>{r.requestedAt.slice(0, 16).replace("T", " ")}</td>
                    <td style={{ ...td, color: c.color, fontWeight: c.color ? 600 : undefined }}>
                      {c.label}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      }
    />
  );
}

const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
