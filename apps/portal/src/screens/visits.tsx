import { Glyph, StatusPill, useApiClient } from "@chartwarden/ui";
// @chartwarden/portal — patient-facing visit chronology. Upcoming and history remain backend-defined
// categories and load independently; route ids never authorize reads, and obsolete patient responses are discarded.
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import {
  formatPortalVisitDate,
  formatPortalVisitTime,
  humanize,
  readError,
  statusTone,
} from "./portal-format";
import { PortalPage } from "./portal-page";

type VisitTab = "upcoming" | "past";

interface Visit {
  visitId: string;
  // Current M31 lay DTO.
  scheduledStartedAt?: string;
  scheduledEndedAt?: string;
  purposeLabel?: string;
  clinicianDisplayName?: string;
  settingLabel?: string;
  // Older DTO fields remain optional for deployed compatibility and Telehealth eligibility.
  discipline?: string;
  scheduledStart?: string;
  modality?: string;
  status?: string;
  joinable?: boolean;
}

interface VisitResource {
  patientId: string | null;
  items: Visit[];
  loading: boolean;
  error: string | null;
}

const emptyResource = (patientId: string | null): VisitResource => ({
  patientId,
  items: [],
  loading: patientId !== null,
  error: null,
});

function visitStart(visit: Visit): string | undefined {
  return visit.scheduledStartedAt ?? visit.scheduledStart;
}

function visitTitle(visit: Visit): string {
  return visit.purposeLabel ?? (visit.discipline ? humanize(visit.discipline) : "Care visit");
}

function visitFormat(visit: Visit): string {
  return (
    visit.settingLabel ?? (visit.modality ? humanize(visit.modality) : "Visit format not specified")
  );
}

function sortChronologically(items: Visit[]): Visit[] {
  return items
    .map((visit, index) => ({ visit, index, time: Date.parse(visitStart(visit) ?? "") }))
    .sort((a, b) => {
      const aValid = Number.isFinite(a.time);
      const bValid = Number.isFinite(b.time);
      if (aValid && bValid) return a.time - b.time;
      if (aValid) return -1;
      if (bValid) return 1;
      return a.index - b.index;
    })
    .map(({ visit }) => visit);
}

