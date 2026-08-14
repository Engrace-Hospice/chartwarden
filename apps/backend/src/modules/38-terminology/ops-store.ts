// apps/backend/src/modules/38-terminology/ops-store.ts — the data PORT behind M38's six previously
// unbuilt §4.1 routes (GAP-063), plus a deterministic in-memory slice for unit tests.
//
// WHY A SECOND PORT. `TerminologyStore` is the data port behind the PUBLISHED `TerminologyProvider`
// seam — the surface ~20 clinical/billing modules import. None of them needs a value-set catalog
// listing, a load history, or a cross-tenant governance view, and every method added to that
// interface has to be implemented by the deny-stub and by every test double in the repo. So the
// route-only reads live here instead, and `TerminologyProvider` keeps the shape its consumers rely on.
//
// The two halves this port covers:
//   • TENANT reads   — the value-set catalog (`terminology.read`) and the deprecations the §7.3
//                      remediation report joins tenant code usage against (`terminology.deprecation_report`).
//   • PLATFORM-OPS   — load history, version registration, embedding-refresh request, and the
//                      cross-tenant extension governance view (`terminology.admin.*`).
//
// Everything platform-ops WRITES goes through the migration-0206 `terminology_loader` SECURITY DEFINER
// functions: `wardenx_app` has no INSERT/UPDATE grant on any canonical terminology table and must not
// get one (§7.4 lockdown). The Drizzle adapter is `./terminology-ops-store-db.ts`.
import type { CodeSystemId, DeprecationMappingResponse } from "@wardenx/terminology";

/** One row of the `/api/v1/terminology/value-sets` catalog (§4.1). */
export interface ValueSetCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly scope: "platform" | "hospice" | "hqrp";
  readonly updatedAt: string;
}

/** A deprecation mapping tagged with its system — the §7.3 rollup's right-hand input. */
export type SystemDeprecation = { readonly systemId: CodeSystemId } & DeprecationMappingResponse;

/** One `terminology_update_log` entry joined to the version it describes (§4.1 load history). */
export interface TerminologyLoadHistoryEntry {
  readonly logId: string;
  readonly systemId: CodeSystemId;
  readonly versionId: string | null;
  readonly version: string | null;
  readonly versionStatus: string | null;
  readonly action: string;
  readonly conceptCount: number;
  readonly newCodes: number;
  readonly retiredCodes: number;
  readonly affectedValueSets: number;
  readonly summary: Record<string, unknown>;
  readonly at: string;
}

/** What the route asks the loader to register (§4.2 POST …/:system/load). */
export interface RegisterVersionInput {
  readonly system: CodeSystemId;
  readonly version: string;
  readonly sourceFileRef: string;
  readonly checksum: string;
  /** ISO dates; both default to today at the route boundary. */
  readonly releasedOn: string;
  readonly effectiveFrom: string;
  /** The platform operator's user id, recorded on the version row. */
  readonly loadedBy: string;
}

/**
 * Outcome of a registration. `created=false` means the (system, version) pair was already registered —
 * the route answers 409 with this same `versionId`, which is the spec's stated idempotent behaviour.
 */
export interface RegisterVersionResult {
  readonly versionId: string;
  readonly created: boolean;
  readonly status: string;
}

/** Outcome of an embeddings-refresh request; `versionId=null` when the system has no active version. */
export interface EmbeddingRefreshResult {
  readonly versionId: string | null;
  readonly logged: boolean;
}

/** One row of the cross-tenant extension governance view (§4.2). */
export interface TenantExtensionGovernanceRow {
  readonly extensionId: string;
  readonly valueSetId: string;
  readonly organizationId: string;
  readonly systemId: CodeSystemId;
  readonly code: string;
  readonly reason: string;
  readonly addedBy: string | null;
  readonly removedAt: string | null;
  readonly createdAt: string;
}

/** Filters for the governance view (all optional; `limit` is clamped store-side). */
export interface TenantExtensionGovernanceQuery {
  readonly valueSetId?: string;
  readonly organizationId?: string;
  readonly includeRemoved?: boolean;
  readonly limit?: number;
  readonly cursor?: string | null;
}

