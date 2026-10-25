import type { GlyphName } from "@chartwarden/ui";
// apps/web/src/shell — the curated primary navigation (2026-09-25 redesign). The sidebar shows a fixed,
// clinician-shaped list (Home · Patients · Admissions … · Clinical Tools · System) instead of one
// group per module. Every registered top-level screen still has exactly one home: it is either an
// entry's own target or one of its children (revealed by the entry's disclosure chevron), and any
// screen no rule claims falls into Administration — so nothing silently drops out of the nav.

export interface NavScreen {
  id: string;
  path: string;
  title: string;
}

export interface NavEntrySpec {
  key: string;
  label: string;
  icon: GlyphName;
  /** Preferred landing route; the first visible claimed screen is used when this one is not visible. */
  to: string;
  /** Path prefixes whose screens belong under this entry. Longest matching prefix wins across entries. */
  claims: string[];
  /** Extra route prefixes that mark this entry current without being nav children (e.g. /patients/:id). */
  activeOn?: string[];
  /** Child display order by path prefix (first match wins); children matching none keep their order, last. */
  childOrder?: string[];
}

export interface NavSectionSpec {
  label?: string;
  entries: NavEntrySpec[];
}

export const PRIMARY_NAV: NavSectionSpec[] = [
  {
    entries: [
      { key: "home", label: "Home", icon: "home", to: "/", claims: [] },
      {
        key: "patients",
        label: "Patients",
        icon: "users",
        to: "/patients",
        claims: ["/patients", "/search"],
      },
      {
        key: "admissions",
        label: "Admissions",
        icon: "user-plus",
        to: "/admissions",
        // Referrals are the Admissions area's "Pending Referrals" tab, so the inbox, new referral,
        // referral detail and Intake review (DocLens faxes start with the referral) live here too —
        // switching between the area's tabs never moves the sidebar highlight.
        claims: ["/admissions", "/compliance/admissions", "/ipu", "/referrals", "/intake"],
        // New admission, then the Discharge / transfer hub right below it, then Readmit (the readmission
        // candidates), then the other admission pages.
        childOrder: [
          "/admissions/new",
          "/admissions/discharges",
          "/admissions/readmit",
          "/admissions",
          "/compliance/admissions",
          "/referrals",
          "/intake",
          "/ipu",
        ],
      },
      {
        key: "assessments",
        label: "Assessments",
        icon: "clipboard-check",
        to: "/hope",
        claims: ["/hope", "/work/drafts", "/work/cosignatures", "/admin/scales"],
      },
      {
        key: "care-plans",
        label: "Care Plans",
        icon: "clipboard-list",
        to: "/bereavement",
        claims: ["/bereavement", "/admin/volunteer"],
      },
      {
        key: "orders",
        label: "Orders",
        icon: "file-check",
        to: "/orders",
        claims: ["/orders", "/standing-orders", "/supplies"],
      },
      {
        key: "medications",
        label: "Medications",
        icon: "pill",
        to: "/prescribing/sign-inbox",
        claims: ["/prescribing", "/refills", "/admin/prescrib", "/admin/administration-policy"],
      },
      {
        key: "scheduling",
        label: "Scheduling",
        icon: "calendar",
        to: "/calendar",
        claims: ["/calendar", "/scheduling", "/admin/scheduling-metrics"],
      },
      { key: "idg", label: "IDG", icon: "grid-circles", to: "/idg/schedule", claims: ["/idg"] },
      {
        key: "documents",
        label: "Documents",
        icon: "file-text",
        to: "/documents",
        claims: ["/documents", "/admin/forms"],
      },
      {
        key: "billing",
        label: "Billing",
        icon: "receipt",
        to: "/billing",
        // Eligibility (Medicare HETS and Medicaid) is a Billing tab, so it stays under Billing — no
        // separate sidebar entry for the highlight to jump to.
        claims: [
          "/billing",
          "/medicaid",
          "/commercial",
          "/remittance",
          "/cap",
          "/cost-reports",
          "/platform/cap",
          "/admin/billing-audit",
        ],
      },
      {
        key: "reports",
        label: "Reports",
        icon: "bar-chart",
        to: "/reports",
        claims: ["/reports", "/quality"],
      },
      {
        key: "administration",
        label: "Administration",
        icon: "settings",
        to: "/admin/onboarding",
        claims: ["/admin", "/subscription", "/compliance", "/organization"],
      },
    ],
  },
  {
    label: "Clinical tools",
    entries: [
      {
        // Visits is the "field work" entry: a clinician's visits, EVV, safety check-ins/incidents and on-call
        // triage are one working surface, so they share this entry and the page's own child row carries the
        // finer location (#637). Do not split On-call / Field safety into top-level entries without a redesign
        // decision: the sidebar structure follows the mockups.
        key: "visits",
        label: "Visits",
        icon: "stethoscope",
        to: "/me/visits",
        claims: ["/me/visits", "/evv", "/me/evv", "/safety", "/me/safety", "/triage", "/me/oncall"],
      },
      {
        key: "communications",
        label: "Communications",
        icon: "message-square",
        to: "/messaging",
        claims: ["/messaging", "/notifications"],
      },
    ],
  },
  {
    label: "System",
    entries: [
      {
        key: "users",
        label: "Users",
        icon: "user-circle",
        to: "/admin/staff",
        claims: ["/admin/staff", "/roles"],
      },
      {
        key: "organization",
        label: "Organization",
        icon: "building",
        to: "/admin/account",
        claims: ["/admin/account", "/admin/support-grants", "/mdm", "/terminology"],
      },
      {
        key: "integrations",
        label: "Integrations",
        icon: "grid-circles",
        to: "/medicaid/billing/trading-partner-credentials",
        claims: [
          "/medicaid/billing/trading-partner-credentials",
          "/billing/mac-credentials",
          "/supplies/vendor-routing",
          "/triage/vendors",
          "/organization/ai",
        ],
      },
      {
        key: "audit-log",
        label: "Audit Log",
        icon: "scroll",
        to: "/audit",
        claims: ["/audit", "/compliance/audit", "/compliance/legal-holds", "/compliance/ai"],
      },
      {
        key: "settings",
        label: "Settings",
        icon: "settings",
        to: "/security/passkeys",
        claims: ["/security", "/me/ai-preferences", "/me/safety/consent"],
      },
    ],
  },
];

