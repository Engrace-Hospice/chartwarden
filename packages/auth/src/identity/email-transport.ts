// @wardenx/auth · identity — outbound transactional email transport (M2 delivery seam).
//
// Better Auth mints the single-use tokens (password reset, magic-link sign-in) and hands them to the
// `sendResetPassword` / `sendMagicLink` callbacks; THIS is the delivery mechanism those callbacks send
// through. It is a thin PORT: the auth wiring templates the message, the transport delivers it. The real
// provider (SMTP / Postmark / SES) is wired in the composition root from credentials — a deliberately
// small surface so adding one later is a one-file change. Until credentials exist, the console transport
// logs the link (dev) and the no-op transport drops it (tests / disabled email).
//
// Transactional auth email is intentionally NOT routed through M36's notification pipeline: M36 is for
// in-app/alert delivery and its out-of-band transport is itself deferred to M1 infra; an auth sign-in
// link needs a direct, synchronous transactional send. Keeping this seam in M2 avoids a dependency on
// M36 infra that does not exist yet.

/** A transactional email to deliver (plain-text is required; html is optional). */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

/** Delivers a transactional email. Production injects a provider adapter at boot. */
export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

/** No-op transport: silently drops the message (tests, or email intentionally disabled). */
export function createNoopEmailTransport(): EmailTransport {
  return { async send() {} };
}

/**
 * Console transport: logs the message (subject + body, which carries the link) so the flow is
 * exercisable in local/dev without a provider. NOT for production — a link in logs is a credential in
 * logs; the composition root selects a real transport when provider credentials are present.
 */
export function createConsoleEmailTransport(log: (line: string) => void = console.info): EmailTransport {
  return {
    async send(message: EmailMessage): Promise<void> {
      log(`[email] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`);
    },
  };
}
