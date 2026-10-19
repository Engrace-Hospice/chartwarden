import { PatientWorkspaceLayout } from "@wardenx/ui";
import type { JSX, ReactNode } from "react";
import { Link } from "react-router-dom";
import { PatientConversationLink, useOpenPatientConversation } from "./open-patient-conversation";
// apps/web/src/shell — the patient-chart tab strip, shared by every patient-scoped workspace screen
// (Care Plan, Orders, Assessments, …) so it is defined once. 2026-09-25 redesign: the mockups replace
// the vertical module rail with a horizontal tab bar under the patient banner (Overview · Clinical ·
// Assessments · Care Plans · Orders · Medications · Visits · IDG · Documents · Claims · Communication).
// Callers still render <ChartModuleRail> as the first child of their workspace row; index.css turns
// that row into a column when it holds the strip, so no screen had to change its markup.

export type ChartSection =
  | "summary"
  | "clinical"
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
  | "idg"
  | "claims";

type ChartTabKey =
  | "overview"
  | "clinical"
  | "election"
  | "assessments"
  | "care-plans"
  | "orders"
  | "medications"
  | "visits"
  | "idg"
  | "documents"
  | "claims"
  | "communication";

// Which tab a section lives under. The M5 record sub-views (demographics, addresses, coverage, care
// team, privacy) and Election & Certification are reached from the Overview's panels and the banner's
// Actions menu, so they highlight Overview.
const SECTION_TAB: Record<ChartSection, ChartTabKey> = {
  summary: "overview",
  demographics: "overview",
  addresses: "overview",
  coverage: "overview",
  "care-team": "overview",
  privacy: "overview",
  election: "election",
  clinical: "clinical",
  hope: "assessments",
  assessments: "assessments",
  "care-plan": "care-plans",
  "discipline-plans": "care-plans",
  encounters: "visits",
  orders: "orders",
  medications: "medications",
  idg: "idg",
  documents: "documents",
  claims: "claims",
};

const TABS: {
  key: ChartTabKey;
  label: string;
  route: (id: string) => string;
}[] = [
  { key: "overview", label: "Overview", route: (id) => `/patients/${id}` },
  {
    key: "clinical",
    label: "Clinical",
    route: (id) => `/patients/${id}?view=clinical`,
  },
  {
    key: "election",
    label: "Election & Certification",
    route: (id) => `/patients/${id}/election-certification`,
  },
  {
    key: "assessments",
    label: "Assessments",
    route: (id) => `/patients/${id}/assessments`,
  },
  {
    key: "care-plans",
    label: "Plan of Care",
    route: (id) => `/patients/${id}/care-plan`,
  },
  { key: "orders", label: "Orders", route: (id) => `/patients/${id}/orders` },
  {
    key: "medications",
    label: "Medications",
    route: (id) => `/patients/${id}/medications`,
  },
  {
    key: "visits",
    label: "Visits",
    route: (id) => `/patients/${id}/encounters`,
  },
  { key: "idg", label: "IDG", route: (id) => `/patients/${id}/idg-history` },
  {
    key: "documents",
    label: "Documents",
    route: (id) => `/patients/${id}/documents`,
  },
  { key: "claims", label: "Claims", route: (id) => `/patients/${id}/claims` },
  // Rendered as PatientConversationLink (opens this patient's care-team conversation); route is the href fallback.
  { key: "communication", label: "Communication", route: () => "/messaging" },
];

export function ChartModuleRail({
  patientId,
  current,
}: {
  patientId: string;
  current: ChartSection;
}): JSX.Element {
  const active = SECTION_TAB[current];
  const conversation = useOpenPatientConversation(patientId);
  return (
    <nav className="wx-chart-tabs wx-no-scrollbar" aria-label="Patient chart">
      <ul>
        {TABS.map((tab) => {
          const isActive = tab.key === active;
          return (
            <li key={tab.key}>
              {tab.key === "communication" ? (
                <PatientConversationLink
                  patientId={patientId}
                  conversation={conversation}
                  className={isActive ? "wx-chart-tab active" : "wx-chart-tab"}
                  aria-current={isActive ? "page" : undefined}
                >
                  {tab.label}
                </PatientConversationLink>
              ) : (
                <Link
                  to={tab.route(patientId)}
                  className={isActive ? "wx-chart-tab active" : "wx-chart-tab"}
                  aria-current={isActive ? "page" : undefined}
                >
                  {tab.label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
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
        {current && patientId ? <ChartModuleRail patientId={patientId} current={current} /> : null}
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
