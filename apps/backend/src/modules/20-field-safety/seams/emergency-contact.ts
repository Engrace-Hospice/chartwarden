// apps/backend/src/modules/20-field-safety/seams/emergency-contact.ts — M20-T05 (M20-F06, §2.2.8, D10,
// §2.2.2's `emergency_terminus`).
//
// ── WHAT M20-F06 ACTUALLY RESOLVED ────────────────────────────────────────────────────────────────────
//
// The spec's dependency list calls this "the per-membership emergency-contact OVERRIDE row", which reads
// like M20 overrides something M2 holds. M2 holds nothing: its authoritative `ownedTables` are
// `two_factor` / `passkey` / `organization_invitation`, and there is no emergency-contact table anywhere
// on the platform. So there is no override — this row IS the record, and it lives in M20's schema beside
// the consent row M20 already owns, because the two are the same act: a clinician saying "yes, you may
// call this person if the chain reaches its end, and here is who".
//
// THAT IS WHY THERE IS NO FOURTEENTH TABLE. `safety_emergency_contact_consent` carries the consent AND
// the contact — the contact lives in `consent_scope_detail`, which §3.3's `m20_secc_contact_present`
// CHECK requires to contain a `contact` key for exactly the `emergency_contact_call` purpose. Splitting
// the contact into its own table would have needed a manifest edit (Wave P2-2 acceptance #1 governs
// those) and would have created a shape the schema explicitly forbids: a contact with no consent behind
// it. A phone number M20 may not dial is not an emergency contact, it is a stored personal detail of a
// clinician's spouse.
//
// ── THE READ IS THREE-VALUED, AND `absent` IS NOT `unavailable` ───────────────────────────────────────
//
// §2.2.2's terminus effect is `{ kind: "dial_emergency_contact", consentPresent }` (../lifecycle/effects)
// and the §4.10 payload carries `emergencyContactCallInitiated` — both have to be able to say the
// terminus happened WITHOUT a contact, because it does: declining `emergency_contact_call` does not
// disable SOS (M20-F16), it means the terminus pages the recipients and dials nobody. So a clinician with
// no live consent is `absent`, a definite fact the ledger records.
//
// An unreadable store is `unavailable`, and it must not collapse into `absent`. They differ in what the
// terminus is entitled to record: `absent` writes "no consent existed" into a workers-comp-grade trail
// that an investigator reads years later, and doing that because a query timed out would put a false
// statement about a clinician's own choice into the one record that is supposed to prove it. The caller
// (M20-T06's terminus path) still dials nobody either way — the alert never waits on this read — but the
// two write different truths.
//
// ── THE CONTACT DETAIL IS NEVER OPENED HERE ───────────────────────────────────────────────────────────
//
// `consent_scope_detail` is application-layer ciphertext (§3.3) and §3.6-audit-denylisted. This module
// hands it to the dial effect VERBATIM as an opaque value and never parses, logs or projects it. There is
// deliberately no `phone` field on {@link SafetyEmergencyContactRead}: a spouse's phone number that
// existed as a plain string anywhere in M20's read path would sooner or later reach a log line, and the
// §8.7 privacy boundary is drawn precisely so that it cannot.
import type { IsoInstant, MembershipId, OrgId } from "@chartwarden/types";
import type { SafetyEmergencyContactFacts, SafetySeamStore } from "./store";

/** M20-F06 — the terminus's answer to "may we call somebody for her, and who?". See the header. */
export type SafetyEmergencyContactRead =
  | {
      readonly kind: "granted";
      readonly consentId: string;
      readonly grantedAt: IsoInstant;
      readonly expiresAt: IsoInstant | null;
      /** The `consent_scope_detail` ciphertext, verbatim and unopened. */
      readonly consentScopeDetail: unknown;
    }
  | { readonly kind: "absent" }
  | { readonly kind: "unavailable"; readonly reason: string };

/** Project one stored row into the `granted` arm. Exported so §9.1 pins the projection without a store. */
export function emergencyContactReadFrom(
  facts: SafetyEmergencyContactFacts,
): SafetyEmergencyContactRead {
  return {
    kind: "granted",
    consentId: facts.consentId,
    grantedAt: facts.grantedAt,
    expiresAt: facts.expiresAt,
    consentScopeDetail: facts.consentScopeDetail,
  };
}

/**
 * D10 / §2.2.2 — resolve the clinician's live `emergency_contact_call` consent at `atIso`.
 *
 * `atIso` rather than `now()` because the terminus may be reconstructed: a §2.7 BCP re-entry replays a
 * night's chain, and asking today whether consent exists would answer for today. The store's predicate is
 * `status = 'granted' AND (expires_at IS NULL OR expires_at > atIso)` — an `expired` row is NOT a
 * revocation (§2.2.8 keeps the two apart because a coercion review reads exactly that difference), but it
 * is equally not permission to dial.
 */
export async function readEmergencyContact(
  store: SafetySeamStore,
  input: {
    readonly orgId: OrgId;
    readonly clinicianMembershipId: MembershipId;
    readonly atIso: IsoInstant;
  },
): Promise<SafetyEmergencyContactRead> {
  try {
    const facts = await store.emergencyContactConsent(input.clinicianMembershipId, input.atIso);
    return facts === null ? { kind: "absent" } : emergencyContactReadFrom(facts);
  } catch (error) {
    return {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : "emergency-contact consent read failed",
    };
  }
}

/**
 * The boolean the §2.2.2 machine takes (`emergencyContactConsent` on the terminus input,
 * ../lifecycle/sos-alert).
 *
 * ONLY `granted` IS TRUE. `unavailable` maps to false, which is the same VALUE as `absent` and a
 * different FACT — the caller keeps the three-valued read for the ledger entry and passes this boolean to
 * the machine, which needs to know only whether a dial is authorized. Mapping `unavailable` to true would
 * authorize a call to a number nobody confirmed consent for.
 */
export function emergencyContactConsentPresent(read: SafetyEmergencyContactRead): boolean {
  return read.kind === "granted";
}
