// @wardenx/mdm — the `MdmRouteService` + a shared in-memory backend (M40-T07, §4.1, §7.6).
//
// The routes (apps/backend/src/modules/40-mdm/routes) read through the `MdmEntityProvider` seam
// (T05) and call THIS service for the write/admin surface the read seam doesn't cover: overlay
// upsert, the BAA register, manual license entry, and the platform-ops merge / provisional / NPPES
// operations. In the slice both the provider's `MdmStore` and this service are produced by ONE
// `createInMemoryMdmBackend` over shared mutable maps — so the §7.6 invariant is demonstrable end
// to end: after `approveMerge` flips the duplicate's redirect row, a `resolve*` of the OLD id still
// returns the survivor (the redirect is invisible to consumers). Production swaps in the Drizzle
// service; the per-consumer batched `mdm.repoint_*` jobs are the T08 surface — they only optimize,
// they don't gate, because the redirect already keeps queries correct (§7.6).

import type { BaaEntityKind } from "../interfaces/baa-status-provider";
import type {
  CanonicalFields,
  OverlayFields,
  OverlayPhysicianFields,
} from "../interfaces/entity-provider";
import type { MdmEntityKind, MdmMergeStatus } from "../interfaces/kinds";
import type { MdmStore } from "../provider/store";
import type { SeedCanonical } from "../provider/store";
import type { CanonicalRedirectRow } from "../resolve/follow-merge";

/** A merge-request row (§2.4.2) the platform-ops surface lists/approves/rejects. */
export interface MergeRequestRow {
  readonly id: string;
  readonly kind: MdmEntityKind;
  /** the survivor canonical the duplicate merges into. */
  readonly canonicalId: string;
  /** the duplicate canonical that will flip to `merged`. */
  readonly duplicateId: string;
  readonly status: MdmMergeStatus;
  readonly evidence: Readonly<Record<string, unknown>>;
}

/** A BAA register entry (§4.1 GET/POST /mdm/baa) — the per-tenant view of `mdm_baa_record`. */
export interface BaaRegisterEntry {
  readonly id: string;
  readonly kind: BaaEntityKind;
  readonly canonicalId: string;
  readonly baaStatus: "executed" | "pending" | "n_a";
  readonly executedOn: string | null;
  readonly expiresOn: string | null;
}

/** An NPPES sync-log row (§4.1 GET /admin/mdm/nppes/sync-log). */
export interface NppesSyncRun {
  readonly id: string;
  readonly mode: "nightly_delta" | "weekly_full" | "on_demand";
  readonly outcome: "success" | "partial" | "failure";
}

/** The write/admin surface the routes call (reads go through the `MdmEntityProvider` seam). */
export interface MdmRouteService {
  /** Upsert this tenant's physician overlay for a canonical row (§4.1 PATCH overlay; Phase-1 kind). */
  upsertPhysicianOverlay(
    orgId: string,
    canonicalId: string,
    fields: OverlayPhysicianFields,
    actorUserId: string,
  ): Promise<{ applied: boolean }>;

  /** The tenant's BAA register across MDM entities (§4.1 GET /mdm/baa). */
  listBaa(orgId: string): Promise<readonly BaaRegisterEntry[]>;

  /** Record/update a BAA execution + expiration (§4.1 POST /mdm/baa). */
  recordBaa(
    orgId: string,
    input: Omit<BaaRegisterEntry, "id">,
    actorUserId: string,
  ): Promise<{ id: string }>;

  /** Enter/update a license + expiration — Phase-1 manual (§4.1 POST /mdm/license/manual). */
  recordLicense(
    orgId: string,
    input: { kind: MdmEntityKind; canonicalId: string; licenseState: string; expiresOn: string },
    actorUserId: string,
  ): Promise<{ recorded: true }>;

  /** Pending merges (§4.1 GET /admin/mdm/merge-requests; platform-ops). */
  listMergeRequests(): Promise<readonly MergeRequestRow[]>;

