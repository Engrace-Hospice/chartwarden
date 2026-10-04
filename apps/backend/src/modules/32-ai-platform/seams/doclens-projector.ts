// apps/backend/src/modules/32-ai-platform/seams/doclens-projector.ts — the §2.5 output projector for the
// DocLens classifier and extractor seams, plus the JSON Schemas their backends are constrained to
// (F-236, ADR-0048).
//
// The projector's job is to turn `output.text` into a seam contract's payload or answer `null` ("cannot")
// — never to repair a reply. Structured outputs constrain what a backend MAY emit; the reply is still
// parsed and checked here, because a constraint a backend claims to honour is not a parse the platform
// may skip (and a local model honours it less strictly than a cloud one). `null` makes the seam refuse
// with `output_validation_failed_after_retry`; the `ai_invocation` row is already written either way.
//
// Every other seam name answers `null`, exactly as with no projector bound.
import type { AiInvocationOutput } from "../invocation/service";

/** The document types `doclens_classify` may answer (M22 `classified_page_doc_type`). */
export const DOCLENS_DOCUMENT_TYPES = [
  "discharge_summary",
  "med_recon",
  "hp",
  "lab",
  "imaging",
  "consult",
  "insurance_card",
  "photo_id",
  "advance_directive",
  "dpoa",
  "transfer_record",
  "unknown",
] as const;

export const DOCLENS_CLASSIFY_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    documentType: { type: "string", enum: [...DOCLENS_DOCUMENT_TYPES] },
    confidence: { type: "number" },
  },
  required: ["documentType", "confidence"],
  additionalProperties: false,
};

export const DOCLENS_EXTRACT_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    fields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fieldPath: { type: "string" },
          value: { type: "string" },
          quote: { type: "string" },
          page: { type: "integer" },
          confidence: { type: "number" },
        },
        required: ["fieldPath", "value", "quote", "page", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["fields"],
  additionalProperties: false,
};

/** Parse a JSON object reply. Tolerates a ```json fence (some local models add one); nothing else. */
function parseObject(text: string): Record<string, unknown> | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const v = JSON.parse(trimmed) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const isConfidence = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

const FIELD_PATH = /^[A-Za-z][A-Za-z0-9]*(\[\d+\])?(\.[A-Za-z][A-Za-z0-9]*(\[\d+\])?)*$/;

export function projectDocLensClassify(output: AiInvocationOutput) {
  const o = parseObject(output.text);
  if (!o) return null;
  if (!(DOCLENS_DOCUMENT_TYPES as readonly unknown[]).includes(o.documentType)) return null;
  if (!isConfidence(o.confidence)) return null;
  return {
    documentType: o.documentType as string,
    confidence: o.confidence,
    alternates: [],
    warnings: [],
  };
}

export function projectDocLensExtract(output: AiInvocationOutput) {
  const o = parseObject(output.text);
  if (!o || !Array.isArray(o.fields)) return null;
  const fields: Record<
    string,
    { value: string; confidence: number; sourceQuote: { page: number; text: string } }
  > = {};
  for (const raw of o.fields as unknown[]) {
    const f = raw as Record<string, unknown> | null;
    // One malformed entry invalidates the reply: a partial projection would present a model that
    // answered badly as a model that found fewer fields.
    if (
      !f ||
      typeof f.fieldPath !== "string" ||
      !FIELD_PATH.test(f.fieldPath) ||
      typeof f.value !== "string" ||
      typeof f.quote !== "string" ||
      typeof f.page !== "number" ||
      !Number.isInteger(f.page) ||
      f.page < 1 ||
      !isConfidence(f.confidence)
    ) {
      return null;
    }
    if (f.value.trim() === "") continue; // "not present" said with an empty string — omit, as asked
    const prior = fields[f.fieldPath];
    if (prior && prior.confidence >= f.confidence) continue;
    fields[f.fieldPath] = {
      value: f.value,
      confidence: f.confidence,
      sourceQuote: { page: f.page, text: f.quote },
    };
  }
  return { fields, warnings: [] };
}

/** Structurally `AiSeamOutputProjector` (published.ts) — not imported, so published.ts may import this file. */
export function createDocLensOutputProjector(): {
  project(seam: string, output: AiInvocationOutput): unknown | null;
} {
  return {
    project(seam, output) {
      if (seam === "DocLensClassifier") return projectDocLensClassify(output);
      if (seam === "DocLensExtractor") return projectDocLensExtract(output);
      return null;
    },
  };
}
