// apps/web/src/modules/17-scheduling — Recurring Policies (M17 §5.1 `/app/scheduling/recurring`, Track B / ADR-0030).
// Spec: docs/ui/screens — "Use Work Queue". The list of active recurring-visit policies for a patient (from
// `?patient=`) with their RRULE + status. The create/discontinue write surfaces fill in as those write paths
// harden; the SERVER owns the §7.7 materialization/discontinuation (ADR-0030 — no frontend authz). Reads GET
// /api/v1/recurring-visits via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { EmptyState, LoadingSpinner, PageHeader, useApiClient, WorkQueueLayout } from "@wardenx/ui";

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

  const active = rows.filter((r) => r.status === "active");

  return (
    <WorkQueueLayout
      header={<PageHeader title="Recurring Policies" />}
      table={
        !patient ? (
          <EmptyState
            title="Select a patient"
            description="Open this view from a patient context to see their recurring-visit policies."
          />
        ) : error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && rows.length === 0 ? (
          <LoadingSpinner />
        ) : active.length === 0 ? (
          <EmptyState title="No active policies" description="This patient has no active recurring-visit policies." />
        ) : (
          <table style={table}>
            <thead>
              <tr style={tr}>
                <th style={th}>Purpose</th>
                <th style={th}>Clinician</th>
                <th style={th}>RRULE</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {active.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid #f3f4f6" }}>
                  <td style={td}>{r.visitPurpose}</td>
                  <td style={mono}>{r.assignedMembershipId.slice(0, 8)}</td>
                  <td style={mono}>{r.rrule}</td>
                  <td style={{ ...td, color: r.status === "active" ? "#15803d" : "#6b7280" }}>{r.status}</td>
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
