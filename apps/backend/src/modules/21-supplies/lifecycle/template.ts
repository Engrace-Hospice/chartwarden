// apps/backend/src/modules/21-supplies/lifecycle/template.ts — M21-T03 (§2.3 / D3).
//
// The comfort-kit template is the RECIPE, and its rules are all one shape: platform floor, tenant may extend
// or tighten, tenant may never remove or loosen. The arithmetic of that rule (bounds, thresholds, the
// four-medication floor) lives in `@chartwarden/supplies`; this file owns the LIFECYCLE around it — authoring a
// tenant template, superseding one with a new version, retiring one, and answering "which template was
// effective when this kit went out?".
//
// TEMPLATES ARE APPENDED, NEVER EDITED IN PLACE. A dispatch froze its template's handling-policy digest at
// dispatch time (§2.5); if the recipe behind it could be mutated, the DEA record would describe a kit that
// never existed. So a change is a NEW row with `replaces_template_id` pointing back and the old row's
// `effective_to` closed — the same append-only posture §7.4 gives vendor-routing rules.
//
// The one asymmetry worth reading twice is on `replenishmentThresholdPct`: RAISING it triggers replenishment
// sooner and is a tightening; LOWERING it lets a kit run further down before anyone is told, which is the
// direction that leaves a dying patient without morphine at 2am. `validateTenantTemplate` rejects the
// lowering; this file never second-guesses it.
import {
  COMFORT_KIT_PLATFORM_FLOOR,
  type TemplateViolation,
  type TenantTemplateMedication,
  validateTenantTemplate,
} from "@chartwarden/supplies";
import type { ComfortKitTemplateId, IsoInstant } from "@chartwarden/types";
import { type SupplySideEffect, withAudit } from "./effects";
import { SupplyStateError, require_ } from "./errors";

/** One template row as the lifecycle sees it (the columns §2.3 reasons about, nothing more). */
export interface ComfortKitTemplateFacts {
  readonly templateId: ComfortKitTemplateId;
  readonly isPlatformFloor: boolean;
  readonly systemLocked: boolean;
  readonly effectiveFrom: IsoInstant;
  readonly effectiveTo: IsoInstant | null;
}

/** §2.3 — is the template usable for a dispatch at this instant? A window is half-open: `effective_from`
 *  inclusive, `effective_to` exclusive, so a supersession at midnight leaves no instant covered twice. */
export function isTemplateEffectiveAt(template: ComfortKitTemplateFacts, at: Date): boolean {
  const from = new Date(template.effectiveFrom).getTime();
  if (at.getTime() < from) return false;
  if (template.effectiveTo === null) return true;
  return at.getTime() < new Date(template.effectiveTo).getTime();
}

/**
 * §2.3 — the guard every dispatch runs before it resolves contents. Dispatching against a retired template
 * is not a harmless anachronism: the retired recipe may hold the quantity a state board has since
 * prohibited, and the kit would ship with it.
 */
export function assertTemplateEffective(template: ComfortKitTemplateFacts, at: Date): void {
  require_(
    isTemplateEffectiveAt(template, at),
    "M21_TEMPLATE_NOT_EFFECTIVE",
    `comfort-kit template ${template.templateId} is not effective at ${at.toISOString()} (window ${template.effectiveFrom} → ${template.effectiveTo ?? "open"})`,
  );
}

/** The result of authoring or superseding a tenant template. */
export interface TemplateAuthoringResult {
  readonly effects: ReadonlyArray<SupplySideEffect>;
}

/**
 * §2.3 / D3 — validate a tenant template's medication set against the platform floor.
 *
 * Reported as ONE error carrying every violation rather than the first: a coordinator fixing a kit recipe
 * should see all four problems at once, not discover them one save at a time.
 */
export function assertTenantTemplateWithinFloor(
  lines: ReadonlyArray<TenantTemplateMedication>,
): void {
  const validation = validateTenantTemplate(lines);
  if (validation.ok) return;
  throw new SupplyStateError(
    "M21_TEMPLATE_VIOLATES_PLATFORM_FLOOR",
    describeViolations(validation.violations),
  );
}

