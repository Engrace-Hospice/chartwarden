// @wardenx/messaging — the PHI sanitization wrapper (M36-T06, spec §4.7 / §7.2).
//
// THE SINGLE CHOKEPOINT between in-perimeter PHI-bearing structures (`Alert` / `Message`) and
// outbound vendors (SMS / email / push / voice). Every out-of-band dispatcher MUST take its
// payload from `sanitizeForOutOfBand`'s output, never from the source emit (§4.7). The HIPAA
// constraint (no PHI in out-of-band payloads — §164.312(e), HHS SMS/email guidance) is enforced
// here AS CODE, not by per-developer discipline.
//
// SAFE BY CONSTRUCTION: the output is built from an ALLOWLIST — a content-free
// `notificationDeliveryId`, a GENERIC per-category `short`, and a content-free deep link into
// the authenticated app. The sanitizer NEVER copies a field off the input, so no message body,
// no patient name, no diagnosis, and no `phi: true`-tagged field can traverse it regardless of
// what the caller passes (§7.2 red-team fixture: PHI in every field → output is PHI-free). A
// dependency-cruiser rule (added with the vendor dispatchers, M36-T08) additionally blocks any
// direct `twilio.*` / `postmark.*` / `web-push` call outside this chokepoint.

import type { AlertCategory } from "../interfaces/kinds";

/** An in-perimeter alert as the dispatcher sees it. `payload` MAY carry PHI (patient ids,
 *  names, diagnoses, `phi: true`-tagged fields); the sanitizer never reads from it. */
