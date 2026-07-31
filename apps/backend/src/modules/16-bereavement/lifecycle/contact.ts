// apps/backend/src/modules/16-bereavement/lifecycle/contact.ts — M16-T03 (§2.3).
//
// The `bereaved_contact` lifecycle: proposed → active, with the four ways a survivor leaves the program
// (opted out, deceased, unreachable, referred out for complicated grief) and the three ways back in. The
// contact — not the plan — is the operational unit: consent, opt-out and the schedule are all per-contact,
// and §2.3 is explicit that a per-contact closure does NOT close the plan unless it leaves the roster with
// nobody who opted IN (the D6 evaluation lives on the plan machine).
//
// D9's two levels are distinct and both live here: the M31 portal self-service opt-out and its 90-day
// rescind window, and the §2.6 M39 revocation CASCADE where M39 is the source of truth and M16 only
// follows. The cascade path is not a second policy — it is the same `optOut` transition with
// `source='m39_revocation_cascade'`, which is why the audit story reads the same for both.
import {
  UNREACHABLE_CONSECUTIVE_NO_RESPONSE_THRESHOLD,
  isWithinOptOutRescindWindow,
} from "@wardenx/bereavement";
import type {
  BereavedContactStatus,
  BereavementOptOutKind,
  BereavementOptOutSourceKind,
  ExternalGriefResourceId,
  IsoInstant,
} from "@wardenx/types";
import { type BereavementTransitionResult, result } from "./effects";
import { BereavementStateError, require_ } from "./errors";

/** The §2.3 per-bereaved-person states (mirrors `bereaved_contact_status`). */
export type BereavedContactLifecycleState = BereavedContactStatus;

/** The §2.3 per-contact events. */
export type BereavedContactEvent =
  | {
      /** §2.3 — consent verified, or the contact is the primary caregiver whose M5 `family_caregiver_access`
       *  consent at time of death covers post-death engagement (D9). */
      readonly type: "confirmContact";
      readonly at: IsoInstant;
      readonly hasBereavementOutreachConsent: boolean;
      readonly isPrimaryCaregiverWithFamilyAccess: boolean;
    }
  | {
      readonly type: "optOut";
      readonly at: IsoInstant;
      readonly optOutKind: BereavementOptOutKind;
      readonly source: BereavementOptOutSourceKind;
      readonly reason: string;
      /** Required iff `optOutKind = 'channel_specific'` (§3.3.8). */
      readonly channelKinds?: ReadonlyArray<string>;
    }
  | {
      readonly type: "rescindOptOut";
      readonly at: IsoInstant;
      /** The instant the OPEN opt-out row recorded — the D9 90-day window counts from here. */
      readonly optedOutAt: IsoInstant;
      /** A counselor rescind with a documented reason is not bound by the self-service window (§2.3). */
      readonly byCounselor: boolean;
    }
  | {
      readonly type: "markDeceased";
      readonly at: IsoInstant;
      /** §2.3 — the death must be VERIFIED: a date and where it came from, both captured. */
      readonly deathVerified: boolean;
    }
  | {
      readonly type: "markUnreachable";
      readonly at: IsoInstant;
      /** Consecutive `bereavement_contact_log.outcome='no_response'` rows behind the proposal. */
      readonly consecutiveNoResponseCount: number;
    }
  | {
      readonly type: "rescindUnreachable";
      readonly at: IsoInstant;
    }
  | {
      /** §7.7 — complicated grief / suicidal ideation. The M16 program ENDS for this contact and the
       *  survivor is routed to the M40 external mental-health resource. */
      readonly type: "flagComplicatedGrief";
      readonly at: IsoInstant;
      readonly externalResourceId: ExternalGriefResourceId | null;
    }
  | {
      readonly type: "clinicalReevaluation";
      readonly at: IsoInstant;
    };

export type BereavedContactTransition = BereavementTransitionResult<
  BereavedContactLifecycleState,
  BereavedContactEvent["type"]
>;

