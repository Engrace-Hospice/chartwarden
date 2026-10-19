import {
  EmptyState,
  ErrorState,
  Glyph,
  LoadingSpinner,
  Panel,
  StatusPill,
  interactiveRowProps,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/14-idg — IDG Schedule (per-location) (M14 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_IDG_MEETING.md. 2026-09 "Lantern Clinical 2.0" redesign:
// the org-level page anatomy shared with Billing / Admissions (idg-page-kit.tsx): page head, sub-page tabs,
// a label-first KPI strip derived from the rows actually returned, a boxed filter panel (search + Location
// + Status), the meetings table (one row per meeting with its §2.2 lifecycle chip) and a right rail (next
// meeting, quick actions, status mix — all from the rows already loaded).
// The SERVER owns the lifecycle and the §4.7 idg_meeting_scope / per_patient_review_floor_clear ABAC
// (ADR-0030 — no frontend authz). The location comes from `?location=`; when the URL carries none the
// screen lists the org's sites (GET /locations) and opens the first, so the nav entry is no longer a dead
// end (the F-081 finding). The range is midnight-anchored today → +8 weeks.
//
// "Schedule Meeting" (POST /idg/meetings, idg.schedule) opens ScheduleMeetingModal; the SERVER decides
// permission (a 403 is surfaced in the dialog), overlap and the time rules — no frontend authz. The
// coordinator is an id on the read; names resolve from GET /orgs/{id}/members (short-id fallback).
// Reads GET /api/v1/idg/schedule + GET /api/v1/locations via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  IdgFilter,
  IdgFilterPanel,
  IdgPageHead,
  IdgStat,
  IdgSubtabs,
  IdgTableFooter,
  PAGE_SIZE,
  dayLabel,
  timeLabel,
} from "./idg-page-kit";
import { shortId, useMemberNames } from "./idg-people";
import { MEETING_TONE, stateLabel } from "./idg-status";
import { ScheduleMeetingModal } from "./schedule-meeting-modal";

interface MeetingRow {
  id: string;
  locationId: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string;
  coordinatorMembershipId?: string;
}
interface LocationOption {
  id: string;
  name: string;
}

const DAY = 86_400_000;
const STATUSES = [
  "scheduled",
  "packets_building",
  "packets_ready",
  "live",
  "adjourned",
  "cancelled",
  "rescheduled",
] as const;
/** A meeting that still has work ahead of it (not closed out). */
const OPEN_STATUSES = ["scheduled", "packets_building", "packets_ready", "live"];

export function IdgSchedule(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const location = params.get("location") ?? undefined;
  const [locations, setLocations] = useState<LocationOption[] | null>(null);
  const [locationsError, setLocationsError] = useState(false);
  const [locationsRetry, setLocationsRetry] = useState(0);
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ kind: "forbidden" | "error"; message: string } | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const session = useSession();
  const canSchedule = session?.permissions?.includes("idg.schedule") ?? false;
  const memberNames = useMemberNames(session?.organizationId);
  const coordinatorName = useCallback(
    (id: string | undefined): string =>
      id ? (memberNames.get(id) ?? shortId(id)) : "Not assigned",
    [memberNames],
  );

  /**
   * The window this view reads, anchored at the START OF TODAY rather than at the current instant.
   *
   * F-081 — `from` used to be `new Date()`, and the server filters `scheduled_start >= from`. A meeting
   * IN SESSION started in the past by definition, so the moment a meeting went live it vanished from
   * the schedule that is supposed to be watching it, along with everything that finished earlier today.
   * The screen's own status filter offers `Live` and `Adjourned` — neither could ever match a row.
   * Midnight-anchored, today's meetings stay visible for the whole of today, which is what a
   * coordinator opening this page during an IDG expects to see.
   */
  const range = useMemo(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from.getTime() + 56 * DAY); // through the next 8 weeks
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

  // The org's sites, for the location picker and to name the location column.
  useEffect(() => {
    let active = true;
    setLocationsError(false);
    void client
      .GET("/api/v1/locations", { params: { query: {} } })
      .then((r) => {
        if (!active) return;
        if (r.error) throw new Error("locations read failed");
        const items = Array.isArray(r.data?.items) ? r.data.items : [];
        const activeLocations = items
          .filter((l) => l.status !== "inactive")
          .map((l) => ({ id: l.id, name: l.name }));
        const allowed = session?.orgWidePatientScope
          ? activeLocations
          : activeLocations.filter((candidate) =>
              (session?.locationIds ?? []).includes(candidate.id),
            );
        setLocations(allowed);
      })
      .catch(() => {
        if (!active) return;
        setLocationsError(true);
        setLocations([]);
      });
    return () => {
      active = false;
    };
  }, [client, locationsRetry, session?.locationIds, session?.orgWidePatientScope]);

  // No `?location=` → open the first site rather than a permanently empty screen.
  const firstLocationId = locations?.[0]?.id;
  useEffect(() => {
    if (!location && firstLocationId) {
      setParams({ location: firstLocationId }, { replace: true });
    } else if (location && locations && !locations.some((item) => item.id === location)) {
      if (firstLocationId) setParams({ location: firstLocationId }, { replace: true });
      else setParams({}, { replace: true });
    }
  }, [location, locations, firstLocationId, setParams]);

  const locationName = useCallback(
    (id: string): string => locations?.find((l) => l.id === id)?.name ?? "Location unavailable",
    [locations],
  );

  const load = useCallback(async () => {
    if (!location) {
      setLoading(false);
      return;
    }
    if (locations === null || !locations.some((item) => item.id === location)) return;
    setLoading(true);
    setError(null);
    const {
      data,
      error: err,
      response,
    } = await client.GET("/api/v1/idg/schedule", {
      params: { query: { location, from: range.from, to: range.to } },
    });
    if (err) {
      setError({
        kind: response.status === 403 || response.status === 404 ? "forbidden" : "error",
        message:
          response.status === 403 || response.status === 404
            ? "This location is not available in your current access scope."
            : "Could not load the IDG schedule for this location.",
      });
      setLoading(false);
      return;
    }
    setMeetings((data ?? []) as MeetingRow[]);
    setLoading(false);
  }, [client, location, locations, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = useMemo(
    () => [...meetings].sort((a, b) => Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart)),
    [meetings],
  );

  const kpis = useMemo(() => {
    const now = Date.now();
    const upcoming = sorted.filter((m) => OPEN_STATUSES.includes(m.status));
    const next = upcoming.find((m) => Date.parse(m.scheduledEnd) >= now) ?? null;
    return {
      total: sorted.length,
      upcoming: upcoming.length,
      ready: sorted.filter((m) => m.status === "packets_ready").length,
      building: sorted.filter((m) => m.status === "packets_building").length,
      live: sorted.filter((m) => m.status === "live").length,
      next,
    };
  }, [sorted]);

  const rows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return sorted.filter((m) => {
      const matchesStatus = !status || m.status === status;
      const matchesSearch =
        !q ||
        m.id.toLowerCase().includes(q) ||
        locationName(m.locationId).toLowerCase().includes(q) ||
        coordinatorName(m.coordinatorMembershipId).toLowerCase().includes(q) ||
        stateLabel(m.status).toLowerCase().includes(q);
      return matchesStatus && matchesSearch;
    });
  }, [sorted, searchQuery, status, locationName, coordinatorName]);

  const activeFilters = [searchQuery.trim() !== "", status !== ""].filter(Boolean).length;
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const activePage = Math.min(page, pageCount);
  const pagedRows = rows.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE);

  const clearFilters = (): void => {
    setSearchQuery("");
    setStatus("");
    setPage(1);
  };

  const emptyState = (
    <div className="wx-list-state">
      <EmptyState
        title={
          activeFilters > 0 ? "No matching meetings" : "No IDG meeting scheduled for this location."
        }
        description={
          activeFilters > 0
            ? "Try adjusting the schedule filters."
            : "No IDG meetings fall in the next 8 weeks. Schedule one for this location."
        }
        action={
          activeFilters > 0 ? (
            <button type="button" className="wx-btn-secondary" onClick={clearFilters}>
              Clear filters
            </button>
          ) : canSchedule ? (
            <button type="button" className="wx-btn-primary" onClick={() => setScheduling(true)}>
              Schedule Meeting
            </button>
          ) : undefined
        }
      />
    </div>
  );

  const statusMix = STATUSES.map((s) => ({
    status: s,
    count: sorted.filter((m) => m.status === s).length,
  })).filter((s) => s.count > 0);
  const maxMix = Math.max(...statusMix.map((s) => s.count), 1);

  return (
    <div className="wx-with-rail">
      <div className="wx-with-rail-main" aria-busy={loading}>
        <IdgPageHead
          title="IDG Schedule"
          subtitle="Review upcoming interdisciplinary group meetings for the selected location."
          actions={
            canSchedule ? (
              <button type="button" className="wx-btn-primary" onClick={() => setScheduling(true)}>
                <Glyph name="plus" size={16} /> Schedule Meeting
              </button>
            ) : undefined
          }
        />

        <IdgSubtabs current="schedule" />

        <div className="wx-stat-grid" aria-label="Schedule summary">
          <IdgStat
            icon="calendar"
            label="Open Meetings"
            value={location ? kpis.upcoming : "—"}
            hint="Next 8 weeks"
          />
          <IdgStat
            icon="package"
            label="Packets Building"
            value={location ? kpis.building : "—"}
            hint="Build in progress"
            color="var(--color-viz-violet)"
          />
          <IdgStat
            icon="file-check"
            label="Packets Ready"
            value={location ? kpis.ready : "—"}
            hint="Ready to start"
            color={t.success}
          />
          <IdgStat
            icon="activity"
            label="Live Now"
            value={location ? kpis.live : "—"}
            hint="In session"
          />
        </div>

        <IdgFilterPanel
          searchLabel="Search IDG schedule"
          placeholder="Search by meeting, location, coordinator…"
          search={searchQuery}
          onSearch={(v) => {
            setSearchQuery(v);
            setPage(1);
          }}
          searchDisabled={!location}
          onClear={activeFilters > 0 ? clearFilters : undefined}
        >
          <IdgFilter
            label="Location"
            wide
            value={location ?? ""}
            disabled={!locations || locations.length === 0}
            onChange={(v) => {
              setParams({ location: v });
              setPage(1);
            }}
          >
            {(locations ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </IdgFilter>
          <IdgFilter
            label="Status"
            ariaLabel="Meeting status"
            value={status}
            disabled={!location}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {stateLabel(s)}
              </option>
            ))}
          </IdgFilter>
        </IdgFilterPanel>

        {error ? (
          <div className="wx-list-state">
            <ErrorState
              title={
                error.kind === "forbidden" ? "Location unavailable" : "IDG schedule unavailable"
              }
              description={error.message}
              onRetry={() => void load()}
              action={<Link to="/idg/schedule">Back to schedule</Link>}
            />
          </div>
        ) : locationsError ? (
          <div className="wx-list-state">
            <ErrorState
              title="Locations unavailable"
              description="Could not load the locations available to your account."
              onRetry={() => {
                setLocations(null);
                setLocationsRetry((value) => value + 1);
              }}
            />
          </div>
        ) : !location ? (
          <div className="wx-list-state">
            {locations === null ? (
              <LoadingSpinner />
            ) : (
              <EmptyState
                title="Select a location"
                description="No location is available to your role. Open this schedule from a location context to view its IDG meetings."
              />
            )}
          </div>
        ) : loading && meetings.length === 0 ? (
          <div className="wx-list-state">
            <LoadingSpinner />
          </div>
        ) : rows.length === 0 ? (
          emptyState
        ) : (
          <div className="wx-list-table-wrap">
            <table className="wx-list-table">
              <caption className="wx-sr-only">IDG meetings</caption>
              <thead>
                <tr>
                  <th scope="col">Meeting</th>
                  <th scope="col">Time</th>
                  <th scope="col">Location</th>
                  <th scope="col">Coordinator</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="wx-sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((m) => (
                  <tr
                    key={m.id}
                    className="wx-data-row-interactive"
                    {...interactiveRowProps(
                      () => navigate(`/idg/meetings/${m.id}?location=${location}`),
                      false,
                      true,
                    )}
                  >
                    <td>
                      <Link
                        to={`/idg/meetings/${m.id}?location=${location}`}
                        className="wx-row-title"
                        onClick={(e) => e.stopPropagation()}
                      >
                        IDG meeting
                      </Link>
                      <span className="wx-row-sub wx-nums">{dayLabel(m.scheduledStart)}</span>
                    </td>
                    <td className="wx-nums">
                      {timeLabel(m.scheduledStart)} – {timeLabel(m.scheduledEnd)}
                    </td>
                    <td>{locationName(m.locationId)}</td>
                    <td>{coordinatorName(m.coordinatorMembershipId)}</td>
                    <td>
                      <StatusPill
                        label={stateLabel(m.status)}
                        tone={MEETING_TONE[m.status] ?? "neutral"}
                      />
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Link
                        to={`/idg/meetings/${m.id}?location=${location}`}
                        className="wx-icon-link"
                        aria-label={`Open IDG meeting on ${dayLabel(m.scheduledStart)}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Glyph name="chevron-right" size={18} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <IdgTableFooter
              page={activePage}
              pages={pageCount}
              pageSize={PAGE_SIZE}
              total={rows.length}
              noun="meetings"
              onPage={setPage}
            />
          </div>
        )}
      </div>

      <aside className="wx-with-rail-side" aria-label="Schedule context">
        <Panel
          title="Next IDG meeting"
          icon="calendar-check"
          action={
            kpis.next ? (
              <Link to={`/idg/meetings/${kpis.next.id}?location=${location}`}>Open</Link>
            ) : undefined
          }
        >
          {kpis.next ? (
            <dl className="wx-kv" style={{ gridTemplateColumns: "5.5rem minmax(0, 1fr)" }}>
              <dt>Date</dt>
              <dd className="wx-nums">{dayLabel(kpis.next.scheduledStart)}</dd>
              <dt>Time</dt>
              <dd className="wx-nums">
                {timeLabel(kpis.next.scheduledStart)} – {timeLabel(kpis.next.scheduledEnd)}
              </dd>
              <dt>Location</dt>
              <dd>{locationName(kpis.next.locationId)}</dd>
              <dt>Coordinator</dt>
              <dd>{coordinatorName(kpis.next.coordinatorMembershipId)}</dd>
              <dt>Status</dt>
              <dd>
                <StatusPill
                  label={stateLabel(kpis.next.status)}
                  tone={MEETING_TONE[kpis.next.status] ?? "neutral"}
                />
              </dd>
            </dl>
          ) : (
            <p className="wx-rail-empty" style={{ padding: 0 }}>
              {loading ? "Loading…" : "No open meeting in the next 8 weeks."}
            </p>
          )}
        </Panel>

        <Panel title="Quick actions" icon="zap">
          <div style={{ display: "grid", gap: "0.5rem" }}>
            {canSchedule ? (
              <button
                type="button"
                className="wx-btn-secondary"
                style={{ justifyContent: "flex-start" }}
                onClick={() => setScheduling(true)}
              >
                <Glyph name="plus" size={16} /> Schedule a meeting
              </button>
            ) : null}
            <Link
              to="/idg/action-items"
              className="wx-btn-secondary"
              style={{ justifyContent: "flex-start" }}
            >
              <Glyph name="clipboard-check" size={16} /> My action items
            </Link>
            {kpis.next ? (
              <Link
                to={`/idg/meetings/${kpis.next.id}?location=${location}`}
                className="wx-btn-secondary"
                style={{ justifyContent: "flex-start" }}
              >
                <Glyph name="file-check" size={16} /> Review next meeting
              </Link>
            ) : null}
          </div>
        </Panel>

        <Panel title="Meetings by status" icon="bar-chart">
          {statusMix.length === 0 ? (
            <p className="wx-rail-empty" style={{ padding: 0 }}>
              No meetings in the next 8 weeks.
            </p>
          ) : (
            <ul className="wx-hbars">
              {statusMix.map((s) => (
                <li key={s.status}>
                  <span>{stateLabel(s.status)}</span>
                  <span className="wx-hbar-track">
                    <span style={{ width: `${(s.count / maxMix) * 100}%` }} />
                  </span>
                  <strong className="wx-nums">{s.count}</strong>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </aside>

      <ScheduleMeetingModal
        open={scheduling}
        locations={locations ?? []}
        defaultLocationId={location}
        meMembershipId={session?.membershipId}
        memberNames={memberNames}
        onClose={() => setScheduling(false)}
        onScheduled={(m) => {
          // Show the location the new meeting landed in, then refresh the list.
          if (m.locationId !== location) setParams({ location: m.locationId });
          else void load();
        }}
      />
    </div>
  );
}
