// apps/backend/__tests__/document-extraction.test.ts — M22-T08.
//
// Proves the backend's DocLens Phase-1 wiring (§32 / §8.10 / §7.1 W1):
//   • the `documents.doclens` gate fails closed → `503 EXTRACTION_DISABLED` while the flag is OFF (Phase 1), and
//     falls through once a tenant has it ON;
//   • the gate preHandler sets `Retry-After: 0` and throws for an authorized caller when off;
//   • the backend pipeline runner consumes the M32 deny-stubs and fails safe at `awaiting_capability` (no AI runs,
//     no chart write, no auto-commit) — ready to flip live when M32 registers the real capabilities.
import { describe, expect, it, vi } from "vitest";
import {
  type DocLensFeatureFlag,
  ExtractionDisabledError,
  assertDocLensEnabled,
  createDocLensPipelineRunner,
  phase1DocLensFlag,
  requireDocLensEnabled,
} from "../src/modules/22-documents/extraction/index";

const ORG = "11111111-1111-1111-1111-111111111111";

describe("M22-T08 — documents.doclens gate", () => {
  it("Phase-1 flag is OFF for every tenant", () => {
    expect(phase1DocLensFlag.isEnabled(ORG)).toBe(false);
    expect(phase1DocLensFlag.isEnabled("any-other-org")).toBe(false);
  });

  it("assertDocLensEnabled throws 503 EXTRACTION_DISABLED when off; passes when on", () => {
    const off = phase1DocLensFlag;
    expect(() => assertDocLensEnabled(off, ORG)).toThrow(ExtractionDisabledError);
    try {
      assertDocLensEnabled(off, ORG);
    } catch (e) {
      expect(e).toBeInstanceOf(ExtractionDisabledError);
      expect((e as ExtractionDisabledError).code).toBe("EXTRACTION_DISABLED");
      expect((e as ExtractionDisabledError).statusCode).toBe(503);
    }
    const on: DocLensFeatureFlag = { isEnabled: () => true };
    expect(() => assertDocLensEnabled(on, ORG)).not.toThrow();
  });

  it("preHandler sets Retry-After: 0 and throws for an authorized caller while off", async () => {
    const header = vi.fn();
    const request = { context: { organizationId: ORG } } as never;
    const reply = { header } as never;
    const handler = requireDocLensEnabled(phase1DocLensFlag);
    await expect(handler(request, reply)).rejects.toBeInstanceOf(ExtractionDisabledError);
    expect(header).toHaveBeenCalledWith("Retry-After", "0");
  });

  it("preHandler falls through (no throw, no Retry-After) when the tenant flag is ON", async () => {
    const header = vi.fn();
    const request = { context: { organizationId: ORG } } as never;
    const reply = { header } as never;
    const handler = requireDocLensEnabled({ isEnabled: () => true });
    await expect(handler(request, reply)).resolves.toBeUndefined();
    expect(header).not.toHaveBeenCalled();
  });
});

describe("M22-T08 — DocLens pipeline runner over the M32 deny-stubs", () => {
  it("fails safe at awaiting_capability (no AI, no auto-commit) in Phase 1", async () => {
    let seq = 0;
    const runner = createDocLensPipelineRunner({ mintId: (p) => `${p}-${++seq}` });
    const out = await runner.run({ batchId: "b1", objectKey: "tenant-x/intake/b1/original.pdf", pageCount: 18 });
    expect(out).toEqual({ kind: "awaiting_capability", stage: "docling", missingCapability: "DoclingParser" });
  });
});
