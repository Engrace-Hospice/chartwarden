// @wardenx/x12-835-client — lightweight ISA/ST envelope-header extraction. PURE string parsing, no pyx12,
// no sidecar round-trip. WX-PR-012: the M25 receive step needs the dedup key (ISA13 interchange control
// number + ST02 transaction-set control number) BEFORE it can insert the `remittance_advice` row — the
// full CLP-level parse only happens after that row exists (the queued → parsing → parsed state machine,
// spec §2.2). The X12 ISA segment is a fixed-layout header (106 bytes incl. terminator when delimiters are
// single characters), so this is real, deterministic, well-known logic — not a stand-in for the sidecar.
//
// Malformed/truncated input (not X12, no ISA segment, no following ST segment) returns null — the caller
// treats that as "receive" failing closed with nothing persisted (never a guessed/blank dedup key).

export interface X12EnvelopeHeader {
  /** ISA13 — the interchange control number (9 digits, left-padded with the segment's own formatting). */
  readonly interchangeControlNumber: string;
  /** ST02 — the transaction set control number of the FIRST ST segment (one 835 file = one ST envelope). */
  readonly transactionSetControlNumber: string;
}

const ISA_SEGMENT_LENGTH = 106;
const ISA13_ELEMENT_INDEX = 13;

/** Extract ISA13 + the first ST segment's ST02 from a raw X12 835 document. Returns null when malformed. */
export function parseX12EnvelopeHeader(raw: string): X12EnvelopeHeader | null {
  if (raw.length < ISA_SEGMENT_LENGTH) return null;
  const head = raw.slice(0, ISA_SEGMENT_LENGTH);
  if (!head.startsWith("ISA")) return null;
  const elementSep = head[3];
  const segmentTerm = head[ISA_SEGMENT_LENGTH - 1];
  if (!elementSep || !segmentTerm) return null;

  const isaElements = head.slice(0, ISA_SEGMENT_LENGTH - 1).split(elementSep);
  const interchangeControlNumber = isaElements[ISA13_ELEMENT_INDEX]?.trim();
  if (!interchangeControlNumber) return null;

  // Segments after ISA are terminator-delimited; find the first ST segment (one 835 = one ST envelope).
  const rest = raw.slice(ISA_SEGMENT_LENGTH);
  const segments = rest.split(segmentTerm);
  const stSegment = segments.find((s) => s.trim().startsWith(`ST${elementSep}`));
  if (!stSegment) return null;
  const stElements = stSegment.trim().split(elementSep);
  const transactionSetControlNumber = stElements[2]?.trim();
  if (!transactionSetControlNumber) return null;

  return { interchangeControlNumber, transactionSetControlNumber };
}
