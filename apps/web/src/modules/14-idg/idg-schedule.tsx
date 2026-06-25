import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/14-idg — IDG Schedule (per-location) (M14 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_IDG_MEETING.md — "Use Work Queue + Documentation Workspace". The
// IDG Coordinator's per-location view of the next weeks of meetings: one row per scheduled meeting with its
// lifecycle chip (scheduled → packets_building → packets_ready → live → adjourned). The cancel / reschedule /
// edit-recurring-policy write surfaces fill in as their write paths harden; the SERVER owns the §2.2 lifecycle
// and the §4.7 idg_meeting_scope / per_patient_review_floor_clear ABAC (ADR-0030 — no frontend authz). The
// location is taken from the `?location=` query (location-scoped read); the range defaults to the next 8 weeks.
// Reads GET /api/v1/idg/schedule via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { MEETING_TONE, stateLabel } from "./idg-status";

interface MeetingRow {
  id: string;
  locationId: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string;
}

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
          <table>
            <thead>
              <tr>
                <th>Start</th>
                <th>End</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((m) => (
                <tr
                  key={m.id}
                  // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/idg/meetings/${m.id}`)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      navigate(`/idg/meetings/${m.id}`);
                    }
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <td className="tabular-nums">{ts(m.scheduledStart)}</td>
                  <td className="tabular-nums">{ts(m.scheduledEnd)}</td>
                  <td>
                    <StatusPill
                      label={stateLabel(m.status)}
                      tone={MEETING_TONE[m.status] ?? "neutral"}
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