  /**
   * Approve a merge (§7.6): the duplicate flips to `merged` with `merged_into_id` set + the
   * survivor's `merged_from` updated; the merge row becomes `executed`. Throws when the merge id is
   * unknown or not `pending`. After this, resolving the duplicate id redirects to the survivor.
   */
  approveMerge(
    mergeId: string,
    actorUserId: string,
  ): Promise<{ duplicateId: string; canonicalId: string }>;

  /** Reject a pending merge with a reason (§4.1 POST …/reject). */
  rejectMerge(mergeId: string, reason: string, actorUserId: string): Promise<void>;

  /** Admin promotes a provisional to canonical (§4.1 POST /admin/mdm/provisional/:id/promote). */
  promoteProvisional(provisionalId: string, actorUserId: string): Promise<{ canonicalId: string }>;

  /** On-demand single-NPI sync (§4.1 POST /admin/mdm/nppes/lookup); the nightly path is T08. */
  nppesLookup(npi: string): Promise<{ matched: boolean; canonicalId: string | null }>;

  /** Recent NPPES sync outcomes (§4.1 GET /admin/mdm/nppes/sync-log). */
  nppesSyncLog(): Promise<readonly NppesSyncRun[]>;
}

/** Seed shape for {@link createInMemoryMdmBackend}. */
export interface InMemoryMdmBackendSeed {
  readonly canonicals?: readonly SeedCanonical[];
  readonly mergeRequests?: readonly MergeRequestRow[];
  readonly provisionalCanonicalIds?: Readonly<Record<string, string>>; // provisionalId → canonical id on promote
  readonly nppesByNpi?: Readonly<Record<string, string>>; // npi → canonical id
  readonly syncLog?: readonly NppesSyncRun[];
}

function key(...parts: string[]): string {
  return parts.join(" ");
}

/**
 * One shared in-memory MDM backend producing BOTH the provider's {@link MdmStore} and the
 * {@link MdmRouteService} over the SAME mutable maps — so a merge approved through the service is
 * visible to a resolve through the store (the §7.6 end-to-end proof). Deterministic, no I/O.
 */
