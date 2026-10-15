import {
  DataTable,
  type DataTableColumn,
  EmptyState,
  ErrorState,
  FlagChip,
  Glyph,
  InfoRows,
  LoadingSpinner,
  Panel,
  StatusPill,
  humanizeIdentifier,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/14-idg — Meeting Detail (pre-meeting) (M14 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_IDG_MEETING.md. 2026-09 "Lantern Clinical 2.0" redesign
// (flat page head + Panels, right context rail, kit DataTable, 8px-radius buttons). The IDG Coordinator's
// pre-meeting view: header (date/time, location, status, live quorum, packets ready) over the agenda by
// kind, the per-patient packet list, and a rail of attendance/quorum + schedule. The SERVER owns the §2.2
// lifecycle and §4.7 idg_meeting_scope ABAC (ADR-0030 — no frontend authz). Reads GET /idg/meetings/:id,
// /packets, /agenda, /attendance and GET /locations (for the site name).
//
// HONEST GAPS: the packets read carries each packet's patient + freeze state, NOT the as-presented
// summary / eligibility / recommendations (that is the full packet, /packets/:patientId) — so the center is
// a section scaffold + Open packet. Patients are shown as `patient.displayName` (+ MRN suffix) when the
// read carries it, else by id prefix; the coordinator is an id on the meeting read, named from
// GET /orgs/{id}/members (id-prefix fallback). The "carry-forward" flag is the agenda item's
// `carry_forward` kind; overdue-action-item detail is not returned here.
//
// #91 / F-062 — the attendance rail renders `GET /idg/meetings/:id/attendance`. The §2.2 transitions
// (build packets, start, cancel, reschedule) live here; the SERVER owns every one of them, and GAP-020's
// `per_patient_review_floor_clear` refuses a cancel/move that would push a patient past the 15-day floor.
// The buttons reflect the CURRENT status only so the coordinator is not offered a transition that is
// obviously not next; the refusal is still the server's.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  type AgendaItemView,
  type AttendanceView,
  IdgReadError,
  buildPackets,
  loadAgenda,
  loadAttendance,
  startMeeting,
} from "./idg-api";
import { type LifecycleAction, LifecycleModal } from "./idg-meeting-modals";
import { IdgStat, MeetingProgress } from "./idg-page-kit";
import { PatientLabel, type PatientRef, patientText, shortId, useMemberNames } from "./idg-people";
import { MEETING_TONE, stateLabel } from "./idg-status";
import { MeetingPromotions } from "./meeting-promotions";

interface MeetingView {
  id: string;
  organizationId?: string;
  coordinatorMembershipId?: string;
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
  patient?: PatientRef | null;
  frozenAt: string | null;
}

/** §2.7 `IDG_REQUIRED_QUORUM` — displayed, never enforced here (the server's `quorate_decision` decides). */
const REQUIRED_QUORUM: { discipline: string; label: string }[] = [
  { discipline: "hospice_physician", label: "Physician" },
  { discipline: "rn_case_manager", label: "RN" },
  { discipline: "msw", label: "MSW" },
  { discipline: "chaplain", label: "Chaplain" },
];
const PRESENT_STATUSES = new Set(["present", "tardy", "partial"]);
/** Spec: 3+ carry-forward agenda items raise a compliance alert. */
const CARRY_FORWARD_ALERT_AT = 3;
const PACKET_SECTIONS = [
  "As-presented summary",
  "Eligibility note",
  "Recommendations & decisions",
] as const;
const KIND_LABEL: Record<string, string> = {
  patient_review: "Patient review",
  carry_forward: "Carry-forward",
  administrative_note: "Administrative note",
  family_meeting_setup: "Family meeting setup",
  other: "Other",
};

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function MeetingDetail(): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const canCoordinate = session?.permissions?.includes("idg.coordinate") ?? false;
  const canSchedule = session?.permissions?.includes("idg.schedule") ?? false;
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [meeting, setMeeting] = useState<MeetingView | null>(null);
  const [packets, setPackets] = useState<PacketRow[]>([]);
  const [agenda, setAgenda] = useState<AgendaItemView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [roster, setRoster] = useState<AttendanceView[]>([]);
  const [locationName, setLocationName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ forbidden: boolean; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lifecycle, setLifecycle] = useState<LifecycleAction | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [m, p, nextRoster, nextAgenda] = await Promise.all([
        client.GET("/api/v1/idg/meetings/{id}", { params: { path: { id } } }),
        client.GET("/api/v1/idg/meetings/{id}/packets", { params: { path: { id } } }),
        loadAttendance(client, id),
        loadAgenda(client, id),
      ]);
      if (m.error || p.error) {
        const status = m.error ? m.response.status : p.response.status;
        setError({
          forbidden: status === 403 || status === 404,
          message:
            status === 403 || status === 404
              ? "This meeting is not available in your current access scope."
              : "Could not load this IDG meeting.",
        });
        setLoading(false);
        return;
      }
      setMeeting((m.data ?? null) as MeetingView | null);
      const rows = (p.data ?? []) as PacketRow[];
      setPackets(rows);
      setSelectedId((prev) => prev ?? rows[0]?.packetId ?? null);
      setRoster(nextRoster);
      setAgenda(nextAgenda);
      setLoading(false);
    } catch (err) {
      const forbidden = err instanceof IdgReadError && (err.status === 403 || err.status === 404);
      setError({
        forbidden,
        message: forbidden
          ? "This meeting is not available in your current access scope."
          : "Could not load all required meeting data.",
      });
      setLoading(false);
    }
  }, [client, id]);

  /** One helper for the two transitions that take no body; the modal carries the two that do. */
  async function transition(kind: "build" | "start"): Promise<void> {
    if (!id) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = kind === "build" ? await buildPackets(client, id) : await startMeeting(client, id);
      setNotice(
        res.ok
          ? kind === "build"
            ? "Packet build started."
            : "Meeting started — decisions can now be recorded."
          : res.message,
      );
      if (res.ok) await load();
    } catch {
      setNotice("The network request did not complete. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  // The meeting read carries only a location id; name it from the org's sites.
  const locationId = meeting?.locationId;
  useEffect(() => {
    if (!locationId) return;
    let active = true;
    void client
      .GET("/api/v1/locations", { params: { query: {} } })
      .then((r) => {
        if (!active) return;
        const items = Array.isArray(r.data?.items) ? r.data.items : [];
        setLocationName(items.find((l) => l.id === locationId)?.name ?? null);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, locationId]);

  const presentDisciplines = useMemo(
    () => new Set(roster.filter((r) => PRESENT_STATUSES.has(r.status)).map((r) => r.discipline)),
    [roster],
  );
  const missingQuorum = REQUIRED_QUORUM.filter((q) => !presentDisciplines.has(q.discipline));
  const carryForward = agenda.filter((a) => a.kind === "carry_forward").length;
  const memberNames = useMemberNames(meeting?.organizationId);
  const coordinator = meeting?.coordinatorMembershipId
    ? (memberNames.get(meeting.coordinatorMembershipId) ?? shortId(meeting.coordinatorMembershipId))
    : null;
  const packetByPatient = useMemo(() => new Map(packets.map((p) => [p.patientId, p])), [packets]);

  if (error || (loading && meeting === null) || meeting === null) {
    return (
      <div className="wx-with-rail" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
        <div className="wx-list-state">
          {error ? (
            <ErrorState
              title={error.forbidden ? "Meeting unavailable" : "Unable to load meeting"}
              description={error.message}
              onRetry={() => void load()}
              action={<Link to="/idg/schedule">Back to schedule</Link>}
            />
          ) : loading ? (
            <LoadingSpinner />
          ) : (
            <EmptyState title="Not found" description="This meeting is not available." />
          )}
        </div>
      </div>
    );
  }

  const ready = packets.filter((p) => p.frozenAt !== null).length;
  const selected = packets.find((p) => p.packetId === selectedId) ?? null;
  const building = meeting.status === "packets_building";
  const terminal = ["adjourned", "cancelled", "rescheduled"].includes(meeting.status);
  const quorumLabel =
    roster.length === 0
      ? { tone: "neutral" as const, text: "Quorum — no check-ins yet" }
      : missingQuorum.length === 0
        ? { tone: "success" as const, text: "Quorate — Physician + RN + MSW + Chaplain present" }
        : {
            tone: "warning" as const,
            text: `Not quorate — missing ${missingQuorum.map((q) => q.label).join(", ")}`,
          };

  const agendaColumns: DataTableColumn<AgendaItemView>[] = [
    {
      id: "kind",
      header: "Item",
      priority: "primary",
      cell: (a) => (
        <span style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <strong>{KIND_LABEL[a.kind] ?? stateLabel(a.kind)}</strong>
          {a.kind === "carry_forward" ? (
            <FlagChip label="Carry-forward" tone="warning" icon="rotate-ccw" />
          ) : null}
        </span>
      ),
    },
    {
      id: "patient",
      header: "Patient",
      priority: "primary",
      cell: (a) =>
        a.patientId ? (
          <PatientLabel patientId={a.patientId} patient={a.patient} />
        ) : (
          <span className="wx-row-sub">—</span>
        ),
    },
    {
      id: "packet",
      header: "Packet",
      priority: "secondary",
      cell: (a) => {
        if (!a.patientId) return <span className="wx-row-sub">—</span>;
        const p = packetByPatient.get(a.patientId);
        if (!p) return <StatusPill label="Not built" tone="neutral" />;
        return p.frozenAt ? (
          <StatusPill label="Built" tone="success" />
        ) : (
          <StatusPill label="Draft" tone="warning" />
        );
      },
    },
  ];

  const packetColumns: DataTableColumn<PacketRow>[] = [
    {
      id: "patient",
      header: "Patient",
      priority: "primary",
      cell: (p) => <PatientLabel patientId={p.patientId} patient={p.patient} />,
    },
    {
      id: "state",
      header: "Packet",
      priority: "primary",
      cell: (p) =>
        p.frozenAt ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
            <span style={{ color: t.success, display: "flex" }}>
              <Glyph name="check-circle" size={14} label="Packet frozen" />
            </span>
            <span className="wx-row-sub wx-nums">Frozen {p.frozenAt.slice(0, 10)}</span>
          </span>
        ) : (
          <StatusPill label="Draft" tone="warning" />
        ),
    },
  ];

  return (
    <div className="wx-with-rail">
      <div className="wx-with-rail-main">
        {/* Meeting header */}
        <div className="wx-page-head">
          <div style={{ minWidth: 0, flex: "1 1 22rem" }}>
            <div
              style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}
            >
              <h1 style={{ fontSize: "1.875rem" }}>IDG Meeting</h1>
              <StatusPill
                label={meeting.status === "adjourned" ? "Finalized" : stateLabel(meeting.status)}
                tone={MEETING_TONE[meeting.status] ?? "neutral"}
              />
            </div>
            <ul style={metaList}>
              <li style={metaItem}>
                <Glyph name="calendar" size={16} />
                <span className="wx-nums">
                  {dayLabel(meeting.scheduledStart)} · {timeLabel(meeting.scheduledStart)} –{" "}
                  {timeLabel(meeting.scheduledEnd)}
                </span>
              </li>
              <li style={metaItem}>
                <Glyph name="building" size={16} />
                <span>{locationName ?? "Location unavailable"}</span>
              </li>
              {coordinator ? (
                <li style={metaItem}>
                  <Glyph name="user" size={16} />
                  <span>Coordinator: {coordinator}</span>
                </li>
              ) : null}
            </ul>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {canCoordinate && meeting.status === "scheduled" ? (
              <button
                type="button"
                className="wx-btn-secondary"
                onClick={() => void transition("build")}
                disabled={busy}
              >
                Build packets
              </button>
            ) : null}
            {canCoordinate && meeting.status === "packets_ready" ? (
              <button
                type="button"
                className="wx-btn-secondary"
                onClick={() => void transition("start")}
                disabled={busy}
              >
                Start meeting
              </button>
            ) : null}
            {canSchedule && (meeting.status === "scheduled" || meeting.status === "packets_ready") ? (
              <>
                <button
                  type="button"
                  className="wx-btn-secondary"
                  onClick={() => setLifecycle("reschedule")}
                  disabled={busy}
                >
                  Reschedule
                </button>
                <button
                  type="button"
                  className="wx-btn-secondary"
                  onClick={() => setLifecycle("cancel")}
                  disabled={busy}
                >
                  Cancel
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="wx-btn-primary"
              onClick={() => navigate(`/idg/meetings/${meeting.id}/live`)}
            >
              <Glyph name={terminal ? "file-text" : "play"} size={14} />{" "}
              {meeting.status === "adjourned"
                ? "View finalized record"
                : terminal
                  ? "View meeting record"
                  : "Meeting workspace"}
            </button>
          </div>
        </div>

        <MeetingProgress
          status={meeting.status}
          scheduledStart={meeting.scheduledStart}
          adjournedAt={meeting.adjournedAt}
        />

        {notice ? (
          <output aria-live="polite" style={{ fontSize: "0.8125rem", color: t.onSurfaceVariant }}>{notice}</output>
        ) : null}

        <div className="wx-stat-grid" aria-label="Meeting summary">
          <IdgStat
            icon="clipboard-list"
            label="Agenda items"
            value={agenda.length}
            hint={carryForward > 0 ? `${carryForward} carry-forward` : "None carried forward"}
            color={carryForward > 0 ? t.warning : undefined}
          />
          <IdgStat
            icon="file-check"
            label="Packets ready"
            value={`${ready} / ${packets.length}`}
            hint={building ? "Build in progress" : "Frozen at build"}
            color={packets.length > 0 && ready === packets.length ? t.success : undefined}
          />
          <IdgStat
            icon="users"
            label="Checked in"
            value={roster.filter((r) => PRESENT_STATUSES.has(r.status)).length}
            hint={`${roster.length} on the roster`}
          />
          <IdgStat
            icon="shield-check"
            label="Quorum"
            value={`${REQUIRED_QUORUM.length - missingQuorum.length} / ${REQUIRED_QUORUM.length}`}
            hint={
              roster.length === 0
                ? "No check-ins yet"
                : missingQuorum.length === 0
                  ? "Quorate"
                  : `Missing ${missingQuorum.map((q) => q.label).join(", ")}`
            }
            color={
              roster.length === 0 ? undefined : missingQuorum.length === 0 ? t.success : t.warning
            }
          />
        </div>

        <LifecycleModal
          open={lifecycle !== null}
          action={lifecycle ?? "cancel"}
          meetingId={meeting.id}
          onClose={() => setLifecycle(null)}
          onDone={() => void load()}
        />

        {carryForward >= CARRY_FORWARD_ALERT_AT ? (
          <div role="alert" style={complianceAlert}>
            <Glyph name="alert" size={18} />
            <span>
              <strong>Compliance alert.</strong> {carryForward} carry-forward items are on this
              agenda — action items left open across meetings need review.
            </span>
          </div>
        ) : null}

        {building ? (
          <Panel
            title="Packets building"
            icon="package"
            description="The per-patient packets freeze as the build completes."
          >
            <div
              role="progressbar"
              tabIndex={0}
              aria-label="Packet build progress"
              aria-valuemin={0}
              aria-valuemax={packets.length}
              aria-valuenow={ready}
              style={progressTrack}
            >
              <div
                style={{
                  ...progressFill,
                  width: packets.length ? `${Math.round((ready / packets.length) * 100)}%` : "0%",
                }}
              />
            </div>
            <p className="wx-row-sub wx-nums" style={{ margin: "0.5rem 0 0.75rem" }}>
              {ready} of {packets.length} patient packets built
            </p>
            {packets.length === 0 ? (
              <p className="wx-row-sub" style={{ margin: 0 }}>
                No per-patient packets have appeared yet.
              </p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {packets.map((p) => (
                  <li key={p.packetId} style={railRow}>
                    <PatientLabel patientId={p.patientId} patient={p.patient} />
                    {p.frozenAt ? (
                      <StatusPill label="Built" tone="success" />
                    ) : (
                      <StatusPill label="Building" tone="progress" />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        ) : null}

        <Panel
          title="Agenda"
          icon="clipboard-list"
          description={`${agenda.length} ${agenda.length === 1 ? "item" : "items"}${
            carryForward > 0 ? ` · ${carryForward} carry-forward` : ""
          }`}
          flush
        >
          <DataTable
            ariaLabel="Meeting agenda"
            rows={agenda}
            columns={agendaColumns}
            getRowId={(a) => a.id}
            empty={
              <p className="wx-row-sub" style={{ margin: 0, padding: "0.5rem 1.125rem 1rem" }}>
                Nothing on the agenda yet.
              </p>
            }
          />
        </Panel>

        {canCoordinate && id ? (
          <MeetingPromotions meetingId={id} onAgendaChanged={() => void load()} />
        ) : null}

        <Panel
          title="Patient packets"
          icon="file-check"
          description={`${ready} / ${packets.length} ready`}
          flush
        >
          <DataTable
            ariaLabel="Patient packets"
            rows={packets}
            columns={packetColumns}
            getRowId={(p) => p.packetId}
            selectedRowId={selectedId}
            onRowSelect={(p) => setSelectedId(p.packetId)}
            empty={
              <p className="wx-row-sub" style={{ margin: 0, padding: "0.5rem 1.125rem 1rem" }}>
                No packets built yet.
              </p>
            }
          />
        </Panel>

        {selected ? (
          <Panel
            title={<>{patientText(selected.patientId, selected.patient)} — review packet</>}
            icon="clipboard-check"
            action={
              <button
                type="button"
                className="wx-btn-primary wx-btn-sm"
                onClick={() =>
                  navigate(`/idg/meetings/${selected.meetingId}/packets/${selected.patientId}`)
                }
              >
                Open full packet
              </button>
            }
          >
            {selected.frozenAt ? (
              <p style={{ ...metaLine, color: t.success }}>
                <Glyph name="check-circle" size={14} /> Frozen {selected.frozenAt.slice(0, 10)}
              </p>
            ) : (
              <p style={metaLine}>
                <StatusPill label="Draft packet" tone="warning" />
              </p>
            )}
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {PACKET_SECTIONS.map((s) => (
                <li key={s} style={railRow}>
                  <strong style={{ color: t.onSurface }}>{s}</strong>
                  <span className="wx-row-sub">in the full packet</span>
                </li>
              ))}
            </ul>
            <p className="wx-row-sub" style={{ margin: "0.75rem 0 0" }}>
              The care-plan snapshot, eligibility note and recommendations live on the full packet
              (frozen at build); open it to review and record the IDG decision.
            </p>
          </Panel>
        ) : packets.length > 0 ? (
          <EmptyState title="No packet selected" description="Select a packet to review it." />
        ) : null}
      </div>

      {/* Right rail — attendance/quorum + schedule */}
      <aside className="wx-with-rail-side" aria-label="Meeting context">
        <Panel title="Attendance & quorum" icon="users">
          {roster.length === 0 ? (
            <p className="wx-row-sub" style={{ margin: 0 }}>
              Nobody has checked in. Attendance is recorded on the live meeting surface; §4.7's
              `quorate_decision` counts these rows server-side.
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {roster.map((r) => (
                <li key={r.id} style={railRow}>
                  <span style={{ textTransform: "capitalize" }}>
                    {r.discipline.replace(/_/g, " ")}
                  </span>
                  {r.disciplineAttested ? (
                    <StatusPill label="Attested by coordinator" tone="warning" />
                  ) : null}
                  <StatusPill
                    label={humanizeIdentifier(r.status)}
                    tone={PRESENT_STATUSES.has(r.status) ? "success" : "neutral"}
                  />
                </li>
              ))}
            </ul>
          )}
          <p style={{ ...metaLine, marginTop: "0.75rem", color: t.onSurfaceVariant }}>
            {quorumLabel.text}. The server still decides quorum.
          </p>
        </Panel>

        <Panel title="Quick actions" icon="zap">
          <div style={{ display: "grid", gap: "0.5rem" }}>
            <Link
              to={`/idg/meetings/${meeting.id}/live`}
              className="wx-btn-secondary"
              style={{ justifyContent: "flex-start" }}
            >
              <Glyph name="play" size={16} /> Live surface
            </Link>
            <Link
              to={`/idg/schedule?location=${meeting.locationId}`}
              className="wx-btn-secondary"
              style={{ justifyContent: "flex-start" }}
            >
              <Glyph name="calendar" size={16} /> Back to schedule
            </Link>
            {meeting.status === "adjourned" ? (
              <Link
                to={`/idg/meetings/${meeting.id}/minutes`}
                className="wx-btn-secondary"
                style={{ justifyContent: "flex-start" }}
              >
                <Glyph name="file-text" size={16} /> View minutes
              </Link>
            ) : null}
          </div>
        </Panel>

        <Panel title="Schedule" icon="calendar">
          <InfoRows
            labelWidth="5rem"
            rows={[
              {
                label: "Date",
                value: <span className="wx-nums">{dayLabel(meeting.scheduledStart)}</span>,
              },
              {
                label: "Time",
                value: (
                  <span className="wx-nums">
                    {timeLabel(meeting.scheduledStart)} – {timeLabel(meeting.scheduledEnd)}
                  </span>
                ),
              },
              { label: "Location", value: locationName ?? "Location unavailable" },
              ...(coordinator ? [{ label: "Coordinator", value: coordinator }] : []),
              {
                label: "Status",
                value: (
                  <StatusPill
                    label={meeting.status === "adjourned" ? "Finalized" : stateLabel(meeting.status)}
                    tone={MEETING_TONE[meeting.status] ?? "neutral"}
                  />
                ),
              },
              {
                label: "Packets",
                value: (
                  <span className="wx-nums">
                    {ready} / {packets.length} ready
                  </span>
                ),
              },
              ...(meeting.adjournedAt
                ? [
                    {
                      label: "Adjourned",
                      value: (
                        <span className="wx-nums">
                          {dayLabel(meeting.adjournedAt)} {timeLabel(meeting.adjournedAt)}
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </Panel>
      </aside>
    </div>
  );
}

const metaList: CSSProperties = {
  listStyle: "none",
  margin: "0.5rem 0 0",
  padding: 0,
  display: "flex",
  flexWrap: "wrap",
  gap: "0.375rem 1.25rem",
  color: t.onSurfaceVariant,
  fontSize: "0.875rem",
};
const metaItem: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.35rem",
};
const metaLine: CSSProperties = {
  margin: "0 0 0.5rem",
  display: "flex",
  alignItems: "center",
  gap: "0.35rem",
  fontSize: "0.8125rem",
};
const railRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.5rem",
  padding: "0.5rem 0",
  fontSize: "0.8125rem",
  borderBottom: `1px solid ${t.cardBorder}`,
};
const progressTrack: CSSProperties = {
  height: "0.5rem",
  borderRadius: "9999px",
  background: t.surfaceContainer,
  overflow: "hidden",
};
const progressFill: CSSProperties = {
  height: "100%",
  background: t.primary,
  borderRadius: "9999px",
  transition: "width 0.2s ease",
};
const complianceAlert: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.625rem",
  padding: "0.75rem 1rem",
  borderRadius: t.radiusMd,
  background: `color-mix(in srgb, ${t.error} 8%, ${t.surfaceLowest})`,
  border: `1px solid color-mix(in srgb, ${t.error} 30%, ${t.cardBorder})`,
  color: t.error,
  fontSize: "0.875rem",
};
