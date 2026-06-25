import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/14-idg — My Action Items (M14 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_IDG_MEETING.md — "Use Work Queue + Documentation Workspace". The
// caller's queue of IDG action items assigned to them (`assignee=me` resolves to the caller's membership
// server-side), one row per item with its status + due date + linked-artifact kind. The update-status /
// link-artifact / add-note write surfaces fill in as their write paths harden; the SERVER owns the §2.7
// auto-close (an item linked to a downstream artifact closes when that artifact reaches an absorbing state) and
// the §4.7 is_assignee ABAC (ADR-0030 — no frontend authz). Reads GET /api/v1/idg/action-items via the typed
// client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { ACTION_TONE, stateLabel } from "./idg-status";

interface ActionItemRow {
  id: string;
  meetingId: string;
  patientId: string | null;
  status: string;
  dueDate: string;
  linkedArtifactKind: string | null;
}

const ts = (v: string): string => v.slice(0, 10);

export function MyActionItems(): JSX.Element {
  const client = useApiClient();
  const [items, setItems] = useState<ActionItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/idg/action-items", {
      params: { query: { assignee: "me" } },
    });
    if (err) {
      setError("Could not load your action items.");
      setLoading(false);
      return;
    }
    setItems((data ?? []) as ActionItemRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // Open + in-progress first (the actionable work), then by soonest due.
  const sorted = useMemo(() => {
    const rank = (s: string): number => (s === "open" ? 0 : s === "in_progress" ? 1 : 2);
    return [...items].sort(
      (a, b) => rank(a.status) - rank(b.status) || Date.parse(a.dueDate) - Date.parse(b.dueDate),
    );
  }, [items]);

  const now = Date.now();

  return (
    <WorkQueueLayout
      header={<PageHeader title="My Action Items" />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : sorted.length === 0 ? (
          <EmptyState
            title="No action items"
            description="You have no IDG action items assigned."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Due</th>
                <th>Patient</th>
                <th>Linked</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((a) => {
                const overdue =
                  (a.status === "open" || a.status === "in_progress") &&
                  Date.parse(a.dueDate) < now;
                return (
                  <tr key={a.id}>
                    <td>
                      <span
                        style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
                      >
                        <span className="tabular-nums">{ts(a.dueDate)}</span>
                        {overdue ? <StatusPill label="Overdue" tone="error" /> : null}
                      </span>
                    </td>
                    <td className="wx-data-md">{a.patientId ? a.patientId.slice(0, 8) : "—"}</td>
                    <td>{a.linkedArtifactKind ? stateLabel(a.linkedArtifactKind) : "—"}</td>
                    <td>
                      <StatusPill
                        label={stateLabel(a.status)}
                        tone={ACTION_TONE[a.status] ?? "neutral"}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      }
    />
  );
}
