// M36 WP 2.8 - saved replies (message templates): the shapes the web reads and the one place their wording lives.
// The server is authoritative for every rule (PHI lint, platform floor, ownership); the web only presents them.

export type TemplateScope = "platform" | "org" | "personal";

export const TEMPLATE_CATEGORIES = [
  "scheduling",
  "administrative",
  "logistics",
  "confirmation",
  "general",
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export interface SavedReply {
  readonly id: string;
  readonly scope: TemplateScope;
  readonly templateKey: string | null;
  readonly category: TemplateCategory;
  readonly title: string;
  readonly body: string;
  readonly customized: boolean;
}

export interface PlatformReplyAdmin {
  readonly id: string;
  readonly templateKey: string;
  readonly category: TemplateCategory;
  readonly floorTitle: string;
  readonly floorBody: string;
  readonly requiredPhrases: readonly string[];
  readonly overlay: {
    readonly title: string | null;
    readonly body: string | null;
    readonly isEnabled: boolean;
    readonly updatedAt: string;
  } | null;
}

export interface ReplyDraft {
  readonly title: string;
  readonly body: string;
  readonly category: TemplateCategory;
}

export const CATEGORY_LABEL: Readonly<Record<TemplateCategory, string>> = {
  scheduling: "Scheduling",
  administrative: "Administrative",
  logistics: "Logistics",
  confirmation: "Confirmation",
  general: "General",
};

export const SCOPE_LABEL: Readonly<Record<TemplateScope, string>> = {
  platform: "Platform",
  org: "Organization",
  personal: "Personal",
};

/**
 * The text a refused save shows. A 422 carries the field and a reason per finding ("looks like a phone number");
 * it never carries the text that triggered it, so joining the details is safe to render.
 */
export function savedReplyErrorText(error: unknown, fallback: string): string {
  const envelope = (error as { error?: { message?: unknown; details?: unknown } } | null)?.error;
  const message = typeof envelope?.message === "string" ? envelope.message : "";
  const details = Array.isArray(envelope?.details) ? envelope.details : [];
  const reasons = details
    .map((d) => {
      const detail = d as { field?: unknown; message?: unknown };
      if (typeof detail.message !== "string") return "";
      return typeof detail.field === "string"
        ? `${detail.field} ${detail.message}`
        : detail.message;
    })
    .filter(Boolean);
  if (message && reasons.length > 0) return `${message} (${reasons.join("; ")})`;
  return message || fallback;
}
