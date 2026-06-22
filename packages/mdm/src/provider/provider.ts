// @wardenx/mdm — the REAL `MdmEntityProvider` (M40-T05, spec §4.5).
//
// This is the implementation M40 registers into the M1 seam registry at boot — the master-data
// read surface every clinical/billing/interop consumer uses (a patient's attending physician, a
// claim's payer, an order's facility). It is pure ORCHESTRATION over the injected {@link MdmStore}:
// the store returns rows, this provider runs the T04 merge-redirect chase (`followMerge`) and the
// canonical+overlay join (`joinOverlay`) — so the §7.2 "the merge redirect is invisible to
// consumers" guarantee has exactly one home and every consumer resolves the same way.
//
// Design invariant (§7.2): every `resolve*` follows `merged_into_id` transparently; a FK to a
// now-merged row keeps resolving to its survivor forever, with `resolvedFrom` set so the caller
// MAY lazily patch its FK. `status` is never `merged` — the chase always lands on a live survivor.
//
// SCOPE (T05): the seam is whole + callable. Deeper behaviours land behind this same interface:
// real fuzzy matching (§7.1 `fuzzy_candidates`) + merge approval (§7.6) are T07/T08; the as-of BAA
// time-travel gate (§7.7) is the `BaaStatusProvider` seam (T06) this delegates to. The slice store
// keeps those deliberately simple here.

import type {
  IdentifyingFields,
  MdmEntityProvider,
  MdmResolved,
  SearchSpec,
} from "../interfaces/entity-provider";
import type { MdmEntityKind } from "../interfaces/kinds";
import { followMerge, joinOverlay } from "../resolve";
import type { MdmStore } from "./store";

/**
 * Resolve one entity end-to-end: chase the redirect to its survivor (§7.2), load the survivor's
 * canonical payload + this tenant's overlay (§2.3), and join them. Returns `null` for an unknown id
 * (a dangling FK). `orgId` is `null` for the canonical-shape hierarchy reads (parentOf/childrenOf),
 * which never join an overlay (§4.5 "same answer for everyone").
 */
async function resolveOne<K extends MdmEntityKind>(
  store: MdmStore,
  orgId: string | null,
  kind: K,
  id: string,
): Promise<MdmResolved<K> | null> {
  const redirect = await followMerge((k, i) => store.canonicalRedirect(k, i), kind, id);
  if (redirect === null) return null;
  const canonical = await store.canonicalFields(kind, redirect.id);
  if (canonical === null) {
    // followMerge resolved an id whose payload is gone — same corruption class the chase guards.
    return null;
  }
  const overlay = orgId === null ? null : await store.overlay(kind, orgId, redirect.id);
  return joinOverlay(redirect, canonical, overlay) as MdmResolved<K>;
}

/**
 * Build the real {@link MdmEntityProvider} over an injected {@link MdmStore}. The boot slice passes
 * the in-memory store; production passes the Drizzle/Valkey-backed store (T07).
 */
export function createMdmEntityProvider(store: MdmStore): MdmEntityProvider {
  const resolveKind = <K extends MdmEntityKind>(orgId: string, kind: K, id: string) =>
    resolveOne(store, orgId, kind, id);

  return {
    resolvePhysician: (orgId, id) => resolveKind(orgId, "physician", id),
    resolveFacility: (orgId, id) => resolveKind(orgId, "facility", id),
    resolvePharmacy: (orgId, id) => resolveKind(orgId, "pharmacy", id),
    resolveReferralSource: (orgId, id) => resolveKind(orgId, "referral_source", id),
    resolvePayer: (orgId, id) => resolveKind(orgId, "payer", id),
    resolveDmeVendor: (orgId, id) => resolveKind(orgId, "dme_vendor", id),
    resolveFuneralHome: (orgId, id) => resolveKind(orgId, "funeral_home", id),

    async resolveBatch<K extends MdmEntityKind>(
      orgId: string,
      kind: K,
      ids: readonly string[],
    ): Promise<Map<string, MdmResolved<K>>> {
      const out = new Map<string, MdmResolved<K>>();
      // Resolve each requested id; a merged id keys the result by its ORIGINAL id (what the caller
      // asked for) so the caller can patch the row it holds — `resolved.id` carries the survivor.
      await Promise.all(
        ids.map(async (id) => {
          const resolved = await resolveOne(store, orgId, kind, id);
          if (resolved !== null) out.set(id, resolved);
        }),
      );
      return out;
    },

    async search<K extends MdmEntityKind>(
      orgId: string,
      kind: K,
      q: SearchSpec<K>,
    ): Promise<MdmResolved<K>[]> {
      const ids = await store.searchCanonicalIds(kind, q);
      const resolved = await Promise.all(ids.map((id) => resolveOne(store, orgId, kind, id)));
      return resolved.filter((r): r is MdmResolved<K> => r !== null);
    },

    async getOrCreate<K extends MdmEntityKind>(
      orgId: string,
      kind: K,
      identifying: IdentifyingFields<K>,
      actorUserId: string,
    ) {
      // §7.1: an identifier already in canonical returns `matched_canonical` — no provisional, no
      // duplicate row. (The above-threshold `fuzzy_candidates` branch is the T07/T08 proposal path.)
      const matchId = await store.canonicalIdByIdentifier(kind, identifying.identifierValue);
      if (matchId !== null) {
        const entity = await resolveOne(store, orgId, kind, matchId);
        if (entity !== null) return { kind: "matched_canonical" as const, entity };
      }
      const { provisionalId } = await store.createProvisional(
        orgId,
        kind,
        identifying,
        actorUserId,
      );
      return { kind: "created_provisional" as const, provisionalId };
    },

    async parentOf<K extends MdmEntityKind>(kind: K, id: string): Promise<MdmResolved<K> | null> {
      const parentId = await store.parentId(kind, id);
      // Hierarchy is canonical-shape — same answer for everyone, so no overlay (orgId = null).
      return parentId === null ? null : resolveOne(store, null, kind, parentId);
    },

    async childrenOf<K extends MdmEntityKind>(kind: K, id: string): Promise<MdmResolved<K>[]> {
      const ids = await store.childIds(kind, id);
      const resolved = await Promise.all(ids.map((cid) => resolveOne(store, null, kind, cid)));
      return resolved.filter((r): r is MdmResolved<K> => r !== null);
    },

    async baaStatus(orgId, kind, id) {
      // Resolve the redirect first so a BAA recorded against the survivor still gates a merged id
      // (§7.2). The real as-of time-travel decision is T06's BaaStatusProvider; this delegates to
      // the store's recorded state for now.
      const redirect = await followMerge((k, i) => store.canonicalRedirect(k, i), kind, id);
      const canonicalId = redirect?.id ?? id;
      return store.baaGate(orgId, kind, canonicalId);
    },
  };
}
