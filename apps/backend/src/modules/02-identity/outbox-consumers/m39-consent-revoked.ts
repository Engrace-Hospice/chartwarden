// apps/backend/src/modules/02-identity/outbox-consumers/m39-consent-revoked.ts — M2's half of the
// §2.6/D7 M39 consent-revocation cascade (F-142, #248): "M2 portal-session terminate."
//
// M39's own spec is unusually decisive about this one, cross-referenced three separate ways: D7 ("M2
// portal-session terminate"), the per-type cascade table (names M2 for both `portal_access` and
// `family_caregiver_access`), and a worked "Done means" walkthrough (§7.3, W-CON-03) that names the
// mechanism outright — "M2 consumer subscribes; iterates active sessions... terminates each session
// immediately" — and the acceptance check: "within 5 seconds of revocation, all portal sessions for
// the patient are terminated server-side (verified by a portal-session probe returning `401
// session_revoked`)". This is the FIRST outbox consumer M2 has ever had — no `outbox-consumers/`
// directory existed here before this file.
//
// THIS BUILD IS DELIBERATELY SCOPED TO ONE OF THE TWO NAMED CASCADE TYPES, NOT BOTH — read on before
// assuming `family_caregiver_access` is simply "left for later."
//
// The spec's own walkthrough was written against a session model that no longer exists: it says
// `session_class='portal' AND scope.patientId=pt_chen` as if one flat "portal" class + a bare
// patient id always resolves the right sessions. Since then (F-030 / migration 0219-0220) the single
// `portal` class split into THREE — `patient_portal` / `caregiver_portal` / `bereaved_portal`
// (`packages/auth/src/identity/session-classes.ts`) — and `session.scope` gained a
// `portalAccountId` key that arrives BEFORE `patientId` does (a portal session is minted before its
// patient is selected). Critically, `portal_access_grant` (M31-owned) has NO uniqueness constraint
// preventing two independent, concurrently-active consent-backed grants of the SAME kind for the SAME
// patient — e.g. two separate `family_caregiver_access` consent RECORDS, each naming a different
// caregiver, can legitimately coexist for one patient (nothing in `consent-store-db.ts#createDraft`
// refuses a second draft of an already-consented type). `family_caregiver_access` is also §2.3
// per-recipient (`CONSENT_TYPE_STRUCTURE.family_caregiver_access.isPerRecipient`), so ONE revoked
// consent record can back MULTIPLE caregivers' portal accounts at once.
//
// So a blanket "every `caregiver_portal` session scoped to this patientId" sweep — the only sweep
// buildable from M2's OWN table alone — would, in that two-record scenario, terminate an UNRELATED
// caregiver's still-valid session whose access derives from a DIFFERENT, still-active consent record.
// That is exactly the over-termination the task brief warns against, and it is a real, structurally
// reachable case, not a hypothetical: the only fact that could disambiguate it is
// `portal_access_grant.source_consent_record_id` (M31-owned), and M31's two published read seams
// (`PortalAccountReader`, `PortalAccessGrantReader`, `apps/backend/src/modules/31-portal/seams/
// registration.ts`) do not expose it — `PortalAccessGrantDigest` (`packages/types/src/portal.ts`)
// carries `grantId/portalAccountId/patientId/grantKind/scopeSet/grantedAt/revokedAt`, no
// `sourceConsentRecordId`. Both seams are ALSO not in the platform's `SeamName` union
// (`packages/types/src/seams.ts`) or `REQUIRED_SEAMS`
// (`apps/backend/src/bootstrap/seams/registry.ts`) at all — `getSeam("PortalAccessGrantReader")`
// does not type-check today; only M31's own files and the composition root reference either name.
// Resolving this precisely needs a NEW query on the M31 side (e.g. "portal accounts backed by consent
// record X") threaded through those shared files — out of scope for an isolated M2-only file per this
// pass's brief. Reported for the coordinator rather than guessed at.
//
// `portal_access` (the patient's OWN access) has NO equivalent risk and is what this file builds:
// `portal_account_relationship='patient_self'` is inherently one-per-patient (there is exactly one
// "the patient, logged in as themselves" relationship, and `portal_access_grant_account_patient_
// active_unique` caps a given account to ONE active grant per patient regardless of how many consent
// records exist), so every `patient_portal`-class session scoped to this exact `patientId` is, by
// construction, a session this exact revocation should end — no cross-caregiver ambiguity is
// possible. This is also the ONLY consent type the spec's own worked example (§7.3, `cascadeKind:
// 'portal_access_revocation'`) actually walks through end to end.
//
// TERMINATION MECHANISM: a DELETE, not a status flag — `session` carries no "revoked" column;
// `session-writer-db.ts#revokeAllForUser`/`#revokeForMembership` (the only existing M2 session-
// termination precedent) already delete the row outright, which is how Better Auth's `getSession`
// comes to answer "no such session" (`401`) for a killed token. This consumer does the identical
// DELETE, scoped tighter than either precedent: by `(activeOrganizationId, sessionClass, scope-
// >>'patientId')` rather than by user, so it can never touch a STAFF session even though
// `portal_account.user_id` references the same `user` table a staff member's Better Auth identity
// lives in (a real, if unlikely, shared-identity edge case `revokeAllForUser` would not have been
// safe against here).
//
// NO `withOrgContext` — `session` is NON_ORG_SCOPED (no RLS; see `packages/db/src/schema/
// sessions.ts`'s own header), so every statement scopes inline on `active_organization_id`, the exact
// shape `portal-session-store.ts` and `session-writer-db.ts` already use. Safe to call from a relay
// tick with no ambient request context, unlike M6's id-keyed §4.7 seam reads.
//
// IDEMPOTENT BY CONSTRUCTION: a DELETE that matches zero rows (already deleted by an earlier
// delivery, or never existed) is a no-op — no separate dedup bookkeeping needed.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, sql } from "drizzle-orm";