/** Render the violation list into the non-dismissible banner §7.2 asks the UI to show. */
export function describeViolations(violations: ReadonlyArray<TemplateViolation>): string {
  return violations.map((v) => `${v.code}: ${v.message}`).join("; ");
}

/**
 * §2.3 — author a new tenant template (or the first version of one). The floor check runs BEFORE anything
 * is written, so a template that violates the floor never exists even transiently: §2.5's dispatch-time
 * defense-in-depth check is a second net, not the first.
 */
export function authorTenantTemplate(input: {
  readonly lines: ReadonlyArray<TenantTemplateMedication>;
  readonly effectiveFrom: IsoInstant;
  readonly effectiveTo: IsoInstant | null;
}): TemplateAuthoringResult {
  assertEffectiveWindowOrdered(input.effectiveFrom, input.effectiveTo);
  assertTenantTemplateWithinFloor(input.lines);
  return { effects: withAudit([]) };
}

/**
 * §2.3 / §7.4-shape — supersede an existing template with a new version.
 *
 * The predecessor's `effective_to` is set to the successor's `effective_from` (not to "now"): the window the
 * new recipe opens is exactly the window the old one closes, so no dispatch instant falls between two
 * templates and none is covered by both.
 */
export function supersedeTemplate(input: {
  readonly predecessor: ComfortKitTemplateFacts;
  readonly successorEffectiveFrom: IsoInstant;
  readonly lines: ReadonlyArray<TenantTemplateMedication>;
}): TemplateAuthoringResult {
  const { predecessor, successorEffectiveFrom } = input;
  require_(
    !predecessor.isPlatformFloor,
    "M21_TEMPLATE_SYSTEM_LOCKED",
    "the platform-floor template is superseded by controlled migration, never by a tenant edit",
  );
  require_(
    predecessor.effectiveTo === null,
    "M21_TEMPLATE_EFFECTIVE_WINDOW_INVALID",
    `template ${predecessor.templateId} was already superseded (effective_to=${String(predecessor.effectiveTo)})`,
  );
  require_(
    new Date(successorEffectiveFrom).getTime() > new Date(predecessor.effectiveFrom).getTime(),
    "M21_TEMPLATE_EFFECTIVE_WINDOW_INVALID",
    "a successor template may not become effective before the version it replaces",
  );
  assertTenantTemplateWithinFloor(input.lines);

  return {
    effects: withAudit([
      { kind: "set_timestamp", field: "effective_to", at: successorEffectiveFrom },
    ]),
  };
}

/**
 * §2.3 — a `system_locked` medication line is platform-managed. This is the guard behind "a tenant may not
 * remove any of the four floor medications": the floor validator catches the ABSENCE at author time, and
 * this catches the DELETE that would have caused it.
 */
export function assertMedicationLineDeletable(line: {
  readonly systemLocked: boolean;
  readonly drugName: string;
}): void {
  require_(
    !line.systemLocked,
    "M21_TEMPLATE_SYSTEM_LOCKED",
    `'${line.drugName}' is a platform-floor comfort-kit medication and may not be removed from a tenant template`,
  );
}

/** §3.1.4 — mirrors the `m21_ckit_template_effective_window` CHECK, at the service layer where the error is
 *  a field-anchored 422 rather than a 500 from the database. */
export function assertEffectiveWindowOrdered(
  effectiveFrom: IsoInstant,
  effectiveTo: IsoInstant | null,
): void {
  if (effectiveTo === null) return;
  require_(
    new Date(effectiveTo).getTime() > new Date(effectiveFrom).getTime(),
    "M21_TEMPLATE_EFFECTIVE_WINDOW_INVALID",
    "effective_to must be strictly after effective_from",
  );
}

/** D3 — the floor keys a tenant template must carry. Exposed so the §5 admin screen can render the locked
 *  rows as locked rather than re-deriving the list (and drifting from it). */
export const PLATFORM_FLOOR_KEYS: ReadonlyArray<string> = COMFORT_KIT_PLATFORM_FLOOR.map(
  (m) => m.key,
);
