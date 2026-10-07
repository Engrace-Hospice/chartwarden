// apps/backend/src/modules/31-portal/outbox-consumers/m39-consent-revoked.ts — the §4.10
// `m39.consent.revoked` (BROAD, any-consent-type) binding (#248 continuation of F-160's M31 build).
//
// M31's own §4.10 "M31 consumes" table names this pair — "any consent type backing an active grant" — with
// a real consumer file (`m39-consent-revoked.ts`), effect: "Cascade revoke grants; close active sessions."
// This is a WIDER relationship than the already-built (F-139) `m39.consent.delegated_access.revoked`, which
// only ever covers the `family_caregiver_access` per-recipient projection row; THIS event fires for every
// M39 consent type, including `portal_access`, `dpoa_healthcare`, `personal_representative_authority_post_
// death` and `bereavement_outreach_consent` — every type `portal_access_grant.grant_kind` can carry.
//
// SCOPED TO THE GRANT-REVOCATION HALF ONLY — "close active sessions" is DELIBERATELY NOT built here, and
// that is a scoping decision, not an oversight. `apps/backend/src/modules/02-identity/outbox-consumers/
// m39-consent-revoked.ts` (M2's own binding of this SAME event) already terminates sessions for exactly one
// of the five backing consent types (`portal_access`) and its own header explains, at length, why it
// refuses the other four: M2's `session` table carries no consent-record linkage, only a bare `patientId` in
// `session.scope`, so for any per-recipient type (`family_caregiver_access`) — where TWO different, still-
// valid consent records can each back a DIFFERENT caregiver's grant for the SAME patient — a patientId-only
// sweep would terminate an unrelated caregiver's still-authorized session. M2's file names the fix
// precisely: "a NEW query on the M31 side ('portal accounts backed by consent record X') threaded through
// [M31's published seam files] — out of scope for an isolated M2-only file."
//
// THIS FILE DOES NOT PICK UP THAT NAMED FIX, on purpose, for a narrower reason than "out of scope": `session`
// is M2's OWNED table (packages/db/src/schema/sessions.ts), and `session-writer-db.ts`'s own file header
// (quoted in M2's consumer) calls its DELETE path "the only existing M2 session-termination precedent" — no
// other module in this codebase writes to `session` anywhere (grepped). Writing a second, M31-owned DELETE
// path against a table M31 does not own would be the exact cross-module write boundary this arc's table-
// ownership gate (`scripts/check-table-ownership.ts`) exists to catch, even though M31 now HAS the
// disambiguating fact M2's file says it lacks (this consumer resolves the exact `portalAccountId` per
// revoked grant, which — per M2's own comment that `session.scope` carries a `portalAccountId` key that
// arrives before `patientId` does — WOULD resolve M2's ambiguity precisely). That fix is real and is now
// buildable (M31's `sourceConsentRecordId` match below is the exact query M2's header asks for), but it
// belongs in M2's own file as a call into an M31-published read, not as an M31 write into M2's table — left
// for that follow-up, reported here rather than built past the ownership boundary.
//
// WHY THIS HALF HAS NO AMBIGUITY, UNLIKE M2's: `portal_access_grant.source_consent_record_id` is a REAL
// COLUMN M31 OWNS on the exact table this consumer writes — the match is a direct, unambiguous equality on
// M31's own row, never a broad patientId sweep across accounts. The per-recipient multi-caregiver case that
// blocks M2's sweep does not apply here: each grant already carries the ONE consent record that backs it.
//
// NO ACTOR NEEDED: `revoked_by_membership_id` is nullable (unlike `granted_by_membership_id`, the F-150-
// shaped NOT NULL wall the sibling `plan_opened` consumer — reported BLOCKED this same pass — hits on the
// INSERT side of the bereaved flip). A revoke needs no system-actor convention this codebase doesn't have.
//
// IDEMPOTENT BY CONSTRUCTION: the UPDATE is guarded by `revoked_at IS NULL` in its own WHERE clause (the
// telehealth consumers' / sibling `plan-closed` consumer's precedent) — a redelivery matches zero rows.
//
// ACCOUNT-LEVEL ORPHAN CLEANUP (spec §2.2.1: "all grants revoked and the account has no remaining patient
// context" → `portal_account.status='revoked'`) IS NOT ATTEMPTED HERE — this consumer only ever sees the
// grants this ONE revoked consent record backs, not an account's full grant roster across every patient, so
// deciding "does this account have any OTHER live grant left" from inside this handler would need a second,
// broader read this file's narrow scope does not ask for. Left as a separate, undecided mechanism.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, isNull, sql } from "drizzle-orm";
import { type M31EventEmitter, emitGrantsRevoked } from "../events";

