// apps/backend/src/modules/22-documents/render-pdf/registry.ts — the template -> real-PDF-renderer registry.
// A template key with an entry here renders its own bespoke layout; every other key renders its payload
// through the structured generic builder (generic-payload-doc.ts) - still a REAL, openable PDF, never the old
// JSON-behind-a-%PDF-header stand-in (GAP-033). Adding a bespoke layout is one row here and nothing else changes.
import { buildAdrResponseDoc } from "./adr-response-doc";
import { buildAppealPacketDoc } from "./appeal-packet-doc";
import type { DocModel } from "./doc-model";
import { buildElectionAddendumDoc } from "./election-addendum-doc";
import { buildElectionStatementDoc } from "./election-statement-doc";
import { COMPILED_FORMS } from "./forms";
import { buildGenericPayloadDoc } from "./generic-payload-doc";
import { buildIdgMinutesDoc } from "./idg-minutes-doc";
import { buildIdgPacketDoc } from "./idg-packet-doc";
import { renderDocModelToPdf } from "./pdf-writer";
import { isRec } from "./shared";
import {
  buildTriageSummaryAttendingDoc,
  buildTriageSummaryCaregiverDoc,
} from "./triage-summary-doc";

/** Builds the document model (pure) for one template from its render payload. */
export type DocModelBuilder = (payload: unknown) => DocModel;

export type PdfRendererRegistry = Readonly<Record<string, DocModelBuilder>>;

export const DEFAULT_PDF_RENDERERS: PdfRendererRegistry = {
  // GAP-033 Wave 1 - declarative FormSpec forms (render-pdf/forms): typed payload, allow-listed fields, fail
  // closed on a missing signature / patient identity. `abn` ships structure only (CMS wording pending).
  ...COMPILED_FORMS,
  idg_minutes: buildIdgMinutesDoc,
  idg_patient_packet: buildIdgPacketDoc,
  // F-224 (#248) — M19's caregiver / attending triage-call summaries (two templates, one builder each).
  triage_summary_caregiver: buildTriageSummaryCaregiverDoc,
  triage_summary_attending: buildTriageSummaryAttendingDoc,
  // FY2027 (CMS-1851-F) — the 42 CFR 418.24(c) addendum and the 418.24(b)(1)–(8) election statement.
  election_addendum: buildElectionAddendumDoc,
  election_statement: buildElectionStatementDoc,
  // GAP-036 - M25's typed AppealPacketRenderPayload (validated here; a malformed packet fails the render).
  appeal_packet: buildAppealPacketDoc,
  // Milestone 2b - M25's typed AdrPacketRenderPayload: the cover sheet and enclosure index of a filed ADR response.
  adr_response_packet: buildAdrResponseDoc,
};

/**
 * Real PDF bytes for ANY template: its registered bespoke builder, else the structured generic builder titled
 * `defaultTitle`. Total over template keys, so a render can no longer produce non-PDF bytes (GAP-033).
 */
export function renderPdfForTemplate(
  templateKey: string,
  payload: unknown,
  defaultTitle: string,
  registry: PdfRendererRegistry = DEFAULT_PDF_RENDERERS,
): Uint8Array {
  // A legacy id-only M6 event drained under the explicit fallback flag has no typed content to draw a form from.
  const legacy = isRec(payload) && payload.legacyUntyped === true;
  const build =
    Object.hasOwn(registry, templateKey) && !legacy
      ? registry[templateKey]
      : buildGenericPayloadDoc(defaultTitle);
  return renderDocModelToPdf((build ?? buildGenericPayloadDoc(defaultTitle))(payload));
}

/** Real PDF bytes for `templateKey`, or `undefined` when no real renderer is registered for it. */
export function renderRegisteredPdf(
  templateKey: string,
  payload: unknown,
  registry: PdfRendererRegistry = DEFAULT_PDF_RENDERERS,
): Uint8Array | undefined {
  const build = Object.hasOwn(registry, templateKey) ? registry[templateKey] : undefined;
  return build === undefined ? undefined : renderDocModelToPdf(build(payload));
}
