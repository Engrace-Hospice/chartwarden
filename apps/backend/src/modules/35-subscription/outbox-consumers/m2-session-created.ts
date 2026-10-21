// apps/backend/src/modules/35-subscription/outbox-consumers/m2-session-created.ts — the §4.12
// `user-active-period-aggregator` binding over `m2.session.created` (F-172, #248). M35's own D21 (locked,
// exhaustive "8 inbound subscriptions") names this event; F-142/F-167 left it deferred on
// `PseudonymKeyProvider.activeKey()` having zero implementations — now built
// (`../pseudonym-key-provider.ts`).
//
// THE PAYLOAD/DOMAIN MISMATCH F-142 NAMED, RESOLVED. `m2.session.created`'s catalogued payload carries a
// `userId` (`events-by-m2.ts`), while D6 and `UsageMeteringService.recordUserActive` both key the
// per-user meter on a MEMBERSHIP id — a real, decided fact this file resolves rather than works around:
// `membership` is M1-owned (`architecture/module-manifest.ts`), M35's manifest `dependsOn` is `[1]`, and
// M5's own `membershipUserIdForOrg` (`05-patient/seams/drizzle-stores.ts`) already reads `schema.memberships`
// directly for the identical reason — "the established precedent, not a new cross-module seam." This file
// does the SAME direct read in the opposite direction: `(organizationId, userId) -> membershipId`.
//
// A session for a user with NO membership row in this org (a platform-ops session, a stale/edge-case
// delivery) is a documented no-op — the `membershipUserIdForOrg` "nothing to resolve, skip" precedent —
// never a fabricated membership id.
import { type DbClient, schema } from "@chartwarden/db";
import {
  type PseudonymKeyProvider,
  computeBillingPseudonym,
  toBillingYearMonth,
} from "@chartwarden/subscription-billing";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, desc, eq, ne } from "drizzle-orm";
import { createDrizzleActivePeriodStore } from "../active-period-store-drizzle";

const MB = schema.memberships;
const CONSUMER_USER_ID = "";

export const M35_SESSION_CREATED_CONSUMER = {
  eventNames: ["m2.session.created"] as const,
  consumerName: "m35.user-active-period-aggregator",
} as const;

export interface SessionCreatedConsumerDeps {
  readonly db: DbClient;
  readonly keyProvider: PseudonymKeyProvider;
  readonly now?: () => Date;
}

/** `(organizationId, userId) -> membershipId` — the non-revoked membership if one exists, else the most
 *  recently invited (a session for a revoked-only membership history is still resolvable for the pseudonym
 *  ledger; only a user with NO membership at all in this org resolves to `null`). */
async function membershipIdForUserForOrg(
  db: DbClient,
  organizationId: string,
  userId: string,
): Promise<string | null> {
  return withOrgContext(db, { organizationId, userId: CONSUMER_USER_ID }, async (tx) => {
    const t = tx as unknown as DbClient;
    const [nonRevoked] = await t
      .select({ id: MB.id })
      .from(MB)
      .where(
        and(eq(MB.organizationId, organizationId), eq(MB.userId, userId), ne(MB.status, "revoked")),
      )
      .limit(1);
    if (nonRevoked) return nonRevoked.id;
    const [mostRecent] = await t
      .select({ id: MB.id })
      .from(MB)
      .where(and(eq(MB.organizationId, organizationId), eq(MB.userId, userId)))
      .orderBy(desc(MB.invitedAt))
      .limit(1);
    return mostRecent?.id ?? null;
  });
}

/**
 * M35's live `m2.session.created` binding (§4.12 `user-active-period-aggregator`). Pseudonymizes the
 * resolved membership id and upserts `user_active_period` — idempotent on
 * `(organizationId, membershipPseudonym, periodYearMonth)` via the store's own `ON CONFLICT`.
 */
export function buildM35SessionCreatedConsumer(deps: SessionCreatedConsumerDeps) {
  const now = deps.now ?? (() => new Date());
  const activePeriodStore = createDrizzleActivePeriodStore(deps.db);

  return {
    consumerName: M35_SESSION_CREATED_CONSUMER.consumerName,
    consumerModule: "m35" as const,
    eventTypes: M35_SESSION_CREATED_CONSUMER.eventNames,
    async handle(event: {
      readonly eventType: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const p = (event.payload ?? {}) as Record<string, unknown>;
      const userId = typeof p.userId === "string" ? p.userId : "";
      if (userId.length === 0) return;

      const membershipId = await membershipIdForUserForOrg(deps.db, event.organizationId, userId);
      if (!membershipId) return; // no membership for this (org, user) — nothing to attribute, skip.

      const key = await deps.keyProvider.activeKey();
      const membershipPseudonym = computeBillingPseudonym(key.keyMaterial, membershipId);
      const at = now();

      await activePeriodStore.upsertUserActivePeriod({
        organizationId: event.organizationId,
        membershipPseudonym,
        pseudonymKeyEpoch: key.keyEpoch,
        periodYearMonth: toBillingYearMonth(at),
        becameActiveAt: at,
      });
    },
  };
}
