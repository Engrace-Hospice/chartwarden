// @wardenx/db — business-rule constraint registry (F-022 / #55).
//
// A UNIQUE index is often not a storage detail but a BUSINESS RULE the database is the authority
// for: `scale_license_active_per_org_scale_uq` says "at most one active license per (org, scale)",
// and violating it is a caller error with an obvious remedy. Postgres reports it as `23505` with
// the constraint's name; Drizzle wraps that in a `DrizzleQueryError`; nothing inspected either, so
// it reached the caller as `500 INTERNAL_ERROR / "An unexpected error occurred"` and reached the
// log as `"unhandled error"` — the same severity as a genuine fault, in a run where four of the
// five `unhandled error` entries were this one constraint.
//
// The mapping lives HERE, beside the index definition, rather than being inferred from the name at
// the error site. A name is not a specification: `…_uq` says nothing about which of two columns the
// caller got wrong, and a message guessed from one would be confidently wrong the first time a
// constraint was renamed. `businessRule()` returns the name it is given, so the registration IS the
// index declaration — there is no second place to keep in sync and no way to register a meaning for
// a constraint that does not exist:
//
//     activePerOrgScale: uniqueIndex(
//       businessRule("scale_license_active_per_org_scale_uq", "…what the caller did…"),
//     ).on(t.organizationId, t.scaleType)
//
// A constraint with NO registered meaning is left alone: it stays a 500, exactly as before. That is
// deliberate. Silence is the honest answer when nobody has written down what the rule means, and a
// 500 that says nothing is better than a 409 that says the wrong thing.

/** A constraint the database enforces on behalf of a written business rule. */
export interface BusinessRuleConstraint {
  /** The constraint / unique-index name exactly as Postgres reports it in `23505`. */
  readonly constraint: string;
  /** What the CALLER did, in caller-facing language. Rendered verbatim into the 409 body. */
  readonly meaning: string;
}

const REGISTRY = new Map<string, string>();

/**
 * Declare what a constraint means to a caller, and return its name so the declaration can BE the
 * index definition. Re-registering the same name with the same meaning is a no-op (a schema module
 * may be imported more than once); re-registering it with a DIFFERENT meaning throws, because two
 * answers to "what did the caller do wrong" means one of them is stale.
 */
export function businessRule(constraint: string, meaning: string): string {
  const existing = REGISTRY.get(constraint);
  if (existing !== undefined && existing !== meaning) {
    throw new Error(
      `businessRule: '${constraint}' is already registered with a different meaning. ` +
        `One of the two is stale — delete it rather than leaving both.\n  existing: ${existing}\n  new:      ${meaning}`,
    );
  }
  REGISTRY.set(constraint, meaning);
  return constraint;
}

/** What a constraint means to a caller, or `undefined` if nobody has written it down. */
export function businessRuleMeaning(constraint: string): string | undefined {
  return REGISTRY.get(constraint);
}

/** Every registered constraint, sorted by name. For tests and for documentation generation. */
export function businessRuleConstraints(): BusinessRuleConstraint[] {
  return [...REGISTRY.entries()]
    .map(([constraint, meaning]) => ({ constraint, meaning }))
    .sort((a, b) => a.constraint.localeCompare(b.constraint));
}

/** A `23505` on a constraint whose meaning is registered. */
export interface BusinessRuleViolation {
  readonly kind: "business-rule-violation";
  /** The constraint Postgres named. */
  readonly constraint: string;
  /** Its registered, caller-facing meaning. */
  readonly meaning: string;
}

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = "23505";
/** How far down a `.cause` chain to look. Drizzle wraps once; a repository may wrap once more. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Recognise a database error as the violation of a business rule somebody has written down.
 *
 * Returns `null` for everything else — an unregistered constraint, a different SQLSTATE, a non-
 * database error — so the caller's existing handling is untouched. Walks `.cause` because the error
 * that reaches an error handler is a `DrizzleQueryError` wrapping the `pg` `DatabaseError` that
 * actually carries `code` and `constraint`.
 *
 * NOTE for callers: do not log the raw error after mapping one of these. A `DrizzleQueryError`'s
 * message embeds the failed query AND its bound parameters, which on most tables is PHI.
 */
export function classifyDatabaseError(err: unknown): BusinessRuleViolation | null {
  let cursor: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cursor instanceof Error; depth++) {
    const code = (cursor as { code?: unknown }).code;
    const constraint = (cursor as { constraint?: unknown }).constraint;
    if (code === UNIQUE_VIOLATION && typeof constraint === "string") {
      const meaning = businessRuleMeaning(constraint);
      if (meaning !== undefined) {
        return { kind: "business-rule-violation", constraint, meaning };
      }
      return null;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return null;
}
