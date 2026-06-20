// @wardenx/messaging — the D9 tenant-offboarding eraseFn (M36-T10, spec §7.8 / §11 D9, §3.1 layout).
//
// Registered with the M4 destruction registry (over the app boundary's DataEraser) to satisfy a
// right-to-erasure / tenant-offboarding request for the `messages` data class. M36's PHI payload is
// the message body, stored ONLY as `message.body_cipher` under the tenant's per-tenant DEK (M1
// envelope encryption, spec §3.2 D2). So the spec's destruction order is exact and load-bearing:
//
//   1. DESTROY THE TENANT DEK FIRST — cryptographic erasure (architecture §8(2)). The moment the DEK
//      is gone every `body_cipher` for the tenant is undecryptable; a post-erase decrypt attempt on a
//      sample row MUST fail (§7.8 "done means"). This is the actual PHI-shred — it does not wait on a
//      row-by-row scrub and cannot be partially completed.
//   2. THEN delete the structural rows (channels, members, messages, receipts, attachments, alerts,
//      notification deliveries, …) for housekeeping per retention class.
//   3. THEN delete the cross-tenant user rows (presence / delivery_endpoint /
//      user_notification_preferences) ONLY for users whose sole membership was this tenant — a user
//      who belongs to other tenants keeps those rows (D9 carve-out: "a user is not the tenant").
//
// Pure orchestration over the {@link MessagingEraseStore} port — no clock, no I/O — so the offboarding
// counts are deterministic and assertable. The in-memory store (below, in store/in-memory-erase) backs
// the slice/tests; the Drizzle-backed store implements the same port over the live tables and the M1
// key vault in production. The eraser ALWAYS destroys the DEK before any structural delete, so even a
// store whose deletes later fail has already made every body unreadable.

/** Faithful breakdown the eraseFn reports back (the DataEraser sums these into `{ erased }`). */
export interface MessagingEraseResult {
  /** `message` rows whose `body_cipher` became undecryptable when the tenant DEK was destroyed. */
  readonly bodiesRendered: number;
  /** Structural rows deleted for housekeeping (channels/members/messages/receipts/alerts/…). */
  readonly structuralRows: number;
  /** Cross-tenant user rows deleted for users whose only membership was the offboarded tenant. */
  readonly crossTenantRows: number;
  /** Total rows accounted for — the M4 destruction-cert `{ erased }` count. */
  readonly erased: number;
}

/** The narrow data port the messaging eraseFn composes over (a slice of the production store). */
export interface MessagingEraseStore {
  /**
   * Cryptographically erase the tenant's message bodies by destroying its per-tenant DEK. Returns
   * the count of `message` rows whose `body_cipher` is now undecryptable. Idempotent: a second call
   * for an already-shredded tenant reports 0. MUST run before any structural delete.
   */
  destroyTenantDek(orgId: string): Promise<{ bodiesRendered: number }>;
  /**
   * Delete the org-scoped structural rows (channels, channel members, messages, receipts,
   * attachments, alerts, alert routing overrides, notification deliveries, notification templates +
   * overlays) for the offboarding org. Returns the total rows removed.
   */
  deleteStructuralRows(orgId: string): Promise<{ deleted: number }>;
  /**
   * Delete the cross-tenant user rows (`presence`, `delivery_endpoint`,
   * `user_notification_preferences`) for users whose ONLY membership was the offboarding org.
   * Users in multiple tenants retain these rows (D9 carve-out). Returns the rows removed.
   */
  deleteSoleTenantUserRows(orgId: string): Promise<{ deleted: number }>;
}

/**
 * Erase a tenant's messaging footprint on offboarding (D9). Destroys the tenant DEK first
 * (cryptographic erasure of every message body, §7.8), then deletes structural rows, then the
 * cross-tenant rows of users who belonged only to this tenant. `orgId` is the offboarding org (the
 * `subjectId` the M4 destruction registry hands the eraser). The order is fixed and the DEK
 * destruction is unconditional — the bodies are unreadable the instant step 1 returns.
 */
export async function eraseTenantMessaging(
  orgId: string,
  store: MessagingEraseStore,
): Promise<MessagingEraseResult> {
  const { bodiesRendered } = await store.destroyTenantDek(orgId);
  const structural = await store.deleteStructuralRows(orgId);
  const crossTenant = await store.deleteSoleTenantUserRows(orgId);
  return {
    bodiesRendered,
    structuralRows: structural.deleted,
    crossTenantRows: crossTenant.deleted,
    erased: bodiesRendered + structural.deleted + crossTenant.deleted,
  };
}
