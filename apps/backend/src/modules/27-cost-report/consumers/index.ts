// apps/backend/src/modules/27-cost-report/consumers — barrel for the §4.10 / D3 upstream-event consumers.
//
// The PURE, port-injected inbound half of M27: the topic→effect subscription map (the single source of
// truth for the §4.10 fan-out), one pure handler per subscribed topic, and the forward-declared register
// surface the boot dispatcher wires once the live inbound transactional-outbox dispatcher accessor lands.
// Mirrors the M30 `@wardenx/quality` consumers barrel. RULE 3(d): these ship pure + a subscription map —
// NO boot-wired running subscriber here; the live inbound dispatcher is a later platform phase.
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
import {
  type M27UpstreamSubscription,
  M27_UPSTREAM_SUBSCRIPTIONS,
  M40_PROVIDER_ENTITY_OFFBOARDED_TOPIC,
} from "./subscription-map";

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

/**
 * Register the M27 §4.10 upstream consumers (the M30 register-surface mirror). The boot dispatcher calls
 * this with its `bind(eventName, consumerName, handler)` registrar and the live {@link M27ConsumerPorts};
 * each forward-declared subscription is bound to a closure over {@link dispatchM27UpstreamEvent}. Until the
 * live inbound transactional-outbox dispatcher accessor lands (RULE 3(d)) the composition root calls this
 * with NO registrar — it then merely returns the forward-declared bindings (nothing boots). Idempotent: the
 * dispatcher dedups on `(eventId, consumerName)` per the M1 outbox-consumer pattern.
 */
export function registerM27Consumers(options?: {
  readonly ports?: M27ConsumerPorts;
  readonly bind?: (
    eventName: string,
    consumerName: string,
    handler: (payload: unknown) => Promise<UpstreamConsumeReport>,
  ) => void;
}): readonly M27UpstreamSubscription[] {
  const { ports, bind } = options ?? {};
  if (bind && ports) {
    for (const subscription of M27_UPSTREAM_SUBSCRIPTIONS) {
      bind(subscription.eventName, subscription.consumerName, (payload) =>
        dispatchM27UpstreamEvent(
          { topic: subscription.eventName, payload } as M27UpstreamEvent,
          ports,
        ),
      );
    }
  }
  return M27_UPSTREAM_SUBSCRIPTIONS;
}
