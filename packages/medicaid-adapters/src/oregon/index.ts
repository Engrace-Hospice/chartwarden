import { MedicaidAdapterError } from "../errors";
// @wardenx/medicaid-adapters — the Oregon reference adapter (D14). Engrace Hospice (Pendleton OR, CCN
// 381588) is the founding customer; Oregon Health Plan (OHP) via OHA DMAP + CCO routing is the Phase-1
// production target. This adapter ships the REAL declarative metadata + the pure helpers (TOB mapping, the
// OHP Member ID mod-10 format check).
//
// WX-PR-011: the live wire I/O (OHA MMIS 270/271 + 837I-equivalent, CCO clearinghouse, ack/remittance parsing,
// rate lookup) is now BOUND to the launch-gateway (./launch-gateway.ts) when one is injected at construction
// — the same real+fake-transport posture as M23's MAC-HTTP/x12-gen (a faithful fake exercises every path in
// tests; real per-tenant OHA/CCO endpoint + trading-partner certification is still external-sandbox pending).
// With NO gateway injected (the default — dev/test/CI, `m24LaunchGatewayConfigFromEnv` unset), every I/O
// method still throws the original structured ADAPTER_NOT_WIRED. NOT a deny-stub either way (vendor has no
// '-deny-stub' suffix; metadata + helpers are real), so `isPhaseOneDenyStub('OR')` is false.
import type { MedicaidAdapter, MedicaidAdapterMetadata } from "../interface";
import { replacementTob as stdReplacementTob, voidTob as stdVoidTob } from "../tob";
import { type OregonGatewayPort, assembleOregonSubmissionPayload } from "./launch-gateway";

const OREGON_VENDOR = "oregon-oha-direct";
const OPS_HINT =
  "Configure the OHA MMIS / CCO clearinghouse endpoint + trading-partner credentials (M34 wizard) to enable live Oregon Medicaid submission.";

const OREGON_METADATA: MedicaidAdapterMetadata = {
  acceptsDocumentedMissingEvv: false, // D9 — Cures Act §12006; Oregon does not accept documented_missing
  combinesHospiceAndRb: true, // Oregon bills hospice + R&B on a single 837I
  hasNoeEquivalent: false,
  supportedChannels: ["direct_mmis", "cco_clearinghouse"],
  ackMode: "sync",
  supportedTobs: ["811", "812", "813", "814", "817", "818"],
};

/**
 * Validate an Oregon OHP Member ID: 8 digits with a trailing mod-10 (Luhn) check digit. Pure + total —
 * returns false on any non-conforming input (never throws). The digits themselves are never logged/stored.
 */
export function isValidOhpMemberId(recipientId: string): boolean {
  const id = recipientId.trim();
  if (!/^\d{8}$/.test(id)) return false;
  let sum = 0;
  let double = true; // start doubling from the leftmost of the first 7 (rightmost is the check digit)
  for (let i = id.length - 2; i >= 0; i -= 1) {
    let d = id.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === id.charCodeAt(id.length - 1) - 48;
}

export class OregonMedicaidAdapter implements MedicaidAdapter {
  readonly state = "OR";
  readonly vendor = OREGON_VENDOR;
  readonly version = "0.1.0";
  readonly metadata = OREGON_METADATA;

  constructor(private readonly gateway: OregonGatewayPort | null = null) {}

  replacementTob(originalTob: string): string {
    return stdReplacementTob(originalTob);
  }
  voidTob(originalTob: string): string {
    return stdVoidTob(originalTob);
  }

  private notWired(method: string): never {
    throw new MedicaidAdapterError(
      "ADAPTER_NOT_WIRED",
      "OR",
      `Oregon adapter ${method}() requires a live OHA MMIS / CCO endpoint, not yet configured.`,
      OPS_HINT,
    );
  }
  private requireGateway(method: string): OregonGatewayPort {
    if (!this.gateway) this.notWired(method);
    return this.gateway;
  }

  async eligibilityCheck(args: Parameters<MedicaidAdapter["eligibilityCheck"]>[0]) {
    return this.requireGateway("eligibilityCheck").eligibilityCheck({
      recipientIdPlain: args.recipientIdPlain,
      asOfServiceDate: args.asOfServiceDate,
      credentials: args.credentials,
    });
  }

  async assembleSubmissionPayload(
    args: Parameters<MedicaidAdapter["assembleSubmissionPayload"]>[0],
  ) {
    // Pure local render — no network, no gateway required (mirrors M23's X12-generation step being a
    // separate concern from transmission). See launch-gateway.ts's SIMPLIFICATION note: a JSON envelope,
    // not raw X12 837I.
    const { body, idempotencyKey } = assembleOregonSubmissionPayload(args.claimSnapshot);
    return {
      body,
      idempotencyKey,
      channel: "direct_mmis" as const,
      mcoId: args.claimSnapshot.mcoId,
    };
  }

  async submit(args: Parameters<MedicaidAdapter["submit"]>[0]) {
    return this.requireGateway("submit").submit({
      body: args.body,
      idempotencyKey: args.idempotencyKey,
      credentials: args.credentials,
    });
  }

  async poll(args: Parameters<MedicaidAdapter["poll"]>[0]) {
    return this.requireGateway("poll").poll(args);
  }

  async parseAcknowledgment(args: Parameters<MedicaidAdapter["parseAcknowledgment"]>[0]) {
    return this.requireGateway("parseAcknowledgment").parseAcknowledgment(args);
  }

  async parseRemittance(args: Parameters<MedicaidAdapter["parseRemittance"]>[0]) {
    return this.requireGateway("parseRemittance").parseRemittance(args);
  }

  async rateLookup(args: Parameters<MedicaidAdapter["rateLookup"]>[0]) {
    return this.requireGateway("rateLookup").rateLookup(args);
  }

  async healthy(): Promise<{
    ok: boolean;
    lastChecked: string;
    latencyMs: number;
    channelStatus: Record<string, "up" | "degraded" | "down">;
  }> {
    if (!this.gateway) {
      return {
        ok: false,
        lastChecked: "1970-01-01T00:00:00.000Z",
        latencyMs: 0,
        channelStatus: { direct_mmis: "down", cco_clearinghouse: "down" },
      };
    }
    // The interface's healthy() carries no PE/credentials — report "gateway wired" rather than probing a
    // specific PE's endpoint (that per-PE probe is the launch-gateway's own healthy(credentials), used
    // directly by the M24 worker's state-channel-health cron, not through this boundary).
    return {
      ok: true,
      lastChecked: new Date().toISOString(),
      latencyMs: 0,
      channelStatus: { direct_mmis: "up", cco_clearinghouse: "up" },
    };
  }
}