/** A resolved nav entry: its landing href (null when the actor can see none of its screens) + children. */
export interface NavEntry {
  key: string;
  label: string;
  icon: GlyphName;
  href: string | null;
  /** Every visible static destination owned by this entry, including its landing screen. */
  screens: NavScreen[];
  children: NavScreen[];
  /** Every prefix that makes this entry "current": its own target, its claims, and `activeOn`. */
  matchPrefixes: string[];
}

export interface NavSection {
  label?: string;
  entries: NavEntry[];
}

function matchLength(path: string, prefix: string): number {
  if (prefix === "/") return path === "/" ? 1 : 0;
  return path === prefix || path.startsWith(`${prefix}/`) ? prefix.length : 0;
}

function sortChildren(children: NavScreen[], order?: string[]): NavScreen[] {
  if (!order) return children;
  const rank = (path: string) => {
    const i = order.findIndex((prefix) => matchLength(path, prefix) > 0);
    return i === -1 ? order.length : i;
  };
  // Array.prototype.sort is stable, so screens of one group keep their registration order.
  return [...children].sort((a, b) => rank(a.path) - rank(b.path));
}

/**
 * Assign each visible, non-parametric screen to the entry whose claim is its longest matching
 * prefix (so `/billing/eligibility` lands in Eligibility, not Billing). Unclaimed screens go to
 * Administration. The Home entry is always present; other entries appear only when the actor can
 * reach at least one of their screens.
 */
export function buildPrimaryNav(
  visibleScreens: NavScreen[],
  spec: NavSectionSpec[] = PRIMARY_NAV,
): NavSection[] {
  const allEntries = spec.flatMap((s) => s.entries);
  const owned = new Map<string, NavScreen[]>(allEntries.map((e) => [e.key, []]));
  for (const screen of visibleScreens) {
    if (screen.path.includes(":") || screen.path === "/") continue;
    let best: { key: string; len: number } | null = null;
    for (const entry of allEntries) {
      for (const claim of entry.claims) {
        const len = matchLength(screen.path, claim);
        if (len > 0 && (!best || len > best.len)) best = { key: entry.key, len };
      }
    }
    owned.get(best?.key ?? "administration")?.push(screen);
  }
  return spec
    .map((section) => ({
      label: section.label,
      entries: section.entries
        .map((entry): NavEntry => {
          const children = sortChildren(owned.get(entry.key) ?? [], entry.childOrder);
          const landing =
            entry.key === "home"
              ? "/"
              : (children.find((c) => c.path === entry.to)?.path ?? children[0]?.path ?? null);
          const landingScreen = children.find((child) => child.path === landing);
          const orderedScreens = landingScreen
            ? [landingScreen, ...children.filter((child) => child.path !== landing)]
            : children;
          return {
            key: entry.key,
            label: entry.label,
            icon: entry.icon,
            href: landing,
            // Mirrors the rendered sidebar: entry-row destination first, disclosed children after it.
            screens: orderedScreens,
            // The landing screen is the entry row itself; list only the others under it.
            children: children.filter((c) => c.path !== landing),
            // Include resolved child paths as well as declared claims. This keeps the parent current
            // for fallback-owned screens such as `/telehealth`, whose route deliberately has no
            // broad `/telehealth` claim of its own.
            matchPrefixes: [
              entry.to,
              ...entry.claims,
              ...(entry.activeOn ?? []),
              ...children.map((child) => child.path),
            ],
          };
        })
        .filter((e) => e.href !== null),
    }))
    .filter((s) => s.entries.length > 0);
}

/** The entry key that owns `pathname` (longest-prefix wins), or null. */
export function activeEntryKey(sections: NavSection[], pathname: string): string | null {
  let best: { key: string; len: number } | null = null;
  for (const entry of sections.flatMap((s) => s.entries)) {
    for (const prefix of entry.matchPrefixes) {
      const len = matchLength(pathname, prefix);
      if (len > 0 && (!best || len > best.len)) best = { key: entry.key, len };
    }
  }
  return best?.key ?? null;
}
