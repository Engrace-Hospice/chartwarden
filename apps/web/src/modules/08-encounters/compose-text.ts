// apps/web/src/modules/08-encounters — the words the visit-note composer and its vitals panel share: a wire code as a label, a server
// validation detail as one sentence, and the line for a dropped connection.

export const humanize = (k: string): string =>
  k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export const TRANSPORT_MESSAGE =
  "The connection was interrupted. Your changes are still here; try again.";

const VITAL_LABELS: Record<string, string> = {
  bpSystolic: "Systolic blood pressure",
  bpDiastolic: "Diastolic blood pressure",
  heartRate: "Heart rate",
  respiratoryRate: "Respiratory rate",
  temperature: "Temperature",
  spo2: "SpO₂",
  painScore: "Pain score",
};

/** The first 422 detail as one sentence ("Heart rate: must be at most 300"), or `fallback` when the answer names none. */
export function readableValidation(details: unknown, fallback: string): string {
  const first = Array.isArray(details) ? details[0] : details;
  if (first && typeof first === "object") {
    const item = first as { field?: unknown; message?: unknown };
    const field =
      typeof item.field === "string" ? (VITAL_LABELS[item.field] ?? humanize(item.field)) : null;
    if (typeof item.message === "string") return field ? `${field}: ${item.message}` : item.message;
  }
  return fallback;
}
