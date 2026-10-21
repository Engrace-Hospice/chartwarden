// @chartwarden/terminology-loader — `terminology.refresh_embeddings` (M38 §3.1, §4.3, D5).
//
// Embeds the concepts of a system's ACTIVE version that have no vector yet and writes them through the loader door.
// The embedder is a PORT. The intended implementation is the local BGE-small-en-v1.5 sidecar behind the M32
// `ModelBackend.embed` contract (packages/ai-platform, backend key `local-bge-small-en`) — that sidecar is NOT
// built in this repository, so production binds {@link embedderUnavailable}: `available` is false, the admin
// route answers 503 EMBEDDINGS_NOT_CONFIGURED, an activation does not enqueue this job, and semantic search stays
// on its fuzzy fallback (§7.10). Nothing here fabricates a vector.
import { LoaderDataError } from "./errors";
import type { LoaderLogger } from "./ports";
import type { LoadableSystemId } from "./types";

/** The vector width of `concept_embedding.embedding` (BGE-small-en-v1.5). */
export const EMBEDDING_DIMENSIONS = 384;
/** Concepts embedded per call to the embedder and per write. */
export const EMBEDDING_BATCH_SIZE = 256;
/** Concepts one run will embed before yielding (the job re-enqueues itself for the remainder). */
export const EMBEDDING_MAX_PER_RUN = 50_000;

export interface EmbedderPort {
  readonly available: boolean;
  readonly modelId: string;
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

/** The fail-closed default while no embeddings backend exists. */
export const embedderUnavailable: EmbedderPort = {
  available: false,
  modelId: "unconfigured",
  async embed() {
    throw new LoaderDataError("EMBEDDINGS_NOT_CONFIGURED", "no embeddings backend is bound");
  },
};

export interface EmbeddingStorePort {
  activeVersionId(system: LoadableSystemId): Promise<string | null>;
  /** Concepts of the version with no `concept_embedding` row yet, after `afterCode`, ordered by code. */
  conceptsMissingEmbeddings(
    system: LoadableSystemId,
    versionId: string,
    afterCode: string | null,
    limit: number,
  ): Promise<readonly { readonly code: string; readonly display: string }[]>;
  writeEmbeddings(
    versionId: string,
    modelId: string,
    rows: readonly { readonly code: string; readonly embedding: readonly number[] }[],
  ): Promise<number>;
  logEmbedded(system: LoadableSystemId, versionId: string, conceptCount: number): Promise<void>;
}

export interface RefreshEmbeddingsResult {
  readonly outcome: "refreshed" | "no_active_version" | "embedder_unavailable";
  readonly embedded: number;
  /** True when the per-run cap stopped the walk with concepts remaining. */
  readonly hasMore: boolean;
}

function assertVectors(vectors: readonly (readonly number[])[], expected: number): void {
  if (vectors.length !== expected) {
    throw new LoaderDataError(
      "EMBEDDING_INVALID",
      `embedder returned ${vectors.length} vectors for ${expected} inputs`,
    );
  }
  for (const v of vectors) {
    if (v.length !== EMBEDDING_DIMENSIONS || !v.every(Number.isFinite)) {
      throw new LoaderDataError(
        "EMBEDDING_INVALID",
        `vector is not ${EMBEDDING_DIMENSIONS} finite numbers`,
      );
    }
  }
}

/** Embed the active version's un-embedded concepts, batch by batch, up to the per-run cap. Idempotent. */
export async function runRefreshEmbeddings(
  deps: {
    readonly store: EmbeddingStorePort;
    readonly embedder: EmbedderPort;
    readonly log: LoaderLogger;
  },
  system: LoadableSystemId,
  maxPerRun: number = EMBEDDING_MAX_PER_RUN,
): Promise<RefreshEmbeddingsResult> {
  if (!deps.embedder.available)
    return { outcome: "embedder_unavailable", embedded: 0, hasMore: false };
  const versionId = await deps.store.activeVersionId(system);
  if (versionId === null) return { outcome: "no_active_version", embedded: 0, hasMore: false };
  let after: string | null = null;
  let embedded = 0;
  while (embedded < maxPerRun) {
    const batch = await deps.store.conceptsMissingEmbeddings(
      system,
      versionId,
      after,
      Math.min(EMBEDDING_BATCH_SIZE, maxPerRun - embedded),
    );
    if (batch.length === 0) {
      if (embedded > 0) await deps.store.logEmbedded(system, versionId, embedded);
      return { outcome: "refreshed", embedded, hasMore: false };
    }
    const vectors = await deps.embedder.embed(batch.map((c) => c.display));
    assertVectors(vectors, batch.length);
    await deps.store.writeEmbeddings(
      versionId,
      deps.embedder.modelId,
      batch.map((c, i) => ({ code: c.code, embedding: vectors[i] as readonly number[] })),
    );
    embedded += batch.length;
    after = (batch[batch.length - 1] as { code: string }).code;
  }
  await deps.store.logEmbedded(system, versionId, embedded);
  deps.log.info({ system, versionId, embedded }, "embedding run reached its per-run cap");
  return { outcome: "refreshed", embedded, hasMore: true };
}
