// apps/web/src/shell — the two-row area navigation shared by the Medicare and Medicaid billing bars: a row of areas and,
// for the current area, a second row of its views. The current area and view are read from the URL (longest matching
// prefix), so a screen only renders its bar; the area tables live beside it (billing-tabs.tsx, medicaid-billing-tabs.tsx).
import type { JSX } from "react";
import { Link, useLocation } from "react-router-dom";

export interface AreaView {
  to: string;
  label: string;
  match: string[];
}
export interface NavArea {
  label: string;
  /** Where the area's own link goes; defaults to its first view. */
  to?: string;
  /** Prefixes that put the area itself current, beyond its views' own. */
  match?: string[];
  views: AreaView[];
}

const areaTo = (area: NavArea, home: string): string => area.to ?? area.views[0]?.to ?? home;

interface Place {
  area: NavArea;
  view: AreaView | null;
  len: number;
}

function currentPlace(areas: NavArea[], pathname: string): Place | null {
  let best: Place | null = null;
  const consider = (area: NavArea, view: AreaView | null, prefixes: string[]) => {
    for (const prefix of prefixes)
      if (pathname === prefix || pathname.startsWith(`${prefix}/`))
        if (!best || prefix.length > best.len) best = { area, view, len: prefix.length };
  };
  for (const area of areas) {
    consider(area, null, area.match ?? []);
    for (const view of area.views) consider(area, view, view.match);
  }
  return best;
}

type Current = "page" | "area" | false;

// An area's own link points at its first view, so on any other view of the area it is "in" the area, not "the page":
// only one element on the screen carries aria-current="page".
function NavLink({
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

export function AreaNav({
  areas,
  label,
  home,
}: { areas: NavArea[]; label: string; home: string }): JSX.Element {
  const place = currentPlace(areas, useLocation().pathname);
  return (
    <>
      <nav className="wx-subtabs" aria-label={label}>
        {areas.map((area) => (
          <NavLink
            key={area.label}
            to={areaTo(area, home)}
            label={area.label}
            current={place?.area === area && (place.view ? "area" : "page")}
          />
        ))}
      </nav>
      {place && place.area.views.length > 0 && (
        <nav className="wx-subtabs" aria-label={`${place.area.label} views`}>
          {place.area.views.map((view) => (
            <NavLink
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
