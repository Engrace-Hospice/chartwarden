// apps/backend/src/modules/39-consent/bereavement-outreach-consent-probe.ts — M39's answer to M16's D6
// confirm-contact gate (`bereavementConsentActive`, M16 `routes/write-service-drizzle.ts`).
//
// M16 §2.3 lets a `proposed` bereaved contact become `active` only when
//   (a) THAT survivor's own M39 `bereavement_outreach_consent` is in force (D6: one record per bereaved
//       person, captured post-death with `grantor_kind='bereaved_person_self'`, linked from
//       `bereaved_contact.consent_record_id`), or
//   (b) the contact is the decedent's primary caregiver and a `family_caregiver_access` consent still
//       covers post-death engagement (M39 D13: it persists only when captured `survives_death=true`; M39's
//       `m5.patient.deceased` consumer expires every other one at death).
// M39 answers the two consent facts; M16 decides "primary caregiver" from M5's roster seam and combines them.
//
// Both facts go through the published `ConsentEvaluator` seam — the same engine every PHI-egress module
// uses — so status, effective/expiry window, post-death scope and per-recipient activeness are decided in one
// place. Fact (a) is PINNED to the contact's own record (`consentRecordId`): another survivor's active
// consent on the same decedent never stands in for this one, and no record id means no consent.
//
// Tenant scope: the Drizzle `ConsentStore` behind the evaluator reads under `withOrgContext(organizationId)`,
// so RLS limits every read to the caller's org — a consent record id from another tenant is invisible and
// denies. Callers pass an explicit org, so this works from a request or a worker alike.
//
// FAIL-CLOSED: an evaluator error propagates; M16's caller turns any failure into "no consent".
import type { ConsentEvaluator } from "@wardenx/consent";

/** The two M39 facts M16's D6 confirm gate reads. */
export interface BereavementOutreachConsentFacts {
  /** The contact's own `bereavement_outreach_consent` record is in force. */
  readonly hasOutreachConsent: boolean;
  /** A `family_caregiver_access` consent on the decedent is still in force (survives-death). */
  readonly hasFamilyCaregiverAccess: boolean;
}

export interface BereavementOutreachConsentQuery {
  readonly organizationId: string;
  /** The decedent (`bereavement_plan.patient_id`) — M39 files a survivor's consent against them. */
  readonly patientId: string;
  /** The survivor's own consent record (`bereaved_contact.consent_record_id`). */
  readonly consentRecordId?: string;
}

export type BereavementOutreachConsentProbe = (
  query: BereavementOutreachConsentQuery,
) => Promise<BereavementOutreachConsentFacts>;

const CALLER_MODULE = "m16";
const CALLER_ROUTE = "POST /api/v1/bereavement/contacts/:contactId/confirm";

/** Build the probe over M39's evaluator (resolved per call, so a late seam registration is honored). */
export function createBereavementOutreachConsentProbe(
  evaluator: () => ConsentEvaluator,
  now: () => Date = () => new Date(),
): BereavementOutreachConsentProbe {
  return async ({ organizationId, patientId, consentRecordId }) => {
    const asOf = now().toISOString();
    const common = {
      organizationId,
      patientId,
      asOf,
      sessionContext: { sessionClass: "staff" as const },
      callerModule: CALLER_MODULE,
      callerRoute: CALLER_ROUTE,
    };
    const outreach =
      consentRecordId === undefined
        ? { allowed: false }
        : await evaluator().evaluate({
            ...common,
            consentType: "bereavement_outreach_consent",
            consentRecordId,
          });
    const family = await evaluator().evaluate({
      ...common,
      consentType: "family_caregiver_access",
    });
    return { hasOutreachConsent: outreach.allowed, hasFamilyCaregiverAccess: family.allowed };
  };
}
