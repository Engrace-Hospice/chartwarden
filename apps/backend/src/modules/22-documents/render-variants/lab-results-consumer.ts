// apps/backend/src/modules/22-documents/render-variants/lab-results-consumer.ts — M22-T09 (§7.15/§7.16/§7.18).
//
// The lab-results render path: `m11.order.results_received` (+ `_critical`, D22) → hydrate the observation via the
// M29 `LabObservationReader` seam → build the `lab_results_pdf` payload (D20 SUD redaction, D22 watermark, D23
// retention) → render. In Phase 1 the M29 reader is the deny-stub (M29 = Wave H), so this resolves to
// `awaiting_reader` and the consumer is INERT — no PDF, no back-ref. The render plan it returns (when live) feeds
// the same `dispatchDocumentRender` back-ref machinery the §4.11 core uses, so M11's `m22.document.rendered`
// consumer stamps `order_record.document_id` and (on the critical lane) M36 priority-routes the inbox push.
//
// PURE decision core (no IO beyond the injected reader): the redaction is performed by `@wardenx/forms`'
// `buildLabResultsRenderPayload`, so the "no SUD plaintext in the binary" invariant (§7.16) is enforced before any
// engine runs and is unit-testable without a database or a render engine.

import { buildLabResultsRenderPayload, type LabResultsRenderPayload } from "@wardenx/forms";
import type { OrgScope } from "@wardenx/types";
import type { LabObservationReader } from "./m29-lab-observation-reader";

/** The §7.15/§7.18 lab-results render events the consumer handles (routine + the D22 critical lane). */
const LAB_RESULT_EVENTS = new Set(["m11.order.results_received", "m11.order.results_received_critical"]);

/** The resolved lab-results render plan (when the M29 reader is live), or an inert/skip status. */
export type LabResultsRenderResolution =
  | {
      readonly status: "render";
      readonly scope: OrgScope;
      readonly aggregateId: string;
      readonly patientId: string;
      readonly critical: boolean;
      readonly payload: LabResultsRenderPayload;
    }
  /** The M29 reader denied (Wave H not landed) — the consumer is inert; no PDF, no back-ref. */
  | { readonly status: "awaiting_reader" }
  /** The event is not a lab-results trigger, or the payload is malformed (missing org/patient/order id). */
  | { readonly status: "skip" };

function str(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Resolve a lab-results render event to its plan (§7.15 W-M22-22 / §7.16 W-M22-23 / §7.18 W-M22-25). Returns
 * `awaiting_reader` while the M29 `LabObservationReader` deny-stub is in place (Phase 1 / Wave H) — the inert path.
 * On a live reader it loads the observation and builds the redacted `lab_results_pdf` payload; the D20 redaction
 * and D23 retention are decided inside `buildLabResultsRenderPayload` from the per-value `isSudClass` flag. The
 * critical lane (`m11.order.results_received_critical`) sets the D22 watermark and the `critical` flag the
 * dispatcher uses to additionally emit `m22.document.rendered_critical_results`.
 */
export async function resolveLabResultsRender(
  eventName: string,
  payload: unknown,
  deps: { readonly labObservationReader: LabObservationReader },
): Promise<LabResultsRenderResolution> {
  if (!LAB_RESULT_EVENTS.has(eventName)) return { status: "skip" };
  const rec = (payload ?? {}) as Record<string, unknown>;
  const organizationId = str(rec, "organizationId");
  const patientId = str(rec, "patientId");
  const orderId = str(rec, "orderId");
  const observationId = str(rec, "observationId");
  if (!organizationId || !patientId || !orderId || !observationId) return { status: "skip" };

  const loaded = await deps.labObservationReader.loadObservation({ organizationId, observationId });
  if (!loaded.available) return { status: "awaiting_reader" };

  const critical = eventName === "m11.order.results_received_critical";
  const payloadOut = buildLabResultsRenderPayload({
    orderId,
    observationId,
    orderingProviderName: loaded.observation.orderingProviderName,
    resultValues: loaded.observation.resultValues,
    critical,
  });
  return {
    status: "render",
    scope: { orgId: organizationId },
    aggregateId: orderId,
    patientId,
    critical,
    payload: payloadOut,
  };
}
