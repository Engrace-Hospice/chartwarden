import { describe, expect, it } from "vitest";
import { eraPullBindingForOrg, shouldRunLegacyEraPullFor } from "../claimmd-era-config";

// The M25 ERA pull is decided per account (owner decision 2026-11-08): a tenant's OWN Claim.MD account keeps its per-org pull;
// the platform's Claim.MD account yields to main's capture/delivery; any other vendor always pulls.
const transport = { vendor: "x" } as const;
const CASES = [
  {
    name: "tenant claimmd",
    binding: { vendor: "claimmd", account: "tenant" as const },
    off: true,
    on: true,
  },
  { name: "platform claimmd", binding: { vendor: "claimmd" }, off: true, on: false },
  {
    name: "tenant stedi",
    binding: { vendor: "stedi", account: "tenant" as const },
    off: true,
    on: true,
  },
  { name: "unbound", binding: { vendor: null }, off: true, on: true },
];

describe("the M25 ERA pull per account", () => {
  for (const c of CASES) {
    for (const [label, flags, expected] of [
      ["capture off", { captureEnabled: false, deliveryEnabled: false }, c.off],
      ["capture on", { captureEnabled: true, deliveryEnabled: false }, c.on],
      ["delivery on", { captureEnabled: false, deliveryEnabled: true }, c.on],
    ] as const) {
      it(`${c.name}, ${label}: ${expected ? "pulls" : "does not pull"}`, () => {
        expect(shouldRunLegacyEraPullFor(c.binding, flags)).toBe(expected);
        const resolved = eraPullBindingForOrg({ ...c.binding, transport }, flags);
        // A skipped binding becomes unbound (vendor null), which the pull treats as "nothing for this org".
        expect(resolved.vendor).toBe(expected ? c.binding.vendor : null);
        expect(resolved.transport).toBe(transport);
      });
    }
  }
});
