/**
 * ChartWarden — narrowing helpers for the gate scripts (F-012 / #34).
 *
 * `scripts/` compiles under the repo's own `noUncheckedIndexedAccess`, which types every indexed
 * read as `T | undefined`. Most of the resulting diagnostics in the gate scripts are one shape: a
 * capture group the REGEX ITSELF makes mandatory, read as `m[1]`. The pattern guarantees it; the
 * type system cannot see that.
 *
 * `m[1]!` would silence each site and state nothing. These helpers state the invariant instead, and
 * — because a gate script's job is to be believed — turn the impossible case into a loud error
 * naming the pattern rather than an `undefined` that flows on and quietly makes a check pass.
 */

/** A capture group the pattern makes mandatory. Throws if the group did not participate. */
export function group(m: RegExpMatchArray, index: number, what: string): string {
  const value = m[index];
  if (value === undefined) {
    throw new Error(
      `${what}: capture group ${index} did not participate in the match. The pattern makes it mandatory, so this means the pattern and this call disagree.`,
    );
  }
  return value;
}

export function groups(m: RegExpMatchArray, count: 1, what: string): [string];
export function groups(m: RegExpMatchArray, count: 2, what: string): [string, string];
export function groups(m: RegExpMatchArray, count: 3, what: string): [string, string, string];
export function groups(
  m: RegExpMatchArray,
  count: 4,
  what: string,
): [string, string, string, string];
/**
 * The first `count` capture groups, as a tuple, so destructuring keeps `string` rather than
 * decaying to `string | undefined`.
 */
export function groups(m: RegExpMatchArray, count: number, what: string): string[] {
  return Array.from({ length: count }, (_, i) => group(m, i + 1, what));
}

/** An element the caller requires. For a bound the code guarantees but the type cannot express. */
export function at<T>(list: readonly T[], index: number, what: string): T {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`${what}: no element at index ${index} (length ${list.length}).`);
  }
  return item;
}
