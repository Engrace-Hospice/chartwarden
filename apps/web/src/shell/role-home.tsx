// apps/web/src/shell — Operational Home (M1 app-shell landing, Track A; 2026-09-25 redesign, mockup
// "Dashboard"). Home answers "what needs my attention today?" from permission-gated, org-scoped reads
// that already exist in the domain modules: a greeting, five KPI cards, My Tasks (HOPE windows, orders
// awaiting signature, my IDG action items, my unsigned notes), the patients those items point at,
// census and A/R aging, HOPE assessments due, and a right column with alerts, today's visits and
// quick links. A source the actor lacks the permission for is never called. WardenX keeps no
// history snapshots for "vs last week" trends or a daily census/revenue series, and no "recently
// viewed" patient list, so the cards show current detail instead and the patient panel lists the
// patients the open work refers to.
import { EmptyState, Glyph, type GlyphName, Panel, t, useApiClient } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import type { JSX, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { canSeeScreen } from "./actor-session";
import type { WebScreenDescriptor } from "./screen-registry";
import { useSession } from "./session";
import type { Session } from "./session";

type Tone = "neutral" | "healthy" | "info" | "warning" | "critical";
type Severity = "critical" | "warning" | "info";
type TaskCategory = "assessments" | "orders" | "followups" | "other";

interface DashboardKpi {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly href?: string;
  readonly tone: Tone;
  readonly icon: GlyphName;
  /** Lower sorts first; the five lowest the actor can see fill the card row. */
  readonly rank: number;
}

interface AttentionItem {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly description?: string;
  readonly severity: Severity;
  readonly href?: string;
  readonly module: string;
}

interface TaskItem {
  readonly id: string;
  readonly category: TaskCategory;
  readonly title: string;
  readonly patientId?: string | null;
  readonly fallbackSubject?: string;
  readonly dueAt?: string | null;
  readonly href: string;
}

interface DueAssessment {
  readonly id: string;
  readonly patientId: string;
  readonly type: string;
  readonly dueAt: string;
  readonly href: string;
}

interface UpcomingVisit {
  readonly id: string;
  readonly patientId: string;
  readonly purpose: string;
  readonly startAt: string;
  readonly href: string;
}

interface CensusFigures {
  readonly active?: number;
  readonly byStatus?: Record<string, number>;
  readonly aging?: { label: string; cents: number }[];
}

interface Contribution {
  readonly kpis?: readonly DashboardKpi[];
  readonly attention?: readonly AttentionItem[];
  readonly tasks?: readonly TaskItem[];
  readonly assessments?: readonly DueAssessment[];
  readonly visits?: readonly UpcomingVisit[];
  readonly census?: CensusFigures;
  /** Sources the server scoped out for this actor (not failures). */
  readonly unavailable?: readonly string[];
}

interface WidgetSource {
  readonly id: string;
  /** The actor needs any one of these keys. */
  readonly permission: string | readonly string[];
  readonly load: (client: ApiClient) => Promise<Contribution>;
}

interface PatientRef {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly dob: string;
  readonly status: string;
}

interface DashboardState {
  readonly kpis: DashboardKpi[];
  readonly attention: AttentionItem[];
  readonly tasks: TaskItem[];
  readonly assessments: DueAssessment[];
  readonly visits: UpcomingVisit[];
  readonly census: CensusFigures;
  readonly unavailable: string[];
  readonly failed: string[];
}

const EMPTY_STATE: DashboardState = {
  kpis: [],
  attention: [],
  tasks: [],
  assessments: [],
  visits: [],
  census: {},
  unavailable: [],
  failed: [],
};

const DAY = 86_400_000;
const SKELETON_KEYS = ["a", "b", "c", "d", "e"];

const toneColor: Record<Tone, string> = {
  neutral: t.primary,
  healthy: t.success,
  info: t.primary,
  warning: t.warning,
  critical: t.error,
};

const toneTint = (color: string, pct = 12): string =>
  `color-mix(in srgb, ${color} ${pct}%, ${t.surfaceLowest})`;

function hasPermission(session: Session | null, permission: string | readonly string[]): boolean {
  const keys = typeof permission === "string" ? [permission] : permission;
  return keys.some((k) => session?.permissions?.includes(k) ?? false);
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

function startOfDay(offsetDays = 0): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

/** Calendar days from today to `iso` (negative = past). Date-only strings are local calendar dates. */
function daysUntil(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
  d.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - startOfDay().getTime()) / DAY);
}

