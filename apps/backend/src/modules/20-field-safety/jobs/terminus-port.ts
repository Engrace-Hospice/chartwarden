// apps/backend/src/modules/20-field-safety/jobs/terminus-port.ts — GAP-032: the one terminus effect M20 can
// truly execute today, the platform page to WardenX ops (§2.2.2 (c) / INT-031).
//
// The terminus rung used to be refused outright because none of its three caller-owned effects
// (`dial_emergency_contact`, `surface_psap_number`, `page_wardenx_ops`) had an implementer, so a tier-3 alert
// breaching its SLA stalled silently. The page is the effect that needs no vendor-specific telephony or M40
// master data: an authenticated HTTPS webhook (PagerDuty/Opsgenie/Slack-style receiver) chosen by
// configuration. It carries IDS ONLY (no PHI, no coordinates, no contact numbers).
//
// What this does NOT do, and the terminus payload says so rather than claiming it:
//   • `dial_emergency_contact` needs an M36 voice dispatch to the consented contact — still unbound, so
//     `emergencyContactCallInitiated` stays false.
//   • `surface_psap_number` is fetched by the responder's client from M40 against a jurisdiction id; no M40
//     reader exists yet, so `psapJurisdictionId` stays null.
// The terminus is only entered when the page was actually delivered; a failed page throws (the watchdog tick
// rolls the transition back and retries) so the ledger never says "terminus reached" with nobody paged.

export interface SosTerminusPageInput {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly sosAlertId: string;
  /** 0 on the terminus entry, then the re-page loop count. */
  readonly loopIteration: number;
  readonly at: string;
}

/** Pages WardenX ops. Resolves only once the receiver acknowledged; rejects otherwise. */
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
      const response = await doFetch(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: JSON.stringify({
          source: "wardenx.m20.sos_terminus",
          severity: "critical",
          summary: "SOS alert reached the emergency terminus without an acknowledgment",
          ...input,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status < HTTP_OK_MIN || response.status > HTTP_OK_MAX) {
        throw new Error(`m20: ops page webhook answered HTTP ${response.status}`);
      }
    },
  };
}
