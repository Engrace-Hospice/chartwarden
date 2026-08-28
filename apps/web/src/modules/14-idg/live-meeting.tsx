import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/14-idg — Live Meeting Surface (M14 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_IDG_MEETING.md — "Use Work Queue + Documentation Workspace".
//
// The IDG Coordinator's in-meeting surface. Until #91 this was a left-rail list of patient ids and
// nothing else: the decision-recording panel, the attendance tracker, the action-item assignment and
// the adjourn control were all deferred, so the meeting where 42 CFR 418.56(b) says the plan of care
// is established — and §418.56(d) says it is reviewed every 15 days — could be opened and read and
// never conducted. The routes behind every control here were mounted and guarded the whole time; six
// of them wrote rows that NO read route returned, which is why this change carries a server half
// (F-062: `GET .../attendance`, `.../agenda`, `.../decisions`).
//
// THE QUORUM READOUT IS INFORMATION, NOT A GATE. §4.7's `quorate_decision` counts the roster
// server-side and refuses a non-quorate decision with a 422. This surface shows which of the four
// §2.7 disciplines are present because a coordinator needs to know who to call — but Record a
// decision stays ENABLED regardless, and the refusal is rendered where the coordinator is looking.
// Disabling it here would be a second implementation of the CoP composition rule, free to disagree
// with the one the server enforces (ADR-0030 — the server is the only enforcement point).
//
// The Socket.IO real-time propagation and the Capacitor Mobile Live variant remain deferred; this
// surface reloads the three ledgers after each write, which is correct if less live.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  type AgendaItemView,
  type AttendanceView,
  type DecisionView,
  type MeetingView,
  type PacketDigestView,
  excuseAttendance,
  loadAgenda,
  loadAttendance,
  loadDecisions,
  supersedeDecision,
} from "./idg-api";
import { DecisionModal } from "./idg-decision-modal";
import {
  ActionItemModal,
  AgendaModal,
  AttendanceModal,
  LifecycleModal,
} from "./idg-meeting-modals";
import { MEETING_TONE, stateLabel } from "./idg-status";

/** The four disciplines §2.7's `IDG_REQUIRED_QUORUM` looks for. Displayed, never enforced here. */
const REQUIRED_QUORUM = ["rn_case_manager", "hospice_physician", "msw", "chaplain"] as const;
/** Statuses that count as PRESENT for the quorum readout (mirrors the server's present-set). */
const PRESENT_STATUSES = new Set(["present", "tardy", "partial"]);

const short = (id: string): string => id.slice(0, 8);
const humanize = (k: string): string =>
  k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

type Dialog =
  | { kind: "none" }
  | { kind: "attendance" }
  | { kind: "agenda" }
  | { kind: "decision" }
  | { kind: "action-item"; decisionId: string | null }
  | { kind: "adjourn" };

