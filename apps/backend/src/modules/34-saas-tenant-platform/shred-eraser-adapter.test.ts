import type { DataClass, DataEraser } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  TENANT_SHRED_ERASER_SUBJECT,
  TenantShredLegalHoldRefusal,
  createTenantShredEraserCallback,
} from "./shred-eraser-adapter";

describe("M34 tenant shred eraser adapter", () => {
  it("fans every data class out at its declared subject grain", async () => {
    const calls: Array<{ dataClass: DataClass; subjectId: string }> = [];
    const eraserFor = (dataClass: DataClass): DataEraser => ({
      async erase(_ctx, subjectId) {
        calls.push({ dataClass, subjectId });
        return { erased: 1 };
      },
    });
    const callback = createTenantShredEraserCallback({
      subjects: {
        patientIds: async () => ["patient-1", "patient-2"],
        soleTenantUserIds: async () => ["user-1"],
      },
      eraserFor,
    });

    const receipts = await callback.callbackAllEraserFns({
      orgId: "org-1",
      destructionCertId: "cert-1",
    });

    expect(receipts.map((receipt) => receipt.module).sort()).toEqual(
      Object.keys(TENANT_SHRED_ERASER_SUBJECT).sort(),
    );
    expect(calls.filter((call) => call.dataClass === "clinical_record")).toEqual([
      { dataClass: "clinical_record", subjectId: "patient-1" },
      { dataClass: "clinical_record", subjectId: "patient-2" },
    ]);
    expect(calls).toContainEqual({ dataClass: "saas_tenant_platform_class", subjectId: "org-1" });
    expect(calls).toContainEqual({ dataClass: "identity", subjectId: "user-1" });
  });

  it("surfaces Part 2 refusals and blocks legal-hold refusals", async () => {
    const partTwo = createTenantShredEraserCallback({
      subjects: { patientIds: async () => ["patient-1"], soleTenantUserIds: async () => [] },
      eraserFor: (dataClass) => ({
        erase: async () =>
          dataClass === "consent" ? { erased: 0, refusedPartTwo: 3 } : { erased: 0 },
      }),
    });
    await expect(
      partTwo.callbackAllEraserFns({ orgId: "org-1", destructionCertId: "cert-1" }),
    ).resolves.toContainEqual({
      module: "consent",
      outcome: "refused_part_two_retention",
      refusedRows: 3,
    });

    const held = createTenantShredEraserCallback({
      subjects: { patientIds: async () => ["patient-1"], soleTenantUserIds: async () => [] },
      eraserFor: (dataClass) => ({
        erase: async () =>
          dataClass === "documents" ? { erased: 0, refusedLegalHold: 1 } : { erased: 0 },
      }),
    });
    await expect(
      held.callbackAllEraserFns({ orgId: "org-1", destructionCertId: "cert-1" }),
    ).rejects.toBeInstanceOf(TenantShredLegalHoldRefusal);
  });
});
