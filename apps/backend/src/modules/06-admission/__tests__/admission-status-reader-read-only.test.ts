// GAP-159 — the M31 post-discharge read-only gate was dead code: `AdmissionStatusReader.isDischargedReadOnly`
// was optional on the interface and implemented nowhere, so the portal write gate always answered false.
import { describe, expect, it, vi } from "vitest";
import { createAdmissionStatusReader } from "../seams/readers";
import { createInMemoryAdmissionReaderStore } from "../seams/store";

const { store } = createInMemoryAdmissionReaderStore();

describe("createAdmissionStatusReader.isDischargedReadOnly", () => {
  it("exposes the probe when one is supplied and delegates org + patient to it", async () => {
    const probe = vi.fn(async () => true);
    const reader = createAdmissionStatusReader(store, { isDischargedReadOnly: probe });
    await expect(reader.isDischargedReadOnly?.("org-1", "patient-1")).resolves.toBe(true);
    expect(probe).toHaveBeenCalledWith("org-1", "patient-1");
  });

  it("leaves the method unbound when no probe is supplied (the portal gate stays fail-open)", () => {
    const reader = createAdmissionStatusReader(store);
    expect(reader.isDischargedReadOnly).toBeUndefined();
  });
});
