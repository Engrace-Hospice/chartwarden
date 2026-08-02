// @wardenx/subscription-billing — §8.7 audit-envelope REDACTOR (pure core, M35-T04).
//
// Every request/response envelope the dispatcher writes to `stripe_api_call_audit` passes through here
// FIRST, so a Stripe secret key, a card PAN/CVC, a bank number, a bearer token, or a raw patient id can
// never land in the forensic ledger (D14 hard PHI boundary + §8.9 secret catalog). The redactor walks the
// object graph and replaces any value under a denylisted KEY, or any value whose STRING content matches a
// secret pattern, with {@link REDACTED}. Structure (which fields were present) is preserved for triage;
// only the sensitive VALUES are stripped. Pure + deterministic — the §9.1 ≥95% strict-coverage target.

/** The sentinel a redacted value collapses to. Recognisable in the audit ledger; carries no information. */
export const REDACTED = "[REDACTED]";

/** Object keys (case-insensitive, substring match) whose values are always sensitive. Covers Stripe secrets
 *  (`client_secret`, `secret`, `api_key`), raw card data (`number`, `cvc`, `cvv`), bank data
 *  (`account_number`, `routing_number`, `iban`), auth material (`authorization`, `password`, `token`), and
 *  the PHI boundary (`patient`, `mrn`, `ssn`, `tax_id`). */
const DENYLISTED_KEY_SUBSTRINGS: readonly string[] = [
  "client_secret",
  "secret",
  "api_key",
  "apikey",
  "password",
  "authorization",
  "token",
  "number", // card `number`, `account_number`, `routing_number`
  "cvc",
  "cvv",
  "iban",
  "ssn",
  "tax_id",
  "patient",
  "mrn",
];

/** Value patterns that are sensitive regardless of the key they sit under: Stripe live/test secret + webhook
 *  signing keys, and bare card-length digit runs (13–19 digits, a PAN). */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+/, // Stripe (restricted-)secret keys
  /\bwhsec_[A-Za-z0-9]+/, // Stripe webhook signing secret
  /\bpk_(?:live|test)_[A-Za-z0-9]+/, // publishable key (public, but no reason to persist)
  /(?:\d[ -]?){13,19}/, // bare PAN — 13–19 digits, optional space/dash grouping
];

function keyIsDenylisted(key: string): boolean {
  const lower = key.toLowerCase();
  return DENYLISTED_KEY_SUBSTRINGS.some((needle) => lower.includes(needle));
}

function valueLooksSecret(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((re) => re.test(value));
}

/**
 * §8.7 — return a deep copy of `envelope` with every sensitive value replaced by {@link REDACTED}. Safe on
 * any JSON-shaped input (objects, arrays, primitives, `null`/`undefined`). Never mutates the input; never
 * throws. Cyclic references are broken with {@link REDACTED} (Stripe payloads are acyclic, but the guard
 * keeps the audit path total).
 */
export function redactForAudit(envelope: unknown): unknown {
  return redact(envelope, new WeakSet());
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return valueLooksSecret(value) ? REDACTED : value;
  }
  if (value === null || typeof value !== "object") {
    return value; // number / boolean / undefined / bigint / symbol — no secret surface
  }
  if (seen.has(value)) {
    return REDACTED; // cycle — do not recurse forever
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = keyIsDenylisted(key) ? REDACTED : redact(child, seen);
  }
  return out;
}
