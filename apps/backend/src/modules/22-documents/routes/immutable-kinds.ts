// apps/backend/src/modules/22-documents/routes/immutable-kinds.ts — document kinds no generic write route may change.
//
// A signed BAA between ChartWarden and a tenant (`tenant_baa`) is filed once by a platform operator through the dedicated onboarding route;
// it is the evidence behind the go-live BAA guard. The tenant's own documents routes (a new version, a metadata edit, a link, a tag) must
// not be able to alter it, whatever documents.* keys the tenant's user holds. Every generic write path checks this where it locks the
// document row: the server upload (`lockWritableDocument`), the presigned upload's two version steps, and the metadata service's
// `lockDocForWrite` (patch, link, add / remove tag).
import { ChartWardenError } from "@chartwarden/types";

/** `document_aggregate_type` values that are written once, by a dedicated route, and never changed by the generic ones. */
const OPERATOR_FILED_KINDS: ReadonlySet<string> = new Set(["tenant_baa"]);

/** 409 DOCUMENT_IMMUTABLE for a kind the generic write routes may not change. */
export function assertKindWritable(aggregateType: string): void {
  if (!OPERATOR_FILED_KINDS.has(aggregateType)) return;
  throw new ChartWardenError(
    "DOCUMENT_IMMUTABLE",
    "this kind of document is filed once by ChartWarden support and cannot be changed here",
    409,
  );
}
