import {
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
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
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
          <EmptyState
            title="No active policies"
            description="This patient has no active recurring-visit policies."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Purpose</th>
                <th>Clinician</th>
                <th>RRULE</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {active.map((r) => (
                <tr key={r.id}>
                  <td>{stateLabel(r.visitPurpose)}</td>
                  <td className="wx-data-md">{r.assignedMembershipId.slice(0, 8)}</td>
                  <td className="wx-data-md">{r.rrule}</td>
                  <td>
                    <StatusPill
                      label={stateLabel(r.status)}
                      tone={RECURRING_TONE[r.status] ?? "neutral"}
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
