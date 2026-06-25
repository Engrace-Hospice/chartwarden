// @wardenx/saas-tenant-platform · consumers — the M22 §1.1-handshake back-ref consumer (M34 §7.3, D9).
//
// THE DOWNSTREAM HALF OF THE DSAR RENDER HANDSHAKE. The DSAR worker emits `m22.document.upload_requested`
// for the rendered FHIR-Bundle PDF + NDJSON manifest (`services/dsar-export-worker.ts`); M22 renders +
// stores both and replies `m22.document.rendered` carrying the new `document_id` keyed by the aggregate
// the request named (the DSAR `jobId`). This consumer subscribes to that reply and writes the
// `document_id` onto `dsar_export_job.bundle_document_id` — closing the loop (M22 spec §4.11 / §7.2; the
// M14 `m14-document-backref` precedent, `apps/backend/src/modules/14-idg/consumers/index.ts`).
//
// PURE DECISION CORE (the M22 `decideDocumentRequest` / M6-T11 pattern): no Drizzle, no `getSeam`, no
// outbox import — just the mapping from a delivered `m22.document.rendered` reply to the
// {@link DsarBackRefAction} the live consumer executes (the `DsarExportRepository.update` write under the
// tenant's RLS). M34 reads M22 SOLELY through the foundation outbox event STRING, so this adds NO new
// manifest `dependsOn` edge (the M22 reach is outbox, no-edge per ADR-0005). The consumed event name is a
// string literal; the consumed payload is a locally-declared structural minimum (M22 owns the canonical
// wire payload). Idempotency rides the M1 outbox-consumer rail: a back-ref already applied → no-op.
import type { DsarExportRepository } from "../repositories";

/** The M22 reply event this consumer subscribes to (the downstream half of the §1.1 handshake). */
export const M22_DOCUMENT_RENDERED = "m22.document.rendered" as const;

/** The M22 aggregate-type the DSAR upload-request named (kept in lock-step with the worker's value) so we
 *  only act on the DSAR back-ref, never some other module's render reply that shares the dispatcher. */
export const DSAR_DOCUMENT_AGGREGATE_TYPE = "other" as const;

/**
 * The structural minimum M34 reads off `m22.document.rendered` (M22 owns the canonical superset). The
 * `aggregateId` is the value M34 put in the upload-request — the DSAR `jobId` — so the consumer resolves
 * the job to patch without M22 knowing anything about `dsar_export_job`. `aggregateType` discriminates a
 * DSAR back-ref from any other module's render reply on the shared dispatcher.
 */
export interface M22DocumentRenderedPayload {
  readonly organizationId: string;
  /** The owning-module artifact the rendered document materialized (we act only on the DSAR value). */
  readonly aggregateType: string;
  /** The aggregate the rendered document back-refs — the DSAR `jobId` M34 sent in the upload-request. */
  readonly aggregateId: string;
  /** The newly-stored M22 document the DSAR bundle PDF + NDJSON manifest live under. */
  readonly documentId: string;
}

/** What the facts the live consumer resolves before deciding (kept as data so the decider stays pure). */
export interface DsarBackRefFacts {
  /** The `dsar_export_job` the `aggregateId` resolves to still exists for this org (RLS-scoped lookup). */
  readonly jobExists: boolean;
  /** A `bundle_document_id` is already set on the job (a prior delivery applied the back-ref — D14). */
  readonly alreadyLinked: boolean;
}

/** The single effect the back-ref decider returns for one delivered `m22.document.rendered` reply. */
export type DsarBackRefAction =
  /** The reply is not a DSAR back-ref (different `aggregateType`) — ignore it (shared dispatcher). */
  | { readonly kind: "not_dsar" }
  /** A re-delivery whose back-ref is already applied — no-op (idempotency, D14). */
  | { readonly kind: "idempotent_skip" }
  /** The named job is gone (denied/destroyed before the render landed) — drop; nothing to link. */
  | { readonly kind: "job_absent"; readonly jobId: string }
  /** Apply `dsar_export_job.bundle_document_id = documentId` for `jobId` (the happy path). */
  | { readonly kind: "apply_backref"; readonly jobId: string; readonly documentId: string };

/**
 * Decide the single effect for one delivered `m22.document.rendered` reply (PURE). The live consumer
 * resolves {@link DsarBackRefFacts} (job-exists + already-linked) from the `DsarExportRepository` under
 * the tenant's RLS, then runs the returned action. Gate order: is-DSAR → idempotency → job-present →
 * apply. The `aggregateId` IS the DSAR `jobId` (the worker set it that way in the upload-request).
 */
export function decideDsarBackRef(
  payload: M22DocumentRenderedPayload,
  facts: DsarBackRefFacts,
): DsarBackRefAction {
  // 1. Only DSAR render replies are ours — other modules share this dispatcher event.
  if (payload.aggregateType !== DSAR_DOCUMENT_AGGREGATE_TYPE) return { kind: "not_dsar" };

  // 2. Idempotency (D14): re-delivery never re-links / overwrites a settled bundle document.
  if (facts.alreadyLinked) return { kind: "idempotent_skip" };

  // 3. The job may have been denied / destroyed between request and reply — nothing to link onto.
  if (!facts.jobExists) return { kind: "job_absent", jobId: payload.aggregateId };

  // 4. Happy path — write `bundle_document_id`.
  return { kind: "apply_backref", jobId: payload.aggregateId, documentId: payload.documentId };
}

/**
 * Execute a {@link DsarBackRefAction} against the `DsarExportRepository` (the live-consumer side; thin,
 * so the decision stays the unit-tested core). Only `apply_backref` writes — every other action is a
 * deliberate no-op. MUST be called inside the requesting tenant's `withOrgContext` (RLS scopes the
 * update to the owning org; F09). Returns the action so the caller can log/audit the disposition.
 */
export async function applyDsarBackRef(
  action: DsarBackRefAction,
  repo: DsarExportRepository,
): Promise<DsarBackRefAction> {
  if (action.kind === "apply_backref") {
    await repo.update(action.jobId, { bundleDocumentId: action.documentId });
  }
  return action;
}

/** The §4.5 event → consumer binding the boot dispatcher wires (the M14 `M14_OUTBOX_SUBSCRIPTIONS` shape).
 *  Consumer dedup is keyed `(eventId, consumerName)` per the M1 outbox-consumer pattern; re-delivery is
 *  safe (the decider's idempotency gate backstops it). */
export const M34_DSAR_BACKREF_SUBSCRIPTION = {
  eventName: M22_DOCUMENT_RENDERED,
  consumerName: "m34.m22-document-backref",
} as const;
