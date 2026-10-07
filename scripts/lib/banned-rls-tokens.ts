/**
 * ADR-0010 D2 — the RLS spellings no spec may PRESCRIBE (GAP-180). Shared by `check-module-docs.ts`
 * (which runs top-level and so cannot be imported by a test) and its unit test.
 */
export const BANNED_RLS_TOKENS = /\bapp\.tenant_id\b|\bwithTenantContext\b/;

/** A line that names the token only to say it is gone is a changelog entry, not a prescription. */
export const BANNED_TOKEN_CONTEXT =
  /\b(banned|removed|renamed|normali[sz]ed|replaced|defect|spellings?)\b|→|->/i;

/** True when `line` prescribes a banned spelling. */
export function prescribesBannedRlsToken(line: string): boolean {
  return BANNED_RLS_TOKENS.test(line) && !BANNED_TOKEN_CONTEXT.test(line);
}
