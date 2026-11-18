/**
 * The registry of synthetic identifiers (`compliance/synthetic-identifiers.json`) as the guard reads it. Its own file
 * since wave 13: `io.ts` loads it, and `io.ts` is all the emergency ledger child (`emergency-ledger.ts`) may import, so a
 * corrupted `patterns.ts` or `content-scan.ts` cannot take the ledger line of an emergency deny with it. No imports.
 */
export interface SyntheticRegistry {
  readonly ssn: ReadonlySet<string>;
  readonly mbi: ReadonlySet<string>;
}

export function registryFrom(json: {
  ssn?: readonly string[];
  mbi?: readonly string[];
}): SyntheticRegistry {
  return {
    ssn: new Set((json.ssn ?? []).map((s) => s.replace(/-/g, ""))),
    mbi: new Set((json.mbi ?? []).map((s) => s.replace(/-/g, "").toUpperCase())),
  };
}

export const EMPTY_REGISTRY: SyntheticRegistry = { ssn: new Set(), mbi: new Set() };
