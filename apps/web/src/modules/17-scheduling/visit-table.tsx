// apps/web/src/modules/17-scheduling — the shared visit table the day/week/my-visits read screens render
// (M17 §5.1, Track B / ADR-0030). One row per visit: scheduled window, purpose, clinician, status chip. Status
// colors are paired with the text label (WCAG §5.4 — never color-only). Leaves only (@wardenx/ui shapes).
import type { JSX } from "react";

/** §4.1 visit projection the §5.1 read screens render (a subset of the typed `VisitView`). */
export interface VisitRow {
  id: string;
  patientId: string;
  assignedMembershipId: string;
  visitPurpose: string;
  scheduledStartedAt: string;
  scheduledEndedAt: string;
  status: string;
}

/** §2.2.1 visit-state → display color (color-blind-safe; always shown with the text label, §5.4). */
export const VISIT_STATUS_COLOR: Record<string, string | undefined> = {
  proposed: "#6b7280",
  published: "#1d4ed8",
  en_route: "#b45309",
  in_visit: "#15803d",
  completed: "#6b7280",
  cancelled: "#b91c1c",
  no_show: "#b91c1c",
  rescheduled: "#6b7280",
};

const ts = (v: string): string => v.slice(0, 16).replace("T", " ");

export function VisitRows({
  visits,
  onSelect,
  colorMap,
}: {
  visits: readonly VisitRow[];
  onSelect: (visitId: string) => void;
  colorMap: Record<string, string | undefined>;
}): JSX.Element {
  return (
    <table style={table}>
      <thead>
        <tr style={tr}>
          <th style={th}>Start</th>
          <th style={th}>End</th>
          <th style={th}>Purpose</th>
          <th style={th}>Clinician</th>
          <th style={th}>Status</th>
        </tr>
      </thead>
      <tbody>
        {visits.map((v) => (
          <tr
            key={v.id}
            onClick={() => onSelect(v.id)}
            style={{ cursor: "pointer", borderTop: "1px solid #f3f4f6" }}
          >
            <td style={td}>{ts(v.scheduledStartedAt)}</td>
            <td style={td}>{ts(v.scheduledEndedAt)}</td>
            <td style={td}>{v.visitPurpose}</td>
            <td style={mono}>{v.assignedMembershipId.slice(0, 8)}</td>
            <td style={{ ...td, color: colorMap[v.status] }}>{v.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const table = { width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" } as const;
const tr = { textAlign: "left", color: "#6b7280" } as const;
const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
const mono = { ...td, fontFamily: "monospace", fontSize: "0.8rem" } as const;
