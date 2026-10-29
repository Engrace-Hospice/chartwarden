import type { NavEntry, NavScreen, NavSection } from "./primary-nav";
import { activeEntryKey } from "./primary-nav";

export const MODULE_NAVIGATION_KEYS = [
  "admissions",
  "assessments",
  "care-plans",
  "orders",
  "medications",
  "reports",
  "administration",
  "organization",
  "integrations",
  "scheduling",
] as const;

export type ModuleNavigationKey = (typeof MODULE_NAVIGATION_KEYS)[number];

export interface ModuleNavigationItem extends NavScreen {
  label: string;
}

export interface ModuleNavigation {
  key: ModuleNavigationKey;
  label: string;
  items: ModuleNavigationItem[];
  activePath: string | null;
}

const MODULE_KEYS = new Set<string>(MODULE_NAVIGATION_KEYS);

const LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  "/bereavement": "Bereavement Caseload",
  "/orders": "Awaiting Signature",
  "/prescribing/sign-inbox": "Awaiting Signature",
  "/reports": "Reports & Analytics",
  "/medicaid/billing/trading-partner-credentials": "Trading Partner Credentials",
};

/** Curated module rows keep the working destinations in a stable order. Visibility comes from the sidebar. */
const ADMISSIONS_ITEMS: readonly { path: string; label: string }[] = [
  { path: "/admissions", label: "All Admissions" },
  { path: "/admissions/new", label: "New Admission" },
  { path: "/referrals", label: "Referral Inbox" },
  { path: "/referrals/new", label: "New Referral" },
  { path: "/admissions/readmit", label: "Readmit" },
  { path: "/admissions/discharges", label: "Discharge/Transfer" },
];

const ASSESSMENTS_ITEMS: readonly { path: string; label: string }[] = [
  { path: "/hope", label: "HOPE Timepoints" },
  { path: "/work/cosignatures", label: "Cosignatures" },
  { path: "/work/drafts", label: "My visit drafts" },
  { path: "/admin/scales/licenses", label: "Scale Licenses" },
  { path: "/admin/scales/policies", label: "Scale Policies" },
  { path: "/hope/sfv", label: "SFV Worklist" },
  { path: "/hope/submissions", label: "HOPE Submissions" },
  { path: "/hope/compliance", label: "HQRP Compliance" },
];

function entryFor(sections: NavSection[], key: string): NavEntry | undefined {
  return sections.flatMap((section) => section.entries).find((entry) => entry.key === key);
}

function moduleKeyForPath(sections: NavSection[], pathname: string): ModuleNavigationKey | null {
  // The cosign screen is registered at `/discharges/:id/cosign`, outside the otherwise consistent
  // Admissions prefixes. Keep that existing route in the Admissions context without broad `/admin`
  // or `/prescribing` guesses that could pull Users or Scheduling into this navigation.
  if (pathname === "/discharges" || pathname.startsWith("/discharges/")) return "admissions";
  const key = activeEntryKey(sections, pathname);
  return key && MODULE_KEYS.has(key) ? (key as ModuleNavigationKey) : null;
}

function itemsForEntry(entry: NavEntry, key: ModuleNavigationKey): ModuleNavigationItem[] {
  if (key === "admissions" || key === "assessments") {
    const visibleByPath = new Map(entry.screens.map((screen) => [screen.path, screen]));
    const items = key === "admissions" ? ADMISSIONS_ITEMS : ASSESSMENTS_ITEMS;
    return items.flatMap(({ path, label }) => {
      const screen = visibleByPath.get(path);
      return screen ? [{ ...screen, label }] : [];
    });
  }
  return entry.screens.map((screen) => ({
    ...screen,
    label: LABEL_OVERRIDES[screen.path] ?? screen.title,
  }));
}

function matchesPath(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

function activePathFor(
  key: ModuleNavigationKey,
  items: ModuleNavigationItem[],
  pathname: string,
): string | null {
  const available = new Set(items.map((item) => item.path));

  // Detail/workflow routes whose owning destination is explicit in the screen registry and module
  // flow. These avoid claiming an unrelated root tab merely because it shares a short prefix.
  const explicitParents: readonly [boolean, string][] = [
    [key === "admissions" && /^\/referrals\/[^/]+/.test(pathname), "/referrals"],
    [
      key === "admissions" && /^\/admissions\/[^/]+\/readmit(?:\/|$)/.test(pathname),
      "/admissions/readmit",
    ],
    [
      key === "admissions" && /^\/admissions\/[^/]+\/discharge(?:\/|$)/.test(pathname),
      "/admissions/discharges",
    ],
    [
      key === "admissions" && /^\/discharges\/[^/]+\/cosign(?:\/|$)/.test(pathname),
      "/admissions/discharges",
    ],
    [key === "admissions" && /^\/admissions\/[^/]+(?:\/|$)/.test(pathname), "/admissions"],
    [key === "orders" && /^\/supplies\/requests\/[^/]+/.test(pathname), "/supplies"],
    [
      key === "orders" && /^\/supplies\/dispatches\/[^/]+/.test(pathname),
      "/supplies/dispatches/new",
    ],
    [key === "medications" && /^\/refills\/[^/]+/.test(pathname), "/refills"],
    [key === "reports" && /^\/reports\/(?:dashboards|role)\/[^/]+/.test(pathname), "/reports"],
    [
      key === "administration" && /^\/subscription\/invoices\/[^/]+/.test(pathname),
      "/subscription/invoices",
    ],
  ];
  const explicit = explicitParents.find(([matches, path]) => matches && available.has(path));
  if (explicit) return explicit[1];

  // Static destinations use longest segment-boundary matching. Root landing destinations do not
  // automatically claim unknown detail routes; those remain correctly unselected unless mapped above.
  const matches = items
    .filter((item) => matchesPath(pathname, item.path))
    .sort((a, b) => b.path.length - a.path.length);
  const exact = matches.find((item) => item.path === pathname);
  if (exact) return exact.path;
  const nested = matches.find((item) => item.path.split("/").filter(Boolean).length > 1);
  return nested?.path ?? null;
}

/** Resolve route-synchronised module tabs from the already permission-filtered primary navigation. */
export function resolveModuleNavigation(
  sections: NavSection[],
  pathname: string,
): ModuleNavigation | null {
  const key = moduleKeyForPath(sections, pathname);
  if (!key) return null;
  const entry = entryFor(sections, key);
  if (!entry) return null;
  const items = itemsForEntry(entry, key);
  if (items.length === 0) return null;
  return {
    key,
    label: entry.label,
    items,
    activePath: activePathFor(key, items, pathname),
  };
}
