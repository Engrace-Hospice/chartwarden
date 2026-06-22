// apps/web/src/modules/14-idg — IDG Schedule (per-location) (M14 §4.1/§5, Track B / ADR-0030).
// Spec: docs/ui/screens/clinical/WARDENX_UI_IDG_MEETING.md — "Use Work Queue + Documentation Workspace". The
// IDG Coordinator's per-location view of the next weeks of meetings: one row per scheduled meeting with its
// lifecycle chip (scheduled → packets_building → packets_ready → live → adjourned). The cancel / reschedule /
// edit-recurring-policy write surfaces fill in as their write paths harden; the SERVER owns the §2.2 lifecycle
// and the §4.7 idg_meeting_scope / per_patient_review_floor_clear ABAC (ADR-0030 — no frontend authz). The
// location is taken from the `?location=` query (location-scoped read); the range defaults to the next 8 weeks.
// Reads GET /api/v1/idg/schedule via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
  WorkQueueLayout,
} from "@wardenx/ui";

interface MeetingRow {
  id: string;
  locationId: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string;
}

const statusColor: Record<string, string | undefined> = {
  scheduled: "#374151",
  packets_building: "#b45309",
  packets_ready: "#15803d",
  live: "#1d4ed8",
  adjourned: "#6b7280",
  cancelled: "#b91c1c",
  rescheduled: "#6b7280",
};
const ts = (v: string): string => v.slice(0, 16).replace("T", " ");

export function IdgSchedule(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const location = params.get("location") ?? undefined;
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(() => {
    const from = new Date();
    const to = new Date(from.getTime() + 56 * 24 * 60 * 60 * 1000); // next 8 weeks
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

  const load = useCallback(async () => {
    if (!location) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/idg/schedule", {
      params: { query: { location, from: range.from, to: range.to } },
    });
    if (err) {
      setError("Could not load the IDG schedule for this location.");
      setLoading(false);
      return;
    }
    setMeetings((data ?? []) as MeetingRow[]);
    setLoading(false);
  }, [client, location, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = useMemo(
    () => [...meetings].sort((a, b) => Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart)),
    [meetings],
  );

  return (
    <WorkQueueLayout
      header={<PageHeader title="IDG Schedule" />}
      table={
        !location ? (
          <EmptyState
            title="Select a location"
            description="Open this schedule from a location context to view its IDG meetings."
          />
        ) : error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && meetings.length === 0 ? (
          <LoadingSpinner />
        ) : sorted.length === 0 ? (
          <EmptyState
            title="No meetings scheduled"
            description="No IDG meetings are scheduled for this location in the next 8 weeks."
          />
        ) : (
          <table style={table}>
            <thead>
              <tr style={tr}>
                <th style={th}>Start</th>
                <th style={th}>End</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((m) => (
                <tr
                  key={m.id}
                  onClick={() => navigate(`/idg/meetings/${m.id}`)}
                  style={{ cursor: "pointer", borderTop: "1px solid #f3f4f6" }}
                >
                  <td style={td}>{ts(m.scheduledStart)}</td>
                  <td style={td}>{ts(m.scheduledEnd)}</td>
                  <td style={{ ...td, color: statusColor[m.status] }}>{m.status}</td>
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
