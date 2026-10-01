// F-209 (#251) — unit coverage for the M23 diagnosis seam wiring that needs no database: the port-absent
// fail-closed stub in `buildM23BootAssemblyService`, the M7 pass-through adapter, and the M38 `icd10Billable`
// resolution rule (active + billable leaf only; missing => false; no codes => no M38 round trip).
import { describe, expect, it, vi } from "vitest";
import { buildM23BootAssemblyService, buildM23BootDiagnosesSeam } from "../services/boot-assembly";
import {
  type M38TerminologyReader,
  buildM23DiagnosesAdapter,
  buildM23TerminologyAdapter,
} from "../services/claim-assembly-seam-adapters";

const concept = (status: string, isBillableLeaf: boolean) => ({
  status,
  properties: { isBillableLeaf },
});

function fakeM38(concepts: Record<string, ReturnType<typeof concept>>) {
  const lookupBatch = vi.fn(async (_system: "icd10cm", codes: readonly string[], _asOf?: Date) => {
    const m = new Map<string, ReturnType<typeof concept>>();
    for (const c of codes) {
      const hit = concepts[c];
      if (hit) m.set(c, hit);
    }
    return m;
  });
  const reader: M38TerminologyReader = {
    // biome-ignore lint/correctness/useYield: an empty value set is all these tests need
    async *expand() {
      return;
    },
    lookupBatch,
  };
  return { reader, lookupBatch };
}

describe("buildM23TerminologyAdapter — icd10Billable (F-209)", () => {
  it("true only for an active billable leaf; non-leaf, deprecated and unknown codes are false", async () => {
    const { reader, lookupBatch } = fakeM38({
      "C34.90": concept("active", true),
      C34: concept("active", false),
      "R99.9": concept("deprecated", true),
    });
    const seam = buildM23TerminologyAdapter(() => reader);
    const res = await seam.resolveForClaim("org", "2026-06-01", [
      "C34.90",
      "C34",
      "R99.9",
      "ZZZ.0",
      "C34.90",
    ]);
    expect(res.icd10Billable).toEqual({
      "C34.90": true,
      C34: false,
      "R99.9": false,
      "ZZZ.0": false,
    });
    // One bulk call over the DISTINCT codes, as-of the service date.
    expect(lookupBatch).toHaveBeenCalledTimes(1);
    expect(lookupBatch.mock.calls[0]?.[1]).toEqual(["C34.90", "C34", "R99.9", "ZZZ.0"]);
    expect(lookupBatch.mock.calls[0]?.[2]).toEqual(new Date("2026-06-01T00:00:00Z"));
  });

  it("makes no M38 lookup when the claim has no diagnosis codes", async () => {
    const { reader, lookupBatch } = fakeM38({});
    const res = await buildM23TerminologyAdapter(() => reader).resolveForClaim("org", "2026-06-01");
    expect(res.icd10Billable).toEqual({});
    expect(lookupBatch).not.toHaveBeenCalled();
  });
});

describe("buildM23DiagnosesAdapter (F-209)", () => {
  it("passes the M7 rows through as position/code/relationship only", async () => {
    const forRange = vi.fn(async () => ({
      sequence: [{ position: 1, code: "C34.90", relationship: "terminal" as const }],
      withheldForConsentCount: 0,
      terminalWithheldForConsent: false,
    }));
    const seam = buildM23DiagnosesAdapter({ forRange });
    const range = { from: "2026-06-01", to: "2026-06-07" };
    expect(await seam.forRange("org", "pat", range)).toEqual({
      sequence: [{ position: 1, code: "C34.90", relationship: "terminal" }],
      withheldForConsentCount: 0,
      terminalWithheldForConsent: false,
    });
    expect(forRange).toHaveBeenCalledWith("org", "pat", range);
  });

  it("F-214: carries the Part 2 withheld summary through unchanged (count + terminal flag only)", async () => {
    const seam = buildM23DiagnosesAdapter({
      forRange: async () => ({
        sequence: [{ position: 1, code: "J44.9", relationship: "related" as const }],
        withheldForConsentCount: 2,
        terminalWithheldForConsent: true,
      }),
    });
    expect(await seam.forRange("org", "pat", { from: "2026-06-01", to: "2026-06-07" })).toEqual({
      sequence: [{ position: 1, code: "J44.9", relationship: "related" }],
      withheldForConsentCount: 2,
      terminalWithheldForConsent: true,
    });
  });
});

describe("buildM23BootDiagnosesSeam — m7ClaimDiagnoses port absent (F-209)", () => {
  it("is a fail-closed SEAM_UNBOUND stub, never an empty sequence", () => {
    const seam = buildM23BootDiagnosesSeam(undefined);
    expect(() =>
      seam.forRange("org", "pat", { from: "2026-06-01", to: "2026-06-07" }),
    ).toThrowError(expect.objectContaining({ code: "SEAM_UNBOUND", statusCode: 503 }));
  });

  it("delegates to the injected M7 port when bound", async () => {
    const seam = buildM23BootDiagnosesSeam({
      forRange: async () => ({
        sequence: [{ position: 1, code: "C34.90", relationship: "terminal" as const }],
        withheldForConsentCount: 0,
        terminalWithheldForConsent: false,
      }),
    });
    const res = await seam.forRange("org", "pat", { from: "2026-06-01", to: "2026-06-07" });
    expect(res.sequence).toEqual([{ position: 1, code: "C34.90", relationship: "terminal" }]);
  });

  it("buildM23BootAssemblyService accepts the port optionally", () => {
    expect(() => buildM23BootAssemblyService({} as never, {})).not.toThrow();
    expect(() =>
      buildM23BootAssemblyService({} as never, {
        m7ClaimDiagnoses: {
          forRange: async () => ({
            sequence: [],
            withheldForConsentCount: 0,
            terminalWithheldForConsent: false,
          }),
        },
      }),
    ).not.toThrow();
  });
});
