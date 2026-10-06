// apps/backend/src/modules/26-cap/consumers/subscription-map.ts — the M26 §4.4 upstream-event subscriptions
// (the M25/M27 subscription-map precedent). M26 consumes the remittance/claim/patient/election/alert topics
// that drive the accrual ledger + per-patient extrapolation freeze. The boot dispatcher binds each topic to
// its handler when the live inbound relay lands; until then these are forward-declared (registered, inert).
export const M26_SUBSCRIPTION_MAP = {
  // M25 — the authoritative paid-amount source: every accrual cent traces to an 835 remittance line.
  // GAP-075: the per-line posting events (patient + integer cents + service dates), not the advice-level
  // `advice_posted` rollup, which carries none of those facts.
  "m25.remittance.claim_paid": "record-accrual-line",
  "m25.remittance.claim_partial_paid": "record-accrual-line",
  // M23 — claim corrections produce reversal/adjustment accrual lines.
  "m23.claim.replaced": "record-reversal-line",
  "m23.claim.voided": "record-reversal-line",
  // M25 — a CLP02=22 reversal posted directly (F-163, #248: the last of M26's originally-deferred pairs).
  "m25.remittance.claim_recouped": "record-reversal-line",
  // M23 — inpatient (GIP 0656 / IRC 0655) day lines for the 20% cap.
  "m23.claim.line_finalized": "record-inpatient-day-line",
  // M5 — freeze the per-patient projection denominator at death.
  "m5.patient.deceased": "freeze-patient",
  // M6 — freeze the patient's contribution at revocation; init proportional weight on transfer.
  "m6.revocation.created": "freeze-patient",
  "m6.transfer.created": "init-proportional-weight",
  // M36 — surface stuck cap-alert deliveries on the operational queue.
  "m36.notification.delivery_failed": "surface-stuck-alert",
} as const satisfies Record<string, string>;

export type M26SubscribedTopic = keyof typeof M26_SUBSCRIPTION_MAP;

/** The forward-declared topic list the boot dispatcher subscribes (the M25 UPSTREAM_SUBSCRIPTIONS shape). */
export const M26_UPSTREAM_SUBSCRIPTIONS: readonly M26SubscribedTopic[] = Object.keys(
  M26_SUBSCRIPTION_MAP,
) as M26SubscribedTopic[];
