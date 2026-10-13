import { Card, ErrorState, LoadingSpinner, useApiClient } from "@wardenx/ui";
// @wardenx/portal — §5.1 Patient dashboard (`/p/:patientId`). The session-context anchor: the lay-language
// aggregate the backend assembles from the upstream reader seams (GET /portal/care-summary) plus the next
// scheduled visits (GET /portal/upcoming). Every card links to the deeper surface. No internal coordinator
// notes reach here — the DTOs are PHI-minimised server-side (the summary carries counts + a lay label, not
// the clinical record).
import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { humanize, readError, stamp } from "./portal-format";

interface CareSummary {
  patient: { layLabel: string; pronouns?: string; preferredName?: string };
  upcomingVisitsCount: number;
  recentVisitsCount: number;
  activeMedicationsCount: number;
  unreadMessagesCount: number;
  pendingDocumentSharesCount: number;
}
interface UpcomingVisit {
  visitId: string;
  scheduledStartedAt: string;
  visitPurposeLabel: string;
  visitSetting: string;
}

function DashboardCard({
  title,
  to,
  children,
}: { title: string; to?: string; children: ReactNode }): JSX.Element {
  return (
    <Card>
      <div className="wx-portal-dashboard-card__header">
        <h2>{title}</h2>
        {to ? (
          <Link to={to} className="wx-portal-text-link">
            View all <span aria-hidden="true">→</span>
          </Link>
        ) : null}
      </div>
      {children}
    </Card>
  );
}

function Stat({ label, value, to }: { label: string; value: number; to: string }): JSX.Element {
  return (
    <Link to={to} className="wx-portal-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </Link>
  );
}

export function PortalPatientDashboard(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
  const [summary, setSummary] = useState<CareSummary | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingVisit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    // Reading the counter is intentional: incrementing it is the retry trigger for this effect.
    void loadAttempt;
    let active = true;
    void (async () => {
      setLoading(true);
      setError(null);
      const [sRes, uRes] = await Promise.all([
        client.GET("/api/v1/portal/care-summary", {}),
        client.GET("/api/v1/portal/upcoming", { params: { query: { patient: patientId ?? "" } } }),
      ]);
      if (!active) return;
      if (sRes.error) setError(readError(sRes.response?.status));
      else setSummary((sRes.data as CareSummary) ?? null);
      if (!uRes.error) setUpcoming(((uRes.data as UpcomingVisit[]) ?? []) as UpcomingVisit[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, patientId, loadAttempt]);

  if (loading)
    return (
      <div className="wx-portal-dashboard-state" aria-live="polite">
        <LoadingSpinner label="Loading your dashboard…" />
      </div>
    );
  if (error)
    return (
      <div className="wx-portal-dashboard-state">
        <ErrorState
          title="Your care overview is unavailable"
          description={error}
          onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
        />
      </div>
    );

  const base = `/p/${patientId}`;
  const who = summary?.patient.preferredName ?? summary?.patient.layLabel ?? "Care overview";
  return (
    <div className="wx-portal-dashboard">
      <header className="wx-portal-dashboard__welcome">
        <span className="wx-portal-dashboard__eyebrow">Care overview</span>
        <h1>{who}</h1>
        {summary?.patient.pronouns ? <p>{summary.patient.pronouns}</p> : null}
      </header>

      <div className="wx-portal-dashboard__content">
        <DashboardCard title="At a glance">
          <div className="wx-portal-stat-grid">
            <Stat
              label="Upcoming visits"
              value={summary?.upcomingVisitsCount ?? 0}
              to={`${base}/visits`}
            />
            <Stat
              label="Active medications"
              value={summary?.activeMedicationsCount ?? 0}
              to={`${base}/medications`}
            />
            <Stat
              label="Unread messages"
              value={summary?.unreadMessagesCount ?? 0}
              to={`${base}/messages`}
            />
            <Stat
              label="Shared documents"
              value={summary?.pendingDocumentSharesCount ?? 0}
              to={`${base}/documents`}
            />
          </div>
        </DashboardCard>

        <DashboardCard title="Coming up" to={`${base}/visits`}>
          {upcoming.length === 0 ? (
            <p className="wx-portal-muted-copy">Nothing scheduled right now.</p>
          ) : (
            <ul className="wx-portal-upcoming-list">
              {upcoming.map((u) => (
                <li key={u.visitId}>
                  <strong>{u.visitPurposeLabel}</strong>
                  <span>
                    {stamp(u.scheduledStartedAt)} · {humanize(u.visitSetting)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DashboardCard>

        <DashboardCard title="More from your care team">
          <nav className="wx-portal-quick-links" aria-label="More care information">
            <Link to={`${base}/care-plan`}>Care plan</Link>
            <Link to={`${base}/documents`}>Documents</Link>
            <Link to={`${base}/messages`}>Messages</Link>
            <Link to={`${base}/preferences`}>Notifications</Link>
          </nav>
        </DashboardCard>
      </div>
    </div>
  );
}
