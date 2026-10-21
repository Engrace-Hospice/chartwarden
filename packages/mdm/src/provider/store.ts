// @chartwarden/mdm — the `MdmStore` data port + an in-memory slice default (M40-T05, §4.5).
//
// The `MdmEntityProvider` seam (provider.ts) is PURE ORCHESTRATION: it runs the T04 merge-redirect
// chase + overlay join over rows this port returns. The port is the seam between the stable
// provider and the data layer — M40-T07 implements it over the per-kind canonical/overlay Drizzle
// tables, production injects that adapter, and the in-memory store here keeps the boot slice +
// unit tests free of live infra (the same injected-port pattern M38's `TerminologyStore` uses).
// The port returns DATA only; every redirect chase, overlay join, identifier match, and BAA-gate
// decision lives in the provider so that logic has one home and cannot drift across consumers.
//
// SCOPE (T05): this store answers from in-memory seed data with the minimal semantics the seam
// needs to be callable + merge-aware. Real fuzzy matching (§7.1 threshold), merge approval (§7.6),
// and the as-of BAA time-travel gate (§7.7, the `BaaStatusProvider` seam) are T06/T07/T08 — this
// default keeps them deliberately simple.

import type {
  CanonicalFields,
  IdentifyingFields,
  MdmBaaGateResult,
  OverlayFields,
  SearchSpec,
} from "../interfaces/entity-provider";
import type { MdmEntityKind } from "../interfaces/kinds";
import type { CanonicalRedirectRow } from "../resolve/follow-merge";

/**
 * The data-access boundary the {@link MdmEntityProvider} composes over. Every method returns raw
 * rows / records; the provider applies the redirect chase, overlay join, and gate decisions.
 * Implemented in-memory below for the slice; over Drizzle in T07.
 */
export interface MdmStore {
  /** The §2.5 redirect projection of a canonical row — drives the T04 `followMerge` chase. */
  canonicalRedirect(kind: MdmEntityKind, id: string): Promise<CanonicalRedirectRow | null>;

  /** The survivor canonical's full payload (after the redirect resolved its id). */
  canonicalFields<K extends MdmEntityKind>(kind: K, id: string): Promise<CanonicalFields<K> | null>;

  /** This tenant's overlay row for a (kind, canonicalId), or `null` when none / overlay-less kind. */
  overlay<K extends MdmEntityKind>(
    kind: K,
    orgId: string,
    canonicalId: string,
  ): Promise<OverlayFields<K> | null>;

  /** The canonical id whose public identifier exactly matches `value`, or `null` (§7.1 match). */
  canonicalIdByIdentifier(kind: MdmEntityKind, value: string): Promise<string | null>;

  /** Canonical ids matching a search spec (the store decides exact/fuzzy; slice does substring). */
  searchCanonicalIds<K extends MdmEntityKind>(
    kind: K,
    q: SearchSpec<K>,
  ): Promise<readonly string[]>;

  /** Record a provisional proposal when `getOrCreate` finds no identifier match; returns its id. */
  createProvisional<K extends MdmEntityKind>(
    orgId: string,
    kind: K,
    identifying: IdentifyingFields<K>,
    actorUserId: string,
  ): Promise<{ provisionalId: string }>;

  /** Canonical id of the hierarchy parent (`entity_relationship` parent edge), or `null` (§4.5). */
  parentId(kind: MdmEntityKind, id: string): Promise<string | null>;

  /** Canonical ids of the hierarchy children (`entity_relationship` parent edges into `id`). */
  childIds(kind: MdmEntityKind, id: string): Promise<readonly string[]>;

  /** The BAA-gate state for (org, kind, canonicalId) (§7.7). The as-of time-travel `BaaStatusProvider`
   *  seam (T06) supersedes this; the slice returns a recorded record or the `missing`/`n_a` default. */
  baaGate(orgId: string, kind: MdmEntityKind, canonicalId: string): Promise<MdmBaaGateResult>;
}

// ── in-memory slice default ─────────────────────────────────────────────────────────────────

/** A canonical seed row: the redirect projection + the typed payload, keyed by (kind, id). */
export interface SeedCanonical<K extends MdmEntityKind = MdmEntityKind> {
  readonly kind: K;
  readonly redirect: CanonicalRedirectRow;
  readonly fields: CanonicalFields<K>;
}

