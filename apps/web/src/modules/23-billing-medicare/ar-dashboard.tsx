import {
  EmptyState,
  Glyph,
  type GlyphName,
  KpiCard,
  LoadingSpinner,
  Panel,
  StatusPill,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/23-billing-medicare — Billing landing (M23 §5.1 #1, Track B / ADR-0030; 2026-09-25
// redesign, mockup "Billing / Claims"). Four headline cards, the org's claims table, and a right rail with
// the A/R aging buckets, the claim pipeline by state, and the NOE/NOTR filing-window posture.
//   GET /api/v1/billing/claims        → the claims table (cursor pages of 50, "Load more").
//   GET /api/v1/billing/ar-dashboard  → the four A/R aging buckets.
//   GET /api/v1/billing/metrics       → claim counts and amounts by state.
//   GET /api/v1/noe-records / notr-records → filing-window posture.
// Claims carry no submitted/paid dates, so the cards are current counts by state, not month-to-date
// figures, and there are no period-over-period trends. Each read is independent: one that fails leaves its
// card or panel saying so rather than blanking the page. Every read is org-scoped server-side (RLS); the
// server is the only authz point (ADR-0030).
import { useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import { useSession } from "../../shell/session";
import { BillingNeedsAttention } from "./billing-home-attention";
import { claimStateTone, dollars, statusLabel } from "./billing-status";

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
interface ClaimSummary {
  claimId: string;
  patientId: string;
  tob: string;
  state: string;
  serviceFrom: string;
  serviceTo: string;
  claimControlNumber: string;
  macJurisdiction: string;
  totalChargeCents: number;
  totalExpectedPaymentCents: number;
}
interface PatientName {
  firstName?: string | null;
  lastName?: string | null;
  mrn?: string | null;
}
type Load<T> = T | null | "error";

const SUBMITTED = ["submitted", "ack_pending", "ack_accepted", "ack_partial"];
const PAID = ["paid", "partial_paid"];
const PIPELINE = [
  "draft",
  "validating",
  "ready",
  "submitted",
  "ack_pending",
  "ack_accepted",
  "ack_partial",
  "paid",
  "partial_paid",
  "denied",
] as const;
const PAGE_SIZE = 10;

const TOB_SHORT: Record<string, string> = {
  "811": "Admit–discharge",
  "812": "Interim · first",
  "813": "Interim · continuing",
  "814": "Interim · last",
  "817": "Replacement",
  "818": "Void",
};

// Days until a filing window closes (negative = breached).
function daysRemaining(rec: NoticeWindowRecord): number {
  if (rec.windowBreachedAt) return -1;
  if (!rec.windowTargetAt) return Number.POSITIVE_INFINITY;
  return Math.floor((new Date(rec.windowTargetAt).getTime() - Date.now()) / 86_400_000);
}
function posture(records: NoticeWindowRecord[]): {
  atRisk: number;
  breached: number;
  open: number;
} {
  let atRisk = 0;
  let breached = 0;
  let open = 0;
  for (const r of records) {
    if (r.state === "ack_accepted" || r.state === "cancelled" || r.state === "ack_rejected")
      continue;
    open += 1;
    const d = daysRemaining(r);
    if (d < 0) breached += 1;
    else if (d <= 2) atRisk += 1;
  }
  return { atRisk, breached, open };
}

const ymd = (v: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
function servicePeriod(from: string, to: string): string {
  const a = ymd(from);
  const b = ymd(to);
  if (!a || !b) return "—";
  const md = (d: Date) =>
    `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  return `${md(a)} – ${md(b)}/${b.getFullYear()}`;
}
const wholeDollars = (cents: number): string =>
  (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

export function ArDashboard(): JSX.Element {
  const client = useApiClient();
  const permissions = useSession()?.permissions;
  const [aging, setAging] = useState<Load<ArAging>>(null);
  const [buckets, setBuckets] = useState<Load<MetricsBucket[]>>(null);
  const [noe, setNoe] = useState<Load<NoticeWindowRecord[]>>(null);
  const [notr, setNotr] = useState<Load<NoticeWindowRecord[]>>(null);
  const [claims, setClaims] = useState<Load<ClaimSummary[]>>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [patients, setPatients] = useState<Map<string, PatientName>>(new Map());
  const [retryKey, setRetryKey] = useState(0);
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [page, setPage] = useState(1);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryKey re-runs the load on "Retry".
  useEffect(() => {
    let active = true;
    const settle = <T,>(
      p: Promise<{ data?: unknown; error?: unknown }>,
      set: (v: Load<T>) => void,
      pick: (d: unknown) => T,
    ) =>
      p
        .then((r) => active && set(r.error ? "error" : pick(r.data)))
        .catch(() => active && set("error"));
    setClaims(null);
    void settle<ArAging>(client.GET("/api/v1/billing/ar-dashboard"), setAging, (d) => d as ArAging);
    void settle<MetricsBucket[]>(
      client.GET("/api/v1/billing/metrics"),
      setBuckets,
      (d) => (d as { buckets?: MetricsBucket[] })?.buckets ?? [],
    );
    void settle<NoticeWindowRecord[]>(
      client.GET("/api/v1/noe-records"),
      setNoe,
      (d) => (d as { items?: NoticeWindowRecord[] })?.items ?? [],
    );
    void settle<NoticeWindowRecord[]>(
      client.GET("/api/v1/notr-records"),
      setNotr,
      (d) => (d as { items?: NoticeWindowRecord[] })?.items ?? [],
    );
    void client
      .GET("/api/v1/billing/claims", { params: { query: { limit: 50 } } } as never)
      .then((r) => {
        if (!active) return;
        if (r.error) return setClaims("error");
        const page = r.data as unknown as {
          items?: ClaimSummary[];
          nextCursor?: string | null;
          hasMore?: boolean;
        };
        setClaims(page?.items ?? []);
        setCursor(page?.hasMore ? (page.nextCursor ?? null) : null);
      })
      .catch(() => active && setClaims("error"));
    return () => {
      active = false;
    };
  }, [client, retryKey]);

  async function loadMore(): Promise<void> {
    if (!cursor || !Array.isArray(claims)) return;
    setLoadingMore(true);
    const r = await client
      .GET("/api/v1/billing/claims", { params: { query: { limit: 50, cursor } } } as never)
      .catch(() => ({ data: undefined, error: true }));
    setLoadingMore(false);
    if (r.error) return;
    const next = r.data as unknown as {
      items?: ClaimSummary[];
      nextCursor?: string | null;
      hasMore?: boolean;
    };
    setClaims([...claims, ...(next?.items ?? [])]);
    setCursor(next?.hasMore ? (next.nextCursor ?? null) : null);
  }

  // Patient names for the loaded claims.
  useEffect(() => {
    if (!Array.isArray(claims)) return;
    const missing = [...new Set(claims.map((c) => c.patientId))].filter((id) => !patients.has(id));
    if (missing.length === 0) return;
    let active = true;
    void Promise.all(
      missing.slice(0, 60).map((id) =>
        client
          .GET("/api/v1/patients/{id}", { params: { path: { id } } })
          .then((r) => [id, (r.data ?? {}) as PatientName] as const)
          .catch(() => [id, {} as PatientName] as const),
      ),
    ).then((rows) => {
      if (active) setPatients((prev) => new Map([...prev, ...rows]));
    });
    return () => {
      active = false;
    };
  }, [client, claims, patients]);

  const nameOf = (id: string): string => {
    const p = patients.get(id);
    return (
      [p?.firstName, p?.lastName].filter(Boolean).join(" ") || (p ? (p.mrn ?? "Patient") : "…")
    );
  };

  const byState = useMemo(
    () => new Map((Array.isArray(buckets) ? buckets : []).map((b) => [b.key, b])),
    [buckets],
  );
  const sum = (keys: readonly string[], f: "count" | "amountCents") =>
    keys.reduce((n, k) => n + (byState.get(k)?.[f] ?? 0), 0);
  const totalClaims = Array.isArray(buckets) ? buckets.reduce((n, b) => n + b.count, 0) : 0;
  const denied = byState.get("denied")?.count ?? 0;
  const over30 =
    aging && aging !== "error"
      ? aging.bucket31to60Cents + aging.bucket61to90Cents + aging.bucket90PlusCents
      : null;
  const openAr = aging && aging !== "error" ? (over30 ?? 0) + aging.bucket0to30Cents : null;

  const q = search.trim().toLowerCase();
  const visible = (Array.isArray(claims) ? claims : []).filter(
    (c) =>
      (!stateFilter || c.state === stateFilter) &&
      (!q ||
        c.claimControlNumber.toLowerCase().includes(q) ||
        nameOf(c.patientId).toLowerCase().includes(q)),
  );
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const rows = visible.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const canAssemble = permissions?.includes("billing.claim.assemble") ?? false;

  return (
    <div className="wx-with-rail">
      <div className="wx-with-rail-main">
        <header className="wx-page-head">
          <div>
            <h1 style={{ fontSize: "1.875rem" }}>Billing / Claims</h1>
            <p>Medicare claims, remittances, denials and accounts receivable.</p>
          </div>
          <div style={{ display: "flex", gap: "0.625rem" }}>
            <Link to="/billing/claims" className="wx-btn-secondary">
              <Glyph name="clipboard-list" size={16} /> Claim Workbench
            </Link>
            {canAssemble ? (
              <Link to="/billing/claims/new" className="wx-btn-primary">
                <Glyph name="plus" size={16} /> New Claim
              </Link>
            ) : null}
          </div>
        </header>

        <BillingTabs />

        <BillingNeedsAttention />

        <div className="wx-stat-grid" aria-label="Billing summary">
          <Kpi
            icon="send"
            label="Submitted"
            value={buckets === "error" ? "—" : buckets ? sum(SUBMITTED, "count") : null}
            hint={buckets === "error" ? "Unavailable" : "Awaiting payment"}
          />
          <Kpi
            icon="check-circle"
            label="Paid"
            value={buckets === "error" ? "—" : buckets ? sum(PAID, "count") : null}
            hint={
              buckets === "error"
                ? "Unavailable"
                : buckets
                  ? wholeDollars(sum(PAID, "amountCents"))
                  : ""
            }
            color={Array.isArray(buckets) && sum(PAID, "count") > 0 ? t.success : undefined}
          />
          <Kpi
            icon="x-circle"
            label="Denied"
            value={buckets === "error" ? "—" : buckets ? denied : null}
            hint={
              buckets === "error"
                ? "Unavailable"
                : totalClaims > 0
                  ? `${Math.round((denied / totalClaims) * 100)}% of claims`
                  : "No claims yet"
            }
            color={denied > 0 ? t.error : undefined}
          />
          <Kpi
            icon="clock"
            label="A/R > 30 days"
            value={aging === "error" ? "—" : over30 === null ? null : wholeDollars(over30)}
            hint={
              aging === "error"
                ? "Unavailable"
                : openAr === null
                  ? ""
                  : `of ${wholeDollars(openAr)} open`
            }
            color={(over30 ?? 0) > 0 ? t.warning : undefined}
          />
        </div>

        <div className="wx-filter-panel">
          <label className="wx-search-field">
            <Glyph name="search" size={16} />
            <input
              type="search"
              aria-label="Search claims"
              placeholder="Search by claim # or patient…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="wx-filter-field">
            <span>Status</span>
            <select
              className="wx-select"
              aria-label="Claim status"
              value={stateFilter}
              onChange={(e) => {
                setStateFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              {[...PIPELINE, "replaced", "voided"].map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {claims === null ? (
          <div className="wx-list-state">
            <LoadingSpinner />
          </div>
        ) : claims === "error" ? (
          <div className="wx-list-state">
            <EmptyState
              title="Claims unavailable"
              description="The claims list could not be loaded."
            />
            <button
              type="button"
              className="wx-btn-secondary"
              onClick={() => setRetryKey((k) => k + 1)}
            >
              Retry
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="wx-list-state">
            <EmptyState
              title={claims.length === 0 ? "No claims yet" : "No matching claims"}
              description={
                claims.length === 0
                  ? "Claims appear here once they are assembled from a patient's billing period."
                  : "Try a different search or status."
              }
            />
          </div>
        ) : (
          <div className="wx-list-table-wrap">
            <table className="wx-list-table wx-list-table-static">
              <caption className="wx-sr-only">Claims</caption>
              <thead>
                <tr>
                  <th>Claim #</th>
                  <th>Patient</th>
                  <th>Dates of Service</th>
                  <th>Type</th>
                  <th style={{ textAlign: "right" }}>Amount</th>
                  <th style={{ textAlign: "right" }}>Expected</th>
                  <th>Status</th>
                  <th>
                    <span className="wx-sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.claimId}>
                    <td className="wx-nums">
                      <Link to={`/billing/claims/${c.claimId}`} className="wx-row-title">
                        {c.claimControlNumber}
                      </Link>
                    </td>
                    <td>
                      <Link to={`/patients/${c.patientId}`}>{nameOf(c.patientId)}</Link>
                    </td>
                    <td className="wx-nums">{servicePeriod(c.serviceFrom, c.serviceTo)}</td>
                    <td>
                      <span title={`TOB ${c.tob}`}>{TOB_SHORT[c.tob] ?? c.tob}</span>
                      <div className="wx-row-sub">Medicare · {c.macJurisdiction}</div>
                    </td>
                    <td className="wx-nums" style={{ textAlign: "right" }}>
                      {dollars(c.totalChargeCents)}
                    </td>
                    <td className="wx-nums" style={{ textAlign: "right" }}>
                      {dollars(c.totalExpectedPaymentCents)}
                    </td>
                    <td>
                      <StatusPill label={statusLabel(c.state)} tone={claimStateTone(c.state)} />
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Link
                        to={`/billing/claims/${c.claimId}`}
                        className="wx-icon-link"
                        aria-label={`Open claim ${c.claimControlNumber}`}
                      >
                        <Glyph name="chevron-right" size={18} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="wx-table-footer">
              <span className="wx-nums">
                Showing {(current - 1) * PAGE_SIZE + 1} to{" "}
                {Math.min(current * PAGE_SIZE, visible.length)} of {visible.length} loaded claims
              </span>
              <span style={{ display: "inline-flex", gap: "0.375rem" }}>
                <button
                  type="button"
                  className="wx-btn-secondary wx-btn-sm"
                  disabled={current === 1}
                  onClick={() => setPage(current - 1)}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="wx-btn-secondary wx-btn-sm"
                  disabled={current === pages}
                  onClick={() => setPage(current + 1)}
                >
                  Next
                </button>
                {cursor ? (
                  <button
                    type="button"
                    className="wx-btn-secondary wx-btn-sm"
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </button>
                ) : null}
              </span>
            </div>
          </div>
        )}
      </div>

      <aside className="wx-with-rail-side" aria-label="Receivables">
        <Panel title="A/R Aging" icon="bar-chart">
          {aging === null ? (
            <LoadingSpinner />
          ) : aging === "error" ? (
            <p className="wx-rail-empty" style={{ padding: 0 }}>
              A/R aging is unavailable.
            </p>
          ) : (
            <ArAgingBars aging={aging} />
          )}
        </Panel>

        <Panel
          title="Claim Pipeline"
          icon="activity"
          action={<Link to="/billing/claims">Workbench</Link>}
        >
          {buckets === null ? (
            <LoadingSpinner />
          ) : buckets === "error" ? (
            <p className="wx-rail-empty" style={{ padding: 0 }}>
              Claim counts are unavailable.
            </p>
          ) : totalClaims === 0 ? (
            <p className="wx-rail-empty" style={{ padding: 0 }}>
              No claims yet.
            </p>
          ) : (
            <ul className="wx-hbars">
              {PIPELINE.filter((s) => (byState.get(s)?.count ?? 0) > 0).map((s) => {
                const n = byState.get(s)?.count ?? 0;
                const max = Math.max(...PIPELINE.map((k) => byState.get(k)?.count ?? 0), 1);
                return (
                  <li key={s}>
                    <span>{statusLabel(s)}</span>
                    <span className="wx-hbar-track">
                      <span
                        style={{
                          width: `${(n / max) * 100}%`,
                          background: s === "denied" ? t.error : undefined,
                        }}
                      />
                    </span>
                    <strong className="wx-nums">{n}</strong>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Filing Windows" icon="calendar-check">
          <dl className="wx-kv">
            <WindowRow label="NOE" records={noe} to="/billing/noe" />
            <WindowRow label="NOTR" records={notr} to="/billing/notr" />
          </dl>
          <p className="wx-row-sub" style={{ margin: "0.625rem 0 0", fontSize: "0.75rem" }}>
            At risk: 2 days or less left in the filing window.
          </p>
        </Panel>
      </aside>
    </div>
  );
}

// The shared stat card (label · value · detail), like every other summary row in the app.
function Kpi({
  icon,
  label,
  value,
  hint,
  color,
}: {
  icon: GlyphName;
  label: string;
  value: ReactNode | null;
  hint: string;
  color?: string;
}): JSX.Element {
  return (
    <KpiCard icon={icon} accentColor={color} label={label} value={value ?? "…"} detail={hint} />
  );
}

function ArAgingBars({ aging }: { aging: ArAging }): JSX.Element {
  const bars = [
    { label: "0–30", cents: aging.bucket0to30Cents },
    { label: "31–60", cents: aging.bucket31to60Cents },
    { label: "61–90", cents: aging.bucket61to90Cents },
    { label: "90+", cents: aging.bucket90PlusCents },
  ];
  const total = bars.reduce((n, b) => n + b.cents, 0);
  if (total === 0) {
    return (
      <p className="wx-row-sub" style={{ margin: 0 }}>
        No open claims in accounts receivable.
      </p>
    );
  }
  const max = Math.max(...bars.map((b) => b.cents), 1);
  return (
    <figure style={{ margin: 0 }}>
      <figcaption className="wx-row-sub" style={{ marginBottom: "0.5rem" }}>
        {wholeDollars(total)} open, by days outstanding
      </figcaption>
      <div className="wx-bars">
        {bars.map((b) => (
          <div key={b.label} title={`${b.label} days: ${dollars(b.cents)}`}>
            <span className="wx-bar-value wx-nums">{wholeDollars(b.cents)}</span>
            <span
              className="wx-bar"
              style={{
                height: `${Math.max(3, (b.cents / max) * 100)}%`,
                background: b.label === "90+" ? t.warning : t.primary,
              }}
            />
            <span className="wx-bar-label">{b.label}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}

function WindowRow({
  label,
  records,
  to,
}: {
  label: string;
  records: Load<NoticeWindowRecord[]>;
  to: string;
}): JSX.Element {
  const p = Array.isArray(records) ? posture(records) : null;
  return (
    <>
      <dt>
        <Link to={to}>{label} queue</Link>
      </dt>
      <dd>
        {records === null ? (
          "…"
        ) : records === "error" ? (
          "Unavailable"
        ) : p && (p.breached > 0 || p.atRisk > 0) ? (
          <span style={{ display: "inline-flex", gap: "0.375rem", flexWrap: "wrap" }}>
            {p.breached > 0 ? <StatusPill label={`${p.breached} breached`} tone="error" /> : null}
            {p.atRisk > 0 ? <StatusPill label={`${p.atRisk} at risk`} tone="warning" /> : null}
          </span>
        ) : (
          <span className="wx-nums">{p?.open ? `${p.open} open · on time` : "None open"}</span>
        )}
      </dd>
    </>
  );
}
