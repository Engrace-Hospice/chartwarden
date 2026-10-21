import { Glyph, type GlyphName, useApiClient } from "@chartwarden/ui";
// @chartwarden/portal — task-first patient home. The PR1 shell owns persistent patient identity and
// navigation; this screen independently resolves summary and upcoming-visit presentation states.
import { useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { usePortalPatient } from "../patient-context";
import { formatPortalInstant, humanize, readError } from "./portal-format";

interface UpcomingVisit {
  visitId: string;
  scheduledStartedAt: string;
  scheduledEndedAt?: string;
  visitPurposeLabel: string;
  visitSetting: string;
}

function DashboardSkeleton({
  label,
  compact = false,
}: { label: string; compact?: boolean }): JSX.Element {
  return (
    <output
      className={`wx-portal-dashboard-skeleton${compact ? " is-compact" : ""}`}
      aria-label={label}
    >
      <span />
      <span />
      <span />
    </output>
  );
}

function SectionError({ message, onRetry }: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <div className="wx-portal-dashboard-error" role="alert">
      <span aria-hidden="true">
        <Glyph name="alert-circle" size={20} />
      </span>
      <div>
        <strong>This information is unavailable</strong>
        <p>{message}</p>
      </div>
      <button type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  icon,
}: { eyebrow: string; title: string; icon: GlyphName }): JSX.Element {
  return (
    <div className="wx-portal-dashboard-section-heading">
      <span className="wx-portal-dashboard-section-icon" aria-hidden="true">
        <Glyph name={icon} size={22} />
      </span>
      <div>
        <span>{eyebrow}</span>
        <h2>{title}</h2>
      </div>
    </div>
  );
}

function DashboardWelcome(): JSX.Element {
  return (
    <header className="wx-portal-dashboard-welcome">
      <span className="wx-portal-dashboard__eyebrow">Your care at a glance</span>
      <h1>Welcome back</h1>
      <p>Review the next visit, messages, and care information shared with you.</p>
    </header>
  );
}

function DashboardAction({
  to,
  children,
  secondary = false,
}: { to: string; children: ReactNode; secondary?: boolean }): JSX.Element {
  return (
    <Link className={`wx-portal-dashboard-action${secondary ? " is-secondary" : ""}`} to={to}>
      {children}
      <Glyph name="arrow-right" size={17} />
    </Link>
  );
}

function NextVisitCard({
  visit,
  loading,
  error,
  to,
  onRetry,
}: {
  visit: UpcomingVisit | null;
  loading: boolean;
  error: string | null;
  to: string;
  onRetry: () => void;
}): JSX.Element {
  const formatted = formatPortalInstant(visit?.scheduledStartedAt);
  return (
    <section className="wx-portal-next-visit" aria-labelledby="next-visit-heading">
      <div id="next-visit-heading">
        <SectionHeading eyebrow="Coming up" title="Next scheduled visit" icon="calendar-check" />
      </div>
      {loading ? (
        <DashboardSkeleton label="Loading next visit" />
      ) : error ? (
        <SectionError message={error} onRetry={onRetry} />
      ) : visit ? (
        <div className="wx-portal-next-visit__details">
          <div>
            <strong>{visit.visitPurposeLabel || "Scheduled visit"}</strong>
            <p>{formatted ?? "Date and time unavailable"}</p>
            {visit.visitSetting ? (
              <span>
                <Glyph name="home" size={16} />
                {humanize(visit.visitSetting)}
              </span>
            ) : null}
          </div>
          <DashboardAction to={to}>View visits</DashboardAction>
        </div>
      ) : (
        <div className="wx-portal-next-visit__empty">
          <div>
            <strong>No upcoming visits scheduled</strong>
            <p>When your care team schedules a visit, it will appear here.</p>
          </div>
          <DashboardAction to={to}>View visits</DashboardAction>
        </div>
      )}
    </section>
  );
}

function MessagesCard({
  count,
  loading,
  unavailable,
  to,
}: { count: number | null; loading: boolean; unavailable: boolean; to: string }): JSX.Element {
  return (
    <section className="wx-portal-messages-card" aria-labelledby="messages-heading">
      <div id="messages-heading">
        <SectionHeading eyebrow="Care team" title="Messages" icon="message-square" />
      </div>
      {loading ? (
        <DashboardSkeleton label="Loading message summary" compact />
      ) : (
        <div className="wx-portal-messages-card__body">
          {unavailable ? (
            <p>Message status is unavailable, but you can still open your secure messages.</p>
          ) : count && count > 0 ? (
            <p className="wx-portal-messages-card__unread">
              <strong>{count}</strong>
              <span>{count === 1 ? "unread message" : "unread messages"}</span>
            </p>
          ) : (
            <p>No new message count is showing. Open messages anytime to contact your care team.</p>
          )}
          <DashboardAction to={to} secondary>
            Open messages
          </DashboardAction>
        </div>
      )}
      <p className="wx-portal-messages-card__safety">
        <Glyph name="info" size={15} />
        Portal messages are not for emergencies.
      </p>
    </section>
  );
}

function CareEssentialCard({
  icon,
  title,
  description,
  detail,
  to,
}: {
  icon: GlyphName;
  title: string;
  description: string;
  detail?: ReactNode;
  to: string;
}): JSX.Element {
  return (
    <Link className="wx-portal-essential-card" to={to}>
      <span className="wx-portal-essential-card__icon" aria-hidden="true">
        <Glyph name={icon} size={23} />
      </span>
      <span className="wx-portal-essential-card__copy">
        <strong>{title}</strong>
        <span>{description}</span>
        {detail ? <small>{detail}</small> : null}
      </span>
      <Glyph name="chevron-right" size={19} />
    </Link>
  );
}

