// apps/backend/src/modules/22-documents/seams/providers.ts — M22-T04 (§4.3 / §7.2 W2 render handshake).
//
// The two write-side seams M22 publishes into the M1 registry:
//
//   • `DocumentRenderer` — the §7.2 W2 render-from-typed-payload handshake. {@link createDocumentRenderer}
//     orchestrates it over the PURE M22-T03 lifecycle domain (the §2.2.2 object-key model + the
//     create/add-version guards), an injected {@link DocumentRenderAdapter} (the PDF engine — a deterministic
//     Phase-1 stand-in here; the §4.5 react-pdf/puppeteer template library lands in M22-T05), the
//     {@link DocumentStorageProvider} seam (byte storage + integrity hash), and the {@link DocumentRenderStore}
//     (the append-only `document`/`document_version` ledger + the W2 aggregate back-reference index). Registering
//     the real impl over the boot deny-stub CLOSES M39's Wave-C `DocumentRenderer` deny-stub (M39 consumes it
//     directly via getSeam). The M6/M9/M11/M12/M13 PDF stubs close over the §4.11 `*.document_requested` outbox
//     handshake (M22-T06), not here.
//
//   • `DocumentStorageProvider` — the per-tenant object-storage port (re-exported from ./store).
//
// Mirrors the M18-T05 seams/providers.ts precedent: small factories over an injected store, fully unit-testable.
import { randomUUID } from "node:crypto";
import { lookupFormTemplate } from "@wardenx/forms";
import type {
  DocumentAggregateType,
  DocumentRenderer,
  DocumentRetentionClass,
  DocumentSourceKind,
  DocumentStorageProvider,
  OrgScope,
} from "@wardenx/types";
import { addVersion, createDocument, renderedObjectKey, require_ } from "../domain/index";
import type { DocumentRenderStore, StoredDocument } from "./store";

export { createInMemoryDocumentStorageProvider } from "./store";

