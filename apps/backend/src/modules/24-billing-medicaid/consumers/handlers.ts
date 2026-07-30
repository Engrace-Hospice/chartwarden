// apps/backend/src/modules/24-billing-medicaid/consumers/handlers.ts — M24 §4.4 pure upstream-event handlers.
// Each takes the injected CapClaimConsumerStore (the live Drizzle store binds with the claim-lifecycle write
// path; the in-memory default records nothing) + the delivered PHI-free payload, and routes the effect. The
// re-validation enqueue + the lifecycle advance are recorded through the store so the handlers stay pure +
// unit-testable. The live store binds when the inbound relay loop lands (deferred — the M26 posture).

/** The store the M24 consumers drive (the live Drizzle binding records the lifecycle effect / enqueue). */
export interface M24ConsumerStore {
  markClaimPaid(payload: Record<string, unknown>): Promise<{ applied: boolean }>;
  markClaimDenied(payload: Record<string, unknown>): Promise<{ applied: boolean }>;
  resolveMedicarePrimary(payload: Record<string, unknown>): Promise<{ applied: boolean }>;
  enqueueRevalidation(payload: Record<string, unknown>): Promise<{ enqueued: boolean }>;
}

export async function handleClaimPaid(store: M24ConsumerStore, payload: Record<string, unknown>) {
  return store.markClaimPaid(payload);
}
export async function handleClaimDenied(store: M24ConsumerStore, payload: Record<string, unknown>) {
  return store.markClaimDenied(payload);
}
export async function handleMedicarePrimaryAck(store: M24ConsumerStore, payload: Record<string, unknown>) {
  return store.resolveMedicarePrimary(payload);
}
export async function handleUpstreamChange(store: M24ConsumerStore, payload: Record<string, unknown>) {
  return store.enqueueRevalidation(payload);
}
