import {
  CountdownChip,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
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
import { REFILL_TONE, stateLabel } from "./medication-status";

interface RefillRow {
  id: string;
  patientId: string;
  sourceMedicationOrderId: string;
  status: string;
  requestedAt: string;
}

// §2.7 D9 refill SLA (the SERVER owns the authoritative SLA; this is a UX hint): warn at 48h-age,
// critical at 72h-age. Modeled as a CountdownChip counting down to the 72h critical deadline.
const WARN_HOURS = 48;
const CRITICAL_HOURS = 72;
function criticalDeadline(requestedAt: string): Date {
  return new Date(Date.parse(requestedAt) + CRITICAL_HOURS * 3_600_000);
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
      critical: items.filter((r) => nowMs - Date.parse(r.requestedAt) >= CRITICAL_HOURS * 3600_000)
        .length,
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
          <table>
            <thead>
              <tr>
                <th>Source order</th>
                <th>Status</th>
                <th>Requested</th>
                <th>SLA</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/refills/${r.id}`)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      navigate(`/refills/${r.id}`);
                    }
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <td className="wx-data-md">{r.sourceMedicationOrderId.slice(0, 8)}</td>
                  <td>
                    <StatusPill
                      label={stateLabel(r.status)}
                      tone={REFILL_TONE[r.status] ?? "neutral"}
                    />
                  </td>
                  <td className="tabular-nums">{r.requestedAt.slice(0, 16).replace("T", " ")}</td>
                  <td>
                    {/* warning when ≤24h to the 72h critical deadline (≈ ≥48h old); overdue past 72h. */}
                    <CountdownChip
                      dueAt={criticalDeadline(r.requestedAt)}
                      warnWithinHours={CRITICAL_HOURS - WARN_HOURS}
                      alertWithinHours={0}
                      label="SLA"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}
