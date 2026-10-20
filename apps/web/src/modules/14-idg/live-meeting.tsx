import {
  Button,
  CountBadge,
  DataTable,
  type DataTableColumn,
  EmptyState,
  ErrorState,
  Glyph,
  type GlyphName,
  InfoRows,
  LoadingSpinner,
  Panel,
  StatusPill,
  type StatusTone,
  type operations,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/14-idg — Live Meeting Surface (M14 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_IDG_MEETING.md — "Use Work Queue + Documentation Workspace".
// 2026-09 "Lantern Clinical 2.0" redesign: flat sections (no boxes-in-boxes), three panes —
//   left   agenda / patient worklist (agenda kinds, carry-forward flag, packet state),
//   centre patient packet digest + the decision ledger and recorder,
//   right  attendance & quorum banner, action items, and the per-patient recert / F2F windows.
//
// The IDG Coordinator's in-meeting surface: 42 CFR 418.56(b) says the plan of care is established here and
// §418.56(d) says it is reviewed every 15 days. Every control below (check-in, agenda, decision, follow-up,
// supersede, excuse, status amendment, adjourn) is a mounted, guarded route; the three read ledgers
// (`GET .../attendance`, `.../agenda`, `.../decisions`) are F-062.
//
// THE QUORUM READOUT IS INFORMATION, NOT A GATE. §4.7's `quorate_decision` counts the roster
// server-side and refuses a non-quorate decision with a 422. This surface shows which of the four
// §2.7 disciplines are present because a coordinator needs to know who to call — but Record a
// decision stays ENABLED regardless, and the refusal is rendered where the coordinator is looking.
// Disabling it here would be a second implementation of the CoP composition rule, free to disagree
// with the one the server enforces (ADR-0030 — the server is the only enforcement point). A decision the
// server recorded while the group was not quorate carries `wasQuorate: false` and is shown as an
// annotation, not a binding decision.
//
// PATIENT NAMES arrive as the optional `patient: { displayName: "First L.", mrnSuffix }` the agenda / packet /
// decision / action-item reads now carry; when it is null or absent the short id is shown instead.
// RECERT / F2F WINDOWS come from `GET /idg/meetings/{id}/recert-windows` (org-local yyyy-mm-dd dates, one item
// per agenda patient). An `unknown` F2F status is rendered "Not available" — never guessed — and a failed read
// leaves one quiet line rather than a broken pane.
// LIVE UPDATES: there is no realtime channel to subscribe to (no socket/SSE gateway server-side; the UI's
// `SocketProvider` is unmounted), so while the meeting is `live` and the tab visible the surface polls its
// ledgers — see `use-live-refresh.ts`. The selected patient's packet content (cover + discipline tabs) is fetched per patient, cached, and NOT re-read
// on the poll — see `usePacketDetail` in packet-content.tsx.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { DisciplineNotesPanel, type NotesState } from "./discipline-notes";
import {
  type ActionItemView,
  type AddendumState,
  type AgendaItemView,
  type AttendanceStatus,
  type AttendanceView,
  type DecisionView,
  type DisciplineNoteView,
  IdgReadError,
  type MeetingView,
  type PacketDigestView,
  excuseAttendance,
  loadAgenda,
  loadAttendance,
  loadDecisions,
  loadDisciplineNotes,
  updateAttendance,
} from "./idg-api";
import { DecisionModal } from "./idg-decision-modal";
import {
  ActionItemModal,
  AgendaModal,
  AttendanceModal,
  LifecycleModal,
} from "./idg-meeting-modals";
import { ACTION_TONE, MEETING_TONE, stateLabel } from "./idg-status";
import { MeetingProgress } from "./idg-page-kit";
import "./live-meeting.css";
import { useSession } from "../../shell/session";
import { loadStaffNames } from "./idg-people";
import { PacketCompact, usePacketDetail } from "./packet-content";
import { useLiveRefresh } from "./use-live-refresh";

type RecertWindows = NonNullable<
  operations["getApiV1IdgMeetingsByIdRecertwindows"]["responses"][200]["content"]["application/json"]
>;
type RecertItem = RecertWindows["items"][number];
/** `unavailable` = the read failed (or returned nothing usable) — shown as one quiet line. */
type RecertState =
  | { readonly state: "loading" }
  | { readonly state: "ok"; readonly items: RecertItem[] }
  | { readonly state: "unavailable" };
interface PatientRef {
  readonly displayName: string;
  readonly mrnSuffix: string | null;
}

/** The four disciplines §2.7's `IDG_REQUIRED_QUORUM` looks for. Displayed, never enforced here. */
const REQUIRED_QUORUM = ["hospice_physician", "rn_case_manager", "msw", "chaplain"] as const;
const DISCIPLINE_LABEL: Record<string, string> = {
  hospice_physician: "Physician",
  rn_case_manager: "RN",
  msw: "MSW",
  chaplain: "Chaplain",
};
/** Statuses that count as PRESENT for the quorum readout (mirrors the server's present-set). */
const PRESENT_STATUSES = new Set(["present", "tardy", "partial"]);
/** §2.7 participation statuses, in the order the spec lists them. */
const ATTENDANCE_STATUSES: readonly AttendanceStatus[] = [
  "present",
  "tardy",
  "partial",
  "absent",
  "excused",
];
const ATTENDANCE_TONE: Record<string, StatusTone> = {
  present: "success",
  tardy: "warning",
  partial: "warning",
  absent: "error",
  excused: "neutral",
};

const short = (id: string): string => id.slice(0, 8);
const humanize = (k: string): string =>
  k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const disciplineLabel = (d: string): string => DISCIPLINE_LABEL[d] ?? humanize(d);

function dateOf(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function timeOf(v: string | null | undefined): string {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** Keep the previous reference when a poll returns identical data, so memos / modal effects stay stable. */
const keep =
  <T,>(next: T) =>
  (prev: T): T =>
    JSON.stringify(prev) === JSON.stringify(next) ? prev : next;

/** `yyyy-mm-dd` (org-local calendar day) → a local Date, so no timezone shift moves the day. */
function dayOf(v: string | null | undefined): string {
  if (!v) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return dateOf(v);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function recertDaysText(days: number | null): { text: string; overdue: boolean } {
  if (days === null) return { text: "", overdue: false };
  if (days === 0) return { text: "due today", overdue: false };
  if (days > 0) return { text: `in ${days} day${days === 1 ? "" : "s"}`, overdue: false };
  return { text: `${-days} day${days === -1 ? "" : "s"} overdue`, overdue: true };
}

/** F2F status → pill. Overdue/missed = error, window open = warning, attested = success, unknown = muted. */
function f2fPill(i: RecertItem): { label: string; tone: StatusTone } {
  if (i.f2fStatus === "attested") return { label: "Attested", tone: "success" };
  if (i.f2fStatus === "missed") return { label: "Missed", tone: "error" };
  if (i.f2fWindowState === "overdue") return { label: "Overdue", tone: "error" };
  switch (i.f2fStatus) {
    case "window_open":
      return { label: "Window open", tone: "warning" };
    case "not_yet_open":
      return { label: "Not yet open", tone: "neutral" };
    case "not_required":
      return { label: "Not required", tone: "neutral" };
    default:
      return { label: "Not available", tone: "neutral" };
  }
}

type Dialog =
  | { kind: "none" }
  | { kind: "attendance" }
  | { kind: "agenda" }
  | { kind: "decision" }
  | { kind: "action-item"; decisionId: string | null }
  | { kind: "adjourn" };

/** The heading follows the meeting's state: "Live" only while it is live. */
function meetingTitle(status: string | undefined): string {
  if (status === undefined || status === "live") return "Live IDG Meeting";
  if (status === "adjourned") return "IDG Meeting — Adjourned";
  if (status === "cancelled") return "IDG Meeting — Cancelled";
  if (status === "rescheduled") return "IDG Meeting — Rescheduled";
  return "IDG Meeting";
}

export function LiveMeeting(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const session = useSession();
  const canAttend = session?.permissions?.includes("idg.attend") ?? false;
  const canCoordinate = session?.permissions?.includes("idg.coordinate") ?? false;
  const canDecide = session?.permissions?.includes("idg.decide") ?? false;
  const canAct =
    session?.permissions?.includes("idg.act") === true ||
    session?.permissions?.includes("idg.coordinate") === true;
  const { id } = useParams<{ id: string }>();
  const [meeting, setMeeting] = useState<MeetingView | null>(null);
  const [packets, setPackets] = useState<PacketDigestView[]>([]);
  const [roster, setRoster] = useState<AttendanceView[]>([]);
  const [agenda, setAgenda] = useState<AgendaItemView[]>([]);
  const [decisions, setDecisions] = useState<DecisionView[]>([]);
  const [actionItems, setActionItems] = useState<ActionItemView[]>([]);
  const [actionItemsUnavailable, setActionItemsUnavailable] = useState(false);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [locationName, setLocationName] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ forbidden: boolean; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [recert, setRecert] = useState<RecertState>({ state: "loading" });
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [notes, setNotes] = useState<NotesState>({ state: "loading" });
  /** Addendum eligibility from the minutes view (adjourned meetings only); null = unknown → the server decides. */
  const [addendumState, setAddendumState] = useState<AddendumState | null>(null);

  const loadRecert = useCallback(
    async (signal?: AbortSignal) => {
      if (!id) return;
      try {
        const r = await client.GET("/api/v1/idg/meetings/{id}/recert-windows", {
          params: { path: { id } },
          signal,
        });
        const items = (r.data as { items?: unknown } | undefined)?.items;
        setRecert(
          keep<RecertState>(
            r.error || !Array.isArray(items)
              ? { state: "unavailable" }
              : { state: "ok", items: items as RecertItem[] },
          ),
        );
      } catch {
        if (signal?.aborted) return;
        setRecert(keep<RecertState>({ state: "unavailable" }));
      }
    },
    [client, id],
  );

  /** The meeting's discipline notes. A failed re-read keeps what is shown; only a first failure is "unavailable". */
  const loadNotes = useCallback(
    async (signal?: AbortSignal): Promise<DisciplineNoteView[] | null> => {
      if (!id) return null;
      try {
        const r = await loadDisciplineNotes(client, id, undefined, signal);
        if (signal?.aborted) return null;
        if (r.ok) {
          setNotes(keep<NotesState>({ state: "ok", notes: r.value }));
          return r.value;
        }
      } catch {
        if (signal?.aborted) return null;
      }
      setNotes((prev) => (prev.state === "ok" ? prev : { state: "unavailable" }));
      return null;
    },
    [client, id],
  );

  const loadAddendumState = useCallback(async () => {
    if (!id) return;
    try {
      const r = await client.GET("/api/v1/idg/meetings/{id}/minutes", { params: { path: { id } } });
      const st = (r.data as { addendumState?: AddendumState } | undefined)?.addendumState;
      if (st) setAddendumState(st);
    } catch {
      // Keep the last known state; the server still enforces eligibility on every write.
    }
  }, [client, id]);
  const meetingStatus = meeting?.status;
  useEffect(() => {
    if (meetingStatus === "adjourned") void loadAddendumState();
  }, [meetingStatus, loadAddendumState]);

  const loadActionItems = useCallback(async () => {
    if (!id) return;
    try {
      const r = await client.GET("/api/v1/idg/action-items", { params: { query: {} } });
      if (r.error) {
        setActionItemsUnavailable(true);
        return;
      }
      const rows = Array.isArray(r.data) ? (r.data as ActionItemView[]) : [];
      setActionItems(keep(rows.filter((a) => a.meetingId === id)));
      setActionItemsUnavailable(false);
    } catch {
      setActionItemsUnavailable(true);
    }
  }, [client, id]);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    void loadRecert();
    void loadNotes();
    try {
      const [m, p, att, agd, dec] = await Promise.all([
        client.GET("/api/v1/idg/meetings/{id}", { params: { path: { id } } }),
        client.GET("/api/v1/idg/meetings/{id}/packets", { params: { path: { id } } }),
        loadAttendance(client, id),
        loadAgenda(client, id),
        loadDecisions(client, id),
      ]);
      if (m.error || p.error) {
        const status = m.error ? m.response.status : p.response.status;
        setError({
          forbidden: status === 403 || status === 404,
          message:
            status === 403 || status === 404
              ? "This meeting is not available in your current access scope."
              : "Could not load the live meeting surface.",
        });
        setLoading(false);
        return;
      }
      setMeeting(keep((m.data ?? null) as MeetingView | null));
      setPackets(keep((p.data ?? []) as PacketDigestView[]));
      setRoster(keep(att));
      setAgenda(keep(agd));
      setDecisions(keep(dec));
      setLoading(false);
      setLoadedAt(Date.now());
      void loadActionItems();
    } catch (err) {
      const forbidden = err instanceof IdgReadError && (err.status === 403 || err.status === 404);
      setError({
        forbidden,
        message: forbidden
          ? "This meeting is not available in your current access scope."
          : "Could not load all required live meeting data.",
      });
      setLoading(false);
    }
  }, [client, id, loadActionItems, loadNotes, loadRecert]);

  /** One live poll: every ledger re-read with the abort signal; rejects when a core read fails (→ backoff). */
  const pollLedgers = useCallback(
    async (signal: AbortSignal) => {
      if (!id) return;
      const path = { params: { path: { id } }, signal };
      const [m, p, att, agd, dec] = await Promise.all([
        client.GET("/api/v1/idg/meetings/{id}", path),
        client.GET("/api/v1/idg/meetings/{id}/packets", path),
        client.GET("/api/v1/idg/meetings/{id}/attendance", path),
        client.GET("/api/v1/idg/meetings/{id}/agenda", path),
        client.GET("/api/v1/idg/meetings/{id}/decisions", path),
      ]);
      if (m.error || p.error || att.error || agd.error || dec.error) {
        throw new Error("live refresh failed");
      }
      setMeeting(keep((m.data ?? null) as MeetingView | null));
      setPackets(keep((p.data ?? []) as PacketDigestView[]));
      setRoster(keep((att.data ?? []) as AttendanceView[]));
      setAgenda(keep((agd.data ?? []) as AgendaItemView[]));
      setDecisions(keep((dec.data ?? []) as DecisionView[]));
      await Promise.all([loadActionItems(), loadRecert(signal), loadNotes(signal)]);
    },
    [client, id, loadActionItems, loadNotes, loadRecert],
  );
  const live = useLiveRefresh({ enabled: meeting?.status === "live", refresh: pollLedgers });

  useEffect(() => {
    void load();
  }, [load]);

  // Names for the roster / action-item assignees, and the site name — context only, never load-bearing.
  const orgId = meeting?.organizationId;
  const locationId = meeting?.locationId;
  useEffect(() => {
    if (!orgId) return;
    let active = true;
    void loadStaffNames(client, orgId).then((rows) => {
      if (!active) return;
      const map = new Map<string, string>();
      for (const m of rows) map.set(m.membershipId, m.displayName ?? "Unnamed staff member");
      setNames(map);
    });
    return () => {
      active = false;
    };
  }, [client, orgId]);
  useEffect(() => {
    if (!locationId) return;
    let active = true;
    void client
      .GET("/api/v1/locations", { params: { query: {} } })
      .then((r) => {
        const items = (r.data as { items?: { id: string; name: string }[] } | undefined)?.items;
        if (active && Array.isArray(items)) {
          setLocationName(items.find((l) => l.id === locationId)?.name ?? null);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, locationId]);

  /** Names carried on the reads (agenda / packets / decisions / action items / recert windows). */
  const patientRefs = useMemo(() => {
    const map = new Map<string, PatientRef>();
    const rows: { patientId?: string | null; patient?: PatientRef | null }[] = [
      ...agenda,
      ...packets,
      ...decisions,
      ...actionItems,
      ...(recert.state === "ok" ? recert.items : []),
    ];
    for (const r of rows)
      if (r.patientId && r.patient && !map.has(r.patientId)) map.set(r.patientId, r.patient);
    return map;
  }, [agenda, packets, decisions, actionItems, recert]);
  const patientLabel = useCallback(
    (pid: string): string => {
      const ref = patientRefs.get(pid);
      if (!ref) return `Patient ${short(pid)}`;
      return ref.mrnSuffix ? `${ref.displayName} · MRN …${ref.mrnSuffix}` : ref.displayName;
    },
    [patientRefs],
  );
  const nameOf = (pid: string): JSX.Element => {
    const ref = patientRefs.get(pid);
    if (!ref) {
      return (
        <>
          Patient <span className="wx-data-md">{short(pid)}</span>
        </>
      );
    }
    return (
      <>
        {ref.displayName}
        {ref.mrnSuffix ? <span className="wx-idg-live-mrn">MRN …{ref.mrnSuffix}</span> : null}
      </>
    );
  };

  /** The patients this meeting may record a decision about — the agenda, falling back to the packets. */
  const patients = useMemo(() => {
    const ids = new Set<string>();
    for (const a of agenda) if (a.patientId) ids.add(a.patientId);
    for (const p of packets) ids.add(p.patientId);
    return [...ids].map((pid) => ({ id: pid, label: patientLabel(pid) }));
  }, [agenda, packets, patientLabel]);

  const activePatient =
    selected && patients.some((p) => p.id === selected) ? selected : (patients[0]?.id ?? null);
  const activePacket = packets.find((p) => p.patientId === activePatient) ?? null;
  // The selected patient's packet content — fetched once per (patient, packet version), never per poll.
  const packetLoad = usePacketDetail(
    id,
    activePatient,
    activePacket ? `${activePacket.packetId}|${activePacket.frozenAt ?? "draft"}` : null,
  );
  const activeKinds = agenda.filter((a) => a.patientId === activePatient).map((a) => a.kind);

  const presentDisciplines = useMemo(
    () => new Set(roster.filter((r) => PRESENT_STATUSES.has(r.status)).map((r) => r.discipline)),
    [roster],
  );
  const missingQuorum = REQUIRED_QUORUM.filter((d) => !presentDisciplines.has(d));
  const quorate = missingQuorum.length === 0;
  const openDecisions = decisions.filter((d) => d.status === "open").length;
  const carryForward = agenda.filter((a) => a.kind === "carry_forward").length;
  const isLive = meeting?.status === "live";
  const closed =
    meeting?.status === "adjourned" ||
    meeting?.status === "cancelled" ||
    meeting?.status === "rescheduled";
  const coordinatorId = (meeting as { coordinatorMembershipId?: string } | null)
    ?.coordinatorMembershipId;
  const who = (membershipId: string): string => names.get(membershipId) ?? short(membershipId);

  async function onExcuse(rowId: string): Promise<void> {
    const version = roster.find((r) => r.id === rowId)?.version ?? 0;
    const res = await excuseAttendance(client, rowId, version);
    setNotice(
      res.ok ? "Attendance excused — the row is kept, out of the quorum present-set." : res.message,
    );
    if (res.ok) await load();
  }

  async function onStatus(rowId: string, status: AttendanceStatus): Promise<void> {
    const version = roster.find((r) => r.id === rowId)?.version ?? 0;
    const res = await updateAttendance(client, rowId, status, version);
    setNotice(res.ok ? `Attendance updated to ${humanize(status)}.` : res.message);
    if (res.ok) await load();
  }

  const otherAgenda = agenda.filter((a) => !a.patientId);
  const worklist = patients.map((p) => ({
    ...p,
    kinds: agenda.filter((a) => a.patientId === p.id).map((a) => a.kind),
    packet: packets.find((k) => k.patientId === p.id) ?? null,
    decisionCount: decisions.filter((d) => d.patientId === p.id).length,
  }));

  const openActionItems = actionItems.filter(
    (a) => a.status === "open" || a.status === "in_progress",
  ).length;
  const worklistRows = worklist;

  const worklistColumns: DataTableColumn<(typeof worklist)[number]>[] = [
    {
      id: "patient",
      header: "Patient",
      cell: (p) => <span className="wx-row-title">{nameOf(p.id)}</span>,
    },
    {
      id: "agenda",
      header: "Agenda",
      priority: "secondary",
      cell: (p) => (p.kinds.length > 0 ? p.kinds.map(humanize).join(", ") : "Packet only"),
    },
    {
      id: "decisions",
      header: "Decisions",
      priority: "secondary",
      numeric: true,
      cell: (p) => p.decisionCount,
    },
    {
      id: "packet",
      header: "Packet",
      cell: (p) =>
        p.packet ? (
          <StatusPill
            label={p.packet.frozenAt ? "Frozen" : "Draft"}
            tone={p.packet.frozenAt ? "neutral" : "warning"}
          />
        ) : (
          <span className="wx-row-sub">Not built</span>
        ),
    },
  ];

  const decisionColumns: DataTableColumn<DecisionView>[] = [
    {
      id: "decision",
      header: "Decision",
      cell: (d) => <span className="wx-row-title">{humanize(d.decisionKind)}</span>,
    },
    {
      id: "patient",
      header: "Patient",
      cell: (d) => (d.patientId ? nameOf(d.patientId) : "Team"),
    },
    {
      id: "status",
      header: "Status",
      cell: (d) => (
        <span className="wx-idg-live-pills">
          <StatusPill
            label={humanize(d.status)}
            tone={
              d.status === "superseded"
                ? "neutral"
                : d.status === "emitted"
                  ? "success"
                  : "progress"
            }
          />
          {d.wasQuorate ? null : <StatusPill label="Not quorate · annotation" tone="warning" />}
        </span>
      ),
    },
    {
      id: "recorded",
      header: "Recorded",
      priority: "secondary",
      cell: (d) => (
        <span className="wx-nums">
          {dateOf(d.recordedAt)} {timeOf(d.recordedAt)}
        </span>
      ),
    },
    {
      id: "actions",
      header: <span className="wx-sr-only">Actions</span>,
      cell: (d) => (
        <span className="wx-idg-live-cell-actions">
          {canCoordinate && isLive ? <Button
            tone="tertiary"
            size="sm"
            onClick={() => setDialog({ kind: "action-item", decisionId: d.id })}
          >
            Assign follow-up
          </Button> : null}
          {/* No Supersede action here on purpose. The server records the successor in a LATER, live, quorate
              meeting (POST /idg/decisions/:id/supersede takes that TARGET meeting id), and this row's decision
              belongs to the meeting being viewed, so offering it here could only ever 409/422. Follow-up: a
              target-meeting picker (later LIVE meetings with the patient on the caseload; `emitted` decisions
              only) that calls `supersedeDecision(client, decisionId, targetMeetingId)` from idg-api.ts. */}
        </span>
      ),
    },
  ];

  return (
    <div className="wx-with-rail wx-idg-live">
      <div className="wx-with-rail-main">
        <header className="wx-page-head">
          <div className="wx-idg-live-head-main">
            <h1 style={{ fontSize: "1.875rem" }}>{meetingTitle(meeting?.status)}</h1>
            {meeting ? (
              <p className="wx-idg-live-meta">
                <span>
                  <Glyph name="calendar" size={16} />
                  <span className="wx-nums">
                    {dateOf(meeting.scheduledStart)} · {timeOf(meeting.scheduledStart)} –{" "}
                    {timeOf(meeting.scheduledEnd)}
                  </span>
                </span>
                {locationName ? (
                  <span>
                    <Glyph name="building" size={16} />
                    {locationName}
                  </span>
                ) : null}
                {coordinatorId ? (
                  <span>
                    <Glyph name="user-circle" size={16} />
                    Coordinator {who(coordinatorId)}
                  </span>
                ) : null}
                <StatusPill
                  label={meeting.status === "adjourned" ? "Finalized" : stateLabel(meeting.status)}
                  tone={MEETING_TONE[meeting.status] ?? "neutral"}
                />
                <StatusPill
                  label={quorate ? "Quorate" : "Not quorate"}
                  tone={quorate ? "success" : "warning"}
                />
                {isLive ? (
                  <LiveIndicator
                    updatedAt={Math.max(live.lastUpdatedAt ?? 0, loadedAt ?? 0) || null}
                    failing={live.failing}
                  />
                ) : null}
                {id ? <Link to={`/idg/meetings/${id}`}>Meeting details</Link> : null}
                {id ? <Link to={`/idg/meetings/${id}/minutes`}>Minutes</Link> : null}
              </p>
            ) : null}
          </div>
          {meeting && (canAttend || canCoordinate || canDecide) ? (
            <div className="wx-idg-live-actions">
              {canAttend && !closed ? <Button
                tone="secondary"
                onClick={() => setDialog({ kind: "attendance" })}
              >
                Check in
              </Button> : null}
              {canCoordinate && !closed ? <Button
                tone="secondary"
                onClick={() => setDialog({ kind: "agenda" })}
              >
                Add agenda item
              </Button> : null}
              {canDecide && isLive ? <Button onClick={() => setDialog({ kind: "decision" })}>
                Record decision
              </Button> : null}
              {canCoordinate && isLive ? <Button
                tone="secondary"
                onClick={() => setDialog({ kind: "adjourn" })}
              >
                Finalize &amp; Adjourn
              </Button> : null}
            </div>
          ) : null}
        </header>

        {meeting ? (
          <MeetingProgress
            status={meeting.status}
            scheduledStart={meeting.scheduledStart}
            adjournedAt={meeting.adjournedAt}
          />
        ) : null}

        {error ? (
          <ErrorState
            title={error.forbidden ? "Meeting unavailable" : "Live meeting unavailable"}
            description={error.message}
            onRetry={() => void load()}
            action={<Link to="/idg/schedule">Back to schedule</Link>}
          />
        ) : loading && meeting === null ? (
          <LoadingSpinner />
        ) : (
          <>
            {notice ? (
              <output className="wx-idg-alert" data-tone="info" aria-live="polite">
                <Glyph name="check-circle" size={16} />
                <span>{notice}</span>
              </output>
            ) : null}
            {meeting && !isLive ? (
              meeting.status === "adjourned" ? (
                <p className="wx-idg-alert" data-tone="success">
                  <Glyph name="check-circle" size={16} />
                  <span>
                    <strong>Finalized</strong>
                    Historical attendance, agenda and decisions are read-only
                    {meeting.adjournedAt
                      ? ` since ${new Date(meeting.adjournedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`
                      : ""}. Action-item follow-up and authorized late addenda remain available.
                  </span>
                </p>
              ) : (
                <p className="wx-idg-alert" data-tone="warning">
                  <Glyph name="alert-circle" size={16} />
                  <span>
                    This meeting is {stateLabel(meeting.status).toLowerCase()}, not live — decisions,
                    new action items and adjournment are unavailable at this stage.
                  </span>
                </p>
              )
            ) : null}

            <div className="wx-stat-grid" aria-label="Meeting summary">
              <StatCard
                icon="users"
                label="Patients"
                value={worklist.length}
                hint={`${packets.filter((k) => k.frozenAt).length} of ${packets.length} packets frozen`}
              />
              <StatCard
                icon="scale"
                label="Decisions"
                value={decisions.length}
                hint={`${openDecisions} open`}
              />
              <StatCard
                icon="shield-check"
                label="Quorum"
                value={`${REQUIRED_QUORUM.length - missingQuorum.length} of ${REQUIRED_QUORUM.length}`}
                hint={quorate ? "All disciplines present" : `Missing ${missingQuorum.length}`}
                color={quorate ? t.success : t.warning}
              />
              <StatCard
                icon="check-circle"
                label="My action items"
                value={actionItems.length}
                hint={`${openActionItems} open`}
              />
            </div>

            {/* ── Patient worklist ─────────────────────────────────────────────────── */}
            <Region title="Patient worklist">
              <Panel
                title="Patient worklist"
                icon="users"
                flush
                action={<CountBadge count={worklist.length} tone="primary" />}
              >
                <DataTable
                  ariaLabel="Patient worklist"
                  rows={worklistRows}
                  columns={worklistColumns}
                  getRowId={(p) => p.id}
                  selectedRowId={activePatient}
                  onRowSelect={(p) => setSelected(p.id)}
                  empty={
                    <p className="wx-rail-empty">No patient packets are loaded for this meeting.</p>
                  }
                />
              </Panel>
            </Region>

            {/* ── Patient packet + agenda ──────────────────────────────────────────── */}
            <div className="wx-idg-live-pair">
              <Region title="Patient packet">
                <Panel
                  title="Patient packet"
                  icon="file-check"
                  action={
                    activePacket && id ? (
                      <Button
                        tone="secondary"
                        size="sm"
                        onClick={() =>
                          navigate(`/idg/meetings/${id}/packets/${activePacket.patientId}`)
                        }
                      >
                        Open full packet
                      </Button>
                    ) : undefined
                  }
                >
                  {activePatient === null ? (
                    <p className="wx-row-sub">
                      Select a patient from the worklist once one is on the agenda.
                    </p>
                  ) : (
                    <>
                      <InfoRows
                        labelWidth="7rem"
                        rows={[
                          { label: "Patient", value: nameOf(activePatient) },
                          {
                            label: "Agenda",
                            value: activeKinds.length ? activeKinds.map(humanize).join(", ") : "—",
                          },
                          {
                            label: "Packet",
                            value: activePacket ? (
                              activePacket.frozenAt ? (
                                <StatusPill label="Frozen" tone="neutral" />
                              ) : (
                                <StatusPill label="Draft (pre-adjournment)" tone="warning" />
                              )
                            ) : (
                              "Not built"
                            ),
                          },
                          {
                            label: "Frozen at",
                            value: (
                              <span className="wx-nums">
                                {activePacket?.frozenAt
                                  ? `${dateOf(activePacket.frozenAt)} ${timeOf(activePacket.frozenAt)}`
                                  : "—"}
                              </span>
                            ),
                          },
                        ]}
                      />
                      {packetLoad.status === "ok" ? (
                        <PacketCompact packet={packetLoad.packet} />
                      ) : packetLoad.status === "loading" ? (
                        <div className="wx-packet-compact" aria-busy="true">
                          <LoadingSpinner />
                        </div>
                      ) : packetLoad.status === "error" ? (
                        <p className="wx-row-sub" style={{ marginTop: "0.75rem" }} role="alert">
                          Could not load this patient's packet content. Open the full packet to
                          retry.
                        </p>
                      ) : (
                        <p className="wx-row-sub" style={{ marginTop: "0.75rem" }}>
                          No packet has been built for this patient yet.
                        </p>
                      )}
                    </>
                  )}
                </Panel>
              </Region>

              <Region title="Agenda">
                <Panel
                  title="Agenda"
                  icon="clipboard-list"
                  flush
                  action={<CountBadge count={agenda.length} tone="primary" />}
                >
                  {carryForward >= 3 ? (
                    <p
                      className="wx-idg-alert"
                      data-tone="warning"
                      style={{ margin: "0 1.125rem 0.75rem" }}
                    >
                      <Glyph name="alert-circle" size={16} />
                      <span>
                        {carryForward} carry-forward items are on this agenda — three or more raises
                        a compliance alert.
                      </span>
                    </p>
                  ) : null}
                  <DataTable
                    ariaLabel="Agenda items"
                    rows={agenda}
                    getRowId={(a) => a.id}
                    columns={[
                      {
                        id: "kind",
                        header: "Item",
                        cell: (a) => <span className="wx-row-title">{humanize(a.kind)}</span>,
                      },
                      {
                        id: "patient",
                        header: "Patient",
                        cell: (a) => (a.patientId ? nameOf(a.patientId) : "Meeting-level"),
                      },
                      {
                        id: "flag",
                        header: <span className="wx-sr-only">Flag</span>,
                        cell: (a) =>
                          a.kind === "carry_forward" ? (
                            <StatusPill label="Carry-forward" tone="warning" />
                          ) : null,
                      },
                    ]}
                    empty={<p className="wx-rail-empty">Nothing on the agenda yet.</p>}
                  />
                  {otherAgenda.length > 0 ? (
                    <p className="wx-row-sub" style={{ margin: "0.5rem 1.125rem 0.875rem" }}>
                      {otherAgenda.length} item(s) are not tied to a patient.
                    </p>
                  ) : null}
                </Panel>
              </Region>
            </div>

            {/* ── Discipline notes ─────────────────────────────────────────────────── */}
            <div id="discipline-notes">
              <Region title="Discipline notes">
                {id ? (
                  <DisciplineNotesPanel
                    meetingId={id}
                    live={isLive}
                    adjourned={meeting?.status === "adjourned"}
                    adjournedAt={meeting?.adjournedAt ?? null}
                    addendumState={addendumState}
                    statusLabel={meeting ? stateLabel(meeting.status) : ""}
                    notes={notes}
                    onReload={() => {
                      if (meetingStatus === "adjourned") void loadAddendumState();
                      return loadNotes();
                    }}
                    patientId={activePatient}
                    patientName={
                      activePatient
                        ? (patientRefs.get(activePatient)?.displayName ??
                          `Patient ${short(activePatient)}`)
                        : null
                    }
                    roster={roster}
                    callerMembershipId={session?.membershipId ?? null}
                    canWrite={canAttend || canCoordinate}
                    canEditAny={canCoordinate}
                    who={who}
                  />
                ) : null}
              </Region>
            </div>

            {/* ── Decisions ────────────────────────────────────────────────────────── */}
            <Region title="Decisions">
              <Panel
                title="Decisions"
                icon="scale"
                flush
                description={
                  openDecisions > 0
                    ? `${openDecisions} open — adjourning emits them to the downstream modules.`
                    : "Binding decisions need quorum at the moment of recording."
                }
                action={
                  <>
                    <CountBadge count={decisions.length} tone="primary" />
                    {canDecide ? <Button
                      tone="secondary"
                      size="sm"
                      onClick={() => setDialog({ kind: "decision" })}
                      disabled={!isLive}
                    >
                      Record for this patient
                    </Button> : null}
                  </>
                }
              >
                {!quorate ? (
                  <p
                    className="wx-idg-alert"
                    data-tone="warning"
                    style={{ margin: "0 1.125rem 0.75rem" }}
                  >
                    <Glyph name="alert-circle" size={16} />
                    <span>
                      The group is not quorate (missing{" "}
                      {missingQuorum.map(disciplineLabel).join(", ")}). The server refuses a binding
                      decision now; a row it recorded without quorum is marked as an annotation.
                    </span>
                  </p>
                ) : null}
                <DataTable
                  ariaLabel="Decisions"
                  rows={decisions}
                  columns={decisionColumns}
                  getRowId={(d) => d.id}
                  empty={<p className="wx-rail-empty">No decisions recorded.</p>}
                />
              </Panel>
            </Region>
          </>
        )}
      </div>

      {error || (loading && meeting === null) ? null : (
        <aside className="wx-with-rail-side" aria-label="Attendance, action items and recert">
          {/* ── Attendance & quorum ───────────────────────────────────────────────── */}
          <Region title="Attendance & quorum">
            <Panel
              title="Attendance & quorum"
              icon="shield-check"
              action={<CountBadge count={roster.length} tone="primary" />}
            >
              <div className="wx-idg-alert" data-tone={quorate ? "success" : "warning"}>
                <Glyph name={quorate ? "check-circle" : "alert-circle"} size={18} />
                <div>
                  <strong>
                    {quorate
                      ? "Quorate ✓ — Physician + RN + MSW + Chaplain present"
                      : `Not quorate — missing ${missingQuorum.map(disciplineLabel).join(", ")}`}
                  </strong>
                  <p>
                    {quorate
                      ? "All four §2.7 disciplines are present. The server still decides quorum."
                      : "Decisions stay available — the server refuses a non-quorate one."}
                  </p>
                </div>
              </div>
              <ul className="wx-idg-live-discs" aria-label="Required disciplines">
                {REQUIRED_QUORUM.map((d) => (
                  <li key={d} className="wx-idg-live-disc" data-present={presentDisciplines.has(d)}>
                    {presentDisciplines.has(d) ? <Glyph name="check" size={12} /> : null}
                    {disciplineLabel(d)}
                  </li>
                ))}
              </ul>
              {roster.length === 0 ? (
                <p className="wx-row-sub" style={{ marginTop: "0.75rem" }}>
                  Nobody has checked in.
                </p>
              ) : (
                <ul className="wx-idg-rail-list">
                  {roster.map((r) => (
                    <li key={r.id}>
                      <div className="wx-idg-rail-row">
                        <span style={{ minWidth: 0 }}>
                          <strong className="wx-row-title">{who(r.membershipId)}</strong>
                          <small className="wx-row-sub">{disciplineLabel(r.discipline)}</small>
                          {r.disciplineAttested ? (
                            <small className="wx-row-sub">
                              <StatusPill label="Attested by coordinator" tone="warning" />
                            </small>
                          ) : null}
                        </span>
                        <StatusPill
                          label={humanize(r.status)}
                          tone={ATTENDANCE_TONE[r.status] ?? "neutral"}
                        />
                      </div>
                      {canCoordinate && !closed ? <div className="wx-idg-rail-tools">
                        <select
                          className="wx-select"
                          aria-label={`Attendance status for ${who(r.membershipId)}`}
                          value={r.status}
                          disabled={closed}
                          onChange={(e) => void onStatus(r.id, e.target.value as AttendanceStatus)}
                        >
                          {ATTENDANCE_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {humanize(s)}
                            </option>
                          ))}
                        </select>
                        {r.status !== "excused" ? (
                          <Button tone="tertiary" size="sm" onClick={() => void onExcuse(r.id)}>
                            Excuse
                          </Button>
                        ) : null}
                      </div> : null}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </Region>

          {/* ── Action items ─────────────────────────────────────────────────────── */}
          <Region title="My action items">
            <Panel
              title="My action items"
              icon="check-circle"
              action={<CountBadge count={actionItems.length} tone="primary" />}
            >
              {actionItemsUnavailable ? (
                <p className="wx-row-sub" role="status">
                  Your action items could not be refreshed. Other meeting data remains available.
                </p>
              ) : actionItems.length === 0 ? (
                <p className="wx-row-sub">No follow-ups from this meeting are assigned to you.</p>
              ) : (
                <ul className="wx-idg-rail-list">
                  {actionItems.map((a) => (
                    <li key={a.id}>
                      <div className="wx-idg-rail-row">
                        <span style={{ minWidth: 0 }}>
                          <strong className="wx-row-title">{who(a.assignedToMembershipId)}</strong>
                          <small className="wx-row-sub wx-nums">
                            Due {dateOf(a.dueDate)}
                            {a.patientId ? <> · {nameOf(a.patientId)}</> : null}
                          </small>
                        </span>
                        <StatusPill
                          label={stateLabel(a.status)}
                          tone={ACTION_TONE[a.status] ?? "neutral"}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {canAct ? (
                <Link
                  to="/idg/action-items"
                  className="wx-btn-secondary"
                  style={{ marginTop: "0.75rem" }}
                >
                  Open my action-item queue
                </Link>
              ) : null}
            </Panel>
          </Region>

          {/* ── Recert & F2F windows ─────────────────────────────────────────────── */}
          <Region title="Recert & F2F windows">
            <Panel
              title="Recert & F2F windows"
              icon="calendar-check"
              action={
                recert.state === "ok" ? (
                  <CountBadge count={recert.items.length} tone="primary" />
                ) : undefined
              }
            >
              {recert.state === "loading" ? (
                <p className="wx-row-sub">Loading recert windows…</p>
              ) : recert.state === "unavailable" ? (
                <p className="wx-row-sub">Recert and F2F windows are unavailable right now.</p>
              ) : recert.items.length === 0 ? (
                <p className="wx-row-sub">No agenda patients have a recert window.</p>
              ) : (
                <ul className="wx-idg-rail-list">
                  {recert.items.map((r) => {
                    const days = recertDaysText(r.daysUntilNextRecert);
                    const pill = f2fPill(r);
                    const window =
                      r.f2fWindowStart && r.f2fWindowEnd
                        ? ` · window ${dayOf(r.f2fWindowStart)} – ${dayOf(r.f2fWindowEnd)}`
                        : "";
                    return (
                      <li key={r.patientId}>
                        <button
                          type="button"
                          className="wx-idg-rail-row wx-idg-pick"
                          aria-current={r.patientId === activePatient}
                          onClick={() => setSelected(r.patientId)}
                        >
                          <span style={{ minWidth: 0 }}>
                            <strong className="wx-row-title">{nameOf(r.patientId)}</strong>
                            <small className="wx-row-sub wx-nums" data-overdue={days.overdue}>
                              {r.nextRecertDueDate
                                ? `Recert due ${dayOf(r.nextRecertDueDate)}${days.text ? ` · ${days.text}` : ""}`
                                : "Recert date not available"}
                            </small>
                            <small className="wx-row-sub wx-nums">
                              {r.f2fStatus === "unknown"
                                ? "F2F status unknown"
                                : `F2F${window || " — n/a"}`}
                            </small>
                          </span>
                          <StatusPill label={pill.label} tone={pill.tone} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          </Region>
        </aside>
      )}

      {error || (loading && meeting === null) ? null : (
        <>
          {id ? (
            <>
              <AttendanceModal
                open={dialog.kind === "attendance"}
                meetingId={id}
                members={[...names].map(([memberId, label]) => ({ id: memberId, label }))}
                callerMembershipId={session?.membershipId ?? null}
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
                defaultPatientId={activePatient}
                quorum={{ quorate, missing: missingQuorum.map(disciplineLabel) }}
                onClose={() => setDialog({ kind: "none" })}
                onRecorded={() => void load()}
              />
              <ActionItemModal
                open={dialog.kind === "action-item"}
                meetingId={id}
                patients={patients}
                decisionId={dialog.kind === "action-item" ? dialog.decisionId : null}
                onClose={() => setDialog({ kind: "none" })}
                onCreated={() => {
                  setNotice("Action item assigned.");
                  void loadActionItems();
                }}
              />
              <LifecycleModal
                open={dialog.kind === "adjourn"}
                action="adjourn"
                meetingId={id}
                pending={{
                  ...(meeting ? { scheduledStart: meeting.scheduledStart } : {}),
                  decisions: openDecisions,
                  patients: packets.length,
                  quorumMet: roster.length === 0 ? null : quorate,
                  packetCount: packets.length,
                }}
                onClose={() => setDialog({ kind: "none" })}
                onDone={() => void load()}
              />
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A named landmark around a shared Panel, so screen-reader users (and tests) can jump to each pane. */
function Region({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section aria-label={title} className="wx-idg-region">
      {children}
    </section>
  );
}

export function StatCard({
  icon,
  label,
  value,
  hint,
  color,
}: {
  icon: GlyphName;
  label: string;
  value: ReactNode;
  hint: string;
  color?: string;
}): JSX.Element {
  const c = color ?? t.primary;
  return (
    <div className="wx-stat-card">
      <span
        className="wx-stat-icon"
        style={{ color: c, background: `color-mix(in srgb, ${c} 12%, ${t.surfaceLowest})` }}
      >
        <Glyph name={icon} size={20} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="wx-stat-label">{label}</div>
        <strong className="wx-stat-value wx-nums" style={color ? { color } : undefined}>
          {value}
        </strong>
        <div className="wx-stat-label">{hint}</div>
      </div>
    </div>
  );
}

/** "Live · updated Ns ago" — ticks on its own so the page does not re-render every second. */
function LiveIndicator({
  updatedAt,
  failing,
}: {
  updatedAt: number | null;
  failing: boolean;
}): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = updatedAt === null ? null : Math.max(0, Math.floor((now - updatedAt) / 1000));
  const ago =
    secs === null
      ? "updating…"
      : secs < 60
        ? `updated ${secs}s ago`
        : `updated ${Math.floor(secs / 60)}m ago`;
  return (
    <output className="wx-idg-live-pulse" data-failing={failing} aria-live="off">
      <span className="wx-idg-live-pulse-dot" aria-hidden="true" />
      {failing ? `Live · ${ago} · retrying` : `Live · ${ago}`}
    </output>
  );
}
