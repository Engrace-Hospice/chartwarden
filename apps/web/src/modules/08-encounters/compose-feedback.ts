// apps/web/src/modules/08-encounters — what the composer tells the author when a save or a finalize is refused (or the connection drops):
// the banner's tone, title and words. The server decides every refusal; this only words it (extracted from encounter-compose.tsx).
import type { WriteResult } from "./encounters-api";

export const humanize = (k: string): string =>
  k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export type UiFeedback = {
  tone: "success" | "error" | "warning";
  title: string;
  message: string;
  field?: string;
};

export function feedbackFor(result: Extract<WriteResult<unknown>, { ok: false }>): UiFeedback {
  if (result.code === "STALE_VERSION")
    return {
      tone: "warning",
      title: "This visit note changed",
      message:
        "The note was updated after you opened it. Reload the latest version before continuing.",
    };
  if (result.code === "COMPLIANCE_GATE_UNAVAILABLE" || result.code === "DRAFT_UNAVAILABLE")
    return {
      tone: "error",
      title: "The draft could not be checked",
      message:
        "The visit-note draft could not be checked right now. The note was not finalized. Try again in a moment.",
    };
  const first = Array.isArray(result.details) ? result.details[0] : result.details;
  const field =
    first && typeof first === "object" && typeof (first as { field?: unknown }).field === "string"
      ? (first as { field: string }).field
      : undefined;
  return {
    tone: "error",
    title: "Action needed",
    message: readableValidation(result.details, result.message),
    field,
  };
}

export const transportFeedback: UiFeedback = {
  tone: "error",
  title: "Connection interrupted",
  message: "The connection was interrupted. Your changes are still here; try again.",
};

const VITAL_LABELS: Record<string, string> = {
  bpSystolic: "Systolic blood pressure",
  bpDiastolic: "Diastolic blood pressure",
  heartRate: "Heart rate",
  respiratoryRate: "Respiratory rate",
  temperature: "Temperature",
  spo2: "SpO₂",
  painScore: "Pain score",
};

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
