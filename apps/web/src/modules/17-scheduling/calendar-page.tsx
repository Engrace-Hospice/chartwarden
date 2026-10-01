import {
  EmptyState,
  Glyph,
  type GlyphName,
  LoadingSpinner,
  Panel,
  StatusPill,
  inkOn,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/17-scheduling — Scheduling (M17 §5.1, Track B / ADR-0030; 2026-09-25 redesign,
// mockup "Scheduling"). The org calendar: a Day / Week / Month / List view of the visits in range
// (GET /visits from–to), a staff legend that filters the grid, the selected visit's details below it,
// and a right rail with a month picker, filters, the pending visit proposals ("unscheduled visits")
// and staff availability. Staff names come from the org member roster, disciplines from each
// clinician's credentials, and availability from their weekly hours and approved time off — every one
// of those reads is permission-gated, so a missing read degrades to a short id or "not set" rather
// than an error. Visit objectives, visit notes and visit priority are not modeled on the visit, so
// they are not drawn; the notes live on the linked encounter. The server enforces every scope
// (ADR-0030 — no authz on the frontend; an out-of-scope visit is simply absent).
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useSession } from "../../shell/session";
import { VISIT_TONE, stateLabel } from "./scheduling-status";
import {
  type EncounterLink,
  NewVisitModal,
  type VisitView,
  findLinkedEncounter,
  hasPermission,
} from "./scheduling-workflow";

type CalendarView = "day" | "week" | "month" | "list";

interface PatientSummary {
  id: string;
  mrn?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  dob?: string | null;
  status?: string | null;
}
interface Member {
  membershipId: string;
  displayName: string | null;
  email: string | null;
}
interface Credential {
  credentialType: string;
  status: string;
}
interface Availability {
  slots: { weekday: number; startTime: string; endTime: string }[];
}
interface TimeOff {
  membershipId: string;
  startsAt: string;
  endsAt: string;
  state: string;
}
interface Proposal {
  id: string;
  patientId: string;
  proposedVisitPurpose: string;
  proposedForDate: string;
  status: string;
}

const DISCIPLINES: Record<string, { label: string; color: string }> = {
  rn: { label: "RN", color: "var(--color-viz-blue)" },
  lpn: { label: "LPN", color: "var(--color-viz-cyan)" },
  chha: { label: "HHA", color: "var(--color-viz-rose)" },
  msw: { label: "MSW", color: "var(--color-viz-violet)" },
  chaplain: { label: "Chaplain", color: "var(--color-viz-amber)" },
  volunteer: { label: "Volunteer", color: "var(--color-viz-green)" },
  md: { label: "MD", color: "var(--color-viz-teal)" },
  np: { label: "NP", color: "var(--color-viz-teal)" },
};

// Visit purpose → display label and the discipline that usually performs it (the fallback color when
// the assigned clinician's credential is not readable).
const PURPOSES: Record<string, { label: string; discipline: string }> = {
  routine_visit: { label: "Routine Visit", discipline: "rn" },
  prn: { label: "PRN Visit", discipline: "rn" },
  aide_poc: { label: "HHA Visit", discipline: "chha" },
  msw_assessment: { label: "MSW Assessment", discipline: "msw" },
  msw_followup: { label: "MSW Follow-up", discipline: "msw" },
  chaplain_visit: { label: "Chaplain Visit", discipline: "chaplain" },
  chaplain_assessment: { label: "Chaplain Assessment", discipline: "chaplain" },
  volunteer_visit: { label: "Volunteer Visit", discipline: "volunteer" },
  f2f: { label: "Face-to-Face", discipline: "md" },
  recert: { label: "Recertification", discipline: "md" },
  loc_change: { label: "LOC Change", discipline: "rn" },
  pronouncement: { label: "Pronouncement", discipline: "rn" },
  admission_visit: { label: "Admission Visit", discipline: "rn" },
  discharge_visit: { label: "Discharge Visit", discipline: "rn" },
};
const purposeLabel = (p: string): string => PURPOSES[p]?.label ?? stateLabel(p);

const SETTINGS: Record<string, { label: string; icon: GlyphName }> = {
  patient_home: { label: "Patient Home", icon: "home" },
  facility: { label: "Facility", icon: "building" },
  inpatient_unit: { label: "Inpatient Unit", icon: "bed" },
  telephonic: { label: "Telephonic", icon: "phone" },
};

// Cancelled and rescheduled visits are superseded; they stay off the grid unless asked for.
const INACTIVE = new Set(["cancelled", "rescheduled"]);
const HOUR_PX = 44;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FETCH_CAP = 40;

// ── dates (local calendar days) ───────────────────────────────────────────────────────────────────────
function parseDay(value: string | null): Date {
  const m = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d: Date, n: number): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d: Date): Date => addDays(d, -((d.getDay() + 6) % 7));
const sameDay = (a: Date, b: Date): boolean => dayKey(a) === dayKey(b);
const fmt = (d: Date, o: Intl.DateTimeFormatOptions): string => d.toLocaleDateString("en-US", o);
const time = (d: Date): string =>
  d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

function rangeOf(view: CalendarView, date: Date): { start: Date; days: number } {
  if (view === "day") return { start: date, days: 1 };
  if (view === "month") {
    const first = new Date(date.getFullYear(), date.getMonth(), 1);
    return { start: mondayOf(first), days: 42 };
  }
  return { start: mondayOf(date), days: 7 };
}

