// apps/backend/src/modules/16-bereavement/outbox-consumers/m39-consent-revoked.ts — the §2.6 / D6
// M39 consent-revocation cascade (F-151, #248).
//
// `decideConsentRevocationCascade` (../lifecycle/cascades.ts) has been a complete, pure, unit-tested
// decider since M16-T03 with no live binding anywhere — the `m39.consent.revoked` → m16 pair sat in
// `scripts/outbox-deferred-consumers.ts`'s `handlers-unbound` group. `bereavement_opt_out.source_kind`'s
// own schema comment already names the mechanism this file builds: "when M39 emits
// `m39.consent.revoked` for a `bereavement_outreach_consent` record, M16 CASCADES (§2.6) — it does not
// gate-keep. M39 is the truth" (`packages/db/src/schema/bereavement/bereavement-opt-outs.ts`).
//
// §2.6 is explicit that M16 never GATES on consent, only reacts to it, which is why this consumer never
// refuses a delivery: a consent revocation for a contact this org's M16 does not track (no
// `bereaved_contact.consent_record_id` match) or for a contact that already left the roster is a no-op,
// not an error — `decideConsentRevocationCascade` says so directly.
//
// The write mirrors `optOutContact`'s existing HTTP-route path (`routes/write-service-drizzle.ts`,
// route 14) exactly — same machine, same effect runner, same OPT_OUT insert shape, same future-outreach
// cancellation — with `recordedByUserId: null` and `sourceKind: "m39_revocation_cascade"` in place of a
// staff membership, the identical "consumer-driven write names no acting membership" convention F-102's
// `CONSUMER_USER_ID` established and F-105's bereavement intake consumer already uses for `app.user_id`.
//
// A NARROW, LATENT DECIDER/MACHINE MISMATCH, FOUND WHILE BINDING THIS — reported, not silently
// papered over. `decideConsentRevocationCascade` returns `cascade_opt_out` for a contact whose status is
// EITHER `active` OR `proposed`; `BEREAVED_CONTACT_GRAPH` (../lifecycle/contact.ts) accepts `optOut` only
// from `active` — `proposed` accepts only `confirmContact`. The decider's own unit test
// (`bereavement-lifecycle.test.ts`) only ever exercises `active`/`opted_out`/`null`, never `proposed`, so
// this has never been caught. A consent revocation that lands while a contact is still `proposed` (invited
// but not yet confirmed onto the roster) therefore throws `ILLEGAL_TRANSITION` here and dead-letters for a
// human — the same "refuse rather than guess" posture `../outbox-consumers/m6-bereavement-eligible.ts`
// takes on its own unresolvable death-fact cases, not a bug in THIS consumer. Whether an unconfirmed
// contact's consent revocation should instead be a no-op (matching `opted_out`/`deceased`) or drive some
// other transition is a product decision this pass does not make.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { BereavedContactId, ConsentId, IsoInstant } from "@chartwarden/types";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { decideConsentRevocationCascade } from "../lifecycle/cascades";
import { transitionBereavedContact } from "../lifecycle/index";
import type { WriteOutboxPort } from "../routes/write-service";

const CONTACT = schema.bereavedContact;
const OPT_OUT = schema.bereavementOptOut;
const OUTREACH = schema.bereavementOutreach;

/** §3.3 — a consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

export const M16_CONSENT_REVOKED_CONSUMER = {
  eventName: "m39.consent.revoked",
  consumerName: "m16.m39-consent-revoked",
} as const;

export interface ConsentRevocationDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s `m16.*` against the boot catalog. */
  readonly outbox: WriteOutboxPort;
}

function factsOf(payload: unknown): { consentRecordId: ConsentId } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const consentRecordId = p.consentRecordId;
  if (typeof consentRecordId !== "string" || consentRecordId.length === 0) {
    throw new Error(`${M16_CONSENT_REVOKED_CONSUMER.consumerName}: payload has no consentRecordId`);
  }
  return { consentRecordId: consentRecordId as ConsentId };
}

/**
 * M16's live `m39.consent.revoked` binding — the §2.6 / D6 consent-source-of-truth cascade.
 *
 * Idempotent by construction, not merely by the dispatcher's `(eventId, consumerName)` receipt:
 * `decideConsentRevocationCascade` reads `contactStatus` fresh on every delivery and answers `no_op` for
 * anything but `active`/`proposed`, so a redelivery after the cascade already ran finds the contact
 * already `opted_out` and does nothing a second time — no separate uniqueness constraint is needed the
 * way `berv_plan_unique_admission` backstops the intake consumer, because this write can never target
 * the same row twice with an effect that still applies.
 */
export function buildM16ConsentRevokedConsumer(deps: ConsentRevocationDeps) {
  return {
    consumerName: M16_CONSENT_REVOKED_CONSUMER.consumerName,
    consumerModule: "m16" as const,
    eventTypes: [M16_CONSENT_REVOKED_CONSUMER.eventName] as const,
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

          const [contact] = await tx
            .select()
            .from(CONTACT)
            .where(
              and(
                eq(CONTACT.organizationId, organizationId),
                eq(CONTACT.consentRecordId, facts.consentRecordId),
              ),
            )
            .limit(1);

          const action = decideConsentRevocationCascade({
            consentRecordId: facts.consentRecordId,
            contactId: (contact?.id ?? null) as BereavedContactId | null,
            contactStatus: contact?.status ?? null,
          });

          if (action.kind === "no_op" || !contact) return;

          const at = new Date().toISOString() as IsoInstant;
          const transition = transitionBereavedContact(contact.status, {
            type: "optOut",
            at,
            optOutKind: "full",
            source: "m39_revocation_cascade",
            reason: "consent revoked via M39 (D6 — M39 is the source of truth; M16 cascades)",
          });

          const payload = {
            planId: contact.planId,
            contactId: contact.id,
            optOutKind: "full",
            source: "m39_revocation_cascade",
          };
          await deps.outbox.publish(tx, {
            organizationId,
            eventName: "m16.bereavement.contact_opted_out",
            aggregateKind: "bereavement_plan",
            aggregateId: contact.planId,
            payload,
          });

          await tx.insert(OPT_OUT).values({
            organizationId,
            providerEntityId: contact.providerEntityId,
            locationId: contact.locationId,
            planId: contact.planId,
            bereavedContactId: contact.id,
            optOutKind: "full",
            reasonRedacted: null,
            optedOutAt: new Date(at),
            recordedByUserId: null,
            sourceKind: "m39_revocation_cascade",
          });

          const scheduled = await tx
            .select({ id: OUTREACH.id })
            .from(OUTREACH)
            .where(
              and(
                eq(OUTREACH.bereavedContactId, contact.id),
                eq(OUTREACH.status, "scheduled"),
                gte(OUTREACH.dueAt, new Date(at)),
              ),
            );
          if (scheduled.length > 0) {
            await tx
              .update(OUTREACH)
              .set({
                status: "cancelled",
                cancelledAt: new Date(at),
                cancellationReasonRedacted: "contact opted out via M39 revocation cascade",
                version: sql`${OUTREACH.version} + 1`, // §2.5 (GAP-194)
                updatedAt: new Date(at),
              })
              .where(
                inArray(
                  OUTREACH.id,
                  scheduled.map((r) => r.id),
                ),
              );
          }

          await tx
            .update(CONTACT)
            .set({
              status: transition.to,
              optedOutAt: new Date(at),
              version: contact.version + 1,
              updatedAt: new Date(at),
            })
            .where(eq(CONTACT.id, contact.id));
        },
      );
    },
  };
}
