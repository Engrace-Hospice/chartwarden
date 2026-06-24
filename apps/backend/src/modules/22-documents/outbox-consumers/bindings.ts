// apps/backend/src/modules/22-documents/outbox-consumers/bindings.ts — M22-T06 the §4.11 forward-declared
// (event → consumer) bindings. PHASE-1 DEFERRED (M7-T08 / M6-T11 precedent).
//
// Each `*.document_requested` event (and the two real-seam gates it threads through) is DECLARED here — the
// contract the boot outbox dispatcher will bind to once the live render worker lands — but is NOT live-wired
// into the dispatcher yet. What ships now is the PURE, fully-tested decision core ({@link decideDocumentRequest})
// plus the two impure seam resolvers ({@link resolveSudConsentPresent} / {@link resolveExternalBaaActive}).
// Wiring later is: for each binding, register the handler that (1) resolves `DocumentRequestFacts` from the
// outbox-dedup registry + the T04 template table + (when the payload flags it) the M39/M40 seams, (2) calls
// `decideDocumentRequest`, (3) executes the returned action through the T04 `DocumentRenderer` seam, and
// (4) emits `m22.document.rendered` with the back-ref so the source module applies `document_id`.
//
// The event names are STRING literals only — M22 reads every source module solely through the foundation
// outbox, never a `dependsOn` edge or a producer-package import (§4 boundary rule, M22 deps stay `[1, 5]`).
// This file lives under outbox-consumers/ (not an events-by-m22 catalog) so arch:gaps does not treat the
// consumed names as M22-produced events.
import {
  M22_DOCUMENT_REQUEST_EVENTS,
  type DocumentRequestEvent,
} from "./decide-document-request";

/** A single forward-declared §4.11 binding: the consumed event + the M22 consumer name the dispatcher routes
 * to once the live render worker lands. `consumerName` is the `(eventId, consumerName)` dedup key (§4.11). */
export interface DocumentRequestBinding {
  readonly eventName: DocumentRequestEvent;
  readonly consumerName: string;
}

/** The shared M22 render-handshake consumer name (one worker drains every `*.document_requested` queue). */
export const M22_DOCUMENT_RENDER_CONSUMER = "m22.render-document-from-request" as const;

/** The §4.11 forward-declared bindings — one per consumed `*.document_requested` event. */
export const M22_DOCUMENT_REQUEST_BINDINGS: readonly DocumentRequestBinding[] =
  M22_DOCUMENT_REQUEST_EVENTS.map((eventName) => ({
    eventName,
    consumerName: M22_DOCUMENT_RENDER_CONSUMER,
  }));

/** True in Phase 1 — no live render worker; the bindings are declared but not wired into the dispatcher. */
export const M22_DOCUMENT_REQUEST_BINDINGS_DEFERRED = true;
