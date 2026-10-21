// apps/backend/src/modules/36-messaging/delivery/transport-binding.ts — GAP-062 / GAP-063: the boot-time decision
// for the out-of-band vendor transports (web-push, Twilio SMS + voice, Postmark alert email).
//
// Credentials come ONLY from env. A channel binds its real vendor adapter only when every variable it needs is
// present and well-formed; otherwise THAT channel stays on the fail-closed DENY transport (every send settles
// `failed` / `transport_not_configured`, never `pending` forever and never "sent"). Each unbound channel is named
// at boot — names of variables only, never values — and an unbound VOICE channel is called out separately because
// it is the Tier-1 SOS field-safety escalation path (spec §2.5): without it a lone-worker SOS cannot reach a phone.
//
//   Twilio  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (also the webhook signing key), MESSAGING_WEBHOOK_PUBLIC_BASE_URL
//             (the status-callback origin — without it a call/SMS could never leave `sent`),
//             SMS: TWILIO_SMS_FROM (E.164) or TWILIO_MESSAGING_SERVICE_SID; VOICE: TWILIO_VOICE_FROM (E.164)
//   Email   POSTMARK_SERVER_TOKEN, POSTMARK_FROM_ADDRESS, POSTMARK_SENDER_VERIFIED=true (same set as auth email)
//   Push    VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (base64url), VAPID_SUBJECT (mailto: or https:)
//
// The same SMS/email adapters carry the §4.2 endpoint-verification code (GAP-063) via
// {@link OutOfBandBinding.sendEndpointVerificationCode}.
import {
  type OutOfBandTransportChannel,
  type OutOfBandTransports,
  type PostmarkAlertEmailOptions,
  type TwilioSmsOptions,
  type VendorFetch,
  createDenyTransport,
  createPostmarkAlertEmailTransport,
  createTwilioSmsTransport,
  createTwilioVoiceTransport,
  createWebPushTransport,
  resolvePostmarkConfig,
  sendPostmarkEmail,
  sendTwilioSms,
} from "@wardenx/messaging";
import { WardenXError } from "@wardenx/types";

type Env = Readonly<Record<string, string | undefined>>;

export type EndpointVerificationSender = (input: {
  readonly channel: "sms" | "email" | "push";
  readonly target: string;
  readonly code: string;
}) => Promise<void>;

export interface OutOfBandBinding {
  readonly transports: OutOfBandTransports;
  /** Which channels have a REAL vendor adapter bound. */
  readonly bound: Readonly<Record<OutOfBandTransportChannel, boolean>>;
  /** Env variable names still needed, per unbound channel (names only). */
  readonly missing: Readonly<Record<OutOfBandTransportChannel, readonly string[]>>;
  /** True only when Tier-1 SOS voice escalation can actually place a call. */
  readonly sosVoiceAvailable: boolean;
  /** Delivers the §4.2 OTP over the bound sms/email adapter; throws a 503 `WardenXError` when that one is unbound. */
  readonly sendEndpointVerificationCode: EndpointVerificationSender;
}

export interface OutOfBandBindingOptions {
  readonly env: Env;
  /** PHI-free sink for the boot notices. */
  readonly log: (line: string) => void;
  readonly fetch?: VendorFetch;
}

const val = (env: Env, key: string): string | undefined => {
  const v = env[key]?.trim();
  return v ? v : undefined;
};
const E164 = /^\+[1-9]\d{6,14}$/;
const need = (env: Env, keys: readonly string[]): string[] => keys.filter((k) => !val(env, k));
const VERIFICATION_TEXT = (code: string) =>
  `Your ChartWarden verification code is ${code}. If you did not request it, ignore this message.`;

function unavailable(channel: string): WardenXError {
  return new WardenXError(
    "ENDPOINT_VERIFICATION_UNAVAILABLE",
    `${channel} verification is not available: the ${channel} delivery provider is not configured`,
    503,
  );
}