function dueLabel(iso?: string | null): { text: string; tone: Tone } {
  if (!iso) return { text: "No due date", tone: "neutral" };
  const n = daysUntil(iso);
  if (n < 0) return { text: "Overdue", tone: "critical" };
  if (n === 0) return { text: "Due today", tone: "critical" };
  if (n === 1) return { text: "Tomorrow", tone: "warning" };
  return { text: `In ${n} days`, tone: n <= 2 ? "warning" : "info" };
}

function usDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function ageOf(dob: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (!m) return null;
  const now = new Date();
  let age = now.getFullYear() - Number(m[1]);
  if (
    now.getMonth() + 1 < Number(m[2]) ||
    (now.getMonth() + 1 === Number(m[2]) && now.getDate() < Number(m[3]))
  ) {
    age -= 1;
  }
  return age;
}

function initials(name: string): string {
  const parts = name.split(/[\s,._@-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

const AVATAR_TINTS = [
  "var(--color-viz-blue)",
  "var(--color-viz-green)",
  "var(--color-viz-violet)",
  "var(--color-viz-amber)",
  "var(--color-viz-teal)",
  "var(--color-viz-pink)",
];
function tintFor(key: string): string {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_TINTS[h % AVATAR_TINTS.length]!;
}

const HOPE_KIND: Record<string, string> = {
  "01_admission": "HOPE Admission",
  "02_huv1": "HOPE Update Visit 1",
  "03_huv2": "HOPE Update Visit 2",
  "04_sfv": "Symptom Follow-up",
  "05_discharge": "HOPE Discharge",
};

const VISIT_PURPOSE: Record<string, string> = {
  routine_visit: "Routine visit",
  prn: "PRN visit",
  aide_poc: "Aide visit",
  msw_assessment: "Social work assessment",
  msw_followup: "Social work",
  chaplain_visit: "Chaplain visit",
  chaplain_assessment: "Spiritual assessment",
  volunteer_visit: "Volunteer visit",
  f2f: "Face-to-face",
  recert: "Recertification visit",
  loc_change: "Level-of-care change",
  pronouncement: "Pronouncement",
  admission_visit: "Admission visit",
  discharge_visit: "Discharge visit",
};

const CLAIM_SETTLED = /paid|denied|void|cancel|reject|written_off|closed/i;
const CLAIM_REVIEW = /reject|denied|failed|partial/i;

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
            label: "Active Patients",
            value: String(active),
            detail: `${data.total ?? 0} total records`,
            href: "/patients",
            tone: "info",
            icon: "users",
            rank: 1,
          },
        ],
        census: { active, byStatus: data.byStatus ?? {} },
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
      return {
        kpis: [
          {
            id: "referrals-open",
            label: "Referrals",
            value: String(received + triaged),
            detail: `${received} awaiting triage`,
            href: "/referrals",
            tone: received > 0 ? "warning" : "healthy",
            icon: "user-plus",
            rank: 6,
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
            label: "Pending Admissions",
            value: String(pending),
            detail: `${active} active`,
            href: "/admissions",
            tone: pending > 0 ? "warning" : "healthy",
            icon: "file-text",
            rank: 2,
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
      };
    },
  },
  {
    id: "hope",
    permission: "hope.timepoint.read",
    async load(client) {
      const res = await client.GET("/api/v1/hope/schedules", {
        params: { query: { status: "open" } },
      });
      // The hope.scope ABAC answers an out-of-scope org-wide list with 404 (deny-as-not-found):
      // the actor simply has no HOPE worklist here, which is not a load failure.
      if (res.response.status === 404) return { unavailable: ["hope"] };
      if (res.error) throw res.error;
      const open = [...(res.data?.schedules ?? [])].sort((a, b) =>
        a.windowClosesAt.localeCompare(b.windowClosesAt),
      );
      const overdue = countBy(open, (s) => daysUntil(s.windowClosesAt) < 0);
      const href = (s: { admissionId: string }) => `/admissions/${s.admissionId}/hope`;
      return {
        kpis: [
          {
            id: "hope-due",
            label: "Assessments Due",
            value: String(open.length),
            detail: overdue > 0 ? `${overdue} past window` : "HOPE windows open",
            href: "/hope",
            tone: overdue > 0 ? "critical" : "info",
            icon: "clipboard-check",
            rank: 3,
          },
        ],
        attention:
          overdue > 0
            ? [
                {
                  id: "hope-overdue",
                  type: "HIGH",
                  title: `${overdue} HOPE assessment${overdue === 1 ? "" : "s"} past window`,
                  description: "HOPE compliance",
                  severity: "critical",
                  href: "/hope",
                  module: "HOPE",
                },
              ]
            : [],
        tasks: open.slice(0, 10).map((s) => ({
          id: `hope-${s.id}`,
          category: "assessments" as const,
          title: `Complete ${HOPE_KIND[s.rfaKind] ?? "HOPE assessment"}`,
          patientId: s.patientId,
          dueAt: s.windowClosesAt,
          href: href(s),
        })),
        assessments: open.slice(0, 6).map((s) => ({
          id: s.id,
          patientId: s.patientId,
          type: HOPE_KIND[s.rfaKind] ?? "HOPE",
          dueAt: s.windowClosesAt,
          href: href(s),
        })),
      };
    },
  },
  {
    id: "idg",
    permission: "idg.read",
    async load(client) {
      const [locs, mine] = await Promise.all([
        client.GET("/api/v1/locations", { params: { query: {} } }),
        client.GET("/api/v1/idg/action-items", { params: { query: { assignee: "me" } } }),
      ]);
      const from = startOfDay().toISOString();
      const to = startOfDay(1).toISOString();
      const sites = (locs.data?.items ?? []).slice(0, 5);
      const lists = await Promise.all(
        sites.map((l) =>
          client
            .GET("/api/v1/idg/schedule", { params: { query: { location: l.id, from, to } } })
            .then((r) => r.data ?? [])
            .catch(() => []),
        ),
      );
      const today = lists
        .flat()
        .filter((m) => m.status !== "cancelled" && m.status !== "rescheduled");
      const next = [...today].sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart))[0];
      const items = (mine.data ?? []).filter(
        (a) => a.status === "open" || a.status === "in_progress",
      );
      return {
        kpis: locs.error
          ? []
          : [
              {
                id: "idg-today",
                label: "IDG Meetings",
                value: String(today.length),
                detail: next ? `Today · first at ${timeOf(next.scheduledStart)}` : "Today",
                href: "/idg/schedule",
                tone: "info",
                icon: "users",
                rank: 4,
              },
            ],
        tasks: items.slice(0, 10).map((a) => ({
          id: `idg-${a.id}`,
          category: "followups" as const,
          title: a.linkedArtifactKind
            ? `IDG follow-up: ${stateLabel(a.linkedArtifactKind).toLowerCase()}`
            : "IDG follow-up",
          patientId: a.patientId,
          fallbackSubject: "IDG action item",
          dueAt: a.dueDate,
          href: "/idg/action-items",
        })),
      };
    },
  },
  {
    id: "orders",
    permission: "orders.read",
    async load(client) {
      const res = await client.GET("/api/v1/orders", {
        params: { query: { status: "pending_signature" } },
      });
      if (res.error) throw res.error;
      const orders = res.data?.orders ?? [];
      return {
        tasks: orders.slice(0, 10).map((o) => ({
          id: `order-${o.id}`,
          category: "orders" as const,
          title: `Sign ${o.kind === "dme" ? "DME" : stateLabel(o.kind).toLowerCase()} order`,
          patientId: o.patientId,
          dueAt: o.verbalDeadlineAt,
          href: `/orders/${o.id}`,
        })),
      };
    },
  },
  {
    id: "notes",
    permission: "encounter.read",
    async load(client) {
      const res = await client.GET("/api/v1/encounters/my-drafts");
      if (res.error) throw res.error;
      return {
        tasks: (res.data?.encounters ?? []).slice(0, 10).map((e) => ({
          id: `note-${e.id}`,
          category: "other" as const,
          title: `Finish ${stateLabel(e.encounterType).toLowerCase()} note`,
          patientId: e.patientId,
          dueAt: null,
          href: `/patients/${e.patientId}/encounters/${e.id}`,
        })),
      };
    },
  },
  {
    id: "visits",
    permission: ["visit.read_team", "visit.read"],
    async load(client) {
      const res = await client.GET("/api/v1/visits", {
        params: { query: { from: new Date().toISOString(), to: startOfDay(1).toISOString() } },
      });
      if (res.error) throw res.error;
      const visits = [...(res.data ?? [])]
        .filter((v) => !/cancel|missed|no_show|completed/.test(v.status))
        .sort((a, b) => a.scheduledStartedAt.localeCompare(b.scheduledStartedAt));
      return {
        visits: visits.slice(0, 6).map((v) => ({
          id: v.id,
          patientId: v.patientId,
          purpose: VISIT_PURPOSE[v.visitPurpose] ?? stateLabel(v.visitPurpose),
          startAt: v.scheduledStartedAt,
          href: `/scheduling/visits/${v.id}`,
        })),
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
          overdueState: string;
          activeSosAlert: { id?: string } | null;
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
            label: "Field Safety",
            value: String(activeSos + overdue),
            detail: activeSos > 0 ? `${activeSos} SOS active` : `${overdue} overdue check-ins`,
            href: "/safety",
            tone: activeSos > 0 ? "critical" : overdue > 0 ? "warning" : "healthy",
            icon: "shield",
            rank: 7,
          },
        ],
        attention,
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
      const items = pageItems<{ id: string; state: string; severity: string }>(res.data);
      const open = countBy(
        items,
        (x) => !["resolved", "closed_followup_complete"].includes(x.state),
      );
      const critical = countBy(items, (x) => x.severity === "critical" || x.severity === "severe");
      return {
        kpis: [
          {
            id: "quality-open-incidents",
            label: "Quality Incidents",
            value: String(open),
            detail: `${critical} severe or critical`,
            href: "/quality/qapi",
            tone: critical > 0 ? "critical" : open > 0 ? "warning" : "healthy",
            icon: "alert",
            rank: 8,
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
    id: "billing",
    permission: "billing.claim.read_ar_dashboard",
    async load(client) {
      const [agingRes, metricsRes] = await Promise.all([
        client.GET("/api/v1/billing/ar-dashboard"),
        client.GET("/api/v1/billing/metrics"),
      ]);
      if (agingRes.error) throw agingRes.error;
      const aging = agingRes.data;
      const buckets = metricsRes.data?.buckets ?? [];
      const pending = buckets
        .filter((x) => !CLAIM_SETTLED.test(x.key))
        .reduce((sum, x) => sum + x.count, 0);
      const review = buckets
        .filter((x) => CLAIM_REVIEW.test(x.key))
        .reduce((sum, x) => sum + x.count, 0);
      return {
        kpis: metricsRes.error
          ? []
          : [
              {
                id: "claims-pending",
                label: "Claims Pending",
                value: String(pending),
                detail: review > 0 ? `${review} need billing review` : "Not yet paid or denied",
                href: "/billing/claims",
                tone: review > 0 ? "warning" : "info",
                icon: "receipt",
                rank: 5,
              },
            ],
        attention:
          review > 0
            ? [
                {
                  id: "billing-failed-claims",
                  type: "DUE",
                  title: `${review} claim${review === 1 ? "" : "s"} need billing review`,
                  description: "Claim workbench",
                  severity: "warning",
                  href: "/billing/claims",
                  module: "Billing",
                },
              ]
            : [],
        census: aging
          ? {
              aging: [
                { label: "0–30", cents: aging.bucket0to30Cents },
                { label: "31–60", cents: aging.bucket31to60Cents },
                { label: "61–90", cents: aging.bucket61to90Cents },
                { label: "90+", cents: aging.bucket90PlusCents },
              ],
            }
          : {},
      };
    },
  },
];

function mergeContributions(
  results: readonly Contribution[],
  failed: readonly string[],
): DashboardState {
  const all = <K extends keyof Contribution>(k: K) =>
    results.flatMap((x) => [...((x[k] as readonly unknown[] | undefined) ?? [])]);
  return {
    kpis: (all("kpis") as DashboardKpi[]).sort((a, b) => a.rank - b.rank).slice(0, 5),
    attention: (all("attention") as AttentionItem[])
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
      .slice(0, 6),
    tasks: (all("tasks") as TaskItem[]).sort(
      (a, b) =>
        (a.dueAt ? Date.parse(a.dueAt) : Number.MAX_SAFE_INTEGER) -
        (b.dueAt ? Date.parse(b.dueAt) : Number.MAX_SAFE_INTEGER),
    ),
    assessments: all("assessments") as DueAssessment[],
    visits: all("visits") as UpcomingVisit[],
    census: Object.assign({}, ...results.map((x) => x.census ?? {})) as CensusFigures,
    unavailable: all("unavailable") as string[],
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
    "admission.create",
    "hope.dashboard",
    "orders.sign-inbox",
    "idg.schedule",
    "documents.explorer",
    "reporting.catalog",
    "admission.referrals",
    "safety.dashboard",
    "quality.qapi-incidents",
    "admission.census",
    "patient.census",
    "billing.claims",
    "identity.staff-management",
    "audit.log",
  ];
  return visible
    .filter((s) => preferred.includes(s.id))
    .sort((a, b) => preferred.indexOf(a.id) - preferred.indexOf(b.id))
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

const QUICK_ICON: Record<string, GlyphName> = {
  "admission.create": "plus",
  "hope.dashboard": "clipboard-check",
  "orders.sign-inbox": "file-check",
  "idg.schedule": "users",
  "documents.explorer": "upload",
  "reporting.catalog": "bar-chart",
  "admission.referrals": "user-plus",
  "safety.dashboard": "shield",
  "quality.qapi-incidents": "alert",
  "billing.claims": "receipt",
  "identity.staff-management": "users",
  "audit.log": "file-text",
};

const TASK_CHIPS: { key: TaskCategory | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "assessments", label: "Assessments" },
  { key: "orders", label: "Orders" },
  { key: "followups", label: "Follow-ups" },
  { key: "other", label: "Notes" },
];

export function RoleHome({ screens }: { screens: WebScreenDescriptor[] }): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const [state, setState] = useState<DashboardState>(EMPTY_STATE);
  const [patients, setPatients] = useState<Map<string, PatientRef>>(new Map());
  const [loading, setLoading] = useState(true);
  const [taskChip, setTaskChip] = useState<TaskCategory | "all">("all");
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
      const merged = mergeContributions(good, failed);
      setState(merged);
      setLoading(false);
      // Names for the patients the tasks, visits and assessments point at.
      const referenced =
        merged.tasks.some((x) => x.patientId) ||
        merged.visits.length > 0 ||
        merged.assessments.length > 0;
      if (referenced && hasPermission(session, "patient.read")) {
        try {
          const res = await client.GET("/api/v1/patients", { params: { query: { limit: 200 } } });
          if (!active) return;
          setPatients(new Map(pageItems<PatientRef>(res.data).map((p) => [p.id, p])));
        } catch {
          // Names are context; the rows still render with a neutral subject.
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [client, session]);

  const nameOf = (id?: string | null): string | null => {
    const p = id ? patients.get(id) : undefined;
    return p ? `${p.firstName} ${p.lastName}` : null;
  };

  const taskCounts = useMemo(() => {
    const c: Record<string, number> = { all: state.tasks.length };
    for (const x of state.tasks) c[x.category] = (c[x.category] ?? 0) + 1;
    return c;
  }, [state.tasks]);
  const tasks = state.tasks.filter((x) => taskChip === "all" || x.category === taskChip);

  // The patients open work points at, most urgent first (tasks are already sorted by due date).
  const watch = useMemo(() => {
    const seen = new Map<string, { reason: string; tone: Tone; when: string }>();
    for (const v of state.visits) {
      if (!seen.has(v.patientId)) {
        seen.set(v.patientId, { reason: v.purpose, tone: "info", when: timeOf(v.startAt) });
      }
    }
    for (const x of state.tasks) {
      if (x.patientId && !seen.has(x.patientId)) {
        const due = dueLabel(x.dueAt);
        seen.set(x.patientId, {
          reason: x.title.replace(/^(Complete|Sign|Finish) /, ""),
          tone: due.tone,
          when: x.dueAt ? due.text : "",
        });
      }
    }
    return [...seen.entries()].slice(0, 5);
  }, [state.visits, state.tasks]);

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="wx-home">
      <div className="wx-home-main">
        <header className="wx-page-head">
          <div>
            <h1 style={{ fontSize: "1.875rem" }}>
              {session ? `${greeting()}, ${firstName(session)}` : "Welcome to WardenX"}
            </h1>
            <p>Here's what's happening with your hospice today.</p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <span style={{ color: t.onSurfaceVariant, fontSize: "0.875rem" }}>{today}</span>
            {action ? (
              <Link to={action.path} className="wx-btn-primary">
                <Glyph name="plus" size={16} />
                <span>{action.title}</span>
              </Link>
            ) : null}
          </div>
        </header>

        <section aria-label="Summary" className="wx-home-kpis">
          {loading && state.kpis.length === 0
            ? SKELETON_KEYS.map((k) => <KpiSkeleton key={k} />)
            : state.kpis.map((kpi) => <Kpi key={kpi.id} kpi={kpi} />)}
        </section>

        {state.failed.length > 0 ? (
          <output className="wx-home-degraded">
            Some dashboard sections could not be loaded: {state.failed.join(", ")}.
          </output>
        ) : null}

        <div className="wx-home-row">
          <Card title="My Tasks" icon="clipboard-list">
            <fieldset className="wx-seg wx-seg-compact" style={{ alignSelf: "start" }}>
              <legend className="wx-sr-only">Task type</legend>
              {TASK_CHIPS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={taskChip === c.key}
                  className={taskChip === c.key ? "is-selected" : undefined}
                  onClick={() => setTaskChip(c.key)}
                >
                  {c.label}
                  <span className="wx-seg-count wx-nums">{taskCounts[c.key] ?? 0}</span>
                </button>
              ))}
            </fieldset>
            {loading ? (
              <ListSkeleton rows={4} />
            ) : tasks.length === 0 ? (
              <p className="wx-row-sub">No open tasks in this view.</p>
            ) : (
              <ul className="wx-home-list">
                {tasks.slice(0, 5).map((x) => {
                  const due = dueLabel(x.dueAt);
                  return (
                    <li key={x.id}>
                      <Link to={x.href}>
                        <span
                          className="wx-task-ring"
                          aria-hidden
                          style={{ borderColor: toneColor[due.tone] }}
                        />
                        <span className="wx-home-list-main">
                          <strong>{x.title}</strong>
                          <span className="wx-row-sub">
                            {nameOf(x.patientId) ?? x.fallbackSubject ?? "Patient"}
                          </span>
                        </span>
                        {x.dueAt ? (
                          <span
                            style={{
                              color: due.tone === "critical" ? t.error : t.onSurfaceVariant,
                              fontSize: "0.8125rem",
                            }}
                          >
                            {due.text}
                          </span>
                        ) : null}
                        <Glyph name="chevron-right" size={16} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card title="Patients Needing Attention" icon="user-circle" viewAll="/patients">
            {loading ? (
              <ListSkeleton rows={4} />
            ) : watch.length === 0 ? (
              <p className="wx-row-sub">No open work points at a patient right now.</p>
            ) : (
              <ul className="wx-home-list">
                {watch.map(([id, w]) => {
                  const p = patients.get(id);
                  const name = p ? `${p.firstName} ${p.lastName}` : "Patient";
                  const age = p ? ageOf(p.dob) : null;
                  return (
                    <li key={id}>
                      <Link to={`/patients/${id}`}>
                        <Avatar name={name} />
                        <span className="wx-home-list-main">
                          <strong>{name}</strong>
                          <span className="wx-row-sub">
                            {p ? `DOB ${usDate(p.dob)}${age != null ? ` (${age}y)` : ""}` : "—"}
                          </span>
                        </span>
                        <span
                          className="wx-home-pill"
                          style={{
                            color: toneColor[w.tone],
                            background: toneTint(toneColor[w.tone]),
                          }}
                        >
                          {w.reason}
                        </span>
                        <span
                          className="wx-row-sub"
                          style={{ minWidth: "4.5rem", textAlign: "right" }}
                        >
                          {w.when}
                        </span>
                        <Glyph name="chevron-right" size={16} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        <div className="wx-home-row">
          <CensusCard census={state.census} loading={loading} />
          <Card title="Assessments Due" icon="clipboard-check" viewAll="/hope">
            {loading ? (
              <ListSkeleton rows={4} />
            ) : !hasPermission(session, "hope.timepoint.read") ||
              state.unavailable.includes("hope") ? (
              <p className="wx-row-sub">
                The HOPE worklist is not available for your access scope.
              </p>
            ) : state.assessments.length === 0 ? (
              <p className="wx-row-sub">No HOPE assessment windows are open.</p>
            ) : (
              <table className="wx-mini-table">
                <thead>
                  <tr>
                    <th scope="col">Patient</th>
                    <th scope="col">Type</th>
                    <th scope="col">Target Date</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {state.assessments.map((a) => {
                    const n = daysUntil(a.dueAt);
                    const status =
                      n < 0
                        ? { label: "Overdue", tone: "critical" as Tone }
                        : n <= 2
                          ? { label: "Due soon", tone: "warning" as Tone }
                          : { label: "Pending", tone: "neutral" as Tone };
                    const color =
                      status.tone === "neutral" ? t.onSurfaceVariant : toneColor[status.tone];
                    return (
                      <tr key={a.id}>
                        <td>
                          <Link to={a.href} style={{ color: t.onSurface, fontWeight: 600 }}>
                            {nameOf(a.patientId) ?? "Patient"}
                          </Link>
                        </td>
                        <td>{stateLabel(a.type)}</td>
                        <td className="wx-nums">{usDate(a.dueAt)}</td>
                        <td>
                          <span
                            className="wx-home-pill"
                            style={{ color, background: toneTint(color) }}
                          >
                            {status.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>

      <aside className="wx-home-rail" aria-label="Today">
        <Panel
          title="Critical Alerts"
          icon="alert"
          tone={state.attention.some((x) => x.severity === "critical") ? "danger" : "default"}
        >
          {loading && state.attention.length === 0 ? (
            <ListSkeleton rows={2} />
          ) : state.attention.length > 0 ? (
            <ul className="wx-alert-list">
              {state.attention.map((item) => (
                <li key={item.id}>
                  <Link to={item.href ?? "/"}>
                    <span
                      className="wx-alert-badge"
                      aria-hidden
                      style={{
                        color: item.severity === "critical" ? t.error : t.warning,
                        background: toneTint(
                          item.severity === "critical" ? t.error : t.warning,
                          16,
                        ),
                      }}
                    >
                      <Glyph
                        name={item.severity === "critical" ? "alert-circle" : "clock"}
                        size={16}
                      />
                    </span>
                    <span className="wx-home-list-main">
                      <strong
                        style={{ color: item.severity === "critical" ? t.error : t.onSurface }}
                      >
                        {item.title}
                      </strong>
                      <span className="wx-row-sub">
                        {item.module}
                        {item.description ? ` · ${item.description}` : ""}
                      </span>
                    </span>
                    <Glyph name="chevron-right" size={16} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <HealthyState />
          )}
        </Panel>

        <Panel
          title="Upcoming Visits"
          icon="calendar"
          action={
            <Link to="/calendar" style={{ fontWeight: 500 }}>
              View all
            </Link>
          }
        >
          {loading && state.visits.length === 0 ? (
            <ListSkeleton rows={3} />
          ) : state.visits.length === 0 ? (
            <p style={{ margin: 0, color: t.onSurfaceVariant, fontSize: "0.8125rem" }}>
              No more visits scheduled today.
            </p>
          ) : (
            <ul className="wx-home-list wx-home-visits">
              {state.visits.map((v) => {
                const name = nameOf(v.patientId) ?? "Patient";
                return (
                  <li key={v.id}>
                    <Link to={v.href}>
                      <span className="wx-nums wx-home-visit-time">{timeOf(v.startAt)}</span>
                      <Avatar name={name} />
                      <span className="wx-home-list-main">
                        <strong>{name}</strong>
                        <span className="wx-row-sub">{v.purpose}</span>
                      </span>
                      <Glyph name="chevron-right" size={16} />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Quick Links" icon="link" flush>
          {quickAccess.length > 0 ? (
            <ul className="wx-rail-links">
              {quickAccess.map((s) => (
                <li key={s.id}>
                  <Link to={s.path}>
                    <span style={{ color: t.primary }}>
                      <Glyph
                        name={QUICK_ICON[s.id] ?? "arrow-right"}
                        size={17}
                        strokeWidth={1.75}
                      />
                    </span>
                    <span style={{ flex: 1 }}>{s.title}</span>
                    <Glyph name="chevron-right" size={16} strokeWidth={1.75} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p
              style={{
                margin: 0,
                padding: "0 1rem 1rem",
                color: t.onSurfaceVariant,
                fontSize: "0.8125rem",
              }}
            >
              No shortcuts are available for your current permissions.
            </p>
          )}
        </Panel>
      </aside>
    </div>
  );
}

function Kpi({ kpi }: { kpi: DashboardKpi }): JSX.Element {
  const color = toneColor[kpi.tone];
  const content = (
    <>
      <span className="wx-home-kpi-head">
        <span
          className="wx-home-kpi-icon"
          aria-hidden
          style={{ color: t.primary, background: toneTint(t.primary) }}
        >
          <Glyph name={kpi.icon} size={20} strokeWidth={1.75} />
        </span>
        <span>{kpi.label}</span>
      </span>
      <strong className="wx-nums wx-home-kpi-value">{kpi.value}</strong>
      {kpi.detail ? (
        <span
          className="wx-home-kpi-detail"
          style={{ color: kpi.tone === "critical" ? color : undefined }}
        >
          {kpi.detail}
        </span>
      ) : null}
    </>
  );
  return kpi.href ? (
    <Link to={kpi.href} className="wx-home-kpi">
      {content}
    </Link>
  ) : (
    <div className="wx-home-kpi">{content}</div>
  );
}

function Card({
  title,
  icon,
  viewAll,
  children,
}: {
  title: string;
  icon: GlyphName;
  viewAll?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="wx-foot-card" aria-label={title}>
      <header style={{ alignItems: "center" }}>
        <span style={{ color: t.primary, display: "flex" }}>
          <Glyph name={icon} size={20} strokeWidth={1.75} />
        </span>
        <h2 style={{ flex: 1 }}>{title}</h2>
        {viewAll ? (
          <Link to={viewAll} style={{ fontWeight: 500, fontSize: "0.875rem" }}>
            View all →
          </Link>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function CensusCard({ census, loading }: { census: CensusFigures; loading: boolean }): JSX.Element {
  const aging = census.aging ?? [];
  const total = aging.reduce((s, b) => s + b.cents, 0);
  const old = aging.find((b) => b.label === "90+")?.cents ?? 0;
  const statuses = Object.entries(census.byStatus ?? {}).filter(([, n]) => n > 0);
  const max = Math.max(1, ...aging.map((b) => b.cents));
  const statusMax = Math.max(1, ...statuses.map(([, n]) => n));
  const hasAny = census.active !== undefined || aging.length > 0;
  return (
    <Card title="Census & Receivables" icon="bar-chart">
      {loading ? (
        <ListSkeleton rows={3} />
      ) : !hasAny ? (
        <EmptyState
          title="No census or A/R data"
          description="Census and receivables appear for roles with patient or billing access."
        />
      ) : (
        <>
          <div className="wx-home-figures">
            {census.active !== undefined ? (
              <div>
                <span>Active census</span>
                <strong className="wx-nums">{census.active}</strong>
              </div>
            ) : null}
            {aging.length > 0 ? (
              <>
                <div>
                  <span>Open A/R</span>
                  <strong className="wx-nums">{formatMoney(total)}</strong>
                </div>
                <div>
                  <span>Over 90 days</span>
                  <strong className="wx-nums" style={{ color: old > 0 ? t.warning : undefined }}>
                    {formatMoney(old)}
                  </strong>
                </div>
              </>
            ) : null}
          </div>
          <div className="wx-home-charts">
            {aging.length > 0 && total === 0 ? (
              <p className="wx-row-sub" style={{ margin: 0 }}>
                No open claims in accounts receivable.
              </p>
            ) : null}
            {aging.length > 0 && total > 0 ? (
              <figure>
                <figcaption>A/R aging (days)</figcaption>
                <div className="wx-bars">
                  {aging.map((b) => (
                    <div key={b.label} title={`${b.label} days: ${formatMoney(b.cents)}`}>
                      <span className="wx-bar-value wx-nums">{formatMoney(b.cents)}</span>
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
            ) : null}
            {statuses.length > 0 ? (
              <figure>
                <figcaption>Patients by status</figcaption>
                <ul className="wx-hbars">
                  {statuses.map(([status, n]) => (
                    <li key={status}>
                      <span>{stateLabel(status)}</span>
                      <span className="wx-hbar-track">
                        <span style={{ width: `${(n / statusMax) * 100}%` }} />
                      </span>
                      <strong className="wx-nums">{n}</strong>
                    </li>
                  ))}
                </ul>
              </figure>
            ) : null}
          </div>
        </>
      )}
    </Card>
  );
}

function Avatar({ name }: { name: string }): JSX.Element {
  const c = tintFor(name);
  return (
    <span
      className="wx-home-avatar"
      aria-hidden
      style={{
        color: `color-mix(in srgb, ${c} 60%, var(--color-on-surface))`,
        background: toneTint(c, 14),
      }}
    >
      {initials(name)}
    </span>
  );
}

function HealthyState(): JSX.Element {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
      <span
        className="wx-alert-badge"
        style={{ color: t.success, background: toneTint(t.success, 16) }}
      >
        <Glyph name="check" size={16} />
      </span>
      <div>
        <div style={{ fontWeight: 700, color: t.onSurface, fontSize: "0.875rem" }}>
          You're all caught up
        </div>
        <div className="wx-row-sub">No urgent items require your attention.</div>
      </div>
    </div>
  );
}

function KpiSkeleton(): JSX.Element {
  return (
    <div className="wx-home-kpi" aria-hidden>
      <span className="wx-skeleton" style={{ width: "60%" }} />
      <span className="wx-skeleton" style={{ width: "35%", height: "1.9rem" }} />
      <span className="wx-skeleton" style={{ width: "70%" }} />
    </div>
  );
}

function ListSkeleton({ rows }: { rows: number }): JSX.Element {
  return (
    <div style={{ display: "grid", gap: "0.75rem" }} aria-hidden>
      {SKELETON_KEYS.slice(0, rows).map((k) => (
        <div key={k} style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <span className="wx-skeleton" style={{ width: "2.25rem", height: "2.25rem" }} />
          <span className="wx-skeleton" style={{ flex: 1 }} />
          <span className="wx-skeleton" style={{ width: "4rem" }} />
        </div>
      ))}
    </div>
  );
}
