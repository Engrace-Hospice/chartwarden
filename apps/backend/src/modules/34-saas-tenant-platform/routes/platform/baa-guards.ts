// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/baa-guards.ts - what a platform BAA register write must
// satisfy, shared by the Drizzle service and its in-memory twin so the two cannot drift.
import { ChartWardenError } from "@chartwarden/types";

/**
 * An `executed` BAA must point at its executed document (the M22 document id of the signed PDF). The go-live BAA guard reads
 * the register's STATUS: without this, one operator could mark a BAA executed on their own word and the status alone would
 * satisfy the guard. 422 BAA_DOCUMENT_REQUIRED. Judged on the row AS IT WILL BE after the write.
 */
export function assertExecutedBaaHasDocument(input: {
  readonly baaStatus: string;
  readonly documentId: string | null | undefined;
}): void {
  if (input.baaStatus === "executed" && !input.documentId) {
    throw new ChartWardenError(
      "BAA_DOCUMENT_REQUIRED",
      "an executed BAA must reference its executed document (documentId): upload the signed agreement and link it",
      422,
      [
        {
          field: "documentId",
          code: "BAA_DOCUMENT_REQUIRED",
          message: "documentId is required when baaStatus is executed",
        },
      ],
    );
  }
}
