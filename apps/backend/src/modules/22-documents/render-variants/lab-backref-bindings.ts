import { getSeam } from "../../../bootstrap/index";
// apps/backend/src/modules/22-documents/render-variants/lab-backref-bindings.ts — M22-T09 the §7.15 lab-
// results back-ref LIVE binding. Bound since F-171 (#248) — M29's `LabObservationReader` seam is registered
// at boot (`registerM29PublishedSeams`), and this file's own `resolveLabResultsPayload` used to call a
// method (`resolveLabResultsPayload` on the seam itself) the real interface never had — a name mismatch the
// deny-stub silently absorbed, so the whole pipeline fail-closed forever even once M29 landed. Fixed to call
// the REAL registered method (`getByObservationId`, added alongside this fix — see `published.ts`), and the
// M29 DTO → M22 render-payload mapping (previously assumed to happen INSIDE the seam) now lives in
// `./lab-backref-consumer.ts`'s `buildLabResultsRenderPayload`, pure and locally testable.
//
// What ships now: the LIVE wiring — subscribing the boot dispatcher to `m11.order.results_received`,
// resolving the M29 `LabObservationReader` seam, calling the pure decider, executing the render via the T04
// `DocumentRenderer` seam, and emitting `m22.document.rendered` so M11's own back-ref consumer stamps
// `order_record.document_id`. The event name is a STRING literal and the M29 seam is reached OPAQUELY via
// getSeam, so M22 deps stay `[1, 5]` (no producer import, no edge).
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { resolveSudConsentPresent } from "../outbox-consumers/consent-gate";
import { getDocumentRenderer } from "../seams";
import type { DocumentSeamStore } from "../seams/store";
import {
  type LabBackrefFacts,
  type LabObservationSeamDtoPort,
  type LabResultsRequestPayload,
  M22_LAB_RESULTS_CONSUMER,
  M22_LAB_RESULTS_EVENT,
  buildLabResultsRenderPayload,
  decideLabBackref,
} from "./lab-backref-consumer";
import type { LabResultsRenderPayload } from "./render-variants";

/** The forward-declared §7.15 binding: the consumed event + the M22 consumer the dispatcher routes to. */
export interface LabBackrefBinding {
  readonly eventName: typeof M22_LAB_RESULTS_EVENT;
  readonly consumerName: typeof M22_LAB_RESULTS_CONSUMER;
}

/** The §7.15 binding (one event → the lab-results render consumer). */
export const M22_LAB_RESULTS_BINDING: LabBackrefBinding = {
  eventName: M22_LAB_RESULTS_EVENT,
  consumerName: M22_LAB_RESULTS_CONSUMER,
} as const;

/** False since F-171 (#248) — `buildM22LabBackrefConsumer` is registered with the boot dispatcher. Kept
 *  (rather than deleted) so the assertion that used to pin it `true` now pins it `false` — the §4.11
 *  `M22_DOCUMENT_REQUEST_BINDINGS_DEFERRED` precedent. */
export const M22_LAB_RESULTS_BINDING_DEFERRED = false;

/** The M22-side structural projection of M29's real `LabObservationReader` (the two arms M22 consumes). The
 * real (richer) contract lives in `29-external-interfaces/seams/published.ts`; M22 reads it opaquely from
 * the M1 registry — never a producer import. */
export interface LabObservationReaderPort {
  getByObservationId(input: {
    organizationId: string;
    observationId: string;
  }): Promise<LabObservationSeamDtoPort | null>;
}

/**
 * Resolve the lab-results render payload via M29's real `LabObservationReader.getByObservationId` seam
 * (§7.15, F-171). Fail-CLOSED on any seam error / unregistered seam / no matching row — the decider then
 * defers (`observations_unresolved`), which the worker retries-then-dead-letters; it NEVER renders a
 * blank/unredacted lab PDF.
 */
export async function resolveLabResultsPayload(
  requestPayload: LabResultsRequestPayload,
): Promise<LabResultsRenderPayload | null> {
  try {
    const reader = getSeam("LabObservationReader") as unknown as LabObservationReaderPort;
    if (typeof reader?.getByObservationId !== "function") return null; // seam not registered / wrong shape
    const dto = await reader.getByObservationId({
      organizationId: requestPayload.organizationId,
      observationId: requestPayload.observationId,
    });
    if (dto === null) return null;
    return buildLabResultsRenderPayload(requestPayload, dto);
  } catch {
    return null; // fail-closed — observation reader unavailable ⇒ defer the render
  }
}

