// apps/backend/src/modules/22-documents/lifecycle/effects.ts — M22-T03 (§2.4).
//
// §2.4 fixes the pattern: every document-lifecycle transition carries an explicit, in-transaction
// side-effect list (audit + outbox + child-row ops + the MinIO destroy descriptor), and the COMMIT binds
// the domain row, the audit row and the outbox row atomically — the "DB updated but the event never went
// out" failure mode is eliminated structurally. This pure engine (M22-T03) returns side effects
// DECLARATIVELY as data; the service layer (a later M22 task) executes them inside the aggregate's
// optimistic-locked transaction. Keeping them as data makes the machines deterministic and unit-testable
// with no DB and no MinIO client (D1 storage stays a port — see @wardenx/types DocumentStorageProvider).
import type {
  DocumentAccessKind,
  IsoInstant,
  M22EventName,
} from "@wardenx/types";

/**
 * One in-transaction side effect a transition declares (§2.4). The service layer is the only place these
 * run; the machine never touches IO. `outbox` events are restricted to the §4.10 `m22.*` catalog.
 */
export type DocumentSideEffect =
  /** Write the M4 write-audit row for the aggregate (always present per §2.4). */
  | { readonly kind: "audit" }
  /** Publish an `m22.*` outbox event in the same tx (§4.10 catalog). */
  | { readonly kind: "outbox"; readonly event: M22EventName }
  /** Flip `document.active_version_id` to the new version (the single source of "current"; D2). */
  | { readonly kind: "flip_active_version"; readonly versionId: string }
  /** Mark the prior version's document `status='superseded'` (the D21 two-PDF external-source case). */
  | { readonly kind: "set_status"; readonly status: string }
  /** Insert the §3.3 `document_legal_hold` row (on M4 legal_hold.applied). */
  | { readonly kind: "insert_legal_hold"; readonly legalHoldEventId: string }
  /** Stamp `document_legal_hold.released_at` on the active hold (on M4 legal_hold.released). */
  | { readonly kind: "release_legal_hold" }
  /** Version-aware MinIO destruction: delete EVERY object version + delete-marker (D12 / DR-019). */
  | {
      readonly kind: "destroy_objects";
      readonly bucket: string;
      readonly objectKeys: ReadonlyArray<string>;
    }
  /** Cryptographically shred the per-tenant DEK for the version cipher columns (D12 second layer). */
  | { readonly kind: "shred_dek" }
  /** Null `document.active_version_id` as part of tombstoning (D12). */
  | { readonly kind: "null_active_version" }
  /** Append a `document_access_log` row (pure event descriptor; §2.4 / §164.528 accounting). */
  | {
      readonly kind: "access_log";
      readonly accessKind: DocumentAccessKind;
      readonly at: IsoInstant;
    }
  /** Set a timestamp/marker column on the aggregate (e.g. `tombstoned_at`, `released_at`). */
  | { readonly kind: "set_timestamp"; readonly field: string; readonly at: IsoInstant }
  /** Set a free-text/marker column on the aggregate (e.g. the new patient_id on a merge cascade). */
  | { readonly kind: "set_field"; readonly field: string; readonly value: string };

/** A transition's full result — the new state + its ordered side-effect list. */
export interface DocumentTransitionResult<S extends string, E extends string> {
  readonly from: S;
  readonly event: E;
  readonly to: S;
  readonly effects: ReadonlyArray<DocumentSideEffect>;
}

/** Build a {@link DocumentTransitionResult} (keeps the machines terse and uniform). */
export function result<S extends string, E extends string>(
  from: S,
  event: E,
  to: S,
  effects: ReadonlyArray<DocumentSideEffect>,
): DocumentTransitionResult<S, E> {
  return { from, event, to, effects };
}
