// apps/backend/src/modules/25-remittance/outbox-consumers/live-binding.ts — the LIVE
// `m25.parse-and-post` outbox consumer (WX-PR-012, spec §4.8/§4.10 `m25:parse-and-post`). M25 owns and
// consumes its own `m25.edi.835_received` event (self-pull posture — no other module produces it): the
// dispatcher (bootstrap/outbox-dispatcher.ts) delivers each receipt here, which drives
// {@link M25IngestService.postAdvice} — the parse + transactional-post + denial-seed half of the pipeline
// (../ingest/service-drizzle.ts covers the receive + dedup half).
//
// The EXISTING `remittance.replay` route already re-emits this same event (write-service-drizzle.ts
// `replayAdvice`) to re-queue a `failed` envelope — so replay naturally re-drives this consumer with no
// separate replay code path needed here.
//
// DISPATCHER CONTRACT (the M6 admission-event-applier precedent): a business-level outcome (posted,
// partial_posted, or a handled parse/post failure) is a SUCCESSFUL delivery — `postAdvice` never throws for
// those; the advice row itself carries the durable answer (parse_status + parse_summary), operator-visible
// via the read routes and re-triggerable via `remittance.replay`. Only a malformed EVENT PAYLOAD (missing
// remittanceAdviceId — an integration defect, not a business outcome) throws, so the dispatcher retries and
// eventually DLQs it — the event was never actionable, unlike an advice-row failure which always is.
import type { M25IngestActor, M25IngestService } from "../ingest/service";

/** Structural binding (matches the dispatcher's OutboxConsumerBinding without importing bootstrap). */
export interface M25EdiReceivedConsumerBinding {
  readonly consumerName: "m25.parse-and-post";
  readonly consumerModule: "m25";
  readonly eventTypes: readonly ["m25.edi.835_received"];
  handle(event: {
    readonly payload: unknown;
    readonly organizationId: string;
  }): Promise<void>;
}

function remittanceAdviceIdOf(payload: unknown): string {
  const id = (payload as { remittanceAdviceId?: unknown } | null)?.remittanceAdviceId;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(
      "m25.parse-and-post: malformed m25.edi.835_received payload (missing remittanceAdviceId) — refusing to guess",
    );
  }
  return id;
}

/** Build the LIVE consumer the composition root registers with the outbox dispatcher. */
export function buildM25EdiReceivedConsumer(
  ingestService: M25IngestService,
): M25EdiReceivedConsumerBinding {
  return {
    consumerName: "m25.parse-and-post",
    consumerModule: "m25",
    eventTypes: ["m25.edi.835_received"],
    async handle(event) {
      const adviceId = remittanceAdviceIdOf(event.payload);
      const actor: M25IngestActor = { organizationId: event.organizationId };
      await ingestService.postAdvice(actor, adviceId);
    },
  };
}
