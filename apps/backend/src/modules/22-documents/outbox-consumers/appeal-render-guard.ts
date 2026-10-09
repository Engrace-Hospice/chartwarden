// apps/backend/src/modules/22-documents/outbox-consumers/appeal-render-guard.ts - GAP-036. The render-time half of
// the appeal packet's enclosure rules. M25 validated every enclosure at submit, but the render is a separate step
// (an outbox hop, possibly retried): a document can be superseded, destroyed, or reclassified to 42 CFR Part 2
// in between. Before M22 draws a letter that names the documents, it re-reads each one through its OWN
// `DocumentReader` and refuses - a settled refusal, never a retry into a disclosure - if any may no longer be named.
// Fail-closed: a document that cannot be read counts as not found.
//
// Only references already in the typed payload are read; no document content or title is fetched or logged. The
// patient link was proven at submit (the claim's patient), so it is not re-derived here.
import { runWithRequestContext } from "@wardenx/tenancy";
import { type DocumentReader, appealEnclosureRefusal } from "@wardenx/types";

/** M22's own `DocumentReader`, narrowed to the one arm the guard reads. */
export type AppealRenderGuardDocuments = Pick<DocumentReader, "documentMetadata">;

export interface RenderGuardRequest {
  readonly organizationId: string;
  readonly templateKey: string;
  readonly content: Record<string, unknown>;
}

/** Why the render must not proceed. `detail` is `<documentId>:<reason>` - ids and a reason code, never content. */
export interface RenderGuardRefusal {
  readonly detail: string;
}

const APPEAL_PACKET_TEMPLATE_KEY = "appeal_packet";

/** The document ids an appeal packet payload names (supporting documents, then the bundle), tolerant of shape. */
export function appealEnclosureIds(content: Record<string, unknown>): string[] {
  const idOf = (v: unknown): string | null => {
    if (typeof v !== "object" || v === null) return null;
    const id = (v as Record<string, unknown>).documentId;
    return typeof id === "string" && id.length > 0 ? id : null;
  };
  const supporting = Array.isArray(content.supportingDocuments) ? content.supportingDocuments : [];
  return [...supporting.map(idOf), idOf(content.medicalRecordsBundleRef)].filter(
    (id): id is string => id !== null,
  );
}

export function buildAppealPacketRenderGuard(documents: () => AppealRenderGuardDocuments) {
  return async (request: RenderGuardRequest): Promise<RenderGuardRefusal | null> => {
    if (request.templateKey !== APPEAL_PACKET_TEMPLATE_KEY) return null;
    for (const documentId of appealEnclosureIds(request.content)) {
      // The reader opens the AMBIENT request context's tenant, and the outbox dispatcher runs a consumer outside
      // any request: give the read an explicit context for the row's org (never a payload-carried one).
      const digest = await runWithRequestContext(
        { organizationId: request.organizationId, userId: "" },
        async () =>
          documents().documentMetadata({
            documentId: documentId as never,
            organizationId: request.organizationId as never,
          }),
      ).catch(() => null);
      const reason = appealEnclosureRefusal(digest, null);
      if (reason !== null) return { detail: `${documentId}:${reason}` };
    }
    return null;
  };
}
