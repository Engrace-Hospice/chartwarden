// @wardenx/ai-platform — §4.2.6 `SemanticSearchProvider` (M32-T06).
//
// "SemanticSearchProvider + CopilotProvider follow same shape; full interfaces in
// packages/ai-platform/src/seams/copilot.ts and semantic-search.ts" — §4.2.6 hands M32 the file and the
// shape and leaves the method surface to the module. This is that surface, kept minimal on purpose: a
// PROPOSED capability with no consumer should lock the smallest contract that is still usable, because
// every method here is a method a Phase-2 consumer can be held to.
//
// D20 — the search is scoped to ONE tenant's index. `organizationId` comes from the SESSION at the
// route/seam boundary (§2.6 invariant (a)); a caller cannot widen it, and `namespace` partitions within
// a tenant, never across.
//
// §2.4 registers `semantic_search_chart` at `PROPOSED` with `caseload_or_scope` as the M3 predicate that
// must gate it — there is NO upstream module enforcing chart scope for a direct-UI capability, which is
// why the result rows carry entity references rather than content: whatever renders a hit re-reads it
// through the owning module's own read path, under that module's own authorization.
import type { AiSeamRefusal } from "./common";
import type { EmbeddingsNamespace } from "./embeddings";

export interface SemanticSearchInput {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly namespace: EmbeddingsNamespace;
  readonly queryText: string;
  /** Restricts the search to one patient's chart. Omit for a tenant-wide (non-PHI corpus) namespace. */
  readonly patientId?: string | null;
  /** 1..50. The implementation clamps; the contract states the intent. */
  readonly limit?: number;
}

/** One hit. A REFERENCE, never the content — see the header. */
export interface SemanticSearchHit {
  readonly sourceEntityType: string;
  readonly sourceEntityId: string;
  /** Cosine similarity in [0, 1]; higher is closer. */
  readonly score: number;
}

export type SemanticSearchResult =
  | {
      readonly available: true;
      readonly invocationId: string;
      readonly hits: readonly SemanticSearchHit[];
      readonly modelVersionPin: string;
    }
  | AiSeamRefusal;

/** §4.2.6 — chart-scoped semantic search over a tenant's own vector index. */
export interface SemanticSearchProvider {
  search(input: SemanticSearchInput): Promise<SemanticSearchResult>;
}
