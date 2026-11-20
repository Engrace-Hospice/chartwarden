// apps/web/src/modules/09-assessments/wounds — how a wound and its observations read on screen. Pure: nothing here
// decides a clinical fact, it only words what the server computed (area, percent change) and recorded.
import type { StatusTone } from "@chartwarden/ui";
import { shortDate } from "../../../shell/short-date";
import {
  CORRECTION_REASON_LABELS,
  DRESSING_LABELS,
  EXUDATE_AMOUNT_LABELS,
  EXUDATE_TYPE_LABELS,
  ODOR_LABELS,
  PERIWOUND_LABELS,
  STAGE_LABELS,
  TREND_LABELS,
  WOUND_BED_LABELS,
} from "./wound-labels";
import type { WoundObservation, WoundStatus, WoundTrend } from "./wounds-api";

export { shortDate };

/** "Nov 19, 2026, 2:30 PM" from an ISO instant. */
export function shortDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const oneDecimal = (n: number): string => n.toFixed(1);
/** Area has two decimals at most; trailing zeros are dropped ("6", "5.25"). */
const areaText = (n: number): string => `${Number(n.toFixed(2))} cm²`;

/** "3.0 × 2.0 × 0.5 cm", or "3.0 × 2.0 cm" without a depth; null when there is no length and width. */
export function measurementText(
  o: Pick<WoundObservation, "lengthCm" | "widthCm" | "depthCm">,
): string | null {
  if (o.lengthCm === null || o.widthCm === null) return null;
  const parts = [o.lengthCm, o.widthCm, ...(o.depthCm === null ? [] : [o.depthCm])];
  return `${parts.map(oneDecimal).join(" × ")} cm`;
}

/** The measurement with the server-computed area: "3.0 × 2.0 cm (area 6 cm²)". */
export function measurementWithArea(o: WoundObservation): string | null {
  const size = measurementText(o);
  if (size === null) return null;
  return o.areaCm2 === null ? size : `${size} (area ${areaText(o.areaCm2)})`;
}

/** "−25.0% against Nov 12, 2026" (the area against the last earlier measured visit); null when there is no earlier one. */
export function areaChangeText(o: WoundObservation): string | null {
  if (o.areaChangePercent === null || o.areaChangeSinceObservedAt === null) return null;
  const p = o.areaChangePercent;
  const sign = p > 0 ? "+" : p < 0 ? "−" : "";
  return `${sign}${Math.abs(p).toFixed(1)}% against ${shortDate(o.areaChangeSinceObservedAt)}`;
}

const list = (labels: readonly string[]): string => labels.join(", ");

/** One labelled fact of an observation. */
export interface ObservationRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

const yesNo = (v: boolean | null): string | null => (v === null ? null : v ? "Yes" : "No");

/**
 * The facts an observation records, in reading order, leaving out what was not recorded. The same rows the history
 * drawer and the visit note's wound panel show, so the two never word one observation differently.
 */
export function observationRows(o: WoundObservation): ObservationRow[] {
  const drainage = [
    o.exudateAmount ? EXUDATE_AMOUNT_LABELS[o.exudateAmount] : null,
    o.exudateType ? EXUDATE_TYPE_LABELS[o.exudateType].toLowerCase() : null,
  ].filter((part): part is string => part !== null);
  const dressing = o.dressing
    ? `${DRESSING_LABELS[o.dressing]}${o.dressingChanged === true ? " (changed at this visit)" : o.dressingChanged === false ? " (not changed)" : ""}`
    : null;
  const candidates: [string, string, string | null][] = [
    ["stage", "Stage", o.stage ? STAGE_LABELS[o.stage] : null],
    ["measurement", "Size", measurementWithArea(o)],
    ["change", "Change in area", areaChangeText(o)],
    ["undermining", "Undermining", yesNo(o.undermining)],
    [
      "bed",
      "Wound bed",
      o.woundBed.length > 0 ? list(o.woundBed.map((t) => WOUND_BED_LABELS[t])) : null,
    ],
    ["drainage", "Drainage", drainage.length > 0 ? list(drainage) : null],
    ["odor", "Odor", o.odor ? ODOR_LABELS[o.odor] : null],
    [
      "periwound",
      "Skin around the wound",
      o.periwound.length > 0 ? list(o.periwound.map((c) => PERIWOUND_LABELS[c])) : null,
    ],
    ["pain", "Pain", o.painScore === null ? null : `${o.painScore} out of 10`],
    ["dressing", "Dressing", dressing],
    ["infection", "Signs of infection", yesNo(o.infectionSigns)],
    ["trend", "Trend", o.trend ? TREND_LABELS[o.trend] : null],
    [
      "correction",
      "Corrects an earlier entry",
      o.correctionReason ? CORRECTION_REASON_LABELS[o.correctionReason] : null,
    ],
  ];
  return candidates.flatMap(([key, label, value]) =>
    value === null ? [] : [{ key, label, value }],
  );
}

export const TREND_TONE: Readonly<Record<WoundTrend, StatusTone>> = {
  new: "progress",
  improving: "success",
  stable: "neutral",
  worsening: "error",
};

export const STATUS_TONE: Readonly<Record<WoundStatus, StatusTone>> = {
  open: "progress",
  healed: "success",
  resolved_other: "neutral",
};
