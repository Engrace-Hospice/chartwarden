// @chartwarden/x12-835-client — the wire→typed mapper for the sidecar's /parse277ca JSON response. PURE: no
// IO. M25 consumes the M23-published `m23.claim.rejected` (sourced from M23's own 277CA parse) for the
// pre-835 denial seed; this mapper exists so the package owns a symmetric typed surface and so a future
// M25 self-pull of a 277CA roster has a parser. Imports ONLY ./types (the no-circular rule).
import {
  type Parsed277ca,
  type Parsed277caRejection,
  type X12WorkerResult,
  degraded835,
} from "./types";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function mapRejection(w: unknown): Parsed277caRejection | null {
  if (!isObj(w)) return null;
  const patientControlNumber = str(w.patientControlNumber);
  const statusCategoryCode = str(w.statusCategoryCode);
  const statusCode = str(w.statusCode);
  if (!patientControlNumber || !statusCategoryCode || !statusCode) return null;
  return {
    patientControlNumber,
    statusCategoryCode,
    statusCode,
    ...(str(w.freeText) ? { freeText: str(w.freeText)! } : {}),
  };
}

/** Map the sidecar's /parse277ca JSON into a typed {@link Parsed277ca}. Fails closed (degraded), no throw. */
export function mapParsed277ca(wire: unknown): X12WorkerResult<Parsed277ca> {
  if (!isObj(wire)) {
    return degraded835(
      "X12_277CA_PARSE_FAILED",
      "sidecar response was not an object",
      "parse277ca",
      false,
    );
  }
  const isa = str(wire.interchangeControlNumber);
  const st = str(wire.transactionSetControlNumber);
  if (!isa || !st) {
    return degraded835(
      "X12_277CA_PARSE_FAILED",
      "missing ISA13/ST02 control numbers",
      "parse277ca",
      false,
    );
  }
  const rejectionsRaw = Array.isArray(wire.rejections) ? wire.rejections : [];
  return {
    ok: true,
    value: {
      interchangeControlNumber: isa,
      transactionSetControlNumber: st,
      rejections: rejectionsRaw
        .map(mapRejection)
        .filter((r): r is Parsed277caRejection => r !== null),
    },
  };
}
