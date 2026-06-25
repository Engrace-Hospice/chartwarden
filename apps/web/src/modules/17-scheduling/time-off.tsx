import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/17-scheduling — Time-Off Queue (M17 §5.1 `/app/scheduling/time-off`, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Work Queue". The supervisor's PTO approval queue: requested time-off with kind +
// window + state. The one-click approve/deny + per-request conflict count write surfaces fill in as those write
// paths harden (approval triggers the SERVER-side reassignment scan); ADR-0030 — no frontend authz. Optional
// `?state=` / `?membership=` filters. Reads GET /api/v1/time-off via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { TIMEOFF_TONE, stateLabel } from "./scheduling-status";

interface TimeOffRow {
  id: string;
  membershipId: string;
  kind: string;
  startsAt: string;
  endsAt: string;
  state: string;
}

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
          <EmptyState
            title="No time-off requests"
            description="There are no time-off requests in this view."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Clinician</th>
                <th>Kind</th>
                <th>Starts</th>
                <th>Ends</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="wx-data-md">{r.membershipId.slice(0, 8)}</td>
                  <td>{stateLabel(r.kind)}</td>
                  <td className="tabular-nums">{ts(r.startsAt)}</td>
                  <td className="tabular-nums">{ts(r.endsAt)}</td>
                  <td>
                    <StatusPill
                      label={stateLabel(r.state)}
                      tone={TIMEOFF_TONE[r.state] ?? "neutral"}
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