const PAG = schema.portalAccessGrants;

/** Mirrors the sibling consumers' system-actor sentinel — no actor column this update needs to stamp. */
const CONSUMER_USER_ID = "";

export const M31_CONSENT_REVOKED_CONSUMER = {
  eventName: "m39.consent.revoked",
  consumerName: "m31.m39-consent-revoked",
} as const;

export interface ConsentRevokedGrantCascadeConsumerDeps {
  readonly db: DbClient;
  /** GAP-159 - same-tx `m31.portal_access_grant.revoked` emit (absent in slice/tests). */
  readonly events?: M31EventEmitter;
  /**
   * GAP-171 — records M31's `m31_portal` ACK on M39's revocation cascade. Injected (the composition root binds
   * M39's org-explicit `recordCascadeAckForOrg`) so M31 never writes M39's `consent_revocation` table nor
   * imports M39. Called only AFTER the grant revocation committed; a throw fails the delivery so the outbox
   * retries it (the revoke is idempotent), which is exactly the at-least-once the cascade promises.
   */
  readonly ackCascade?: (input: {
    readonly organizationId: string;
    readonly consentRecordId: string;
  }) => Promise<unknown>;
}

interface ConsentRevokedFacts {
  readonly consentRecordId: string;
}

function factsOf(payload: unknown): ConsentRevokedFacts {
  const p = (payload ?? {}) as Record<string, unknown>;
  const consentRecordId = p.consentRecordId;
  if (typeof consentRecordId !== "string" || consentRecordId.length === 0) {
    throw new Error(`${M31_CONSENT_REVOKED_CONSUMER.consumerName}: payload has no consentRecordId`);
  }
  return { consentRecordId };
}

/**
 * M31's live `m39.consent.revoked` binding — revokes every `portal_access_grant` row whose
 * `source_consent_record_id` matches the revoked consent, with `revoke_cascade_source='consent_revoked'`
 * (the exact `PortalGrantRevokeCascadeSource` member the §3.3 CHECK names for this cascade).
 */
export function buildM31ConsentRevokedGrantCascadeConsumer(
  deps: ConsentRevokedGrantCascadeConsumerDeps,
) {
  return {
    consumerName: M31_CONSENT_REVOKED_CONSUMER.consumerName,
    consumerModule: "m31" as const,
    eventTypes: [M31_CONSENT_REVOKED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const now = new Date();

          const revoked = await tx
            .update(PAG)
            .set({
              revokedAt: now,
              revokeCascadeSource: "consent_revoked",
              version: sql`${PAG.version} + 1`,
              updatedAt: now,
            })
            .where(
              and(
                eq(PAG.organizationId, organizationId),
                eq(PAG.sourceConsentRecordId, facts.consentRecordId),
                isNull(PAG.revokedAt),
              ),
            )
            .returning({
              id: PAG.id,
              portalAccountId: PAG.portalAccountId,
              patientId: PAG.patientId,
            });
          await emitGrantsRevoked(deps.events, tx, organizationId, revoked, "consent_revoked");
        },
      );
      await deps.ackCascade?.({ organizationId, consentRecordId: facts.consentRecordId });
    },
  };
}
