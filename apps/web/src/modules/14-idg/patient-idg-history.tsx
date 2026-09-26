import {
  EmptyState,
  Glyph,
  type GlyphName,
  LoadingSpinner,
  Panel,
  PatientWorkspaceLayout,
  StatusPill,
  type StatusTone,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/14-idg — the patient chart's IDG tab (2026-09-25 redesign, mockup "IDG").
// Spec: docs/modules/WARDENX_MODULE_14_IDG — the per-patient slice of the interdisciplinary group.
// KPI cards, the patient's IDG team (M5 care-team assignments), the upcoming meeting, the meetings this
// patient was reviewed in (M14 idg-history: decision kinds + action items), and the plan-of-care
// versions (M7) the IDG signs; the rail carries Patient Summary, Goals Progress, recent reviews and
// quick actions. The history is metadata-only by design — decision KINDS and action-item status, never
// packet or decision narrative — so the "notes" table lists what was decided, not free text. Per-member
// attendance, video links and a standing agenda are not modeled, so they are not drawn. The server owns
// every state (ADR-0030, no frontend authz).
import { useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import { GoalsProgressPanel } from "../../shell/goals-progress";
import { ChartBanner, PatientSummaryPanel, useChartIdentity } from "../../shell/patient-context";
import { ACTION_TONE, MEETING_TONE, stateLabel } from "./idg-status";

interface DecisionRow {
  id: string;
  decisionKind: string;
  status: string;
  wasQuorate: boolean;
  recordedAt: string | null;
}
interface ActionItemRow {
  id: string;
  status: string;
  discipline: string | null;
  dueDate: string | null;
  closedAt: string | null;
}
interface MeetingRow {
  meetingId: string;
  status: string;
  scheduledStart: string;
  actualStart: string | null;
  actualEnd: string | null;
  reviewedAt: string | null;
  packetFrozenAt: string | null;
  decisions: DecisionRow[];
  actionItems: ActionItemRow[];
}
interface Assignment {
  id: string;
  clinicianUserId: string;
  role: string;
  assignedAt: string;
  current: boolean;
}
interface Member {
  membershipId: string;
  userId: string;
  displayName: string | null;
  email: string | null;
}
interface PlanVersion {
  id: string;
  sequence: number;
  kind: string;
  status: string;
  draftedAt: string | null;
  signedAt: string | null;
  signatures: { signerRole: string; signedAt: string | null }[];
}
interface PlanSummary {
  id: string;
  versions: PlanVersion[];
  goals: { status: string }[];
}
interface ScheduledMeeting {
  id: string;
  locationId: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string;
}
interface NextMeeting {
  id: string;
  status: string;
  start: string;
  end: string | null;
  locationName: string | null;
  /** True when this patient has a packet on the meeting (i.e. is on its agenda). */
  onAgenda: boolean;
}

const DAY = 86_400_000;
const OPEN_ACTIONS = ["open", "in_progress"];
const CLOSED_MEETING = ["adjourned", "cancelled", "rescheduled"];

// Care-team role → the IDG discipline it represents (role-implied, not the person's license on file).
const ROLES: Record<string, { label: string; discipline: string }> = {
  primary_rn: { label: "Registered Nurse", discipline: "RN" },
  attending_clinician: { label: "Attending Physician", discipline: "MD" },
  case_manager_msw: { label: "Social Worker", discipline: "MSW" },
  chaplain: { label: "Chaplain", discipline: "Spiritual" },
  aide: { label: "Hospice Aide", discipline: "HHA" },
  np: { label: "Nurse Practitioner", discipline: "NP" },
  md: { label: "Medical Director", discipline: "MD" },
  volunteer: { label: "Volunteer", discipline: "Volunteer" },
  bereavement: { label: "Bereavement Coordinator", discipline: "Bereavement" },
};
const roleOf = (r: string) => ROLES[r] ?? { label: stateLabel(r), discipline: "—" };

const AVATAR_TINTS = [
  "var(--color-viz-green)",
  "var(--color-viz-violet)",
  "var(--color-viz-orange)",
  "var(--color-viz-blue)",
  "var(--color-viz-teal)",
  "var(--color-viz-pink)",
];

const VERSION_TONE: Record<string, StatusTone> = {
  active: "success",
  draft: "progress",
  pending_signature: "warning",
  superseded: "neutral",
};

function shortDate(v: string | null | undefined): string {
  if (!v) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function timeOf(v: string | null | undefined): string {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function initials(name: string): string {
  const parts = name.split(/[\s,._@-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}
function tint(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_TINTS[h % AVATAR_TINTS.length]!;
}
const VERSION_KINDS: Record<string, string> = {
  initial: "Initial Plan",
  idg_review: "IDG Review",
  interim_revision: "Interim Revision",
};
const versionKind = (k: string): string => VERSION_KINDS[k] ?? stateLabel(k);
const meetingDate = (m: MeetingRow): string => m.actualStart ?? m.scheduledStart;
const openItems = (m: MeetingRow): number =>
  m.actionItems.filter((a) => OPEN_ACTIONS.includes(a.status)).length;

export function PatientIdgHistory(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
  const identity = useChartIdentity(patientId);
  const orgId = identity?.patient.organizationId;
  const [meetings, setMeetings] = useState<MeetingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [team, setTeam] = useState<Assignment[] | null>(null);
  const [members, setMembers] = useState<Map<string, Member>>(new Map());
  const [plan, setPlan] = useState<PlanSummary | null | undefined>(undefined);
  const [scheduled, setScheduled] = useState<NextMeeting | null | undefined>(undefined);
  const [locations, setLocations] = useState<Map<string, string>>(new Map());
  const [ownDetail, setOwnDetail] = useState<{
    id: string;
    end: string;
    locationId: string;
  } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryKey re-runs the load on "Try again".
  useEffect(() => {
    if (!patientId) return;
    let active = true;
    setMeetings(null);
    setError(null);
    void client
      .GET("/api/v1/patients/{patientId}/idg-history", { params: { path: { patientId } } })
      .then((r) => {
        if (!active) return;
        if (r.error) throw new Error("Request failed");
        // `meetings` is published loosely on the wire (see idg-typebox note); the rich shape is `MeetingRow`.
        const rows = ((r.data as unknown as { meetings?: MeetingRow[] })?.meetings ?? []).sort(
          (a, b) => meetingDate(b).localeCompare(meetingDate(a)),
        );
        setMeetings(rows);
      })
      .catch(() => {
        if (active) setError("Could not load IDG history for this patient.");
      });
    void client
      .GET("/api/v1/patients/{id}/care-team", { params: { path: { id: patientId } } })
      .then((r) => {
        if (active) setTeam(((r.data?.assignments ?? []) as Assignment[]).filter((a) => a.current));
      })
      .catch(() => active && setTeam([]));
    void client
      .GET("/api/v1/patients/{patientId}/care-plan", { params: { path: { patientId } } })
      .then((r) => {
        if (active) setPlan(r.error ? null : ((r.data as unknown as PlanSummary) ?? null));
      })
      .catch(() => active && setPlan(null));
    return () => {
      active = false;
    };
  }, [client, patientId, retryKey]);

  // Names for the care team, and the org's next IDG meeting (when this patient has no packet on one yet).
  useEffect(() => {
    if (!orgId) return;
    let active = true;
    void client
      .GET("/api/v1/orgs/{id}/members", { params: { path: { id: orgId }, query: {} } })
      .then((r) => {
        if (!active) return;
        const map = new Map<string, Member>();
        for (const m of (r.data?.members ?? []) as Member[]) {
          map.set(m.userId, m);
          map.set(m.membershipId, m);
        }
        setMembers(map);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, orgId]);

  // The org's next IDG meeting across its sites, for a patient with no packet on an upcoming one yet.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const locs = await client.GET("/api/v1/locations", { params: { query: {} } });
        const items = (locs.data?.items ?? []).filter((l) => l.status !== "inactive").slice(0, 5);
        if (!active) return;
        setLocations(new Map(items.map((l) => [l.id, l.name])));
        const from = new Date().toISOString();
        const to = new Date(Date.now() + 30 * DAY).toISOString();
        const lists = await Promise.all(
          items.map((l) =>
            client
              .GET("/api/v1/idg/schedule", { params: { query: { location: l.id, from, to } } })
              .then((r) => (r.data ?? []) as ScheduledMeeting[])
              .catch(() => [] as ScheduledMeeting[]),
          ),
        );
        if (!active) return;
        const next = lists
          .flat()
          .filter((m) => !CLOSED_MEETING.includes(m.status))
          .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart))[0];
        setScheduled(
          next
            ? {
                id: next.id,
                status: next.status,
                start: next.scheduledStart,
                end: next.scheduledEnd,
                locationName: items.find((l) => l.id === next.locationId)?.name ?? null,
                onAgenda: false,
              }
            : null,
        );
      } catch {
        if (active) setScheduled(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [client]);

  const history = meetings ?? [];
  const now = Date.now();

  // A meeting the patient already has a packet on beats the org's next meeting.
  const next: NextMeeting | null | undefined = useMemo(() => {
    const own = [...history]
      .filter(
        (m) => !CLOSED_MEETING.includes(m.status) && Date.parse(m.scheduledStart) >= now - DAY,
      )
      .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart))[0];
    if (own) {
      const detail = ownDetail?.id === own.meetingId ? ownDetail : null;
      return {
        id: own.meetingId,
        status: own.status,
        start: own.scheduledStart,
        end: detail?.end ?? null,
        locationName: detail ? (locations.get(detail.locationId) ?? null) : null,
        onAgenda: true,
      };
    }
    return meetings === null && !error ? undefined : scheduled;
  }, [history, meetings, error, scheduled, now, ownDetail, locations]);

  // The history row has no end time or site; read them from the meeting itself.
  const nextId = next?.onAgenda ? next.id : null;
  useEffect(() => {
    if (!nextId) return;
    let active = true;
    void client
      .GET("/api/v1/idg/meetings/{id}", { params: { path: { id: nextId } } })
      .then((r) => {
        if (active && r.data) {
          setOwnDetail({ id: nextId, end: r.data.scheduledEnd, locationId: r.data.locationId });
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, nextId]);

  const past = history.filter((m) => m.status === "adjourned" || m.reviewedAt);
  const kpis = useMemo(() => {
    const items = history.flatMap((m) => m.actionItems);
    const open = items.filter((a) => OPEN_ACTIONS.includes(a.status));
    const versions = plan?.versions ?? [];
    return {
      members: team?.length ?? 0,
      disciplines: [...new Set((team ?? []).map((a) => roleOf(a.role).discipline))]
        .filter((d) => d !== "—")
        .join(", "),
      meetings: history.filter((m) => {
        const at = Date.parse(meetingDate(m));
        return at >= now - 60 * DAY && at <= now;
      }).length,
      open: open.length,
      overdue: open.filter((a) => a.dueDate && Date.parse(a.dueDate) < now).length,
      updates: versions.length,
      signed: versions.filter((v) => v.signedAt).length,
      drafts: versions.filter((v) => !v.signedAt).length,
    };
  }, [history, team, plan, now]);

  const memberName = (a: Assignment): string | null =>
    members.get(a.clinicianUserId)?.displayName ?? members.get(a.clinicianUserId)?.email ?? null;

  return (
    <PatientWorkspaceLayout
      banner={
        identity ? (
          <ChartBanner
            identity={identity}
            actions={
              <>
                <Link to={`/patients/${patientId}/care-plan`} className="wx-btn-secondary">
                  <Glyph name="clipboard-list" size={16} /> View Care Plan
                </Link>
                <Link
                  to={next ? `/idg/meetings/${next.id}` : "/idg/schedule"}
                  className="wx-btn-primary"
                >
                  <Glyph name="play" size={14} /> IDG Meeting
                </Link>
              </>
            }
          />
        ) : (
          <div className="wx-patient-banner" aria-busy="true" style={{ minHeight: "6.25rem" }} />
        )
      }
      rail={
        patientId ? (
          <>
            <PatientSummaryPanel identity={identity} />
            {plan ? (
              <GoalsProgressPanel
                goals={plan.goals}
                action={
                  <Link to={`/patients/${patientId}/care-plan`} style={{ fontWeight: 500 }}>
                    View all
                  </Link>
                }
              />
            ) : null}
            <RecentReviewsPanel meetings={past} />
            <QuickActions patientId={patientId} latest={past[0] ?? null} />
          </>
        ) : undefined
      }
    >
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        {patientId ? <ChartModuleRail patientId={patientId} current="idg" /> : null}
        <div style={{ flex: 1, overflow: "auto", padding: "1.25rem 1.5rem 1.5rem", minWidth: 0 }}>
          <section className="wx-chart-section" aria-label="IDG" aria-busy={meetings === null}>
            <div className="wx-page-head">
              <div style={{ maxWidth: "36rem" }}>
                <h1>Interdisciplinary Group (IDG)</h1>
                <p>
                  Coordinate hospice care through regular IDG reviews, plan-of-care updates, and
                  team follow-up.
                </p>
              </div>
              <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
                <Link
                  to={next ? `/idg/meetings/${next.id}` : "/idg/schedule"}
                  className="wx-version-card"
                >
                  <span style={{ color: t.primary }}>
                    <Glyph name="calendar" size={20} />
                  </span>
                  <span>
                    <span style={{ fontSize: "0.75rem", color: t.onSurfaceVariant }}>
                      Next IDG Meeting
                    </span>
                    <strong className="wx-nums">
                      {next === undefined
                        ? "Loading…"
                        : next
                          ? `${shortDate(next.start)} ${timeOf(next.start)}`
                          : "None scheduled"}
                    </strong>
                  </span>
                  <Glyph name="chevron-right" size={16} />
                </Link>
                <Link
                  to="/idg/schedule"
                  className="wx-btn-secondary"
                  style={{ alignSelf: "center" }}
                >
                  Schedule Meeting
                </Link>
              </div>
            </div>

            <div className="wx-stat-grid" aria-label="IDG summary">
              <StatCard
                icon="users"
                color={t.primary}
                value={kpis.members}
                label="IDG Members"
                hint={kpis.disciplines || "No care team assigned"}
              />
              <StatCard
                icon="calendar"
                color={t.primary}
                value={kpis.meetings}
                label="Meetings"
                hint="Last 60 days"
              />
              <StatCard
                icon="check"
                color={t.success}
                value={kpis.open}
                label="Open Action Items"
                hint={kpis.overdue ? `${kpis.overdue} overdue` : "None overdue"}
                hintTone={kpis.overdue ? "danger" : undefined}
              />
              <StatCard
                icon="file-text"
                color={t.primary}
                value={kpis.updates}
                label="Care Plan Updates"
                hint={
                  plan ? `${kpis.signed} signed · ${kpis.drafts} in draft` : "No plan of care yet"
                }
              />
            </div>

            {error ? (
              <div className="wx-list-state">
                <EmptyState title="IDG history unavailable" description={error} />
                <button
                  type="button"
                  className="wx-btn-secondary"
                  onClick={() => setRetryKey((k) => k + 1)}
                >
                  Try again
                </button>
              </div>
            ) : null}

            <div className="wx-idg-grid">
              <Card
                icon="users"
                title="IDG Team Members"
                action={
                  <Link
                    to={`/patients/${patientId}?view=care-team`}
                    className="wx-btn-secondary wx-btn-sm"
                  >
                    Edit Team
                  </Link>
                }
              >
                {team === null ? (
                  <LoadingSpinner />
                ) : team.length === 0 ? (
                  <p className="wx-row-sub">No clinicians are assigned to this patient yet.</p>
                ) : (
                  <table className="wx-mini-table">
                    <thead>
                      <tr>
                        <th scope="col">Role</th>
                        <th scope="col">Name</th>
                        <th scope="col">Discipline</th>
                        <th scope="col">Status</th>
                        <th scope="col">Assigned</th>
                      </tr>
                    </thead>
                    <tbody>
                      {team.map((a) => {
                        const name = memberName(a);
                        const badge = name ?? roleOf(a.role).label;
                        return (
                          <tr key={a.id}>
                            <td>
                              <span
                                style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
                              >
                                <span
                                  className="wx-mini-avatar"
                                  aria-hidden
                                  style={{
                                    color: tint(badge),
                                    background: `color-mix(in srgb, ${tint(badge)} 14%, ${t.surfaceLowest})`,
                                  }}
                                >
                                  {initials(badge)}
                                </span>
                                {roleOf(a.role).label}
                              </span>
                            </td>
                            <td style={{ fontWeight: 600 }}>
                              {name ?? <span className="wx-row-sub">Name unavailable</span>}
                            </td>
                            <td>{roleOf(a.role).discipline}</td>
                            <td>
                              <StatusPill label="Active" tone="success" />
                            </td>
                            <td className="wx-nums">{shortDate(a.assignedAt)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </Card>

              <Card
                icon="calendar-check"
                title={next?.onAgenda === false ? "Next IDG Meeting" : "Upcoming IDG Meeting"}
                action={
                  next ? (
                    <Link to={`/idg/meetings/${next.id}`} style={{ fontWeight: 500 }}>
                      Open
                    </Link>
                  ) : null
                }
              >
                {next === undefined ? (
                  <LoadingSpinner />
                ) : next === null ? (
                  <p className="wx-row-sub">
                    No IDG meeting is scheduled in the next 30 days.{" "}
                    <Link to="/idg/schedule">Open the IDG schedule</Link>
                  </p>
                ) : (
                  <>
                    <ul className="wx-meeting-facts">
                      <li>
                        <Glyph name="calendar" size={18} />
                        <div>
                          <strong>{shortDate(next.start)}</strong>
                          <span className="wx-nums">
                            {timeOf(next.start)}
                            {next.end ? ` – ${timeOf(next.end)}` : ""}
                          </span>
                        </div>
                      </li>
                      <li>
                        <Glyph name="building" size={18} />
                        <div>
                          <strong>Location</strong>
                          <span>{next.locationName ?? "See meeting details"}</span>
                        </div>
                      </li>
                      <li>
                        <Glyph name="activity" size={18} />
                        <div>
                          <strong>Status</strong>
                          <span>
                            <StatusPill
                              label={stateLabel(next.status)}
                              tone={MEETING_TONE[next.status] ?? "neutral"}
                            />
                          </span>
                        </div>
                      </li>
                      <li>
                        <Glyph name="file-check" size={18} />
                        <div>
                          <strong>Patient packet</strong>
                          <span>
                            {next.onAgenda
                              ? "Built — this patient is on the agenda"
                              : "Not built — patient not yet on this agenda"}
                          </span>
                        </div>
                      </li>
                    </ul>
                    <div style={{ display: "flex", gap: "0.625rem", flexWrap: "wrap" }}>
                      {next.status === "live" ? (
                        <Link to={`/idg/meetings/${next.id}/live`} className="wx-btn-primary">
                          <Glyph name="play" size={14} /> Join IDG Meeting
                        </Link>
                      ) : null}
                      {next.onAgenda && patientId ? (
                        <Link
                          to={`/idg/meetings/${next.id}/packets/${patientId}`}
                          className="wx-btn-secondary"
                        >
                          View Patient Packet
                        </Link>
                      ) : (
                        <Link to={`/idg/meetings/${next.id}`} className="wx-btn-secondary">
                          View Meeting
                        </Link>
                      )}
                    </div>
                  </>
                )}
              </Card>

              <Card
                icon="file-text"
                title="Recent IDG Reviews"
                action={
                  past.length > 0 ? (
                    <Link
                      to={`/idg/meetings/${past[0]!.meetingId}/minutes`}
                      style={{ fontWeight: 500 }}
                    >
                      Latest minutes
                    </Link>
                  ) : null
                }
              >
                {meetings === null && !error ? (
                  <LoadingSpinner />
                ) : past.length === 0 ? (
                  <p className="wx-row-sub">
                    This patient has not been reviewed in an IDG meeting yet. Reviews appear here
                    once the patient is placed on an agenda.
                  </p>
                ) : (
                  <table className="wx-mini-table">
                    <thead>
                      <tr>
                        <th scope="col">Date</th>
                        <th scope="col">Status</th>
                        <th scope="col">Decisions</th>
                        <th scope="col">Action Items</th>
                      </tr>
                    </thead>
                    <tbody>
                      {past.slice(0, 5).map((m) => (
                        <tr key={m.meetingId}>
                          <td className="wx-nums">
                            <Link to={`/idg/meetings/${m.meetingId}/minutes`}>
                              {shortDate(meetingDate(m))}
                            </Link>
                          </td>
                          <td>
                            <StatusPill
                              label={stateLabel(m.status)}
                              tone={MEETING_TONE[m.status] ?? "neutral"}
                            />
                          </td>
                          <td>
                            {m.decisions.length === 0
                              ? "No decisions recorded"
                              : m.decisions.map((d) => stateLabel(d.decisionKind)).join(", ")}
                            {m.decisions.some((d) => !d.wasQuorate) ? (
                              <span className="wx-row-sub" style={{ color: t.warning }}>
                                Non-quorate decision
                              </span>
                            ) : null}
                          </td>
                          <td>
                            <span
                              className="wx-count-dot"
                              title={`${openItems(m)} open of ${m.actionItems.length}`}
                              data-tone={openItems(m) > 0 ? "open" : "none"}
                            >
                              {openItems(m)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>

              <Card
                icon="clipboard-list"
                title="Care Plan Updates"
                action={
                  plan ? (
                    <Link to={`/care-plans/${plan.id}/versions`} style={{ fontWeight: 500 }}>
                      View all
                    </Link>
                  ) : null
                }
              >
                {plan === undefined ? (
                  <LoadingSpinner />
                ) : !plan || plan.versions.length === 0 ? (
                  <p className="wx-row-sub">No plan of care has been started for this patient.</p>
                ) : (
                  <table className="wx-mini-table">
                    <thead>
                      <tr>
                        <th scope="col">Date</th>
                        <th scope="col">Signed by</th>
                        <th scope="col">Type</th>
                        <th scope="col">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...plan.versions]
                        .sort((a, b) => b.sequence - a.sequence)
                        .slice(0, 5)
                        .map((v) => (
                          <tr key={v.id}>
                            <td className="wx-nums">{shortDate(v.signedAt ?? v.draftedAt)}</td>
                            <td>
                              {v.signatures.filter((s) => s.signedAt).length > 0
                                ? v.signatures
                                    .filter((s) => s.signedAt)
                                    .map((s) => stateLabel(s.signerRole))
                                    .join(", ")
                                : "—"}
                            </td>
                            <td>
                              {versionKind(v.kind)} v{v.sequence}
                            </td>
                            <td>
                              <StatusPill
                                label={stateLabel(v.status)}
                                tone={VERSION_TONE[v.status] ?? "neutral"}
                              />
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </div>
          </section>
        </div>
      </div>
    </PatientWorkspaceLayout>
  );
}

function StatCard({
  icon,
  color,
  value,
  label,
  hint,
  hintTone,
}: {
  icon: GlyphName;
  color: string;
  value: number;
  label: string;
  hint: string;
  hintTone?: "danger";
}): JSX.Element {
  return (
    <div className="wx-stat-card">
      <span
        aria-hidden
        className="wx-stat-icon"
        style={{ color, background: `color-mix(in srgb, ${color} 12%, ${t.surfaceLowest})` }}
      >
        <Glyph name={icon} size={24} strokeWidth={1.6} />
      </span>
      <div style={{ minWidth: 0 }}>
        <strong className="wx-stat-value wx-nums">{value}</strong>
        <div style={{ color: t.onSurface, fontSize: "0.875rem" }}>{label}</div>
        <div className="wx-stat-label" style={hintTone ? { color: t.error } : undefined}>
          {hint}
        </div>
      </div>
    </div>
  );
}

function Card({
  icon,
  title,
  action,
  children,
}: {
  icon: GlyphName;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="wx-foot-card" aria-label={title}>
      <header style={{ alignItems: "center" }}>
        <span style={{ color: t.primary, display: "flex" }}>
          <Glyph name={icon} size={20} strokeWidth={1.75} />
        </span>
        <h2 style={{ flex: 1 }}>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

function RecentReviewsPanel({ meetings }: { meetings: MeetingRow[] }): JSX.Element {
  return (
    <Panel title="Recent IDG Reviews" icon="clipboard-check">
      {meetings.length === 0 ? (
        <p style={{ margin: 0, color: t.onSurfaceVariant, fontSize: "0.8125rem" }}>
          No reviews yet.
        </p>
      ) : (
        <ul className="wx-recent-orders">
          {meetings.slice(0, 3).map((m) => (
            <li key={m.meetingId}>
              <span aria-hidden style={{ color: "var(--color-viz-violet)" }}>
                <Glyph name="users" size={18} strokeWidth={1.75} />
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <Link to={`/idg/meetings/${m.meetingId}/minutes`}>{shortDate(meetingDate(m))}</Link>
                <span className="wx-row-sub">
                  {m.decisions.length
                    ? m.decisions.map((d) => stateLabel(d.decisionKind)).join(", ")
                    : "Reviewed — no decisions"}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function QuickActions({
  patientId,
  latest,
}: {
  patientId: string;
  latest: MeetingRow | null;
}): JSX.Element {
  const links: { label: string; icon: GlyphName; to: string }[] = [
    { label: "Schedule IDG Meeting", icon: "calendar", to: "/idg/schedule" },
    { label: "My Action Items", icon: "check-circle", to: "/idg/action-items" },
    { label: "View Care Plan", icon: "clipboard-list", to: `/patients/${patientId}/care-plan` },
    ...(latest
      ? [
          {
            label: "Latest IDG Minutes",
            icon: "printer" as GlyphName,
            to: `/idg/meetings/${latest.meetingId}/minutes`,
          },
        ]
      : []),
    { label: "Manage Team Members", icon: "users", to: `/patients/${patientId}?view=care-team` },
  ];
  return (
    <Panel title="Quick Actions" icon="zap" flush>
      <ul className="wx-rail-links">
        {links.map((l) => (
          <li key={l.label}>
            <Link to={l.to}>
              <span style={{ color: t.primary }}>
                <Glyph name={l.icon} size={17} strokeWidth={1.75} />
              </span>
              <span style={{ flex: 1 }}>{l.label}</span>
              <Glyph name="chevron-right" size={16} strokeWidth={1.75} />
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