function CareEssentials({
  base,
  loading,
  unavailable,
  medications,
  documentShares,
}: {
  base: string;
  loading: boolean;
  unavailable: boolean;
  medications: number | null;
  documentShares: number | null;
}): JSX.Element {
  return (
    <section className="wx-portal-care-essentials" aria-labelledby="care-essentials-heading">
      <div className="wx-portal-dashboard-heading-row">
        <span className="wx-portal-dashboard__eyebrow">Care essentials</span>
        <h2 id="care-essentials-heading">Find what you need</h2>
      </div>
      {loading ? (
        <div className="wx-portal-essential-grid">
          <DashboardSkeleton label="Loading medications" compact />
          <DashboardSkeleton label="Loading care plan" compact />
          <DashboardSkeleton label="Loading documents" compact />
        </div>
      ) : (
        <div className="wx-portal-essential-grid">
          <CareEssentialCard
            icon="pill"
            title="Medications"
            description="Review medication information shared with you."
            to={`${base}/medications`}
            detail={
              !unavailable && medications !== null && medications > 0
                ? `${medications} active ${medications === 1 ? "medication" : "medications"}`
                : undefined
            }
          />
          <CareEssentialCard
            icon="clipboard-check"
            title="Care plan"
            description="See the care plan summary and goals available to you."
            to={`${base}/care-plan`}
          />
          <CareEssentialCard
            icon="file-text"
            title="Documents"
            description="Open documents securely shared by the hospice team."
            to={`${base}/documents`}
            detail={
              !unavailable && documentShares !== null && documentShares > 0
                ? `${documentShares} new document ${documentShares === 1 ? "share" : "shares"}`
                : undefined
            }
          />
        </div>
      )}
      {unavailable ? (
        <p className="wx-portal-dashboard-inline-note">
          <Glyph name="info" size={16} />
          Counts are unavailable. These care sections remain accessible.
        </p>
      ) : null}
    </section>
  );
}

function HelpfulLinks({ base }: { base: string }): JSX.Element {
  return (
    <section className="wx-portal-dashboard-helpful" aria-labelledby="helpful-heading">
      <div>
        <span className="wx-portal-dashboard__eyebrow">Also available</span>
        <h2 id="helpful-heading">More support</h2>
        <p>Manage notifications or find support resources available through the portal.</p>
      </div>
      <nav aria-label="More support">
        <Link to={`${base}/preferences`}>
          <Glyph name="bell" size={19} />
          Notification preferences
        </Link>
        <Link to={`${base}/bereavement`}>
          <Glyph name="heart" size={19} />
          Bereavement support
        </Link>
      </nav>
    </section>
  );
}

export function PortalPatientDashboard(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
  const {
    summary,
    loading: summaryLoading,
    error: summaryError,
    retry: retrySummary,
  } = usePortalPatient();
  const [upcoming, setUpcoming] = useState<{
    patientId: string | null;
    items: UpcomingVisit[];
    loading: boolean;
    error: string | null;
  }>({ patientId: patientId ?? null, items: [], loading: true, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    void attempt;
    let active = true;
    const requestedPatient = patientId ?? null;
    setUpcoming({ patientId: requestedPatient, items: [], loading: true, error: null });
    if (!requestedPatient) return () => undefined;
    void (async () => {
      const response = await client.GET("/api/v1/portal/upcoming", {
        params: { query: { patient: requestedPatient } },
      });
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
              items: (response.data as UpcomingVisit[] | undefined) ?? [],
              loading: false,
              error: null,
            },
      );
    })();
    return () => {
      active = false;
    };
  }, [client, patientId, attempt]);

  const current =
    upcoming.patientId === patientId
      ? upcoming
      : { patientId, items: [], loading: true, error: null };
  const nextVisit = useMemo(() => {
    const now = Date.now();
    return (
      current.items
        .map((visit) => ({ visit, time: Date.parse(visit.scheduledStartedAt) }))
        .filter(({ time }) => Number.isFinite(time) && time >= now)
        .sort((a, b) => a.time - b.time)[0]?.visit ?? null
    );
  }, [current.items]);
  const base = `/p/${encodeURIComponent(patientId ?? "")}`;

  return (
    <div className="wx-portal-dashboard">
      <DashboardWelcome />
      <div className="wx-portal-dashboard-primary-grid">
        <NextVisitCard
          visit={nextVisit}
          loading={current.loading}
          error={current.error}
          to={`${base}/visits`}
          onRetry={() => setAttempt((value) => value + 1)}
        />
        <MessagesCard
          count={summary?.unreadMessagesCount ?? null}
          loading={summaryLoading}
          unavailable={summaryError !== null}
          to={`${base}/messages`}
        />
      </div>
      {summaryError ? <SectionError message={summaryError} onRetry={retrySummary} /> : null}
      <CareEssentials
        base={base}
        loading={summaryLoading}
        unavailable={summaryError !== null}
        medications={summary?.activeMedicationsCount ?? null}
        documentShares={summary?.pendingDocumentSharesCount ?? null}
      />
      <HelpfulLinks base={base} />
    </div>
  );
}
