// @chartwarden/messaging — in-memory MessagingEraseStore for the M36-T10 D9 eraser slice/tests.
//
// Models just enough of the production shape to prove the §7.8 contract WITHOUT a live DB or the M1
// key vault: a per-tenant DEK guarding a set of `message` rows (`body_cipher`), org-scoped structural
// rows, and cross-tenant user rows tagged with the set of tenants each user belongs to. Destroying the
// DEK flips the tenant to "shredded"; `tryDecrypt()` then fails for that tenant's bodies — the exact
// post-erase decrypt check the spec's "done means" calls for. Deterministic: no clock, no randomness.

import type { MessagingEraseStore } from "./eraseFn";

/** A seeded encrypted message body (cipher text is opaque here — the DEK is what matters). */
export interface SeedMessage {
  readonly id: string;
  readonly orgId: string;
  /** Opaque stand-in for `message.body_cipher`; only readable while the tenant DEK lives. */
  readonly bodyCipher: string;
}

/** A cross-tenant user row (presence / delivery_endpoint / user_notification_preferences). */
export interface SeedCrossTenantRow {
  readonly id: string;
  /** The table this row belongs to — for `remaining()` assertions. */
  readonly table: "presence" | "delivery_endpoint" | "user_notification_preferences";
  readonly userId: string;
  /** Every tenant this user is a member of; the row survives if any tenant other than the target. */
  readonly memberOf: readonly string[];
}

/** An org-scoped structural row (channel/member/message-meta/receipt/attachment/alert/…). */
export interface SeedStructuralRow {
  readonly id: string;
  readonly orgId: string;
}

/** Seed shape for the in-memory messaging-erase store. */
export interface MessagingEraseSeed {
  messages?: SeedMessage[];
  structural?: SeedStructuralRow[];
  crossTenant?: SeedCrossTenantRow[];
}

/** What the in-memory store exposes back to a test beyond the {@link MessagingEraseStore} port. */
export interface InMemoryMessagingEraseStore {
  store: MessagingEraseStore;
  /** Read a body's plaintext-equivalent; throws once the tenant DEK is destroyed (§7.8 check). */
  tryDecrypt(messageId: string): string;
  /** Remaining row counts so a test can assert structural + cross-tenant deletes landed. */
  remaining(): { messages: number; structural: number; crossTenant: number };
}

/** Raised by `tryDecrypt()` after the tenant DEK has been cryptographically erased. */
export class DekDestroyedError extends Error {
  constructor(orgId: string) {
    super(`message body undecryptable: tenant DEK for org '${orgId}' was destroyed`);
    this.name = "DekDestroyedError";
  }
}

/**
 * Build an in-memory {@link MessagingEraseStore} over seeded rows. `destroyTenantDek` marks the
 * tenant shredded (so `tryDecrypt` fails) and reports how many of its message bodies are now
 * unreadable; the structural and cross-tenant deletes mutate the seeded sets per the D9 carve-out.
 */
export function createInMemoryMessagingEraseStore(
  seed: MessagingEraseSeed = {},
): InMemoryMessagingEraseStore {
  const messages = [...(seed.messages ?? [])];
  const structural = [...(seed.structural ?? [])];
  const crossTenant = [...(seed.crossTenant ?? [])];
  const shreddedOrgs = new Set<string>();

  const store: MessagingEraseStore = {
    async destroyTenantDek(orgId) {
      // Idempotent: an already-shredded tenant reports 0 (its bodies were counted on the first pass).
      if (shreddedOrgs.has(orgId)) return { bodiesRendered: 0 };
      shreddedOrgs.add(orgId);
      const bodiesRendered = messages.filter((m) => m.orgId === orgId).length;
      return { bodiesRendered };
    },
    async deleteStructuralRows(orgId) {
      let deleted = 0;
      for (let i = structural.length - 1; i >= 0; i--) {
        if (structural[i]?.orgId === orgId) {
          structural.splice(i, 1);
          deleted++;
        }
      }
      // The message rows are structural too — their bodies are already unreadable; drop the rows.
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.orgId === orgId) {
          messages.splice(i, 1);
          deleted++;
        }
      }
      return { deleted };
    },
    async deleteSoleTenantUserRows(orgId) {
      let deleted = 0;
      for (let i = crossTenant.length - 1; i >= 0; i--) {
        const row = crossTenant[i];
        if (row === undefined) continue;
        const otherTenants = row.memberOf.some((t) => t !== orgId);
        // Delete only when the offboarding org is the user's SOLE tenant (D9 carve-out).
        if (row.memberOf.includes(orgId) && !otherTenants) {
          crossTenant.splice(i, 1);
          deleted++;
        }
      }
      return { deleted };
    },
  };

  return {
    store,
    tryDecrypt(messageId) {
      const msg = messages.find((m) => m.id === messageId);
      if (msg === undefined) throw new Error(`no message '${messageId}'`);
      if (shreddedOrgs.has(msg.orgId)) throw new DekDestroyedError(msg.orgId);
      return msg.bodyCipher;
    },
    remaining: () => ({
      messages: messages.length,
      structural: structural.length,
      crossTenant: crossTenant.length,
    }),
  };
}
