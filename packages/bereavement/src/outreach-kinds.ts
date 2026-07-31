// @wardenx/bereavement — §2.5 / D15 per-kind outreach requirements (M16-T01 domain layout).
//
// Which touchpoint modalities are M8 encounters, which are direct M16 writes, which produce an M22
// artifact, and how the D4 tenant-tighten rule ranks them. PURE DATA — no IO, `@wardenx/types`-only.

import type { BereavementOutreachKind } from "@wardenx/types";

/**
 * D15 — the ONLY kind whose completion is backed by an M8 encounter. In-person bereavement visits carry
 * clinical narrative and belong in M8; letters, cards, calls, email and portal messages are rendering and
 * contact-log content, and routing them through M8 would drown its HearthNote template engine for no gain.
 * The DB encodes both directions as CHECKs on `bereavement_contact_log` (`in_person_visit` ⇒
 * `source_encounter_id IS NOT NULL`, every other kind ⇒ `IS NULL`).
 */
export const ENCOUNTER_BACKED_OUTREACH_KINDS: readonly BereavementOutreachKind[] = [
  "in_person_visit",
] as const;

/** D15 — true when completing this kind REQUIRES a `source_encounter_id`. */
export function requiresSourceEncounter(kind: BereavementOutreachKind): boolean {
  return ENCOUNTER_BACKED_OUTREACH_KINDS.includes(kind);
}

/**
 * D14 — the kinds that hand off to M22 for rendering via `m16.bereavement.outreach_artifact_requested`.
 * `external_referral` is here because §7.7 renders the referral letter from the M40 external-resource
 * choice; `group_support_invitation` is a rendered invitation rather than a live conversation.
 */
export const ARTIFACT_RENDERING_OUTREACH_KINDS: readonly BereavementOutreachKind[] = [
  "sympathy_card",
  "sympathy_letter",
  "anniversary_letter",
  "group_support_invitation",
  "external_referral",
] as const;

/** D14 — true when the kind's completion path runs through the M22 render handshake. */
export function requiresArtifactRender(kind: BereavementOutreachKind): boolean {
  return ARTIFACT_RENDERING_OUTREACH_KINDS.includes(kind);
}

/**
 * §4.5 — the three kinds M22's `m22.document.rendered` callback may auto-complete. The other two rendering
 * kinds do NOT auto-complete: an invitation is only fulfilled when the family responds, and a referral is
 * only fulfilled when the counselor confirms the hand-off landed.
 */
export const AUTO_COMPLETE_ON_RENDER_KINDS: readonly BereavementOutreachKind[] = [
  "sympathy_card",
  "sympathy_letter",
  "anniversary_letter",
] as const;

/**
 * D4 — the modality ladder. A tenant may TIGHTEN by converting a floor item to a HIGHER-touch modality
 * (mail a card → make a call → visit in person); it may never convert downward, which is how "tenant may
 * tighten, never loosen" is enforced for the modality dimension. Higher number = higher touch.
 */
export const OUTREACH_MODALITY_RANK: { readonly [K in BereavementOutreachKind]: number } = {
  portal_message: 1,
  email: 2,
  sympathy_card: 3,
  sympathy_letter: 4,
  anniversary_letter: 4,
  group_support_invitation: 5,
  external_referral: 5,
  phone_call: 6,
  in_person_visit: 7,
} as const;

/** D4 — whether replacing a platform-floor modality with a tenant-chosen one is a permitted tighten. */
export function isPermittedModalitySubstitution(
  floorKind: BereavementOutreachKind,
  tenantKind: BereavementOutreachKind,
): boolean {
  return OUTREACH_MODALITY_RANK[tenantKind] >= OUTREACH_MODALITY_RANK[floorKind];
}
