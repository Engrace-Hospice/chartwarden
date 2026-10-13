// WP 2.7b C2 (ADR-0058, Proposed) - the key provider implementations behind the C1 `SearchKeyProvider` port.
//   * `createUnavailableSearchKeyProvider` is what production wires until P1 (WP 2.13, the M34 wrapped-DEK ring) lands: every
//     call throws, so nothing can be indexed or searched (fail closed, ADR decision 13).
//   * `createLegacyTestSearchKeyProvider` derives K_search from the legacy HKDF DEK (label "legacy"). TEST ONLY: under the
//     legacy scheme there is no tenant key to destroy, which is exactly why the ADR gates production on P1.
import { type SearchKeyProvider, deriveOrgDek, deriveSearchKey } from "@wardenx/messaging";

export const LEGACY_TEST_KEY_VERSION = "legacy";

export class SearchKeyUnavailableError extends Error {
  constructor() {
    super("global search key provider is unavailable (P1 key ring not wired); failing closed");
    this.name = "SearchKeyUnavailableError";
  }
}

export function createUnavailableSearchKeyProvider(): SearchKeyProvider {
  const fail = (): never => {
    throw new SearchKeyUnavailableError();
  };
  return {
    activeVersion: async () => fail(),
    liveVersions: async () => fail(),
    tagKey: async () => fail(),
  };
}

export function createLegacyTestSearchKeyProvider(kek: Buffer): SearchKeyProvider {
  return {
    activeVersion: async () => LEGACY_TEST_KEY_VERSION,
    liveVersions: async () => [LEGACY_TEST_KEY_VERSION],
    tagKey: async (orgId, version) => deriveSearchKey(deriveOrgDek(kek, orgId), orgId, version),
  };
}