/** The data port behind M38's route-only reads and the platform-ops write door. */
export interface TerminologyOpsStore {
  /** Every platform value set, ordered by id (§4.1 catalog). */
  listValueSets(): Promise<readonly ValueSetCatalogEntry[]>;
  /**
   * Deprecations effective on or after `since`, optionally narrowed to one system — the set the
   * remediation report asks consumer modules about. Bounded: the report is per-tenant exposure against
   * RECENT deprecations, not the whole history (the route defaults `since` to 18 months back, §4.2).
   */
  deprecationsSince(since: string, system?: CodeSystemId): Promise<readonly SystemDeprecation[]>;
  /** The platform load history, newest first (§4.1 `terminology_update_log`). */
  loadHistory(opts: {
    system?: CodeSystemId;
    limit: number;
  }): Promise<readonly TerminologyLoadHistoryEntry[]>;
  /** Register a source version through the loader function — idempotent on (system, version). */
  registerVersion(input: RegisterVersionInput): Promise<RegisterVersionResult>;
  /** Record an embeddings-refresh request against the system's ACTIVE version. */
  requestEmbeddingRefresh(system: CodeSystemId, requestedBy: string): Promise<EmbeddingRefreshResult>;
  /** The cross-tenant governance view of tenant value-set extensions. */
  listTenantExtensions(
    query: TenantExtensionGovernanceQuery,
  ): Promise<readonly TenantExtensionGovernanceRow[]>;
}

// ── in-memory slice ───────────────────────────────────────────────────────────────────────────────

/** Deterministic seed for {@link createInMemoryTerminologyOpsStore} (route unit tests / the slice). */
export interface TerminologyOpsSeed {
  readonly valueSets?: readonly ValueSetCatalogEntry[];
  readonly deprecations?: readonly SystemDeprecation[];
  readonly history?: readonly TerminologyLoadHistoryEntry[];
  readonly extensions?: readonly TenantExtensionGovernanceRow[];
  /** Pre-existing (system, version) registrations, so the idempotent 409 path is exercisable. */
  readonly versions?: readonly { system: CodeSystemId; version: string; versionId: string }[];
  /** Systems with an active version — a system absent here cannot accept an embeddings refresh. */
  readonly activeVersionBySystem?: Partial<Record<CodeSystemId, string>>;
}

/**
 * An in-memory {@link TerminologyOpsStore}: no DB, deterministic, and it records what was written so a
 * route test can assert the effect rather than only the response body.
 */
export function createInMemoryTerminologyOpsStore(seed: TerminologyOpsSeed = {}): {
  store: TerminologyOpsStore;
  registered(): RegisterVersionInput[];
  embeddingRequests(): { system: CodeSystemId; requestedBy: string }[];
} {
  const registered: RegisterVersionInput[] = [];
  const embeddingRequests: { system: CodeSystemId; requestedBy: string }[] = [];
  const versions = new Map<string, string>(
    (seed.versions ?? []).map((v) => [`${v.system} ${v.version}`, v.versionId]),
  );
  let versionSeq = versions.size;

  const store: TerminologyOpsStore = {
    async listValueSets() {
      return [...(seed.valueSets ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1));
    },

    async deprecationsSince(since, system) {
      return (seed.deprecations ?? []).filter(
        (d) =>
          d.deprecationEffective >= since && (system === undefined || d.systemId === system),
      );
    },

    async loadHistory({ system, limit }) {
      return (seed.history ?? [])
        .filter((h) => system === undefined || h.systemId === system)
        .sort((a, b) => (a.at < b.at ? 1 : -1))
        .slice(0, limit);
    },

    async registerVersion(input) {
      const key = `${input.system} ${input.version}`;
      const existing = versions.get(key);
      if (existing !== undefined) {
        return { versionId: existing, created: false, status: "loading" };
      }
      versionSeq += 1;
      const versionId = `00000000-0000-4000-8000-${String(versionSeq).padStart(12, "0")}`;
      versions.set(key, versionId);
      registered.push(input);
      return { versionId, created: true, status: "loading" };
    },

    async requestEmbeddingRefresh(system, requestedBy) {
      const versionId = seed.activeVersionBySystem?.[system] ?? null;
      if (versionId === null) return { versionId: null, logged: false };
      embeddingRequests.push({ system, requestedBy });
      return { versionId, logged: true };
    },

    async listTenantExtensions(query) {
      const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
      return (seed.extensions ?? [])
        .filter(
          (x) =>
            (query.valueSetId === undefined || x.valueSetId === query.valueSetId) &&
            (query.organizationId === undefined || x.organizationId === query.organizationId) &&
            (query.includeRemoved === true || x.removedAt === null),
        )
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit);
    },
  };

  return { store, registered: () => registered, embeddingRequests: () => embeddingRequests };
}
