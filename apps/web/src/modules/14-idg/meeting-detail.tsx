import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/14-idg — Meeting Detail (pre-meeting) (M14 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_IDG_MEETING.md — "Use Work Queue + Documentation Workspace". The
// IDG Coordinator's pre-meeting view: the meeting's lifecycle state + scheduled window over a packet-readiness
// list (one row per included patient's packet, with its freeze state). The "Build packets now" / start-meeting /
// cancel / reschedule write surfaces fill in as their write paths harden; the SERVER owns the §2.2 lifecycle and
// the §4.7 idg_meeting_scope ABAC (ADR-0030 — no frontend authz). Reads GET /api/v1/idg/meetings/:id and
// GET /api/v1/idg/meetings/:id/packets via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { MEETING_TONE, stateLabel } from "./idg-status";

interface MeetingView {
  id: string;
  locationId: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string;
  adjournedAt: string | null;
}
interface PacketRow {
  packetId: string;
  meetingId: string;
  patientId: string;
  frozenAt: string | null;
}

const ts = (v: string): string => v.slice(0, 16).replace("T", " ");

export function MeetingDetail(): JSX.Element {
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
      setError("Could not load this IDG meeting.");
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

  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading && meeting === null) return <LoadingSpinner />;
  if (meeting === null)
    return <EmptyState title="Not found" description="This meeting is not available." />;

  const ready = packets.filter((p) => p.frozenAt !== null).length;

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="IDG Meeting"
          breadcrumb={ts(meeting.scheduledStart)}
          actions={
            <StatusPill
              label={stateLabel(meeting.status)}
              tone={MEETING_TONE[meeting.status] ?? "neutral"}
            />
          }
        />
      }
      aside={
        <RightDetailPanel title="Schedule">
          <dl style={{ margin: 0, fontSize: "0.85rem" }}>
            <dt style={dt}>Start</dt>
            <dd style={dd} className="tabular-nums">
              {ts(meeting.scheduledStart)}
            </dd>
            <dt style={dt}>End</dt>
            <dd style={dd} className="tabular-nums">
              {ts(meeting.scheduledEnd)}
            </dd>
            <dt style={dt}>Status</dt>
            <dd style={dd}>
              <StatusPill
                label={stateLabel(meeting.status)}
                tone={MEETING_TONE[meeting.status] ?? "neutral"}
              />
            </dd>
            <dt style={dt}>Packets ready</dt>
            <dd style={dd} className="tabular-nums">
              {ready} / {packets.length}
            </dd>
          </dl>
          <button
            type="button"
            onClick={() => navigate(`/idg/meetings/${meeting.id}/live`)}
            style={btn}
          >
            Live surface →
          </button>
        </RightDetailPanel>
      }
    >
      <h3 style={h3}>Packets</h3>
      {packets.length === 0 ? (
        <EmptyState
          title="No packets"
          description="No patient packets have been built for this meeting yet."
        />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Patient</th>
              <th>Packet</th>
              <th>Frozen</th>
            </tr>
          </thead>
          <tbody>
            {packets.map((p) => (
              <tr
                key={p.packetId}
                // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/idg/meetings/${p.meetingId}/packets/${p.patientId}`)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    navigate(`/idg/meetings/${p.meetingId}/packets/${p.patientId}`);
                  }
                }}
                style={{ cursor: "pointer" }}
              >
                <td className="wx-data-md">{p.patientId.slice(0, 8)}</td>
                <td className="wx-data-md">{p.packetId.slice(0, 8)}</td>
                <td>
                  {p.frozenAt ? (
                    <span className="tabular-nums">{ts(p.frozenAt)}</span>
                  ) : (
                    <StatusPill label="Draft" tone="warning" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </DetailPageLayout>
  );
}

const h3 = { fontSize: "0.9rem", fontWeight: 600, margin: "0 0 0.5rem" } as const;
const dt = { color: "var(--color-on-surface-variant)", marginTop: "0.5rem" } as const;
const dd = { margin: "0.1rem 0 0", fontWeight: 600 } as const;
const btn = {
  marginTop: "1rem",
  width: "100%",
  padding: "0.5rem",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 60%, transparent)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  cursor: "pointer",
  fontSize: "0.85rem",
} as const;
