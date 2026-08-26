// apps/web/src/shell — Operational Home (M1 app-shell landing, Track A).
// The sidebar is the exhaustive navigation surface. Home answers the operational question:
// "what needs my attention today?" using only permission-gated, org-scoped backend reads that
// already exist in the domain modules.
import { EmptyState, Glyph, cardSurface, ghostBorder, t, useApiClient } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import type { CSSProperties, JSX, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { canSeeScreen } from "./actor-session";
import type { WebScreenDescriptor } from "./screen-registry";
import { useSession } from "./session";
import type { Session } from "./session";

type Tone = "neutral" | "healthy" | "info" | "warning" | "critical";
type Severity = "critical" | "warning" | "info";

interface DashboardKpi {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly href?: string;
  readonly tone: Tone;
}

interface AttentionItem {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly description?: string;
  readonly severity: Severity;
  readonly timestamp?: string;
  readonly href?: string;
  readonly module: string;
}

interface TodayItem {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly href?: string;
  readonly tone: Tone;
}

interface ActivityItem {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly timestamp?: string;
  readonly href?: string;
  readonly tone: Tone;
}

interface Contribution {
  readonly kpis?: readonly DashboardKpi[];
  readonly attention?: readonly AttentionItem[];
  readonly today?: readonly TodayItem[];
  readonly activity?: readonly ActivityItem[];
}

interface WidgetSource {
  readonly id: string;
  readonly permission: string;
  readonly load: (client: ApiClient) => Promise<Contribution>;
}

interface DashboardState {
  readonly kpis: DashboardKpi[];
  readonly attention: AttentionItem[];
  readonly today: TodayItem[];
  readonly activity: ActivityItem[];
  readonly failed: string[];
}

const EMPTY_STATE: DashboardState = {
  kpis: [],
  attention: [],
  today: [],
  activity: [],
  failed: [],
};

const toneColor: Record<Tone, string> = {
  neutral: t.onSurfaceVariant,
  healthy: t.success,
  info: t.primary,
  warning: t.warning,
  critical: t.error,
};

const severityTone: Record<Severity, Tone> = {
  critical: "critical",
  warning: "warning",
  info: "info",
};

const toneTint = (color: string, pct = 12): string =>
  `color-mix(in srgb, ${color} ${pct}%, ${t.surfaceLowest})`;

function hasPermission(session: Session | null, permission: string): boolean {
  return session?.permissions?.includes(permission) ?? false;
}

function countBy<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  return items.filter(predicate).length;
}

