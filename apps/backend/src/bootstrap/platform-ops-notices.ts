// apps/backend/src/bootstrap/platform-ops-notices.ts — the LIVE half of the org-less platform-ops notice path
// (GAP-173; sibling of `dlq-alerts.ts`, same reasoning). Platform-ops is not a tenant, so M36's tenant-scoped
// AlertEmitter is the wrong channel for "N suspected duplicate canonical entities are waiting" or "provisional
// entities have been pending 14 days". The durable record is an org-less platform audit event written by the
// module (`modules/40-mdm/jobs/platform-ops.ts`); this is the always-on log line plus the optional
// `OPS_ALERT_WEBHOOK_URL` webhook (read at the composition root, never here — this file owns mechanism, the root
// owns config). The webhook never blocks or throws into the caller.
import { safeErrorMessage } from "./redact-database-error";

export interface PlatformOpsNoticeEvent {
  readonly kind: string;
  readonly summary: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly correlationId: string;
}

export type PlatformOpsNoticeSink = (notice: PlatformOpsNoticeEvent) => void;

export function buildPlatformOpsNoticeSink(opts?: {
  readonly webhookUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (message: string) => void;
}): PlatformOpsNoticeSink {
  const log = opts?.log ?? ((m: string) => console.warn(m));
  const webhookUrl = opts?.webhookUrl;
  const doFetch = opts?.fetchImpl ?? fetch;
  return (notice) => {
    log(`platform-ops notice [${notice.kind}] ${notice.summary} (${notice.correlationId})`);
    if (!webhookUrl) return;
    doFetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...notice, occurredAt: new Date().toISOString() }),
    }).catch((err) => {
      log(`platform-ops notice webhook delivery failed: ${safeErrorMessage(err)}`);
    });
  };
}
