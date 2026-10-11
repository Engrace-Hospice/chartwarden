// @wardenx/billing — READ-SIDE aliases for values persisted before migration 1069 (the `hipps_*` -> `per_diem_*` rename).
//
// `validation_result` and `per_diem_rate_calculation.segments` are append-only compliance history: the migration does NOT
// rewrite them, so rows written before it still carry the legacy spellings. Every reader that projects, resolves or
// dispatches on those stored values maps them through here so a legacy row behaves exactly like a current one. All
// functions are pure and return new values (never mutate their input). New writes only ever use the current spellings.

/** Legacy persisted rule key -> current registry key. */
const LEGACY_RULE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  hipps_coding_correct: "per_diem_class_coding_correct",
});

/** Legacy persisted remediation `fixAction` -> current action. */
const LEGACY_FIX_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  recompute_hipps: "recompute_per_diem_class",
});

/** Legacy segment-object key -> current key. */
const LEGACY_SEGMENT_KEYS: Readonly<Record<string, string>> = Object.freeze({
  hippsCharPosition: "perDiemClassCharPosition",
});

/** The current rule key for a stored one (identity for anything not a known legacy spelling). */
export function canonicalRuleKey(stored: string): string {
  return Object.hasOwn(LEGACY_RULE_KEYS, stored) ? (LEGACY_RULE_KEYS[stored] as string) : stored;
}

/** Every stored spelling (current first, then legacy) a filter on `key` must match. */
export function storedRuleKeySpellings(key: string): readonly string[] {
  const current = canonicalRuleKey(key);
  const legacy = Object.entries(LEGACY_RULE_KEYS)
    .filter(([, to]) => to === current)
    .map(([from]) => from);
  return [current, ...legacy];
}

/** The current fix action for a stored one (identity for anything not a known legacy spelling). */
export function canonicalFixAction(stored: string): string {
  return Object.hasOwn(LEGACY_FIX_ACTIONS, stored)
    ? (LEGACY_FIX_ACTIONS[stored] as string)
    : stored;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * A stored `validation_result.remediation` with its `fixAction` mapped, in either persisted shape (flat, or the older
 * nested `{ remediation: {...} }`). Anything that is not an object is returned unchanged.
 */
export function canonicalRemediation<T>(stored: T): T {
  if (!isRecord(stored)) return stored;
  const out: Record<string, unknown> = { ...stored };
  if (typeof out.fixAction === "string") out.fixAction = canonicalFixAction(out.fixAction);
  if (isRecord(out.remediation)) out.remediation = canonicalRemediation(out.remediation);
  return out as T;
}

/**
 * A stored `per_diem_rate_calculation.segments` array with legacy keys renamed (element order preserved). Anything that
 * is not an array is returned unchanged.
 */
export function canonicalSegments<T>(stored: T): T {
  if (!Array.isArray(stored)) return stored;
  return stored.map((segment: unknown) => {
    if (!isRecord(segment)) return segment;
    return Object.fromEntries(
      Object.entries(segment).map(([k, v]) => [
        Object.hasOwn(LEGACY_SEGMENT_KEYS, k) ? (LEGACY_SEGMENT_KEYS[k] as string) : k,
        v,
      ]),
    );
  }) as unknown as T;
}