export function bindOutOfBandTransports(options: OutOfBandBindingOptions): OutOfBandBinding {
  const { env } = options;
  const fetchOpt = options.fetch ? { fetch: options.fetch } : {};
  const missing: Record<OutOfBandTransportChannel, string[]> = {
    push: [],
    sms: [],
    voice: [],
    email: [],
  };

  // ── Twilio (SMS + voice) ────────────────────────────────────────────────────────────────────────────
  const twilioCommon = need(env, [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "MESSAGING_WEBHOOK_PUBLIC_BASE_URL",
  ]);
  const callbackBase = val(env, "MESSAGING_WEBHOOK_PUBLIC_BASE_URL")?.replace(/\/+$/, "");
  const smsFrom = val(env, "TWILIO_SMS_FROM");
  const messagingService = val(env, "TWILIO_MESSAGING_SERVICE_SID");
  const voiceFrom = val(env, "TWILIO_VOICE_FROM");

  let smsOptions: TwilioSmsOptions | undefined;
  missing.sms.push(...twilioCommon);
  if (!smsFrom && !messagingService)
    missing.sms.push("TWILIO_SMS_FROM|TWILIO_MESSAGING_SERVICE_SID");
  if (smsFrom && !E164.test(smsFrom)) missing.sms.push("TWILIO_SMS_FROM (invalid E.164)");
  if (missing.sms.length === 0) {
    smsOptions = {
      accountSid: val(env, "TWILIO_ACCOUNT_SID") as string,
      authToken: val(env, "TWILIO_AUTH_TOKEN") as string,
      sender: messagingService
        ? { kind: "messaging_service", messagingServiceSid: messagingService }
        : { kind: "number", from: smsFrom as string },
      statusCallbackUrl: `${callbackBase}/webhooks/twilio/sms-status`,
      ...fetchOpt,
    };
  }

  missing.voice.push(...twilioCommon);
  if (!voiceFrom) missing.voice.push("TWILIO_VOICE_FROM");
  else if (!E164.test(voiceFrom)) missing.voice.push("TWILIO_VOICE_FROM (invalid E.164)");

  // ── Postmark alert email (same credential set as the auth-email adapter) ─────────────────────────────
  const postmark = resolvePostmarkConfig({ ...env });
  let emailOptions: PostmarkAlertEmailOptions | undefined;
  if (postmark.bound) {
    emailOptions = { ...postmark.options, ...fetchOpt };
  } else {
    missing.email.push(...postmark.missing, ...postmark.invalid.map((k) => `${k} (invalid)`));
  }

  // ── Web push ─────────────────────────────────────────────────────────────────────────────────────
  missing.push.push(...need(env, ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]));
  const subject = val(env, "VAPID_SUBJECT");
  if (subject && !/^(mailto:|https:\/\/)/i.test(subject))
    missing.push.push("VAPID_SUBJECT (invalid)");

  const deny = createDenyTransport();
  const transports: { -readonly [C in OutOfBandTransportChannel]: OutOfBandTransports[C] } = {
    push: deny,
    sms: deny,
    voice: deny,
    email: deny,
  };
  if (smsOptions) transports.sms = createTwilioSmsTransport(smsOptions);
  if (missing.voice.length === 0) {
    transports.voice = createTwilioVoiceTransport({
      accountSid: val(env, "TWILIO_ACCOUNT_SID") as string,
      authToken: val(env, "TWILIO_AUTH_TOKEN") as string,
      from: voiceFrom as string,
      statusCallbackUrl: `${callbackBase}/webhooks/twilio/voice-status`,
      ...fetchOpt,
    });
  }
  if (emailOptions) transports.email = createPostmarkAlertEmailTransport(emailOptions);
  if (missing.push.length === 0) {
    try {
      transports.push = createWebPushTransport({
        vapidPublicKey: val(env, "VAPID_PUBLIC_KEY") as string,
        vapidPrivateKey: val(env, "VAPID_PRIVATE_KEY") as string,
        subject: subject as string,
        ...fetchOpt,
      });
    } catch {
      missing.push.push("VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY (malformed key pair)");
    }
  }

  const bound = {
    push: transports.push !== deny,
    sms: transports.sms !== deny,
    voice: transports.voice !== deny,
    email: transports.email !== deny,
  } as const;

  for (const channel of ["push", "sms", "voice", "email"] as const) {
    if (!bound[channel]) {
      options.log(
        `[m36:delivery] ${channel} transport NOT bound (deliveries settle failed/transport_not_configured): ${missing[channel].join(", ")}`,
      );
    }
  }
  if (!bound.voice) {
    options.log(
      "[m36:delivery] WARNING: Tier-1 SOS voice escalation is UNAVAILABLE — a field-safety SOS cannot place a phone call until the Twilio voice transport is configured.",
    );
  }

  const sendEndpointVerificationCode: EndpointVerificationSender = async ({
    channel,
    target,
    code,
  }) => {
    try {
      if (channel === "sms") {
        if (!smsOptions) throw unavailable("sms");
        // No status callback: the verification text is not a notification_delivery row.
        const { statusCallbackUrl: _omit, ...withoutCallback } = smsOptions;
        await sendTwilioSms(withoutCallback, { to: target, text: VERIFICATION_TEXT(code) });
      } else if (channel === "email") {
        if (!emailOptions) throw unavailable("email");
        await sendPostmarkEmail(emailOptions, {
          to: target,
          subject: "ChartWarden verification code",
          text: VERIFICATION_TEXT(code),
        });
      }
    } catch (err) {
      if (err instanceof WardenXError) throw err;
      // A vendor refusal: surface a generic 503 (the registration rolls back); never echo vendor detail.
      throw new WardenXError(
        "ENDPOINT_VERIFICATION_DELIVERY_FAILED",
        `could not deliver the ${channel} verification code; try again`,
        503,
      );
    }
  };

  return {
    transports,
    bound,
    missing,
    sosVoiceAvailable: bound.voice,
    sendEndpointVerificationCode,
  };
}
