// apps/web/src/shell — the Billing area's navigation: Overview · Work Queue · Claims · Revenue Cycle · Tools, with the
// views inside the current area on a second row (Work Queue: NOE / NOTR · Transfers · DDE queue; Claims: Medicare ·
// Commercial; Revenue Cycle: Remittances · Denials · ADR requests · Audits · Appeals; Tools: Eligibility · Rates · Wage index). The views are separate
// screens owned by M23, M25 and M41, so the bar lives in the shell and every one of them renders it.
// The current area and view are read from the URL (longest matching prefix), so callers just render <BillingTabs />.
import type { JSX } from "react";
import { Link, useLocation } from "react-router-dom";

interface BillingView {
  to: string;
  label: string;
  match: string[];
}
interface BillingArea {
  label: string;
  /** Where the area's own link goes; defaults to its first view. */
  to?: string;
  /** Prefixes that put the area itself current, beyond its views' own. */
  match?: string[];
  views: BillingView[];
}

const AREAS: BillingArea[] = [
  { label: "Overview", to: "/billing", match: ["/billing"], views: [] },
  {
    label: "Work Queue",
    views: [
      { to: "/billing/queue", label: "All work", match: ["/billing/queue"] },
      { to: "/billing/noe", label: "NOE / NOTR", match: ["/billing/noe", "/billing/notr"] },
      { to: "/billing/transfer-notices", label: "Transfers", match: ["/billing/transfer-notices"] },
      { to: "/billing/dde", label: "DDE queue", match: ["/billing/dde"] },
    ],
  },
  {
    label: "Claims",
    views: [
      { to: "/billing/claims", label: "Medicare", match: ["/billing/claims"] },
      { to: "/commercial/billing/claims", label: "Commercial", match: ["/commercial/billing"] },
    ],
  },
  {
    label: "Revenue Cycle",
    views: [
      { to: "/remittance", label: "Remittances", match: ["/remittance"] },
      { to: "/remittance/denials", label: "Denials", match: ["/remittance/denials"] },
      { to: "/remittance/adrs", label: "ADR requests", match: ["/remittance/adrs"] },
      { to: "/remittance/audits", label: "Audits", match: ["/remittance/audits"] },
      { to: "/remittance/appeals", label: "Appeals", match: ["/remittance/appeals"] },
    ],
  },
  {
    label: "Tools",
    views: [
      { to: "/billing/eligibility", label: "Eligibility", match: ["/billing/eligibility"] },
      { to: "/billing/rate-tables", label: "Rates", match: ["/billing/rate-tables"] },
      { to: "/billing/wage-indexes", label: "Wage index", match: ["/billing/wage-indexes"] },
    ],
  },
];

const areaTo = (area: BillingArea): string => area.to ?? area.views[0]?.to ?? "/billing";

interface Place {
  area: BillingArea;
  view: BillingView | null;
  len: number;
}

function currentPlace(pathname: string): Place | null {
  let best: Place | null = null;
  const consider = (area: BillingArea, view: BillingView | null, prefixes: string[]) => {
    for (const prefix of prefixes)
      if (pathname === prefix || pathname.startsWith(`${prefix}/`))
        if (!best || prefix.length > best.len) best = { area, view, len: prefix.length };
  };
  for (const area of AREAS) {
    consider(area, null, area.match ?? []);
    for (const view of area.views) consider(area, view, view.match);
  }
  return best;
}

type Current = "page" | "area" | false;

// An area's own link points at its first view, so on any other view of the area it is "in" the area, not "the page":
// only one element on the screen carries aria-current="page".
function BillingLink({
  to,
  label,
  current,
}: { to: string; label: string; current: Current }): JSX.Element {
  return current ? (
    <Link to={to} aria-current={current === "page" ? "page" : "true"} className="is-current">
      {label}
    </Link>
  ) : (
    <Link to={to}>{label}</Link>
  );
}

export function BillingTabs(): JSX.Element {
  const place = currentPlace(useLocation().pathname);
  return (
    <>
      <nav className="wx-subtabs" aria-label="Billing areas">
        {AREAS.map((area) => (
          <BillingLink
            key={area.label}
            to={areaTo(area)}
            label={area.label}
            current={place?.area === area && (place.view ? "area" : "page")}
          />
        ))}
      </nav>
      {place && place.area.views.length > 0 && (
        <nav className="wx-subtabs" aria-label={`${place.area.label} views`}>
          {place.area.views.map((view) => (
            <BillingLink
              key={view.to}
              to={view.to}
              label={view.label}
              current={place.view === view && "page"}
            />
          ))}
        </nav>
      )}
    </>
  );
}
