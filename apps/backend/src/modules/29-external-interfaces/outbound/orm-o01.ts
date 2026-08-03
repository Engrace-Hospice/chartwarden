// apps/backend/src/modules/29-external-interfaces/outbound — ORM^O01 wire builder (M29-T06, §4.12). PURE.
//
// Builds the HL7 v2.5.1 ORM^O01 lab-order message from the typed `OrmRequestedPayload` M11 publishes on
// `m11.order.hl7_orm_requested` (the pinned leaf contract in @wardenx/types — M11 has no HL7 knowledge; it
// declares the typed body and M29 owns the wire format, §4.12). D8: OBR-2 = the M11 placer order number.
//
// NO HAPI SIDECAR (architecture wins over the §4.12.1 sketch's `ctx.sidecar.buildOrm`). The Phase-1
// headless build ships no Java sidecar — the pure TS builder produces the v2.5.1 wire shape directly, the
// same stance the inbound `projectAdt`/`projectOru` projectors and the `buildAckMessage` emitter take. IO-
// free: the message control id (MSH-10) and the MSH-7 datetime are INJECTED so the builder is fully
// deterministic under test (never a clock or a uuid call inside a pure builder).
import type { OrmRequestedPayload } from "@wardenx/types";

/** The two application/facility identity pairs the outbound MSH carries (resolved from `external_feed`). */
export interface OrmEndpoint {
  /** MSH-3 — our sending application (WardenX). */
  readonly sendingApplication: string;
  /** MSH-4 — our sending facility (the feed's configured sending facility). */
  readonly sendingFacility: string;
  /** MSH-5 — the destination lab's receiving application. */
  readonly receivingApplication: string;
  /** MSH-6 — the destination lab's receiving facility. */
  readonly receivingFacility: string;
}

export interface BuildOrmInput {
  /** The typed M11 ORM request (the `m11.order.hl7_orm_requested` payload). */
  readonly request: OrmRequestedPayload;
  /** The MSH identity pairs. */
  readonly endpoint: OrmEndpoint;
  /** MSH-10 — the outbound message control id (INJECTED — a ulid/uuid the caller minted). */
  readonly messageControlId: string;
  /** MSH-7 — the message datetime as an HL7 timestamp `YYYYMMDDHHMMSS` (INJECTED — no clock here). */
  readonly messageTimestamp: string;
}

/**
 * Escape the HL7 v2 delimiter characters in free-text so a value containing `|^~\&` cannot break the
 * segment framing (HL7 v2.5.1 §2.7 escape sequences). Backslash MUST be escaped first (it introduces the
 * escape) or the subsequent replacements would double-escape.
 */
export function escapeHl7(value: string): string {
  return value
    .replace(/\\/g, "\\E\\")
    .replace(/\|/g, "\\F\\")
    .replace(/\^/g, "\\S\\")
    .replace(/&/g, "\\T\\")
    .replace(/~/g, "\\R\\");
}

/** ISO `yyyy-mm-dd` → HL7 `YYYYMMDD` (date-only, e.g. PID-7 date of birth). Non-digits stripped. */
export function isoDateToHl7(iso: string): string {
  return iso.replace(/[^0-9]/g, "").slice(0, 8);
}

/** ISO datetime → HL7 `YYYYMMDDHHMMSS` in UTC. Returns `""` for an unparseable input (deterministic). */
export function isoToHl7Timestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/** Join a segment's fields on `|` and drop trailing empty fields (HL7 permits omitting trailing separators). */
function segment(fields: readonly string[]): string {
  return fields.join("|").replace(/\|+$/, "");
}

/**
 * Build the HL7 v2.5.1 `ORM^O01` message (segments joined by `\r`). Segment order: MSH, PID, ORC (`NW` new
 * order), OBR, then one NTE per clinical note. D8: OBR-2 and ORC-2 both carry the M11 placer order number.
 * The §4.4 patient projection intentionally omits SSN / NK1 / IN1 / GT1 (the outbound PID-19 is null-
 * projected — the §3.6 denylist enforces the encrypted MBI/SSN columns never reach a wire payload).
 */
