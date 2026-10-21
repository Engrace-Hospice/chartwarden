// @chartwarden/dosespot — sig canonicalization for the D8 idempotency key (M12-T06, spec §3.3 / D8 / §9 test
// `rx-business-key.test.ts`). DoseSpot's NewRx is non-idempotent (Integrations §6.1); the D8 key dedups "same
// prescriber, same patient, same drug+strength+sig". Cosmetic sig differences (whitespace, case, trailing
// punctuation) must NOT break that dedup — so the free-text sig is canonicalized to a stable form BEFORE it
// feeds the `rxBusinessKey` hash. PURE + deterministic: the same clinical sig always canonicalizes identically.

/**
 * `canonicalizeSig` — fold a free-text sig (or a deterministic stringification of the structured sig) into a
 * stable canonical form: lower-cased, Unicode-NFKC-normalized, internal whitespace collapsed to single
 * spaces, surrounding whitespace + trailing sentence punctuation trimmed. Two sigs that differ only
 * cosmetically (`"Take 1 tab PO QD."` vs `"take  1 tab po qd"`) collapse to the same string and so produce the
 * same `rxBusinessKey`; a genuine clinical change (a different route or frequency) does not.
 */
export function canonicalizeSig(sigFreeText: string): string {
  return sigFreeText
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:]+$/g, "")
    .trim();
}
