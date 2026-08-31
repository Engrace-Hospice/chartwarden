import { StatusPill } from "@wardenx/ui";
// apps/web/src/modules/17-scheduling — the shared visit table the day/week/my-visits read screens render
// (M17 §5.1, Track B / ADR-0030). One row per visit: scheduled window, purpose, clinician, §6.6 status pill.
// Reconciled to Lantern (R1): No-Line table, mono clinician id, keyboard-actionable rows. Leaves only.
import type { JSX } from "react";
import { VISIT_TONE, stateLabel } from "./scheduling-status";

/** §4.1 visit projection the §5.1 read screens render (a subset of the typed `VisitView`). */
export interface VisitRow {
  id: string;
  patientId: string;
  admissionId?: string | null;
  assignedMembershipId: string;
  visitPurpose: string;
  scheduledStartedAt: string;
  scheduledEndedAt: string;
  status: string;
}

const ts = (v: string): string => v.slice(0, 16).replace("T", " ");

export function VisitRows({
  visits,
  onSelect,
}: {
  visits: readonly VisitRow[];
  onSelect: (visitId: string) => void;
}): JSX.Element {
  return (
    <table>
      <thead>
        <tr>
          <th>Start</th>
          <th>End</th>
          <th>Purpose</th>
          <th>Clinician</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {visits.map((v) => (
          <tr
            key={v.id}
            // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
            role="button"
            tabIndex={0}
            onClick={() => onSelect(v.id)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                onSelect(v.id);
              }
            }}
            style={{ cursor: "pointer" }}
          >
            <td className="tabular-nums">{ts(v.scheduledStartedAt)}</td>
            <td className="tabular-nums">{ts(v.scheduledEndedAt)}</td>
            <td>{stateLabel(v.visitPurpose)}</td>
            <td className="wx-data-md">{v.assignedMembershipId.slice(0, 8)}</td>
            <td>
              <StatusPill label={stateLabel(v.status)} tone={VISIT_TONE[v.status] ?? "neutral"} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
