// Storybook (R0.5) — Tier-2 layouts (@chartwarden/ui), filled with realistic Lantern content so future
// screens compose on-system by construction. A sample of the foundational patterns.
import {
  CountdownChip,
  FilterBar,
  GuardChip,
  KpiCard,
  KpiStrip,
  PageHeader,
  RightDetailPanel,
  WorkQueueLayout,
} from "@chartwarden/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { JSX } from "react";

const meta: Meta = { title: "Lantern/Layouts", parameters: { layout: "fullscreen" } };
export default meta;

function Frame({ children }: { children: JSX.Element }): JSX.Element {
  return (
    <div style={{ height: "100vh", background: "var(--color-background)", display: "flex" }}>
      {children}
    </div>
  );
}

const cell = { padding: "0.5rem 0.75rem", fontSize: "0.8125rem" } as const;

export const WorkQueue: StoryObj = {
  name: "Work Queue",
  render: () => (
    <Frame>
      <WorkQueueLayout
        header={<PageHeader title="Cosignature Queue" />}
        kpis={
          <KpiStrip>
            <KpiCard label="Awaiting cosign" value="18" />
            <KpiCard label="Overdue" value="4" />
            <KpiCard label="Signed today" value="31" />
          </KpiStrip>
        }
        filters={
          <FilterBar>
            <input placeholder="Search…" />
          </FilterBar>
        }
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
