import type { DbClient } from "@wardenx/db";
import { describe, expect, it } from "vitest";
import { createDbDocumentRouteService } from "./documents-route-service-db";

const UNTOUCHED_DB = new Proxy(
  {},
  {
    get() {
      throw new Error("document upload refusal must not touch the database");
    },
  },
) as DbClient;

describe("production document upload containment", () => {
  const service = createDbDocumentRouteService(UNTOUCHED_DB);

  it("rejects a new document before creating placeholder metadata", async () => {
    await expect(
      service.uploadDocument("11111111-1111-4111-8111-111111111111", "actor", {
        title: "Election statement",
        aggregateType: "admission",
        aggregateId: "22222222-2222-4222-8222-222222222222",
        patientId: "33333333-3333-4333-8333-333333333333",
        admissionId: null,
        retentionClass: "clinical_record",
        patientFacing: false,
      }),
    ).rejects.toMatchObject({ code: "DEGRADED", statusCode: 503 });
  });

  it("rejects a new version before creating a zero-byte version row", async () => {
    await expect(
      service.uploadVersion(
        "11111111-1111-4111-8111-111111111111",
        "44444444-4444-4444-8444-444444444444",
      ),
    ).rejects.toMatchObject({ code: "DEGRADED", statusCode: 503 });
  });
});
