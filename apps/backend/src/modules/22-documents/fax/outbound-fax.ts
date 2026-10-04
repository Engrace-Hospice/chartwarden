// apps/backend/src/modules/22-documents/fax/outbound-fax.ts — M22's provider-agnostic OUTBOUND FAX port
// (F-238: sending a records request's cover sheet + letter to the PCP / hospital that holds the records).
//
// Ownership: fax is M22's integration surface — INTEGRATIONS §2 row 30 ("Fax/email document ingest", owner
// M22, BAA-gated) — and the vendors that receive faxes for us (fax-to-API) also send them, so the outbound
// half lives beside the inbound one rather than in M36 (whose outbound channels are in-app / e-mail / SMS
// and which carries no PHI out of band). No fax vendor is contracted yet, so no vendor adapter exists: the
// selector below is the ONE place a real adapter (Documo, Sfax, …) plugs in, mirroring
// `selectTransactionalEmailTransport` (M36) — a one-file change in the owning module.
//
// Selection (`FAX_PROVIDER`):
//   · unset / "none"  → UNCONFIGURED: `available: false`; the send route answers 503 and nothing leaves.
//   · "stub"          → the dev/test STUB: logs one line (request reference, page count, the number's last
//                       four digits — never the document) and returns a synthetic message id. REFUSED in
//                       production (a faked "sent" on a records request is a lie a nurse acts on).
//   · anything else   → UNCONFIGURED with the unknown name in the reason (a typo must not fake success).
// Development with nothing set defaults to the stub so the workflow is exercisable locally.
//
// The port is deliberately narrow: E.164 destination, PDF bytes, a vendor-visible reference that carries no
// PHI (the request code), and an idempotency key (the send-attempt id) a real vendor dedupes on.
import { randomUUID } from "node:crypto";

export interface OutboundFaxDocument {
  readonly filename: string;
  readonly contentType: "application/pdf";
  readonly bytes: Uint8Array;
}

export interface OutboundFaxRequest {
  readonly organizationId: string;
  /** Destination in E.164 (`+15035550100`) — see ./fax-number.ts. */
  readonly to: string;
  readonly documents: readonly OutboundFaxDocument[];
  /** Vendor-visible reference — must carry no PHI (the records-request code). */
  readonly reference: string;
  /** Stable per attempt; a real vendor dedupes a retried submit on it. */
  readonly idempotencyKey: string;
}

export type OutboundFaxResult =
  | { readonly ok: true; readonly providerMessageId: string }
  | { readonly ok: false; readonly reason: string };

export interface OutboundFaxTransport {
  /** Adapter name recorded on every send row ("stub", a vendor name, "unconfigured"). */
  readonly provider: string;
  /** False ⇒ nothing can be sent (no provider configured); callers refuse BEFORE recording anything. */
  readonly available: boolean;
  /** Why `available` is false (operator-facing; no PHI). */
  readonly unavailableReason?: string;
  /** Accepts the fax for delivery. Never throws for a vendor refusal — returns `{ ok: false }`. */
  send(request: OutboundFaxRequest): Promise<OutboundFaxResult>;
}

/** The last four digits only — enough for an operator to tell sends apart, not a disclosure. */
export const maskFaxNumber = (e164: string): string => `***${e164.slice(-4)}`;

export interface StubOutboundFaxTransport extends OutboundFaxTransport {
  /** Every accepted request, in order (tests read what "went out"). */
  readonly sent: OutboundFaxRequest[];
}

/** Dev/test stub: no network. Logs a PHI-free line and returns `stub-<uuid>`. `fail` simulates a refusal. */
export function createStubOutboundFaxTransport(
  opts: { log?: (line: string) => void; fail?: (req: OutboundFaxRequest) => string | null } = {},
): StubOutboundFaxTransport {
  const log = opts.log ?? console.info;
  const sent: OutboundFaxRequest[] = [];
  return {
    provider: "stub",
    available: true,
    sent,
    async send(req) {
      const bytes = req.documents.reduce((n, d) => n + d.bytes.byteLength, 0);
      const refusal = opts.fail?.(req) ?? null;
      if (refusal) {
        log(`[m22:fax-stub] REFUSED ref=${req.reference} to=${maskFaxNumber(req.to)} (${refusal})`);
        return { ok: false, reason: refusal };
      }
      sent.push(req);
      const providerMessageId = `stub-${randomUUID()}`;
      log(
        `[m22:fax-stub] accepted ref=${req.reference} to=${maskFaxNumber(req.to)} docs=${req.documents.length} bytes=${bytes} id=${providerMessageId}`,
      );
      return { ok: true, providerMessageId };
    },
  };
}

/** No provider: refuses every send (the route answers 503 before recording an attempt). */
export function createUnconfiguredOutboundFaxTransport(reason: string): OutboundFaxTransport {
  return {
    provider: "unconfigured",
    available: false,
    unavailableReason: reason,
    async send() {
      return { ok: false, reason };
    },
  };
}

/**
 * The single boot-time selection point for outbound fax. An injected `provider` (a real vendor adapter,
 * once contracted + BAA executed — INTEGRATIONS INT-014) always wins; otherwise `FAX_PROVIDER` decides.
 */
export function selectOutboundFaxTransport(opts: {
  readonly isProduction: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly provider?: OutboundFaxTransport;
  readonly log?: (line: string) => void;
}): OutboundFaxTransport {
  if (opts.provider) return opts.provider;
  const name = (opts.env.FAX_PROVIDER ?? "").trim().toLowerCase();
  if (name === "stub" || (name === "" && !opts.isProduction)) {
    if (opts.isProduction) {
      return createUnconfiguredOutboundFaxTransport(
        "FAX_PROVIDER=stub is refused in production (a stub cannot really send a fax)",
      );
    }
    return createStubOutboundFaxTransport({ log: opts.log });
  }
  if (name === "" || name === "none") {
    return createUnconfiguredOutboundFaxTransport("no outbound fax provider is configured");
  }
  return createUnconfiguredOutboundFaxTransport(
    `FAX_PROVIDER=${JSON.stringify(name)} has no adapter in this build`,
  );
}
