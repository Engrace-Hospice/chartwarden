import { LeftNavRail, t } from "@wardenx/ui";
import type { CSSProperties, JSX } from "react";
import { Link } from "react-router-dom";
// apps/web/src/shell — the patient-chart module nav rail, shared by the clinical workspace screens
// (Care Plan, Orders, Assessments, …) so the rail is defined once. Mirrors the P1 Pencil frames'
// "Module Nav Rail": Summary / Care Plan / Encounters / Assessments / Orders / Medications / Documents /
// IDG History, each with a stroke glyph. The active section is `current`; every other item links to its
// real patient-scoped route where one exists, else to the patient chart (the hub those sections live in).

export type ChartSection =
  | "summary"
  | "care-plan"
  | "discipline-plans"
  | "encounters"
  | "assessments"
  | "orders"
  | "medications"
  | "documents"
  | "election"
  | "idg";

type NavIconName = "summary" | "carePlan" | "stethoscope" | "checklist" | "orders" | "pill" | "folder" | "cert" | "idg";
const NAV_ICON_PATHS: Record<NavIconName, string> = {
  summary: "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",
  carePlan: "M9 4h6v3H9z M7 5H5v15h14V5h-2 M9 11h6 M9 15h4",
  stethoscope: "M6 4v5a4 4 0 0 0 8 0V4 M10 16a4 4 0 0 0 8 0v-2 M18 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
  checklist: "M4 6h9 M4 12h9 M4 18h9 M17 5l1.5 1.5L21 4 M17 11l1.5 1.5L21 10",
  orders: "M7 3h7l4 4v14H7z M14 3v4h4 M10 13h5 M10 17h5",
  pill: "M5 13l8-8a4 4 0 0 1 6 6l-8 8a4 4 0 0 1-6-6z M9 9l6 6",
  folder: "M3 6h6l2 2h10v11H3z",
  cert: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z M8.5 12l2.5 2.5 4.5-5",
  idg: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M3 19c0-3 2.7-5 6-5s6 2 6 5 M16 11a3 3 0 0 0 0-6 M15 14c3 .2 5 2.2 5 5",
};
function NavIcon({ name }: { name: NavIconName }): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
      <path d={NAV_ICON_PATHS[name]} />
    </svg>
  );
}

// Each item's real patient-scoped route, or `null` to fall back to the chart (those sections live as
// chart tabs / have no standalone patient route yet).
const ITEMS: { key: ChartSection; label: string; icon: NavIconName; route: ((id: string) => string) | null }[] = [
  { key: "summary", label: "Summary", icon: "summary", route: null },
  { key: "care-plan", label: "Care Plan", icon: "carePlan", route: (id) => `/patients/${id}/care-plan` },
  { key: "discipline-plans", label: "Discipline Plans", icon: "checklist", route: (id) => `/patients/${id}/discipline-plans` },
  { key: "encounters", label: "Encounters", icon: "stethoscope", route: (id) => `/patients/${id}/encounters` },
  { key: "assessments", label: "Assessments", icon: "checklist", route: (id) => `/patients/${id}/assessments` },
  { key: "orders", label: "Orders", icon: "orders", route: (id) => `/patients/${id}/orders` },
  { key: "medications", label: "Medications", icon: "pill", route: (id) => `/patients/${id}/emar` },
  { key: "documents", label: "Documents", icon: "folder", route: (id) => `/patients/${id}/documents` },
  { key: "election", label: "Election & Certification", icon: "cert", route: (id) => `/patients/${id}/election-certification` },
  { key: "idg", label: "IDG History", icon: "idg", route: (id) => `/patients/${id}/idg-history` },
];

export function ChartModuleRail({ patientId, current }: { patientId: string; current: ChartSection }): JSX.Element {
  return (
    <LeftNavRail ariaLabel="Patient modules">
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.125rem" }}>
        {ITEMS.map((it) => {
          const inner = (
            <>
              <NavIcon name={it.icon} />
              {it.label}
            </>
          );
          if (it.key === current) {
            return (
              <li key={it.key}>
                <span style={{ ...navItem, ...navItemActive }} aria-current="page">{inner}</span>
              </li>
            );
          }
          const to = it.route ? it.route(patientId) : `/patients/${patientId}`;
          return (
            <li key={it.key}>
              <Link to={to} style={navItem}>{inner}</Link>
            </li>
          );
        })}
      </ul>
    </LeftNavRail>
  );
}

const navItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.625rem",
  padding: "0.5rem 0.75rem",
  borderRadius: "0.5rem",
  fontSize: "0.8125rem",
  fontWeight: 500,
  textDecoration: "none",
  color: t.onSurfaceVariant,
};
const navItemActive: CSSProperties = { background: t.primaryTint, color: t.primary, fontWeight: 600 };
