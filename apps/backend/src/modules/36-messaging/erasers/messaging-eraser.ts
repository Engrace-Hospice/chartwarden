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
import { DegradedError } from "@wardenx/types";
import type { DataEraser } from "@wardenx/types";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";
import {
  ERASE_DESTROY_DEADLINE_MS,
  ERASE_UPLOAD_URL_GRACE_MS,
  eraseLockName,
} from "../attachments/attachment-policy";
import type { AttachmentStoragePort } from "../attachments/attachment-ports";
import { runWithDeadline } from "../attachments/attachment-scan-gate";
import { ERASED_BODY_SHA256 } from "../jobs/integrity-jobs";

/** Attachment objects destroyed (then their rows deleted) per short transaction. */
const ERASE_OBJECT_BATCH = 100;
/** Passes of "destroy every object" before the structural step; each pass after the first only finds late uploads. */
const ERASE_MAX_OBJECT_PASSES = 5;

/** Thrown inside the preflight probe's transaction to roll it back after the real removal ran. */
class ProbeRollback extends Error {}

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
  /**
   * Destroys the bytes behind `message_attachment.object_key` (the composition root binds M36's storage port over the
   * M22 tenant bucket). Without it, an org that HAS attachment objects cannot be erased: the structural step throws
   * (loud, retryable) rather than certify destruction while the only copy of the bytes survives unreachable.
   */
  attachmentStorage?: Pick<AttachmentStoragePort, "destroyObject">;
  /** Epoch clock for the upload-URL expiry check (tests). Default `new Date()`. */
  now?: () => Date;
}

