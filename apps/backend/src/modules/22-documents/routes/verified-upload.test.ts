// The presigned (verified) upload's `initiate` validates its input before anything is issued. The tenant_baa kind is filed once by a
// platform operator through the onboarding port; the generic write routes refuse it (immutable-kinds.ts). Alongside the server upload's
// own refusal (server-upload.test.ts), the presigned upload's NEW document path must refuse the kind itself: the route schema is not the
// only thing that keeps a tenant from filing evidence of its own BAA.
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import { type InitiateVerifiedUploadInput, createVerifiedUploadService } from "./verified-upload";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP = "33333333-3333-4333-8333-333333333333";

const INPUT: InitiateVerifiedUploadInput = {
  mode: "new_document",
  targetDocumentId: null,
  patientId: null,
  admissionId: null,
  retentionClass: "operational",
  aggregateType: "tenant_baa",
  aggregateId: null,
  title: "Signed BAA",
  patientFacing: false,
  mimeType: "application/pdf",
  byteSize: 1024,
  sha256Hex: "a".repeat(64),
};

/** A store and a database that fail the test if anything past the validation touches them. */
function service() {
  const touched: string[] = [];
  const trap = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, prop) => {
          touched.push(`${name}.${String(prop)}`);
          throw new Error(`${name} was touched`);
        },
      },
    );
  const svc = createVerifiedUploadService({
    db: trap("db") as unknown as DbClient,
    objects: trap("objects") as never,
  });
  return { svc, touched };
}

describe("createVerifiedUploadService.initiate", () => {
  it("refuses an operator-filed kind (tenant_baa) on a new document with 409 DOCUMENT_IMMUTABLE, before the database or the store is touched", async () => {
    const { svc, touched } = service();
    await expect(
      svc.initiate({ organizationId: ORG, userId: USER, membershipId: MEMBERSHIP, input: INPUT }),
    ).rejects.toMatchObject({ code: "DOCUMENT_IMMUTABLE", statusCode: 409 });
    expect(touched).toEqual([]);
  });

  it("does not refuse an ordinary kind on that check (it goes on to the database, which the trap here refuses)", async () => {
    const { svc, touched } = service();
    await expect(
      svc.initiate({
        organizationId: ORG,
        userId: USER,
        membershipId: MEMBERSHIP,
        input: { ...INPUT, aggregateType: "other" as never },
      }),
    ).rejects.not.toMatchObject({ code: "DOCUMENT_IMMUTABLE" });
    expect(touched.length).toBeGreaterThan(0);
  });
});