export function LiveMeeting(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [meeting, setMeeting] = useState<MeetingView | null>(null);
  const [packets, setPackets] = useState<PacketDigestView[]>([]);
  const [roster, setRoster] = useState<AttendanceView[]>([]);
  const [agenda, setAgenda] = useState<AgendaItemView[]>([]);
  const [decisions, setDecisions] = useState<DecisionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });

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
    setPackets((p.data ?? []) as PacketDigestView[]);
    const [att, agd, dec] = await Promise.all([
      loadAttendance(client, id),
      loadAgenda(client, id),
      loadDecisions(client, id),
    ]);
    setRoster(att);
    setAgenda(agd);
    setDecisions(dec);
    setLoading(false);
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The patients this meeting may record a decision about — the agenda, falling back to the packets. */
  const patients = useMemo(() => {
    const ids = new Set<string>();
    for (const a of agenda) if (a.patientId) ids.add(a.patientId);
    for (const p of packets) ids.add(p.patientId);
    return [...ids].map((pid) => ({ id: pid, label: `Patient ${short(pid)}` }));
  }, [agenda, packets]);

  const presentDisciplines = useMemo(
    () => new Set(roster.filter((r) => PRESENT_STATUSES.has(r.status)).map((r) => r.discipline)),
    [roster],
  );
  const missingQuorum = REQUIRED_QUORUM.filter((d) => !presentDisciplines.has(d));
  const openDecisions = decisions.filter((d) => d.status === "open").length;
  const isLive = meeting?.status === "live";

  async function onExcuse(rowId: string): Promise<void> {
    const res = await excuseAttendance(client, rowId);
    setNotice(
      res.ok ? "Attendance excused — the row is kept, out of the quorum present-set." : res.message,
    );
    if (res.ok) await load();
  }

  async function onSupersede(decisionId: string): Promise<void> {
    const res = await supersedeDecision(client, decisionId);
    setNotice(res.ok ? "Decision superseded — a new open decision replaces it." : res.message);
    if (res.ok) await load();
  }

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Live IDG Meeting"
          breadcrumb={meeting ? meeting.scheduledStart.slice(0, 10) : undefined}
          actions={
            meeting ? (
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <StatusPill
                  label={stateLabel(meeting.status)}
                  tone={MEETING_TONE[meeting.status] ?? "neutral"}
                />
                <Button
                  tone="tertiary"
                  onClick={() => setDialog({ kind: "attendance" })}
                  disabled={meeting.status === "adjourned" || meeting.status === "cancelled"}
                >
                  Check in
                </Button>
                <Button
                  tone="tertiary"
                  onClick={() => setDialog({ kind: "agenda" })}
                  disabled={meeting.status === "adjourned" || meeting.status === "cancelled"}
                >
                  Add agenda item
                </Button>
                <Button onClick={() => setDialog({ kind: "decision" })} disabled={!isLive}>
                  Record decision
                </Button>
                <Button
                  tone="secondary"
                  onClick={() => setDialog({ kind: "adjourn" })}
                  disabled={!isLive}
                >
                  Adjourn
                </Button>
              </div>
            ) : undefined
          }
        />
      }
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && meeting === null ? (
          <LoadingSpinner />
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {notice ? <output style={noticeBox}>{notice}</output> : null}

            <Section
              title="Attendance"
              count={roster.length}
              caption={
                missingQuorum.length === 0
                  ? "All four §2.7 disciplines are present. The server still decides quorum."
                  : `Not yet showing: ${missingQuorum.map(humanize).join(", ")}. Decisions stay available — the server refuses a non-quorate one.`
              }
            >
              {roster.length === 0 ? (
                <p style={emptyLine}>Nobody has checked in.</p>
              ) : (
                <ul style={list}>
                  {roster.map((r) => (
                    <li key={r.id} style={row}>
                      <span>
                        {humanize(r.discipline)}{" "}
                        <span className="wx-data-md">{short(r.membershipId)}</span>
                      </span>
                      <span style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                        <StatusPill
                          label={humanize(r.status)}
                          tone={PRESENT_STATUSES.has(r.status) ? "success" : "neutral"}
                        />
                        {r.status !== "excused" ? (
                          <Button tone="tertiary" size="sm" onClick={() => void onExcuse(r.id)}>
                            Excuse
                          </Button>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Agenda" count={agenda.length}>
              {agenda.length === 0 ? (
                <p style={emptyLine}>Nothing on the agenda yet.</p>
              ) : (
                <ul style={list}>
                  {agenda.map((a) => (
                    <li key={a.id} style={row}>
                      <span>{humanize(a.kind)}</span>
                      <span className="wx-data-md">{a.patientId ? short(a.patientId) : "—"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section
              title="Decisions"
              count={decisions.length}
              caption={
                openDecisions > 0
                  ? `${openDecisions} open — adjourning emits them to the downstream modules.`
                  : undefined
              }
            >
              {decisions.length === 0 ? (
                <p style={emptyLine}>No decisions recorded.</p>
              ) : (
                <ul style={list}>
                  {decisions.map((d) => (
                    <li key={d.id} style={row}>
                      <span>
                        {humanize(d.decisionKind)}{" "}
                        <span className="wx-data-md">
                          {d.patientId ? short(d.patientId) : "team"}
                        </span>
                      </span>
                      <span style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                        <StatusPill
                          label={humanize(d.status)}
                          tone={d.status === "superseded" ? "neutral" : "progress"}
                        />
                        {d.wasQuorate ? null : <StatusPill label="Not quorate" tone="warning" />}
                        <Button
                          tone="tertiary"
                          size="sm"
                          onClick={() => setDialog({ kind: "action-item", decisionId: d.id })}
                        >
                          Assign follow-up
                        </Button>
                        {d.status !== "superseded" ? (
                          <Button tone="tertiary" size="sm" onClick={() => void onSupersede(d.id)}>
                            Supersede
                          </Button>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Patients" count={packets.length}>
              {packets.length === 0 ? (
                <p style={emptyLine}>No patient packets are loaded for this meeting.</p>
              ) : (
                <ul style={list}>
                  {packets.map((p) => (
                    <li key={p.packetId}>
                      <button
                        type="button"
                        onClick={() =>
                          navigate(`/idg/meetings/${p.meetingId}/packets/${p.patientId}`)
                        }
                        style={packetButton}
                      >
                        <span>
                          Patient <span className="wx-data-md">{short(p.patientId)}</span>
                        </span>
                        <StatusPill
                          label={p.frozenAt ? "Frozen" : "Draft"}
                          tone={p.frozenAt ? "neutral" : "warning"}
                        />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            {id ? (
              <>
                <AttendanceModal
                  open={dialog.kind === "attendance"}
                  meetingId={id}
                  onClose={() => setDialog({ kind: "none" })}
                  onRecorded={() => void load()}
                />
                <AgendaModal
                  open={dialog.kind === "agenda"}
                  meetingId={id}
                  patients={patients}
                  onClose={() => setDialog({ kind: "none" })}
                  onAdded={() => void load()}
                />
                <DecisionModal
                  open={dialog.kind === "decision"}
                  meetingId={id}
                  patients={patients}
                  onClose={() => setDialog({ kind: "none" })}
                  onRecorded={() => void load()}
                />
                <ActionItemModal
                  open={dialog.kind === "action-item"}
                  meetingId={id}
                  patients={patients}
                  decisionId={dialog.kind === "action-item" ? dialog.decisionId : null}
                  onClose={() => setDialog({ kind: "none" })}
                  onCreated={() => setNotice("Action item assigned.")}
                />
                <LifecycleModal
                  open={dialog.kind === "adjourn"}
                  action="adjourn"
                  meetingId={id}
                  pending={{ decisions: openDecisions, patients: packets.length }}
                  onClose={() => setDialog({ kind: "none" })}
                  onDone={() => void load()}
                />
              </>
            ) : null}
          </div>
        )
      }
    />
  );
}

function Section({
  title,
  count,
  caption,
  children,
}: {
  title: string;
  count: number;
  caption?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <section style={sectionBox}>
      <header style={sectionHeader}>
        <h2 style={sectionTitle}>
          {title} <span style={{ fontWeight: 400 }}>({count})</span>
        </h2>
      </header>
      {caption ? <p style={captionText}>{caption}</p> : null}
      {children}
    </section>
  );
}

const sectionBox = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
  padding: "0.75rem 1rem 1rem",
} as const;
const sectionHeader = { display: "flex", justifyContent: "space-between" } as const;
const sectionTitle = { margin: "0 0 0.25rem", fontSize: "0.95rem", fontWeight: 600 } as const;
const captionText = {
  margin: "0 0 0.5rem",
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
} as const;
const list = { listStyle: "none", margin: 0, padding: 0 } as const;
const row = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  padding: "0.4rem 0",
  fontSize: "0.85rem",
} as const;
const emptyLine = {
  margin: 0,
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
} as const;
const packetButton = {
  cursor: "pointer",
  width: "100%",
  textAlign: "left",
  border: "none",
  background: "none",
  padding: "0.5rem 0",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  color: "var(--color-on-surface)",
} as const;
const noticeBox = {
  display: "block",
  margin: "0.75rem 1rem 0",
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
} as const;
