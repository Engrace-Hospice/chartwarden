import { EmptyState, LoadingSpinner, PageHeader, StatusPill, WorkQueueLayout, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/26-cap — M26, the THRESHOLD EVENT QUEUE (R2, §5.1.4). The reviewer-oriented queue of
// band transitions (90/95/100 aggregate · 18/20 inpatient) for billing managers + compliance officers.
// Acknowledge is a server-authoritative mutation gated on cap.event.acknowledge; this read surface gates nav
// visibility only (ADR-0030). Lantern: WorkQueueLayout + No-Line table + §6.6 StatusPill; CSS-var tokens only.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { BAND_TONE, humanize, shortDate, toneOf } from "./cap-status";

interface EventRow {
  id: string;
  scope: string;
  patientId: string | null;
  priorBand: string;
  currentBand: string;
  raisedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

const cell = { padding: "0.55rem 0.75rem", textAlign: "left" as const };
const head = { ...cell, fontSize: "0.72rem", textTransform: "uppercase" as const, letterSpacing: "0.04em", color: "var(--color-on-surface-variant)", fontWeight: 600 };
const row = { borderTop: "1px solid var(--color-surface-container)" };

export function CapEvents(): JSX.Element {
  const client = useApiClient();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/cap/threshold-events", { params: { query: { unacknowledgedOnly: "true" } } } as never);
    if (res.error) {
      setError("Threshold events are unavailable — you may lack cap visibility.");
      setLoading(false);
      return;
    }
    setEvents((res.data as unknown as EventRow[]) ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const state = (e: EventRow): string => (e.resolvedAt ? "Resolved" : e.acknowledgedAt ? "Acknowledged" : "Unacknowledged");

  return (
    <WorkQueueLayout
      header={<PageHeader title="Threshold Events" breadcrumb="Revenue Cycle — cap band transitions" />}
      table={
      events.length === 0 ? (
        <EmptyState title="No open events" description="No unacknowledged cap-band transitions. The cap is within band." />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
          <thead>
            <tr>
              <th style={head}>Scope</th>
              <th style={head}>Patient</th>
              <th style={head}>Transition</th>
              <th style={head}>Raised</th>
              <th style={head}>State</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} style={row}>
                <td style={cell}>{humanize(e.scope)}</td>
                <td style={{ ...cell, fontVariantNumeric: "tabular-nums" }}>{e.patientId?.slice(0, 8) ?? "—"}</td>
                <td style={cell}>
                  <StatusPill tone={toneOf(BAND_TONE, e.currentBand)} label={`${humanize(e.priorBand)} → ${humanize(e.currentBand)}`} />
                </td>
                <td style={cell}>{shortDate(e.raisedAt)}</td>
                <td style={cell}>{state(e)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )
      }
    />
  );
}
