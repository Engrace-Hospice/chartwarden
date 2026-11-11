// @chartwarden/shared/route-kit — the two reads every module's ABAC predicates make. Structural types, so the
// kit stays free of an `@chartwarden/auth` dependency (an `AbacTarget` / `AbacContext` satisfies them).

/** The first non-empty string among `fields` of an ABAC target, or null. */
export function targetStr(
  target: Readonly<Record<string, unknown>>,
  ...fields: readonly string[]
): string | null {
  for (const field of fields) {
    const value = target[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** The server-assembled membership id on an ABAC context (`attributes.membershipId`), or null. */
export function membershipIdOf(context: {
  readonly attributes?: Readonly<Record<string, unknown>>;
}): string | null {
  const value = context.attributes?.membershipId;
  return typeof value === "string" && value.length > 0 ? value : null;
}
