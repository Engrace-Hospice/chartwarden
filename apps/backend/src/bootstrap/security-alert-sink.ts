// apps/backend/src/bootstrap/security-alert-sink.ts — the delivery half of the security review (CW-MON-01). Sibling of
// `dlq-alerts.ts` and `platform-ops-notices.ts`, and the same destination: an always-on log line plus the optional
// `OPS_ALERT_WEBHOOK_URL` webhook, read at the composition root (this file owns mechanism, the root owns config).
//
// ONE DIFFERENCE, ON PURPOSE. Those two sinks are fire-and-forget: a webhook that fails is only logged. A security alert that
// is lost silently is the failure this control exists to prevent, so this sink AWAITS the POST and reports how it went
// (`delivered` / `failed` / `no_destination`); the review keeps its cursor behind an alert that was not delivered and tries
// again on the next run (see `runSecurityReview`). It still never throws into the caller.
//
// The body is the platform-ops notice shape (`kind`, `summary`, `details`, `correlationId`, `occurredAt`) so a receiver that
// already understands those notices needs no change. NO PHI: `details` is the alert — rule id, severity, counts, ISO window,
// event ids, a subject reference (a user id, a /24 prefix or a truncated credential hash) and the runbook anchor.
import type { AlertDeliveryStatus, SecurityAlert, SecurityAlertSink } from "@chartwarden/audit";
import { WEBHOOK_TIMEOUT_MS } from "./platform-ops-notices";

/**
 * What a failed POST may say in a log line: the error type and its code (`TimeoutError`, `TypeError ECONNREFUSED`), never its
 * message. A malformed-URL error embeds the URL, and a webhook URL commonly carries a secret.
 */
function describeFailure(err: unknown): string {
  const name = err instanceof Error ? err.name : "error";
  const code =
    (err as { cause?: { code?: unknown } } | null)?.cause?.code ??
    (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? `${name} ${code}` : name;
}

/** The log line for one alert: ids and codes, greppable. */
export function formatSecurityAlert(alert: SecurityAlert): string {
  const org = alert.organizationId ? ` org=${alert.organizationId}` : "";
  return `🔒 security alert [${alert.severity}] ${alert.ruleId}${org} subject=${alert.subject.kind}:${alert.subject.ref} count=${alert.count} window=${alert.windowFrom}..${alert.windowTo} fp=${alert.fingerprint}`;
}

export function buildSecurityAlertSink(opts?: {
  readonly webhookUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (message: string) => void;
  readonly now?: () => Date;
}): SecurityAlertSink {
  const log = opts?.log ?? ((m: string) => console.error(m));
  const webhookUrl = opts?.webhookUrl;
  const doFetch = opts?.fetchImpl ?? fetch;
  const now = opts?.now ?? (() => new Date());
  return async (alert): Promise<AlertDeliveryStatus> => {
    log(formatSecurityAlert(alert));
    if (!webhookUrl) return "no_destination";
    try {
      const response = await doFetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "security_alert",
          summary: `[${alert.severity}] ${alert.title}`,
          details: alert,
          correlationId: alert.fingerprint,
          occurredAt: now().toISOString(),
        }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        // A 307/308 would replay the body (org, user and event ids) at wherever it points: an operator's URL is the destination.
        redirect: "error",
      });
      // The body is never read; releasing it frees the connection.
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return "delivered";
      log(
        `⚠️  security alert webhook refused (HTTP ${response.status}) for ${alert.ruleId} fp=${alert.fingerprint}`,
      );
      return "failed";
    } catch (err) {
      log(
        `⚠️  security alert webhook delivery failed for ${alert.ruleId} fp=${alert.fingerprint}: ${describeFailure(err)}`,
      );
      return "failed";
    }
  };
}