export function buildOrmO01(input: BuildOrmInput): string {
  const { request, endpoint } = input;
  const lab = request.labOrderPayload;
  const demo = lab.patientDemographics;
  const placer = escapeHl7(lab.placerOrderNumber); // D8 — OBR-2 = order_record.id (dashless per the contract)
  const requestedTs = isoToHl7Timestamp(request.requestedAt);

  // MSH — roles are ours→theirs; MSH-9 = ORM^O01; MSH-11 = P (production); MSH-12 = 2.5.1.
  const msh = segment([
    "MSH",
    "^~\\&",
    escapeHl7(endpoint.sendingApplication),
    escapeHl7(endpoint.sendingFacility),
    escapeHl7(endpoint.receivingApplication),
    escapeHl7(endpoint.receivingFacility),
    input.messageTimestamp,
    "",
    "ORM^O01",
    escapeHl7(input.messageControlId),
    "P",
    "2.5.1",
  ]);

  // PID — PID-3 CX (mrn^^^authority), PID-5 XPN (family^given), PID-7 DOB, PID-8 sex, PID-11 XAD address.
  const cx = `${escapeHl7(demo.mrn)}^^^${escapeHl7(demo.internalMrnAuthority)}`;
  const name = `${escapeHl7(demo.familyName)}^${escapeHl7(demo.givenName)}`;
  const hasAddress = Boolean(demo.addressLine1 || demo.addressCity || demo.addressState || demo.addressPostal);
  const address = hasAddress
    ? `${escapeHl7(demo.addressLine1 ?? "")}^^${escapeHl7(demo.addressCity ?? "")}^${escapeHl7(
        demo.addressState ?? "",
      )}^${escapeHl7(demo.addressPostal ?? "")}`
    : "";
  const pid = segment(["PID", "1", "", cx, "", name, "", isoDateToHl7(demo.dateOfBirth), demo.administrativeSex, "", "", address]);

  // ORC — ORC-1 NW, ORC-2 placer, ORC-7 quantity/timing (priority in the 6th component), ORC-9 datetime,
  //       ORC-12 ordering provider XCN (npi^family^given).
  const provider = `${escapeHl7(lab.orderingProviderNpi)}^${escapeHl7(lab.orderingProviderName.family)}^${escapeHl7(
    lab.orderingProviderName.given,
  )}`;
  const quantityTiming = `1^^^^^${escapeHl7(request.priority)}`;
  const orc = segment(["ORC", "NW", placer, "", "", "", quantityTiming, "", requestedTs, "", "", provider]);

  // OBR — OBR-2 placer (D8), OBR-4 CWE universal service id (LOINC), OBR-5 priority (deprecated, still read
  //       by many labs), OBR-16 ordering provider, OBR-27 quantity/timing.
  const serviceId = `${escapeHl7(lab.observationIdentifier.code)}^${escapeHl7(
    lab.observationIdentifier.text,
  )}^${escapeHl7(lab.observationIdentifier.codingSystem)}`;
  const obrFields = new Array<string>(28).fill("");
  obrFields[0] = "OBR";
  obrFields[1] = "1";
  obrFields[2] = placer;
  obrFields[4] = serviceId;
  obrFields[5] = escapeHl7(request.priority);
  obrFields[16] = provider;
  obrFields[27] = quantityTiming;
  const obr = segment(obrFields);

  const segments: string[] = [msh, pid, orc, obr];

  // NTE — one per clinical note, set-id incrementing from 1.
  const notes = lab.clinicalNotes ?? [];
  notes.forEach((note, i) => {
    segments.push(segment(["NTE", String(i + 1), "", escapeHl7(note)]));
  });

  return segments.join("\r");
}

/** The §8.4 / D19 PHI-minimization segment summary: only segment PRESENCE + counts + byte length — never a
 *  field value. This is what the `hl7_message_outbound.segments_summary` column and the ops dashboards see. */
export interface OrmSegmentSummary {
  readonly segments: Readonly<Record<string, number>>;
  readonly byteLength: number;
}

/** Summarize a built HL7 wire message to segment-id counts + byte length (no PHI, §8.4). */
export function summarizeSegments(wire: string): OrmSegmentSummary {
  const counts: Record<string, number> = {};
  for (const line of wire.split("\r")) {
    const id = line.slice(0, 3);
    if (id === "") continue;
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return { segments: counts, byteLength: Buffer.byteLength(wire, "utf8") };
}
