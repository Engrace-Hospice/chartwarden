import {
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/13-emar — missed-dose inbox (M13 §4.1/§6.1 #8, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Work Queue" (missed-dose queue /
// chart-level banner). The queue of unacknowledged missed doses for a patient, KPI'd by acknowledged-vs-open,
// sorted oldest-first. NOTE: the §6.1 #8 spec proposes `/admin/missed-doses` as a global queue, but the M13
// read route requires a `patient` query (architecture/route wins, ADR-0030), so this surface is patient-scoped
// (a chart-level inbox). The acknowledge write action fills in as its write surface hardens; the SERVER owns
// the §2.5 missed-dose detection (ADR-0030). Reads GET /api/v1/missed-doses?patient via the typed client.
// Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";

interface MissedDoseRow {
  id: string;
  patientId: string;
  scheduledDoseId: string;
  medicationOrderId: string;
  dueAt: string;
  acknowledgedAt: string | null;
}

const ts = (v: string): string => v.slice(0, 16).replace("T", " ");

export function MissedDoseInbox(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
  const [items, setItems] = useState<MissedDoseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/missed-doses", {
      params: { query: { patient: patientId } },
    });
    if (err) {
      setError("Could not load the missed-dose inbox.");
      setLoading(false);
      return;
    }
    setItems((data ?? []) as MissedDoseRow[]);
    setLoading(false);
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(
    () => ({ total: items.length, open: items.filter((m) => !m.acknowledgedAt).length }),
    [items],
  );
  const rows = useMemo(
    () => [...items].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt)),
    [items],
  );

  return (
    <WorkQueueLayout
      header={<PageHeader title="Missed Doses" />}
      kpis={
        <KpiStrip>
          <KpiCard label="Missed doses" value={counts.total} />
          <KpiCard label="Unacknowledged" value={counts.open} />
        </KpiStrip>
      }
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : rows.length === 0 ? (
          <EmptyState title="No missed doses" description="No missed doses for this patient." />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Due</th>
                <th>Order</th>
                <th>Acknowledged</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td className="tabular-nums">{ts(m.dueAt)}</td>
                  <td className="wx-data-md">{m.medicationOrderId.slice(0, 8)}</td>
                  <td>
                    {m.acknowledgedAt ? (
                      <span className="tabular-nums" style={{ color: "var(--color-on-surface)" }}>
                        {ts(m.acknowledgedAt)}
                      </span>
                    ) : (
                      <StatusPill label="Open" tone="error" />
                    )}
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
