// apps/web/src/modules/14-idg — My Action Items (M14 §4.1/§5, Track B / ADR-0030).
// Spec: docs/ui/screens/clinical/WARDENX_UI_IDG_MEETING.md — "Use Work Queue + Documentation Workspace". The
// caller's queue of IDG action items assigned to them (`assignee=me` resolves to the caller's membership
// server-side), one row per item with its status + due date + linked-artifact kind. The update-status /
// link-artifact / add-note write surfaces fill in as their write paths harden; the SERVER owns the §2.7
// auto-close (an item linked to a downstream artifact closes when that artifact reaches an absorbing state) and
// the §4.7 is_assignee ABAC (ADR-0030 — no frontend authz). Reads GET /api/v1/idg/action-items via the typed
// client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
  WorkQueueLayout,
} from "@wardenx/ui";

interface ActionItemRow {
  id: string;
  meetingId: string;
  patientId: string | null;
  status: string;
  dueDate: string;
  linkedArtifactKind: string | null;
}

const statusColor: Record<string, string | undefined> = {
  open: "#b45309",
  in_progress: "#1d4ed8",
  completed: "#15803d",
  cancelled: "#6b7280",
  auto_closed: "#15803d",
};
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
          <EmptyState title="No action items" description="You have no IDG action items assigned." />
        ) : (
          <table style={table}>
            <thead>
              <tr style={tr}>
                <th style={th}>Due</th>
                <th style={th}>Patient</th>
                <th style={th}>Linked</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((a) => {
                const overdue =
                  (a.status === "open" || a.status === "in_progress") && Date.parse(a.dueDate) < now;
                return (
                  <tr key={a.id} style={{ borderTop: "1px solid #f3f4f6" }}>
                    <td style={{ ...td, color: overdue ? "#b91c1c" : undefined }}>
                      {ts(a.dueDate)}
                      {overdue ? " · overdue" : ""}
                    </td>
                    <td style={td}>{a.patientId ? a.patientId.slice(0, 8) : "—"}</td>
                    <td style={td}>{a.linkedArtifactKind ?? "—"}</td>
                    <td style={{ ...td, color: statusColor[a.status] }}>{a.status}</td>
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

const table = { width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" } as const;
const tr = { textAlign: "left", color: "#6b7280" } as const;
const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
