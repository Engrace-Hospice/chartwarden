// Storybook (R0.5) — Tier-2 layouts (@wardenx/ui), filled with realistic Lantern content so future
// screens compose on-system by construction. A sample of the foundational + domain patterns.
import {
  CountdownChip,
  FilterBar,
  GuardChip,
  KpiCard,
  KpiStrip,
  MarGridLayout,
  PageHeader,
  PatientBanner,
  PortalDashboardLayout,
  RightDetailPanel,
  SchedulingCalendarLayout,
  WorkQueueLayout,
} from "@wardenx/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { JSX } from "react";

const meta: Meta = { title: "Lantern/Layouts", parameters: { layout: "fullscreen" } };
export default meta;

function Frame({ children }: { children: JSX.Element }): JSX.Element {
  return <div style={{ height: "100vh", background: "var(--color-background)", display: "flex" }}>{children}</div>;
}

const cell = { padding: "0.5rem 0.75rem", fontSize: "0.8125rem" } as const;

export const WorkQueue: StoryObj = {
  name: "Work Queue",
  render: () => (
    <Frame>
      <WorkQueueLayout
        header={<PageHeader title="Cosignature Queue" breadcrumb="Clinical · Encounters" />}
        kpis={
          <KpiStrip>
            <KpiCard label="Awaiting cosign" value="18" />
            <KpiCard label="Overdue" value="4" />
            <KpiCard label="Signed today" value="31" />
          </KpiStrip>
        }
        filters={<FilterBar><input placeholder="Search…" /></FilterBar>}
        table={
          <table>
            <thead>
              <tr>
                <th>Patient</th>
                <th>Note</th>
                <th>Author</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Eleanor Whitfield", "SN visit 06/22", "J. Okafor, RN", 6],
                ["Marcus Bell", "PT eval 06/21", "T. Nguyen, PT", 30],
                ["Rosa Delgado", "MSW assessment", "K. Ito, MSW", -4],
              ].map(([p, n, a, h]) => (
                <tr key={p as string}>
                  <td style={cell}>{p}</td>
                  <td style={cell}>{n}</td>
                  <td style={cell}>{a}</td>
                  <td style={cell}>
                    <CountdownChip dueAt={new Date(Date.now() + (h as number) * 3_600_000)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        }
        detail={
          <RightDetailPanel title="Marcus Bell">
            <GuardChip reason="Author has not signed" onFix={() => {}} />
          </RightDetailPanel>
        }
      />
    </Frame>
  ),
};

export const MarGrid: StoryObj = {
  name: "MAR Grid",
  render: () => (
    <Frame>
      <MarGridLayout
        banner={<PatientBanner name="Eleanor Whitfield" mrn="MRN-0042817" dob="1939-03-12" codeStatus="DNR" />}
        windowControls={<FilterBar actions={<button type="button">Day view</button>}><strong>Day shift · 06/24</strong></FilterBar>}
        grid={
          <table>
            <thead>
              <tr>
                <th>Medication</th>
                <th>08:00</th>
                <th>12:00</th>
                <th>16:00</th>
                <th>20:00</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Morphine 5 mg PO", "✓ Given", "Due", "—", "—"],
                ["Lorazepam 0.5 mg", "✓ Given", "✓ Given", "Due", "—"],
                ["Senna 8.6 mg", "Missed", "—", "Due", "—"],
              ].map((row) => (
                <tr key={row[0]}>
                  {row.map((c, i) => (
                    <td key={`${row[0]}-${i}`} style={cell}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        }
        detail={
          <RightDetailPanel title="12:00 · Morphine 5 mg">
            <p style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Scheduled dose. Record administration, hold, or refuse.
            </p>
          </RightDetailPanel>
        }
      />
    </Frame>
  ),
};

export const Scheduling: StoryObj = {
  name: "Scheduling Calendar",
  render: () => (
    <Frame>
      <SchedulingCalendarLayout
        header={<PageHeader title="Visit Calendar" actions={<><button type="button">Day</button><button type="button">Week</button><button type="button">Map</button></>} />}
        roster={
          <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <strong>Roster</strong>
            <span>J. Okafor, RN</span>
            <span>T. Nguyen, PT</span>
            <strong style={{ marginTop: "1rem" }}>Proposals</strong>
            <GuardChip reason="2 visits unassigned" onFix={() => {}} />
          </div>
        }
        calendar={<div style={{ padding: "1.5rem", color: "var(--color-on-surface-variant)" }}>Calendar grid (clinicians × time)…</div>}
        detail={<RightDetailPanel title="09:00 · E. Whitfield"><p>Route + conflicts.</p></RightDetailPanel>}
      />
    </Frame>
  ),
};

export const Portal: StoryObj = {
  name: "Portal Dashboard",
  render: () => (
    <Frame>
      <PortalDashboardLayout
        summary={<h1 style={{ fontFamily: "var(--font-display)", fontWeight: 500 }}>Good afternoon, Sarah</h1>}
        safety={<strong style={{ color: "var(--color-alert)" }}>Need help now? Call the 24/7 care line: (800) 555-0142</strong>}
      >
        {["Your care team", "Next visit — Thu 10:00 AM", "Messages (1 new)", "Documents to review (2)"].map((c) => (
          <div key={c} style={{ background: "var(--color-surface-lowest)", borderRadius: "1rem", boxShadow: "var(--shadow-soft)", padding: "1.5rem", fontSize: "1.0625rem" }}>
            {c}
          </div>
        ))}
      </PortalDashboardLayout>
    </Frame>
  ),
};
