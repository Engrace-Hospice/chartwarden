// @chartwarden/quality · consumers — barrel for the §4.10 upstream-event consumers.
//
// The PURE, port-injected inbound half of M30: the topic→effect subscription map (the single source of
// truth for the §4.10 fan-out) and one pure handler per subscribed topic. Mirrors M33's
// `catalog/outbox-subscription-map.ts` + `refresh/outbox-subscriber.ts`. RULE 3(d): these ship pure + a
// subscription map — NO boot-wired running subscriber; the live inbound dispatcher is a later phase.
export * from "./subscription-map";
export * from "./handlers";
