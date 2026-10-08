// apps/admin/src/shell — the Platform-Ops console's sidebar, grouped like the clinical app's (apps/web
// primary-nav.ts). Keyed by registered screen ID, so the shell still imports no module slice: a screen that is
// registered but not placed here falls into "More" instead of vanishing, and a placed ID that is not registered is
// skipped. Parameterised screens (`:id`) and actions (New refund) are reached from their list, not the sidebar.
import type { GlyphName } from "@wardenx/ui";
import type { AdminScreenDescriptor } from "./registry";

export interface AdminNavEntry {
  key: string;
  label: string;
  to: string;
  icon: GlyphName;
}

export interface AdminNavSection {
  label: string | null;
  entries: AdminNavEntry[];
}

interface Placement {
  id: string;
  icon: GlyphName;
}

const SECTIONS: readonly { label: string; screens: readonly Placement[] }[] = [
  {
    label: "Tenants",
    screens: [
      { id: "saas.tenants", icon: "building" },
      { id: "saas.signups", icon: "user-plus" },
      { id: "saas.onboarding-templates", icon: "clipboard-list" },
      { id: "saas.feature-flags", icon: "zap" },
      { id: "saas.support-sessions", icon: "message-square" },
    ],
  },
  {
    label: "Compliance",
    screens: [
      { id: "saas.baa-register", icon: "file-check" },
      { id: "saas.dsar-queue", icon: "download" },
      { id: "saas.tenant-export-queue", icon: "package" },
      { id: "saas.key-rings", icon: "lock" },
    ],
  },
  {
    label: "Subscription billing",
    screens: [
      { id: "admin.plans", icon: "layout-grid" },
      { id: "admin.promos", icon: "target" },
      { id: "admin.subscriptions", icon: "receipt" },
      { id: "admin.refunds", icon: "rotate-ccw" },
      { id: "admin.dunning", icon: "alert-circle" },
      { id: "admin.revenue", icon: "trending-up" },
      { id: "admin.webhooks", icon: "link" },
    ],
  },
  {
    label: "Medicare billing",
    screens: [{ id: "admin.billing.wage-index-load", icon: "upload" }],
  },
  {
    label: "AI safety",
    screens: [
      { id: "admin.ai-capabilities", icon: "cpu" },
      { id: "admin.ai-kill-switches", icon: "block" },
      { id: "admin.ai-invocations", icon: "activity" },
      { id: "admin.ai-hallucinations", icon: "alert" },
      { id: "admin.ai-tokens", icon: "bar-chart" },
      { id: "admin.ai-evaluations", icon: "clipboard-check" },
      { id: "admin.ai-drift", icon: "trending-up" },
    ],
  },
  {
    label: "Operations",
    screens: [{ id: "admin.ops.outbox", icon: "send" }],
  },
];

/** Screens that are actions reached from a list, never a sidebar row. */
const NOT_IN_NAV: ReadonlySet<string> = new Set(["admin.refund-new"]);

const OVERVIEW: AdminNavEntry = { key: "overview", label: "Overview", to: "/", icon: "home" };

/** The sidebar for the registered chromed screens: Overview, the placed sections, then anything unplaced. */
export function buildAdminNav(screens: readonly AdminScreenDescriptor[]): AdminNavSection[] {
  const listable = screens.filter(
    (s) => s.chrome !== false && !s.path.includes(":") && !NOT_IN_NAV.has(s.id),
  );
  const byId = new Map(listable.map((s) => [s.id, s]));
  const placed = new Set<string>();
  const sections: AdminNavSection[] = [{ label: null, entries: [OVERVIEW] }];
  for (const section of SECTIONS) {
    const entries = section.screens.flatMap((p) => {
      const s = byId.get(p.id);
      if (!s) return [];
      placed.add(s.id);
      return [{ key: s.id, label: s.title, to: s.path, icon: p.icon }];
    });
    if (entries.length > 0) sections.push({ label: section.label, entries });
  }
  const rest = listable
    .filter((s) => !placed.has(s.id))
    .map((s) => ({ key: s.id, label: s.title, to: s.path, icon: "grid-circles" as GlyphName }));
  if (rest.length > 0) sections.push({ label: "More", entries: rest });
  return sections;
}

/** The entry the current path belongs to: an exact match, else the longest path prefix (a detail screen). */
export function activeAdminEntry(
  sections: readonly AdminNavSection[],
  pathname: string,
): string | undefined {
  let best: AdminNavEntry | undefined;
  for (const entry of sections.flatMap((s) => s.entries)) {
    const hit =
      entry.to === "/"
        ? pathname === "/"
        : pathname === entry.to || pathname.startsWith(`${entry.to}/`);
    if (hit && (!best || entry.to.length > best.to.length)) best = entry;
  }
  return best?.key;
}
