// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/onboarding-baa-document.ts — the operator's BAA upload (onboarding step 3,
// and a live tenant's renewal), on the data service's one-transaction write: shared onboarding lock, status gate (`BAA_DOCUMENT_UPLOAD_STATUSES`), the document filed
// through M22's own pipeline on THAT transaction (scoped to the tenant's `app.org_id`), and the platform audit row, all committing or
// rolling back together. A failure after the object was stored takes the object back out: the rows roll back, the object would not.
import type { DbClient } from "@chartwarden/db";
import { ChartWardenError } from "@chartwarden/types";
import type {
  OnboardingBaaDocument,
  OnboardingBaaDocumentPort,
  OnboardingBaaDocumentUpload,
  OnboardingWriteScope,
} from "../../../../bootstrap/onboarding-baa-document-port";
import {
  ONBOARDING_DATA_AUDIT_EVENTS,
  type OnboardingAuditTarget,
  type OnboardingOperator,
} from "./onboarding-data-audit";
import type { WriteResult, WriteSpec } from "./onboarding-write-types";

/**
 * The statuses in which an operator may file a tenant's signed BAA: a tenant that is being set up (step 3), or live (a renewal: the register
 * requires an executed BAA's document, so a live tenant whose agreement is renewed needs its new signed copy filed). An explicit allowlist,
 * in the style of CLEARINGHOUSE_SWITCH_STATUSES: a tenant that is offboarding, retained or being destroyed has no agreement to renew.
 */
export const BAA_DOCUMENT_UPLOAD_STATUSES: ReadonlySet<string> = new Set([
  "provisioning",
  "onboarding",
  "active",
  "at_risk",
  "suspended",
]);

/** The data service's `write` and `scopeOf`, passed in so this file imports no value from the service that uses it. */
export interface BaaDocumentWriteDeps {
  readonly port: OnboardingBaaDocumentPort | undefined;
  readonly write: <T>(
    op: OnboardingOperator,
    orgSlug: string,
    spec: WriteSpec,
    run: (tx: DbClient, target: OnboardingAuditTarget) => Promise<WriteResult<T>>,
  ) => Promise<T>;
  readonly scopeOf: (op: OnboardingOperator, organizationId: string) => OnboardingWriteScope;
  readonly warn?: (message: string, context: Record<string, unknown>) => void;
}

export async function uploadTenantBaaDocument(
  deps: BaaDocumentWriteDeps,
  op: OnboardingOperator,
  orgSlug: string,
  input: { readonly contentBase64: string; readonly mimeType: string },
  reason: string,
): Promise<OnboardingBaaDocument> {
  const { port } = deps;
  if (!port) {
    throw new ChartWardenError(
      "ONBOARDING_BAA_DOCUMENTS_UNBOUND",
      "the BAA document adapter is not bound in this deployment",
      503,
    );
  }
  let filed: OnboardingBaaDocumentUpload | undefined;
  return deps.write(
    op,
    orgSlug,
    {
      event: ONBOARDING_DATA_AUDIT_EVENTS.baaDocumentUploaded,
      resourceKind: "tenant_baa_document",
      reason,
      allowedStatuses: BAA_DOCUMENT_UPLOAD_STATUSES,
      // The rows roll back with the transaction, the stored object would not: take it out, unless the COMMIT itself failed (the rows
      // may have landed, and deleting the file of a document that exists would lose the agreement): then keep it and say so, naming the
      // objectKey. No sweep exists yet to reclaim one whose commit did not land (an open item in ADR-0053's amendment): reconcile by objectKey.
      onFailure: async ({ commitReached }) => {
        if (!filed) return;
        if (!commitReached) {
          await filed.discard();
          return;
        }
        deps.warn?.(
          "m34.onboarding BAA upload: the commit failed after the document was filed; the object is kept because the commit may have landed (if it did not, the object is an orphan: no sweep exists yet; reconcile by objectKey)",
          {
            documentId: filed.resourceId,
            objectKey: filed.objectKey,
            organizationId: op.organizationId,
          },
        );
      },
    },
    async (tx, target) => {
      filed = await port.upload(tx, deps.scopeOf(op, target.organizationId), input);
      return { value: filed.view, resourceId: filed.resourceId, detail: filed.detail };
    },
  );
}