function VisitsTabs({
  active,
  onChange,
  upcomingCount,
  pastCount,
}: {
  active: VisitTab;
  onChange: (tab: VisitTab) => void;
  upcomingCount: number | null;
  pastCount: number | null;
}): JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabs: Array<{ id: VisitTab; label: string; count: number | null }> = [
    { id: "upcoming", label: "Upcoming", count: upcomingCount },
    { id: "past", label: "Past visits", count: pastCount },
  ];
  function onKeyDown(event: React.KeyboardEvent, index: number): void {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!delta && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index + delta + tabs.length) % tabs.length;
    onChange(tabs[next]?.id ?? active);
    refs.current[next]?.focus();
  }
  return (
    <div className="wx-portal-visits-tabs" role="tablist" aria-label="Visit views">
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          ref={(node) => {
            refs.current[index] = node;
          }}
          type="button"
          role="tab"
          id={`visits-tab-${tab.id}`}
          aria-selected={active === tab.id}
          aria-controls={`visits-panel-${tab.id}`}
          tabIndex={active === tab.id ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          <span>{tab.label}</span>
          {tab.count !== null ? (
            <small aria-label={`${tab.count} ${tab.label.toLowerCase()}`}>{tab.count}</small>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function VisitsSkeleton({
  label,
  prominent = false,
}: { label: string; prominent?: boolean }): JSX.Element {
  return (
    <output
      className={`wx-portal-visits-skeleton${prominent ? " is-prominent" : ""}`}
      aria-label={label}
    >
      <span />
      <span />
      <span />
      <span />
    </output>
  );
}

function VisitsError({ message, onRetry }: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <div className="wx-portal-visits-error" role="alert">
      <Glyph name="alert-circle" size={22} />
      <div>
        <strong>Visits could not be loaded</strong>
        <p>{message}</p>
      </div>
      <button type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function DateBlock({ visit }: { visit: Visit }): JSX.Element {
  const start = visitStart(visit);
  const date = formatPortalVisitDate(start);
  const time = formatPortalVisitTime(start);
  const instant = start ? new Date(start) : null;
  const valid = instant && Number.isFinite(instant.getTime());
  return (
    <div
      className="wx-portal-visit-date"
      aria-label={date && time ? `${date} at ${time}` : "Visit date and time unavailable"}
    >
      <span>
        {valid ? new Intl.DateTimeFormat("en-US", { month: "short" }).format(instant) : "Date"}
      </span>
      <strong>
        {valid ? new Intl.DateTimeFormat("en-US", { day: "numeric" }).format(instant) : "—"}
      </strong>
      <small>{time ?? "Time unavailable"}</small>
    </div>
  );
}

function VisitFacts({ visit }: { visit: Visit }): JSX.Element {
  return (
    <div className="wx-portal-visit-facts">
      <span>
        <Glyph name={visit.modality === "telehealth" ? "video" : "stethoscope"} size={17} />
        <span>
          <small>Visit format</small>
          <strong>{visitFormat(visit)}</strong>
        </span>
      </span>
      {visit.clinicianDisplayName ? (
        <span>
          <Glyph name="user" size={17} />
          <span>
            <small>Care team member</small>
            <strong>{visit.clinicianDisplayName}</strong>
          </span>
        </span>
      ) : null}
    </div>
  );
}

function VisitStatus({ visit }: { visit: Visit }): JSX.Element | null {
  return visit.status ? (
    <StatusPill tone={statusTone(visit.status)} label={humanize(visit.status)} />
  ) : null;
}

function TelehealthAction({ visit, base }: { visit: Visit; base: string }): JSX.Element | null {
  const isTelehealth = visit.modality === "telehealth";
  if (visit.joinable === true && isTelehealth)
    return (
      <Link
        className="wx-portal-visit-join"
        to={`${base}/visits/${encodeURIComponent(visit.visitId)}/telehealth`}
      >
        <Glyph name="video" size={18} />
        Join video visit
      </Link>
    );
  if (isTelehealth)
    return (
      <p className="wx-portal-visit-join-note">
        <Glyph name="info" size={16} />
        Joining is not available right now. Eligibility is confirmed by your care team.
      </p>
    );
  return null;
}

function FeaturedVisit({ visit, base }: { visit: Visit; base: string }): JSX.Element {
  const date = formatPortalVisitDate(visitStart(visit));
  const time = formatPortalVisitTime(visitStart(visit));
  return (
    <article className="wx-portal-featured-visit">
      <div className="wx-portal-featured-visit__top">
        <DateBlock visit={visit} />
        <div className="wx-portal-featured-visit__title">
          <span>Next visit</span>
          <h2>{visitTitle(visit)}</h2>
          <p>{date && time ? `${date} at ${time}` : "Date and time unavailable"}</p>
        </div>
        <VisitStatus visit={visit} />
      </div>
      <VisitFacts visit={visit} />
      <TelehealthAction visit={visit} base={base} />
    </article>
  );
}

function VisitCard({ visit, past = false }: { visit: Visit; past?: boolean }): JSX.Element {
  const date = formatPortalVisitDate(visitStart(visit));
  const time = formatPortalVisitTime(visitStart(visit));
  return (
    <article className={`wx-portal-visit-card${past ? " is-past" : ""}`}>
      <DateBlock visit={visit} />
      <div className="wx-portal-visit-card__copy">
        <div>
          <h3>{visitTitle(visit)}</h3>
          <VisitStatus visit={visit} />
        </div>
        <p>{date && time ? `${date} at ${time}` : "Date and time unavailable"}</p>
        <span>{visitFormat(visit)}</span>
        {visit.clinicianDisplayName ? <small>{visit.clinicianDisplayName}</small> : null}
      </div>
    </article>
  );
}

function VisitsEmpty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
}): JSX.Element {
  return (
    <div className="wx-portal-visits-empty">
      <span aria-hidden="true">
        <Glyph name="calendar" size={24} />
      </span>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      {action ? (
        <button type="button" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

export function PortalVisitList(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
  const [activeTab, setActiveTab] = useState<VisitTab>("upcoming");
  const [upcoming, setUpcoming] = useState<VisitResource>(() => emptyResource(patientId ?? null));
  const [history, setHistory] = useState<VisitResource>(() => emptyResource(patientId ?? null));
  const [upcomingAttempt, setUpcomingAttempt] = useState(0);
  const [historyAttempt, setHistoryAttempt] = useState(0);

  useEffect(() => {
    void upcomingAttempt;
    let active = true;
    const requestedPatient = patientId ?? null;
    setUpcoming(emptyResource(requestedPatient));
    if (!requestedPatient) return () => undefined;
    void (async () => {
      try {
        const response = await client.GET("/api/v1/portal/visits/upcoming", {});
        if (!active) return;
        setUpcoming(
          "error" in response
            ? {
                patientId: requestedPatient,
                items: [],
                loading: false,
                error: readError(response.response?.status),
              }
            : {
                patientId: requestedPatient,
                items: (response.data?.items ?? []) as unknown as Visit[],
                loading: false,
                error: null,
              },
        );
      } catch {
        if (active)
          setUpcoming({
            patientId: requestedPatient,
            items: [],
            loading: false,
            error: readError(undefined),
          });
      }
    })();
    return () => {
      active = false;
    };
  }, [client, patientId, upcomingAttempt]);

  useEffect(() => {
    void historyAttempt;
    let active = true;
    const requestedPatient = patientId ?? null;
    setHistory(emptyResource(requestedPatient));
    if (!requestedPatient) return () => undefined;
    void (async () => {
      try {
        const response = await client.GET("/api/v1/portal/visits/history", {});
        if (!active) return;
        setHistory(
          "error" in response
            ? {
                patientId: requestedPatient,
                items: [],
                loading: false,
                error: readError(response.response?.status),
              }
            : {
                patientId: requestedPatient,
                items: (response.data?.items ?? []) as unknown as Visit[],
                loading: false,
                error: null,
              },
        );
      } catch {
        if (active)
          setHistory({
            patientId: requestedPatient,
            items: [],
            loading: false,
            error: readError(undefined),
          });
      }
    })();
    return () => {
      active = false;
    };
  }, [client, patientId, historyAttempt]);

  const currentUpcoming =
    upcoming.patientId === patientId ? upcoming : emptyResource(patientId ?? null);
  const currentHistory =
    history.patientId === patientId ? history : emptyResource(patientId ?? null);
  const upcomingRows = useMemo(
    () => sortChronologically(currentUpcoming.items),
    [currentUpcoming.items],
  );
  const historyRows = useMemo(
    () => sortChronologically(currentHistory.items).reverse(),
    [currentHistory.items],
  );
  const base = `/p/${encodeURIComponent(patientId ?? "")}`;

  return (
    <PortalPage
      title="Visits & appointments"
      subtitle="See upcoming and past care visits shared with you."
      width="workspace"
    >
      <VisitsTabs
        active={activeTab}
        onChange={setActiveTab}
        upcomingCount={
          currentUpcoming.loading || currentUpcoming.error ? null : upcomingRows.length
        }
        pastCount={currentHistory.loading || currentHistory.error ? null : historyRows.length}
      />
      <section
        id={`visits-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`visits-tab-${activeTab}`}
        className="wx-portal-visits-panel"
      >
        {activeTab === "upcoming" ? (
          currentUpcoming.loading ? (
            <>
              <VisitsSkeleton label="Loading next visit" prominent />
              <VisitsSkeleton label="Loading more upcoming visits" />
            </>
          ) : currentUpcoming.error ? (
            <VisitsError
              message={currentUpcoming.error}
              onRetry={() => setUpcomingAttempt((value) => value + 1)}
            />
          ) : upcomingRows.length === 0 ? (
            <VisitsEmpty
              title={
                currentHistory.items.length === 0 &&
                !currentHistory.loading &&
                !currentHistory.error
                  ? "No visits to show yet"
                  : "No upcoming visits scheduled"
              }
              description={
                currentHistory.items.length === 0 &&
                !currentHistory.loading &&
                !currentHistory.error
                  ? "Visits shared by your care team will appear here."
                  : "When your care team schedules a visit, it will appear here."
              }
              action={
                currentHistory.items.length > 0
                  ? { label: "View past visits", onClick: () => setActiveTab("past") }
                  : undefined
              }
            />
          ) : (
            <div className="wx-portal-upcoming-visits">
              <FeaturedVisit visit={upcomingRows[0]!} base={base} />
              {upcomingRows.length > 1 ? (
                <section aria-labelledby="more-upcoming-heading">
                  <h2 id="more-upcoming-heading">More upcoming visits</h2>
                  <div className="wx-portal-visit-list">
                    {upcomingRows.slice(1).map((visit) => (
                      <VisitCard key={visit.visitId} visit={visit} />
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          )
        ) : currentHistory.loading ? (
          <VisitsSkeleton label="Loading past visits" />
        ) : currentHistory.error ? (
          <VisitsError
            message={currentHistory.error}
            onRetry={() => setHistoryAttempt((value) => value + 1)}
          />
        ) : historyRows.length === 0 ? (
          <VisitsEmpty
            title="No past visits to show"
            description="Past visits shared with your portal account will appear here."
          />
        ) : (
          <div className="wx-portal-past-visits">
            <h2>Past visits</h2>
            <div className="wx-portal-visit-list">
              {historyRows.map((visit) => (
                <VisitCard key={visit.visitId} visit={visit} past />
              ))}
            </div>
          </div>
        )}
      </section>
    </PortalPage>
  );
}
