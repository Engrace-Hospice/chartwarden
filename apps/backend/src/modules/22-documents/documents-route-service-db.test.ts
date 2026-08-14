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

/** Both ids are real-shaped: a write now carries the audit actor AND the membership (GAP-039). */
const ACTOR = {
  userId: "55555555-5555-4555-8555-555555555555",
  membershipId: "66666666-6666-4666-8666-666666666666",
};

describe("production document upload containment", () => {
  const service = createDbDocumentRouteService(UNTOUCHED_DB);

  it("rejects a new document before creating placeholder metadata", async () => {
    await expect(
      service.uploadDocument("11111111-1111-4111-8111-111111111111", ACTOR, {
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
        ACTOR,
        "44444444-4444-4444-8444-444444444444",
      ),
    ).rejects.toMatchObject({ code: "DEGRADED", statusCode: 503 });
  });
});
