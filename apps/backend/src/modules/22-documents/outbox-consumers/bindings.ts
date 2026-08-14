// apps/backend/src/modules/22-documents/outbox-consumers/bindings.ts — M22-T06 the §4.11 (event → consumer)
// bindings. LIVE since GAP-023/024/038.
//
// Each consumed `*.document_requested` event is declared here and routed to the single shared render
// consumer that ./render-consumer.ts builds and `apps/backend/src/index.ts` registers with the boot outbox
// dispatcher: it (1) resolves `DocumentRequestFacts` from the `document` table + the T04 template table +
// (when the payload flags it) the M39/M40 seams, (2) calls `decideDocumentRequest`, and (3) executes the
// returned action through the T04 `DocumentRenderer` seam.
//
// STILL NOT DONE: step (4), emitting `m22.document.rendered` with the back-ref so the source module stamps
// `document_id` on its own row. That needs an M22 event catalog, which does not exist — see the note in
// ./decide-document-request.ts.
//
// The event names are STRING literals only — M22 reads every source module solely through the foundation
// outbox, never a `dependsOn` edge or a producer-package import (§4 boundary rule, M22 deps stay `[1, 5]`).
// This file lives under outbox-consumers/ (not an events-by-m22 catalog) so arch:gaps does not treat the
// consumed names as M22-produced events.
import { type DocumentRequestEvent, M22_DOCUMENT_REQUEST_EVENTS } from "./decide-document-request";

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

/** False since GAP-023/024/038 — `buildM22DocumentRequestConsumer` is registered with the boot dispatcher.
 * Kept (rather than deleted) so the assertion that used to pin it `true` now pins it `false`: this flag is
 * the one place a reader can check whether the §4.11 handshake is theory or wiring. */
export const M22_DOCUMENT_REQUEST_BINDINGS_DEFERRED = false;
