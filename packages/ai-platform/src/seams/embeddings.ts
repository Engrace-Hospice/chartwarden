// @wardenx/ai-platform — §4.2.6 `EmbeddingsProvider` (M32-T06).
//
// PUBLISHED WITH NO PHASE-1 CONSUMER, deliberately: §4.2.6 says these are "published with deny-stubs to
// lock the contract". A seam name that exists from the start is one that consumers can be written
// against; a seam name invented later is a second interface somebody has already worked around (the
// M15/M17 `VolunteerComplianceProvider` lesson).
//
// D20 — the namespace is TENANT-SCOPED and the index is per-tenant with `organization_id` LEADING the
// HNSW key. A shared index with an org filter was rejected as bypassable, so `namespace` here is a
// partition WITHIN a tenant, never across them: `organizationId` is not part of `namespace` and cannot
// be varied by the caller to reach another tenant's vectors.
import type { AiSeamRefusal } from "./common";

/** The tenant-scoped vector namespaces §4.2.6 names. */
export type EmbeddingsNamespace = "clinical_record" | "document" | "intake" | "protocol_library";

export interface EmbeddingsInput {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly namespace: EmbeddingsNamespace;
  readonly text: string;
  readonly sourceEntityType: string;
  readonly sourceEntityId: string;
}

export type EmbeddingsResult =
  | {
      readonly available: true;
      readonly invocationId: string;
      readonly vector: readonly number[];
      readonly modelVersionPin: string;
      readonly dimensions: number;
    }
  | AiSeamRefusal;

/** §4.2.6 — generate an embedding vector for text within a tenant-scoped namespace. */
export interface EmbeddingsProvider {
  embed(input: EmbeddingsInput): Promise<EmbeddingsResult>;
}