/** An overlay seed row for the physician overlay (the only Phase-1 overlay table). */
export interface SeedOverlay {
  readonly orgId: string;
  readonly canonicalId: string;
  readonly fields: OverlayFields<"physician">;
}

/** A hierarchy parent edge (`child` → `parent`), within one kind. */
export interface SeedRelationship {
  readonly kind: MdmEntityKind;
  readonly childId: string;
  readonly parentId: string;
}

/** A recorded BAA gate state for (org, kind, canonicalId). */
export interface SeedBaa {
  readonly orgId: string;
  readonly kind: MdmEntityKind;
  readonly canonicalId: string;
  readonly result: MdmBaaGateResult;
}

/** Seed shape for {@link createInMemoryMdmStore} — all fields optional. */
export interface InMemoryMdmSeed {
  readonly canonicals?: readonly SeedCanonical[];
  readonly overlays?: readonly SeedOverlay[];
  readonly relationships?: readonly SeedRelationship[];
  readonly baas?: readonly SeedBaa[];
}

/** Compound map key — space-joined; ids are uuids so no collision with the kind token. */
function key(...parts: string[]): string {
  return parts.join(" ");
}

/**
 * An in-memory {@link MdmStore} for the boot slice + unit tests. Deterministic, no I/O. Provisional
 * ids are a monotonically numbered sequence so `getOrCreate` is reproducible without a clock or
 * randomness. Production replaces this with the Drizzle-backed store (T07).
 */
export function createInMemoryMdmStore(seed: InMemoryMdmSeed = {}): { store: MdmStore } {
  const canonicals = new Map<string, SeedCanonical>();
  for (const c of seed.canonicals ?? []) canonicals.set(key(c.kind, c.redirect.id), c);

  const overlays = new Map<string, OverlayFields<"physician">>();
  for (const o of seed.overlays ?? []) overlays.set(key(o.orgId, o.canonicalId), o.fields);

  const parents = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const r of seed.relationships ?? []) {
    parents.set(key(r.kind, r.childId), r.parentId);
    const ck = key(r.kind, r.parentId);
    (children.get(ck) ?? children.set(ck, []).get(ck)!).push(r.childId);
  }

  const baas = new Map<string, MdmBaaGateResult>();
  for (const b of seed.baas ?? []) baas.set(key(b.orgId, b.kind, b.canonicalId), b.result);

  let provisionalSeq = 0;

  const store: MdmStore = {
    async canonicalRedirect(kind, id) {
      return canonicals.get(key(kind, id))?.redirect ?? null;
    },

    async canonicalFields<K extends MdmEntityKind>(kind: K, id: string) {
      return (canonicals.get(key(kind, id))?.fields as CanonicalFields<K> | undefined) ?? null;
    },

    async overlay<K extends MdmEntityKind>(kind: K, orgId: string, canonicalId: string) {
      // Only the physician kind has a Phase-1 overlay table; every other kind resolves to null.
      if (kind !== "physician") return null;
      return (overlays.get(key(orgId, canonicalId)) as OverlayFields<K> | undefined) ?? null;
    },

    async canonicalIdByIdentifier(kind, value) {
      for (const c of canonicals.values()) {
        if (c.kind === kind && c.fields.identifierValue === value) return c.redirect.id;
      }
      return null;
    },

    async searchCanonicalIds<K extends MdmEntityKind>(kind: K, q: SearchSpec<K>) {
      const needle = q.text?.toLowerCase();
      const hits: string[] = [];
      for (const c of canonicals.values()) {
        if (c.kind !== kind) continue;
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

    async parentId(kind, id) {
      return parents.get(key(kind, id)) ?? null;
    },

    async childIds(kind, id) {
      return children.get(key(kind, id)) ?? [];
    },

    async baaGate(orgId, kind, canonicalId) {
      // No recorded record ⇒ fail-closed `missing` (the real as-of gate is T06's BaaStatusProvider).
      return (
        baas.get(key(orgId, kind, canonicalId)) ?? {
          required: true,
          status: "missing",
          expiresOn: null,
        }
      );
    },
  };

  return { store };
}
