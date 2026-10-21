// apps/backend/src/modules/22-documents/render-variants/medication-list-consumer.ts — F-171 (#248) the
// patient medication-list render pipeline: the §4.11 handshake for M12's `m12.medication_order
// .list_changed`, LIVE (the `lab-backref-consumer.ts` shape, but not a deny-stub — M12's
// `MedicationOrderProvider` seam is real and registered in production, M12-T07).
//
// Why NOT the generic `render-consumer.ts`/`REQUEST_SHAPES` pipeline: that pipeline only ever PROJECTS
// fields already present on the delivered payload — it has no content-resolution step. This event's real,
// catalogued payload (`{patientId, addedOrderIds, removedOrderIds}`, events-by-m12.ts) carries only a DIFF
// of which order ids were added/removed, never the full active-medication set a `patient_medication_list`
// document needs to render. F-166/F-168/F-170 traced this precisely and left it unbound for exactly this
// reason (a content gap, not an idempotency-key gap — `patient_medication_list`'s aggregate type/`
// TemplateDescriptor` already existed; see renderer.ts's own comment on the descriptor this pass added).
//
// The content instead comes from M12's own published `MedicationOrderProvider.getActiveMedications(orgId,
// patientId)` seam (`packages/types/src/dosespot.ts`) — resolved fresh at DELIVERY time, never from the
// diff payload, so a redelivered or later event always renders the CURRENT active-medication set rather
// than replaying stale added/removed ids. M22 `dependsOn` is `[1, 5]`; the seam is reached OPAQUELY via
// `getSeam("MedicationOrderProvider")` (../../../bootstrap/index), never a `@chartwarden/dosespot` import — the
// consent-gate.ts / lab-backref-bindings.ts precedent.
//
// This event fires REPEATEDLY against the same patient (every active-medication-set change), and each
// delivery is a genuinely NEW snapshot, not a correction of the prior one — the F-168 `appends: true`
// shape, applied outside the generic pipeline: idempotency is keyed on the SPECIFIC delivered outbox event
// id (`DocumentSeamStore.documentVersionForSourceEvent`), never on `(aggregateType, aggregateId)` alone,
// so a genuine redelivery (crash between render and receipt) never double-renders, and a later, different
// `list_changed` event for the same patient always produces a new `document_version` (never an
// `idempotent_skip`, the mistake the pre-F-168 aggregate-level key would have made here).
import type { DocumentRetentionClass } from "@chartwarden/types";
import {
  type PatientMedicationListRenderPayload,
  type RenderVariantResult,
  planMedicationListRender,
} from "./render-variants";

/** The `m12.medication_order.list_changed` event this consumer drains (events-by-m12.ts). */
export const M22_MEDICATION_LIST_EVENT = "m12.medication_order.list_changed" as const;

/** The M22 consumer name — the `(eventId, consumerName)` dedup identity (§4.11). */
export const M22_MEDICATION_LIST_CONSUMER = "m22.medication-list-renderer" as const;

/** The `m12.medication_order.list_changed` payload, as M12 hands it on the outbox (matches the catalogued
 * `payloadSchema` in events-by-m12.ts exactly). M22 reads only `patientId` — the aggregate identity; the
 * added/removed order-id arrays name WHAT changed, not the resulting set, so they are not content this
 * render can use (see file header). */
export interface MedicationListChangedPayload {
  readonly patientId: string;
  readonly addedOrderIds: readonly string[];
  readonly removedOrderIds: readonly string[];
}

/** The facts the live consumer resolves before deciding a medication-list render — surfaced as DATA so the
 * decider stays pure. */
export interface MedicationListFacts {
  /** A prior render already exists for THIS SPECIFIC delivered outbox event id (crash-retry redelivery) —
   *  re-announce, never re-render (D14, the F-168 per-request granularity). */
  readonly alreadyRendered: boolean;
  /** M12's `MedicationOrderProvider.getActiveMedications` resolved the current active set (false ⇒ the
   *  seam threw / is unregistered — NEVER render an empty-by-omission list, the same "no silent empty
   *  medication list" rule the seam's own deny-stub enforces). */
  readonly medicationsResolved: boolean;
  /** The resolved render payload (possibly an EMPTY medication list — a patient with every order
   *  discontinued is a legitimate, honestly-rendered outcome). Null when unresolved. */
  readonly renderPayload: PatientMedicationListRenderPayload | null;
  /** The M39 `ConsentEvaluator` returned an active `42_cfr_part_2_release` consent (drives §7.16
   *  redaction of any SUD-treatment row) — resolved by the live consumer ONLY when at least one medication
   *  is SUD-treatment (the same "skip the seam call when nothing needs it" optimization
   *  `render-consumer.ts` applies); `false` when no medication needs it (harmless — nothing to redact). */
  readonly sudConsentPresent: boolean;
}

/** The single effect the medication-list decider resolves for one delivered `.list_changed` event. */
export type MedicationListAction =
  /** Re-delivery of an already-rendered request — skip, no duplicate document version (D14). */
  | { readonly kind: "idempotent_skip" }
  /** M12's active-medication seam is unavailable — defer (the caller throws; retry-then-DLQ per §7.2).
   *  NEVER render a list that silently omits every medication because the read failed. */
  | { readonly kind: "medications_unresolved"; readonly patientId: string }
  /** The happy path — render the medication-list variant (§7.16 SUD redaction baked in by `consentPresent`).
   *  A genuinely EMPTY medication set still renders (an honest "no active medications" document). */
  | {
      readonly kind: "render";
      readonly variant: RenderVariantResult;
      readonly retentionClass: DocumentRetentionClass;
      readonly patientId: string;
    };

/**
 * Decide the single effect for one delivered `m12.medication_order.list_changed` (pure). Gate order:
 * idempotency (this exact outbox event id) → M12-medications-resolved (fail-closed, never a silent empty
 * list) → render the medication-list variant with §7.16 SUD redaction applied per-row via the injected
 * `sudConsentPresent`. The live consumer executes the returned `render` through the T04 `DocumentRenderer`
 * seam, then emits `m22.document.rendered` (optional — nothing currently back-refs a patient-level
 * document id, so the render is discoverable via `document.(aggregate_type, aggregate_id)` regardless).
 */
export function decideMedicationListRender(
  payload: MedicationListChangedPayload,
  facts: MedicationListFacts,
): MedicationListAction {
  // 1. Idempotency (D14, F-168 per-request granularity): a re-delivery of the SAME outbox event never
  //    produces a second document version for the same delivery.
  if (facts.alreadyRendered) return { kind: "idempotent_skip" };

  // 2. M12 seam fail-closed: no resolved active-medication set ⇒ refuse to render (never a fabricated or
  //    silently-empty list — the same rule `medicationOrderProviderDenyStub` enforces at the seam itself).
  if (!facts.medicationsResolved || facts.renderPayload === null) {
    return { kind: "medications_unresolved", patientId: payload.patientId };
  }

  // 3. Happy path — plan the §7.16 medication-list render variant (SUD redaction baked in by the consent
  //    fact). An empty `medications` array is a legitimate render, not a refusal.
  const variant = planMedicationListRender({
    payload: facts.renderPayload,
    consentPresent: facts.sudConsentPresent,
  });
  const retentionClass: DocumentRetentionClass =
    variant.retentionClassOverride ?? "clinical_record";
  return { kind: "render", variant, retentionClass, patientId: payload.patientId };
}
