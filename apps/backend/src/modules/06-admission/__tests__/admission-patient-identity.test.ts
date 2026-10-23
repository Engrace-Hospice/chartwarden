import { describe, expect, it } from "vitest";
import { createInMemoryAdmissionBackend } from "../routes/service";

describe("admission patient identity projection", () => {
  it("adds only a same-organization identity to authorized admission rows", async () => {
    const { service } = createInMemoryAdmissionBackend({
      records: [
        { id: "admission-1", organizationId: "org-a", kind: "admission", patientId: "patient-1" },
        { id: "admission-2", organizationId: "org-a", kind: "admission", patientId: "patient-2" },
        { id: "admission-3", organizationId: "org-b", kind: "admission", patientId: "patient-3" },
      ],
      patientIdentities: {
        "patient-1": {
          id: "patient-1",
          organizationId: "org-a",
          firstName: "Avery",
          lastName: "Case",
          mrn: "MRN-A",
        },
        "patient-2": {
          id: "patient-2",
          organizationId: "org-b",
          firstName: "Other",
          lastName: "Tenant",
          mrn: "MRN-B",
        },
      },
    });

    const page = await service.listAdmissions(
      "org-a",
      {},
      { patientIds: ["patient-1", "patient-2"] },
    );
    expect(page.items).toHaveLength(2);
    expect(page.items.find((item) => item.id === "admission-1")?.patient).toEqual({
      id: "patient-1",
      firstName: "Avery",
      lastName: "Case",
      mrn: "MRN-A",
    });
    expect(page.items.find((item) => item.id === "admission-2")?.patient).toBeNull();
    expect(await service.getAdmission("org-a", "admission-1")).toMatchObject({
      patient: { id: "patient-1", firstName: "Avery", lastName: "Case", mrn: "MRN-A" },
    });
    expect(await service.getAdmission("org-a", "admission-3")).toBeNull();
  });
});