/** What a render produces: the document bytes + their mime type. The §4.5 template library (M22-T05) supplies the real engine. */
export interface DocumentRenderOutput {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

/** The PDF-engine port the renderer calls to turn a typed payload into bytes (`react_pdf`/`puppeteer` in M22-T05). */
export interface DocumentRenderAdapter {
  render(input: { templateKey: string; payload: unknown }): Promise<DocumentRenderOutput> | DocumentRenderOutput;
}

/** The template-manifest facts the lifecycle needs (the §4.5 taxonomy row for a `templateKey`). */
export interface TemplateManifest {
  readonly documentType: DocumentAggregateType;
  readonly retentionClass: DocumentRetentionClass;
  readonly sourceKind: DocumentSourceKind;
  /** The payload field carrying the source aggregate's id (so a re-render appends a version, not a new document). */
  readonly aggregateIdField: string | null;
}

/**
 * The Phase-1 default template-manifest resolver. M22-T04 only needs the `consent_record` row (M39's §4.4 D15
 * deny-stub closure target); every other `templateKey` resolves to a safe generic default. The AUTHORITATIVE
 * §4.5 manifest (all 31 templates with their retention/source/engine) is injected from the Form Template Library
 * in M22-T05 — this resolver is the seam's fallback, not that table.
 */
export function defaultTemplateManifest(templateKey: string): TemplateManifest {
  if (templateKey === "consent_record") {
    return {
      documentType: "consent_record",
      retentionClass: "compliance",
      sourceKind: "consent_capture",
      aggregateIdField: "consentRecordId",
    };
  }
  return { documentType: "other", retentionClass: "clinical_record", sourceKind: "form_render", aggregateIdField: null };
}

/**
 * The §4.5 Form-Template-Library-backed manifest resolver (M22-T06). The authoritative platform-floor library
 * (`@wardenx/forms`) is the source of truth for the `aggregateType` a `templateKey` instantiates and its floor
 * `retentionClass` (D23 SUD upgrades are decided per-render by the consumer, not by this static resolver). Every
 * library template renders as a `form_render` source; the `consent_record` row keeps its `consent_capture` source
 * + `consentRecordId` aggregate field (M39's §4.4 D15 path) by delegating to {@link defaultTemplateManifest}. An
 * unknown key falls through to the generic `other` default. This is the resolver the §4.11 render-handshake
 * consumers (M22-T06) and the M39 consent render run through, so a rendered `document` carries its true
 * `aggregateType` (the W2 back-ref index the `RenderedDocumentProvider` reads) — NB the consumer always supplies
 * the source aggregate id under the uniform `aggregateId` payload field, so `aggregateIdField` stays `null`.
 */
export function formsTemplateManifest(templateKey: string): TemplateManifest {
  if (templateKey === "consent_record") return defaultTemplateManifest(templateKey);
  const entry = lookupFormTemplate(templateKey);
  if (!entry) return defaultTemplateManifest(templateKey);
  return {
    documentType: entry.aggregateType,
    retentionClass: entry.retentionClass,
    sourceKind: "form_render",
    aggregateIdField: null,
  };
}

/** The Phase-1 default render adapter: deterministic placeholder bytes (stable sha for stable input — test-friendly). */
export const placeholderRenderAdapter: DocumentRenderAdapter = {
  render({ templateKey, payload }) {
    const body = JSON.stringify({ templateKey, payload: payload ?? null });
    return { bytes: new TextEncoder().encode(body), mimeType: "application/pdf" };
  },
};

/** Deps for {@link createDocumentRenderer} (all injectable so the impl is clock-/RNG-free in tests). */
export interface DocumentRendererDeps {
  readonly store: DocumentRenderStore;
  readonly storage: DocumentStorageProvider;
  readonly renderAdapter?: DocumentRenderAdapter;
  readonly resolveTemplateManifest?: (templateKey: string) => TemplateManifest;
  readonly mintId?: (prefix: "doc" | "ver") => string;
  readonly now?: () => string;
}

function readString(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Build the real `DocumentRenderer` (§7.2 W2). For a given (aggregateType, aggregateId) the FIRST render creates
 * a `document` at v1; a re-render (e.g. an M8 encounter addendum) APPENDS a new `document_version` and flips
 * `active_version_id` — never a new document (W2). The pure M22-T03 lifecycle domain runs the v1 / monotonicity /
 * version-shape guards; the outbox `m22.document.rendered` emission + the M4 write-audit are the service-layer's
 * job (M22-T06/T07) — this slice persists the row and the W2 back-reference index the T05
 * `RenderedDocumentProvider` reads.
 */
export function createDocumentRenderer(deps: DocumentRendererDeps): DocumentRenderer {
  const renderAdapter = deps.renderAdapter ?? placeholderRenderAdapter;
  const resolveManifest = deps.resolveTemplateManifest ?? formsTemplateManifest;
  const mintId = deps.mintId ?? ((prefix) => `${prefix}-${randomUUID()}`);
  const now = deps.now ?? (() => new Date().toISOString());

  return {
    async render(scope: OrgScope, templateKey: string, payload: unknown): Promise<{ documentId: string }> {
      const manifest = resolveManifest(templateKey);
      const rec = (payload ?? {}) as Record<string, unknown>;
      const patientId = readString(rec, "patientId");
      const aggregateId = manifest.aggregateIdField
        ? readString(rec, manifest.aggregateIdField)
        : readString(rec, "aggregateId");
      // The §7.2 W2 render targets are patient-bound; the §2.2.2 object key is patient-prefixed (D1). Refuse a
      // render with no patient — fail closed rather than mint a key with an empty prefix.
      require_(
        patientId !== null,
        "DOCUMENT_OBJECT_KEY_REQUIRED",
        `the ${templateKey} render payload must carry a non-empty patientId (the §2.2.2 object key is patient-prefixed).`,
      );

      const output = await renderAdapter.render({ templateKey, payload });
      const existing = deps.store.findByAggregate({
        organizationId: scope.orgId,
        aggregateType: manifest.documentType,
        aggregateId,
      });
      const renderedAt = now();

      if (existing) {
        // Re-render → a new version on the SAME document (W2 addendum shape). The domain enforces monotonicity.
        const versionNumber = existing.activeVersionNumber + 1;
        const versionId = mintId("ver");
        const minioObjectKey = renderedObjectKey({
          patientId: patientId as string,
          documentType: manifest.documentType,
          documentId: existing.id,
          versionId,
        });
        const { sha256Hex, byteSize } = await deps.storage.putRenderedDocument({
          scope,
          tenantId: scope.orgId,
          objectKey: minioObjectKey,
          bytes: output.bytes,
          mimeType: output.mimeType,
        });
        addVersion({
          currentStatus: "active",
          currentActiveVersionNumber: existing.activeVersionNumber,
          newVersion: {
            versionNumber,
            minioObjectKey,
            sha256Hex,
            mimeType: output.mimeType,
            uploadedByKind: "system_render",
            uploadedByMembershipId: null,
          },
        });
        deps.store.appendVersion(existing.id, {
          id: versionId,
          versionNumber,
          minioObjectKey,
          sha256Hex,
          mimeType: output.mimeType,
          byteSize,
          renderedAt,
        });
        return { documentId: existing.id };
      }

      // First render → a new document at v1.
      const documentId = mintId("doc");
      const versionId = mintId("ver");
      const minioObjectKey = renderedObjectKey({
        patientId: patientId as string,
        documentType: manifest.documentType,
        documentId,
        versionId,
      });
      const { sha256Hex, byteSize } = await deps.storage.putRenderedDocument({
        scope,
        tenantId: scope.orgId,
        objectKey: minioObjectKey,
        bytes: output.bytes,
        mimeType: output.mimeType,
      });
      createDocument({
        retentionClass: manifest.retentionClass,
        sourceKind: manifest.sourceKind,
        firstVersion: {
          versionNumber: 1,
          minioObjectKey,
          sha256Hex,
          mimeType: output.mimeType,
          uploadedByKind: "system_render",
          uploadedByMembershipId: null,
        },
      });
      const doc: StoredDocument = {
        id: documentId,
        organizationId: scope.orgId,
        patientId,
        aggregateType: manifest.documentType,
        aggregateId,
        title: templateKey,
        retentionClass: manifest.retentionClass,
        sourceKind: manifest.sourceKind,
        activeVersionId: versionId,
        activeVersionNumber: 1,
        versions: [
          { id: versionId, versionNumber: 1, minioObjectKey, sha256Hex, mimeType: output.mimeType, byteSize, renderedAt },
        ],
        renderedAt,
      };
      deps.store.createDocument(doc);
      return { documentId };
    },
  };
}