function pageItems<T>(data: unknown): T[] {
  const page = data as { items?: T[] } | null;
  return Array.isArray(page?.items) ? page.items : [];
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function formatRelative(value?: string): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  const deltaMs = time - Date.now();
  const abs = Math.abs(deltaMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const rtf = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  if (abs < hour) return rtf.format(Math.round(deltaMs / minute), "minute");
  if (abs < day) return rtf.format(Math.round(deltaMs / hour), "hour");
  return rtf.format(Math.round(deltaMs / day), "day");
}

function stateLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function firstName(session: Session | null): string {
  const display = session?.displayName?.trim() || session?.userId || "there";
  return display.split(/\s+/)[0] ?? display;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

const DASHBOARD_SOURCES: readonly WidgetSource[] = [
  {
    id: "patients",
    permission: "patient.read",
    async load(client) {
      const res = await client.GET("/api/v1/patients/census-metrics");
      if (res.error) throw res.error;
      const data = (res.data ?? {}) as { total?: number; byStatus?: Record<string, number> };
      const active = data.byStatus?.active ?? 0;
      return {
        kpis: [
          {
            id: "patients-active",
            label: "Active census",
            value: String(active),
            detail: `${data.total ?? 0} total records`,
            href: "/patients",
            tone: active > 0 ? "info" : "neutral",
          },
        ],
        today: [
          {
            id: "patients-census",
            label: "Active patients",
            value: String(active),
            detail: "Current census",
            href: "/patients",
            tone: "info",
          },
        ],
      };
    },
  },
  {
    id: "referrals",
    permission: "referral.read",
    async load(client) {
      const res = await client.GET("/api/v1/referrals", { params: { query: { limit: 50 } } });
      if (res.error) throw res.error;
      const items = pageItems<{ id: string; state: string }>(res.data);
      const received = countBy(items, (x) => x.state === "received");
      const triaged = countBy(items, (x) => x.state === "triaged" || x.state === "evaluated");
      const active = received + triaged;
      return {
        kpis: [
          {
            id: "referrals-open",
            label: "Referrals",
            value: String(active),
            detail: `${received} awaiting triage`,
            href: "/referrals",
            tone: received > 0 ? "warning" : "healthy",
          },
        ],
        attention:
          received > 0
            ? [
                {
                  id: "referrals-received",
                  type: "DUE",
                  title: `${received} referral${received === 1 ? "" : "s"} awaiting triage`,
                  description: "Referral inbox",
                  severity: "warning",
                  href: "/referrals",
                  module: "Admissions",
                },
              ]
            : [],
        today: [
          {
            id: "referrals-intake",
            label: "Referral intake",
            value: String(active),
            detail: "Open or triaged",
            href: "/referrals",
            tone: active > 0 ? "warning" : "healthy",
          },
        ],
      };
    },
  },
  {
    id: "admissions",
    permission: "admission.read",
    async load(client) {
      const res = await client.GET("/api/v1/admissions", { params: { query: { limit: 50 } } });
      if (res.error) throw res.error;
      const items = pageItems<{ id: string; state: string }>(res.data);
      const pending = countBy(items, (x) => x.state === "pending");
      const active = countBy(items, (x) => x.state === "active" || x.state === "activated");
      return {
        kpis: [
          {
            id: "admissions-pending",
            label: "Admissions",
            value: String(pending),
            detail: `${active} active`,
            href: "/admissions",
            tone: pending > 0 ? "warning" : "healthy",
          },
        ],
        attention:
          pending > 0
            ? [
                {
                  id: "admissions-pending",
                  type: "DUE",
                  title: `${pending} admission${pending === 1 ? "" : "s"} pending`,
                  description: "Admission census",
                  severity: "warning",
                  href: "/admissions",
                  module: "Admissions",
                },
              ]
            : [],
        today: [
          {
            id: "admissions-workload",
            label: "Admissions workload",
            value: String(items.length),
            detail: "Visible admission records",
            href: "/admissions",
            tone: pending > 0 ? "warning" : "neutral",
          },
        ],
      };
    },
  },
  {
    id: "safety",
    permission: "safety.dashboard.read",
    async load(client) {
      const res = await client.GET("/api/v1/safety/dashboard", {});
      if (res.error) throw res.error;
      const board = (res.data ?? {}) as {
        activeSosCount?: number;
        overdueCheckInCount?: number;
        clinicians?: {
          membershipId: string;
          displayName: string;
          overdueState: string;
          activeSosAlert: { id?: string; state?: string } | null;
        }[];
      };
      const clinicians = board.clinicians ?? [];
      const activeSos =
        board.activeSosCount ?? countBy(clinicians, (x) => x.activeSosAlert !== null);
      const overdue =
        board.overdueCheckInCount ??
        countBy(clinicians, (x) => x.overdueState === "overdue" || x.overdueState === "escalated");
      const attention: AttentionItem[] = [];
      if (activeSos > 0) {
        attention.push({
          id: "safety-active-sos",
          type: "HIGH",
          title: `${activeSos} active SOS alert${activeSos === 1 ? "" : "s"}`,
          description: "Field safety board",
          severity: "critical",
          href: "/safety/sos",
          module: "Field safety",
        });
      }
      if (overdue > 0) {
        attention.push({
          id: "safety-overdue",
          type: "WARNING",
          title: `${overdue} overdue check-in${overdue === 1 ? "" : "s"}`,
          description: "Check-in status",
          severity: "warning",
          href: "/safety/check-ins",
          module: "Field safety",
        });
      }
      return {
        kpis: [
          {
            id: "safety-posture",
            label: "Field safety",
            value: String(activeSos + overdue),
            detail: activeSos > 0 ? `${activeSos} SOS active` : `${overdue} overdue check-ins`,
            href: "/safety",
            tone: activeSos > 0 ? "critical" : overdue > 0 ? "warning" : "healthy",
          },
        ],
        attention,
        today: [
          {
            id: "safety-covered-clinicians",
            label: "Safety board",
            value: String(clinicians.length),
            detail: "Visible staff rows",
            href: "/safety",
            tone: activeSos > 0 ? "critical" : overdue > 0 ? "warning" : "healthy",
          },
        ],
      };
    },
  },
  {
    id: "quality-incidents",
    permission: "incident.read",
    async load(client) {
      const res = await client.GET("/api/v1/quality/incidents", {
        params: { query: { limit: 50 } },
      });
      if (res.error) throw res.error;
      const items = pageItems<{ id: string; state: string; severity: string; occurredAt?: string }>(
        res.data,
      );
      const open = countBy(
        items,
        (x) => !["resolved", "closed_followup_complete"].includes(x.state),
      );
      const critical = countBy(items, (x) => x.severity === "critical" || x.severity === "severe");
      return {
        kpis: [
          {
            id: "quality-open-incidents",
            label: "Quality incidents",
            value: String(open),
            detail: `${critical} severe or critical`,
            href: "/quality/qapi",
            tone: critical > 0 ? "critical" : open > 0 ? "warning" : "healthy",
          },
        ],
        attention:
          critical > 0
            ? [
                {
                  id: "quality-critical-incidents",
                  type: "HIGH",
                  title: `${critical} severe quality incident${critical === 1 ? "" : "s"}`,
                  description: "QAPI & incident register",
                  severity: "critical",
                  href: "/quality/qapi",
                  module: "Quality",
                },
              ]
            : open > 0
              ? [
                  {
                    id: "quality-open-incidents",
                    type: "DUE",
                    title: `${open} quality incident${open === 1 ? "" : "s"} open`,
                    description: "QAPI & incident register",
                    severity: "warning",
                    href: "/quality/qapi",
                    module: "Quality",
                  },
                ]
              : [],
      };
    },
  },
  {
    id: "scheduling",
    permission: "visit.metrics.read",
    async load(client) {
      const to = new Date();
      const from = new Date(to);
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      const res = await client.GET("/api/v1/metrics/visits", {
        params: { query: { from: from.toISOString(), to: to.toISOString() } },
      });
      if (res.error) throw res.error;
      const data = (res.data ?? {}) as Record<string, unknown>;
      const completed = Number(data.completed ?? data.completedCount ?? 0);
      const scheduled = Number(data.scheduled ?? data.scheduledCount ?? data.total ?? 0);
      const missed = Number(data.noShow ?? data.noShowCount ?? 0);
      return {
        today: [
          {
            id: "visits-today",
            label: "Scheduled visits",
            value: String(scheduled),
            detail: `${completed} completed`,
            href: "/scheduling/metrics",
            tone: missed > 0 ? "warning" : "info",
          },
        ],
        attention:
          missed > 0
            ? [
                {
                  id: "visits-no-show",
                  type: "WARNING",
                  title: `${missed} no-show visit${missed === 1 ? "" : "s"} today`,
                  description: "Scheduling metrics",
                  severity: "warning",
                  href: "/scheduling/metrics",
                  module: "Scheduling",
                },
              ]
            : [],
      };
    },
  },
  {
    id: "billing-ar",
    permission: "billing.claim.read_ar_dashboard",
    async load(client) {
      const [agingRes, metricsRes] = await Promise.all([
        client.GET("/api/v1/billing/ar-dashboard"),
        client.GET("/api/v1/billing/metrics"),
      ]);
      if (agingRes.error) throw agingRes.error;
      const aging = (agingRes.data ?? {}) as Record<string, number | undefined>;
      const total =
        (aging.bucket0to30Cents ?? 0) +
        (aging.bucket31to60Cents ?? 0) +
        (aging.bucket61to90Cents ?? 0) +
        (aging.bucket90PlusCents ?? 0);
      const old = aging.bucket90PlusCents ?? 0;
      const buckets =
        metricsRes.error || !metricsRes.data
          ? []
          : (((metricsRes.data as { buckets?: { key: string; count: number }[] }).buckets ??
              []) as { key: string; count: number }[]);
      const failedClaims = buckets
        .filter((x) => /reject|denied|failed|partial/i.test(x.key))
        .reduce((sum, x) => sum + x.count, 0);
      return {
        kpis: [
          {
            id: "billing-ar",
            label: "Accounts receivable",
            value: formatMoney(total),
            detail: `${formatMoney(old)} over 90 days`,
            href: "/billing",
            tone: old > 0 ? "warning" : "info",
          },
        ],
        attention:
          failedClaims > 0
            ? [
                {
                  id: "billing-failed-claims",
                  type: "DUE",
                  title: `${failedClaims} claim${failedClaims === 1 ? "" : "s"} need billing review`,
                  description: "Claim workbench",
                  severity: "warning",
                  href: "/billing/claims",
                  module: "Billing",
                },
              ]
            : [],
      };
    },
  },
  {
    id: "audit",
    permission: "audit.read",
    async load(client) {
      const res = await client.GET("/api/v1/audit/events", {
        params: { query: { limit: 6 } },
      });
      if (res.error) throw res.error;
      const items = pageItems<{
        id: string;
        createdAt: string;
        eventType: string;
        resourceKind: string;
        outcome: string;
        severity: "info" | "warn" | "critical";
      }>(res.data);
      return {
        activity: items.map((item) => ({
          id: item.id,
          title: stateLabel(item.eventType),
          detail: `${stateLabel(item.resourceKind)} · ${stateLabel(item.outcome)}`,
          timestamp: item.createdAt,
          href: "/audit",
          tone:
            item.severity === "critical"
              ? "critical"
              : item.severity === "warn"
                ? "warning"
                : "neutral",
        })),
      };
    },
  },
];

function mergeContributions(
  results: readonly Contribution[],
  failed: readonly string[],
): DashboardState {
  return {
    kpis: results.flatMap((x) => [...(x.kpis ?? [])]).slice(0, 5),
    attention: results
      .flatMap((x) => [...(x.attention ?? [])])
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
      .slice(0, 6),
    today: results.flatMap((x) => [...(x.today ?? [])]).slice(0, 6),
    activity: results.flatMap((x) => [...(x.activity ?? [])]).slice(0, 6),
    failed: [...failed],
  };
}

function severityRank(severity: Severity): number {
  return severity === "critical" ? 3 : severity === "warning" ? 2 : 1;
}

function quickAccessScreens(
  screens: readonly WebScreenDescriptor[],
  session: Session | null,
): WebScreenDescriptor[] {
  const visible = screens
    .filter((s) => !s.path.includes(":") && !s.path.includes("*"))
    .filter((s) => canSeeScreen(s, session));
  const preferred = [
    "safety.dashboard",
    "quality.qapi-incidents",
    "admission.referrals",
    "admission.census",
    "patient.census",
    "scheduling.day-view",
    "billing.ar-dashboard",
    "billing.claims",
    "identity.staff-management",
    "audit.log",
    "reporting.catalog",
  ];
  return visible
    .sort((a, b) => {
      const ai = preferred.indexOf(a.id);
      const bi = preferred.indexOf(b.id);
      const ar = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
      const br = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
      return ar - br || a.title.localeCompare(b.title);
    })
    .slice(0, 8);
}

function primaryAction(
  screens: readonly WebScreenDescriptor[],
  session: Session | null,
): WebScreenDescriptor | null {
  const candidates = ["admission.create", "safety.incident.new", "billing.claim.new"];
  for (const id of candidates) {
    const screen = screens.find((s) => s.id === id);
    if (screen && canSeeScreen(screen, session)) return screen;
  }
  return null;
}

export function RoleHome({ screens }: { screens: WebScreenDescriptor[] }): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const [state, setState] = useState<DashboardState>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const action = primaryAction(screens, session);
  const quickAccess = useMemo(() => quickAccessScreens(screens, session), [screens, session]);

  useEffect(() => {
    let active = true;
    const enabled = DASHBOARD_SOURCES.filter((source) => hasPermission(session, source.permission));
    if (enabled.length === 0) {
      setState(EMPTY_STATE);
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      const settled = await Promise.allSettled(enabled.map((source) => source.load(client)));
      if (!active) return;
      const good: Contribution[] = [];
      const failed: string[] = [];
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") good.push(result.value);
        else failed.push(enabled[index]?.id ?? "unknown");
      });
      setState(mergeContributions(good, failed));
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, session]);

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <div>
          <h1 style={titleStyle}>
            {session ? `${greeting()}, ${firstName(session)}` : "Welcome to WardenX"}
          </h1>
          <p style={subtitleStyle}>Here's what needs your attention today.</p>
        </div>
        {action ? (
          <Link to={action.path} className="wx-button" style={primaryActionStyle}>
            <Glyph name="arrow-right" size={16} />
            <span>{action.title}</span>
          </Link>
        ) : null}
      </header>

      <section aria-label="Summary" style={kpiGridStyle}>
        {loading && state.kpis.length === 0
          ? // Keyed by a generated id rather than the raw array index. These are identical,
            // content-free loading placeholders, so no reconciliation bug is possible either way —
            // but building the ids first says "these have no identity" outright, which a bare
            // `key={i}` cannot, and it keeps the honest reading of `noArrayIndexKey` intact for
            // every list that DOES carry identity.
            KPI_SKELETON_KEYS.map((key) => <KpiSkeleton key={key} />)
          : state.kpis.map((kpi) => <Kpi key={kpi.id} kpi={kpi} />)}
      </section>

      <div style={mainGridStyle}>
        <Panel
          title="Needs your attention"
          action={
            state.attention.length > 0 ? (
              <Link to={state.attention[0]!.href ?? "/"}>View first</Link>
            ) : null
          }
          prominent
        >
          {loading && state.attention.length === 0 ? (
            <ListSkeleton rows={4} />
          ) : state.attention.length > 0 ? (
            <div style={{ display: "grid", gap: "0.75rem" }}>
              {state.attention.map((item) => (
                <AttentionRow key={item.id} item={item} />
              ))}
            </div>
          ) : (
            <HealthyState />
          )}
        </Panel>

        <Panel title="Today's operations">
          {loading && state.today.length === 0 ? (
            <ListSkeleton rows={4} />
          ) : state.today.length > 0 ? (
            <div style={{ display: "grid", gap: "0.75rem" }}>
              {state.today.map((item) => (
                <TodayRow key={item.id} item={item} />
              ))}
            </div>
          ) : (
            <EmptyState
              title="No operational rollups yet"
              description="No accessible module exposes a today-focused aggregate for this role."
            />
          )}
        </Panel>
      </div>

      {state.failed.length > 0 ? (
        <div
          // biome-ignore lint/a11y/useSemanticElements: `<output>` is a form-associated calculation
          // result; this is a degraded-state announcement, for which `role="status"` on flow content
          // is the idiomatic polite live region.
          role="status"
          style={degradedStyle}
        >
          Some dashboard sections could not be loaded: {state.failed.join(", ")}.
        </div>
      ) : null}

      <section style={{ marginTop: t.space7 }}>
        <SectionHeading title="Quick access" />
        {quickAccess.length > 0 ? (
          <div style={quickGridStyle}>
            {quickAccess.map((screen) => (
              <Link key={screen.id} to={screen.path} style={quickLinkStyle}>
                <span>{screen.title}</span>
                <Glyph name="arrow-right" size={15} />
              </Link>
            ))}
          </div>
        ) : (
          <p style={mutedStyle}>No shortcuts are available for your current permissions.</p>
        )}
      </section>

      <section style={{ marginTop: t.space7 }}>
        <SectionHeading title="Recent activity" />
        {loading && state.activity.length === 0 ? (
          <ListSkeleton rows={3} />
        ) : state.activity.length > 0 ? (
          <div style={{ ...cardSurface, padding: "0.35rem 1rem" }}>
            {state.activity.map((item) => (
              <ActivityRow key={item.id} item={item} />
            ))}
          </div>
        ) : (
          <p style={mutedStyle}>
            No recent activity feed is available for your current permissions.
          </p>
        )}
      </section>
    </div>
  );
}

