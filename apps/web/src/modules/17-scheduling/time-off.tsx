import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/17-scheduling — Time-Off Queue (M17 §5.1 `/app/scheduling/time-off`, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Work Queue". The supervisor's PTO approval queue: requested time-off with kind +
// window + state. The one-click approve/deny + per-request conflict count write surfaces fill in as those write
// paths harden (approval triggers the SERVER-side reassignment scan); ADR-0030 — no frontend authz. Optional
// `?state=` / `?membership=` filters. Reads GET /api/v1/time-off via the typed client. Leaves only (@chartwarden/ui).
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { approveTimeOff, denyTimeOff } from "./scheduling-api";
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
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  /**
   * #91 — decide a request. This queue's whole reason to exist is an approval it did not offer, and the
   * decision is load-bearing beyond the requester: APPROVED time off is what M17's conflict rules refuse
   * a visit against, so an approval nobody could record was also a clinician the scheduler kept booking.
   */
  async function decide(id: string, kind: "approve" | "deny"): Promise<void> {
    setBusyId(id);
    setNotice(null);
    const res =
      kind === "approve"
        ? await approveTimeOff(client, id)
        : await denyTimeOff(client, id, "Coverage cannot be arranged for this period.");
    setBusyId(null);
    setNotice(res.ok ? (kind === "approve" ? "Approved." : "Denied.") : res.message);
    if (res.ok) await load();
  }

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Time-Off Queue">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Supervisor review queue for requested time off
            {membership ? `, scoped to clinician ${membership.slice(0, 8)}` : ""}
            {state ? `, filtered to ${stateLabel(state)}` : ""}.
          </div>
          {notice ? (
            <output
              style={{
                display: "block",
                color: "var(--color-on-surface-variant)",
                fontSize: "0.8rem",
              }}
            >
              {notice}
            </output>
          ) : null}
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          <div style={infoBannerStyle}>
            Approval and denial actions remain server-owned. This view reflects the current filtered
            request queue from the scheduling service.
          </div>
        </div>
      }
      table={
        error ? (
          <div style={emptyShellStyle}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : loading && rows.length === 0 ? (
          <div style={loadingShellStyle}>
            <LoadingSpinner />
          </div>
        ) : rows.length === 0 ? (
          <div style={emptyShellStyle}>
            <EmptyState
              title="No time-off requests"
              description="There are no time-off requests in this view."
            />
          </div>
        ) : (
          <div style={tableShellStyle}>
            <table style={tableStyle}>
              <thead>
                <tr style={tableHeadRowStyle}>
                  <th style={thStyle}>Clinician</th>
                  <th style={thStyle}>Kind</th>
                  <th style={thStyle}>Starts</th>
                  <th style={thStyle}>Ends</th>
                  <th style={thStyle}>State</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Decide</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={rowStyle}>
                    <td className="wx-data-md" style={tdStyle}>
                      {r.membershipId.slice(0, 8)}
                    </td>
                    <td style={tdStyle}>{stateLabel(r.kind)}</td>
                    <td className="tabular-nums" style={tdStyle}>
                      {ts(r.startsAt)}
                    </td>
                    <td className="tabular-nums" style={tdStyle}>
                      {ts(r.endsAt)}
                    </td>
                    <td style={tdStyle}>
                      <StatusPill
                        label={stateLabel(r.state)}
                        tone={TIMEOFF_TONE[r.state] ?? "neutral"}
                      />
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      {r.state === "requested" ? (
                        <span style={{ display: "inline-flex", gap: "0.35rem" }}>
                          <Button
                            size="sm"
                            disabled={busyId === r.id}
                            onClick={() => void decide(r.id, "approve")}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            tone="tertiary"
                            disabled={busyId === r.id}
                            onClick={() => void decide(r.id, "deny")}
                          >
                            Deny
                          </Button>
                        </span>
                      ) : (
                        <span style={{ color: "var(--color-muted)" }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
      fullPageScroll
    />
  );
}

const filterShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};

const tableShellStyle: CSSProperties = {
  width: "100%",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
};

const emptyShellStyle: CSSProperties = {
  padding: "2rem 1.5rem",
};

const loadingShellStyle: CSSProperties = {
  padding: "2.5rem 1.5rem",
  textAlign: "center",
};

const infoBannerStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid color-mix(in srgb, var(--color-primary) 25%, transparent)",
  background: "var(--color-primary-tint)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.85rem",
};

const tableHeadRowStyle: CSSProperties = {
  background: "var(--color-surface-low)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
};

const thStyle: CSSProperties = {
  padding: "0.5rem 0.75rem",
  textAlign: "left",
  fontSize: "0.7rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
};

const tdStyle: CSSProperties = {
  padding: "0.55rem 0.75rem",
  color: "var(--color-on-surface)",
};

const rowStyle: CSSProperties = {
  borderTop: "1px solid var(--color-surface-container)",
};
