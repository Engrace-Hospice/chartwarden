// apps/backend/src/modules/36-messaging/transactional-email-binding.ts — the boot-time decision for outbound
// transactional email (M36, DR/INT #14).
//
// Credentials come ONLY from env (POSTMARK_*). The Postmark adapter is bound ONLY when a server token, a
// well-formed From address and the operator's sender-verified attestation are all present; otherwise the
// provider stays UNBOUND and the platform fails closed exactly as before the adapter existed:
//   - production drops auth emails (a link in prod logs is a credential in logs);
//   - the funeral / collaborator invite routes answer 503 LINK_DELIVERY_UNAVAILABLE (no credential minted);
//   - the auditor invite delivery throws (the enrolment route answers 503 AUDITOR_LINK_DELIVERY_FAILED).
// An unbound production boot writes a loud line naming each missing / invalid variable (names only, never values).
import {
  type TransactionalEmailTransport,
  createPostmarkTransactionalEmailTransport,
  resolvePostmarkConfig,
  selectTransactionalEmailTransport,
} from "./index";

export interface TransactionalEmailBinding {
  /** What the auth `EmailTransport` seam sends through (provider when bound; console in dev; no-op in prod). */
  readonly emailTransport: TransactionalEmailTransport;
  /** True only when the real provider adapter is bound. Gates every production invite-delivery route. */
  readonly providerBound: boolean;
  /** Whether the funeral / collaborator invite delivery port may be bound: always outside production, and in
   *  production only when the real provider is bound (otherwise those routes answer 503 LINK_DELIVERY_UNAVAILABLE). */
  readonly linkDeliveryAvailable: boolean;
  /** The transport the invite deliveries use: the real one, or one that THROWS when production is unbound. */
  readonly linkEmailTransport: TransactionalEmailTransport;
}

export interface TransactionalEmailBindingOptions {
  readonly env: Record<string, string | undefined>;
  /** PHI-free sink for boot notices and adapter delivery logs (message id + status only). */
  readonly log: (line: string) => void;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function bindTransactionalEmail(
  options: TransactionalEmailBindingOptions,
): TransactionalEmailBinding {
  const isProduction = options.env.NODE_ENV === "production";
  const config = resolvePostmarkConfig(options.env);
  if (!config.bound) {
    const problems = [
      ...config.missing.map((k) => `${k} (missing)`),
      ...config.invalid.map((k) => `${k} (invalid)`),
    ].join(", ");
    options.log(
      `[m36:email] transactional email provider NOT bound: ${problems}. ${
        isProduction
          ? "Portal magic-link sign-in emails are dropped and funeral / collaborator / auditor invite routes answer 503 LINK_DELIVERY_UNAVAILABLE until configured."
          : "Dev/test log the link via the console transport."
      }`,
    );
  }
  const emailTransport = selectTransactionalEmailTransport({
    isProduction,
    ...(config.bound
      ? {
          provider: createPostmarkTransactionalEmailTransport({
            ...config.options,
            log: options.log,
            ...(options.fetch ? { fetch: options.fetch } : {}),
            ...(options.sleep ? { sleep: options.sleep } : {}),
          }),
        }
      : {}),
  });
  const providerBound = config.bound;
  const linkDeliveryAvailable = !isProduction || providerBound;
  const linkEmailTransport: TransactionalEmailTransport = linkDeliveryAvailable
    ? emailTransport
    : {
        async send(): Promise<void> {
          throw new Error("transactional email provider is not bound (POSTMARK_* unset)");
        },
      };
  return { emailTransport, providerBound, linkDeliveryAvailable, linkEmailTransport };
}
