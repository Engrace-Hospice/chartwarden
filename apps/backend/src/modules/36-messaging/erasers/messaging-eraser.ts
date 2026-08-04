// apps/backend/src/modules/36-messaging/erasers/messaging-eraser.ts — M36-T10 the `messages`
// data eraser (spec §7.8 / §11 D9).
//
// M36 owns the destruction path for the `messages` PHI data class, so it registers the REAL eraser
// over the Phase-0 deny-stub (bootstrap REQUIRED_ERASERS + wireErasers()); the composition root
// invokes registerMessagingErasers() through buildServer's `registerModuleErasers` hook, which runs
// AFTER wireErasers() and before validateErasers(), so the real eraser stands and a
// tenant-offboarding / right-to-erasure request hits a working eraser, not a silent no-op (mirrors
// the M2 identity, M4 audit, and M38 terminology erasers).
//
// The actual destruction is the pure `eraseTenantMessaging` (packages/messaging/src/destruction):
// it destroys the tenant DEK FIRST — cryptographic erasure that makes every `message.body_cipher`
// for the tenant undecryptable (§7.8, architecture §8(2)) — then deletes the org-scoped structural
// rows, then the cross-tenant user rows (presence / delivery_endpoint / user_notification_preferences)
// ONLY for users whose sole membership was the offboarded tenant (the D9 "a user is not the tenant"
// carve-out). Like the rest of the slice it runs over an injected store with an in-memory default;
// production injects the Drizzle-backed store + the M1 key vault (DEK destruction is a key-vault op,
// not a row UPDATE), and M4 files the destruction certificate for `messaging_tenant_data`.
import { type DbClient, schema } from "@wardenx/db";
import {
  type MessagingEraseStore,
  createInMemoryMessagingEraseStore,
  eraseTenantMessaging,
} from "@wardenx/messaging";
import { withOrgContext } from "@wardenx/tenancy";
import type { DataEraser } from "@wardenx/types";
import { and, eq, inArray, sql } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";

/** Injected adapter for the M36 eraser (slice defaults to the in-memory messaging-erase store). */
export interface MessagingEraserDeps {
  /** The data port deletes run over (Drizzle + M1 key vault in production; in-memory by default). */
  store?: MessagingEraseStore;
}

/** Cross-tenant wiring the Drizzle erase store needs beyond the tenant pool (see the factory). */
export interface DrizzleMessagingEraseDeps {
  /**
   * Resolve the users whose ONLY membership is the offboarding org (the D9 carve-out set).
   * `membership` is org-RLS'd, so a tenant connection can enumerate the org's OWN members but can
   * never prove the ABSENCE of a membership elsewhere — answering "sole tenant?" is inherently a
   * cross-tenant read. The composition root binds this from a platform-context membership
   * enumeration (the M30 active-org-enumerator pattern); without it the D9 step refuses.
   */
  soleTenantUserIds?: (orgId: string) => Promise<readonly string[]>;
}

/**
 * The Drizzle-backed erase store (TASK-003 / ARCH-007 — the argument-less registration bound the
 * in-memory store, so a tenant offboarding "erased" messages that exist nowhere). Executes the
 * ROW-LEVEL part of each §7.8 step; counts are always rows actually written (`.returning()`).
 *
 *   • `destroyTenantDek` — Phase 1 derives each tenant DEK from the master KEK by HKDF
 *     (packages/messaging/src/crypto: "no per-tenant key table"), so there is no key ROW this
 *     store could destroy; forgetting the derived key is the M1 key-vault/KEK-rotation op the
 *     composition root owns. The row-level part executed here makes the erasure physical rather
 *     than notional: every `message.body_cipher` for the org is overwritten with the empty
 *     sentinel (both columns are NOT NULL — the M31 `""`-sentinel precedent) so no ciphertext
 *     survives for a future KEK compromise to unseal. A valid envelope is ≥ 29 bytes, so
 *     `octet_length > 0` is the idempotency predicate: a second pass finds 0.
 *   • `deleteStructuralRows` — FK-ordered hard deletes of the org-scoped subtree under
 *     `withOrgContext`, children before parents (delivery→alert; attachment/receipt→message→
 *     channel_member→channel; overlay→template). The parent-join children (notification_delivery,
 *     message_attachment — no organization_id by design, 0017) are keyed through a parent
 *     subquery, mirroring their RLS shape.
 *   • `deleteSoleTenantUserRows` — per sole-tenant user, deletes presence / delivery_endpoint /
 *     user_notification_preferences inside `withOrgContext` with THAT user as the context user:
 *     those tables' RLS keys on `app.user_id` (self-only, 0017 §5–7), so the subject's own id is
 *     the only lawful write path — and the M4 trigger attributes the delete to the offboarded
 *     user whose rows they are. Refuses loudly when the cross-tenant resolver is not bound.
 *
 * GRANT CAVEAT (0017 §6): `presence` DELETE is granted to wardenx_admin only (and carries no
 * DELETE policy for wardenx_app), so the presence leg is refused by Postgres until deployment
 * grants the erase path DELETE — the erase fails loudly rather than certifying presence rows
 * destroyed while they survive.
 */
