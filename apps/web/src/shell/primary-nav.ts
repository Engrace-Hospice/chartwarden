import type { GlyphName } from "@chartwarden/ui";
// apps/web/src/shell — the curated primary navigation (2026-09-25 redesign). The sidebar shows a fixed,
// clinician-shaped list (Home · Patients · Admissions … · Clinical Tools · System) instead of one
// group per module. Every registered top-level screen still has exactly one home: it is either an
// entry's own target or one of its children (revealed by the entry's disclosure chevron), and any
// screen no rule claims falls into Administration — so nothing silently drops out of the nav.
//
// SUB-SECTIONS: an entry may declare `subsections` — headed groups of children inside the one entry
// (Billing: Medicare / Medicaid / Commercial / All payers). The entry key, landing and `activeEntryKey`
// are unchanged. Each subsection has its own `claims`; ownership is still longest-prefix across ALL
// claims of ALL entries and subsections, so a screen belongs to exactly one subsection (give the more
// specific path to the narrower owner: `/remittance/adrs` -> Medicare beats `/remittance` -> All payers).
// A subsection with no visible screen is dropped, so it appears the moment its screens are registered.
//
// BORROW: any entry or subsection may list `borrow: [{ path, label? }]` — extra links to screens owned
// elsewhere. A borrowed link renders under its host but takes no ownership: it is not in `children`,
// the owner keeps the active highlight, and it never carries `aria-current` (one per page). It is
// dropped when the actor cannot see the target or the host already owns it. Example:
//   { key: "all-payers", label: "All payers", claims: ["/remittance"],
//     borrow: [{ path: "/billing/eligibility", label: "Eligibility (Medicare)" }] }

export interface NavScreen {
  id: string;
  path: string;
  title: string;
}

/** A link to a screen owned by another entry/subsection; shown, never owned. */
export interface NavBorrowSpec {
  path: string;
  label?: string;
}

export interface NavSubsectionSpec {
  key: string;
  label: string;
  /** Path prefixes owned by this subsection (same longest-prefix rule as entry claims). */
  claims: string[];
  childOrder?: string[];
  borrow?: NavBorrowSpec[];
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
  /** Headed groups of children inside this entry; their claims count as this entry's claims. */
  subsections?: NavSubsectionSpec[];
  /** Links to screens owned elsewhere, rendered under this entry without taking ownership. */
  borrow?: NavBorrowSpec[];
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
        claims: [],
        // Payer lanes inside the one Billing entry. Eligibility (Medicare HETS and Medicaid) is a Billing
        // tab, so it stays here. Surveyor views (/admin/billing-audit, /admin/medicaid-billing-audit)
        // live under the Audit Log entry. Cap and cost reports are Medicare-only (42 CFR 418.309 cap
        // counts Medicare beneficiaries; M27 produces CMS-1984-14, the Medicare hospice cost report).
        subsections: [
          {
            key: "medicare",
            label: "Medicare",
            claims: [
              "/billing",
              "/remittance/adrs",
              "/remittance/audits",
              "/remittance/tpe",
              "/remittance/report",
              "/cap",
              "/platform/cap",
              "/cost-reports",
            ],
          },
          { key: "medicaid", label: "Medicaid", claims: ["/medicaid"] },
          // M41 (ADR-0100): the screens live under /commercial/billing.
          { key: "commercial", label: "Commercial", claims: ["/commercial"] },
          // Shared M25 remittance screens; the Medicare-only review-chain paths above win by length.
          { key: "all-payers", label: "All payers", claims: ["/remittance"] },
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
        key: "messaging",
        label: "Messaging",
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
        claims: [
          "/audit",
          "/compliance/audit",
          "/compliance/legal-holds",
          "/compliance/ai",
          // Surveyor views of Billing (Medicare, Medicaid) are audit surfaces, not Billing screens.
          "/admin/billing-audit",
          "/admin/medicaid-billing-audit",
        ],
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

export interface NavSubsection {
  key: string;
  label: string;
  /** Owned visible screens, landing screen included (the renderer skips the entry row's own target). */
  screens: NavScreen[];
  borrowed: NavScreen[];
}

/** A resolved nav entry: its landing href (null when the actor can see none of its screens) + children. */
export interface NavEntry {
  key: string;
  label: string;
  icon: GlyphName;
  href: string | null;
  /** Every visible static destination owned by this entry, including its landing screen. */
  screens: NavScreen[];
  children: NavScreen[];
  /** Headed groups (only entries with `subsections`); empty subsections are dropped. */
  subsections?: NavSubsection[];
  /** Borrowed links shown under the entry; not owned, not in `children`. */
  borrowed?: NavScreen[];
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
  // Owner slot = entry key, or `${entryKey}/${subsectionKey}` for a subsection.
  const owned = new Map<string, NavScreen[]>();
  const claimRules: { slot: string; claim: string }[] = [];
  for (const entry of allEntries) {
    owned.set(entry.key, []);
    for (const claim of entry.claims) claimRules.push({ slot: entry.key, claim });
    for (const sub of entry.subsections ?? []) {
      const slot = `${entry.key}/${sub.key}`;
      owned.set(slot, []);
      for (const claim of sub.claims) claimRules.push({ slot, claim });
    }
  }
  for (const screen of visibleScreens) {
    if (screen.path.includes(":") || screen.path === "/") continue;
    let best: { slot: string; len: number } | null = null;
    for (const { slot, claim } of claimRules) {
      const len = matchLength(screen.path, claim);
      if (len > 0 && (!best || len > best.len)) best = { slot, len };
    }
    owned.get(best?.slot ?? "administration")?.push(screen);
  }
  const resolveBorrowed = (borrow: NavBorrowSpec[] | undefined, own: NavScreen[]): NavScreen[] =>
    (borrow ?? []).flatMap((b) => {
      const target = visibleScreens.find((s) => s.path === b.path);
      if (!target || own.some((s) => s.path === b.path)) return [];
      return [{ ...target, title: b.label ?? target.title }];
    });
  return spec
    .map((section) => ({
      label: section.label,
      entries: section.entries
        .map((entry): NavEntry => {
          const subsections = (entry.subsections ?? [])
            .map((sub): NavSubsection => {
              const screens = sortChildren(
                owned.get(`${entry.key}/${sub.key}`) ?? [],
                sub.childOrder,
              );
              return {
                key: sub.key,
                label: sub.label,
                screens,
                borrowed: resolveBorrowed(sub.borrow, screens),
              };
            })
            .filter((sub) => sub.screens.length > 0);
          const children = [
            ...sortChildren(owned.get(entry.key) ?? [], entry.childOrder),
            ...subsections.flatMap((sub) => sub.screens),
          ];
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
            ...(entry.subsections ? { subsections } : {}),
            borrowed: resolveBorrowed(entry.borrow, children),
            // Include resolved child paths as well as declared claims. This keeps the parent current
            // for fallback-owned screens such as `/telehealth`, whose route deliberately has no
            // broad `/telehealth` claim of its own.
            matchPrefixes: [
              entry.to,
              ...entry.claims,
              ...(entry.subsections ?? []).flatMap((sub) => sub.claims),
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
