// apps/web/src/modules/17-scheduling — Time-Off Queue (M17 §5.1 `/app/scheduling/time-off`, Track B / ADR-0030).
// Spec: docs/ui/screens — "Use Work Queue". The supervisor's PTO approval queue: requested time-off with kind +
// window + state. The one-click approve/deny + per-request conflict count write surfaces fill in as those write
// paths harden (approval triggers the SERVER-side reassignment scan); ADR-0030 — no frontend authz. Optional
// `?state=` / `?membership=` filters. Reads GET /api/v1/time-off via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { EmptyState, LoadingSpinner, PageHeader, useApiClient, WorkQueueLayout } from "@wardenx/ui";

interface TimeOffRow {
  id: string;
  membershipId: string;
  kind: string;
  startsAt: string;
  endsAt: string;
  state: string;
}

const stateColor: Record<string, string | undefined> = {
  requested: "#1d4ed8",
  approved: "#15803d",
  denied: "#b91c1c",
  cancelled: "#6b7280",
  consumed: "#6b7280",
};
const ts = (v: string): string => v.slice(0, 16).replace("T", " ");

export function SchedulingTimeOff(): JSX.Element {
  const client = useApiClient();
  const [params] = useSearchParams();
  const state = params.get("state") ?? undefined;
  const membership = params.get("membership") ?? undefined;
  const [rows, setRows] = useState<TimeOffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/time-off", {
      params: { query: { ...(state ? { state } : {}), ...(membership ? { membership } : {}) } },
    });
    if (err) {
      setError("Could not load the time-off queue.");
      setLoading(false);
      return;
    }
    setRows((data ?? []) as TimeOffRow[]);
    setLoading(false);
  }, [client, state, membership]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="Time-Off Queue" />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && rows.length === 0 ? (
          <LoadingSpinner />
        ) : rows.length === 0 ? (
          <EmptyState title="No time-off requests" description="There are no time-off requests in this view." />
        ) : (
          <table style={table}>
            <thead>
              <tr style={tr}>
                <th style={th}>Clinician</th>
                <th style={th}>Kind</th>
                <th style={th}>Starts</th>
                <th style={th}>Ends</th>
                <th style={th}>State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid #f3f4f6" }}>
                  <td style={mono}>{r.membershipId.slice(0, 8)}</td>
                  <td style={td}>{r.kind}</td>
                  <td style={td}>{ts(r.startsAt)}</td>
                  <td style={td}>{ts(r.endsAt)}</td>
                  <td style={{ ...td, color: stateColor[r.state] }}>{r.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}

const table = { width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" } as const;
const tr = { textAlign: "left", color: "#6b7280" } as const;
const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
const mono = { ...td, fontFamily: "monospace", fontSize: "0.8rem" } as const;
