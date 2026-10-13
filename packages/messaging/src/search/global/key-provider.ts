// ADR-0058 decision 2 - the port through which the index obtains per-tenant search keys. A PORT ONLY in WP 2.7b chunk C1:
// the production implementation (backed by the M34 wrapped-DEK ring, prerequisite P1) does not exist yet, so nothing
// outside tests implements it and no boot path wires it. `version` is the key ring's TEXT label (for example "v1").
export interface SearchKeyProvider {
  /** The ring version new index rows are written under. Throws when the ring is destroyed (fail closed). */
  activeVersion(orgId: string): Promise<string>;
  /** Versions a query must match during a rotation overlap, active first. */
  liveVersions(orgId: string): Promise<readonly string[]>;
  /** The 32-byte K_search for (org, version), derived with `deriveSearchKey`. */
  tagKey(orgId: string, version: string): Promise<Buffer>;
}
