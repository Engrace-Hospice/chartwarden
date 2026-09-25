import { StatusPill, t } from "@wardenx/ui";
import { useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";

export type CalendarView = "day" | "week" | "month";

export type CalendarEventType =
  | "visit"
  | "encounter"
  | "hope"
  | "sfv"
  | "f2f"
  | "cti"
  | "idg"
  | "assessment"
  | "task"
  | "other";

export type CalendarEventStatus =
  | "scheduled"
  | "due"
  | "completed"
  | "overdue"
  | "cancelled";

export interface CalendarEvent {
  id: string;
  title: string;
  type: CalendarEventType;

  startAt: string;
  endAt?: string | null;
  allDay?: boolean;

  status?: CalendarEventStatus;

  patient?: {
    id: string;
    name: string;
    mrn?: string;
  };

  discipline?: string | null;
  description?: string | null;
  href?: string | null;
}

interface ClinicalCalendarProps {
  events: readonly CalendarEvent[];
  view: CalendarView;
  date: Date;
  onViewChange: (view: CalendarView) => void;
  onDateChange: (date: Date) => void;
  onOpenEvent?: (event: CalendarEvent) => void;
}

const EVENT_TYPE_LABELS: Record<CalendarEventType, string> = {
  visit: "Visit",
  encounter: "Encounter",
  hope: "HOPE",
  sfv: "SFV",
  f2f: "F2F",
  cti: "CTI",
  idg: "IDG",
  assessment: "Assessment",
  task: "Task",
  other: "Other",
};

const STATUS_LABELS: Record<CalendarEventStatus, string> = {
  scheduled: "Scheduled",
  due: "Due",
  completed: "Completed",
  overdue: "Overdue",
  cancelled: "Cancelled",
};

type Tone = "success" | "progress" | "neutral" | "error";

const STATUS_TONES: Record<CalendarEventStatus, Tone> = {
  scheduled: "progress",
  due: "progress",
  completed: "success",
  overdue: "error",
  cancelled: "neutral",
};

export function ClinicalCalendar({
  events,
  view,
  date,
  onViewChange,
  onDateChange,
  onOpenEvent,
}: ClinicalCalendarProps): JSX.Element {
  const [selectedEvent, setSelectedEvent] =
    useState<CalendarEvent | null>(null);

  const [typeFilter, setTypeFilter] = useState<CalendarEventType | "all">(
    "all",
  );

  const [statusFilter, setStatusFilter] =
    useState<CalendarEventStatus | "all">("all");

  const filteredEvents = useMemo(
    () =>
      events.filter((event) => {
        if (typeFilter !== "all" && event.type !== typeFilter) {
          return false;
        }

        if (
          statusFilter !== "all" &&
          event.status !== statusFilter
        ) {
          return false;
        }

        return true;
      }),
    [events, typeFilter, statusFilter],
  );

  function move(direction: -1 | 1): void {
    const next = new Date(date);

    if (view === "month") {
      next.setMonth(next.getMonth() + direction);
    } else if (view === "week") {
      next.setDate(next.getDate() + direction * 7);
    } else {
      next.setDate(next.getDate() + direction);
    }

    onDateChange(next);
  }

  function selectEvent(event: CalendarEvent): void {
    setSelectedEvent(event);
    onOpenEvent?.(event);
  }

  return (
    <div style={calendarShell}>
      <div style={toolbar}>
        <div style={navigationGroup}>
          <button
            type="button"
            style={iconButton}
            onClick={() => move(-1)}
            aria-label="Previous period"
          >
            ←
          </button>

          <button
            type="button"
            style={todayButton}
            onClick={() => onDateChange(startOfToday())}
          >
            Today
          </button>

          <button
            type="button"
            style={iconButton}
            onClick={() => move(1)}
            aria-label="Next period"
          >
            →
          </button>

          <div style={periodTitle}>{periodLabel(date, view)}</div>
        </div>

        <div style={viewSwitcher}>
          {(["day", "week", "month"] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => onViewChange(item)}
              style={{
                ...viewButton,
                ...(view === item ? viewButtonActive : {}),
              }}
              aria-pressed={view === item}
            >
              {item === "day"
                ? "Day"
                : item === "week"
                  ? "Week"
                  : "Month"}
            </button>
          ))}
        </div>
      </div>

      <div style={filters}>
        <label style={filterField}>
          <span style={filterLabel}>Event type</span>

          <select
            value={typeFilter}
            onChange={(event) =>
              setTypeFilter(
                event.target.value as CalendarEventType | "all",
              )
            }
            style={selectStyle}
          >
            <option value="all">All events</option>

            {Object.entries(EVENT_TYPE_LABELS).map(
              ([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ),
            )}
          </select>
        </label>

        <label style={filterField}>
          <span style={filterLabel}>Status</span>

          <select
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(
                event.target.value as CalendarEventStatus | "all",
              )
            }
            style={selectStyle}
          >
            <option value="all">All statuses</option>

            {Object.entries(STATUS_LABELS).map(
              ([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ),
            )}
          </select>
        </label>

        <div style={filterSummary}>
          {filteredEvents.length} event
          {filteredEvents.length === 1 ? "" : "s"} visible
        </div>
      </div>

      <div style={calendarBody}>
        <div style={calendarSurface}>
          {view === "month" ? (
            <MonthView
              date={date}
              events={filteredEvents}
              onSelect={selectEvent}
              onDateChange={onDateChange}
              onViewChange={onViewChange}
            />
          ) : view === "week" ? (
            <WeekView
              date={date}
              events={filteredEvents}
              onSelect={selectEvent}
            />
          ) : (
            <DayView
              date={date}
              events={filteredEvents}
              onSelect={selectEvent}
            />
          )}
        </div>

        {selectedEvent ? (
          <EventDetailPanel
            event={selectedEvent}
            onClose={() => setSelectedEvent(null)}
          />
        ) : null}
      </div>
    </div>
  );
}

