// M36 WP 3.3 - SBAR platform floor, the shared write-time validator and the read accessor.
// Pure and dependency-free: the web form and the server both call `validateSbar`; the server is authoritative.
// The node itself, its labels and its sanitiser live in messaging-rich-body.ts.

import {
  type RichBody,
  SBAR_SECTION_KEYS,
  type SbarSectionKey,
  type SbarUrgencyHint,
  richBlocksToPlainText,
} from "./messaging-rich-body";

export {
  SBAR_SECTION_KEYS,
  SBAR_SECTION_LABELS,
  SBAR_URGENCY_HINTS,
  type SbarSectionKey,
  type SbarUrgencyHint,
} from "./messaging-rich-body";

/** Longest section, measured on its trimmed plain-text projection. */
export const SBAR_MAX_SECTION_CHARS = 2000;

/** What a tenant may only tighten: smallest per-section length, and whether a patient channel is required. */
export interface EffectiveSbarPolicy {
  readonly minChars: Readonly<Record<SbarSectionKey, number>>;
  readonly requirePatientChannel: boolean;
  /** Per-section guidance text; display only, never validated against or projected. */
  readonly hints: Readonly<Partial<Record<SbarSectionKey, string>>>;
}

export const SBAR_PLATFORM_FLOOR = {
  minChars: { situation: 1, background: 1, assessment: 1, recommendation: 1 },
  requirePatientChannel: false,
} as const satisfies Pick<EffectiveSbarPolicy, "minChars" | "requirePatientChannel">;

export interface SbarSections {
  readonly urgencyHint: SbarUrgencyHint;
  readonly sections: Readonly<Record<SbarSectionKey, string>>;
}

/** The SBAR content of a body (trimmed per-section text), or null when the body is not an SBAR message. */
export function richBodySbar(body: RichBody): SbarSections | null {
  const block = body.doc.content[0];
  if (block?.type !== "sbar") return null;
  const sections = {} as Record<SbarSectionKey, string>;
  for (const key of SBAR_SECTION_KEYS) sections[key] = richBlocksToPlainText(block[key]);
  return { urgencyHint: block.urgencyHint, sections };
}

export interface SbarIssue {
  /** `sbar.<section>` */
  readonly field: `sbar.${SbarSectionKey}`;
  readonly code: "REQUIRED" | "TOO_SHORT" | "TOO_LONG";
  /** Never contains any of the message text. */
  readonly message: string;
}

/**
 * Length check of every section against the policy. Empty array = valid (also for a body that is not SBAR: callers
 * decide whether SBAR is expected). The policy minimum is raised to the platform floor here too, so a caller that
 * passes a lower value cannot go under it.
 */
export function validateSbar(body: RichBody, policy: EffectiveSbarPolicy): SbarIssue[] {
  const sbar = richBodySbar(body);
  if (sbar === null) return [];
  const issues: SbarIssue[] = [];
  for (const key of SBAR_SECTION_KEYS) {
    const field = `sbar.${key}` as const;
    const length = sbar.sections[key].length;
    const min = Math.max(policy.minChars[key], SBAR_PLATFORM_FLOOR.minChars[key]);
    if (length === 0) issues.push({ field, code: "REQUIRED", message: "is required" });
    else if (length < min)
      issues.push({ field, code: "TOO_SHORT", message: `must be at least ${min} characters` });
    else if (length > SBAR_MAX_SECTION_CHARS)
      issues.push({
        field,
        code: "TOO_LONG",
        message: `must be at most ${SBAR_MAX_SECTION_CHARS} characters`,
      });
  }
  return issues;
}
