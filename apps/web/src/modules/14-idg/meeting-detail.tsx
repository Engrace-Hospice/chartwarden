import {
  EmptyState,
  Glyph,
  LoadingSpinner,
  StatusPill,
  cardSurface,
  ghostBorder,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/14-idg — Meeting Detail (pre-meeting) (M14 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_IDG_MEETING.md — "Use Work Queue + Documentation Workspace".
// Matched to the P1 Pencil frame (wardenx-P1-clinical.pen `Wqf1e`): a meeting header over a packet list |
// the selected patient's review packet | a right rail (attendance/quorum + schedule). The IDG Coordinator's
// pre-meeting view: the lifecycle state + scheduled window over a packet-readiness list. The SERVER owns the
// §2.2 lifecycle and §4.7 idg_meeting_scope ABAC (ADR-0030 — no frontend authz). Reads GET /idg/meetings/:id
// + /idg/meetings/:id/packets. Honest gaps: the packets read carries each packet's patient + freeze state,
// NOT the as-presented summary / eligibility / recommendations content (that's the full packet, /packets/
// :patientId) — so the center is a section scaffold + Open packet; and the meeting reads don't carry the
// attendance/quorum roster, so that rail is an honest placeholder. Never fabricated.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
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
const PACKET_SECTIONS = [
  "As-presented summary",
  "Eligibility note",
  "Recommendations & decisions",
] as const;

export function MeetingDetail(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [meeting, setMeeting] = useState<MeetingView | null>(null);
  const [packets, setPackets] = useState<PacketRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
    const rows = (p.data ?? []) as PacketRow[];
    setPackets(rows);
    setSelectedId((prev) => prev ?? rows[0]?.packetId ?? null);
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
  const selected = packets.find((p) => p.packetId === selectedId) ?? null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: t.background,
      }}
    >
      {/* Meeting header */}
      <div style={header}>
        <div>
          <h1
            style={{
              margin: 0,
              fontFamily: t.fontDisplay,
              fontWeight: 500,
              fontSize: "1.25rem",
              color: t.onSurface,
            }}
          >
            IDG Meeting
          </h1>
          <span style={meta} className="tabular-nums">
            {ts(meeting.scheduledStart)} → {meeting.scheduledEnd.slice(11, 16)}
          </span>
        </div>
        <span style={{ flex: 1 }} />
        <span style={{ ...meta, marginRight: "0.5rem" }} className="tabular-nums">
          {ready} / {packets.length} packets ready
        </span>
        <StatusPill
          label={stateLabel(meeting.status)}
          tone={MEETING_TONE[meeting.status] ?? "neutral"}
        />
        <button
          type="button"
          onClick={() => navigate(`/idg/meetings/${meeting.id}/live`)}
          style={primaryBtn}
        >
          Live surface
        </button>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Packet list */}
        <div style={packetList}>
          <span style={listHead}>Packets</span>
          {packets.length === 0 ? (
            <p style={meta}>No packets built yet.</p>
          ) : (
            packets.map((p) => {
              const active = p.packetId === selectedId;
              return (
                <button
                  key={p.packetId}
                  type="button"
                  onClick={() => setSelectedId(p.packetId)}
                  style={{ ...listItem, ...(active ? listItemActive : null) }}
                >
                  <span style={{ fontFamily: t.fontMono, fontSize: "0.78rem" }}>
                    {p.patientId.slice(0, 8)}
                  </span>
                  {p.frozenAt ? (
                    <Glyph name="check-circle" size={14} label="Packet frozen" />
                  ) : (
                    <StatusPill label="Draft" tone="warning" />
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Center — selected patient's review packet */}
        <div style={{ flex: 1, overflow: "auto", padding: "1.5rem", minWidth: 0 }}>
          {selected ? (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "1rem",
                }}
              >
                <h2
                  style={{
                    margin: 0,
                    fontFamily: t.fontDisplay,
                    fontWeight: 500,
                    fontSize: "1.25rem",
                    color: t.onSurface,
                  }}
                >
                  Patient{" "}
                  <span style={{ fontFamily: t.fontMono, fontSize: "1rem" }}>
                    {selected.patientId.slice(0, 8)}
                  </span>{" "}
                  — review packet
                </h2>
                {selected.frozenAt ? (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.35rem",
                      color: t.success,
                      fontSize: "0.78rem",
                      fontWeight: 600,
                    }}
                  >
                    <Glyph name="check-circle" size={14} /> frozen {selected.frozenAt.slice(0, 10)}
                  </span>
                ) : (
                  <StatusPill label="Draft packet" tone="warning" />
                )}
              </div>

              <section style={{ ...cardSurface, padding: "0.5rem 1.25rem", marginTop: "1rem" }}>
                {PACKET_SECTIONS.map((s, i) => (
                  <div key={s} style={{ ...sectionRow, borderTop: i === 0 ? "none" : ghostBorder }}>
                    <span style={{ flex: 1, fontWeight: 600, color: t.onSurface }}>{s}</span>
                    <span style={{ color: t.muted, fontSize: "0.78rem" }}>in the full packet</span>
                  </div>
                ))}
              </section>
              <p style={meta}>
                The packet's care-plan snapshot, eligibility note, and recommendations live on the
                full packet (frozen at build); open it to review and record the IDG decision.
              </p>
              <button
                type="button"
                onClick={() =>
                  navigate(`/idg/meetings/${selected.meetingId}/packets/${selected.patientId}`)
                }
                style={{ ...primaryBtn, marginTop: "0.5rem" }}
              >
                Open full packet
              </button>
            </>
          ) : (
            <EmptyState title="No packet selected" description="Select a packet to review it." />
          )}
        </div>

        {/* Right rail — attendance/quorum + schedule */}
        <aside style={rightRail}>
          <div style={{ ...cardSurface, padding: "1.125rem" }}>
            <h2 style={railTitle}>Attendance &amp; quorum</h2>
            <p style={meta}>
              The discipline roster and the §D5 quorum gate (Medical Director + RN + MSW/Chaplain)
              are recorded on the live meeting surface; this pre-meeting view doesn't carry
              attendance yet.
            </p>
          </div>
          <div style={{ ...cardSurface, padding: "1.125rem" }}>
            <h2 style={railTitle}>Schedule</h2>
            <dl style={detailGrid}>
              <dt style={dt}>Start</dt>
              <dd style={{ ...dd }} className="tabular-nums">
                {ts(meeting.scheduledStart)}
              </dd>
              <dt style={dt}>End</dt>
              <dd style={{ ...dd }} className="tabular-nums">
                {ts(meeting.scheduledEnd)}
              </dd>
              <dt style={dt}>Status</dt>
              <dd style={dd}>
                <StatusPill
                  label={stateLabel(meeting.status)}
                  tone={MEETING_TONE[meeting.status] ?? "neutral"}
                />
              </dd>
              <dt style={dt}>Packets</dt>
              <dd style={{ ...dd }} className="tabular-nums">
                {ready} / {packets.length} ready
              </dd>
            </dl>
          </div>
        </aside>
      </div>
    </div>
  );
}

const header: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  padding: "1rem 1.5rem",
  borderBottom: ghostBorder,
  background: t.surfaceLowest,
  flexShrink: 0,
};
const packetList: CSSProperties = {
  width: "13rem",
  flexShrink: 0,
  borderRight: ghostBorder,
  padding: "1rem 0.75rem",
  overflow: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "0.125rem",
};
const listHead: CSSProperties = {
  fontSize: "0.6875rem",
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: t.muted,
  padding: "0 0.5rem 0.5rem",
};
const listItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.5rem",
  padding: "0.5rem 0.625rem",
  borderRadius: "0.5rem",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: t.onSurface,
};
const listItemActive: CSSProperties = { background: t.primaryTint, color: t.primary };
const rightRail: CSSProperties = {
  width: "19rem",
  flexShrink: 0,
  overflow: "auto",
  padding: "1.5rem",
  background: t.surfaceLow,
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};
const railTitle: CSSProperties = {
  margin: "0 0 0.625rem",
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1rem",
  color: t.onSurface,
};
const sectionRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.875rem 0",
  fontSize: "0.85rem",
};
const detailGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr",
  alignItems: "center",
  gap: "0.5rem 1rem",
  margin: 0,
  fontSize: "0.8rem",
};
const dt: CSSProperties = { fontWeight: 600, color: t.onSurfaceVariant };
const dd: CSSProperties = { margin: 0, color: t.onSurface };
const primaryBtn: CSSProperties = {
  padding: "0.45rem 1rem",
  borderRadius: "9999px",
  background: t.primary,
  color: t.onPrimary,
  fontSize: "0.8125rem",
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
};
const meta: CSSProperties = {
  fontSize: "0.78rem",
  color: t.onSurfaceVariant,
  margin: "0.25rem 0 0",
  display: "inline-block",
};
