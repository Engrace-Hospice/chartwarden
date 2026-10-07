// apps/backend/src/modules/36-messaging/delivery/webhook-mount.ts — GAP-101: mounts the three §4.9 inbound
// vendor webhooks (`/webhooks/twilio/sms-status`, `/webhooks/twilio/voice-status`, `/webhooks/postmark/event`).
//
// AUTH IS SIGNATURE-BASED, never a header taken on trust: each request is gated by the §4.9 two layers inside
// `registerMessagingWebhookRoutes` (replay window, then Twilio HMAC-SHA1 over URL + sorted params / Postmark
// source-IP allowlist + constant-time bearer token). The headers that carry those proofs are registered in
// `scripts/check-request-header-auth.ts` (`x-twilio-signature` verified; the timestamps not-authorization).
//
// FAIL-CLOSED: the vendor secrets come from the environment (the M1 §8.3 tenant secret store is not built).
// With a secret unset its resolver throws a 503 `WEBHOOK_UNCONFIGURED` — evaluated AFTER the replay window and
// BEFORE any verification, so an unconfigured deployment never verifies against a default and never reconciles.
//   TWILIO_AUTH_TOKEN, POSTMARK_WEBHOOK_TOKEN, MESSAGING_WEBHOOK_PUBLIC_BASE_URL (the exact URL origin the
//   vendor signs against), POSTMARK_WEBHOOK_SOURCE_IPS (comma-separated Postmark egress IPs).
//
// BODY PARSING: Twilio posts `application/x-www-form-urlencoded`. The parser below lives in an ENCAPSULATED
// scope (no `@fastify/formbody` dependency, no effect on any other route) and yields the flat string map the
// HMAC is computed over.
import type { DbClient } from "@wardenx/db";
import { WebhookError } from "@wardenx/messaging";
import type { FastifyInstance } from "fastify";
import {
  type MessagingWebhookService,
  registerMessagingWebhookRoutes,
} from "../routes/webhook-routes";
import type { DeliveryOutboxPort } from "./delivery-settlement";
import { createDbMessagingWebhookService } from "./webhook-service-db";

export interface MessagingWebhookConfig {
  readonly publicBaseUrl: string | undefined;
  readonly twilioAuthToken: string | undefined;
  readonly postmarkToken: string | undefined;
  readonly postmarkSourceIps: readonly string[];
}

const UNCONFIGURED_STATUS = 503;
const UNCONFIGURED_CODE = "WEBHOOK_UNCONFIGURED";

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function readMessagingWebhookConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): MessagingWebhookConfig {
  return {
    publicBaseUrl: nonEmpty(env.MESSAGING_WEBHOOK_PUBLIC_BASE_URL)?.replace(/\/+$/, ""),
    twilioAuthToken: nonEmpty(env.TWILIO_AUTH_TOKEN),
    postmarkToken: nonEmpty(env.POSTMARK_WEBHOOK_TOKEN),
    postmarkSourceIps: (env.POSTMARK_WEBHOOK_SOURCE_IPS ?? "")
      .split(",")
      .map((ip) => ip.trim())
      .filter((ip) => ip.length > 0),
  };
}

function required(value: string | undefined): string {
  if (value === undefined) {
    throw new WebhookError(UNCONFIGURED_STATUS, UNCONFIGURED_CODE);
  }
  return value;
}

export function mountMessagingWebhookRoutes(
  app: FastifyInstance,
  deps: {
    readonly db: DbClient;
    readonly outbox: DeliveryOutboxPort;
    readonly config?: MessagingWebhookConfig;
    /** Test seam: replaces the Drizzle reconcile service. */
    readonly service?: MessagingWebhookService;
  },
): void {
  const config = deps.config ?? readMessagingWebhookConfig();
  const allowed = new Set(config.postmarkSourceIps);
  if (!config.twilioAuthToken || !config.postmarkToken || !config.publicBaseUrl) {
    app.log.warn(
      { event: "m36.webhooks.partially_unconfigured" },
      "M36 vendor webhooks: TWILIO_AUTH_TOKEN / POSTMARK_WEBHOOK_TOKEN / MESSAGING_WEBHOOK_PUBLIC_BASE_URL not all set. Routes whose secret is missing answer 503 and never reconcile.",
    );
  }

  void app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)));
        } catch (error) {
          done(error as Error);
        }
      },
    );
    registerMessagingWebhookRoutes(scope, {
      publicBaseUrl: config.publicBaseUrl ?? "",
      resolveTwilioAuthToken: () =>
        required(
          config.twilioAuthToken && config.publicBaseUrl ? config.twilioAuthToken : undefined,
        ),
      resolvePostmarkToken: () => required(config.postmarkToken),
      isPostmarkSourceAllowed: (ip) => allowed.has(ip),
      service:
        deps.service ??
        createDbMessagingWebhookService({
          db: deps.db,
          outbox: deps.outbox,
          onUnmatched: (kind, _id, matches) =>
            app.log.warn(
              { event: "m36.webhook.unmatched", kind, matches },
              "M36 vendor callback matched no single delivery; dropped",
            ),
        }),
    });
  });
}