function rangeLabel(view: CalendarView, date: Date): string {
  if (view === "day")
    return fmt(date, { weekday: "long", month: "short", day: "numeric", year: "numeric" });
  if (view === "month") return fmt(date, { month: "long", year: "numeric" });
  const s = mondayOf(date);
  const e = addDays(s, 6);
  return `${fmt(s, { month: "short", day: "numeric" })} – ${fmt(e, { month: "short", day: "numeric", year: "numeric" })}`;
}

// ── people ────────────────────────────────────────────────────────────────────────────────────────────
function patientName(p: PatientSummary | undefined): string | null {
  const name = [p?.firstName, p?.lastName].filter(Boolean).join(" ").trim();
  return name || null;
}
function ageOf(dob?: string | null): number | null {
  const m = dob ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob) : null;
  if (!m) return null;
  const now = new Date();
  let age = now.getFullYear() - Number(m[1]);
  const month = now.getMonth() + 1;
  if (month < Number(m[2]) || (month === Number(m[2]) && now.getDate() < Number(m[3]))) age -= 1;
  return age;
}
function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}
const maskMrn = (mrn?: string | null): string => (mrn ? `…${mrn.slice(-4)}` : "—");
const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m ?? 0);
};

export function CalendarPage(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const session = useSession();
  const permissions = session?.permissions;
  const orgId = session?.organizationId;
  const [params, setParams] = useSearchParams();
  const view: CalendarView =
    (["day", "month", "list"] as const).find((v) => v === params.get("view")) ?? "week";
  const date = useMemo(() => parseDay(params.get("date")), [params]);
  const range = useMemo(() => rangeOf(view, date), [view, date]);
  const rangeKey = `${dayKey(range.start)}:${range.days}`;

  const [visits, setVisits] = useState<VisitView[] | null>(null);
  const [error, setError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [patients, setPatients] = useState<Map<string, PatientSummary>>(new Map());
  const [members, setMembers] = useState<Map<string, Member>>(new Map());
  const [disciplines, setDisciplines] = useState<Map<string, string | null>>(new Map());
  const [availability, setAvailability] = useState<Map<string, Availability | null>>(new Map());
  const [timeOff, setTimeOff] = useState<TimeOff[]>([]);
  const [proposals, setProposals] = useState<Proposal[] | null | "denied">(null);
  const requested = useRef({ patients: new Set<string>(), staff: new Set<string>() });

  const [hiddenStaff, setHiddenStaff] = useState<Set<string>>(new Set());
  const [staffFilter, setStaffFilter] = useState("");
  const [purposeFilter, setPurposeFilter] = useState("");
  const [settingFilter, setSettingFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [creating, setCreating] = useState(false);

  function go(next: { view?: CalendarView; date?: Date }): void {
    const p = new URLSearchParams(params);
    p.set("view", next.view ?? view);
    p.set("date", dayKey(next.date ?? date));
    setParams(p);
  }
  function step(dir: 1 | -1): void {
    if (view === "month") go({ date: new Date(date.getFullYear(), date.getMonth() + dir, 1) });
    else go({ date: addDays(date, dir * (view === "day" ? 1 : 7)) });
  }

  // Visits in the visible range.
  // biome-ignore lint/correctness/useExhaustiveDependencies: retryKey re-runs the load on "Retry".
  useEffect(() => {
    let active = true;
    const [startKey, days] = rangeKey.split(":");
    const from = parseDay(startKey ?? null);
    const to = addDays(from, Number(days));
    setVisits(null);
    setError(false);
    void client
      .GET("/api/v1/visits", {
        params: {
          query: { from: from.toISOString(), to: new Date(to.getTime() - 1).toISOString() },
        },
      })
      .then((r) => {
        if (!active) return;
        if (r.error) setError(true);
        else setVisits(((r.data ?? []) as VisitView[]).slice());
      })
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, [client, rangeKey, retryKey]);

  // Pending proposals (the unscheduled visits), approved time off, and the staff roster — once.
  useEffect(() => {
    let active = true;
    if (hasPermission(permissions, "visit.proposal.read")) {
      void client
        .GET("/api/v1/visit-proposals", { params: { query: {} } })
        .then((r) => {
          if (active)
            setProposals(
              r.error
                ? "denied"
                : ((r.data ?? []) as Proposal[]).filter((p) => p.status === "pending"),
            );
        })
        .catch(() => active && setProposals("denied"));
    } else setProposals("denied");
    void client
      .GET("/api/v1/time-off", { params: { query: { state: "approved" } } })
      .then((r) => {
        if (active && !r.error) setTimeOff((r.data ?? []) as TimeOff[]);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, permissions]);

  useEffect(() => {
    if (!orgId) return;
    let active = true;
    void client
      .GET("/api/v1/orgs/{id}/members", { params: { path: { id: orgId }, query: {} } })
      .then((r) => {
        if (!active || r.error) return;
        setMembers(new Map(((r.data?.members ?? []) as Member[]).map((m) => [m.membershipId, m])));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, orgId]);

  // Patients behind the loaded visits and proposals.
  useEffect(() => {
    const ids = new Set<string>();
    for (const v of visits ?? []) ids.add(v.patientId);
    if (Array.isArray(proposals)) for (const p of proposals) ids.add(p.patientId);
    const missing = [...ids]
      .filter((id) => !requested.current.patients.has(id))
      .slice(0, FETCH_CAP);
    if (missing.length === 0) return;
    for (const id of missing) requested.current.patients.add(id);
    void Promise.all(
      missing.map((id) =>
        client
          .GET("/api/v1/patients/{id}", { params: { path: { id } } })
          .then((r) => (r.data ? ({ ...(r.data as object), id } as PatientSummary) : null))
          .catch(() => null),
      ),
    ).then((rows) =>
      setPatients((prev) => {
        const next = new Map(prev);
        for (const p of rows) if (p) next.set(p.id, p);
        return next;
      }),
    );
  }, [client, visits, proposals]);

  // Each assignee's discipline (credentials) and weekly hours (availability).
  useEffect(() => {
    const ids = [...new Set((visits ?? []).map((v) => v.assignedMembershipId))]
      .filter((id) => !requested.current.staff.has(id))
      .slice(0, FETCH_CAP);
    if (ids.length === 0) return;
    for (const id of ids) requested.current.staff.add(id);
    const canCred = hasPermission(permissions, "membership_credential.read");
    const canAvail = hasPermission(permissions, "availability.read");
    void Promise.all(
      ids.map(async (id) => {
        const [cred, avail] = await Promise.all([
          canCred
            ? client
                .GET("/api/v1/memberships/{membershipId}/credentials", {
                  params: { path: { membershipId: id } },
                })
                .then((r) => (r.data ?? []) as Credential[])
                .catch(() => [] as Credential[])
            : Promise.resolve([] as Credential[]),
          canAvail
            ? client
                .GET("/api/v1/availability", { params: { query: { membership: id } } })
                .then((r) => (r.error ? undefined : ((r.data ?? null) as Availability | null)))
                .catch(() => undefined)
            : Promise.resolve(undefined),
        ]);
        return {
          id,
          discipline: cred.find((c) => c.status === "active")?.credentialType ?? null,
          avail,
        };
      }),
    ).then((rows) => {
      setDisciplines(
        (prev) => new Map([...prev, ...rows.map((r) => [r.id, r.discipline] as const)]),
      );
      setAvailability((prev) => {
        const next = new Map(prev);
        for (const r of rows) if (r.avail !== undefined) next.set(r.id, r.avail);
        return next;
      });
    });
  }, [client, visits, permissions]);

  const staffName = (id: string): string => {
    const m = members.get(id);
    return m?.displayName ?? m?.email ?? `Clinician ${id.slice(0, 8)}`;
  };
  const disciplineOf = (id: string, purpose?: string): string | null =>
    disciplines.get(id) ?? (purpose ? (PURPOSES[purpose]?.discipline ?? null) : null);
  const colorOf = (v: VisitView): string =>
    DISCIPLINES[disciplineOf(v.assignedMembershipId, v.visitPurpose) ?? ""]?.color ?? t.primary;
  const patientLabel = (id: string): string => patientName(patients.get(id)) ?? "Patient";

  const staff = useMemo(() => {
    const ids = [...new Set((visits ?? []).map((v) => v.assignedMembershipId))];
    return ids
      .map((id) => {
        const m = members.get(id);
        const name = m?.displayName ?? m?.email ?? `Clinician ${id.slice(0, 8)}`;
        return { id, name, discipline: disciplines.get(id) ?? null };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [visits, members, disciplines]);

  const shown = useMemo(
    () =>
      (visits ?? [])
        .filter((v) => showInactive || !INACTIVE.has(v.status))
        .filter((v) => !hiddenStaff.has(v.assignedMembershipId))
        .filter((v) => !staffFilter || v.assignedMembershipId === staffFilter)
        .filter((v) => !purposeFilter || v.visitPurpose === purposeFilter)
        .filter((v) => !settingFilter || v.visitSetting === settingFilter)
        .filter((v) => !statusFilter || v.status === statusFilter)
        .sort((a, b) => Date.parse(a.scheduledStartedAt) - Date.parse(b.scheduledStartedAt)),
    [visits, showInactive, hiddenStaff, staffFilter, purposeFilter, settingFilter, statusFilter],
  );

  // Default selection: the next visit from now in the range, else the first.
  useEffect(() => {
    if (shown.length === 0) return;
    if (selectedId && shown.some((v) => v.id === selectedId)) return;
    const now = Date.now();
    setSelectedId((shown.find((v) => Date.parse(v.scheduledEndedAt) >= now) ?? shown[0]!).id);
  }, [shown, selectedId]);
  const selected = shown.find((v) => v.id === selectedId) ?? null;

  const filtersActive = Boolean(staffFilter || purposeFilter || settingFilter || statusFilter);
  const days = [...Array(view === "month" ? 42 : range.days)].map((_, i) =>
    addDays(range.start, i),
  );
  const canCreate = hasPermission(permissions, "visit.create");

  return (
    <div className="wx-sched">
      <div className="wx-sched-main">
        <header className="wx-page-head">
          <div>
            <h1 style={{ fontSize: "1.875rem" }}>Scheduling</h1>
            <p>Manage visits, staff schedules, and patient care activities.</p>
          </div>
          <div style={{ display: "flex", gap: "0.625rem", alignItems: "center" }}>
            <details className="wx-menu">
              <summary className="wx-btn-secondary">
                View Options <Glyph name="chevron-down" size={14} />
              </summary>
              <div className="wx-menu-list">
                <label>
                  <input
                    type="checkbox"
                    checked={showInactive}
                    onChange={(e) => setShowInactive(e.target.checked)}
                  />
                  Show cancelled and rescheduled
                </label>
              </div>
            </details>
            {canCreate ? (
              <button type="button" className="wx-btn-primary" onClick={() => setCreating(true)}>
                <Glyph name="plus" size={16} /> New Visit
              </button>
            ) : null}
            <details className="wx-menu">
              <summary className="wx-btn-secondary" aria-label="More scheduling tools">
                <Glyph name="more-horizontal" size={16} />
              </summary>
              <div className="wx-menu-list">
                {hasPermission(permissions, "visit.read_team") ? (
                  <Link to="/scheduling/day">Clinician day view</Link>
                ) : null}
                {hasPermission(permissions, "visit.read_metrics") ? (
                  <Link to="/admin/scheduling-metrics">Scheduling metrics</Link>
                ) : null}
                <Link to="/idg/schedule">IDG meetings</Link>
              </div>
            </details>
          </div>
        </header>

        <nav className="wx-subtabs" aria-label="Scheduling views">
          <Link to="/calendar" aria-current="page" className="is-current">
            Calendar
          </Link>
          <Link to="/me/visits">My Visits</Link>
          {hasPermission(permissions, "visit.proposal.read") ? (
            <Link to="/scheduling/proposals">Proposals</Link>
          ) : null}
          {hasPermission(permissions, "recurring_visit.read") ? (
            <Link to="/scheduling/recurring">Recurrence</Link>
          ) : null}
          {hasPermission(permissions, "time_off.read_team") ? (
            <Link to="/scheduling/time-off">Staff Time Off</Link>
          ) : null}
        </nav>

        <div className="wx-cal-toolbar">
          <button
            type="button"
            className="wx-btn-secondary wx-btn-square"
            aria-label="Previous"
            onClick={() => step(-1)}
          >
            <Glyph name="chevron-left" size={16} />
          </button>
          <button
            type="button"
            className="wx-btn-secondary wx-btn-square"
            aria-label="Next"
            onClick={() => step(1)}
          >
            <Glyph name="chevron-right" size={16} />
          </button>
          <button
            type="button"
            className="wx-btn-secondary"
            onClick={() => go({ date: parseDay(null) })}
          >
            Today
          </button>
          <h2 className="wx-cal-range">{rangeLabel(view, date)}</h2>
          <fieldset className="wx-seg wx-seg-solid">
            <legend className="wx-sr-only">Calendar view</legend>
            {(["day", "week", "month", "list"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                className={view === v ? "is-selected" : undefined}
                onClick={() => go({ view: v })}
              >
                {stateLabel(v)}
              </button>
            ))}
          </fieldset>
        </div>

        <section className={`wx-cal-panel${view === "week" || view === "day" ? " has-staff" : ""}`}>
          {view === "week" || view === "day" ? (
            <StaffLegend
              staff={staff}
              hidden={hiddenStaff}
              onToggle={(id) =>
                setHiddenStaff((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onAll={(on) => setHiddenStaff(on ? new Set() : new Set(staff.map((s) => s.id)))}
            />
          ) : null}
          <div className="wx-cal-body">
            {error ? (
              <div className="wx-list-state">
                <EmptyState
                  title="Visits unavailable"
                  description="The schedule could not be loaded."
                />
                <button
                  type="button"
                  className="wx-btn-secondary"
                  onClick={() => setRetryKey((k) => k + 1)}
                >
                  Retry
                </button>
              </div>
            ) : visits === null ? (
              <div className="wx-list-state">
                <LoadingSpinner />
              </div>
            ) : view === "month" ? (
              <MonthGrid
                days={days}
                month={date.getMonth()}
                visits={shown}
                colorOf={colorOf}
                patientLabel={patientLabel}
                onDay={(d) => go({ view: "day", date: d })}
                onSelect={setSelectedId}
              />
            ) : view === "list" ? (
              <VisitList
                visits={shown}
                colorOf={colorOf}
                patientLabel={patientLabel}
                staffName={staffName}
                selectedId={selectedId}
                onSelect={(id) => {
                  setSelectedId(id);
                  setPanelOpen(true);
                }}
              />
            ) : (
              <TimeGrid
                days={days}
                visits={shown}
                colorOf={colorOf}
                patientLabel={patientLabel}
                selectedId={panelOpen ? selectedId : null}
                onSelect={(id) => {
                  setSelectedId(id);
                  setPanelOpen(true);
                }}
              />
            )}
            {visits !== null && !error && shown.length === 0 ? (
              <p className="wx-cal-empty">
                {visits.length === 0
                  ? "No visits are scheduled in this range."
                  : "No visits match the current filters."}
              </p>
            ) : null}
          </div>
        </section>

        {selected && panelOpen ? (
          <VisitPanel
            visit={selected}
            patient={patients.get(selected.patientId)}
            staffName={staffName(selected.assignedMembershipId)}
            discipline={disciplineOf(selected.assignedMembershipId)}
            color={colorOf(selected)}
            onClose={() => setPanelOpen(false)}
          />
        ) : null}
      </div>

      <aside className="wx-sched-rail" aria-label="Scheduling tools">
        <Panel title="Calendar" icon="calendar">
          <MiniCalendar
            selected={date}
            marked={new Set((visits ?? []).map((v) => dayKey(new Date(v.scheduledStartedAt))))}
            onPick={(d) => go({ date: d })}
          />
        </Panel>

        <Panel
          title="Filters"
          icon="filter"
          action={
            filtersActive ? (
              <button
                type="button"
                className="wx-link-button"
                onClick={() => {
                  setStaffFilter("");
                  setPurposeFilter("");
                  setSettingFilter("");
                  setStatusFilter("");
                }}
              >
                Reset
              </button>
            ) : null
          }
        >
          <div className="wx-rail-filters">
            <RailSelect label="Staff" value={staffFilter} onChange={setStaffFilter}>
              <option value="">All staff</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </RailSelect>
            <RailSelect label="Visit type" value={purposeFilter} onChange={setPurposeFilter}>
              <option value="">All visit types</option>
              {Object.entries(PURPOSES).map(([k, p]) => (
                <option key={k} value={k}>
                  {p.label}
                </option>
              ))}
            </RailSelect>
            <RailSelect label="Location" value={settingFilter} onChange={setSettingFilter}>
              <option value="">All locations</option>
              {Object.entries(SETTINGS).map(([k, s]) => (
                <option key={k} value={k}>
                  {s.label}
                </option>
              ))}
            </RailSelect>
            <RailSelect label="Status" value={statusFilter} onChange={setStatusFilter}>
              <option value="">All statuses</option>
              {Object.keys(VISIT_TONE).map((s) => (
                <option key={s} value={s}>
                  {stateLabel(s)}
                </option>
              ))}
            </RailSelect>
          </div>
        </Panel>

        {proposals !== "denied" ? (
          <Panel
            title={`Unscheduled Visits${Array.isArray(proposals) ? ` (${proposals.length})` : ""}`}
            icon="alert-circle"
            action={<Link to="/scheduling/proposals">View all</Link>}
            flush
          >
            {proposals === null ? (
              <div className="wx-list-state">
                <LoadingSpinner />
              </div>
            ) : proposals.length === 0 ? (
              <p className="wx-rail-empty">No visit proposals are waiting to be scheduled.</p>
            ) : (
              <ul className="wx-rail-list">
                {proposals.slice(0, 4).map((p) => (
                  <li key={p.id}>
                    <span
                      className="wx-rail-icon"
                      style={{
                        color:
                          DISCIPLINES[PURPOSES[p.proposedVisitPurpose]?.discipline ?? ""]?.color ??
                          t.primary,
                      }}
                    >
                      <Glyph name="home" size={16} />
                    </span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <strong>{patientLabel(p.patientId)}</strong>
                      <span>{purposeLabel(p.proposedVisitPurpose)}</span>
                    </div>
                    <span className="wx-rail-tag wx-nums">
                      {fmt(parseDay(p.proposedForDate.slice(0, 10)), {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        ) : null}

        <StaffAvailability
          staff={staff}
          visits={visits ?? []}
          timeOff={timeOff}
          availability={availability}
          canReadHours={hasPermission(permissions, "availability.read")}
        />
      </aside>

      <NewVisitModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(visit) => {
          setCreating(false);
          navigate(`/scheduling/visits/${visit.id}`);
        }}
      />
    </div>
  );
}

// ── staff legend ──────────────────────────────────────────────────────────────────────────────────────
function StaffLegend({
  staff,
  hidden,
  onToggle,
  onAll,
}: {
  staff: { id: string; name: string; discipline: string | null }[];
  hidden: Set<string>;
  onToggle: (id: string) => void;
  onAll: (on: boolean) => void;
}): JSX.Element {
  return (
    <div className="wx-cal-staff">
      <div className="wx-cal-staff-head">Staff</div>
      <label className="wx-staff-check">
        <input
          type="checkbox"
          checked={hidden.size === 0}
          onChange={(e) => onAll(e.target.checked)}
          disabled={staff.length === 0}
        />
        <strong>All Staff</strong>
      </label>
      {staff.map((s) => {
        const d = s.discipline ? DISCIPLINES[s.discipline] : undefined;
        return (
          <label
            key={s.id}
            className="wx-staff-check"
            style={{ "--c": d?.color ?? t.primary } as CSSProperties}
          >
            <input type="checkbox" checked={!hidden.has(s.id)} onChange={() => onToggle(s.id)} />
            <span>
              <strong>{s.name}</strong>
              <small>{d?.label ?? "Discipline not set"}</small>
            </span>
          </label>
        );
      })}
    </div>
  );
}

// ── time grid (day + week) ────────────────────────────────────────────────────────────────────────────
function TimeGrid({
  days,
  visits,
  colorOf,
  patientLabel,
  selectedId,
  onSelect,
}: {
  days: Date[];
  visits: VisitView[];
  colorOf: (v: VisitView) => string;
  patientLabel: (id: string) => string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const today = new Date();
  // 8 AM – 6 PM by default, widened to fit any visit in range.
  let first = 8;
  let last = 18;
  for (const v of visits) {
    const s = new Date(v.scheduledStartedAt);
    const e = new Date(v.scheduledEndedAt);
    first = Math.min(first, s.getHours());
    last = Math.max(last, sameDay(s, e) ? Math.ceil(e.getHours() + e.getMinutes() / 60) : 24);
  }
  const hours = [...Array(last - first)].map((_, i) => first + i);
  return (
    <div className="wx-cal-scroll">
      <div className="wx-cal-grid" style={{ "--days": days.length } as CSSProperties}>
        <div className="wx-cal-corner" />
        {days.map((d) => (
          <div key={dayKey(d)} className={`wx-cal-dayhead${sameDay(d, today) ? " is-today" : ""}`}>
            <strong>{WEEKDAYS[d.getDay()]}</strong>
            <span className="wx-nums">{fmt(d, { month: "short", day: "numeric" })}</span>
          </div>
        ))}
        <div className="wx-cal-times">
          {hours.map((h) => (
            <span key={h} style={{ height: HOUR_PX }} className="wx-nums">
              {time(new Date(2000, 0, 1, h))}
            </span>
          ))}
        </div>
        {days.map((d) => (
          <div
            key={dayKey(d)}
            className={`wx-cal-col${sameDay(d, today) ? " is-today" : ""}`}
            style={{ height: hours.length * HOUR_PX, "--hour": `${HOUR_PX}px` } as CSSProperties}
          >
            {layoutDay(visits.filter((v) => sameDay(new Date(v.scheduledStartedAt), d))).map(
              ({ visit: v, lane, lanes }) => {
                const s = new Date(v.scheduledStartedAt);
                const e = new Date(v.scheduledEndedAt);
                const startMin = (s.getHours() - first) * 60 + s.getMinutes();
                const dur = Math.max(30, (e.getTime() - s.getTime()) / 60000);
                const c = colorOf(v);
                return (
                  <button
                    key={v.id}
                    type="button"
                    className={`wx-cal-event${v.id === selectedId ? " is-selected" : ""}${INACTIVE.has(v.status) ? " is-inactive" : ""}`}
                    style={
                      {
                        "--c": c,
                        top: (startMin / 60) * HOUR_PX + 2,
                        height: (dur / 60) * HOUR_PX - 4,
                        left: `calc(${(lane / lanes) * 100}% + 3px)`,
                        width: `calc(${100 / lanes}% - 6px)`,
                      } as CSSProperties
                    }
                    onClick={() => onSelect(v.id)}
                    title={`${patientLabel(v.patientId)} · ${purposeLabel(v.visitPurpose)} · ${time(s)}–${time(e)} · ${stateLabel(v.status)}`}
                  >
                    <Glyph name={SETTINGS[v.visitSetting]?.icon ?? "home"} size={15} />
                    <span>
                      <strong>{patientLabel(v.patientId)}</strong>
                      <small>{purposeLabel(v.visitPurpose)}</small>
                    </span>
                  </button>
                );
              },
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Side-by-side lanes for overlapping visits within one day. */
function layoutDay(visits: VisitView[]): { visit: VisitView; lane: number; lanes: number }[] {
  const sorted = [...visits].sort(
    (a, b) => Date.parse(a.scheduledStartedAt) - Date.parse(b.scheduledStartedAt),
  );
  const out: { visit: VisitView; lane: number; lanes: number }[] = [];
  let cluster: { visit: VisitView; lane: number; lanes: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = 0;
  const flush = () => {
    for (const c of cluster) c.lanes = laneEnds.length;
    out.push(...cluster);
    cluster = [];
    laneEnds = [];
  };
  for (const v of sorted) {
    const s = Date.parse(v.scheduledStartedAt);
    const e = Math.max(Date.parse(v.scheduledEndedAt), s + 30 * 60000);
    if (cluster.length && s >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= s);
    if (lane === -1) lane = laneEnds.push(e) - 1;
    else laneEnds[lane] = e;
    cluster.push({ visit: v, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, e);
  }
  flush();
  return out;
}

// ── month + list ──────────────────────────────────────────────────────────────────────────────────────
function MonthGrid({
  days,
  month,
  visits,
  colorOf,
  patientLabel,
  onDay,
  onSelect,
}: {
  days: Date[];
  month: number;
  visits: VisitView[];
  colorOf: (v: VisitView) => string;
  patientLabel: (id: string) => string;
  onDay: (d: Date) => void;
  onSelect: (id: string) => void;
}): JSX.Element {
  const today = new Date();
  return (
    <div className="wx-cal-scroll">
      <div className="wx-cal-month">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((w) => (
          <div key={w} className="wx-cal-month-head">
            {w}
          </div>
        ))}
        {days.map((d) => {
          const list = visits.filter((v) => sameDay(new Date(v.scheduledStartedAt), d));
          return (
            <div
              key={dayKey(d)}
              className={`wx-cal-month-cell${d.getMonth() === month ? "" : " is-outside"}${sameDay(d, today) ? " is-today" : ""}`}
            >
              <button type="button" className="wx-cal-month-day wx-nums" onClick={() => onDay(d)}>
                {d.getDate()}
              </button>
              {list.slice(0, 3).map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className="wx-cal-chip"
                  style={{ "--c": colorOf(v) } as CSSProperties}
                  onClick={() => {
                    onSelect(v.id);
                    onDay(d);
                  }}
                >
                  <span className="wx-nums">{time(new Date(v.scheduledStartedAt))}</span>{" "}
                  {patientLabel(v.patientId)}
                </button>
              ))}
              {list.length > 3 ? (
                <button type="button" className="wx-link-button" onClick={() => onDay(d)}>
                  +{list.length - 3} more
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function VisitList({
  visits,
  colorOf,
  patientLabel,
  staffName,
  selectedId,
  onSelect,
}: {
  visits: VisitView[];
  colorOf: (v: VisitView) => string;
  patientLabel: (id: string) => string;
  staffName: (id: string) => string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  if (visits.length === 0) return <div />;
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <thead>
          <tr>
            <th>Date &amp; Time</th>
            <th>Patient</th>
            <th>Visit Type</th>
            <th>Staff</th>
            <th>Location</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {visits.map((v) => {
            const s = new Date(v.scheduledStartedAt);
            return (
              <tr key={v.id} aria-selected={v.id === selectedId}>
                <td className="wx-nums">
                  <button type="button" className="wx-link-button" onClick={() => onSelect(v.id)}>
                    {fmt(s, { weekday: "short", month: "short", day: "numeric" })} · {time(s)}
                  </button>
                </td>
                <td>
                  <Link to={`/patients/${v.patientId}`}>{patientLabel(v.patientId)}</Link>
                </td>
                <td>
                  <span className="wx-status-dot" style={{ background: colorOf(v) }} />{" "}
                  {purposeLabel(v.visitPurpose)}
                </td>
                <td>{staffName(v.assignedMembershipId)}</td>
                <td>{SETTINGS[v.visitSetting]?.label ?? stateLabel(v.visitSetting)}</td>
                <td>
                  <StatusPill
                    label={stateLabel(v.status)}
                    tone={VISIT_TONE[v.status] ?? "neutral"}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── selected visit ────────────────────────────────────────────────────────────────────────────────────
const PROGRESS = ["published", "en_route", "in_visit", "completed"] as const;

function VisitPanel({
  visit,
  patient,
  staffName,
  discipline,
  color,
  onClose,
}: {
  visit: VisitView;
  patient: PatientSummary | undefined;
  staffName: string;
  discipline: string | null;
  color: string;
  onClose: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [encounter, setEncounter] = useState<EncounterLink | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    setEncounter(undefined);
    void findLinkedEncounter(client, visit)
      .then((e) => active && setEncounter(e))
      .catch(() => active && setEncounter(null));
    return () => {
      active = false;
    };
  }, [client, visit]);

  const name = patientName(patient) ?? "Patient";
  const age = ageOf(patient?.dob);
  const s = new Date(visit.scheduledStartedAt);
  const e = new Date(visit.scheduledEndedAt);
  const setting = SETTINGS[visit.visitSetting];
  const at = PROGRESS.indexOf(visit.status as (typeof PROGRESS)[number]);
  const primary =
    visit.status === "published"
      ? "Start Visit"
      : visit.status === "en_route"
        ? "Check In"
        : "Open Visit";

  return (
    <section className="wx-visit-panel" aria-label={`Visit for ${name}`}>
      <header className="wx-visit-panel-head">
        <span
          className="wx-home-avatar wx-avatar-lg"
          aria-hidden
          style={{
            color: inkOn(color),
            background: `color-mix(in srgb, ${color} 14%, ${t.surfaceLowest})`,
          }}
        >
          {initials(name)}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            <h2>{name}</h2>
            {patient?.status ? (
              <StatusPill label={stateLabel(patient.status)} tone="progress" />
            ) : null}
          </div>
          <div className="wx-row-sub wx-nums" style={{ fontSize: "0.8125rem" }}>
            {[
              patient?.dob
                ? `DOB ${fmt(parseDay(patient.dob), { month: "short", day: "numeric", year: "numeric" })}${age != null ? ` (${age}y)` : ""}`
                : null,
              patient?.mrn ? `MRN: ${maskMrn(patient.mrn)}` : null,
            ]
              .filter(Boolean)
              .join("  •  ") || "—"}
          </div>
        </div>
        <Link to={`/scheduling/visits/${visit.id}`} className="wx-btn-primary">
          <Glyph name={visit.status === "en_route" ? "check-circle" : "clock"} size={16} />{" "}
          {primary}
        </Link>
        {encounter ? (
          <Link
            to={`/patients/${encounter.patientId}/encounters/${encounter.id}`}
            className="wx-btn-secondary"
          >
            Open Documentation
          </Link>
        ) : null}
        <button
          type="button"
          className="wx-icon-link"
          aria-label="Close visit details"
          onClick={onClose}
        >
          <Glyph name="close" size={18} />
        </button>
      </header>
      <nav className="wx-detail-tabs" aria-label="Visit views">
        <span aria-current="page">Visit Details</span>
        <Link to={`/patients/${visit.patientId}`}>Patient Info</Link>
        <Link to={`/patients/${visit.patientId}/care-plan`}>Care Plan</Link>
        <Link to={`/patients/${visit.patientId}/medications`}>Medications</Link>
      </nav>
      <div className="wx-visit-panel-body">
        <section className="wx-drawer-card">
          <dl className="wx-kv-icons">
            <Fact icon="calendar" label="Date & Time">
              <span className="wx-nums">
                {fmt(s, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                <br />
                {time(s)} – {time(e)}
              </span>
            </Fact>
            <Fact icon="activity" label="Visit Type">
              {purposeLabel(visit.visitPurpose)}
            </Fact>
            <Fact icon="user" label="Staff">
              <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
                <span
                  className="wx-home-avatar"
                  aria-hidden
                  style={{
                    color: inkOn(color),
                    background: `color-mix(in srgb, ${color} 14%, ${t.surfaceLowest})`,
                  }}
                >
                  {initials(staffName)}
                </span>
                {staffName}
                {discipline
                  ? `, ${DISCIPLINES[discipline]?.label ?? discipline.toUpperCase()}`
                  : ""}
              </span>
            </Fact>
            <Fact icon={setting?.icon ?? "home"} label="Location">
              {setting?.label ?? stateLabel(visit.visitSetting)}
            </Fact>
          </dl>
        </section>

        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Visit Progress</h3>
            <StatusPill
              label={stateLabel(visit.status)}
              tone={VISIT_TONE[visit.status] ?? "neutral"}
            />
          </div>
          {at >= 0 ? (
            <ol className="wx-stepper">
              {PROGRESS.map((p, i) => (
                <li
                  key={p}
                  className={
                    i < at || (p === "completed" && at === i)
                      ? "is-done"
                      : i === at
                        ? "is-current"
                        : undefined
                  }
                >
                  <span className="wx-step-dot" aria-hidden>
                    {i < at || (p === "completed" && at === i) ? (
                      <Glyph name="check" size={12} strokeWidth={3} />
                    ) : (
                      i + 1
                    )}
                  </span>
                  <span>{p === "published" ? "Scheduled" : stateLabel(p)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="wx-row-sub">
              {visit.status === "proposed"
                ? "This visit is proposed and not yet published to the clinician."
                : visit.status === "rescheduled"
                  ? "This visit was moved; its replacement carries the schedule forward."
                  : visit.status === "no_show"
                    ? "Marked as a no-show; follow-up is tracked on the visit."
                    : "This visit was cancelled."}
            </p>
          )}
        </section>

        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Visit Documentation</h3>
          </div>
          {encounter === undefined ? (
            <LoadingSpinner />
          ) : encounter ? (
            <dl className="wx-kv">
              <dt>Encounter</dt>
              <dd>{stateLabel(encounter.encounterType)}</dd>
              <dt>Status</dt>
              <dd>
                <StatusPill
                  label={stateLabel(encounter.status)}
                  tone={encounter.signedAt ? "success" : "progress"}
                />
              </dd>
              <dt>Signed</dt>
              <dd className="wx-nums">
                {encounter.signedAt
                  ? fmt(new Date(encounter.signedAt), { month: "short", day: "numeric" })
                  : "Not yet"}
              </dd>
            </dl>
          ) : (
            <p className="wx-row-sub">
              No encounter is linked yet. The draft encounter is created once the visit is
              published; visit notes are written there.
            </p>
          )}
        </section>
      </div>
    </section>
  );
}

function Fact({
  icon,
  label,
  children,
}: { icon: GlyphName; label: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt>
        <Glyph name={icon} size={17} /> {label}
      </dt>
      <dd>{children}</dd>
    </>
  );
}

// ── rail ──────────────────────────────────────────────────────────────────────────────────────────────
function MiniCalendar({
  selected,
  marked,
  onPick,
}: {
  selected: Date;
  marked: Set<string>;
  onPick: (d: Date) => void;
}): JSX.Element {
  const [month, setMonth] = useState(
    () => new Date(selected.getFullYear(), selected.getMonth(), 1),
  );
  useEffect(() => setMonth(new Date(selected.getFullYear(), selected.getMonth(), 1)), [selected]);
  const start = addDays(month, -month.getDay());
  const today = new Date();
  return (
    <div className="wx-mini-cal">
      <div className="wx-mini-cal-head">
        <strong>{fmt(month, { month: "long", year: "numeric" })}</strong>
        <button
          type="button"
          className="wx-icon-link"
          aria-label="Previous month"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
        >
          <Glyph name="chevron-left" size={16} />
        </button>
        <button
          type="button"
          className="wx-icon-link"
          aria-label="Next month"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
        >
          <Glyph name="chevron-right" size={16} />
        </button>
      </div>
      <div className="wx-mini-cal-grid">
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((w) => (
          <span key={w} className="wx-mini-cal-dow">
            {w}
          </span>
        ))}
        {[...Array(42)].map((_, i) => {
          const d = addDays(start, i);
          if (d.getMonth() !== month.getMonth()) return <span key={dayKey(d)} />;
          return (
            <button
              key={dayKey(d)}
              type="button"
              className={[
                "wx-nums",
                sameDay(d, selected) ? "is-selected" : "",
                sameDay(d, today) ? "is-today" : "",
                marked.has(dayKey(d)) ? "has-visits" : "",
              ].join(" ")}
              aria-pressed={sameDay(d, selected)}
              onClick={() => onPick(d)}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RailSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <select
      className="wx-select"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {children}
    </select>
  );
}

function StaffAvailability({
  staff,
  visits,
  timeOff,
  availability,
  canReadHours,
}: {
  staff: { id: string; name: string; discipline: string | null }[];
  visits: VisitView[];
  timeOff: TimeOff[];
  availability: Map<string, Availability | null>;
  canReadHours: boolean;
}): JSX.Element {
  const [all, setAll] = useState(false);
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const statusOf = (id: string): { label: string; color: string } => {
    const current = visits.find(
      (v) => v.assignedMembershipId === id && (v.status === "in_visit" || v.status === "en_route"),
    );
    if (current?.status === "in_visit")
      return { label: "In visit", color: "var(--color-viz-amber)" };
    if (current) return { label: "En route", color: "var(--color-viz-blue)" };
    if (
      timeOff.some(
        (o) =>
          o.membershipId === id &&
          Date.parse(o.startsAt) <= now.getTime() &&
          Date.parse(o.endsAt) > now.getTime(),
      )
    )
      return { label: "Time off", color: t.muted };
    const a = availability.get(id);
    if (!canReadHours || a === undefined) return { label: "Hours not visible", color: t.muted };
    if (a === null || a.slots.length === 0) return { label: "Hours not set", color: t.muted };
    const on = a.slots.some(
      (s) =>
        s.weekday === now.getDay() &&
        minutesOf(s.startTime) <= nowMin &&
        nowMin < minutesOf(s.endTime),
    );
    return on ? { label: "Available", color: t.success } : { label: "Off shift", color: t.muted };
  };
  const rows = all ? staff : staff.slice(0, 4);
  return (
    <Panel
      title="Staff Availability"
      icon="users"
      flush
      action={
        staff.length > 4 ? (
          <button type="button" className="wx-link-button" onClick={() => setAll((v) => !v)}>
            {all ? "Show less" : "View all"}
          </button>
        ) : null
      }
    >
      {staff.length === 0 ? (
        <p className="wx-rail-empty">No staff have visits in this range.</p>
      ) : (
        <ul className="wx-rail-list">
          {rows.map((s) => {
            const d = s.discipline ? DISCIPLINES[s.discipline] : undefined;
            const c = d?.color ?? t.primary;
            const st = statusOf(s.id);
            return (
              <li key={s.id}>
                <span
                  className="wx-home-avatar"
                  aria-hidden
                  style={{
                    color: inkOn(c),
                    background: `color-mix(in srgb, ${c} 14%, ${t.surfaceLowest})`,
                  }}
                >
                  {initials(s.name)}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <strong>{s.name}</strong>
                  <span>{d?.label ?? "Discipline not set"}</span>
                </div>
                <span className="wx-avail" style={{ color: st.color }}>
                  <span className="wx-status-dot" style={{ background: st.color }} />
                  {st.label}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
