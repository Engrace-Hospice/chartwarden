import { cardSurface, EmptyState, LoadingSpinner, PortalDashboardLayout, t, useApiClient } from "@wardenx/ui";
// @wardenx/portal — §5.1 Patient dashboard (`/p/:patientId`). The session-context anchor: the lay-language
// aggregate the backend assembles from the upstream reader seams (GET /portal/care-summary) plus the next
// scheduled visits (GET /portal/upcoming). Every card links to the deeper surface. No internal coordinator
// notes reach here — the DTOs are PHI-minimised server-side (the summary carries counts + a lay label, not
// the clinical record).
import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
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

const link: CSSProperties = { color: t.primary, textDecoration: "none", fontWeight: 600, fontSize: "0.85rem" };

function Card({ title, to, children }: { title: string; to?: string; children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <section style={cardSurface}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.6rem" }}>
        <h2 style={{ margin: 0, fontSize: "1rem" }}>{title}</h2>
        {to ? (
          <Link to={to} style={link}>
            View all →
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, to }: { label: string; value: number; to: string }): JSX.Element {
  return (
    <Link
      to={to}
      style={{
        flex: "1 1 8rem",
        textDecoration: "none",
        color: t.onSurface,
        background: t.surfaceLowest,
        border: `1px solid ${t.surfaceContainer}`,
        borderRadius: "0.6rem",
        padding: "0.8rem 1rem",
      }}
    >
      <div style={{ fontFamily: t.fontDisplay, fontSize: "1.6rem", fontWeight: 600 }}>{value}</div>
      <div style={{ fontSize: "0.78rem", color: t.onSurfaceVariant }}>{label}</div>
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

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
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
  }, [client, patientId]);

  if (loading) return <LoadingSpinner label="Loading your dashboard…" />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const base = `/p/${patientId}`;
  const who = summary?.patient.preferredName ?? summary?.patient.layLabel ?? "Care overview";
  return (
    <PortalDashboardLayout
      header={
        <div style={{ padding: "1.25rem 1.5rem", borderBottom: `1px solid ${t.surfaceContainer}` }}>
          <div style={{ fontFamily: t.fontDisplay, fontSize: "1.35rem", fontWeight: 600 }}>{who}</div>
          {summary?.patient.pronouns ? (
            <div style={{ color: t.onSurfaceVariant, fontSize: "0.85rem" }}>{summary.patient.pronouns}</div>
          ) : null}
        </div>
      }
      summary={
        <Card title="At a glance">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
            <Stat label="Upcoming visits" value={summary?.upcomingVisitsCount ?? 0} to={`${base}/visits`} />
            <Stat label="Active medications" value={summary?.activeMedicationsCount ?? 0} to={`${base}/medications`} />
            <Stat label="Unread messages" value={summary?.unreadMessagesCount ?? 0} to={`${base}/messages`} />
            <Stat label="Shared documents" value={summary?.pendingDocumentSharesCount ?? 0} to={`${base}/documents`} />
          </div>
        </Card>
      }
      safety={
        <div style={{ fontSize: "0.85rem", color: t.onSurfaceVariant }}>
          After-hours concern? Call your hospice team's 24/7 line — do not use the portal for emergencies.
        </div>
      }
    >
      <Card title="Coming up" to={`${base}/visits`}>
        {upcoming.length === 0 ? (
          <p style={{ margin: 0, color: t.onSurfaceVariant, fontSize: "0.88rem" }}>Nothing scheduled right now.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {upcoming.map((u) => (
              <li key={u.visitId} style={{ fontSize: "0.9rem" }}>
                <strong>{u.visitPurposeLabel}</strong>
                <span style={{ display: "block", color: t.onSurfaceVariant, fontSize: "0.8rem" }}>
                  {stamp(u.scheduledStartedAt)} · {humanize(u.visitSetting)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Quick links">
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
          <Link to={`${base}/care-plan`} style={link}>
            Care plan
          </Link>
          <Link to={`${base}/documents`} style={link}>
            Documents
          </Link>
          <Link to={`${base}/messages`} style={link}>
            Messages
          </Link>
          <Link to={`${base}/preferences`} style={link}>
            Notifications
          </Link>
        </div>
      </Card>
    </PortalDashboardLayout>
  );
}
