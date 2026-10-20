// @wardenx/audit - structural legal-hold matching (M4 spec §2.5 supremacy, §10.6; GAP-008).
//
// WHAT WAS WRONG. The eraser's `legalHoldFor` serialized a hold's `criteria` jsonb and looked for the row-group's
// resource id or patient id as a SUBSTRING. A hold whose only selectors were `dateRange` or `resourceKinds` (both
// accepted by `POST /legal-holds`) names no id, so it matched nothing: an approved destruction certificate erased
// the very rows the hold was applied to protect.
//
// THE RULE. A hold covers a row-group when EVERY selector the hold names matches the group (the same AND the hold's
// own `matchedRecordCount` uses):
//   - `patientIds`    the group's patient (or its resource id, for a patient-keyed group) is listed;
//   - `resourceKinds` the group's resource kind is listed;
//   - `dateRange`     the group's created-at span OVERLAPS the range. A group with no recorded span is treated as
//                     overlapping (the eraser may be asked to destroy rows of any age): over-holding is the safe
//                     direction, a wrongly-released row is not.
// A hold that names no selector at all covers nothing here (the route refuses to create one: 422 EMPTY_CRITERIA).
import type { EraseInput } from "./eraser";

/** A hold's selectors, as `POST /legal-holds` stores them in `legal_hold.criteria`. */
export interface LegalHoldCriteriaShape {
  readonly patientIds?: readonly string[];
  readonly dateRange?: { readonly from: string; readonly to: string };
  readonly resourceKinds?: readonly string[];
  /** Messaging selectors (ADR-0086 (proposed), WP 5.6): hold these M36 channels / these users' messages. They name
   *  no `audit_event` row, so a hold carrying ONLY these (plus, optionally, a dateRange) covers no audit group. */
  readonly channelIds?: readonly string[];
  readonly userIds?: readonly string[];
}

/** True when a hold names messaging selectors and NO audit selector (`patientIds`/`resourceKinds`): it protects
 *  messages only, so it neither covers an audit row-group nor reads as org-wide to a non-messaging reader. */
export function isMessagingOnlyCriteria(criteria: unknown): boolean {
  const c = (criteria ?? {}) as LegalHoldCriteriaShape;
  const messaging = (c.channelIds?.length ?? 0) > 0 || (c.userIds?.length ?? 0) > 0;
  return messaging && (c.patientIds?.length ?? 0) === 0 && (c.resourceKinds?.length ?? 0) === 0;
}

const toMs = (iso: string): number => Date.parse(iso);

/** Whether `[aFrom, aTo]` and `[bFrom, bTo]` share at least one instant. A bound that fails to parse overlaps. */
function overlaps(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  const [af, at, bf, bt] = [toMs(aFrom), toMs(aTo), toMs(bFrom), toMs(bTo)];
  if ([af, at, bf, bt].some(Number.isNaN)) return true;
  return af <= bt && bf <= at;
}

/** Whether one active hold's criteria cover this destruction row-group. */
export function holdCoversGroup(criteria: unknown, input: EraseInput): boolean {
  const c = (criteria ?? {}) as LegalHoldCriteriaShape;
  const hasPatients = (c.patientIds?.length ?? 0) > 0;
  const hasKinds = (c.resourceKinds?.length ?? 0) > 0;
  const hasRange = c.dateRange !== undefined && c.dateRange !== null;
  if (!hasPatients && !hasKinds && !hasRange) return false;
  if (isMessagingOnlyCriteria(c)) return false;

  if (hasPatients) {
    const listed = c.patientIds as readonly string[];
    const byPatient = input.patientId !== undefined && listed.includes(input.patientId);
    const byResource = listed.includes(input.resourceId);
    if (!byPatient && !byResource) return false;
  }
  if (hasKinds && !(c.resourceKinds as readonly string[]).includes(input.resourceKind)) return false;
  if (hasRange && input.createdAtFrom !== undefined && input.createdAtTo !== undefined) {
    const range = c.dateRange as { from: string; to: string };
    if (!overlaps(input.createdAtFrom, input.createdAtTo, range.from, range.to)) return false;
  }
  return true;
}

/** The id of the first active hold covering the group, or null. `holds` are ACTIVE holds only. */
export function firstCoveringHold(
  holds: readonly { readonly id: string; readonly criteria: unknown }[],
  input: EraseInput,
): string | null {
  return holds.find((h) => holdCoversGroup(h.criteria, input))?.id ?? null;
}

/** Widen a running `[from, to]` span with one row's created-at, immutably. */
export function widenSpan(
  span: { readonly from: string; readonly to: string } | undefined,
  createdAt: string,
): { readonly from: string; readonly to: string } {
  if (!span) return { from: createdAt, to: createdAt };
  return {
    from: toMs(createdAt) < toMs(span.from) ? createdAt : span.from,
    to: toMs(createdAt) > toMs(span.to) ? createdAt : span.to,
  };
}
