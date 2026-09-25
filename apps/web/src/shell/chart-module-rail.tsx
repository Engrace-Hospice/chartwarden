import { LeftNavRail, PatientWorkspaceLayout, t } from "@wardenx/ui";
import type { CSSProperties, JSX, ReactNode } from "react";
import { Link } from "react-router-dom";
// apps/web/src/shell — the patient-chart module nav rail, shared by the clinical workspace screens
// (Care Plan, Orders, Assessments, …) so the rail is defined once. Mirrors the P1 Pencil frames'
// "Module Nav Rail": Summary / Care Plan / Encounters / Assessments / Orders / Medications / Documents /
// IDG History, each with a stroke glyph. The active section is `current`; every other item links to its
// real patient-scoped route where one exists, else to the patient chart (the hub those sections live in).

export type ChartSection =
  | "summary"
  | "demographics"
  | "addresses"
  | "coverage"
  | "care-team"
  | "hope"
  | "privacy"
  | "care-plan"
  | "discipline-plans"
  | "encounters"
  | "assessments"
  | "orders"
  | "medications"
  | "documents"
  | "election"
  | "idg";

type NavIconName =
  | "summary"
  | "person"
  | "pin"
  | "shield"
  | "groups"
  | "hope"
  | "lock"
  | "carePlan"
  | "stethoscope"
  | "checklist"
  | "orders"
  | "pill"
  | "folder"
  | "cert"
  | "idg";

const NAV_ICON_PATHS: Record<NavIconName, string> = {
  summary: "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",

  person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 20c0-4 4-6 8-6s8 2 8 6",

  pin: "M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11z M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",

  shield: "M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z",

  groups:
    "M8 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M2 20c0-3 2.7-5 6-5 M16 13a3 3 0 1 0 0-6 M14 15c3.3 0 6 2 6 5",

  hope: "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.7A4 4 0 0 1 19 10c0 5.6-7 10-7 10z",

  lock: "M6 10V8a6 6 0 0 1 12 0v2 M5 10h14v10H5z",

  carePlan: "M9 4h6v3H9z M7 5H5v15h14V5h-2 M9 11h6 M9 15h4",

  stethoscope:
    "M6 4v5a4 4 0 0 0 8 0V4 M10 16a4 4 0 0 0 8 0v-2 M18 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",

  checklist: "M4 6h9 M4 12h9 M4 18h9 M17 5l1.5 1.5L21 4 M17 11l1.5 1.5L21 10",

  orders: "M7 3h7l4 4v14H7z M14 3v4h4 M10 13h5 M10 17h5",

  pill: "M5 13l8-8a4 4 0 0 1 6 6l-8 8a4 4 0 0 1-6-6z M9 9l6 6",

  folder: "M3 6h6l2 2h10v11H3z",

  cert: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z M8.5 12l2.5 2.5 4.5-5",

  idg: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M3 19c0-3 2.7-5 6-5s6 2 6 5 M16 11a3 3 0 0 0 0-6 M15 14c3 .2 5 2.2 5 5",
};

function NavIcon({ name }: { name: NavIconName }): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path d={NAV_ICON_PATHS[name]} />
    </svg>
  );
}

// Each item's real patient-scoped route, or `null` to fall back to the chart (those sections live as
// chart tabs / have no standalone patient route yet).
const ITEMS: {
  key: ChartSection;
  label: string;
  icon: NavIconName;
  route: (id: string) => string;
}[] = [
  {
    key: "summary",
    label: "Summary",
    icon: "summary",
    route: (id) => `/patients/${id}`,
  },
  {
    key: "demographics",
    label: "Demographics & Identifiers",
    icon: "person",
    route: (id) => `/patients/${id}?view=demographics`,
  },
  {
    key: "addresses",
    label: "Addresses",
    icon: "pin",
    route: (id) => `/patients/${id}?view=addresses`,
  },
  {
    key: "coverage",
    label: "Coverage / Payers",
    icon: "shield",
    route: (id) => `/patients/${id}?view=coverage`,
  },
  {
    key: "care-team",
    label: "Care Team & Assignments",
    icon: "groups",
    route: (id) => `/patients/${id}?view=care-team`,
  },
  {
    key: "hope",
    label: "HOPE",
    icon: "hope",
    route: (id) => `/patients/${id}/hope`,
  },
  {
    key: "privacy",
    label: "Privacy Flags",
    icon: "lock",
    route: (id) => `/patients/${id}?view=privacy`,
  },
  {
    key: "care-plan",
    label: "Care Plan",
    icon: "carePlan",
    route: (id) => `/patients/${id}/care-plan`,
  },
  {
    key: "discipline-plans",
    label: "Discipline Plans",
    icon: "checklist",
    route: (id) => `/patients/${id}/discipline-plans`,
  },
  {
    key: "encounters",
    label: "Encounters / Visits",
    icon: "stethoscope",
    route: (id) => `/patients/${id}/encounters`,
  },
  {
    key: "assessments",
    label: "Assessments",
    icon: "checklist",
    route: (id) => `/patients/${id}/assessments`,
  },
  {
    key: "orders",
    label: "Orders",
    icon: "orders",
    route: (id) => `/patients/${id}/orders`,
  },
  {
    key: "medications",
    label: "Medications / eMAR",
    icon: "pill",
    route: (id) => `/patients/${id}/medications`,
  },
  {
    key: "documents",
    label: "Documents",
    icon: "folder",
    route: (id) => `/patients/${id}/documents`,
  },
  {
    key: "election",
    label: "Election & Certification",
    icon: "cert",
    route: (id) => `/patients/${id}/election-certification`,
  },
  {
    key: "idg",
    label: "IDG History",
    icon: "idg",
    route: (id) => `/patients/${id}/idg-history`,
  },
];

export function ChartModuleRail({
  patientId,
  current,
}: {
  patientId: string;
  current: ChartSection;
}): JSX.Element {
  return (
    <LeftNavRail ariaLabel="Patient modules">
      <ul
        className="wx-chart-module-list"
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: "0.125rem",
        }}
      >
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
                <span
                  className="wx-chart-module-item is-active"
                  style={{ ...navItem, ...navItemActive }}
                  aria-current="page"
                >
                  {inner}
                </span>
              </li>
            );
          }
          const to = it.route(patientId);
          return (
            <li key={it.key}>
              <Link className="wx-chart-module-item" to={to} style={navItem}>
                {inner}
              </Link>
            </li>
          );
        })}
      </ul>
    </LeftNavRail>
  );
}

/**
 * A patient/case-chart tab screen's loading/error/empty bail-out — keeps the same banner + module
 * rail mounted that the screen's success path renders, instead of a bare spinner/empty state that
 * drops them (live-browser audit #4: a user landing on an empty-state tab, or any tab mid-load, was
 * stranded with no in-chart way back). `current`/`patientId` are optional because not every chart
 * tab screen renders `ChartModuleRail` on its success path either — this only ever restores what
 * that screen already shows once loaded, never adds a rail a screen doesn't otherwise have.
 */
export function PatientChartBail({
  banner,
  patientId,
  current,
  children,
}: {
  banner: ReactNode;
  patientId?: string;
  current?: ChartSection;
  children: ReactNode;
}): JSX.Element {
  return (
    <PatientWorkspaceLayout banner={banner}>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {current && patientId ? (
          <ChartModuleRail patientId={patientId} current={current} />
        ) : null}
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {children}
        </div>
      </div>
    </PatientWorkspaceLayout>
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
const navItemActive: CSSProperties = {
  background: t.primaryTint,
  color: t.primary,
  fontWeight: 600,
};