// ── The live consumer ───────────────────────────────────────────────────────────────────────────────────

/** The `m22.document.rendered` payload the consumer hands to the emitter (see ../events-by-m22.ts). Mirrors
 *  `outbox-consumers/render-consumer.ts`'s `DocumentRenderedEmit` shape exactly — one shared wire contract. */
export interface LabBackrefRenderedEmit {
  readonly organizationId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly versionNumber: number;
  readonly isFirstVersion: boolean;
  readonly templateKey: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly retentionClass: string;
  readonly patientId: string | null;
  readonly sourceEvent: string;
  readonly sourceModule: string;
  readonly renderedAt: string;
}

export interface LabBackrefConsumerDeps {
  /** The document-ROW store (idempotency + the W2 upsert) — the SAME store instance shape
   *  `buildM22DocumentRequestConsumer` uses; production injects a fresh `createDrizzleDocumentSeamStore`. */
  readonly store: DocumentSeamStore;
  /** Overridable for tests; production resolves M22's own registered `DocumentRenderer` seam lazily. */
  readonly renderer?: () => {
    render(
      scope: { orgId: string },
      templateKey: string,
      payload: unknown,
    ): Promise<{ documentId: string }>;
  };
  /** Overridable for tests; production calls the real M29 seam via {@link resolveLabResultsPayload}. */
  readonly resolvePayload?: (
    requestPayload: LabResultsRequestPayload,
  ) => Promise<LabResultsRenderPayload | null>;
  /** Overridable for tests; production consults the real M39 `ConsentEvaluator` seam. */
  readonly resolveSudConsent?: (input: {
    organizationId: string;
    patientId: string;
  }) => Promise<boolean>;
  /** The §7.2 downstream half: emits `m22.document.rendered` so M11's back-ref consumer stamps
   *  `order_record.document_id`. Optional — omitted, the render still happens and stays reachable through
   *  `document.(aggregate_type, aggregate_id)`; the source row's column simply stays NULL. */
  readonly emitRendered?: (event: LabBackrefRenderedEmit) => Promise<void>;
  /** Structured sink for the `observations_unresolved` defer outcome — visible without being a dead letter
   *  on its FIRST occurrence (the dispatcher still retries-then-DLQs via the thrown error). */
  readonly onDeferred?: (info: {
    readonly organizationId: string;
    readonly orderId: string;
    readonly observationId: string;
  }) => void;
}

/** Raised when M29 has not (yet) resolved the observation an `m11.order.results_received` names. The
 *  dispatcher retries then dead-letters — never a silent skip of a clinical lab result. */
