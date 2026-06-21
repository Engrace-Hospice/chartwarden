// @wardenx/messaging — outbound TRANSACTIONAL email transport (M36; FB-T14, DR/INT #14).
//
// M36 owns outbound email in the integration catalog (manifest VENDOR_ADAPTERS["postmark"] =
// "packages/messaging"; M2_DR_INT_INVENTORY §2.2 #14 — "Postmark email ... Owner = M36"). The auth
// module (M2) mints the single-use auth links (password reset, magic-link sign-in) and hands the
// fully-templated message to its `EmailTransport` PORT; THIS is the M36-owned mechanism that PORT is
// bound to at the composition root, so the auth follow-up "email delivery wired to M36" (FB-T14) is
// satisfied without M2 importing a vendor SDK or M36 (no `dependsOn` edge — the bridge is the
// composition root, which may import both).
//
// Scope vs. §4.7: these are TRANSACTIONAL, pre-org, pre-session messages — a verification/sign-in link
// to a single email address. They carry NO PHI and have no in-perimeter `Alert`/`Message` source, so
// they do NOT traverse `sanitizeForOutOfBand` (that chokepoint guards PHI-bearing alert/message emits)
// and are NOT recorded in the org-scoped `notification_delivery` pipeline (which serves in-app/alert
// fan-out under RLS, and has no org context to scope a pre-auth reset to). The link IS the
// "authenticated deep link" the no-PHI rule permits (DR/INT §2.2).
//
// The real provider (Postmark/SES) plugs in at `selectTransactionalEmailTransport`'s `provider` slot
// when M1 infra wires credentials — a one-place change in this owner. Until then dev logs the link
// (console) and production drops it (no-op — a link in prod logs is a credential in logs).

/** A transactional email to deliver (plain-text is required; html is optional). Mirrors the auth
 *  module's `EmailMessage` port shape structurally so the composition root binds them without
 *  coupling the two interface definitions. */
export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

/** Delivers a transactional email. The production Postmark/SES adapter implements this. */
export interface TransactionalEmailTransport {
  send(email: OutboundEmail): Promise<void>;
}

/** No-op transport: silently drops the message (tests, or email intentionally disabled in prod). */
export function createNoopTransactionalEmailTransport(): TransactionalEmailTransport {
  return { async send() {} };
}

/**
 * Console transport: logs the message (subject + body, which carries the link) so the reset /
 * magic-link flow is exercisable in local/dev without a provider. NOT for production — a link in logs
 * is a credential in logs; {@link selectTransactionalEmailTransport} picks no-op there instead.
 */
export function createConsoleTransactionalEmailTransport(
  log: (line: string) => void = console.info,
): TransactionalEmailTransport {
  return {
    async send(email: OutboundEmail): Promise<void> {
      log(`[m36:email] to=${email.to} subject=${JSON.stringify(email.subject)}\n${email.text}`);
    },
  };
}

/**
 * The single boot-time selection point M36 owns for transactional email delivery. The composition
 * root calls this once and injects the result into the auth `EmailTransport` seam:
 *   - an injected `provider` (the real Postmark/SES adapter) always wins, when wired (M1 infra);
 *   - otherwise dev logs the link (console) and production drops it (no-op).
 * Centralizing the choice here means wiring the production provider is a one-file change in the
 * module that owns the integration, not a scattered edit in the host.
 */
export function selectTransactionalEmailTransport(opts: {
  readonly isProduction: boolean;
  readonly provider?: TransactionalEmailTransport;
  readonly log?: (line: string) => void;
}): TransactionalEmailTransport {
  if (opts.provider) return opts.provider;
  return opts.isProduction
    ? createNoopTransactionalEmailTransport()
    : createConsoleTransactionalEmailTransport(opts.log);
}
