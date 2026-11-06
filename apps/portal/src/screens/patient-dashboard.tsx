import { Glyph, type GlyphName, useApiClient } from "@chartwarden/ui";
// @chartwarden/portal — the Family Care Dashboard (patient home). The shell owns persistent patient identity and
// navigation; this screen loads the next visit, a medication preview and the latest messages independently, so
// each card resolves its own loading / error / empty state.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { usePortalPatient } from "../patient-context";
import { firstNameOf, greetingFor, isOwnRecord, patientNameOf } from "../portal-relationship";
import { usePortalViewer } from "../viewer-context";
import {
  BereavementCard,
  CardError,
  type CardResource,
  CardSkeleton,
  CarePlanCard,
  type DashboardMedication,
  type DashboardMessage,
  DocumentsCard,
  FamilyIcon,
  MedicationsCard,
  NeedHelpCard,
  RecentMessagesCard,
} from "./dashboard-cards";
import { humanize, readError } from "./portal-format";

interface UpcomingVisit {
  visitId: string;
  scheduledStartedAt?: string;
  purposeLabel?: string;
  settingLabel?: string;
}

interface ApiResult {
  data?: unknown;
  error?: unknown;
  response?: { status?: number };
}

const RECENT_MESSAGES = 2;

/** "Friday, Nov 7 at 10:00 AM" in browser-local time; null for date-only or invalid values. */
function compactVisitTime(iso: string | undefined): string | null {
  if (!iso || /^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const instant = new Date(iso);
  if (!Number.isFinite(instant.getTime())) return null;
  const date = instant.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  const time = instant.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${date} at ${time}`;
}
const MESSAGE_PAGE = 10;

/**
 * One independently-retryable list read. `load` and `select` must be stable (module-level or useCallback):
 * `load` returns the raw API result and `select` lifts the items out of the payload.
 */
function useDashboardList<T>(
  load: () => Promise<ApiResult>,
  select: (data: unknown) => readonly T[],
  patientId: string | undefined,
): { resource: CardResource<T>; retry: () => void } {
  const [resource, setResource] = useState<CardResource<T>>({ status: "loading", items: [] });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    void attempt;
    void patientId; // the session is patient-bound: a patient switch refetches
    let active = true;
    setResource({ status: "loading", items: [] });
    void (async () => {
      try {
        const result = await load();
        if (!active) return;
        setResource(
          "error" in result
            ? { status: "error", items: [], error: readError(result.response?.status) }
            : { status: "ready", items: select(result.data) },
        );
      } catch {
        if (active) setResource({ status: "error", items: [], error: readError(undefined) });
      }
    })();
    return () => {
      active = false;
    };
  }, [load, select, attempt, patientId]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { resource, retry };
}

function selectItems<T>(data: unknown): readonly T[] {
  return (data as { items?: T[] } | undefined)?.items ?? [];
}

function selectRecentMessages(data: unknown): readonly DashboardMessage[] {
  return [...((data as { messages?: DashboardMessage[] } | undefined)?.messages ?? [])]
    .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt))
    .slice(0, RECENT_MESSAGES);
}

/** Relationships that reach the portal after the patient's death: no "what's happening today" copy. */
const AFTER_DEATH = new Set(["personal_representative_post_death", "bereaved_family_member"]);

interface HeroCopy {
  greeting: string | null;
  headline: string;
  lead: string;
}

function heroCopy(
  relationship: string | null,
  viewerName: string | null,
  patientFirst: string | null,
): HeroCopy {
  const greeting = `${greetingFor()},`;
  if (relationship !== null && AFTER_DEATH.has(relationship)) {
    return {
      greeting: null,
      headline: "Welcome",
      lead: "Here you can find the documents, messages and support shared with your family.",
    };
  }
  const viewerFirst = firstNameOf(viewerName);
  if (isOwnRecord(relationship) && viewerFirst) {
    return {
      greeting,
      headline: viewerFirst,
      lead: "Here’s what’s happening with your care today and what’s next.",
    };
  }
  if (relationship !== null && !isOwnRecord(relationship) && patientFirst) {
    return {
      greeting,
      headline: `${patientFirst}’s family`,
      lead: `You’re an important part of ${patientFirst}’s care. Here’s what’s happening today and what’s next.`,
    };
  }
  return {
    greeting: null,
    headline: "Welcome back",
    lead: "Here’s what’s happening with your care today and what’s next.",
  };
}

function FamilyHero(): JSX.Element {
  const { summary } = usePortalPatient();
  const viewer = usePortalViewer();
  const copy = heroCopy(
    viewer.relationship,
    viewer.name,
    firstNameOf(patientNameOf(summary?.patient)),
  );
  return (
    <header className="wx-family-hero">
      <h1>
        {copy.greeting ? (
          <>
            <span className="wx-family-hero__greeting">{copy.greeting}</span>{" "}
          </>
        ) : null}
        <span className="wx-family-hero__name">{copy.headline}</span>
      </h1>
      <p>{copy.lead}</p>
    </header>
  );
}

const QUICK_ACTIONS: readonly {
  path: string;
  icon: GlyphName;
  lead: string;
  label: string;
  short: string;
}[] = [
  {
    path: "messages",
    icon: "message-square",
    lead: "Message",
    label: "the care team",
    short: "Message the care team",
  },
  { path: "visits", icon: "calendar", lead: "View", label: "upcoming visits", short: "Visits" },
  { path: "medications", icon: "pill", lead: "View", label: "medications", short: "Medications" },
  { path: "documents", icon: "file-text", lead: "View", label: "documents", short: "Documents" },
];

function QuickActions({ base }: { base: string }): JSX.Element {
  return (
    <nav className="wx-family-actions" aria-label="Quick actions">
      {QUICK_ACTIONS.map((action, index) => (
        <Link
          key={action.path}
          to={`${base}/${action.path}`}
          className={`wx-family-action${index === 0 ? " is-primary" : ""}`}
        >
          <FamilyIcon name={action.icon} size={24} />
          <span className="wx-family-action__label">
            <small>{action.lead}</small> <strong>{action.label}</strong>
          </span>
          <span className="wx-family-action__short" aria-hidden="true">
            {action.short}
          </span>
          <span className="wx-family-action__arrow" aria-hidden="true">
            <Glyph name="arrow-right" size={19} />
          </span>
        </Link>
      ))}
    </nav>
  );
}

function VisitLink({ to, label }: { to: string; label: string }): JSX.Element {
  return (
    <Link className="wx-family-button" to={to}>
      {label}
      <Glyph name="arrow-right" size={17} />
    </Link>
  );
}

function NextVisitCard({
  resource,
  to,
  onRetry,
}: {
  resource: CardResource<UpcomingVisit>;
  to: string;
  onRetry: () => void;
}): JSX.Element {
  const visit = useMemo(() => {
    const now = Date.now();
    return (
      resource.items
        .map((item) => ({ item, time: Date.parse(item.scheduledStartedAt ?? "") }))
        .filter(({ time }) => Number.isFinite(time) && time >= now)
        .sort((a, b) => a.time - b.time)[0]?.item ?? null
    );
  }, [resource.items]);
  return (
    <section
      className="wx-family-card wx-family-card--leafy wx-family-visit"
      aria-labelledby="family-visit-heading"
    >
      <header className="wx-family-card__header">
        <FamilyIcon name="calendar" />
        <div>
          <h2 id="family-visit-heading" tabIndex={-1}>
            Next care visit
          </h2>
        </div>
      </header>
      <div className="wx-family-card__body">
        {resource.status === "loading" ? (
          <CardSkeleton label="Loading next visit" />
        ) : resource.status === "error" ? (
          <CardError message={resource.error} onRetry={onRetry} focusId="family-visit-heading" />
        ) : visit ? (
          <div className="wx-family-visit__details">
            <p className="wx-family-visit__when">
              {compactVisitTime(visit.scheduledStartedAt) ?? "Date and time unavailable"}
            </p>
            <p className="wx-family-visit__what">
              <Glyph name="user" size={17} />
              <span>{visit.purposeLabel || "Scheduled visit"}</span>
              {visit.settingLabel ? <span>· {humanize(visit.settingLabel)}</span> : null}
            </p>
            <VisitLink to={to} label="View visit details" />
          </div>
        ) : (
          <div className="wx-family-visit__details">
            <p className="wx-family-visit__what">
              <strong>No upcoming visits scheduled</strong>
            </p>
            <p>When your care team schedules a visit, it will appear here.</p>
            <VisitLink to={to} label="View visits" />
          </div>
        )}
      </div>
    </section>
  );
}

export function PortalPatientDashboard(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
  const { summary, error: summaryError, retry: retrySummary } = usePortalPatient();

  // Same session-pinned M31 endpoints the Visits / Medications / Messages screens read.
  const loadVisits = useCallback(
    () => client.GET("/api/v1/portal/visits/upcoming", {}) as Promise<ApiResult>,
    [client],
  );
  const loadMedications = useCallback(
    () => client.GET("/api/v1/portal/medications/active", {}) as Promise<ApiResult>,
    [client],
  );
  const loadMessages = useCallback(
    () =>
      client.GET("/api/v1/portal/messages/history", {
        params: { query: { limit: MESSAGE_PAGE } },
      }) as Promise<ApiResult>,
    [client],
  );
  const visits = useDashboardList<UpcomingVisit>(loadVisits, selectItems, patientId);
  const medications = useDashboardList<DashboardMedication>(
    loadMedications,
    selectItems,
    patientId,
  );
  const messages = useDashboardList<DashboardMessage>(
    loadMessages,
    selectRecentMessages,
    patientId,
  );

  const base = `/p/${encodeURIComponent(patientId ?? "")}`;
  return (
    <div className="wx-family-dashboard">
      <FamilyHero />
      <QuickActions base={base} />
      {summaryError ? <CardError message={summaryError} onRetry={retrySummary} /> : null}
      <div className="wx-family-grid">
        <NextVisitCard resource={visits.resource} to={`${base}/visits`} onRetry={visits.retry} />
        <CarePlanCard to={`${base}/care-plan`} />
        <NeedHelpCard messagesTo={`${base}/messages`} />
        <MedicationsCard
          resource={medications.resource}
          activeCount={summary?.activeMedicationsCount ?? null}
          to={`${base}/medications`}
          onRetry={medications.retry}
        />
        <RecentMessagesCard
          resource={messages.resource}
          unreadCount={summary?.unreadMessagesCount ?? null}
          to={`${base}/messages`}
          onRetry={messages.retry}
        />
        <DocumentsCard
          newCount={summary?.pendingDocumentSharesCount ?? null}
          to={`${base}/documents`}
        />
        <BereavementCard to={`${base}/bereavement`} />
      </div>
    </div>
  );
}