export class LabObservationUnresolvedError extends Error {
  readonly code = "LAB_OBSERVATION_UNRESOLVED";
  constructor(observationId: string) {
    super(`lab observation '${observationId}' not resolved by M29 LabObservationReader`);
    this.name = "LabObservationUnresolvedError";
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/** Parse the delivered `m11.order.results_received` payload into {@link LabResultsRequestPayload} (the real
 *  catalogued shape, `events-by-m11.ts`). A malformed delivery throws — retry-then-DLQ, never a guess. */
function parseRequestPayload(event: DispatchableOutboxEvent): LabResultsRequestPayload {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const orderId = str(p.orderId);
  const observationId = str(p.observationId);
  if (!orderId || !observationId) {
    throw new Error(
      `m11.order.results_received malformed: missing orderId/observationId (event ${event.id})`,
    );
  }
  return {
    orderId,
    organizationId: event.organizationId,
    observationId,
    orderingPhysicianMdmId: str(p.orderingPhysicianMdmId) ?? "",
    signedAt: str(p.signedAt) ?? event.createdAt.toISOString(),
    attachmentKind: p.attachmentKind === "partial" ? "partial" : "full",
  };
}

/**
 * Build the LIVE §7.15/§7.16 lab-results render consumer (F-171, #248). Drains `m11.order.results_received`:
 * parses the request, resolves the M29 observation (always — even on a redelivery, so a re-announce still
 * has `patientId` in hand), decides the render via the pure {@link decideLabBackref}, and executes it
 * through the T04 `DocumentRenderer` — as a NEW VERSION of the order's `order_record` document trail (see
 * `lab-backref-consumer.ts`'s own header for why aggregate-level idempotency is wrong here).
 */
export function buildM22LabBackrefConsumer(deps: LabBackrefConsumerDeps): OutboxConsumerBinding {
  const renderer = deps.renderer ?? getDocumentRenderer;
  const resolvePayload = deps.resolvePayload ?? resolveLabResultsPayload;
  const resolveSudConsent = deps.resolveSudConsent ?? resolveSudConsentPresent;

  return {
    consumerName: M22_LAB_RESULTS_CONSUMER,
    consumerModule: "m22",
    eventTypes: [M22_LAB_RESULTS_EVENT],
    async handle(event: DispatchableOutboxEvent): Promise<void> {
      const requestPayload = parseRequestPayload(event);

      // F-168 per-event dedup: a genuine crash-retry redelivery of THIS exact outbox event already wrote a
      // document_version carrying its id — read it up front (not merely for the decision) so a redelivery
      // can still re-announce with a real patientId, rather than skipping the emit on a lost race.
      const prior = await deps.store.documentVersionForSourceEvent({
        sourceEventId: event.id,
        organizationId: event.organizationId,
      });

      // Resolve the observation regardless of `prior` — the emit on a redelivery needs `patientId`, and
      // this consumer is a background worker (not a hot path), so the extra seam call trades a few
      // milliseconds for never losing the re-announce.
      const renderPayload = await resolvePayload(requestPayload);

      const sudConsentPresent = renderPayload?.resultValues.some((v) => v.isSudClass)
        ? await resolveSudConsent({
            organizationId: event.organizationId,
            patientId: renderPayload.patientId,
          })
        : false;

      const facts: LabBackrefFacts = {
        alreadyRendered: prior !== null,
        observationsResolved: renderPayload !== null,
        renderPayload,
        sudConsentPresent,
      };
      const action = decideLabBackref(requestPayload, facts);

      // The applied retention class (D23): `compliance_42cfr_part2` whenever ANY value redacted, computed
      // the same way `redactSudValue`/`planLabResultsRender` do — needed both for the render call AND for
      // a redelivery's re-announce (which does not recompute the variant, only re-reads the prior row).
      const retentionClass: "clinical_record" | "compliance_42cfr_part2" =
        renderPayload?.resultValues.some((v) => v.isSudClass && !sudConsentPresent)
          ? "compliance_42cfr_part2"
          : "clinical_record";

      const announce = async (row: {
        documentId: string;
        versionId: string;
        versionNumber: number;
        renderedAt: string;
      }): Promise<void> => {
        if (!deps.emitRendered || renderPayload === null) return;
        await deps.emitRendered({
          organizationId: event.organizationId,
          documentId: row.documentId,
          documentVersionId: row.versionId,
          versionNumber: row.versionNumber,
          isFirstVersion: row.versionNumber === 1,
          templateKey: "lab_results_pdf",
          aggregateType: "order_record",
          aggregateId: requestPayload.orderId,
          retentionClass,
          patientId: renderPayload.patientId,
          sourceEvent: event.eventType,
          sourceModule: "m11",
          renderedAt: row.renderedAt,
        });
      };

      switch (action.kind) {
        case "idempotent_skip":
          // D14/F-168 — a re-delivery never produces a second document_version. It must still ANNOUNCE:
          // the render and the emit are two transactions, so a crash between them is exactly what gets
          // redelivered (the render-consumer.ts precedent, applied to this dedicated pipeline).
          if (prior) await announce(prior);
          return;
        case "observations_unresolved":
          deps.onDeferred?.({
            organizationId: event.organizationId,
            orderId: requestPayload.orderId,
            observationId: action.observationId,
          });
          throw new LabObservationUnresolvedError(action.observationId); // retry-then-DLQ
        case "render": {
          const { variant, orderId, retentionClass: appliedRetentionClass } = action;
          await renderer().render({ orgId: event.organizationId }, variant.templateKey, {
            ...variant.content,
            aggregateId: orderId,
            patientId: renderPayload?.patientId ?? null,
            ...(variant.sudRedacted ? { sudRedacted: true } : {}),
            // F-171 — the D23 SUD-promotion override (see renderer.ts's `RenderPayloadCore
            // .retentionClassOverride` doc comment for why this channel had to be added: `render()` used
            // to apply ONLY the template's static default, silently dropping this pure decider's own
            // `retentionClassOverride` result).
            retentionClassOverride: appliedRetentionClass,
            // F-168 — atomic with the version insert (`document_version.source_event_id`), the same
            // crash-retry dedup `outbox-consumers/render-consumer.ts` relies on.
            sourceEventId: event.id,
          });
          const written = await deps.store.documentVersionForSourceEvent({
            sourceEventId: event.id,
            organizationId: event.organizationId,
          });
          if (written) await announce(written);
          return;
        }
      }
    },
  };
}
