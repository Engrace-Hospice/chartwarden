// @wardenx/messaging — Twilio SMS + Voice transports (M36 GAP-062, spec §4.4 / §4.7).
//
// SMS  -> `POST /2010-04-01/Accounts/{sid}/Messages.json`   (vendorMessageId = the message SID)
// Voice-> `POST /2010-04-01/Accounts/{sid}/Calls.json`      (vendorMessageId = the call SID) — the Tier-1 SOS page.
//
// Only a {@link SanitizedNotification} reaches the vendor (§4.7): a generic line and a content-free deep link
// for SMS, the fixed voice script for a call. `StatusCallback` points at the §4.9 webhooks the backend already
// mounts, which reconcile `sent -> delivered | failed` against the SID returned here. Neither SMS nor voice
// settles on acceptance: `delivered` comes from the signed callback.
//
// Credentials arrive as constructor arguments (the composition root reads env); they are used only to build the
// Basic auth header and never appear in a thrown reason.
import { renderOutOfBand } from "../notification/sanitize";
import type { OutOfBandTransport } from "./transports";
import { TransportError } from "./transports";
import { type VendorFetch, postToVendor } from "./vendor-http";

export const TWILIO_DEFAULT_BASE_URL = "https://api.twilio.com";

/** Where Twilio sends the From identity: a verified number or a Messaging Service (SMS only). */
export type TwilioSender =
  | { readonly kind: "number"; readonly from: string }
  | { readonly kind: "messaging_service"; readonly messagingServiceSid: string };

interface TwilioBase {
  readonly accountSid: string;
  readonly authToken: string;
  readonly baseUrl?: string;
  readonly fetch?: VendorFetch;
  readonly timeoutMs?: number;
}

export interface TwilioSmsOptions extends TwilioBase {
  readonly sender: TwilioSender;
  /** Absolute URL of `/webhooks/twilio/sms-status` (public origin). Omitted => no delivery callback. */
  readonly statusCallbackUrl?: string;
}

export interface TwilioVoiceOptions extends TwilioBase {
  /** A Twilio voice-capable number in E.164. */
  readonly from: string;
  readonly statusCallbackUrl?: string;
}

function basicAuth(sid: string, token: string): string {
  return `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function twilioPost(
  opts: TwilioBase,
  resource: "Messages" | "Calls",
  form: URLSearchParams,
): Promise<string> {
  const base = (opts.baseUrl ?? TWILIO_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const res = await postToVendor({
    vendor: "twilio",
    url: `${base}/2010-04-01/Accounts/${encodeURIComponent(opts.accountSid)}/${resource}.json`,
    headers: {
      Authorization: basicAuth(opts.accountSid, opts.authToken),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
    fetch: opts.fetch ?? ((url, init) => fetch(url, init)),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  const sid = res.json?.sid;
  // A 2xx without a SID cannot be reconciled by the callback; treat as a terminal vendor fault, not success.
  if (typeof sid !== "string" || sid.length === 0) {
    throw new TransportError("twilio_invalid_response", false);
  }
  return sid;
}

/**
 * Send one SMS through Twilio and return the message SID. Exposed (not only wrapped in a transport) so the
 * §4.2 endpoint-verification code can use the same authenticated path with its own fixed text.
 */
export async function sendTwilioSms(
  opts: TwilioSmsOptions,
  input: { readonly to: string; readonly text: string },
): Promise<string> {
  const form = new URLSearchParams();
  form.set("To", input.to);
  form.set("Body", input.text);
  if (opts.sender.kind === "number") form.set("From", opts.sender.from);
  else form.set("MessagingServiceSid", opts.sender.messagingServiceSid);
  if (opts.statusCallbackUrl) form.set("StatusCallback", opts.statusCallbackUrl);
  return twilioPost(opts, "Messages", form);
}

export function createTwilioSmsTransport(opts: TwilioSmsOptions): OutOfBandTransport {
  return {
    async send({ notification, destination }) {
      const vendorMessageId = await sendTwilioSms(opts, {
        to: destination,
        text: renderOutOfBand(notification, "sms").body,
      });
      return { vendorMessageId, settlesOnAcceptance: false };
    },
  };
}

export function createTwilioVoiceTransport(opts: TwilioVoiceOptions): OutOfBandTransport {
  return {
    async send({ notification, destination }) {
      const form = new URLSearchParams();
      form.set("To", destination);
      form.set("From", opts.from);
      // The sanitized `short` for the voice channel IS the fixed script (§4.7) — spoken twice so a clipped
      // pickup still hears it. No name, location or patient detail exists on the notification to speak.
      const line = xmlEscape(renderOutOfBand(notification, "voice").body);
      form.set(
        "Twiml",
        `<Response><Say>${line}</Say><Pause length="1"/><Say>${line}</Say></Response>`,
      );
      if (opts.statusCallbackUrl) form.set("StatusCallback", opts.statusCallbackUrl);
      const vendorMessageId = await twilioPost(opts, "Calls", form);
      return { vendorMessageId, settlesOnAcceptance: false };
    },
  };
}