/** The legal §2.3 transition graph (from → events accepted). `deceased` is the only terminal state: a
 *  survivor who died cannot re-enter the program, while every other exit has a documented way back. */
export const BEREAVED_CONTACT_GRAPH: Readonly<
  Record<BereavedContactLifecycleState, ReadonlyArray<BereavedContactEvent["type"]>>
> = {
  proposed: ["confirmContact"],
  active: [
    "optOut",
    "markDeceased",
    "markUnreachable",
    "flagComplicatedGrief",
  ],
  opted_out: ["rescindOptOut"],
  unreachable: ["rescindUnreachable"],
  ineligible_post_review: ["clinicalReevaluation"],
  deceased: [],
};

/** The result of the `[*] → proposed` insert (§2.3 `createContact`). */
export interface BereavedContactCreation {
  readonly status: "proposed";
  readonly effects: BereavedContactTransition["effects"];
}

/**
 * The `[*] → proposed` factory (§2.3). `relationshipInValueSet` is M38's answer for the submitted
 * `relationship_code` (§2.5); a code M38 does not know is refused rather than stored, because the
 * relationship drives both the D3 rubric's ambivalence factor and the M28 FHIR `RelatedPerson` projection.
 *
 * No outbox event: a proposed contact is not yet part of the program — `contact_active` fires on confirm.
 */
export function createBereavedContact(relationshipInValueSet: boolean): BereavedContactCreation {
  require_(
    relationshipInValueSet,
    "RELATIONSHIP_NOT_IN_VALUE_SET",
    "the relationship code is not in the M38 relationship-to-decedent value set",
  );
  return { status: "proposed", effects: [{ kind: "audit" }] };
}