function Kpi({ kpi }: { kpi: DashboardKpi }): JSX.Element {
  const content = (
    <>
      <span style={labelStyle}>{kpi.label}</span>
      <span className="tabular-nums" style={{ ...kpiValueStyle, color: toneColor[kpi.tone] }}>
        {kpi.value}
      </span>
      {kpi.detail ? <span style={mutedSmallStyle}>{kpi.detail}</span> : null}
    </>
  );
  const style = {
    ...cardSurface,
    ...kpiStyle,
    borderLeft: `4px solid ${toneColor[kpi.tone]}`,
  };
  return kpi.href ? (
    <Link to={kpi.href} style={{ ...style, textDecoration: "none", color: t.onSurface }}>
      {content}
    </Link>
  ) : (
    <div style={style}>{content}</div>
  );
}

function AttentionRow({ item }: { item: AttentionItem }): JSX.Element {
  const accent = toneColor[severityTone[item.severity]];
  const content = (
    <>
      <span style={{ ...pillStyle, color: accent, background: toneTint(accent, 12) }}>
        {item.type}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={rowTitleStyle}>{item.title}</span>
        <span style={rowMetaStyle}>
          {item.description ?? item.module}
          {item.timestamp ? ` · ${formatRelative(item.timestamp)}` : ""}
        </span>
      </span>
    </>
  );
  return item.href ? (
    <Link to={item.href} style={attentionRowStyle}>
      {content}
    </Link>
  ) : (
    <div style={attentionRowStyle}>{content}</div>
  );
}

