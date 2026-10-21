// @chartwarden/messaging — the PHI sanitization wrapper (M36-T06, spec §4.7 / §7.2).
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

/** Every out-of-band channel, for exhaustive tests and the render table. */
export const OUT_OF_BAND_CHANNELS: readonly OutOfBandChannel[] = ["sms", "email", "push", "voice"];

/**
 * WP 4.7 provenance: only the two sanitizers below mint a notification, and they register it here together with
 * the channels its text is valid for. The renderer ({@link renderOutOfBand}) trusts a notification only for those
 * channels, so a hand-built object, a spread copy with a swapped `short`, or the SOS call script handed to a
 * push/SMS/email transport can never put its own text on a lock screen. Module-private.
 */
const issuedNotifications = new WeakMap<object, ReadonlySet<OutOfBandChannel>>();

function issue(
  n: SanitizedNotification,
  channels: readonly OutOfBandChannel[],
): SanitizedNotification {
  const frozen = Object.freeze(n);
  issuedNotifications.set(frozen, new Set(channels));
  return frozen;
}

/** Stable, content-free reason codes for a generic-wording fallback (log / metric keys). */
export type OutOfBandFallbackReason = "unissued_notification" | "channel_not_bound";

export interface OutOfBandFallbackEvent {
  readonly reason: OutOfBandFallbackReason;
  readonly channel: OutOfBandChannel;
}

let fallbackObserver: ((event: OutOfBandFallbackEvent) => void) | undefined;

/** Install (or clear) the observer called whenever the renderer substitutes generic wording. It receives a
 *  reason code and the channel only - never text, ids or recipients. A throwing observer is ignored. */
export function setOutOfBandFallbackObserver(
  observer: ((event: OutOfBandFallbackEvent) => void) | undefined,
): void {
  fallbackObserver = observer;
}

/** SMS hard cap (§4.7) — the `short` is truncated to fit one segment with the signed deep link. */
const SMS_MAX_CHARS = 160;

/** The fixed voice script (§4.7) — a pre-recorded text-to-speech line, never PHI. */
const VOICE_SCRIPT = "ChartWarden field safety alert. Please open the app.";

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
  return issue(
    {
      notificationDeliveryId: input.idempotencyKey,
      short: [
        `This is an automated safety call from ${agency}. ${subject} listed you as an emergency contact,`,
        "and a safety alert they raised has not been answered. Please try to reach them now.",
        "If you cannot reach them and you are concerned for their safety, contact your local emergency services.",
        "This call does not involve any patient.",
      ].join(" "),
      deepLink: "",
    },
    ["voice"],
  );
}

/** The one generic line (WP 4.7). Names no patient, no clinical content and no sender; the link, when
 *  present, is appended by the renderer and opens only inside an authenticated session. */
const GENERIC_SHORT = "You have a new notification in ChartWarden. Sign in to view.";
const URGENT_SHORT = "You have a new urgent request in ChartWarden. Sign in to view.";
const SAFETY_SHORT = "ChartWarden safety alert. Sign in to view.";
const MESSAGE_SHORT = "You have a new message in ChartWarden. Sign in to view.";

/** Generic, PHI-free `short` per alert category (§4.7: "no category specifics beyond the generic short").
 *  Urgency level is the only thing a category may add; it identifies no one. */
const CATEGORY_SHORT: { readonly [C in AlertCategory]: string } = {
  clinical_urgent: URGENT_SHORT,
  clinical_routine: GENERIC_SHORT,
  operational: GENERIC_SHORT,
  field_safety: SAFETY_SHORT,
  administrative: GENERIC_SHORT,
  system: GENERIC_SHORT,
};

/** Truncate to the SMS segment limit without splitting awkwardly past the cap. */
function clampForSms(short: string): string {
  return short.length <= SMS_MAX_CHARS ? short : `${short.slice(0, SMS_MAX_CHARS - 1)}…`;
}

/** An opaque delivery id: letters, digits, `-` and `_` only. Anything else (a name, a path, a query) is refused. */
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Content-free deep link: a single opaque `notification_delivery` id under the app's authed notification
 * route. Carries NO patient/channel/message identifier and no token (§4.7). Returns "" - never a partial or
 * rewritten link - when the base is not a plain http(s) origin (no credentials, query or fragment) or the id is
 * not opaque; the wording ("Sign in to view.") stands on its own without it.
 */
function deepLinkFor(baseUrl: string, notificationDeliveryId: string): string {
  if (!OPAQUE_ID.test(notificationDeliveryId)) return "";
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return "";
  }
  const plain =
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "";
  if (!plain) return "";
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/n/${notificationDeliveryId}`;
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

  return issue(
    {
      notificationDeliveryId,
      short,
      deepLink: deepLinkFor(baseUrl, notificationDeliveryId),
    },
    OUT_OF_BAND_CHANNELS,
  );
}

/** What a vendor transport puts on the wire, per channel. Every field is generic or opaque. */
export interface RenderedOutOfBand {
  /** Push title (a constant). */
  readonly title: string;
  /** Email subject (a constant). */
  readonly subject: string;
  /** SMS body, email text, push body or spoken line. */
  readonly body: string;
  /** The deep link, or "" when none is safe. Already included in `body` where the channel shows one. */
  readonly link: string;
  /** The delivery id for vendor correlation, or "" when it is not opaque. */
  readonly id: string;
}

const PUSH_TITLE = "ChartWarden";
const EMAIL_SUBJECT = "ChartWarden notification";

/**
 * WP 4.7 render-time guard: the ONLY place out-of-band subject / title / body text is composed. A notification
 * that did not come out of a sanitizer above for this channel (hand-built, a modified copy, or minted for another channel) is replaced by the generic wording
 * and no link, so a future caller, template or payload field cannot leak. Never throws and never drops the send:
 * the fallback is still a deliverable alert.
 */
export function renderOutOfBand(
  notification: SanitizedNotification,
  channel: OutOfBandChannel,
): RenderedOutOfBand {
  const bound = issuedNotifications.get(notification);
  const proven = bound?.has(channel) === true;
  if (!proven) {
    try {
      fallbackObserver?.({
        reason: bound === undefined ? "unissued_notification" : "channel_not_bound",
        channel,
      });
    } catch {
      // an observer must never break a send
    }
  }
  const short = proven ? notification.short : channel === "voice" ? VOICE_SCRIPT : GENERIC_SHORT;
  const link = proven ? notification.deepLink : "";
  const id =
    proven && OPAQUE_ID.test(notification.notificationDeliveryId)
      ? notification.notificationDeliveryId
      : "";
  const withLink = link === "" ? short : `${short} ${link}`;
  const body =
    channel === "sms"
      ? withLink.length <= SMS_MAX_CHARS
        ? withLink
        : clampForSms(short)
      : channel === "email"
        ? link === ""
          ? short
          : `${short}\n\n${link}`
        : short;
  return {
    title: PUSH_TITLE,
    subject: EMAIL_SUBJECT,
    body,
    link: channel === "sms" && body === short ? "" : link,
    id,
  };
}
