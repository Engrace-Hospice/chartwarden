import { StatusPill, type StatusTone } from "@chartwarden/ui";
// apps/web/src/modules/18-evv — shared table + status-pill primitives the M18 §5.1 read screens render
// (Track B / ADR-0030, M18-T07). Reconciled to Lantern (R1): §6.6 StatusPill (tone maps grounded in the
// @chartwarden/types enums) + a No-Line, keyboard-actionable DataTable. Coordinate-free: the read screens never
// render lat/lng (D10 — coordinates need the separate evv.read_coords path).
import type { JSX, ReactNode } from "react";

// EvvEventGpsQuality = high | acceptable | degraded_attested | outside_geofence | no_geofence_baseline | suspected_spoof.
export const EVV_QUALITY_TONE: Record<string, StatusTone> = {
  high: "success",
  acceptable: "success",
  degraded_attested: "warning",
  outside_geofence: "error",
  no_geofence_baseline: "neutral",
  suspected_spoof: "error",
};

// EvvMissingResolutionStatus — `open` is the only billing-blocking state (ADR-0008) → error.
export const EVV_RESOLUTION_TONE: Record<string, StatusTone> = {
  open: "error",
  closed_clinician_attested: "success",
  closed_supervisor_override: "warning",
  closed_visit_voided: "neutral",
  closed_documented_at_encounter: "success",
  closed_system_checkout_received: "neutral",
};

// EvvAggregatorSubmissionStatus = pending | queued | submitting | submitted | accepted | rejected | timeout | cancelled.
export const EVV_SUBMISSION_TONE: Record<string, StatusTone> = {
  pending: "neutral",
  queued: "progress",
  submitting: "progress",
  submitted: "progress",
  accepted: "success",
  rejected: "error",
  timeout: "error",
  cancelled: "neutral",
};

// EvvDeviceStatus = pending_approval | approved | suspended | rejected | retired.
export const EVV_DEVICE_TONE: Record<string, StatusTone> = {
  pending_approval: "warning",
  approved: "success",
  suspended: "error",
  rejected: "error",
  retired: "neutral",
};

/** Title-case an underscore enum value, e.g. `degraded_attested` → `Degraded Attested`. */
export function stateLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Wrap an identifier value in the mono data voice (§3.1). */
export const mono = (v: ReactNode): JSX.Element => <span className="wx-data-md">{v}</span>;

/** A §6.6 status pill driven by a per-domain tone map. */
export function StatusChip({
  value,
  toneMap,
}: {
  value: string;
  toneMap: Record<string, StatusTone>;
}): JSX.Element {
  return <StatusPill label={stateLabel(value)} tone={toneMap[value] ?? "neutral"} />;
}

/** A minimal accessible table: one `<th scope=col>` header row + keyboard-actionable body rows. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onSelect,
}: {
  columns: ReadonlyArray<{ header: string; cell: (row: T) => ReactNode }>;
  rows: readonly T[];
  rowKey: (row: T) => string;
  onSelect?: (row: T) => void;
}): JSX.Element {
  return (
    <table>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.header} scope="col">
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) =>
          onSelect ? (
            <tr
              key={rowKey(r)}
              // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
              role="button"
              tabIndex={0}
              onClick={() => onSelect(r)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onSelect(r);
                }
              }}
              style={{ cursor: "pointer" }}
            >
              {columns.map((c) => (
                <td key={c.header}>{c.cell(r)}</td>
              ))}
            </tr>
          ) : (
            <tr key={rowKey(r)}>
              {columns.map((c) => (
                <td key={c.header}>{c.cell(r)}</td>
              ))}
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

/** Trim an ISO instant to `YYYY-MM-DD HH:MM` for compact display. */
export const ts = (v: string | null): string => (v ? v.slice(0, 16).replace("T", " ") : "—");