function MonthView({
  date,
  events,
  onSelect,
  onDateChange,
  onViewChange,
}: {
  date: Date;
  events: readonly CalendarEvent[];
  onSelect: (event: CalendarEvent) => void;
  onDateChange: (date: Date) => void;
  onViewChange: (view: CalendarView) => void;
}): JSX.Element {
  const days = monthGrid(date);
  const today = dateKey(startOfToday());

  return (
    <div>
      <div style={monthWeekHeader}>
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
          (label) => (
            <div key={label} style={monthWeekDay}>
              {label}
            </div>
          ),
        )}
      </div>

      <div style={monthGridStyle}>
        {days.map((day) => {
          const key = dateKey(day);

          const dayEvents = events
            .filter((event) => dateKey(new Date(event.startAt)) === key)
            .sort(sortByStart);

          const outsideMonth =
            day.getMonth() !== date.getMonth();

          return (
            <div
              key={key}
              style={{
                ...monthCell,
                ...(key === today ? todayCell : {}),
              }}
            >
              <button
                type="button"
                style={{
                  ...dayNumberButton,
                  ...(outsideMonth ? outsideMonthStyle : {}),
                }}
                onClick={() => {
                  onDateChange(day);
                  onViewChange("day");
                }}
              >
                {day.getDate()}
              </button>

              <div style={monthEventList}>
                {dayEvents.slice(0, 4).map((event) => (
                  <EventCard
                    key={event.id}
                    event={event}
                    compact
                    onClick={() => onSelect(event)}
                  />
                ))}

                {dayEvents.length > 4 ? (
                  <button
                    type="button"
                    style={moreButton}
                    onClick={() => {
                      onDateChange(day);
                      onViewChange("day");
                    }}
                  >
                    +{dayEvents.length - 4} more
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekView({
  date,
  events,
  onSelect,
}: {
  date: Date;
  events: readonly CalendarEvent[];
  onSelect: (event: CalendarEvent) => void;
}): JSX.Element {
  const days = weekDays(date);
  const today = dateKey(startOfToday());

  return (
    <div style={weekGrid}>
      {days.map((day) => {
        const key = dateKey(day);

        const dayEvents = events
          .filter((event) => dateKey(new Date(event.startAt)) === key)
          .sort(sortByStart);

        return (
          <section
            key={key}
            style={{
              ...weekColumn,
              ...(key === today ? todayWeekColumn : {}),
            }}
          >
            <header style={weekColumnHeader}>
              <span style={weekDayName}>
                {day.toLocaleDateString(undefined, {
                  weekday: "short",
                })}
              </span>

              <span style={weekDateNumber}>{day.getDate()}</span>
            </header>

            <div style={weekEvents}>
              {dayEvents.length > 0 ? (
                dayEvents.map((event) => (
                  <EventCard
                    key={event.id}
                    event={event}
                    onClick={() => onSelect(event)}
                  />
                ))
              ) : (
                <span style={emptyDay}>No events</span>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function DayView({
  date,
  events,
  onSelect,
}: {
  date: Date;
  events: readonly CalendarEvent[];
  onSelect: (event: CalendarEvent) => void;
}): JSX.Element {
  const key = dateKey(date);

  const dayEvents = events
    .filter((event) => dateKey(new Date(event.startAt)) === key)
    .sort(sortByStart);

  return (
    <div style={dayView}>
      <div style={dayViewHeader}>
        <span style={dayViewWeekday}>
          {date.toLocaleDateString(undefined, {
            weekday: "long",
          })}
        </span>

        <span style={dayViewDate}>
          {date.toLocaleDateString(undefined, {
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        </span>
      </div>

      {dayEvents.length === 0 ? (
        <div style={emptyAgenda}>
          <strong>No events scheduled</strong>
          <span>There are no visible calendar items for this day.</span>
        </div>
      ) : (
        <div style={agendaList}>
          {dayEvents.map((event) => (
            <div key={event.id} style={agendaRow}>
              <div style={agendaTime}>
                {event.allDay
                  ? "All day"
                  : formatTime(event.startAt)}
              </div>

              <div style={agendaEvent}>
                <EventCard
                  event={event}
                  onClick={() => onSelect(event)}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EventCard({
  event,
  compact = false,
  onClick,
}: {
  event: CalendarEvent;
  compact?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      style={{
        ...eventCard,
        ...(compact ? compactEventCard : {}),
        ...(event.status === "completed"
          ? completedEventCard
          : {}),
        ...(event.status === "overdue"
          ? overdueEventCard
          : {}),
      }}
      onClick={onClick}
    >
      <div style={eventTopLine}>
        <span style={eventType}>
          {EVENT_TYPE_LABELS[event.type]}
        </span>

        {!compact && event.status ? (
          <span style={eventStatus}>
            {STATUS_LABELS[event.status]}
          </span>
        ) : null}
      </div>

      <strong style={eventTitle}>{event.title}</strong>

      {!compact ? (
        <>
          {event.patient ? (
            <span style={eventMeta}>{event.patient.name}</span>
          ) : null}

          <span style={eventMeta}>
            {event.allDay
              ? "All day"
              : event.endAt
                ? `${formatTime(event.startAt)} – ${formatTime(event.endAt)}`
                : formatTime(event.startAt)}
          </span>
        </>
      ) : null}
    </button>
  );
}

function EventDetailPanel({
  event,
  onClose,
}: {
  event: CalendarEvent;
  onClose: () => void;
}): JSX.Element {
  return (
    <aside style={detailPanel}>
      <div style={detailHeader}>
        <div>
          <span style={detailEyebrow}>
            {EVENT_TYPE_LABELS[event.type]}
          </span>

          <h2 style={detailTitle}>{event.title}</h2>
        </div>

        <button
          type="button"
          onClick={onClose}
          style={closeButton}
          aria-label="Close event details"
        >
          ×
        </button>
      </div>

      {event.status ? (
        <div>
          <StatusPill
            label={STATUS_LABELS[event.status]}
            tone={STATUS_TONES[event.status]}
          />
        </div>
      ) : null}

      <dl style={detailGrid}>
        <dt style={dt}>Date</dt>
        <dd style={dd}>
          {new Date(event.startAt).toLocaleDateString()}
        </dd>

        <dt style={dt}>Time</dt>
        <dd style={dd}>
          {event.allDay
            ? "All day"
            : event.endAt
              ? `${formatTime(event.startAt)} – ${formatTime(event.endAt)}`
              : formatTime(event.startAt)}
        </dd>

        {event.patient ? (
          <>
            <dt style={dt}>Patient</dt>
            <dd style={dd}>{event.patient.name}</dd>
          </>
        ) : null}

        {event.patient?.mrn ? (
          <>
            <dt style={dt}>MRN</dt>
            <dd style={monoDd}>{event.patient.mrn}</dd>
          </>
        ) : null}

        {event.discipline ? (
          <>
            <dt style={dt}>Discipline</dt>
            <dd style={dd}>{event.discipline}</dd>
          </>
        ) : null}
      </dl>

      {event.description ? (
        <div style={descriptionBox}>
          <span style={detailEyebrow}>Details</span>
          <p style={descriptionText}>{event.description}</p>
        </div>
      ) : null}

      {event.href ? (
        <a href={event.href} style={openButton}>
          Open item
        </a>
      ) : (
        <div style={backendNotice}>
          Navigation will be connected when calendar events are backed by
          their source modules.
        </div>
      )}
    </aside>
  );
}

function monthGrid(value: Date): Date[] {
  const first = new Date(
    value.getFullYear(),
    value.getMonth(),
    1,
  );

  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

function weekDays(value: Date): Date[] {
  const start = new Date(value);
  start.setHours(0, 0, 0, 0);

  const day = start.getDay();
  start.setDate(start.getDate() - day);

  return Array.from({ length: 7 }, (_, index) => {
    const current = new Date(start);
    current.setDate(start.getDate() + index);
    return current;
  });
}

function startOfToday(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function dateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function periodLabel(
  date: Date,
  view: CalendarView,
): string {
  if (view === "month") {
    return date.toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });
  }

  if (view === "day") {
    return date.toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }

  const days = weekDays(date);

  const first = days[0]!;
  const last = days[6]!;

  if (first.getMonth() === last.getMonth()) {
    return `${first.toLocaleDateString(undefined, {
      month: "short",
    })} ${first.getDate()} – ${last.getDate()}, ${last.getFullYear()}`;
  }

  return `${first.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })} – ${last.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function sortByStart(
  a: CalendarEvent,
  b: CalendarEvent,
): number {
  return (
    new Date(a.startAt).getTime() -
    new Date(b.startAt).getTime()
  );
}

const calendarShell: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  height: "100%",
};

const toolbar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
  padding: "1rem 1.25rem",
  borderBottom: `1px solid ${t.outlineVariant}`,
};

const navigationGroup: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};

const iconButton: CSSProperties = {
  width: "2.25rem",
  height: "2.25rem",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: t.radiusMd,
  background: t.surfaceLowest,
  color: t.onSurface,
  cursor: "pointer",
};

const todayButton: CSSProperties = {
  ...iconButton,
  width: "auto",
  padding: "0 0.75rem",
  fontWeight: 650,
};

const periodTitle: CSSProperties = {
  marginLeft: "0.5rem",
  fontFamily: t.fontDisplay,
  fontSize: "1.05rem",
  fontWeight: 600,
  color: t.onSurface,
};

const viewSwitcher: CSSProperties = {
  display: "inline-flex",
  padding: "0.2rem",
  borderRadius: t.radiusMd,
  background: t.surfaceContainer,
};

const viewButton: CSSProperties = {
  minHeight: "2rem",
  padding: "0.35rem 0.75rem",
  border: "none",
  borderRadius: t.radiusMd,
  background: "transparent",
  color: t.onSurfaceVariant,
  cursor: "pointer",
  fontSize: "0.78rem",
  fontWeight: 600,
};

const viewButtonActive: CSSProperties = {
  background: t.surfaceLowest,
  color: t.primary,
  boxShadow: "var(--shadow-soft)",
};

const filters: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: "0.75rem",
  flexWrap: "wrap",
  padding: "0.75rem 1.25rem",
  background: t.surfaceLow,
  borderBottom: `1px solid ${t.outlineVariant}`,
};

const filterField: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
};

const filterLabel: CSSProperties = {
  fontSize: "0.68rem",
  fontWeight: 650,
  color: t.onSurfaceVariant,
};

const selectStyle: CSSProperties = {
  minHeight: "2.25rem",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: t.radiusMd,
  background: t.surfaceLowest,
  color: t.onSurface,
  padding: "0.35rem 0.6rem",
};

const filterSummary: CSSProperties = {
  marginLeft: "auto",
  paddingBottom: "0.45rem",
  color: t.muted,
  fontSize: "0.72rem",
};

const calendarBody: CSSProperties = {
  display: "flex",
  flex: 1,
  minHeight: 0,
};

const calendarSurface: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "auto",
  background: t.surfaceLowest,
};

const monthWeekHeader: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
  position: "sticky",
  top: 0,
  zIndex: 2,
  background: t.surfaceLowest,
  borderBottom: `1px solid ${t.outlineVariant}`,
};

const monthWeekDay: CSSProperties = {
  padding: "0.6rem",
  textAlign: "center",
  fontSize: "0.68rem",
  fontWeight: 700,
  color: t.onSurfaceVariant,
};

const monthGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(7, minmax(8rem, 1fr))",
  gridAutoRows: "minmax(8.5rem, 1fr)",
};

const monthCell: CSSProperties = {
  minWidth: 0,
  padding: "0.45rem",
  borderRight: `1px solid ${t.outlineVariant}`,
  borderBottom: `1px solid ${t.outlineVariant}`,
};

const todayCell: CSSProperties = {
  background:
    "color-mix(in srgb, var(--color-primary) 5%, transparent)",
};

const dayNumberButton: CSSProperties = {
  width: "1.7rem",
  height: "1.7rem",
  border: "none",
  borderRadius: "9999px",
  background: "transparent",
  color: t.onSurface,
  cursor: "pointer",
  fontSize: "0.72rem",
};

const outsideMonthStyle: CSSProperties = {
  opacity: 0.4,
};

const monthEventList: CSSProperties = {
  display: "grid",
  gap: "0.25rem",
  marginTop: "0.35rem",
};

const eventCard: CSSProperties = {
  width: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  gap: "0.15rem",
  textAlign: "left",
  padding: "0.55rem",
  border: "none",
  borderLeft: `3px solid ${t.primary}`,
  borderRadius: t.radiusMd,
  background: t.primaryTint,
  color: t.onSurface,
  cursor: "pointer",
};

const compactEventCard: CSSProperties = {
  padding: "0.32rem 0.4rem",
};

const completedEventCard: CSSProperties = {
  opacity: 0.7,
  borderLeftColor: t.outline,
  background: t.surfaceLow,
};

const overdueEventCard: CSSProperties = {
  borderLeftColor: t.error,
  background:
    "color-mix(in srgb, var(--color-error) 8%, transparent)",
};

const eventTopLine: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.5rem",
};

const eventType: CSSProperties = {
  fontSize: "0.59rem",
  fontWeight: 750,
  letterSpacing: "0.06em",
  color: t.primary,
};

const eventStatus: CSSProperties = {
  fontSize: "0.6rem",
  color: t.onSurfaceVariant,
};

const eventTitle: CSSProperties = {
  fontSize: "0.76rem",
  lineHeight: 1.3,
};

const eventMeta: CSSProperties = {
  fontSize: "0.67rem",
  color: t.onSurfaceVariant,
};

const moreButton: CSSProperties = {
  border: "none",
  background: "transparent",
  color: t.primary,
  textAlign: "left",
  fontSize: "0.66rem",
  cursor: "pointer",
};

const weekGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(7, minmax(10rem, 1fr))",
  minHeight: "100%",
};

const weekColumn: CSSProperties = {
  minWidth: 0,
  borderRight: `1px solid ${t.outlineVariant}`,
};

const todayWeekColumn: CSSProperties = {
  background:
    "color-mix(in srgb, var(--color-primary) 4%, transparent)",
};

const weekColumnHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.5rem",
  padding: "0.75rem",
  borderBottom: `1px solid ${t.outlineVariant}`,
  background: t.surfaceLow,
};

const weekDayName: CSSProperties = {
  fontSize: "0.7rem",
  color: t.onSurfaceVariant,
  fontWeight: 650,
};

const weekDateNumber: CSSProperties = {
  fontSize: "1rem",
  color: t.onSurface,
  fontWeight: 700,
};

const weekEvents: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
  padding: "0.65rem",
};

const emptyDay: CSSProperties = {
  padding: "0.4rem",
  color: t.muted,
  fontSize: "0.7rem",
};

const dayView: CSSProperties = {
  maxWidth: "60rem",
  margin: "0 auto",
  padding: "1.25rem",
};

const dayViewHeader: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.15rem",
  marginBottom: "1rem",
};

const dayViewWeekday: CSSProperties = {
  fontSize: "0.72rem",
  fontWeight: 700,
  color: t.primary,
};

const dayViewDate: CSSProperties = {
  fontFamily: t.fontDisplay,
  fontSize: "1.25rem",
  color: t.onSurface,
};

const agendaList: CSSProperties = {
  display: "grid",
};

const agendaRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "6rem 1fr",
  gap: "1rem",
  padding: "0.65rem 0",
  borderTop: `1px solid ${t.outlineVariant}`,
};

const agendaTime: CSSProperties = {
  fontSize: "0.75rem",
  color: t.onSurfaceVariant,
  paddingTop: "0.55rem",
};

const agendaEvent: CSSProperties = {
  minWidth: 0,
};

const emptyAgenda: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  padding: "2rem",
  borderRadius: t.radiusMd,
  background: t.surfaceLow,
  color: t.onSurfaceVariant,
};

const detailPanel: CSSProperties = {
  width: "20rem",
  flexShrink: 0,
  overflow: "auto",
  borderLeft: `1px solid ${t.outlineVariant}`,
  background: t.surfaceLow,
  padding: "1.25rem",
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};

const detailHeader: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "1rem",
};

const detailEyebrow: CSSProperties = {
  fontSize: "0.65rem",
  fontWeight: 750,
  color: t.primary,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

const detailTitle: CSSProperties = {
  margin: "0.2rem 0 0",
  fontFamily: t.fontDisplay,
  fontSize: "1.1rem",
  fontWeight: 600,
  color: t.onSurface,
};

const closeButton: CSSProperties = {
  border: "none",
  background: "transparent",
  color: t.onSurfaceVariant,
  cursor: "pointer",
  fontSize: "1.3rem",
};

const detailGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr",
  gap: "0.65rem 0.8rem",
  margin: 0,
  fontSize: "0.78rem",
};

const dt: CSSProperties = {
  color: t.onSurfaceVariant,
  fontWeight: 650,
};

const dd: CSSProperties = {
  margin: 0,
  color: t.onSurface,
};

const monoDd: CSSProperties = {
  ...dd,
  fontFamily: t.fontMono,
};

const descriptionBox: CSSProperties = {
  padding: "0.75rem",
  borderRadius: t.radiusMd,
  background: t.surfaceLowest,
};

const descriptionText: CSSProperties = {
  margin: "0.35rem 0 0",
  color: t.onSurfaceVariant,
  fontSize: "0.78rem",
  lineHeight: 1.5,
};

const openButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "2.35rem",
  borderRadius: t.radiusMd,
  background: t.primary,
  color: t.onPrimary,
  textDecoration: "none",
  fontSize: "0.78rem",
  fontWeight: 650,
};

const backendNotice: CSSProperties = {
  padding: "0.75rem",
  borderRadius: t.radiusMd,
  background: t.surfaceContainer,
  color: t.onSurfaceVariant,
  fontSize: "0.7rem",
  lineHeight: 1.45,
};