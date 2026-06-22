// @wardenx/auth · identity — outbound transactional email transport (M2 delivery seam).
//
// Better Auth mints the single-use tokens (password reset, magic-link sign-in) and hands them to the
// `sendResetPassword` / `sendMagicLink` callbacks; THIS is the thin PORT those callbacks send through —
// the auth wiring templates the message, the bound transport delivers it.
//
// FB-T14: M36 OWNS outbound email in the integration catalog (manifest VENDOR_ADAPTERS["postmark"] =
// packages/messaging; M2_DR_INT_INVENTORY §2.2 #14). The composition root therefore binds this PORT to
// M36's `selectTransactionalEmailTransport` (`@wardenx/messaging`) — so auth links dispatch through M36,
// while M2 neither imports a vendor SDK nor takes a `dependsOn` edge on M36 (the bridge is the
// composition root, which may import both). These sends are TRANSACTIONAL and PHI-free (a sign-in link
// to one address) with no in-perimeter `Alert`/`Message` source, so they bypass §4.7
// `sanitizeForOutOfBand` and the org-scoped `notification_delivery` pipeline — a pre-auth reset has no
// org context to scope. The no-op + console impls below remain as the M2 slice/test fallback and the
// `EmailTransport` port the auth instance is typed against.

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
export function createConsoleEmailTransport(
  log: (line: string) => void = console.info,
): EmailTransport {
  return {
    async send(message: EmailMessage): Promise<void> {
      log(`[email] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`);
    },
  };
}
