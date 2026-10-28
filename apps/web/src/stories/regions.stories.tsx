// Storybook (R0.5) — Tier-1 layout regions (@chartwarden/ui). Visual reference for the shared zones
// every screen composes: header, KPI strip, patient banner, filter bar, detail panel, footer.
import {
  FilterBar,
  KpiCard,
  KpiStrip,
  PageHeader,
  PatientBanner,
  RightDetailPanel,
  StickyFooterActions,
} from "@chartwarden/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { JSX } from "react";

const meta: Meta = {
  title: "Lantern/Regions",
  parameters: { layout: "fullscreen" },
};
export default meta;

function Pad({ children }: { children: JSX.Element }): JSX.Element {
  return (
    <div style={{ background: "var(--color-background)", minHeight: "100vh" }}>{children}</div>
  );
}

export const PageHeaders: StoryObj = {
  name: "Page Header",
  render: () => (
    <Pad>
      <PageHeader
        title="Patient Census"
        breadcrumb="Clinical · Patients"
        actions={
          <>
            <button type="button">Export</button>
            <button type="button">Admit patient</button>
          </>
        }
      />
    </Pad>
  ),
};

export const Kpis: StoryObj = {
  name: "KPI Strip",
  render: () => (
    <Pad>
      <KpiStrip>
        <KpiCard label="Active census" value="142" onSelect={() => {}} />
        <KpiCard label="Pending admissions" value="7" onSelect={() => {}} />
        <KpiCard label="Unsigned notes" value="23" />
        <KpiCard label="Recerts due (7d)" value="5" />
      </KpiStrip>
    </Pad>
  ),
};

export const Banner: StoryObj = {
  name: "Patient Banner",
  render: () => (
    <Pad>
      <PatientBanner
        name="Eleanor Whitfield"
        mrn="MRN-0042817"
        dob="1939-03-12"
        codeStatus="DNR"
        allergies="Penicillin, Sulfa"
        benefitPeriod="BP3 · day 41"
      />
    </Pad>
  ),
};

export const Filters: StoryObj = {
  name: "Filter Bar",
  render: () => (
    <Pad>
      <FilterBar actions={<button type="button">Save view</button>}>
        <input placeholder="Search patients…" />
        <select>
          <option>All teams</option>
          <option>Team A</option>
        </select>
        <select>
          <option>All statuses</option>
          <option>Active</option>
        </select>
      </FilterBar>
    </Pad>
  ),
};

export const DetailPanel: StoryObj = {
  name: "Right Detail Panel",
  render: () => (
    <Pad>
      <div style={{ display: "flex", height: "100vh" }}>
        <div style={{ flex: 1, padding: "1.5rem", color: "var(--color-on-surface-variant)" }}>
          Work table…
        </div>
        <RightDetailPanel title="Eleanor Whitfield" onClose={() => {}}>
          <p style={{ color: "var(--color-on-surface-variant)" }}>
            Selected record detail renders here.
          </p>
        </RightDetailPanel>
      </div>
    </Pad>
  ),
};

export const Footer: StoryObj = {
  name: "Sticky Footer Actions",
  render: () => (
    <Pad>
      <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <div style={{ flex: 1, padding: "1.5rem", color: "var(--color-on-surface-variant)" }}>
          Form body…
        </div>
        <StickyFooterActions>
          <button type="button">Cancel</button>
          <button type="button">Save draft</button>
          <button type="button">Sign &amp; complete</button>
        </StickyFooterActions>
      </div>
    </Pad>
  ),
};
