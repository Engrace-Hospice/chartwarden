// apps/backend/src/modules/32-ai-platform/seams/doclens-projector.ts — the §2.5 output projector for the
// DocLens classifier, extractor, stage-5 vision verifier and SUD detector seams, plus the JSON Schemas their backends are constrained to
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

/** F-237 — stage 5: the model's independent reading of one field from an image crop. */
export const DOCLENS_VISION_VERIFY_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    legible: { type: "boolean" },
    observedValues: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
  },
  required: ["legible", "observedValues", "confidence"],
  additionalProperties: false,
};

/** F-237 — the SUD categories the model may report (M22 `SudIndicatorCategory`). */
export const DOCLENS_SUD_CATEGORIES = [
  "medication",
  "diagnosis",
  "social_history",
  "treatment_setting",
] as const;

export const DOCLENS_SUD_DETECT_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    indicators: {
      type: "array",
      items: {
        type: "object",
        properties: {
          page: { type: "integer" },
          quote: { type: "string" },
          category: { type: "string", enum: [...DOCLENS_SUD_CATEGORIES] },
        },
        required: ["page", "quote", "category"],
        additionalProperties: false,
      },
    },
    confidence: { type: "number" },
  },
  required: ["indicators", "confidence"],
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

/**
 * F-237 — `field_value`: legible ⇒ `pass` with the reading(s); illegible ⇒ `uncertain` with none. A LIST
 * field (`medications[1].name`) reads every visible entry: Docling often hands back a whole list as one
 * block, so the crop cannot isolate one line, and the consumer checks the value is AMONG the readings.
 */
export function projectDocLensVisionVerify(output: AiInvocationOutput) {
  const o = parseObject(output.text);
  if (!o || typeof o.legible !== "boolean" || !Array.isArray(o.observedValues)) return null;
  if (!o.observedValues.every((v) => typeof v === "string")) return null;
  if (!isConfidence(o.confidence)) return null;
  const values = (o.observedValues as string[]).map((v) => v.trim()).filter((v) => v !== "");
  const read = o.legible && values.length > 0;
  return {
    verdict: read ? ("pass" as const) : ("uncertain" as const),
    confidence: o.confidence,
    evidence: [],
    warnings: [],
    ...(read ? { observedValue: values[0] as string, observedValues: values } : {}),
  };
}

export function projectDocLensSudDetect(output: AiInvocationOutput) {
  const o = parseObject(output.text);
  if (!o || !Array.isArray(o.indicators) || !isConfidence(o.confidence)) return null;
  const indicators: { pageNumber: number; snippet: string; category: string }[] = [];
  for (const raw of o.indicators as unknown[]) {
    const i = raw as Record<string, unknown> | null;
    if (
      !i ||
      typeof i.page !== "number" ||
      !Number.isInteger(i.page) ||
      i.page < 1 ||
      typeof i.quote !== "string" ||
      !(DOCLENS_SUD_CATEGORIES as readonly unknown[]).includes(i.category)
    ) {
      return null;
    }
    if (i.quote.trim() === "") continue;
    indicators.push({ pageNumber: i.page, snippet: i.quote, category: i.category as string });
  }
  return {
    sudIndicatorsDetected: indicators.length > 0,
    confidence: o.confidence,
    indicators,
    warnings: [],
  };
}

/** Structurally `AiSeamOutputProjector` (published.ts) — not imported, so published.ts may import this file. */
export function createDocLensOutputProjector(): {
  project(seam: string, output: AiInvocationOutput): unknown | null;
} {
  return {
    project(seam, output) {
      if (seam === "DocLensClassifier") return projectDocLensClassify(output);
      if (seam === "DocLensExtractor") return projectDocLensExtract(output);
      if (seam === "DocLensVisionVerifier") return projectDocLensVisionVerify(output);
      if (seam === "DocLensSudDetector") return projectDocLensSudDetect(output);
      return null;
    },
  };
}
