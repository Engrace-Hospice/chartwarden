// apps/backend/src/modules/29-external-interfaces/inbound — OBX-5 embedded-PDF extraction (M29-T05, §9 D7).
// PURE, no IO. Some labs send the human-readable report as an OBX with `OBX-2='ED'` (encapsulated data) and
// `OBX-5` carrying the HL7 ED data type `<sourceApp>^<dataSubtype>^<encoding>^<data>` — e.g.
// `^PDF^Base64^JVBERi0xLj…`. The `lab_value_type` enum has NO `ED` member, so an ED OBX is NEVER persisted
// as a `lab_observation_value` row; instead it becomes an M22 document-upload handshake (the attach planner
// emits `m29.document.upload_requested`; M22 stores it and the T08 back-ref consumer wires the returned
// `document_id` onto `lab_observation.attached_document_id`). This file only does the pure byte extraction;
// the outbox publish + back-ref wiring are the T08 worker/consumer's.
import type { ProjectedObx } from "./hl7-oru-projection";

/** OBX-2 value type marking an embedded-data (encapsulated) segment. */
export const OBX_ENCAPSULATED_DATA_TYPE = "ED";

/** One extracted PDF attachment: the raw bytes (base64) + the OBX set id it came from + its LOINC. */
export interface ExtractedPdf {
  readonly obxSetId: number;
  readonly loincCode: string;
  /** The decoded PDF bytes, re-encoded base64 (the handshake payload the M22 upload request carries). */
  readonly payloadBase64: string;
  readonly byteLength: number;
}

/**
 * Decode the base64 payload of an HL7 ED data type (`<sourceApp>^<subtype>^<encoding>^<data>`). Returns the
 * decoded bytes when the subtype is `PDF` and the encoding is `Base64`, else `null` (a malformed or
 * non-PDF/non-Base64 ED segment is skipped, not a hard error — the numeric results still attach).
 */
export function decodeEncapsulatedPdf(obx5: string): Buffer | null {
  const parts = obx5.split("^");
  // Subcomponents: [0] source app, [1] data subtype, [2] encoding, [3] data.
  if (parts.length < 4) return null;
  if ((parts[1] ?? "").trim().toUpperCase() !== "PDF") return null;
  if ((parts[2] ?? "").trim().toUpperCase() !== "BASE64") return null;
  const data = (parts[3] ?? "").trim();
  if (data === "") return null;
  try {
    const bytes = Buffer.from(data, "base64");
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/** Extract every decodable embedded PDF from an OBX list (the ED segments only). */
export function extractPdfAttachments(obxList: readonly ProjectedObx[]): ExtractedPdf[] {
  const out: ExtractedPdf[] = [];
  for (const obx of obxList) {
    if (obx.valueType !== OBX_ENCAPSULATED_DATA_TYPE) continue;
    const bytes = decodeEncapsulatedPdf(obx.value);
    if (!bytes) continue;
    out.push({
      obxSetId: obx.setId,
      loincCode: obx.loincCode,
      payloadBase64: bytes.toString("base64"),
      byteLength: bytes.length,
    });
  }
  return out;
}