const SESSION = schema.sessions;

/** The one consent type this build resolves without ambiguity — see the file header. */
const PORTAL_ACCESS_TYPE_KEY = "portal_access";

/** The session class `portal_access` (patient-self) revocation terminates. */
const PATIENT_PORTAL_SESSION_CLASS = "patient_portal";

export const M2_CONSENT_REVOKED_CONSUMER = {
  eventName: "m39.consent.revoked",
  consumerName: "m2.m39-consent-revoked",
} as const;

export interface ConsentRevokedSessionTerminationDeps {
  readonly db: DbClient;
}

interface ConsentRevokedFacts {
  readonly patientId: string;
  readonly typeKey: string;
}

function factsOf(payload: unknown): ConsentRevokedFacts {
  const p = (payload ?? {}) as Record<string, unknown>;
  const patientId = p.patientId;
  const typeKey = p.typeKey;
  if (typeof patientId !== "string" || patientId.length === 0) {
    throw new Error(`${M2_CONSENT_REVOKED_CONSUMER.consumerName}: payload has no patientId`);
  }
  if (typeof typeKey !== "string" || typeKey.length === 0) {
    throw new Error(`${M2_CONSENT_REVOKED_CONSUMER.consumerName}: payload has no typeKey`);
  }
  return { patientId, typeKey };
}

/**
 * M2's live `m39.consent.revoked` binding — terminates the patient's own `patient_portal` sessions
 * when their `portal_access` consent is revoked. See the file header for why `family_caregiver_access`
 * (and every other consent type) is deliberately NOT handled here yet.
 */
export function buildM2ConsentRevokedConsumer(deps: ConsentRevokedSessionTerminationDeps) {
  return {
    consumerName: M2_CONSENT_REVOKED_CONSUMER.consumerName,
    consumerModule: "m2" as const,
    eventTypes: [M2_CONSENT_REVOKED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      if (facts.typeKey !== PORTAL_ACCESS_TYPE_KEY) {
        // Every other consent type's session-termination scope is ambiguous from M2's own table alone
        // (see file header) — deliberately left untouched rather than guessed at.
        return;
      }

      await deps.db
        .delete(SESSION)
        .where(
          and(
            eq(SESSION.activeOrganizationId, event.organizationId),
            eq(SESSION.sessionClass, PATIENT_PORTAL_SESSION_CLASS),
            sql`${SESSION.scope} ->> 'patientId' = ${facts.patientId}`,
          ),
        );
    },
  };
}
