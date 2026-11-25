// apps/web/src/modules/08-encounters/next-visit — the optional structured fields of the "Plan and Next Visit" section, and the fixed
// sentences they assemble into. Pure and deterministic: the same fields give the same lines, and each field's text is the clinician's own,
// trimmed and otherwise untouched. The lines are ADDED to the section's free text (which the server stores and states verbatim), so the
// note, its preview and the gate that counts the section need nothing new: the structure is a way to write the entry, not a second record.

export interface PlanEntryFields {
  /** The discipline the next visit is with (a `PLAN_VISIT_BY_OPTIONS` value), or "" when not stated. */
  readonly nextVisitBy: string;
  /** The day of the next visit, `YYYY-MM-DD`, or "" when not stated. */
  readonly nextVisitDate: string;
  readonly nextVisitFocus: string;
  readonly followUps: string;
  readonly pendingOrders: string;
  readonly teaching: string;
  readonly whenToCall: string;
}

export const EMPTY_PLAN_ENTRY: PlanEntryFields = {
  nextVisitBy: "",
  nextVisitDate: "",
  nextVisitFocus: "",
  followUps: "",
  pendingOrders: "",
  teaching: "",
  whenToCall: "",
};

export const PLAN_VISIT_BY_OPTIONS: readonly { readonly value: string; readonly label: string }[] =
  [
    { value: "rn", label: "RN" },
    { value: "lpn", label: "LPN" },
    { value: "chha", label: "Hospice aide" },
    { value: "msw", label: "Social worker" },
    { value: "chaplain", label: "Chaplain" },
    { value: "md_np", label: "Physician or NP" },
    { value: "volunteer", label: "Volunteer" },
    { value: "pt", label: "PT" },
    { value: "ot", label: "OT" },
    { value: "slp", label: "Speech therapist" },
  ];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `YYYY-MM-DD` as `Mon D, YYYY`, or null when it is not a real calendar day. A fixed form: it must not follow the reader's locale. */
function dayLabel(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const real = new Date(Date.UTC(year, month - 1, day));
  const valid =
    real.getUTCFullYear() === year && real.getUTCMonth() === month - 1 && real.getUTCDate() === day;
  return valid ? `${MONTHS[month - 1]} ${day}, ${year}` : null;
}

const byLabel = (value: string): string | null =>
  PLAN_VISIT_BY_OPTIONS.find((option) => option.value === value)?.label ?? null;

/** The note's sentences for the fields that were filled in, in a fixed order. */
export function planEntryLines(fields: PlanEntryFields): readonly string[] {
  const lines: string[] = [];
  const by = byLabel(fields.nextVisitBy);
  const day = dayLabel(fields.nextVisitDate);
  if (by !== null || day !== null) {
    lines.push(`Next visit: ${[by, day].filter((part) => part !== null).join(", ")}.`);
  }
  const own: readonly (readonly [string, string])[] = [
    ["Focus of next visit", fields.nextVisitFocus],
    ["Follow-ups from this visit", fields.followUps],
    ["Orders and supplies pending", fields.pendingOrders],
    ["Teaching and instructions given", fields.teaching],
    ["Call the hospice if", fields.whenToCall],
  ];
  for (const [label, words] of own) {
    const trimmed = words.trim();
    if (trimmed.length > 0) lines.push(`${label}: ${trimmed}`);
  }
  return lines;
}

export const planEntryText = (fields: PlanEntryFields): string => planEntryLines(fields).join("\n");

/**
 * `addition` placed below what the clinician already wrote, which is left exactly as typed. Adding lines already in the text adds
 * nothing, so pressing the button twice does not state the plan twice.
 */
export function appendToFreeText(existing: string, addition: string): string {
  if (addition.trim().length === 0) return existing;
  if (existing.trim().length === 0) return addition;
  if (existing.includes(addition)) return existing;
  return existing.endsWith("\n") ? `${existing}${addition}` : `${existing}\n${addition}`;
}
