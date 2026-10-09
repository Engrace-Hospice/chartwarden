import { TransportError } from "./transports";
import type { OutOfBandTransport } from "./transports";
// @wardenx/messaging — Postmark alert-email transport (M36 GAP-062, spec §4.4 / §4.7).
//
// The OUT-OF-BAND alert path (`messaging.send_email`): a sanitized notification, never a body. Distinct from
// `createPostmarkTransactionalEmailTransport` (auth/invite emails, void return): the delivery sweep needs the
// Postmark `MessageID` back so the signed `/webhooks/postmark/event` callback can reconcile `delivered | bounced`
// against it, and it must NOT retry internally (the sweep owns retry + backoff).
import { type VendorFetch, postToVendor } from "./vendor-http";

export const POSTMARK_ALERT_DEFAULT_BASE_URL = "https://api.postmarkapp.com";
const ALERT_SUBJECT = "WardenX notification";

export interface PostmarkAlertEmailOptions {
  readonly serverToken: string;
  /** A From address with a verified sender signature / domain in Postmark. */
  readonly from: string;
  readonly messageStream?: string;
  readonly baseUrl?: string;
  readonly fetch?: VendorFetch;
  readonly timeoutMs?: number;
}

/** Send one email through Postmark and return its MessageID. Shared with the endpoint-verification sender. */
export async function sendPostmarkEmail(
  opts: PostmarkAlertEmailOptions,
  input: { readonly to: string; readonly subject: string; readonly text: string },
): Promise<string> {
  const base = (opts.baseUrl ?? POSTMARK_ALERT_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const res = await postToVendor({
    vendor: "postmark",
    url: `${base}/email`,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": opts.serverToken,
    },
    body: JSON.stringify({
      From: opts.from,
      To: input.to,
      Subject: input.subject,
      TextBody: input.text,
      ...(opts.messageStream ? { MessageStream: opts.messageStream } : {}),
      // No open/click tracking: the deep link must not be rewritten through a third-party redirect.
      TrackOpens: false,
      TrackLinks: "None",
    }),
    fetch: opts.fetch ?? ((url, init) => fetch(url, init)),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  const messageId = res.json?.MessageID;
  const errorCode = res.json?.ErrorCode;
  if (
    typeof messageId !== "string" ||
    messageId.length === 0 ||
    (errorCode !== undefined && errorCode !== 0)
  ) {
    throw new TransportError("postmark_invalid_response", false);
  }
  return messageId;
}

export function createPostmarkAlertEmailTransport(
  opts: PostmarkAlertEmailOptions,
): OutOfBandTransport {
  return {
    async send({ notification, destination }) {
      const vendorMessageId = await sendPostmarkEmail(opts, {
        to: destination,
        subject: ALERT_SUBJECT,
        text: `${notification.short}\n\n${notification.deepLink}`,
      });
      return { vendorMessageId, settlesOnAcceptance: false };
    },
  };
}
