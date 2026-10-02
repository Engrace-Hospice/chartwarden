// apps/backend/src/modules/12-dosespot/webhooks/webhook-route.ts — `POST /webhooks/dosespot`
// (M12 spec §4.1 / §7.4 D7; F-230, #248). The only public-internet-facing M12 route: NO session, NO
// permission key — it authenticates by the §7.4 envelope (HMAC-SHA256 of the RAW body with the per-tenant
// secret + ±5 min timestamp + dedup), run inside `ingestDoseSpotWebhook`.
//
// FAIL-CLOSED: when no webhook secret source is configured (`secrets.isConfigured() === false`, the
// production default until an operator binds `DOSESPOT_WEBHOOK_SECRETS`) the route answers 503
// `DOSESPOT_WEBHOOK_UNCONFIGURED` for EVERY request and logs ONE structured warning at registration — it never
// reads the body, never verifies against a default, never persists, never emits.
//
// RAW BODY: HMAC verification needs the exact bytes, so the route lives in an ENCAPSULATED scope whose JSON
// parser hands the handler the unparsed string (re-serializing a parsed body breaks the signature). The
// override is local to this scope; no other route's parsing changes.
import { DOSESPOT_WIRE_MAPPING_VERIFIED } from "@wardenx/dosespot";
import { WardenXError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { type DoseSpotWebhookIngestDeps, ingestDoseSpotWebhook } from "./ingest";

export const DOSESPOT_WEBHOOK_PATH = "/webhooks/dosespot";

const firstHeader = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export function registerDoseSpotWebhookRoute(
  app: FastifyInstance,
  deps: DoseSpotWebhookIngestDeps,
): void {
  const log =
    deps.log ??
    ((event: string, context: Record<string, unknown>) =>
      app.log.info({ event, ...context }, event));
  const enabled = deps.secrets.isConfigured();
  if (!enabled) {
    app.log.warn(
      { event: "dosespot.webhook.disabled" },
      "DoseSpot webhook route is DISABLED: no per-tenant webhook secret is configured (DOSESPOT_WEBHOOK_SECRETS). Every request is refused with 503.",
    );
  } else if (!DOSESPOT_WIRE_MAPPING_VERIFIED) {
    app.log.warn(
      { event: "dosespot.webhook.wire_mapping_unverified" },
      "DoseSpot webhook enabled, but the script_status_update payload field names and the signature scheme have NOT been verified against real vendor documentation/samples (F-230).",
    );
  }

  void app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) =>
      done(null, body),
    );
    scope.post(DOSESPOT_WEBHOOK_PATH, async (request, reply) => {
      if (!enabled) {
        throw new WardenXError(
          "DOSESPOT_WEBHOOK_UNCONFIGURED",
          "the DoseSpot webhook is not configured",
          503,
        );
      }
      const rawBody = typeof request.body === "string" ? request.body : "";
      const verdict = await ingestDoseSpotWebhook(
        { ...deps, log },
        {
          rawBody,
          signatureHeader: firstHeader(request.headers["x-dosespot-signature"]),
          timestampHeader: firstHeader(request.headers["x-dosespot-timestamp"]),
        },
      );
      switch (verdict.kind) {
        case "invalid_signature":
          return reply.code(401).send({ code: "INVALID_SIGNATURE" });
        case "stale":
          return reply.code(400).send({ code: "STALE_REQUEST" });
        case "malformed_timestamp":
        case "malformed":
          return reply.code(400).send({ code: "MALFORMED_REQUEST" });
        default:
          // `duplicate` and `accepted` are both 200 (§7.4.4: a redelivery returns 200, no reprocessing).
          return reply.code(200).send({ received: true });
      }
    });
  });
}
