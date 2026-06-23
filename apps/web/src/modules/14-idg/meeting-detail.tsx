// apps/web/src/modules/14-idg — Meeting Detail (pre-meeting) (M14 §4.1/§5, Track B / ADR-0030).
// Spec: docs/ui/screens/clinical/WARDENX_UI_IDG_MEETING.md — "Use Work Queue + Documentation Workspace". The
// IDG Coordinator's pre-meeting view: the meeting's lifecycle state + scheduled window over a packet-readiness
// list (one row per included patient's packet, with its freeze state). The "Build packets now" / start-meeting /
// cancel / reschedule write surfaces fill in as their write paths harden; the SERVER owns the §2.2 lifecycle and
// the §4.7 idg_meeting_scope ABAC (ADR-0030 — no frontend authz). Reads GET /api/v1/idg/meetings/:id and
// GET /api/v1/idg/meetings/:id/packets via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";

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
      header={<PageHeader title="IDG Meeting" breadcrumb={`${ts(meeting.scheduledStart)} · ${meeting.status}`} />}
      aside={
        <aside style={{ width: "16rem", flexShrink: 0, padding: "1.5rem", borderLeft: "1px solid #e5e7eb" }}>
          <h3 style={h3}>Schedule</h3>
          <dl style={{ margin: 0, fontSize: "0.85rem" }}>
            <dt style={dt}>Start</dt>
            <dd style={dd}>{ts(meeting.scheduledStart)}</dd>
            <dt style={dt}>End</dt>
            <dd style={dd}>{ts(meeting.scheduledEnd)}</dd>
            <dt style={dt}>Status</dt>
            <dd style={dd}>{meeting.status}</dd>
            <dt style={dt}>Packets ready</dt>
            <dd style={dd}>{ready} / {packets.length}</dd>
          </dl>
          <button type="button" onClick={() => navigate(`/idg/meetings/${meeting.id}/live`)} style={btn}>
            Live surface →
          </button>
        </aside>
      }
    >
      <h3 style={h3}>Packets</h3>
      {packets.length === 0 ? (
        <EmptyState title="No packets" description="No patient packets have been built for this meeting yet." />
      ) : (
        <table style={table}>
          <thead>
            <tr style={tr}>
              <th style={th}>Patient</th>
              <th style={th}>Packet</th>
              <th style={th}>Frozen</th>
            </tr>
          </thead>
          <tbody>
            {packets.map((p) => (
              <tr
                key={p.packetId}
                onClick={() => navigate(`/idg/meetings/${p.meetingId}/packets/${p.patientId}`)}
                style={{ cursor: "pointer", borderTop: "1px solid #f3f4f6" }}
              >
                <td style={td}>{p.patientId.slice(0, 8)}</td>
                <td style={td}>{p.packetId.slice(0, 8)}</td>
                <td style={{ ...td, color: p.frozenAt ? "#6b7280" : "#b45309" }}>
                  {p.frozenAt ? ts(p.frozenAt) : "draft"}
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
const table = { width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" } as const;
const tr = { textAlign: "left", color: "#6b7280" } as const;
const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
const dt = { color: "#6b7280", marginTop: "0.5rem" } as const;
const dd = { margin: "0.1rem 0 0", fontWeight: 600 } as const;
const btn = {
  marginTop: "1rem",
  width: "100%",
  padding: "0.5rem",
  border: "1px solid #d1d5db",
  borderRadius: "0.375rem",
  background: "#fff",
  cursor: "pointer",
  fontSize: "0.85rem",
} as const;