/** Apply a `bereaved_contact` event (§2.3). Throws `ILLEGAL_TRANSITION` if not accepted. */
export function transitionBereavedContact(
  from: BereavedContactLifecycleState,
  event: BereavedContactEvent,
): BereavedContactTransition {
  if (!BEREAVED_CONTACT_GRAPH[from].includes(event.type)) {
    throw new BereavementStateError(
      "ILLEGAL_TRANSITION",
      `bereaved contact cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "confirmContact": {
      // §2.3 / D9 — either an explicit M39 `bereavement_outreach_consent`, or the primary caregiver whose
      // living-patient family-access consent covers post-death engagement. FAIL-CLOSED: neither means no
      // outreach, because an unconsented condolence call to a grieving family is the harm the rule exists
      // to prevent.
      require_(
        event.hasBereavementOutreachConsent || event.isPrimaryCaregiverWithFamilyAccess,
        "BEREAVEMENT_CONSENT_REQUIRED",
        "confirming a bereaved contact needs an active M39 bereavement-outreach consent",
      );
      return result(from, event.type, "active", [
        { kind: "set_timestamp", field: "confirmed_at", at: event.at },
        { kind: "recompute_risk", scope: "contact" },
        { kind: "audit" },
        { kind: "outbox", event: "m16.bereavement.contact_active" },
      ]);
    }
    case "optOut": {
      require_(
        event.reason.trim().length > 0,
        "OPT_OUT_REASON_REQUIRED",
        "an opt-out must record the reason given",
      );
      require_(
        event.optOutKind !== "channel_specific" || (event.channelKinds?.length ?? 0) > 0,
        "OPT_OUT_CHANNEL_KINDS_REQUIRED",
        "a channel-specific opt-out must name the channels being declined",
      );
      // NOTE: a `channel_specific` opt-out still moves the contact to `opted_out` here because the STATUS
      // enum has no partial value; the surviving channels are restored by the schedule regeneration, which
      // reads `bereavement_opt_out.channel_kinds`. The alternative — leaving the contact `active` — would
      // make the D6 all-opted-out evaluation silently miss it.
      return result(from, event.type, "opted_out", [
        { kind: "set_timestamp", field: "opted_out_at", at: event.at },
        { kind: "insert_opt_out", optOutKind: event.optOutKind, source: event.source },
        { kind: "cancel_future_outreach", scope: "contact" },
        { kind: "audit" },
        { kind: "outbox", event: "m16.bereavement.contact_opted_out" },
        ...(event.source === "m39_revocation_cascade"
          ? ([{ kind: "alert", alert: "consent_revoked_cascade" }] as const)
          : []),
      ]);
    }
    case "rescindOptOut": {
      // D9 — the portal self-service window is 90 days. A counselor rescind with a documented reason is
      // NOT bound by it (§2.3), because a survivor who calls back at month 5 asking to re-enrol should not
      // be told the software forgot how.
      require_(
        event.byCounselor || isWithinOptOutRescindWindow(event.optedOutAt, event.at),
        "OPT_OUT_RESCIND_WINDOW_EXPIRED",
        "the 90-day self-service opt-out rescind window has passed",
      );
      return result(from, event.type, "active", [
        { kind: "rescind_opt_out", at: event.at },
        { kind: "regenerate_schedule", fromIso: event.at, scope: "contact" },
        { kind: "audit" },
        { kind: "outbox", event: "m16.bereavement.contact_opt_out_rescinded" },
      ]);
    }
    case "markDeceased": {
      require_(
        event.deathVerified,
        "CONTACT_DEATH_VERIFICATION_REQUIRED",
        "marking a bereaved contact deceased requires a verified date + source",
      );
      return result(from, event.type, "deceased", [
        { kind: "set_timestamp", field: "deceased_at", at: event.at },
        { kind: "cancel_future_outreach", scope: "contact" },
        { kind: "audit" },
        { kind: "outbox", event: "m16.bereavement.contact_deceased" },
      ]);
    }
    case "markUnreachable": {
      // §2.3 — the nightly detector PROPOSES at 3 strikes; the counselor decides. The threshold is a guard
      // on the transition, so a UI that fires it early is refused rather than silently trusted.
      require_(
        event.consecutiveNoResponseCount >= UNREACHABLE_CONSECUTIVE_NO_RESPONSE_THRESHOLD,
        "UNREACHABLE_THRESHOLD_NOT_MET",
        `marking unreachable needs ${UNREACHABLE_CONSECUTIVE_NO_RESPONSE_THRESHOLD} consecutive no-response touchpoints`,
      );
      return result(from, event.type, "unreachable", [
        { kind: "set_timestamp", field: "unreachable_at", at: event.at },
        { kind: "audit" },
        { kind: "outbox", event: "m16.bereavement.contact_unreachable" },
        { kind: "alert", alert: "contact_unreachable" },
      ]);
    }
    case "rescindUnreachable": {
      return result(from, event.type, "active", [
        { kind: "regenerate_schedule", fromIso: event.at, scope: "contact" },
        { kind: "audit" },
      ]);
    }
    case "flagComplicatedGrief": {
      // §7.7 — the referral must name WHERE the survivor was routed. "Referred to external services"
      // without a resource is a dead end for someone in crisis, so the id is required rather than optional.
      require_(
        event.externalResourceId !== null,
        "EXTERNAL_GRIEF_RESOURCE_REQUIRED",
        "a complicated-grief referral must name the M40 external resource it routes to",
      );
      return result(from, event.type, "ineligible_post_review", [
        { kind: "set_timestamp", field: "ineligible_at", at: event.at },
        { kind: "log_external_referral", externalResourceId: event.externalResourceId as string },
        { kind: "cancel_future_outreach", scope: "contact" },
        { kind: "audit" },
        { kind: "outbox", event: "m16.bereavement.contact_referred_external" },
        { kind: "alert", alert: "complicated_grief_referral" },
      ]);
    }
    case "clinicalReevaluation": {
      return result(from, event.type, "active", [
        { kind: "regenerate_schedule", fromIso: event.at, scope: "contact" },
        { kind: "recompute_risk", scope: "contact" },
        { kind: "audit" },
      ]);
    }
  }
}
