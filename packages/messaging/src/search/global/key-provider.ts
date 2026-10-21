// ADR-0058 decision 2 - the port through which the index obtains per-tenant search keys. Production implementation: the ring-backed
// provider in apps/backend/src/modules/36-messaging/global-search/search-key-provider.ts (M34 wrapped-DEK ring, WP 2.13). `version` is the key ring's TEXT label (for example "v1").
import type { SearchLabels } from "./tags";

export interface SearchKeyForLabels {
  readonly labels: SearchLabels;
  readonly key: Buffer;
}

export interface SearchKeyProvider {
  /** The ring version new index rows are written under. Throws when the ring is destroyed (fail closed). */
  activeVersion(orgId: string): Promise<string>;
  /** Versions a query must match during a rotation overlap, active first. */
  liveVersions(orgId: string): Promise<readonly string[]>;
  /** The 32-byte K_search for (org, version), derived with `deriveSearchKey`. */
  tagKey(orgId: string, version: string): Promise<Buffer>;
  /**
   * QUERY side only: the K_search for (org, version) under every accepted label set (current first), each paired with its
   * labels so the channel key is derived with the matching set. Must return at least one entry (callers fail closed on zero).
   */
  tagKeysForRead(orgId: string, version: string): Promise<readonly SearchKeyForLabels[]>;
}
