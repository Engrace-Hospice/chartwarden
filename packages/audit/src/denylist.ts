// @wardenx/audit — the audit field denylist (M1 spec §7.3, §8.5).
//
// An audit record proves WHAT a subject did to WHICH resource — it must not become a second
// copy of the PHI it describes (HIPAA §164.312(b)). Every before/after/context snapshot
// audit() writes is first run through redact(): any leaf key on the denylist is replaced with
// CENSOR. The leaf-key set mirrors the Pino `redact` paths in spec §8.5 so the audit log and
// the application logs strip exactly the same fields.

/** Leaf field names (compared case-insensitively) replaced with CENSOR in every snapshot. */
export const AUDIT_FIELD_DENYLIST: ReadonlySet<string> = new Set(
  [
    // credentials / secrets
    "password",
    "passwordHash",
    "token",
    "accessToken",
    "refreshToken",
    "apiKey",
    "secret",
    // direct identifiers
    "ssn",
    "taxId",
    "mbi",
    "medicareNumber",
    "medicaidId",
    "dob",
    "dateOfBirth",
    "firstName",
    "lastName",
    "fullName",
    "address",
    "addressLine1",
    "phone",
    "email",
    // free text that may carry PHI
    "narrative",
    "note",
    "notes",
    "encounterText",
    // medication detail
    "medicationName",
    "dose",
  ].map((k) => k.toLowerCase()),
);

/** The marker written in place of a denylisted value. */
export const CENSOR = "[REDACTED]";

/** Marker used when a snapshot contains a reference cycle (keeps redact() total). */
export const CIRCULAR = "[CIRCULAR]";

/** True if `key` is on the denylist (case-insensitive). */
export function isDenied(key: string): boolean {
  return AUDIT_FIELD_DENYLIST.has(key.toLowerCase());
}

/**
 * Returns a deep copy of `value` with every denylisted leaf key replaced by CENSOR. Arrays
 * and nested objects are walked; reference cycles are collapsed to CIRCULAR; primitives and
 * other non-plain values pass through unchanged.
 */
export function redact<T>(value: T): T {
  return redactInner(value, new WeakSet<object>()) as T;
}

function redactInner(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);
    return value.map((v) => redactInner(v, seen));
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isDenied(k) ? CENSOR : redactInner(v, seen);
    }
    return out;
  }
  return value;
}

/** Redact an optional snapshot, preserving `undefined` so it stays absent in the row. */
export function redactSnapshot(
  snapshot: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return snapshot === undefined ? undefined : redact(snapshot);
}
