import type { DocModel } from "./doc-model";
// apps/backend/src/modules/22-documents/render-pdf/registry.ts — the template -> real-PDF-renderer registry.
// A template key with an entry here renders a REAL, openable PDF; any other key keeps the deterministic
// stand-in (renderer.ts `renderBytes`), so adding a template is one row here and nothing else changes.
import { buildElectionAddendumDoc } from "./election-addendum-doc";
import { buildElectionStatementDoc } from "./election-statement-doc";
import { buildIdgMinutesDoc } from "./idg-minutes-doc";
import { buildIdgPacketDoc } from "./idg-packet-doc";
import { renderDocModelToPdf } from "./pdf-writer";
import {
  buildTriageSummaryAttendingDoc,
  buildTriageSummaryCaregiverDoc,
} from "./triage-summary-doc";

/** Builds the document model (pure) for one template from its render payload. */
export type DocModelBuilder = (payload: unknown) => DocModel;

export type PdfRendererRegistry = Readonly<Record<string, DocModelBuilder>>;

export const DEFAULT_PDF_RENDERERS: PdfRendererRegistry = {
  idg_minutes: buildIdgMinutesDoc,
  idg_patient_packet: buildIdgPacketDoc,
  // F-224 (#248) — M19's caregiver / attending triage-call summaries (two templates, one builder each).
  triage_summary_caregiver: buildTriageSummaryCaregiverDoc,
  triage_summary_attending: buildTriageSummaryAttendingDoc,
  // FY2027 (CMS-1851-F) — the 42 CFR 418.24(c) addendum and the 418.24(b)(1)–(8) election statement.
  election_addendum: buildElectionAddendumDoc,
  election_statement: buildElectionStatementDoc,
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
