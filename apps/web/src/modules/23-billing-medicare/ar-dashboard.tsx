import {
  DashboardLayout,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the AR DASHBOARD (R2, §5.1 #1).
// The landing surface: AR aging buckets (0-30 / 31-60 / 61-90 / 90+), denial rate, NOE/NOTR filing-window
// posture, and the claim-state mix. The spec names no single aggregate route, so the dashboard is composed
// CLIENT-SIDE from the org-scoped rollup reads:
//   GET /api/v1/billing/ar-dashboard  → ArAgingDto (the four aging buckets) — REQUIRED.
//   GET /api/v1/billing/metrics       → { buckets: { key=claimState, count, amountCents }[] } — best-effort.
//   GET /api/v1/noe-records / notr-records → filing-window posture (at-risk / breached) — best-effort.
// All reads are org-scoped server-side (RLS); these are aggregate-only (no row-level PHI). The server is the
// only authz point (ADR-0030) — a 403/503 on a best-effort read simply leaves that tile absent (degraded),
// never a hard failure. Lantern: DashboardLayout + KpiStrip (Fraunces eyebrow / Inter tabular figure),
// No-Line cards, CSS-var tokens only; every status pill resolves through billing-status.ts (§6.6).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { dollars, windowTierLabel, windowTierTone } from "./billing-status";

interface ArAging {
  bucket0to30Cents: number;
  bucket31to60Cents: number;
  bucket61to90Cents: number;
  bucket90PlusCents: number;
}

interface MetricsBucket {
  key: string;
  count: number;
  amountCents: number;
}

interface NoticeWindowRecord {
  state: string;
  windowTargetAt: string | null;
  windowBreachedAt: string | null;
}

interface ListPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

// Days remaining until a filing window closes (negative = breached). A row already flagged
// `windowBreachedAt` is breached regardless of the wall clock.
function daysRemaining(rec: NoticeWindowRecord): number {
  if (rec.windowBreachedAt) return -1;
  if (!rec.windowTargetAt) return Number.POSITIVE_INFINITY;
  return Math.floor((new Date(rec.windowTargetAt).getTime() - Date.now()) / 86_400_000);
}

type WindowPosture = { atRisk: number; breached: number; total: number };

function summarizeWindows(records: NoticeWindowRecord[]): WindowPosture {
  let atRisk = 0;
  let breached = 0;
  for (const r of records) {
    // Terminal notices (accepted / cancelled) have left the window — they don't count against posture.
    if (r.state === "ack_accepted" || r.state === "cancelled" || r.state === "ack_rejected") continue;
    const d = daysRemaining(r);
    if (d < 0) breached += 1;
    else if (d <= 2) atRisk += 1;
  }
  return { atRisk, breached, total: records.length };
}

export function ArDashboard(): JSX.Element {
  const client = useApiClient();
  const [aging, setAging] = useState<ArAging | null>(null);
  const [buckets, setBuckets] = useState<MetricsBucket[] | null>(null);
  const [noe, setNoe] = useState<WindowPosture | null>(null);
  const [notr, setNotr] = useState<WindowPosture | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDegraded(false);
    const [agingRes, metricsRes, noeRes, notrRes] = await Promise.all([
      client.GET("/api/v1/billing/ar-dashboard"),
      client.GET("/api/v1/billing/metrics"),
      client.GET("/api/v1/noe-records"),
      client.GET("/api/v1/notr-records"),
    ]);
    // The AR aging rollup is the page anchor; a 503 (seams unbound) / 403 here degrades the whole surface.
    if (agingRes.error) {
      setError("AR dashboard unavailable — the billing read seam is not bound, or you lack scope.");
      setLoading(false);
      return;
    }
    setAging(agingRes.data as unknown as ArAging);
    // Best-effort tiles: each absent read leaves its tile out and raises the degraded marker (never throws).
    if (metricsRes.error) setDegraded(true);
    else setBuckets(((metricsRes.data as unknown as { buckets?: MetricsBucket[] })?.buckets) ?? []);
    if (noeRes.error) setDegraded(true);
    else
      setNoe(
        summarizeWindows(
          ((noeRes.data as unknown as ListPage<NoticeWindowRecord>)?.items ?? []) as NoticeWindowRecord[],
        ),
      );
    if (notrRes.error) setDegraded(true);
    else
      setNotr(
        summarizeWindows(
          ((notrRes.data as unknown as ListPage<NoticeWindowRecord>)?.items ?? []) as NoticeWindowRecord[],
        ),
      );
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error || !aging) return <EmptyState title="Unavailable" description={error ?? "No data."} />;

  const totalArCents =
    aging.bucket0to30Cents +
    aging.bucket31to60Cents +
    aging.bucket61to90Cents +
    aging.bucket90PlusCents;

  // Claim-state mix → denial rate + open-claim count (best-effort; absent when metrics degraded).
  const byState = new Map((buckets ?? []).map((b) => [b.key, b]));
  const totalClaims = (buckets ?? []).reduce((n, b) => n + b.count, 0);
  const deniedCount = byState.get("denied")?.count ?? 0;
  const denialRate = totalClaims > 0 ? Math.round((deniedCount / totalClaims) * 100) : null;
  const validatingCount = byState.get("validating")?.count ?? 0;

  return (
    <DashboardLayout
      header={<PageHeader title="Accounts Receivable" breadcrumb="Billing — Medicare" />}
      kpis={
        <KpiStrip>
          {/* AR aging buckets (§5.1 #1). */}
          <KpiCard label="AR · 0-30 days" value={dollars(aging.bucket0to30Cents)} />
          <KpiCard label="AR · 31-60 days" value={dollars(aging.bucket31to60Cents)} />
          <KpiCard label="AR · 61-90 days" value={dollars(aging.bucket61to90Cents)} />
          <KpiCard label="AR · 90+ days" value={dollars(aging.bucket90PlusCents)} />
          <KpiCard label="Total open AR" value={dollars(totalArCents)} />
          {/* claim-state-derived tiles (best-effort over GET /metrics). */}
          {buckets ? (
            <>
              <KpiCard
                label="Denial rate"
                value={denialRate === null ? "—" : `${denialRate}%`}
              />
              <KpiCard label="Open claims" value={totalClaims} />
              <KpiCard label="Pending validation" value={validatingCount} />
            </>
          ) : null}
        </KpiStrip>
      }
      charts={
        <section style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
          <WindowPostureCard title="NOE filing windows" posture={noe} href="/billing/noe" />
          <WindowPostureCard title="NOTR filing windows" posture={notr} href="/billing/notr" />
          {degraded ? (
            <p
              style={{
                margin: 0,
                fontSize: "0.8rem",
                color: "var(--color-on-surface-variant)",
                alignSelf: "center",
              }}
            >
              Some panels are running in a degraded mode — a supporting read is unavailable.
            </p>
          ) : null}
        </section>
      }
    />
  );
}

// ── NOE / NOTR filing-window posture card — surfaces at-risk / breached counts with §6.6 window tones ──
function WindowPostureCard({
  title,
  posture,
  href,
}: { title: string; posture: WindowPosture | null; href: string }): JSX.Element {
  if (!posture) {
    return (
      <article style={cardStyle}>
        <h3 style={cardTitleStyle}>{title}</h3>
        <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
          Window posture unavailable
        </span>
      </article>
    );
  }
  // The worst tier present drives the card pill: any breached → error; else any at-risk → warning; else good.
  const worstDays = posture.breached > 0 ? -1 : posture.atRisk > 0 ? 1 : 5;
  return (
    <a href={href} style={{ ...cardStyle, textDecoration: "none", color: "inherit" }}>
      <h3 style={cardTitleStyle}>{title}</h3>
      <StatusPill label={windowTierLabel(worstDays)} tone={windowTierTone(worstDays)} />
      <div
        style={{
          display: "flex",
          gap: "1.25rem",
          fontSize: "0.8rem",
          color: "var(--color-on-surface-variant)",
        }}
      >
        <span className="tabular-nums">{posture.atRisk} at risk</span>
        <span className="tabular-nums">{posture.breached} breached</span>
        <span className="tabular-nums">{posture.total} total</span>
      </div>
    </a>
  );
}

const cardStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.5rem",
  minWidth: "16rem",
  background: "var(--color-surface-lowest)",
  borderRadius: "var(--radius-xl, 1rem)",
  boxShadow: "var(--shadow-soft)",
  padding: "1rem 1.25rem",
};

const cardTitleStyle = {
  margin: 0,
  fontFamily: "var(--font-display)",
  fontSize: "0.95rem",
  fontWeight: 500,
  color: "var(--color-on-surface)",
};