export function createDrizzleMessagingEraseStore(
  db: DbClient,
  deps: DrizzleMessagingEraseDeps = {},
): MessagingEraseStore {
  const CH = schema.channels;
  const CM = schema.channelMembers;
  const MSG = schema.messages;
  const RCPT = schema.messageReceipts;
  const ATT = schema.messageAttachments;
  const AL = schema.alerts;
  const ND = schema.notificationDeliveries;
  const RO = schema.tenantAlertRoutingOverride;
  const TPL = schema.notificationTemplate;
  const TPLO = schema.tenantNotificationTemplateOverlay;
  const PRES = schema.presence;
  const DE = schema.deliveryEndpoints;
  const UNP = schema.userNotificationPreferences;

  return {
    async destroyTenantDek(orgId) {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const shredded = await tx
          .update(MSG)
          .set({ bodyCipher: Buffer.alloc(0), bodySha256: "" })
          .where(and(eq(MSG.organizationId, orgId), sql`octet_length(${MSG.bodyCipher}) > 0`))
          .returning({ id: MSG.id });
        return { bodiesRendered: shredded.length };
      });
    },

    async deleteStructuralRows(orgId) {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const del = async <T extends { id: string }>(run: () => Promise<T[]>): Promise<number> =>
          (await run()).length;
        const orgAlertIds = tx.select({ id: AL.id }).from(AL).where(eq(AL.organizationId, orgId));
        const orgMessageIds = tx
          .select({ id: MSG.id })
          .from(MSG)
          .where(eq(MSG.organizationId, orgId));

        let deleted = 0;
        // Children of alert / message first (RESTRICT-shaped parents).
        deleted += await del(() =>
          tx.delete(ND).where(inArray(ND.alertId, orgAlertIds)).returning({ id: ND.id }),
        );
        deleted += await del(() =>
          tx.delete(AL).where(eq(AL.organizationId, orgId)).returning({ id: AL.id }),
        );
        deleted += await del(() =>
          tx.delete(ATT).where(inArray(ATT.messageId, orgMessageIds)).returning({ id: ATT.id }),
        );
        deleted += await del(() =>
          tx.delete(RCPT).where(eq(RCPT.organizationId, orgId)).returning({ id: RCPT.id }),
        );
        // One statement is self-FK-safe: parent/quoted references land on rows deleted in the
        // same statement (NO ACTION is checked at statement end against surviving rows only).
        deleted += await del(() =>
          tx.delete(MSG).where(eq(MSG.organizationId, orgId)).returning({ id: MSG.id }),
        );
        deleted += await del(() =>
          tx.delete(CM).where(eq(CM.organizationId, orgId)).returning({ id: CM.id }),
        );
        deleted += await del(() =>
          tx.delete(CH).where(eq(CH.organizationId, orgId)).returning({ id: CH.id }),
        );
        deleted += await del(() =>
          tx.delete(RO).where(eq(RO.organizationId, orgId)).returning({ id: RO.id }),
        );
        // Tenant template overlays before the org's template rows (FK); the platform-floor
        // templates (organization_id IS NULL) are not the tenant's and are never touched.
        deleted += await del(() =>
          tx.delete(TPLO).where(eq(TPLO.organizationId, orgId)).returning({ id: TPLO.id }),
        );
        deleted += await del(() =>
          tx.delete(TPL).where(eq(TPL.organizationId, orgId)).returning({ id: TPL.id }),
        );
        return { deleted };
      });
    },

    async deleteSoleTenantUserRows(orgId) {
      const resolve = deps.soleTenantUserIds;
      if (!resolve) {
        throw new Error(
          "M36_ERASER_SOLE_TENANT_UNRESOLVABLE: the D9 carve-out needs a cross-tenant membership " +
            "read (org-RLS'd `membership` cannot prove a user has NO other tenant); bind " +
            "DrizzleMessagingEraseDeps.soleTenantUserIds from a platform-context enumerator. " +
            "Refusing to guess — deleting on a same-org-only view would destroy rows of users " +
            "who still belong to other tenants.",
        );
      }
      const userIds = await resolve(orgId);
      let deleted = 0;
      for (const userId of userIds) {
        // The context user IS the row owner: presence/delivery_endpoint/user_notification_
        // preferences RLS keys on app.user_id (self-only), not app.org_id.
        deleted += await withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
          const pres = await tx
            .delete(PRES)
            .where(eq(PRES.userId, userId))
            .returning({ id: PRES.userId });
          const endpoints = await tx
            .delete(DE)
            .where(eq(DE.userId, userId))
            .returning({ id: DE.id });
          const prefs = await tx
            .delete(UNP)
            .where(eq(UNP.userId, userId))
            .returning({ id: UNP.id });
          return pres.length + endpoints.length + prefs.length;
        });
      }
      return { deleted };
    },
  };
}

/**
 * Build M36's `messages` DataEraser. The destruction registry hands `subjectId` = the offboarding
 * org id; the eraser cryptographically erases that org's message bodies (DEK destruction) and reports
 * the faithful total rows accounted for (bodies rendered unreadable + structural + cross-tenant).
 */
export function createMessagingEraser(store: MessagingEraseStore): DataEraser {
  return {
    async erase(scope, subjectId) {
      // The data class is org-scoped: both `scope.orgId` and the offboarding `subjectId` name the
      // org. Erase by the subject (the offboarding org), consistent with the M2/M4/M38 erasers.
      void scope;
      const result = await eraseTenantMessaging(subjectId, store);
      return { erased: result.erased };
    },
  };
}

/**
 * Register M36's REAL `messages` eraser into the M1 destruction-cert registry over the Phase-0
 * deny-stub (M36-T10). Called by the composition root's wireModuleErasers() AFTER wireErasers()
 * and before validateErasers(), so the real eraser stands.
 */
export function registerMessagingErasers(deps: MessagingEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryMessagingEraseStore().store;
  registerEraser("messages", createMessagingEraser(store));
}
