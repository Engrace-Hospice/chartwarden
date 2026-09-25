import { PageHeader, t } from "@wardenx/ui";
import { useMemo } from "react";
import type { CSSProperties, JSX } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ClinicalCalendar,
  type CalendarEvent,
  type CalendarView,
} from "../../components/calendar/clinical-calendar";

const MOCK_EVENTS: readonly CalendarEvent[] = [
  {
    id: "visit-1",
    title: "RN Visit",
    type: "visit",
    startAt: "2026-09-25T09:00:00",
    endAt: "2026-09-25T10:00:00",
    status: "scheduled",
    patient: {
      id: "patient-1",
      name: "Mary Smith",
      mrn: "MRN-00231",
    },
    discipline: "RN",
    description:
      "Routine skilled nursing visit. Mock calendar item for the frontend calendar.",
  },
  {
    id: "hope-1",
    title: "HOPE HUV1",
    type: "hope",
    startAt: "2026-09-25T11:30:00",
    status: "due",
    patient: {
      id: "patient-2",
      name: "John Doe",
      mrn: "MRN-00412",
    },
    discipline: "RN",
    description:
      "HOPE follow-up timepoint. Backend integration will be added later.",
  },
  {
    id: "f2f-1",
    title: "Face-to-Face",
    type: "f2f",
    startAt: "2026-09-26T14:00:00",
    endAt: "2026-09-26T14:45:00",
    status: "scheduled",
    patient: {
      id: "patient-3",
      name: "Robert Taylor",
      mrn: "MRN-00118",
    },
    discipline: "MD",
  },
  {
    id: "cti-1",
    title: "CTI review due",
    type: "cti",
    startAt: "2026-09-28T09:00:00",
    status: "due",
    patient: {
      id: "patient-4",
      name: "Emma Wilson",
    },
  },
  {
    id: "idg-1",
    title: "IDG Meeting",
    type: "idg",
    startAt: "2026-09-29T13:00:00",
    endAt: "2026-09-29T14:30:00",
    status: "scheduled",
    description: "Weekly interdisciplinary group meeting.",
  },
  {
    id: "sfv-1",
    title: "Symptom Follow-Up Visit",
    type: "sfv",
    startAt: "2026-09-24T15:00:00",
    status: "completed",
    patient: {
      id: "patient-5",
      name: "Susan Miller",
    },
    discipline: "RN",
  },
  {
    id: "assessment-1",
    title: "Pain reassessment",
    type: "assessment",
    startAt: "2026-09-23T10:30:00",
    status: "overdue",
    patient: {
      id: "patient-6",
      name: "Daniel Brown",
    },
  },
];

function parseView(value: string | null): CalendarView {
  if (value === "day" || value === "month") {
    return value;
  }

  return "week";
}

function parseDate(value: string | null): Date {
  if (!value) {
    return new Date();
  }

  const parsed = new Date(`${value}T12:00:00`);

  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }

  return parsed;
}

function toDateParam(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

export function CalendarPage(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();

  const view = parseView(searchParams.get("view"));

  const date = useMemo(
    () => parseDate(searchParams.get("date")),
    [searchParams],
  );

  function setView(nextView: CalendarView): void {
    const next = new URLSearchParams(searchParams);

    next.set("view", nextView);
    next.set("date", toDateParam(date));

    setSearchParams(next);
  }

  function setDate(nextDate: Date): void {
    const next = new URLSearchParams(searchParams);

    next.set("view", view);
    next.set("date", toDateParam(nextDate));

    setSearchParams(next);
  }

  return (
    <div style={page}>
      <PageHeader
        title="Calendar"
        breadcrumb="Workspace / Calendar"
      >
        <p style={subtitle}>
          Unified clinical calendar preview. Events are currently
          frontend-only; source modules will be connected later.
        </p>
      </PageHeader>

      <div style={calendarContainer}>
        <ClinicalCalendar
          events={MOCK_EVENTS}
          view={view}
          date={date}
          onViewChange={setView}
          onDateChange={setDate}
        />
      </div>
    </div>
  );
}

const page: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: "100%",
};

const subtitle: CSSProperties = {
  margin: "0.25rem 0 0",
  color: t.onSurfaceVariant,
  fontSize: "0.8rem",
};

const calendarContainer: CSSProperties = {
  flex: 1,
  minHeight: "42rem",
  margin: "0 1.5rem 1.5rem",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: t.radiusMd,
  overflow: "hidden",
  background: t.surfaceLowest,
};