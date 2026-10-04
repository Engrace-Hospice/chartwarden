import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/17-scheduling — Recurring Policies (M17 §5.1 `/app/scheduling/recurring`, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Work Queue". The list of active recurring-visit policies for a patient (from
// `?patient=`) with their RRULE + status. The create/discontinue write surfaces fill in as those write paths
// harden; the SERVER owns the §7.7 materialization/discontinuation (ADR-0030 — no frontend authz). Reads GET
// /api/v1/recurring-visits via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { discontinueRecurring } from "./scheduling-api";
import { RECURRING_TONE, stateLabel } from "./scheduling-status";

interface RecurringRow {
  id: string;
  patientId: string;
  assignedMembershipId: string;
  visitPurpose: string;
  rrule: string;
  status: string;
}

export function SchedulingRecurring(): JSX.Element {
  const client = useApiClient();
  const [params] = useSearchParams();
  const patient = params.get("patient") ?? undefined;
  const [rows, setRows] = useState<RecurringRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!patient) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/recurring-visits", {
      params: { query: { patient } },
    });
    if (err) {
      setError("Could not load recurring policies for this patient.");
      setLoading(false);
      return;
    }
    setRows((data ?? []) as RecurringRow[]);
    setLoading(false);
  }, [client, patient]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * #91 — stop a cadence. Only DISCONTINUE is offered: creating a policy takes an RRULE, and an RRULE
   * builder is a screen rather than a row action. Already-scheduled visits are unaffected — the server
   * decides that, and this control does not claim otherwise.
   */
  async function stop(id: string): Promise<void> {
    setBusyId(id);
    setNotice(null);
    const res = await discontinueRecurring(client, id, "No longer clinically indicated.");
    setBusyId(null);
    setNotice(res.ok ? "Discontinued. Visits already scheduled are unchanged." : res.message);
    if (res.ok) await load();
  }

  const active = rows.filter((r) => r.status === "active");

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Recurring Policies" breadcrumb="Scheduling">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Active recurring-visit policies{patient ? ` for patient ${patient.slice(0, 8)}` : ""}.
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
            Recurring policy reads are patient-scoped. Create and discontinue actions remain on
            their dedicated write surfaces once the server paths are enabled.
          </div>
        </div>
      }
      table={
        !patient ? (
          <div style={emptyShellStyle}>
            <EmptyState
              title="Select a patient"
              description="Open this view from a patient context to see their recurring-visit policies."
            />
          </div>
        ) : error ? (
          <div style={emptyShellStyle}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : loading && rows.length === 0 ? (
          <div style={loadingShellStyle}>
            <LoadingSpinner />
          </div>
        ) : active.length === 0 ? (
          <div style={emptyShellStyle}>
            <EmptyState
              title="No active policies"
              description="This patient has no active recurring-visit policies."
            />
          </div>
        ) : (
          <div style={tableShellStyle}>
            <table style={tableStyle}>
              <thead>
                <tr style={tableHeadRowStyle}>
                  <th style={thStyle}>Purpose</th>
                  <th style={thStyle}>Clinician</th>
                  <th style={thStyle}>RRULE</th>
                  <th style={thStyle}>Status</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Discontinue</th>
                </tr>
              </thead>
              <tbody>
                {active.map((r) => (
                  <tr key={r.id} style={rowStyle}>
                    <td style={tdStyle}>{stateLabel(r.visitPurpose)}</td>
                    <td className="wx-data-md" style={tdStyle}>
                      {r.assignedMembershipId.slice(0, 8)}
                    </td>
                    <td className="wx-data-md" style={tdStyle}>
                      {r.rrule}
                    </td>
                    <td style={tdStyle}>
                      <StatusPill
                        label={stateLabel(r.status)}
                        tone={RECURRING_TONE[r.status] ?? "neutral"}
                      />
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      {r.status === "active" ? (
                        <Button
                          size="sm"
                          tone="tertiary"
                          disabled={busyId === r.id}
                          onClick={() => void stop(r.id)}
                        >
                          Discontinue
                        </Button>
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
