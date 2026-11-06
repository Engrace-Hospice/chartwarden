// apps/backend/src/modules/16-bereavement/mailings/eligibility.ts — ADR-0109 D10: may this contact receive THIS mailing, and by which channel?
//
// PURE. It is run twice for every recipient: when the run is generated (it selects the batch) and again at `confirm-mailed` (it re-checks
// the people already rendered into the PDF: an opt-out recorded between render and mailing must stop the piece from going out).
//
// It reads the contact's OPT-OUT ROWS, not the contact's status. The status enum has no partial value, so a `channel_specific` opt-out (calls only)
// moves a contact to `opted_out`; reading the status would then drop a family from the newsletter for declining the phone. The rows say what was
// actually declined:
//   full / pause_temporarily  block every mailing;       no_mailings  blocks every mailing (calls continue);
//   channel_specific          blocks ONLY the channels it names (a mailed piece when it names a mailed kind, email when it names `email`).
// The status is consulted for one thing only: a contact who is not (or is no longer) a person the program writes to: not yet confirmed
// (`proposed`: no consent has been verified, D6), `deceased`, or `ineligible_post_review` (a complicated-grief referral ended the program for them).
//
// CHANNEL. A contact is reached by post unless their stated preference leaves it out: stated `allowed_kinds` that name email and NO mailed kind
// make email the PREFERRED channel; stated kinds that name neither leave no channel (`channel_not_allowed`); no stated preference means post.
// Email is used only when preferred AND an address is stored AND the tenant has an email channel (it is NOT built yet: the M36 transactional
// transport is documented as a no-PHI, pre-org link transport with no delivery record, so `emailChannelAvailable` is false in production today and
// an email-preferring contact is excluded with `email_channel_unavailable` rather than silently mailed on paper against their preference).
import { isMailingOutreachKind } from "@chartwarden/bereavement";
import type {
  BereavedContactRelationship,
  BereavedContactStatus,
  BereavementMailingChannel,
  BereavementMailingExclusionReason,
  BereavementOptOutKind,
  BereavementOutreachKind,
  BereavementPlanStatus,
} from "@chartwarden/types";

/** One OPEN (not rescinded) opt-out row of the contact. */
export interface OpenOptOutFact {
  readonly optOutKind: BereavementOptOutKind;
  /** `bereavement_opt_out.channel_kinds`: the outreach kinds a `channel_specific` row declines; null / empty otherwise. */
  readonly channelKinds: readonly string[] | null;
}

export interface MailingEligibilityFacts {
  readonly planStatus: BereavementPlanStatus;
  readonly contactStatus: BereavedContactStatus;
  readonly relationship: BereavedContactRelationship;
  readonly openOptOuts: readonly OpenOptOutFact[];
  /** `outreach_preferences_jsonb.allowed_kinds`; undefined / empty is "no stated preference". */
  readonly allowedKinds: readonly BereavementOutreachKind[] | undefined;
  readonly hasMailingAddress: boolean;
  readonly hasEmailAddress: boolean;
  /** The run's audience filter (`audience_relationships`); null = every relationship. */
  readonly audience: readonly BereavedContactRelationship[] | null;
  /** Is an email channel bound for this tenant? False today: see the file header. */
  readonly emailChannelAvailable: boolean;
}

export type MailingEligibilityDecision =
  | { readonly eligible: true; readonly channel: BereavementMailingChannel }
  | { readonly eligible: false; readonly reason: BereavementMailingExclusionReason };

/** The contact statuses the program does not write to (everything else is decided by the opt-out rows). */
const NOT_ENGAGEABLE: ReadonlySet<BereavedContactStatus> = new Set([
  "proposed",
  "deceased",
  "ineligible_post_review",
]);

const out = (reason: BereavementMailingExclusionReason): MailingEligibilityDecision => ({
  eligible: false,
  reason,
});

/** Does the contact's stated preference reach them by post? (No stated preference = yes.) */
function postalAllowed(allowed: readonly BereavementOutreachKind[] | undefined): boolean {
  if (allowed === undefined || allowed.length === 0) return true;
  return allowed.some((kind) => isMailingOutreachKind(kind));
}

/** The contact's preferred channel, or null when the stated preference leaves neither a mailed piece nor email. */
export function preferredMailingChannel(
  allowed: readonly BereavementOutreachKind[] | undefined,
): BereavementMailingChannel | null {
  if (postalAllowed(allowed)) return "postal";
  return allowed?.includes("email") ? "email" : null;
}

/** Does a `channel_specific` row decline this channel? A mailed kind declines post; `email` declines email. */
function declinesChannel(row: OpenOptOutFact, channel: BereavementMailingChannel): boolean {
  if (row.optOutKind !== "channel_specific") return false;
  const named = row.channelKinds ?? [];
  return channel === "postal"
    ? named.some((kind) => isMailingOutreachKind(kind as BereavementOutreachKind))
    : named.includes("email");
}

export function decideMailingEligibility(facts: MailingEligibilityFacts): MailingEligibilityDecision {
  if (facts.planStatus !== "active") return out("plan_not_active");
  if (NOT_ENGAGEABLE.has(facts.contactStatus)) return out("contact_not_engageable");
  if (facts.audience !== null && !facts.audience.includes(facts.relationship)) {
    return out("not_in_audience");
  }
  if (facts.openOptOuts.some((o) => o.optOutKind === "no_mailings")) return out("no_mailings");
  if (
    facts.openOptOuts.some((o) => o.optOutKind === "full" || o.optOutKind === "pause_temporarily")
  ) {
    return out("opted_out");
  }

  const channel = preferredMailingChannel(facts.allowedKinds);
  if (channel === null) return out("channel_not_allowed");
  if (facts.openOptOuts.some((o) => declinesChannel(o, channel))) return out("channel_opted_out");

  if (channel === "postal") {
    return facts.hasMailingAddress ? { eligible: true, channel } : out("no_mailing_address");
  }
  if (!facts.emailChannelAvailable) return out("email_channel_unavailable");
  return facts.hasEmailAddress ? { eligible: true, channel } : out("no_email_address");
}
