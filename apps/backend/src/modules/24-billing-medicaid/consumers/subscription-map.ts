// apps/backend/src/modules/24-billing-medicaid/consumers/subscription-map.ts — M24 §4.4 upstream-event
// subscriptions. M24 re-validates a claim when an upstream clinical/reference fact changes (M5/M8) and
// advances the claim lifecycle on the state-remittance signals (M25) + the Medicare-primary acceptance
// (M23, dual-eligible COB). Maps each subscribed topic to its pure handler action.
//
// F-165 (#248, m24 group) — three stale entries removed (`m6.admission.changed`, `m18.evv.compliance_changed`,
// `m40.reference.rate_schedule_loaded`): none is a real catalogued event anywhere in the platform under
// any spelling (grepped `events-by-m6.ts` / `events-by-m18.ts` / `events-by-m40.ts` directly — M18's own
// catalog comment independently calls `compliance_changed` "a vapor name"), so all three could never be
// bound regardless of this map's own contents. Also added `m5.patient.address_changed` (its own
// `events-by-m5.ts` description already says "triggers... Medicaid state recheck (M24)" — this map had
// simply never listed it under the same `trigger-revalidate` action its sibling `m5.patient.updated`
// carries). The `trigger-revalidate` and `resolve-medicare-primary` actions are now live —
// `outbox-consumers/m24-revalidate-triggers.ts` / `m24-medicare-primary-ack.ts` — bound directly as
// `OutboxConsumerBinding`s at the composition root rather than through this map + `handlers.ts` +
// `consumers/index.ts`'s `registerM24Consumers`, which remains dead scaffolding with no caller (the
// F-153 M23 `registerM23Consumers` precedent). `mark-claim-paid`/`mark-claim-denied` stay unbound — see
// the m24 `handlers-unbound` group in `scripts/outbox-deferred-consumers.ts` for why.
export const M24_SUBSCRIPTION_MAP: Readonly<Record<string, string>> = {
  "m25.remittance.claim_paid": "mark-claim-paid",
  "m25.remittance.claim_denied": "mark-claim-denied",
  // F-095 — was `m23.medicare_claim.acknowledged`, a name M23 has never catalogued under any wave.
  // M23 owns one claim-acknowledgment topic and this is it (the 277CA ack that resolves whether Medicare
  // paid primary, which is the precondition for billing Medicaid secondary).
  "m23.claim.acknowledged": "resolve-medicare-primary",
  "m5.patient.updated": "trigger-revalidate",
  "m5.patient.address_changed": "trigger-revalidate",
  "m8.encounter.signed": "trigger-revalidate",
};

export const M24_UPSTREAM_SUBSCRIPTIONS = Object.keys(M24_SUBSCRIPTION_MAP) as readonly string[];

export type M24SubscribedTopic = (typeof M24_UPSTREAM_SUBSCRIPTIONS)[number];
