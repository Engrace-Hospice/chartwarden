// WP 2.7b C2 (ADR-0058, Accepted) - the key provider implementations behind the C1 `SearchKeyProvider` port.
//   * `createRingSearchKeyProvider` is the production provider: K_search = deriveSearchKey(ringDek, orgId, ringVersion) over
//     the WP 2.13 M34 wrapped-DEK ring (`RingDekCache`). It resolves the cache lazily on every call (the ring is bound after
//     the routes are mounted) and FAILS CLOSED: no binding, destroyed or missing ring, a provider outage or a version
//     mismatch all throw `SearchKeyUnavailableError`; it never falls back to the legacy HKDF key. The ring exposes only
//     `current` and `byVersion` (no version listing), so `liveVersions` is the ACTIVE version only: after a rotation, rows
//     written under the previous version are not matched until the index is rebuilt under the new one (under-recall, the safe
//     direction; the ADR's rotation overlap needs a version enumerator the ring does not have).
//   * `createUnavailableSearchKeyProvider` always throws (nothing can be indexed or searched); kept for tests/unwired boots.
//   * `createLegacyTestSearchKeyProvider` derives K_search from the legacy HKDF DEK (label "legacy"). TEST ONLY: under the
//     legacy scheme there is no tenant key to destroy, which is exactly why the ADR gates production on P1.
import {
  SEARCH_LABELS_READ,
  type SearchKeyProvider,
  deriveOrgDek,
  deriveOrgReadDeks,
  deriveSearchKey,
} from "@chartwarden/messaging";
import type { RingDekCache } from "../body-key-ring";

export const LEGACY_TEST_KEY_VERSION = "legacy";

export class SearchKeyUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("global search key provider is unavailable; failing closed", { cause });
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
    // LEGACY(wardenx->chartwarden): both label generations, paired index-wise (current DEK + current search labels, then
    // legacy + legacy) - the two lists have the same order and length.
    tagKeysForRead: async (orgId, version) => {
      const deks = deriveOrgReadDeks(kek, orgId);
      return SEARCH_LABELS_READ.map((labels, i) => ({
        labels,
        key: deriveSearchKey(deks[i] as Buffer, orgId, version, labels),
      }));
    },
  };
}

/** `getCache` is called on EVERY use (never at construction): the ring is bound after boot. */
export function createRingSearchKeyProvider(
  getCache: () => RingDekCache | undefined,
): SearchKeyProvider {
  const cache = (): RingDekCache => {
    const c = getCache();
    if (!c) throw new SearchKeyUnavailableError();
    return c;
  };
  const guarded = async <T>(load: () => Promise<T>): Promise<T> => {
    try {
      return await load();
    } catch (err) {
      throw err instanceof SearchKeyUnavailableError ? err : new SearchKeyUnavailableError(err);
    }
  };
  const activeVersion = (orgId: string) =>
    guarded(async () => {
      const { version } = await cache().current(orgId);
      if (!version) throw new Error("ring DEK carries no version label");
      return version;
    });
  return {
    activeVersion,
    liveVersions: async (orgId) => [await activeVersion(orgId)],
    tagKey: (orgId, version) =>
      guarded(async () => {
        const dek = await cache().byVersion(orgId, version);
        if (dek.version !== version) throw new Error("ring returned a different key version");
        return deriveSearchKey(dek.key, orgId, version);
      }),
    tagKeysForRead: (orgId, version) =>
      guarded(async () => {
        const dek = await cache().byVersion(orgId, version);
        if (dek.version !== version) throw new Error("ring returned a different key version");
        return SEARCH_LABELS_READ.map((labels) => ({
          labels,
          key: deriveSearchKey(dek.key, orgId, version, labels),
        }));
      }),
  };
}
