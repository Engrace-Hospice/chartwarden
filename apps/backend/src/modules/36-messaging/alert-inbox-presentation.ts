import type { AlertCategory } from "@wardenx/messaging";

const CATEGORY_LABEL: Record<AlertCategory, string> & Readonly<Record<string, string>> = {
  clinical_urgent: "Urgent clinical alert",
  clinical_routine: "Clinical alert",
  operational: "Operational alert",
  field_safety: "Field-safety alert",
  administrative: "Administrative notice",
  system: "System notice",
};

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Accept only an unmodified absolute-path reference on the current WardenX origin. */
export function normalizeAlertDeepLink(value: unknown): string | null {
  if (typeof value !== "string" || value !== value.trim()) return null;
  if (value === "/" || !value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\") || hasControlCharacter(value)) return null;
  return value;
}

/** Project the two safe, user-facing fields from an otherwise private alert payload. */
export function projectAlertInboxPresentation(
  payload: unknown,
  category: string,
): { summary: string; deepLink: string | null } {
  const record = payloadRecord(payload);
  const message = record?.message;
  const normalizedMessage = typeof message === "string" ? message.trim() : "";

  return {
    summary: normalizedMessage || CATEGORY_LABEL[category] || "Notification",
    deepLink: normalizeAlertDeepLink(record?.deepLink),
  };
}
