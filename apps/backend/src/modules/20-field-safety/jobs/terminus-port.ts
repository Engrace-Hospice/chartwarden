// apps/backend/src/modules/20-field-safety/jobs/terminus-port.ts - GAP-032: the platform page to WardenX ops
// (§2.2.2 (c) / INT-031). An authenticated HTTPS webhook (PagerDuty/Opsgenie/Slack-style receiver) chosen by
// configuration. It carries IDS ONLY (no PHI, no coordinates, no contact numbers).
//
// This is only the TRANSPORT. WHEN to page, retry, de-duplicate and record the outcome is the terminus
// ledger's business (`../terminus/`): the executor calls this OUTSIDE any tenant transaction, so a slow or
// down receiver can neither hold a pooled connection nor hide the terminus. `dedupKey` (`sos:{alertId}`)
// lets the receiver coalesce the per-period re-pages into one incident instead of N.

export interface SosTerminusPageInput {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly sosAlertId: string;
  /** 0 on the terminus entry, then the re-page loop count. */
  readonly loopIteration: number;
  readonly at: string;
  /** The ledger row's idempotency key, so a receiver can drop an exact replay. */
  readonly idempotencyKey?: string;
}

/** A failed page, classified for the ledger's closed outcome vocabulary. */
export class OpsPageError extends Error {
  constructor(
    readonly outcome: "receiver_non_2xx" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "OpsPageError";
  }
}

/** Pages WardenX ops. Resolves only once the receiver acknowledged; rejects with {@link OpsPageError} otherwise. */
export interface SosTerminusPort {
  pageOps(input: SosTerminusPageInput): Promise<void>;
}

type FetchResponse = { readonly status: number };
export type OpsPageFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<FetchResponse>;

const PAGE_TIMEOUT_MS = 8_000;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;

export interface WebhookOpsPagerOptions {
  readonly url: string;
  readonly token?: string | undefined;
  readonly fetchImpl?: OpsPageFetch;
  readonly timeoutMs?: number;
}

/** HTTPS-only webhook pager. Throws at construction on a non-https URL (misconfiguration must be loud). */
export function createWebhookOpsPager(options: WebhookOpsPagerOptions): SosTerminusPort {
  if (!/^https:\/\//.test(options.url)) {
    throw new Error("m20: WARDENX_OPS_PAGE_WEBHOOK_URL must be an https:// URL");
  }
  const doFetch: OpsPageFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? PAGE_TIMEOUT_MS;
  return {
    async pageOps(input) {
      let response: FetchResponse;
      try {
        response = await doFetch(options.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          },
          body: JSON.stringify({
            source: "wardenx.m20.sos_terminus",
            severity: "critical",
            summary: "SOS alert reached the emergency terminus without an acknowledgment",
            dedupKey: `sos:${input.sosAlertId}`,
            ...input,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // Unreachable or timed out. The underlying error text can carry the URL, so it is not propagated.
        throw new OpsPageError("timeout", "m20: ops page webhook unreachable or timed out");
      }
      if (response.status < HTTP_OK_MIN || response.status > HTTP_OK_MAX) {
        throw new OpsPageError(
          "receiver_non_2xx",
          `m20: ops page webhook answered HTTP ${response.status}`,
        );
      }
    },
  };
}