/**
 * The Drizzle-backed erase store (TASK-003 / ARCH-007 — the argument-less registration bound the
 * in-memory store, so a tenant offboarding "erased" messages that exist nowhere). Executes the
 * ROW-LEVEL part of each §7.8 step; counts are always rows actually written (`.returning()`).
 *
 *   • `destroyTenantDek` — a body sealed on the M34 ring (WP 2.13, envelope version 2) is shredded for real when M34's
 *     shred worker runs `m34_destroy_tenant_key_ring` AFTER the module erasers (the wrapped DEK was random and its
 *     ciphertext was the only copy). A body still on the legacy envelope (version 1) has NO destroyable key: its DEK is
 *     HKDF(MESSAGING_ENCRYPTION_KEY, org), so only the row-level part executed here makes the erasure physical: every
 *     `message.body_cipher` for the org is overwritten with the empty sentinel (both columns are NOT NULL, the M31 `""`-sentinel
 *     precedent) so no ciphertext survives in the live table. A valid envelope is ≥ 29 bytes, so `octet_length > 0` is the
 *     idempotency predicate: a second pass finds 0. Backups of a legacy row are not shredded (docs/runbooks/m36-body-key-ring.md).
 *   • `deleteStructuralRows` — FK-ordered hard deletes of the org-scoped subtree under
 *     `withOrgContext`, children before parents (delivery→alert; attachment/receipt→message→
 *     channel_member→channel; overlay→template). The parent-join child (notification_delivery
 *     — no organization_id by design, 0017) is keyed through a parent subquery, mirroring its RLS shape;
 *     message_attachment carries organization_id (1075) and is keyed on it; attachment_access_event cascades from it.
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
  const LH = schema.legalHolds;
  const LHM = schema.legalHoldMessages;
  const CH = schema.channels;
  const CM = schema.channelMembers;
  const MSG = schema.messages;
  const RCPT = schema.messageReceipts;
  const ATT = schema.messageAttachments;
  const DRAFT = schema.messageDrafts;
  const SCHED = schema.scheduledMessages;
  const EB = schema.messagingEraseBlocks;
  const AL = schema.alerts;
  const ND = schema.notificationDeliveries;
  const RO = schema.tenantAlertRoutingOverride;
  const TPL = schema.notificationTemplate;
  const TPLO = schema.tenantNotificationTemplateOverlay;
  const MTPL = schema.messageTemplates;
  const MTPLO = schema.tenantMessageTemplateOverlays;
  const SBARP = schema.tenantSbarPolicies;
  const PRES = schema.presence;
  const DE = schema.deliveryEndpoints;
  const UNP = schema.userNotificationPreferences;

  /**
   * Stop the tenant from creating any more attachment objects (migration 1076). Takes the erase lock EXCLUSIVELY: that
   * waits for every in-flight `authorize`/`complete` (which hold it SHARED until they commit), so their rows are visible to
   * the sweeps below, and once this commits every later one sees the flag and refuses. Idempotent.
   */
  async function blockNewUploads(orgId: string): Promise<void> {
    await withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${eraseLockName(orgId)}, 0))`,
      );
      await tx.insert(EB).values({ organizationId: orgId }).onConflictDoNothing();
    });
  }

  /**
   * A presigned PUT minted before the block stays valid until its own expiry, and an object that lands after the destroy
   * pass is an orphan once its row is deleted. So refuse (retryably) until every URL the tenant ever minted has expired;
   * with new authorizes blocked, nothing can then create an object, and the destroy passes that follow are final.
   */
  async function assertUploadUrlsExpired(orgId: string): Promise<void> {
    const cutoff = new Date((deps.now?.() ?? new Date()).getTime() - ERASE_UPLOAD_URL_GRACE_MS);
    const [live] = await withOrgContext(db, { organizationId: orgId, userId: "" }, (tx) =>
      tx
        .select({ until: ATT.uploadExpiresAt })
        .from(ATT)
        .where(and(eq(ATT.organizationId, orgId), gt(ATT.uploadExpiresAt, cutoff)))
        .orderBy(desc(ATT.uploadExpiresAt))
        .limit(1),
    );
    if (live?.until) {
      throw new DegradedError(
        "attachment-destruction",
        `upload URLs minted before the erase block stay valid until ${live.until.toISOString()}; retry after that (new uploads are already refused)`,
      );
    }
  }

  /**
   * Destroy the bytes behind `message_attachment.object_key` in bounded batches (the M22 document-eraser order,
   * D12/DR-019): the row is the only pointer to the object, so a row is deleted only AFTER its object is gone, batch by
   * batch, each batch in its own short transaction (no network IO inside one long transaction). A failure throws with the
   * failing batch's rows (and so its keys) still in place; objects already destroyed are idempotent on the retry.
   * Returns how many objects this pass destroyed.
   *
   * (`preflightAttachmentRemoval` runs first: the rows can only be removed with the destruction credential, so an erase run
   * without it would destroy the bytes and then fail on the row removal, leaving rows that point at nothing.)
   *
   * Retry semantics if the real removal still removes nothing after a batch's objects were destroyed (only a grant revoked
   * mid-run can do that): it throws; the batch's rows remain, the destroyed objects are gone, and the retry re-destroys
   * them idempotently (destroyObject on a missing object resolves) and then removes the rows.
   */
  const noObjectStore = () =>
    new DegradedError(
      "attachment-storage",
      "tenant has attachment objects but no object store is bound to destroy them; refusing to erase (retry once bound)",
    );
  const cannotRemove = () =>
    new DegradedError(
      "attachment-destruction",
      "tenant has attachment objects but this connection cannot delete message_attachment rows (bind DATABASE_DESTRUCTION_URL); refusing to destroy the bytes first",
    );

  /**
   * Runs BEFORE the erase block and before anything is destroyed (a misconfigured eraser must not lock the tenant out of
   * uploads for nothing): needs an object store when the tenant has objects, and a connection that can really remove the
   * rows. The probe is a REAL removal of the first row inside a transaction that is rolled back: it exercises privilege,
   * RLS policy, triggers and FKs exactly as the real one will, and commits nothing.
   */
  async function preflightAttachmentRemoval(orgId: string): Promise<void> {
    const [first] = await withOrgContext(db, { organizationId: orgId, userId: "" }, (tx) =>
      tx
        .select({ id: ATT.id })
        .from(ATT)
        .where(and(eq(ATT.organizationId, orgId), sql`${ATT.objectKey} IS NOT NULL`))
        .orderBy(ATT.id)
        .limit(1),
    );
    if (!first) return;
    if (!deps.attachmentStorage) throw noObjectStore();
    let probeRemoved = false;
    try {
      await withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const gone = await tx
          .delete(ATT)
          .where(and(eq(ATT.organizationId, orgId), eq(ATT.id, first.id)))
          .returning({ id: ATT.id });
        probeRemoved = gone.length === 1;
        throw new ProbeRollback(); // never commit the probe
      });
    } catch (error) {
      if (!(error instanceof ProbeRollback)) throw cannotRemove(); // permission denied, trigger refusal, ...
    }
    if (!probeRemoved) throw cannotRemove(); // the grant exists but RLS hides the row from this role
  }

  async function destroyAttachmentObjects(orgId: string): Promise<number> {
    const withKeys = and(eq(ATT.organizationId, orgId), sql`${ATT.objectKey} IS NOT NULL`);
    const nextBatch = () =>
      withOrgContext(db, { organizationId: orgId, userId: "" }, (tx) =>
        tx
          .select({ id: ATT.id, key: ATT.objectKey })
          .from(ATT)
          .where(withKeys)
          .orderBy(ATT.id)
          .limit(ERASE_OBJECT_BATCH),
      );
    let batch = await nextBatch();
    if (batch.length === 0) return 0;
    const storage = deps.attachmentStorage;
    if (!storage) throw noObjectStore(); // (preflight refused earlier; kept so no code path destroys without a store)
    let destroyed = 0;
    while (batch.length > 0) {
      for (const { key } of batch) {
        if (key) {
          await runWithDeadline(
            (signal) => storage.destroyObject({ organizationId: orgId, objectKey: key, signal }),
            ERASE_DESTROY_DEADLINE_MS,
            () =>
              new DegradedError(
                "attachment-destruction",
                "an object destroy exceeded its deadline; retry",
              ),
          );
          destroyed += 1;
        }
      }
      const ids = batch.map((r) => r.id);
      const gone = await withOrgContext(db, { organizationId: orgId, userId: "" }, (tx) =>
        tx
          .delete(ATT)
          .where(and(eq(ATT.organizationId, orgId), inArray(ATT.id, ids)))
          .returning({ id: ATT.id }),
      );
      if (gone.length === 0) {
        throw new DegradedError(
          "attachment-destruction",
          "attachment rows could not be deleted after their objects were destroyed; refusing to continue (the retry resumes)",
        );
      }
      batch = await nextBatch();
    }
    return destroyed;
  }

  /**
   * Destroy until a pass finds nothing: an upload authorized while the erase was running (a row with an object key
   * created after an earlier pass) must have its bytes destroyed too before the structural step removes its row.
   * Bounded: a tenant that keeps uploading through repeated passes fails the erase loudly (retryable), it does not loop.
   */
  async function destroyAllAttachmentObjects(orgId: string): Promise<void> {
    for (let pass = 0; pass < ERASE_MAX_OBJECT_PASSES; pass += 1) {
      if ((await destroyAttachmentObjects(orgId)) === 0) return;
    }
    throw new DegradedError(
      "attachment-destruction",
      "attachment objects kept appearing while the tenant was being erased; retry once uploads have stopped",
    );
  }

  /**
   * ADR-0086 (PROPOSED): a message under an ACTIVE legal hold cannot be rewritten or deleted (migration 1138's backstop trigger raises 23001
   * mid-statement). Look first, before any key is destroyed or any row touched, and fail cleanly and retryably (release the hold, then
   * retry) instead of dying on a trigger halfway through the erase.
   */
  async function assertNoActiveMessageHold(orgId: string): Promise<void> {
    const [held] = await withOrgContext(db, { organizationId: orgId, userId: "" }, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(LHM)
        .innerJoin(LH, and(eq(LH.id, LHM.legalHoldId), eq(LH.status, "active")))
        .where(eq(LHM.organizationId, orgId)),
    );
    if (held && held.n > 0) {
      throw new DegradedError(
        "legal-hold",
        `${held.n} message(s) are under an active legal hold; refusing to erase the tenant's messages (release the hold, then retry)`,
      );
    }
  }

  return {
    async destroyTenantDek(orgId) {
      await assertNoActiveMessageHold(orgId);
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const shredded = await tx
          .update(MSG)
          .set({ bodyCipher: Buffer.alloc(0), bodySha256: ERASED_BODY_SHA256 })
          .where(and(eq(MSG.organizationId, orgId), sql`octet_length(${MSG.bodyCipher}) > 0`))
          .returning({ id: MSG.id });
        return { bodiesRendered: shredded.length };
      });
    },

    async deleteStructuralRows(orgId) {
      // 1. Close the door (no new object can be created for this tenant), 2. wait out the URLs already minted, 3. destroy
      // the bytes in their own short transactions (see destroyAttachmentObjects), 4. delete the rows.
      await assertNoActiveMessageHold(orgId);
      await preflightAttachmentRemoval(orgId);
      await blockNewUploads(orgId);
      await assertUploadUrlsExpired(orgId);
      // The URL-expiry wait can be long: look again right before the irreversible object destruction (a hold applied meanwhile).
      await assertNoActiveMessageHold(orgId);
      await destroyAllAttachmentObjects(orgId);
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        // Last look, inside this transaction: a row with an object that appeared after the final pass would be removed
        // with its bytes orphaned. Refuse (retryable) instead; the whole transaction rolls back.
        const [late] = await tx
          .select({ id: ATT.id })
          .from(ATT)
          .where(and(eq(ATT.organizationId, orgId), sql`${ATT.objectKey} IS NOT NULL`))
          .limit(1);
        if (late) {
          throw new DegradedError(
            "attachment-destruction",
            "an attachment object appeared during the erase; retry",
          );
        }
        const del = async <T extends { id: string }>(run: () => Promise<T[]>): Promise<number> =>
          (await run()).length;
        const orgAlertIds = tx.select({ id: AL.id }).from(AL).where(eq(AL.organizationId, orgId));

        let deleted = 0;
        // Children of alert / message first (RESTRICT-shaped parents).
        deleted += await del(() =>
          tx.delete(ND).where(inArray(ND.alertId, orgAlertIds)).returning({ id: ND.id }),
        );
        deleted += await del(() =>
          tx.delete(AL).where(eq(AL.organizationId, orgId)).returning({ id: AL.id }),
        );
        // WP 1.5: attachments carry organization_id (1075) and may be unbound (no message yet), so they are
        // keyed on the org, not on a message subquery. Their append-only access log (no DELETE for the app role)
        // goes with them through the composite FK's ON DELETE CASCADE, like message_revision.
        deleted += await del(() =>
          tx.delete(ATT).where(eq(ATT.organizationId, orgId)).returning({ id: ATT.id }),
        );
        // WP 2.5: private drafts (sealed under the tenant DEK) go with the tenant. Visible here only on the
        // destruction connection (RLS pins app-role reads to the owner); the channel FK cascade below is the backstop.
        deleted += await del(() =>
          tx.delete(DRAFT).where(eq(DRAFT.organizationId, orgId)).returning({ id: DRAFT.id }),
        );
        // WP 2.6: scheduled messages (sealed under the tenant DEK, owner-pinned like drafts) go with the tenant too; the
        // channel FK cascade is the backstop.
        deleted += await del(() =>
          tx.delete(SCHED).where(eq(SCHED.organizationId, orgId)).returning({ id: SCHED.id }),
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
        // WP 2.8: the tenant's saved replies, shared templates and overlays (platform templates carry no organization_id
        // and are never matched). The overlay goes first only for readability: its FK points at the platform rows.
        deleted += await del(() =>
          tx.delete(MTPLO).where(eq(MTPLO.organizationId, orgId)).returning({ id: MTPLO.id }),
        );
        deleted += await del(() =>
          tx.delete(MTPL).where(eq(MTPL.organizationId, orgId)).returning({ id: MTPL.id }),
        );
        // WP 3.3: the tenant's SBAR policy (org configuration, one row).
        deleted += await del(() =>
          tx
            .delete(SBARP)
            .where(eq(SBARP.organizationId, orgId))
            .returning({ id: SBARP.organizationId }),
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