function TodayRow({ item }: { item: TodayItem }): JSX.Element {
  const content = (
    <>
      <span>
        <span style={rowTitleStyle}>{item.label}</span>
        {item.detail ? <span style={rowMetaStyle}>{item.detail}</span> : null}
      </span>
      <span className="tabular-nums" style={{ color: toneColor[item.tone], fontWeight: 750 }}>
        {item.value}
      </span>
    </>
  );
  return item.href ? (
    <Link to={item.href} style={todayRowStyle}>
      {content}
    </Link>
  ) : (
    <div style={todayRowStyle}>{content}</div>
  );
}

function ActivityRow({ item }: { item: ActivityItem }): JSX.Element {
  return (
    <Link to={item.href ?? "/audit"} style={activityRowStyle}>
      <span style={{ ...activityDotStyle, background: toneColor[item.tone] }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={rowTitleStyle}>{item.title}</span>
        {item.detail ? <span style={rowMetaStyle}>{item.detail}</span> : null}
      </span>
      {item.timestamp ? (
        <span style={mutedSmallStyle}>{formatRelative(item.timestamp)}</span>
      ) : null}
    </Link>
  );
}

function Panel({
  title,
  action,
  prominent = false,
  children,
}: {
  title: string;
  action?: ReactNode;
  prominent?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <section style={{ ...cardSurface, padding: t.space5, minHeight: prominent ? "21rem" : "auto" }}>
      <div style={panelHeaderStyle}>
        <h2 style={sectionTitleStyle}>{title}</h2>
        {action ? <div style={{ fontSize: "0.85rem" }}>{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function SectionHeading({ title }: { title: string }): JSX.Element {
  return <h2 style={{ ...sectionTitleStyle, marginBottom: "0.85rem" }}>{title}</h2>;
}

function HealthyState(): JSX.Element {
  return (
    <div style={healthyStyle}>
      <span style={healthyIconStyle}>
        <Glyph name="check" size={18} />
      </span>
      <div>
        <div style={{ fontWeight: 750, color: t.onSurface }}>You're all caught up</div>
        <div style={mutedSmallStyle}>No urgent items require your attention.</div>
      </div>
    </div>
  );
}

function KpiSkeleton(): JSX.Element {
  return (
    <div style={{ ...cardSurface, ...kpiStyle }}>
      <span style={{ ...skeletonStyle, width: "55%" }} />
      <span style={{ ...skeletonStyle, width: "35%", height: "1.9rem" }} />
      <span style={{ ...skeletonStyle, width: "70%" }} />
    </div>
  );
}

/** Stable ids for the four KPI loading placeholders — see the note at the call site. */
const KPI_SKELETON_KEYS = ["kpi-skeleton-1", "kpi-skeleton-2", "kpi-skeleton-3", "kpi-skeleton-4"];

/** Stable ids for `rows` identical list placeholders. */
function skeletonRowKeys(rows: number): string[] {
  return Array.from({ length: rows }, (_, i) => `skeleton-row-${i + 1}`);
}

function ListSkeleton({ rows }: { rows: number }): JSX.Element {
  return (
    <div style={{ display: "grid", gap: "0.75rem" }}>
      {/* Generated ids, not the raw index — see the KPI skeleton above. */}
      {skeletonRowKeys(rows).map((key) => (
        <div key={key} style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <span style={{ ...skeletonStyle, width: "3rem" }} />
          <span style={{ ...skeletonStyle, flex: 1 }} />
          <span style={{ ...skeletonStyle, width: "4rem" }} />
        </div>
      ))}
    </div>
  );
}

const pageStyle: CSSProperties = {
  padding: "clamp(1rem, 3vw, 2rem)",
  overflow: "auto",
  background: t.background,
  minHeight: "100%",
};
const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: t.space5,
  marginBottom: t.space7,
  flexWrap: "wrap",
};
const titleStyle: CSSProperties = {
  margin: "0 0 0.35rem",
  fontFamily: t.fontDisplay,
  fontWeight: 650,
  fontSize: "1.75rem",
  letterSpacing: 0,
  color: t.onSurface,
};
const subtitleStyle: CSSProperties = {
  margin: 0,
  color: t.onSurfaceVariant,
  maxWidth: "44rem",
};
const primaryActionStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.45rem",
  padding: "0.65rem 0.9rem",
  borderRadius: t.radiusMd,
  background: t.primary,
  color: t.onPrimary,
  textDecoration: "none",
  fontWeight: 750,
  whiteSpace: "nowrap",
};
const kpiGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 12rem), 1fr))",
  gap: t.space4,
  marginBottom: t.space7,
};
const kpiStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "0.45rem",
  padding: "1rem 1.1rem",
  minHeight: "7.75rem",
};
const labelStyle: CSSProperties = {
  color: t.onSurfaceVariant,
  fontSize: "0.72rem",
  fontWeight: 750,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};
