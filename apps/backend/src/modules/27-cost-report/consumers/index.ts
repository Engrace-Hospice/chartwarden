// apps/backend/src/modules/27-cost-report/consumers — barrel for the §4.10 / D3 upstream-event consumers.
//
// The PURE, port-injected inbound half of M27: the topic→effect subscription map (the single source of
// truth for the §4.10 fan-out), one pure handler per subscribed topic. Mirrors the M30 `@chartwarden/quality`
// consumers barrel. GAP-205: the former `registerM27Consumers` registrar was dead scaffolding (no caller, no dispatcher took a registrar) and is deleted; the LIVE bindings are the `OutboxConsumerBinding`s under `../outbox-consumers/` (wired from apps/backend/src/index.ts, proven by `arch:outbox-bindings`).
export * from "./subscription-map";
export * from "./handlers";

import {
  type DenialOpenedEvent,
  type DocumentRenderedEvent,
  type M27ConsumerPorts,
  type ProviderEntityOffboardedEvent,
  type UpstreamConsumeReport,
  handleDenialOpened,
  handleDocumentRendered,
  handleProviderEntityOffboarded,
} from "./handlers";
import { M40_PROVIDER_ENTITY_OFFBOARDED_TOPIC } from "./subscription-map";

/**
 * The discriminated upstream event the inbound dispatcher delivers to M27 (the topic + its structurally-
 * minimal payload). Additive: a new subscribed topic is a new variant.
 */
export type M27UpstreamEvent =
  | { readonly topic: "m22.document.rendered"; readonly payload: DocumentRenderedEvent }
  | { readonly topic: "m25.denial.opened"; readonly payload: DenialOpenedEvent }
  | {
      readonly topic: typeof M40_PROVIDER_ENTITY_OFFBOARDED_TOPIC;
      readonly payload: ProviderEntityOffboardedEvent;
    };

/**
 * Route one delivered upstream event to its pure handler (the dispatcher's single entry point). Returns the
 * structured {@link UpstreamConsumeReport}; an unmapped topic would be unrepresentable in {@link
 * M27UpstreamEvent}, so this is total over the subscribed set. Pure orchestration — the side effects all
 * live behind the injected {@link M27ConsumerPorts}.
 */
export async function dispatchM27UpstreamEvent(
  event: M27UpstreamEvent,
  ports: M27ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  switch (event.topic) {
    case "m22.document.rendered":
      return handleDocumentRendered(event.payload, ports);
    case "m25.denial.opened":
      return handleDenialOpened(event.payload, ports);
    case M40_PROVIDER_ENTITY_OFFBOARDED_TOPIC:
      return handleProviderEntityOffboarded(event.payload, ports);
  }
}
