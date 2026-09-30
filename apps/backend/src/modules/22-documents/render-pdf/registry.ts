import type { DocModel } from "./doc-model";
// apps/backend/src/modules/22-documents/render-pdf/registry.ts — the template -> real-PDF-renderer registry.
// A template key with an entry here renders a REAL, openable PDF; any other key keeps the deterministic
// stand-in (renderer.ts `renderBytes`), so adding a template is one row here and nothing else changes.
import { buildIdgMinutesDoc } from "./idg-minutes-doc";
import { buildIdgPacketDoc } from "./idg-packet-doc";
import { renderDocModelToPdf } from "./pdf-writer";

/** Builds the document model (pure) for one template from its render payload. */
export type DocModelBuilder = (payload: unknown) => DocModel;

export type PdfRendererRegistry = Readonly<Record<string, DocModelBuilder>>;

export const DEFAULT_PDF_RENDERERS: PdfRendererRegistry = {
  idg_minutes: buildIdgMinutesDoc,
  idg_patient_packet: buildIdgPacketDoc,
};

/** Real PDF bytes for `templateKey`, or `undefined` when no real renderer is registered for it. */
export function renderRegisteredPdf(
  templateKey: string,
  payload: unknown,
  registry: PdfRendererRegistry = DEFAULT_PDF_RENDERERS,
): Uint8Array | undefined {
  const build = Object.hasOwn(registry, templateKey) ? registry[templateKey] : undefined;
  return build === undefined ? undefined : renderDocModelToPdf(build(payload));
}