export function createInMemoryMdmBackend(seed: InMemoryMdmBackendSeed = {}): {
  store: MdmStore;
  service: MdmRouteService;
} {
  const canonicals = new Map<string, SeedCanonical>();
  for (const c of seed.canonicals ?? []) canonicals.set(key(c.kind, c.redirect.id), c);

  const overlays = new Map<string, OverlayPhysicianFields>();
  const merges = new Map<string, MergeRequestRow>();
  for (const m of seed.mergeRequests ?? []) merges.set(m.id, m);
  const baa = new Map<string, BaaRegisterEntry[]>(); // orgId → entries
  const syncLog: NppesSyncRun[] = [...(seed.syncLog ?? [])];
  let baaSeq = 0;
  let provisionalSeq = 0;

  /** Replace a canonical's redirect projection in place (merge mutation). */
  function setRedirect(kind: MdmEntityKind, id: string, redirect: CanonicalRedirectRow): void {
    const existing = canonicals.get(key(kind, id));
    if (existing) canonicals.set(key(kind, id), { ...existing, redirect });
  }

  const store: MdmStore = {
    async canonicalRedirect(kind, id) {
      return canonicals.get(key(kind, id))?.redirect ?? null;
    },
    async canonicalFields<K extends MdmEntityKind>(kind: K, id: string) {
      return (canonicals.get(key(kind, id))?.fields as CanonicalFields<K> | undefined) ?? null;
    },
    async overlay<K extends MdmEntityKind>(kind: K, orgId: string, canonicalId: string) {
      if (kind !== "physician") return null;
      return (overlays.get(key(orgId, canonicalId)) as OverlayFields<K> | undefined) ?? null;
    },
    async canonicalIdByIdentifier(kind, value) {
      for (const c of canonicals.values()) {
        if (c.kind === kind && c.fields.identifierValue === value) return c.redirect.id;
      }
      return null;
    },
    async searchCanonicalIds(kind, q) {
      const needle = q.text?.toLowerCase();
      const hits: string[] = [];
      for (const c of canonicals.values()) {
        if (c.kind !== kind) continue;
        if (c.redirect.status === "merged") continue; // §4.2 search excludes merged
        if (q.identifier !== undefined && c.fields.identifierValue !== q.identifier) continue;
        if (needle !== undefined) {
          const hay = `${c.fields.displayName} ${c.fields.identifierValue ?? ""}`.toLowerCase();
          if (!hay.includes(needle)) continue;
        }
        hits.push(c.redirect.id);
      }
      return q.limit !== undefined ? hits.slice(0, q.limit) : hits;
    },
    async createProvisional() {
      // biome-ignore lint/suspicious/noAssignInExpressions: in-memory monotonic id counter.
      return { provisionalId: `prov_${(provisionalSeq += 1)}` };
    },
    async parentId() {
      return null;
    },
    async childIds() {
      return [];
    },
    async baaGate(orgId, _kind, canonicalId) {
      const entry = (baa.get(orgId) ?? []).find((e) => e.canonicalId === canonicalId);
      if (entry === undefined) return { required: true, status: "missing", expiresOn: null };
      return {
        required: true,
        status: entry.baaStatus === "n_a" ? "n_a" : entry.baaStatus,
        expiresOn: entry.expiresOn,
      };
    },
  };

  const service: MdmRouteService = {
    async upsertPhysicianOverlay(orgId, canonicalId, fields) {
      overlays.set(key(orgId, canonicalId), fields);
      return { applied: true };
    },

    async listBaa(orgId) {
      return baa.get(orgId) ?? [];
    },

    async recordBaa(orgId, input) {
      // biome-ignore lint/suspicious/noAssignInExpressions: in-memory monotonic id counter.
      const id = `baa_${(baaSeq += 1)}`;
      const entry: BaaRegisterEntry = { id, ...input };
      const list = baa.get(orgId) ?? [];
      // Replace any existing entry for the same (kind, canonicalId) — one register row per entity.
      const next = list.filter(
        (e) => !(e.kind === input.kind && e.canonicalId === input.canonicalId),
      );
      next.push(entry);
      baa.set(orgId, next);
      return { id };
    },

    async recordLicense() {
      return { recorded: true };
    },

    async listMergeRequests() {
      return [...merges.values()];
    },

    async approveMerge(mergeId) {
      const m = merges.get(mergeId);
      if (m === undefined) throw new Error(`merge request ${mergeId} not found`);
      if (m.status !== "pending")
        throw new Error(`merge request ${mergeId} is ${m.status}, not pending`);
      // §7.6: flip the duplicate to merged → survivor; update the survivor's merged_from.
      setRedirect(m.kind, m.duplicateId, {
        id: m.duplicateId,
        status: "merged",
        mergedIntoId: m.canonicalId,
      });
      merges.set(mergeId, { ...m, status: "executed" });
      return { duplicateId: m.duplicateId, canonicalId: m.canonicalId };
    },

    async rejectMerge(mergeId, _reason) {
      const m = merges.get(mergeId);
      if (m === undefined) throw new Error(`merge request ${mergeId} not found`);
      merges.set(mergeId, { ...m, status: "rejected" });
    },

    async promoteProvisional(provisionalId) {
      const canonicalId = seed.provisionalCanonicalIds?.[provisionalId] ?? `canon_${provisionalId}`;
      return { canonicalId };
    },

    async nppesLookup(npi) {
      const canonicalId = seed.nppesByNpi?.[npi] ?? null;
      return { matched: canonicalId !== null, canonicalId };
    },

    async nppesSyncLog() {
      return syncLog;
    },
  };

  return { store, service };
}