const kpiValueStyle: CSSProperties = {
  fontFamily: t.fontSans,
  fontSize: "1.85rem",
  fontWeight: 750,
  lineHeight: 1.05,
};
const mainGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 21rem), 1fr))",
  gap: t.space5,
};
const panelHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: t.space3,
  marginBottom: t.space4,
};
const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontSize: "1rem",
  fontWeight: 750,
  letterSpacing: 0,
  color: t.onSurface,
};
const pillStyle: CSSProperties = {
  width: "4.7rem",
  flex: "0 0 4.7rem",
  textAlign: "center",
  borderRadius: t.radiusSm,
  padding: "0.22rem 0.35rem",
  fontSize: "0.68rem",
  fontWeight: 800,
  letterSpacing: "0.04em",
};
const attentionRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.85rem",
  padding: "0.85rem",
  borderRadius: t.radiusMd,
  background: t.surfaceLow,
  color: t.onSurface,
  textDecoration: "none",
};
const todayRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: t.space3,
  alignItems: "center",
  padding: "0.8rem 0",
  borderBottom: ghostBorder,
  color: t.onSurface,
  textDecoration: "none",
};
const activityRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.8rem 0",
  borderBottom: ghostBorder,
  color: t.onSurface,
  textDecoration: "none",
};
const rowTitleStyle: CSSProperties = {
  display: "block",
  color: t.onSurface,
  fontWeight: 700,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const rowMetaStyle: CSSProperties = {
  display: "block",
  color: t.onSurfaceVariant,
  fontSize: "0.8rem",
  marginTop: "0.18rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const mutedStyle: CSSProperties = { color: t.onSurfaceVariant, margin: 0 };
const mutedSmallStyle: CSSProperties = { color: t.onSurfaceVariant, fontSize: "0.8rem" };
const degradedStyle: CSSProperties = {
  marginTop: t.space5,
  padding: "0.8rem 1rem",
  borderRadius: t.radiusMd,
  color: t.warning,
  background: toneTint(t.warning, 10),
};
const quickGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 12rem), 1fr))",
  gap: t.space3,
};
const quickLinkStyle: CSSProperties = {
  ...cardSurface,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: t.space3,
  padding: "0.85rem 1rem",
  color: t.onSurface,
  textDecoration: "none",
  fontWeight: 700,
};
const healthyStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.85rem",
  padding: "1.25rem",
  borderRadius: t.radiusLg,
  background: toneTint(t.success, 10),
};
const healthyIconStyle: CSSProperties = {
  display: "inline-flex",
  width: "2rem",
  height: "2rem",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "999px",
  color: t.successPillFg,
  background: toneTint(t.success, 18),
};
const activityDotStyle: CSSProperties = {
  width: "0.5rem",
  height: "0.5rem",
  borderRadius: "999px",
  flex: "0 0 auto",
};
const skeletonStyle: CSSProperties = {
  display: "block",
  height: "0.85rem",
  borderRadius: "999px",
  background: `linear-gradient(90deg, ${t.surfaceLow}, ${t.surfaceContainer}, ${t.surfaceLow})`,
};
