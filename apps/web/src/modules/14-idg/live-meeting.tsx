import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/14-idg — Live Meeting Surface (M14 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_IDG_MEETING.md — "Use Work Queue + Documentation Workspace". The
// IDG Coordinator's in-meeting surface: a left-rail patient list (the meeting's packets) over the meeting's
// lifecycle state. The center packet viewer (per-discipline switch), the right-rail decision-recording panel
// (with the live quorum gauge), the attendance tracker, the action-item assignment, the adjourn control, and
// the Socket.IO real-time decision/action-item propagation fill in as their write paths harden; the SERVER owns
// the §2.2 lifecycle, the §4.7 quorate_decision / idg_meeting_scope ABAC, and the §4.10 D13 fresh-step-up
// adjournment gate (ADR-0030 — no frontend authz; a non-quorate decision refusal returns 422 server-side).
// Reads GET /api/v1/idg/meetings/:id and GET /api/v1/idg/meetings/:id/packets via the typed client.
// Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { MEETING_TONE, stateLabel } from "./idg-status";

interface MeetingView {
  id: string;
  status: string;
  scheduledStart: string;
}
interface PacketRow {
  packetId: string;
  meetingId: string;
  patientId: string;
  frozenAt: string | null;
}

export function LiveMeeting(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [meeting, setMeeting] = useState<MeetingView | null>(null);
  const [packets, setPackets] = useState<PacketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const [m, p] = await Promise.all([
      client.GET("/api/v1/idg/meetings/{id}", { params: { path: { id } } }),
      client.GET("/api/v1/idg/meetings/{id}/packets", { params: { path: { id } } }),
    ]);
    if (m.error || p.error) {
      setError("Could not load the live meeting surface.");
      setLoading(false);
      return;
    }
    setMeeting((m.data ?? null) as MeetingView | null);
    setPackets((p.data ?? []) as PacketRow[]);
    setLoading(false);
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Live IDG Meeting"
          breadcrumb={meeting ? meeting.scheduledStart.slice(0, 10) : undefined}
          actions={
            meeting ? (
              <StatusPill
                label={stateLabel(meeting.status)}
                tone={MEETING_TONE[meeting.status] ?? "neutral"}
              />
            ) : undefined
          }
        />
      }
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && meeting === null ? (
          <LoadingSpinner />
        ) : packets.length === 0 ? (
          <EmptyState
            title="No patients"
            description="No patient packets are loaded for this meeting."
          />
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {packets.map((p) => (
              <li key={p.packetId}>
                <button
                  type="button"
                  onClick={() => navigate(`/idg/meetings/${p.meetingId}/packets/${p.patientId}`)}
                  style={{
                    cursor: "pointer",
                    width: "100%",
                    textAlign: "left",
                    border: "none",
                    background: "none",
                    padding: "0.75rem 1rem",
                    borderBottom:
                      "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    color: "var(--color-on-surface)",
                  }}
                >
                  <span>
                    Patient <span className="wx-data-md">{p.patientId.slice(0, 8)}</span>
                  </span>
                  <StatusPill
                    label={p.frozenAt ? "Frozen" : "Draft"}
                    tone={p.frozenAt ? "neutral" : "warning"}
                  />
                </button>
              </li>
            ))}
          </ul>
        )
      }
    />
  );
}
