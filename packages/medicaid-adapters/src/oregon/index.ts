import { MedicaidAdapterError } from "../errors";
// @wardenx/medicaid-adapters — the Oregon reference adapter (D14). Engrace Hospice (Pendleton OR, CCN
// 381588) is the founding customer; Oregon Health Plan (OHP) via OHA DMAP + CCO routing is the Phase-1
// production target. This adapter ships the REAL declarative metadata + the pure helpers (TOB mapping, the
// OHP Member ID mod-10 format check). The live wire I/O (OHA MMIS 270/271 + 837I, CCO clearinghouse,
// 999/277CA/835 parsing) throws a structured ADAPTER_NOT_WIRED until the live endpoint + creds are
// configured — the same deferral posture as M23's MAC-HTTP/x12-gen. NOT a deny-stub (vendor has no
// '-deny-stub' suffix; metadata + helpers are real), so `isPhaseOneDenyStub('OR')` is false.
import type { MedicaidAdapter, MedicaidAdapterMetadata } from "../interface";
import { replacementTob as stdReplacementTob, voidTob as stdVoidTob } from "../tob";

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

  async eligibilityCheck(): Promise<never> {
    return this.notWired("eligibilityCheck");
  }
  async assembleSubmissionPayload(): Promise<never> {
    return this.notWired("assembleSubmissionPayload");
  }
  async submit(): Promise<never> {
    return this.notWired("submit");
  }
  async poll(): Promise<never> {
    return this.notWired("poll");
  }
  async parseAcknowledgment(): Promise<never> {
    return this.notWired("parseAcknowledgment");
  }
  async parseRemittance(): Promise<never> {
    return this.notWired("parseRemittance");
  }
  async rateLookup(): Promise<never> {
    return this.notWired("rateLookup");
  }

  async healthy(): Promise<{
    ok: boolean;
    lastChecked: string;
    latencyMs: number;
    channelStatus: Record<string, "up" | "degraded" | "down">;
  }> {
    return {
      ok: false,
      lastChecked: "1970-01-01T00:00:00.000Z",
      latencyMs: 0,
      channelStatus: { direct_mmis: "down", cco_clearinghouse: "down" },
    };
  }
}
