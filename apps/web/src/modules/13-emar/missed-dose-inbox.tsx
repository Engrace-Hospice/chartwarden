import {
  Button,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/13-emar — missed-dose inbox (M13 §4.1/§6.1 #8, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_MEDICATIONS_EMAR.md — "Use Work Queue" (missed-dose queue /
// chart-level banner). The queue of unacknowledged missed doses for a patient, KPI'd by acknowledged-vs-open,
// sorted oldest-first. NOTE: the §6.1 #8 spec proposes `/admin/missed-doses` as a global queue, but the M13
// read route requires a `patient` query (architecture/route wins, ADR-0030), so this surface is patient-scoped
// (a chart-level inbox). F-031 — the acknowledge action is live: `POST /api/v1/missed-doses/{id}/acknowledge`
// per row, gated by the same `administration.acknowledge_missed` key the server enforces. Acknowledging is
// the case manager's statement that they have SEEN the miss; it does not un-miss the dose, so the row stays
// on the queue with its acknowledged stamp rather than disappearing. The SERVER owns the §2.5 missed-dose
// detection (ADR-0030). Reads GET /api/v1/missed-doses?patient via the typed client.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import {
  type MissedDoseView,
  acknowledgeMissedDose,
  errorMessage,
  listMissedDoses,
} from "./emar-api";
import { formatLocalTs } from "./emar-status";

const ts = formatLocalTs;

export function MissedDoseInbox(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
  const [items, setItems] = useState<MissedDoseView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acking, setAcking] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    const { missed, error: err } = await listMissedDoses(client, { patient: patientId });
    if (err) {
      setError("Could not load the missed-dose inbox.");
      setLoading(false);
      return;
    }
    setItems(missed);
    setLoading(false);
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const acknowledge = useCallback(
    async (id: string) => {
      setAcking(id);
      setActionError(null);
      const { error: err } = await acknowledgeMissedDose(client, id);
      setAcking(null);
      if (err) {
        setActionError(errorMessage(err, "The acknowledgment could not be recorded."));
        return;
      }
      void load();
    },
    [client, load],
  );

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
          <>
            {actionError ? (
              <p role="alert" style={{ color: "var(--color-error)", fontSize: "0.8rem" }}>
                {actionError}
              </p>
            ) : null}
            <table>
              <thead>
                <tr>
                  <th>Due</th>
                  <th>Order</th>
                  <th>Acknowledged</th>
                  <th>Action</th>
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
                    <td>
                      {m.acknowledgedAt ? null : (
                        <Button
                          size="sm"
                          tone="secondary"
                          loading={acking === m.id}
                          disabled={acking !== null}
                          onClick={() => void acknowledge(m.id)}
                        >
                          Acknowledge
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )
      }
    />
  );
}
