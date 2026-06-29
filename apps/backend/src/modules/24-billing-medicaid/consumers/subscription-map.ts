// apps/backend/src/modules/24-billing-medicaid/consumers/subscription-map.ts — M24 §4.4 upstream-event
// subscriptions. M24 re-validates a claim when an upstream clinical/reference fact changes (M5/M6/M8/M18/M40)
// and advances the claim lifecycle on the state-remittance signals (M25) + the Medicare-primary acceptance
// (M23, dual-eligible COB). Maps each subscribed topic to its pure handler action. The live inbound relay is
// deferred (the M25/M26 posture); the names are the forward-declared contract subscribers wire against.
export const M24_SUBSCRIPTION_MAP: Readonly<Record<string, string>> = {
  "m25.remittance.claim_paid": "mark-claim-paid",
  "m25.remittance.claim_denied": "mark-claim-denied",
  "m23.medicare_claim.acknowledged": "resolve-medicare-primary",
  "m5.patient.updated": "trigger-revalidate",
  "m6.admission.changed": "trigger-revalidate",
  "m8.encounter.signed": "trigger-revalidate",
  "m18.evv.compliance_changed": "trigger-revalidate",
  "m40.reference.rate_schedule_loaded": "trigger-revalidate",
};

export const M24_UPSTREAM_SUBSCRIPTIONS = Object.keys(M24_SUBSCRIPTION_MAP) as readonly string[];

export type M24SubscribedTopic = (typeof M24_UPSTREAM_SUBSCRIPTIONS)[number];
