import {
  CountBadge,
  DataTable,
  EmptyState,
  Glyph,
  InfoRows,
  LoadingSpinner,
  Panel,
  PatientWorkspaceLayout,
  StatusPill,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/14-idg — Per-Patient Packet (read-only chart embed) (M14 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_IDG_MEETING.md — "Use Work Queue + Documentation Workspace" (packet
// reading surface). 2026-09 "Lantern Clinical 2.0" redesign: the patient chart banner + tab strip, flat sections,
// and the patient summary in the right rail. Shows what the platform returns for one patient in one meeting:
// the packet digest (freeze state), the meeting context, the decisions recorded about this patient (kinds and
// status only — the D4 payload stays server-side) and the follow-ups assigned for them. The per-discipline
// `built_snapshot` (cover summary, the seven discipline tabs, signed encounters, assessment / order / medication
// changes, HOPE timepoints, flagged events, carry-forward items) is drawn from the packet read route's `content`
// by packet-content.tsx; `content: null` says the snapshot is missing. The SERVER owns the §7.2/W-SUD-01 SUD
// redaction and the §4.7 idg_meeting_scope + caseload_or_scope ABAC (ADR-0030 — no frontend authz; an
// out-of-scope packet 404s).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import { ChartBanner, PatientSummaryPanel, useChartIdentity } from "../../shell/patient-context";
import {
  type ActionItemView,
  type AgendaItemView,
  type DecisionView,
  type MeetingView,
  loadAgenda,
  loadDecisions,
} from "./idg-api";
import { PatientLabel, type PatientRef, shortId, useMemberNames } from "./idg-people";
import { ACTION_TONE, MEETING_TONE, stateLabel } from "./idg-status";
import "./live-meeting.css";
import { StatCard } from "./live-meeting";
import {
  DisciplineViews,
  NoContentNotice,
  PacketChanges,
  PacketCover,
  type PacketDetail,
  RedactionBanner,
} from "./packet-content";

type PacketView = PacketDetail & { patient?: PatientRef | null };

const ts = (v: string | null | undefined): string => {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? v.slice(0, 16).replace("T", " ")
    : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
};

const dayOf = (v: string): string => {
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? v.slice(0, 10)
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

export function PatientPacket(): JSX.Element {
  const client = useApiClient();
  const { meetingId, patientId } = useParams<{ meetingId: string; patientId: string }>();
  const identity = useChartIdentity(patientId);
  const [packet, setPacket] = useState<PacketView | null>(null);
  const [meeting, setMeeting] = useState<MeetingView | null>(null);
  const [decisions, setDecisions] = useState<DecisionView[]>([]);
  const [agenda, setAgenda] = useState<AgendaItemView[]>([]);
  const [actions, setActions] = useState<ActionItemView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const names = useMemberNames(meeting?.organizationId);
  const who = (membershipId: string): string => names.get(membershipId) ?? shortId(membershipId);

  const load = useCallback(async () => {
    if (!meetingId || !patientId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET(
      "/api/v1/idg/meetings/{meetingId}/packets/{patientId}",
      { params: { path: { meetingId, patientId } } },
    );
    if (err) {
      setError("Could not load this patient's IDG packet.");
      setLoading(false);
      return;
    }
    setPacket((data ?? null) as PacketView | null);
    setLoading(false);
    // Context reads — secondary; the packet stands without them.
    void client
      .GET("/api/v1/idg/meetings/{id}", { params: { path: { id: meetingId } } })
      .then((r) => setMeeting((r.data ?? null) as MeetingView | null))
      .catch(() => undefined);
    void loadDecisions(client, meetingId)
      .then((rows) => setDecisions(rows.filter((d) => d.patientId === patientId)))
      .catch(() => undefined);
    void loadAgenda(client, meetingId)
      .then((rows) => setAgenda(rows.filter((a) => a.patientId === patientId)))
      .catch(() => undefined);
    void client
      .GET("/api/v1/idg/action-items", { params: { query: {} } })
      .then((r) => {
        const rows = Array.isArray(r.data) ? (r.data as ActionItemView[]) : [];
        setActions(rows.filter((a) => a.meetingId === meetingId && a.patientId === patientId));
      })
      .catch(() => undefined);
  }, [client, meetingId, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isLive = meeting?.status === "live";

  return (
    <PatientWorkspaceLayout
      banner={
        identity ? (
          <ChartBanner
            identity={identity}
            actions={
              meetingId ? (
                <Link
                  to={isLive ? `/idg/meetings/${meetingId}/live` : `/idg/meetings/${meetingId}`}
                  className="wx-btn-primary"
                >
                  <Glyph name="play" size={14} /> {isLive ? "Live meeting" : "IDG Meeting"}
                </Link>
              ) : undefined
            }
          />
        ) : (
          <div className="wx-patient-banner" aria-busy="true" style={{ minHeight: "6.25rem" }} />
        )
      }
      rail={patientId ? <PatientSummaryPanel identity={identity} /> : undefined}
    >
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        {patientId ? <ChartModuleRail patientId={patientId} current="idg" /> : null}
        <div style={{ flex: 1, overflow: "auto", padding: "1.25rem 1.5rem 1.5rem", minWidth: 0 }}>
          <section
            className="wx-chart-section wx-idg-packet"
            aria-label="IDG packet"
            aria-busy={loading}
          >
            <div className="wx-page-head">
              <div style={{ maxWidth: "36rem" }}>
                <h1>IDG Packet</h1>
                <p>
                  What the interdisciplinary group has on this patient for the meeting.
                  {patientId ? (
                    <>
                      {" "}
                      <Link to={`/patients/${patientId}/idg-history`}>IDG history</Link>
                    </>
                  ) : null}
                </p>
              </div>
            </div>

            {error ? (
              <EmptyState title="Unavailable" description={error} />
            ) : loading && packet === null ? (
              <LoadingSpinner />
            ) : packet === null ? (
              <EmptyState
                title="Not found"
                description="No IDG packet for this patient in this meeting."
              />
            ) : (
              <>
                <div className="wx-stat-grid" aria-label="Packet summary">
                  <StatCard
                    icon="file-check"
                    label="Packet"
                    value={packet.frozenAt ? "Frozen" : "Draft"}
                    hint={packet.frozenAt ? ts(packet.frozenAt) : "Pre-adjournment"}
                    color={packet.frozenAt ? undefined : t.warning}
                  />
                  <StatCard
                    icon="clipboard-list"
                    label="Agenda"
                    value={agenda.length}
                    hint={
                      agenda.length
                        ? agenda.map((a) => stateLabel(a.kind)).join(", ")
                        : "Packet only"
                    }
                  />
                  <StatCard
                    icon="scale"
                    label="Decisions"
                    value={decisions.length}
                    hint={`${decisions.filter((d) => d.status === "open").length} open`}
                  />
                  <StatCard
                    icon="check-circle"
                    label="Follow-ups"
                    value={actions.length}
                    hint={`${actions.filter((a) => a.status === "open" || a.status === "in_progress").length} open`}
                  />
                </div>

                <Panel title="Packet" icon="file-check">
                  <InfoRows
                    labelWidth="8rem"
                    rows={[
                      {
                        label: "Patient",
                        value: (
                          <PatientLabel patientId={packet.patientId} patient={packet.patient} />
                        ),
                      },
                      {
                        label: "State",
                        value: packet.frozenAt ? (
                          <StatusPill label="Frozen" tone="neutral" />
                        ) : (
                          <StatusPill label="Draft (pre-adjournment)" tone="warning" />
                        ),
                      },
                      {
                        label: "Frozen at",
                        value: <span className="wx-nums">{ts(packet.frozenAt)}</span>,
                      },
                      {
                        label: "Meeting",
                        value: meeting ? (
                          <span style={{ display: "inline-flex", gap: "0.5rem", flexWrap: "wrap" }}>
                            <span className="wx-nums">{ts(meeting.scheduledStart)}</span>
                            <StatusPill
                              label={stateLabel(meeting.status)}
                              tone={MEETING_TONE[meeting.status] ?? "neutral"}
                            />
                          </span>
                        ) : (
                          <span className="wx-data-md">{packet.meetingId}</span>
                        ),
                      },
                      {
                        label: "Packet id",
                        value: <span className="wx-data-md">{packet.packetId}</span>,
                      },
                    ]}
                  />
                </Panel>

                <RedactionBanner packet={packet} />
                {packet.content ? (
                  <>
                    <PacketCover content={packet.content} />
                    <DisciplineViews content={packet.content} />
                    <PacketChanges content={packet.content} who={who} />
                  </>
                ) : (
                  <NoContentNotice />
                )}

                <Panel
                  title="Decisions for this patient"
                  icon="scale"
                  flush
                  action={<CountBadge count={decisions.length} tone="primary" />}
                >
                  <DataTable
                    ariaLabel="Decisions for this patient"
                    rows={decisions}
                    getRowId={(d) => d.id}
                    columns={[
                      {
                        id: "decision",
                        header: "Decision",
                        cell: (d) => (
                          <span className="wx-row-title">{stateLabel(d.decisionKind)}</span>
                        ),
                      },
                      {
                        id: "status",
                        header: "Status",
                        cell: (d) => (
                          <span className="wx-idg-live-pills">
                            <StatusPill
                              label={stateLabel(d.status)}
                              tone={
                                d.status === "superseded"
                                  ? "neutral"
                                  : d.status === "emitted"
                                    ? "success"
                                    : "progress"
                              }
                            />
                            {d.wasQuorate ? null : (
                              <StatusPill label="Not quorate · annotation" tone="warning" />
                            )}
                          </span>
                        ),
                      },
                      {
                        id: "recorded",
                        header: "Recorded",
                        cell: (d) => <span className="wx-nums">{ts(d.recordedAt)}</span>,
                      },
                    ]}
                    empty={<p className="wx-rail-empty">No decisions recorded for this patient.</p>}
                  />
                </Panel>

                <Panel
                  title="Follow-ups"
                  icon="check-circle"
                  flush
                  action={<CountBadge count={actions.length} tone="primary" />}
                >
                  <DataTable
                    ariaLabel="Follow-ups"
                    rows={actions}
                    getRowId={(a) => a.id}
                    columns={[
                      {
                        id: "due",
                        header: "Due",
                        cell: (a) => <span className="wx-nums">{dayOf(a.dueDate)}</span>,
                      },
                      {
                        id: "status",
                        header: "Status",
                        cell: (a) => (
                          <StatusPill
                            label={stateLabel(a.status)}
                            tone={ACTION_TONE[a.status] ?? "neutral"}
                          />
                        ),
                      },
                    ]}
                    empty={
                      <p className="wx-rail-empty">No follow-ups assigned for this patient.</p>
                    }
                  />
                </Panel>
              </>
            )}
          </section>
        </div>
      </div>
    </PatientWorkspaceLayout>
  );
}