export interface Alert {
  readonly kind: "alert";
  readonly alertId: string;
  /** Content-free id the vendor webhook correlates back to `notification_delivery`. */
  readonly notificationDeliveryId: string;
  readonly category: AlertCategory;
  /** Structured event payload — the in-perimeter PHI surface. NEVER traverses the sanitizer. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** An in-perimeter message as the dispatcher sees it. `body` is plaintext PHI and NEVER leaves. */
export interface Message {
  readonly kind: "message";
  readonly messageId: string;
  readonly notificationDeliveryId: string;
  readonly channelId: string;
  /** Decrypted plaintext body — PHI. Present so the type mirrors the in-perimeter struct; the
   *  sanitizer ignores it entirely. */
  readonly body: string;
}

/** The ONLY shape that may cross to an out-of-band vendor (§4.7). No body, no patient
 *  identifiers, no category specifics beyond the generic `short`. */
export interface SanitizedNotification {
  /** For vendor webhook correlation — content-free. */
  readonly notificationDeliveryId: string;
  /** One generic line. Never names a patient, a diagnosis, or message content. */
  readonly short: string;
  /** Authenticated app URL; opens inside the recipient's session. Content-free. */
  readonly deepLink: string;
}

/** The out-of-band transports (§4.7). `voice` is SOS-only at the routing layer (§2.5); its
 *  spoken script here is a fixed string that never speaks a name or a location. */
export type OutOfBandChannel = "sms" | "email" | "push" | "voice";

/** SMS hard cap (§4.7) — the `short` is truncated to fit one segment with the signed deep link. */
const SMS_MAX_CHARS = 160;

/** The fixed voice script (§4.7) — a pre-recorded text-to-speech line, never PHI. */
const VOICE_SCRIPT = "WardenX field safety alert. Please open the app.";

// ── GAP-032: the SOS terminus emergency-contact call (spec §4.7 amendment) ─────────────────────────────
//
// The fixed voice script above never speaks a name. This is the one deliberate exception: an automated safety
// call to a clinician's CONSENTED emergency contact (a third party), which is useless if it cannot say who is
// calling about whom. It is its own function with a fixed template and an allowlist of exactly two
// variables - the agency name and the clinician's display name (D10 consent covers both). No patient,
// location, coordinate or alert id has a parameter, so none can be spoken. The names are cleaned to a
// conservative character set and capped; the Twilio transport XML-escapes the result.

const CONTACT_CALL_NAME_MAX = 80;
const CONTACT_CALL_NAME_DISALLOWED = /[^\p{L}\p{N} .,'&-]/gu;
const CONTACT_CALL_AGENCY_FALLBACK = "your home health agency";
const CONTACT_CALL_SUBJECT_FALLBACK = "a member of the care team";

function cleanSpokenName(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(CONTACT_CALL_NAME_DISALLOWED, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CONTACT_CALL_NAME_MAX)
    .trim();
  return cleaned === "" ? fallback : cleaned;
}

/** The only payload that may cross to the voice vendor for the SOS emergency-contact call. */
export function sanitizeForEmergencyContactCall(input: {
  readonly idempotencyKey: string;
  readonly agencyName: string;
  readonly subjectDisplayName: string;
}): SanitizedNotification {
  const agency = cleanSpokenName(input.agencyName, CONTACT_CALL_AGENCY_FALLBACK);
  const subject = cleanSpokenName(input.subjectDisplayName, CONTACT_CALL_SUBJECT_FALLBACK);
  return {
    notificationDeliveryId: input.idempotencyKey,
    short: [
      `This is an automated safety call from ${agency}. ${subject} listed you as an emergency contact,`,
      "and a safety alert they raised has not been answered. Please try to reach them now.",
      "If you cannot reach them and you are concerned for their safety, contact your local emergency services.",
      "This call does not involve any patient.",
    ].join(" "),
    deepLink: "",
  };
}

/** Generic, PHI-free `short` per alert category (§4.7: "no category specifics beyond the
 *  generic short"). Deliberately content-free — the recipient learns only that something needs
 *  attention and follows the deep link into the authenticated app for any detail. */
const CATEGORY_SHORT: { readonly [C in AlertCategory]: string } = {
  clinical_urgent: "You have an urgent clinical alert",
  clinical_routine: "You have a new clinical alert",
  operational: "You have a new alert",
  field_safety: "Field safety alert",
  administrative: "You have a new alert",
  system: "You have a new alert",
};

/** The generic `short` for an out-of-band message notification (§4.7). */
const MESSAGE_SHORT = "You have a new message";

/** Truncate to the SMS segment limit without splitting awkwardly past the cap. */
function clampForSms(short: string): string {
  return short.length <= SMS_MAX_CHARS ? short : `${short.slice(0, SMS_MAX_CHARS - 1)}…`;
}

/** Content-free deep link: a single opaque `notification_delivery` id under the app's authed
 *  notification route. Carries NO patient/channel/message identifier (§4.7). */
function deepLinkFor(baseUrl: string, notificationDeliveryId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/n/${notificationDeliveryId}`;
}

/**
 * Sanitize an in-perimeter `Alert`/`Message` into the only payload that may cross to an
 * out-of-band vendor (§4.7). Output is constructed from an allowlist (id + generic short + deep
 * link) — never copied off the input — so it is PHI-free by construction for every category ×
 * channel (§7.2). The voice channel always speaks the fixed {@link VOICE_SCRIPT}; SMS truncates
 * the `short` to one segment.
 */
export function sanitizeForOutOfBand(input: {
  alertOrMessage: Alert | Message;
  channel: OutOfBandChannel;
  recipientUserId: string;
  baseUrl: string;
}): SanitizedNotification {
  const { alertOrMessage, channel, baseUrl } = input;
  const notificationDeliveryId = alertOrMessage.notificationDeliveryId;

  // Generic short, derived ONLY from the discriminator/category — never from payload/body.
  const baseShort =
    alertOrMessage.kind === "message" ? MESSAGE_SHORT : CATEGORY_SHORT[alertOrMessage.category];

  const short =
    channel === "voice" ? VOICE_SCRIPT : channel === "sms" ? clampForSms(baseShort) : baseShort;

  return {
    notificationDeliveryId,
    short,
    deepLink: deepLinkFor(baseUrl, notificationDeliveryId),
  };
}
