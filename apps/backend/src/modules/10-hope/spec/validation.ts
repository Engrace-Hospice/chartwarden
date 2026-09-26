import type { HopeIsc } from "../hope-spec-registry";
import type {
  HopeAnswerMap,
  HopeApplicabilityResult,
  HopeApplicabilityState,
} from "./applicability";

export type HopeValidationMode = "draft" | "final";
export type HopeValidationSeverity = "error" | "warning";
export type HopeFindingKind =
  | "missing_required"
  | "invalid_skip_state"
  | "inconsistent_value"
  | "mutual_exclusivity"
  | "date_order"
  | "timing"
  | "workflow"
  | "record_consistency";

export interface HopeValidationItem {
  readonly itemCode: string;
  readonly sectionLabel: string;
  readonly kind: string;
  readonly cmsItemTypeCode: string;
}

export interface HopeValidationAssessment {
  readonly id: string;
  readonly rfaKind: string;
  readonly status: string;
  readonly targetDate: string;
  readonly specVersionId: string;
  readonly specVersionCode: string;
  readonly isc: HopeIsc;
  readonly correctsAssessmentId: string | null;
}

export interface HopeValidationContext {
  readonly mode: HopeValidationMode;
  readonly assessment: HopeValidationAssessment;
  readonly activeItems: readonly HopeValidationItem[];
  readonly answers: HopeAnswerMap;
  readonly applicability: HopeApplicabilityResult;
  readonly submissionDate?: string;
}

export interface HopeRuleFinding {
  readonly ruleId: string;
  readonly severity: HopeValidationSeverity;
  readonly findingKind: HopeFindingKind;
  readonly section: string;
  readonly itemCode?: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly fingerprint: string;
}

export interface HopeValidationResult {
  readonly assessmentId: string;
  readonly mode: HopeValidationMode;
  readonly evaluatedAt: Date;
  readonly findings: readonly HopeRuleFinding[];
}

export interface HopeValidationRule {
  readonly id: string;
  evaluate(ctx: HopeValidationContext): readonly HopeRuleFinding[];
}

export interface HopeValidationEngine {
  readonly specVersionCode: string;
  readonly rules: readonly HopeValidationRule[];
  evaluate(ctx: HopeValidationContext): readonly HopeRuleFinding[];
}

export class HopeValidationSpecUnsupportedError extends Error {
  constructor(readonly specVersionCode: string) {
    super(`HOPE validation rules are not registered for spec version ${specVersionCode}`);
    this.name = "HopeValidationSpecUnsupportedError";
  }
}

export function answerValue(answers: HopeAnswerMap, itemCode: string): string | null {
  const answer = answers.get(itemCode);

  if (!answer || answer.state !== "answered") {
    return null;
  }

  if (typeof answer.value === "string") {
    return answer.value;
  }

  // Defensive compatibility for legacy/imported
  // records that stored CMS option codes
  // as numbers.
  if (typeof answer.value === "number" && Number.isFinite(answer.value)) {
    return String(answer.value);
  }

  if (typeof answer.value === "boolean") {
    return answer.value ? "1" : "0";
  }

  return null;
}

export function isAnswered(answers: HopeAnswerMap, itemCode: string): boolean {
  return answers.get(itemCode)?.state === "answered";
}

export function isSkipped(answers: HopeAnswerMap, itemCode: string): boolean {
  return answers.get(itemCode)?.state === "skipped";
}

export function applicabilityOf(
  ctx: HopeValidationContext,
  itemCode: string,
): HopeApplicabilityState {
  return ctx.applicability.items.get(itemCode)?.applicability ?? "not_applicable";
}

export function sectionOf(itemCode: string): string {
  return itemCode.slice(0, 1).toUpperCase();
}

export function fingerprint(
  ruleId: string,
  ...parts: readonly (string | null | undefined)[]
): string {
  return [ruleId, ...parts.filter((part): part is string => Boolean(part))].join(":");
}

export function parseHopeDate(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function daysBetween(later: string, earlier: string): number | null {
  const laterDate = parseHopeDate(later);
  const earlierDate = parseHopeDate(earlier);
  if (!laterDate || !earlierDate) return null;
  return Math.floor((laterDate.getTime() - earlierDate.getTime()) / 86_400_000);
}
