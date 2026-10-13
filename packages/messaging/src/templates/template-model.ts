// @wardenx/messaging - message template model (M36 WP 2.8): types, write validation, the platform floor and the
// effective (platform + overlay) resolution. Pure: shared by the Drizzle service, the in-memory double and the routes.
//
// OWNERSHIP (decided in WP 2.8):
//   platform  - seeded by migration, read-only to every tenant, carries `requiredPhrases` (the floor).
//   org       - a shared template authored by the tenant (needs messaging.template.manage), visible to every sender.
//   personal  - a saved reply owned by one user, visible only to them.
// A tenant overlay re-words a PLATFORM template's title/body or disables it for the tenant. It can never change the
// category or the required phrases, cannot drop a required phrase, and is held to the same PHI lint. The floor is
// re-checked when the overlay is RESOLVED, not only when it is saved, so a stored overlay that no longer satisfies a
// (later tightened) floor silently falls back to the platform text instead of being served.
import { WardenXError } from "@wardenx/types";
import {
  PHI_FINDING_MESSAGES,
  PHI_LINT_VERSION,
  type PhiFindingCode,
  lintTemplateText,
  normalizeForLint,
  stripInvisibleCharacters,
} from "./phi-lint";

export { PHI_LINT_VERSION };

/** Non-clinical categories only. A clinical handoff category (SBAR) is Phase 3 and is deliberately absent. */
export const TEMPLATE_CATEGORIES = [
  "scheduling",
  "administrative",
  "logistics",
  "confirmation",
  "general",
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const TEMPLATE_SCOPES = ["platform", "org", "personal"] as const;
export type TemplateScope = (typeof TEMPLATE_SCOPES)[number];

export const TEMPLATE_LIMITS = {
  titleMax: 120,
  bodyMax: 2000,
  personalPerUser: 50,
  sharedPerOrg: 200,
} as const;

export interface PlatformTemplate {
  readonly id: string;
  readonly templateKey: string;
  readonly category: TemplateCategory;
  readonly title: string;
  readonly body: string;
  readonly requiredPhrases: readonly string[];
}

export interface TemplateOverlay {
  readonly templateId: string;
  readonly title: string | null;
  readonly body: string | null;
  readonly isEnabled: boolean;
}

/** What a picker (and the list route) sees. `body` is the text that is inserted into the composer. */
export interface TemplateView {
  readonly id: string;
  readonly scope: TemplateScope;
  readonly templateKey: string | null;
  readonly category: TemplateCategory;
  readonly title: string;
  readonly body: string;
  /** Platform templates only: a tenant overlay is being applied. */
  readonly customized: boolean;
}

function phiError(field: "title" | "body", codes: readonly PhiFindingCode[]): WardenXError {
  return new WardenXError(
    "TEMPLATE_PHI_DETECTED",
    "Saved replies must not contain patient identifiers.",
    422,
    codes.map((code) => ({ field, code: `PHI_${code}`, message: PHI_FINDING_MESSAGES[code] })),
  );
}

function shapeError(field: "title" | "body", message: string): WardenXError {
  return new WardenXError("VALIDATION_FAILED", "request validation failed", 422, [
    { field, code: "INVALID", message },
  ]);
}

function checkOne(field: "title" | "body", raw: string, max: number): string {
  // What is stored and shown is what was linted: invisible bidi/zero-width characters never reach a row.
  const text = stripInvisibleCharacters(raw).trim();
  if (text.length === 0) throw shapeError(field, `${field} must not be empty`);
  if (text.length > max) throw shapeError(field, `${field} must be at most ${max} characters`);
  const codes = lintTemplateText(text);
  if (codes.length > 0) throw phiError(field, codes);
  return text;
}

/** Trim, bound and PHI-lint a title and body. Throws 422 VALIDATION_FAILED or 422 TEMPLATE_PHI_DETECTED. */
export function validateTemplateText(input: { title: string; body: string }): {
  title: string;
  body: string;
} {
  return {
    title: checkOne("title", input.title, TEMPLATE_LIMITS.titleMax),
    body: checkOne("body", input.body, TEMPLATE_LIMITS.bodyMax),
  };
}

const matchForm = (text: string): string =>
  normalizeForLint(text).toLowerCase().replace(/\s+/g, " ");

/** True when an overlay body is set and drops a phrase the platform template requires. */
export function overlayViolatesFloor(
  platform: Pick<PlatformTemplate, "requiredPhrases">,
  overlay: { readonly body: string | null },
): boolean {
  if (overlay.body === null) return false;
  const haystack = matchForm(overlay.body);
  return platform.requiredPhrases.some((phrase) => !haystack.includes(matchForm(phrase)));
}

export function floorError(missing: readonly string[]): WardenXError {
  return new WardenXError(
    "TEMPLATE_FLOOR_VIOLATION",
    "This template must keep the platform's required wording.",
    422,
    missing.map((phrase) => ({
      field: "body",
      code: "REQUIRED_PHRASE_MISSING",
      message: `must keep the wording "${phrase}"`,
    })),
  );
}

/** Throws TEMPLATE_FLOOR_VIOLATION naming the missing required phrases (the phrases are platform text, not PHI). */
export function assertOverlayRespectsFloor(
  platform: Pick<PlatformTemplate, "requiredPhrases">,
  overlay: { readonly body: string | null },
): void {
  if (overlay.body === null) return;
  const haystack = matchForm(overlay.body);
  const missing = platform.requiredPhrases.filter((p) => !haystack.includes(matchForm(p)));
  if (missing.length > 0) throw floorError(missing);
}

const passesLint = (text: string): boolean => lintTemplateText(text).length === 0;

/**
 * The platform templates a tenant's senders see: each with its overlay applied where that overlay still satisfies the
 * floor and the lint, the platform text otherwise; a template the tenant disabled is omitted.
 */
export function effectiveForOrg(
  platform: readonly PlatformTemplate[],
  overlays: readonly TemplateOverlay[],
): TemplateView[] {
  const byTemplate = new Map(overlays.map((o) => [o.templateId, o] as const));
  const views: TemplateView[] = [];
  for (const base of platform) {
    const overlay = byTemplate.get(base.id);
    // A template with required wording (the emergency floor) is never hidden, even by an overlay stored before
    // that was refused at write time.
    if (overlay && !overlay.isEnabled && base.requiredPhrases.length === 0) continue;
    const title = overlay?.title && passesLint(overlay.title) ? overlay.title : null;
    const body =
      overlay?.body && passesLint(overlay.body) && !overlayViolatesFloor(base, overlay)
        ? overlay.body
        : null;
    views.push({
      id: base.id,
      scope: "platform",
      templateKey: base.templateKey,
      category: base.category,
      title: title ?? base.title,
      body: body ?? base.body,
      customized: title !== null || body !== null,
    });
  }
  return views;
}

/** A shared or personal row is served only while it still passes the current lint (fail closed on a tightened rule). */
export function isServable(row: { readonly title: string; readonly body: string }): boolean {
  return passesLint(row.title) && passesLint(row.body);
}

// ---- write preparation shared by every TemplateService implementation ---------------------------------------------

export interface TemplateFields {
  readonly title: string;
  readonly body: string;
  readonly category: TemplateCategory;
}

export interface OverlayFields {
  readonly title: string | null;
  readonly body: string | null;
  readonly isEnabled: boolean;
}

/** Validate a complete create payload: category in the closed list, then trim/bound/lint title and body. */
export function prepareTemplate(input: TemplateFields): TemplateFields {
  if (!(TEMPLATE_CATEGORIES as readonly string[]).includes(input.category)) {
    throw new WardenXError("VALIDATION_FAILED", "request validation failed", 422, [
      { field: "category", code: "INVALID", message: "category is not one of the allowed values" },
    ]);
  }
  return { ...validateTemplateText(input), category: input.category };
}

/** Merge a partial update over the stored row, then validate the result as a whole (returns a new object). */
export function prepareTemplatePatch(
  existing: TemplateFields,
  patch: Partial<TemplateFields>,
): TemplateFields {
  return prepareTemplate({
    title: patch.title ?? existing.title,
    body: patch.body ?? existing.body,
    category: patch.category ?? existing.category,
  });
}

/** Validate an overlay write: lint any text it sets, then refuse a body that drops a required phrase. */
export function prepareOverlay(
  platform: Pick<PlatformTemplate, "requiredPhrases">,
  overlay: OverlayFields,
): OverlayFields {
  const title =
    overlay.title === null ? null : checkOne("title", overlay.title, TEMPLATE_LIMITS.titleMax);
  const body =
    overlay.body === null ? null : checkOne("body", overlay.body, TEMPLATE_LIMITS.bodyMax);
  assertOverlayRespectsFloor(platform, { body });
  if (!overlay.isEnabled && platform.requiredPhrases.length > 0) {
    throw new WardenXError(
      "TEMPLATE_FLOOR_VIOLATION",
      "This template carries required platform wording and cannot be hidden.",
      422,
      [
        {
          field: "isEnabled",
          code: "FLOOR_PROTECTED",
          message: "this template cannot be turned off",
        },
      ],
    );
  }
  return { title, body, isEnabled: overlay.isEnabled };
}

/** Case-insensitive uniqueness key for a title within one owner scope (the DB index is lower(title)). */
export const titleKey = (title: string): string => title.trim().toLowerCase();

export const titleTakenError = (): WardenXError =>
  new WardenXError("TEMPLATE_TITLE_TAKEN", "A saved reply with this title already exists.", 409);

export const limitReachedError = (): WardenXError =>
  new WardenXError("TEMPLATE_LIMIT_REACHED", "The saved reply limit has been reached.", 409);
