import { PatientWorkspaceLayout } from "@chartwarden/ui";
import { type JSX, type ReactNode, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { PatientConversationLink, useOpenPatientConversation } from "./open-patient-conversation";
// apps/web/src/shell — the patient-chart tab strip, shared by every patient-scoped workspace screen
// (Care Plan, Orders, Assessments, …) so it is defined once. The primary strip groups the workspace
// into six stable areas; a contextual secondary strip preserves every existing patient destination.
// Callers still render <ChartModuleRail> as the first child of their workspace row, so no patient
// screen or route has to change its markup.

export type ChartSection =
  | "summary"
  | "clinical"
  | "demographics"
  | "addresses"
  | "coverage"
  | "care-team"
  | "hope"
  | "privacy"
  | "code-status"
  | "care-plan"
  | "discipline-plans"
  | "encounters"
  | "assessments"
  | "orders"
  | "medications"
  | "documents"
  | "election"
  | "signatures"
  | "idg"
  | "claims"
  | "communication";

type ChartGroupKey =
  | "overview"
  | "patient-details"
  | "clinical"
  | "documents"
  | "communication"
  | "more";

// Every existing chart section stays addressable at its current route. This map changes only the
// presentation: the former thirteen-item strip is grouped into six stable patient-workspace areas.
const SECTION_GROUP: Record<ChartSection, ChartGroupKey> = {
  summary: "overview",
  demographics: "patient-details",
  addresses: "patient-details",
  coverage: "patient-details",
  "care-team": "patient-details",
  privacy: "more",
  "code-status": "clinical",
  election: "more",
  clinical: "clinical",
  hope: "clinical",
  assessments: "clinical",
  "care-plan": "clinical",
  "discipline-plans": "clinical",
  encounters: "clinical",
  orders: "clinical",
  medications: "clinical",
  idg: "clinical",
  documents: "documents",
  signatures: "documents",
  claims: "more",
  communication: "communication",
};

const GROUPS: {
  key: ChartGroupKey;
  label: string;
  route: (id: string) => string;
}[] = [
  { key: "overview", label: "Overview", route: (id) => `/patients/${id}` },
  {
    key: "patient-details",
    label: "Patient details",
    route: (id) => `/patients/${id}?view=demographics`,
  },
  {
    key: "clinical",
    label: "Clinical",
    route: (id) => `/patients/${id}?view=clinical`,
  },
  {
    key: "documents",
    label: "Documents",
    route: (id) => `/patients/${id}/documents`,
  },
  // Rendered as PatientConversationLink (opens this patient's care-team conversation); route is the href fallback.
  { key: "communication", label: "Communication", route: () => "/messaging" },
  {
    key: "more",
    label: "More",
    route: (id) => `/patients/${id}/election-certification`,
  },
];

type SectionLink = {
  key: ChartSection;
  label: string;
  route: (id: string) => string;
};

const GROUP_SECTIONS: Partial<Record<ChartGroupKey, SectionLink[]>> = {
  "patient-details": [
    {
      key: "demographics",
      label: "Demographics & identifiers",
      route: (id) => `/patients/${id}?view=demographics`,
    },
    { key: "addresses", label: "Addresses", route: (id) => `/patients/${id}?view=addresses` },
    { key: "coverage", label: "Coverage", route: (id) => `/patients/${id}?view=coverage` },
    { key: "care-team", label: "Care team", route: (id) => `/patients/${id}?view=care-team` },
  ],
  clinical: [
    { key: "clinical", label: "Clinical summary", route: (id) => `/patients/${id}?view=clinical` },
    { key: "assessments", label: "Assessments", route: (id) => `/patients/${id}/assessments` },
    { key: "hope", label: "HOPE assessments", route: (id) => `/patients/${id}/hope` },
    { key: "care-plan", label: "Plan of care", route: (id) => `/patients/${id}/care-plan` },
    {
      key: "discipline-plans",
      label: "Discipline plans",
      route: (id) => `/patients/${id}/discipline-plans`,
    },
    { key: "orders", label: "Orders", route: (id) => `/patients/${id}/orders` },
    { key: "medications", label: "Medications", route: (id) => `/patients/${id}/medications` },
    { key: "encounters", label: "Visits", route: (id) => `/patients/${id}/encounters` },
    { key: "idg", label: "IDG", route: (id) => `/patients/${id}/idg-history` },
    {
      key: "code-status",
      label: "Code status",
      route: (id) => `/patients/${id}?view=code-status`,
    },
  ],
  documents: [
    { key: "documents", label: "Documents", route: (id) => `/patients/${id}/documents` },
    { key: "signatures", label: "Signatures", route: (id) => `/patients/${id}/signatures` },
  ],
  more: [
    {
      key: "election",
      label: "Election & certification",
      route: (id) => `/patients/${id}/election-certification`,
    },
    { key: "privacy", label: "Privacy", route: (id) => `/patients/${id}?view=privacy` },
    { key: "claims", label: "Claims", route: (id) => `/patients/${id}/claims` },
  ],
};

export function ChartModuleRail({
  patientId,
  current,
}: {
  patientId: string;
  current: ChartSection;
}): JSX.Element {
  const activeGroup = SECTION_GROUP[current];
  const sectionLinks = GROUP_SECTIONS[activeGroup] ?? [];
  const conversation = useOpenPatientConversation(patientId);
  const primaryNav = useRef<HTMLElement>(null);
  const secondaryNav = useRef<HTMLElement>(null);
  // Both strips can scroll on a narrow viewport; keep the active group and destination visible.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the active keys are the triggers
  useEffect(() => {
    primaryNav.current
      ?.querySelector<HTMLElement>("[aria-current='page']")
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    secondaryNav.current
      ?.querySelector<HTMLElement>("[aria-current='page']")
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeGroup, current]);
  return (
    <>
      <nav ref={primaryNav} className="wx-chart-tabs" aria-label="Patient chart">
        <ul>
          {GROUPS.map((group) => {
            const isActive = group.key === activeGroup;
            return (
              <li key={group.key}>
                {group.key === "communication" ? (
                  <PatientConversationLink
                    patientId={patientId}
                    conversation={conversation}
                    className={isActive ? "wx-chart-tab active" : "wx-chart-tab"}
                    aria-current={isActive ? "page" : undefined}
                  >
                    {group.label}
                  </PatientConversationLink>
                ) : (
                  <Link
                    to={group.route(patientId)}
                    className={isActive ? "wx-chart-tab active" : "wx-chart-tab"}
                    aria-current={isActive ? "page" : undefined}
                  >
                    {group.label}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
      {sectionLinks.length > 0 ? (
        <nav
          ref={secondaryNav}
          className="wx-chart-subtabs"
          aria-label={`${GROUPS.find((group) => group.key === activeGroup)?.label ?? "Chart"} sections`}
        >
          <ul>
            {sectionLinks.map((section) => {
              const isActive = section.key === current;
              return (
                <li key={section.key}>
                  <Link
                    to={section.route(patientId)}
                    className={isActive ? "wx-chart-subtab active" : "wx-chart-subtab"}
                    aria-current={isActive ? "page" : undefined}
                  >
                    {section.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}
    </>
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
