// apps/backend/src/modules/29-external-interfaces/inbound — ADT segment projection (M29-T04, §4.6/§4.12).
// PURE. Turns a raw HL7 v2 ADT frame (the bytes BETWEEN the MLLP `<VT>…<FS><CR>` envelope, already framed
// by T-29.03/T03) into the typed candidate the T-29.05 match cascade and the T-29.06 proposal builder read.
//
// SCOPE: only the segments the propose-then-review ADT flow needs — PID (patient identity + demographics),
// PV1 (visit class for the M6 admission proposals), EVN (event-recorded timestamp). Escape-sequence
// un-expansion, repetition beyond the first name/address, and the full HAPI typed tree are deliberately
// NOT done here (the sidecar owns the exhaustive parse); this is the minimal, deterministic projection the
// cascade + owner-module apply need. The separators are read from MSH-1/MSH-2 so a non-standard encoding
// still parses (mirrors `parseMshEnvelope`).
import { parseMshEnvelope, type MshEnvelope } from "../listener/mllp-framing";

/** The HL7 encoding separators read off MSH-1 (field) and MSH-2 (component/repetition/escape/subcomponent). */
export interface Hl7Separators {
  readonly field: string;
  readonly component: string;
  readonly repetition: string;
  readonly escape: string;
  readonly subcomponent: string;
}

/** A single PID-3 identifier repetition (CX): the raw value + its assigning authority (CX-4). */
export interface AdtIdentifier {
  readonly value: string;
  readonly assigningAuthority: string;
  /** CX-5 identifier type code (`MR`, `SS`, …); empty when absent. */
  readonly typeCode: string;
}

/** The PID-11 mailing address (XAD), projected for the proposal candidate JSONB. */
export interface AdtAddress {
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
}

/** The demographic candidate the cascade matches on + the owner module applies at accept (§4.6 / §2.2). */
export interface AdtPatientCandidate {
  readonly identifiers: readonly AdtIdentifier[];
  readonly lastName: string;
  readonly firstName: string;
  readonly middleName?: string;
  /** ISO `yyyy-mm-dd` (PID-7); empty when PID-7 is missing/short — the cascade then skips L3/L4/L5. */
  readonly dateOfBirth: string;
  /** PID-8 administrative sex, uppercased; empty when absent. */
  readonly administrativeSex: string;
  /** PID-19 (or a PID-3 `SS` rep) last-four; undefined when no usable SSN is present. */
  readonly ssnLast4?: string;
  readonly address?: AdtAddress;
  readonly phoneHome?: string;
}

/** PV1 visit context (M6 admission proposals carry it in the candidate for the applier). */
export interface AdtVisitContext {
  /** PV1-2 patient class (`I` inpatient, `O` outpatient, …). */
  readonly patientClass?: string;
  /** PV1-44 admit datetime, raw HL7 TS. */
  readonly admitDatetimeRaw?: string;
}

/** The full ADT projection — the parsed candidate stored as `hl7_inbound_proposal.proposed_patient_candidate`. */
export interface ProjectedAdt {
  /** MSH-9 recombined, e.g. `ADT^A08`. */
  readonly messageType: string;
  /** MSH-9.2 trigger event, e.g. `A08`. */
  readonly triggerEvent: string;
  readonly patientCandidate: AdtPatientCandidate;
  readonly visit?: AdtVisitContext;
  /** EVN-2 recorded datetime (fallback MSH-7), raw HL7 TS. */
  readonly eventRecordedAtRaw?: string;
}

/** HL7 default encoding characters (MSH-2 `^~\&`) — used when a frame omits them. */
export const HL7_DEFAULT_SEPARATORS: Hl7Separators = {
  field: "|",
  component: "^",
  repetition: "~",
  escape: "\\",
  subcomponent: "&",
};

/** Split a raw frame into its CR/LF-delimited segment lines, dropping empty trailing lines. */
export function splitSegments(payload: string): string[] {
  return payload
    .split(/\r\n|\r|\n/)
    .map((s) => s.trimEnd())
    .filter((s) => s.length > 0);
}

/** Read the separators off the MSH segment (MSH-1 field sep = char 4; MSH-2 = the next four encoding chars). */
export function readSeparators(mshSegment: string): Hl7Separators {
  const field = mshSegment.charAt(3) || "|";
  // MSH-2 is the run of encoding chars immediately after the second field separator.
  const afterField = mshSegment.slice(4);
  const encoding = afterField.split(field)[0] ?? "";
  return {
    field,
    component: encoding.charAt(0) || "^",
    repetition: encoding.charAt(1) || "~",
    escape: encoding.charAt(2) || "\\",
    subcomponent: encoding.charAt(3) || "&",
  };
}

/** Convert an HL7 TS (`YYYYMMDD` or `YYYYMMDDHHMMSS…`) to ISO `yyyy-mm-dd`; empty string when unusable. */
export function hl7DateToIso(hl7Date: string | undefined): string {
  if (!hl7Date || hl7Date.length < 8) return "";
  const y = hl7Date.slice(0, 4);
  const m = hl7Date.slice(4, 6);
  const d = hl7Date.slice(6, 8);
  if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) return "";
  return `${y}-${m}-${d}`;
}

/** Extract the last four digits of an SSN-bearing string; undefined when fewer than four digits are present. */
export function extractSsnLast4(ssnRaw: string | undefined): string | undefined {
  if (!ssnRaw) return undefined;
  const digits = ssnRaw.replace(/\D/g, "");
  if (digits.length < 4) return undefined;
  return digits.slice(-4);
}

/** A non-MSH segment's fields, where `field(n)` returns HL7 field n (`field(0)` is the segment name). */
class Segment {
  private readonly fields: string[];
  constructor(
    line: string,
    private readonly sep: Hl7Separators,
  ) {
    this.fields = line.split(sep.field);
  }
  field(n: number): string {
    return this.fields[n] ?? "";
  }
  /** Component `c` (1-indexed) of field `n`. */
  component(n: number, c: number): string {
    const comps = this.field(n).split(this.sep.component);
    return (comps[c - 1] ?? "").trim();
  }
  /** The repetitions (`~`-split) of field `n`. */
  repetitions(n: number): string[] {
    const raw = this.field(n);
    if (raw === "") return [];
    return raw.split(this.sep.repetition);
  }
}

function findSegment(segments: string[], name: string): string | undefined {
  return segments.find((s) => s.startsWith(name));
}

function projectIdentifiers(pid: Segment, sep: Hl7Separators): AdtIdentifier[] {
  const out: AdtIdentifier[] = [];
  for (const rep of pid.repetitions(3)) {
    const comps = rep.split(sep.component);
    const value = (comps[0] ?? "").trim();
    if (value === "") continue;
    out.push({
      value,
      assigningAuthority: (comps[3] ?? "").trim(),
      typeCode: (comps[4] ?? "").trim(),
    });
  }
  return out;
}

/** Pull a usable SSN last-four from PID-19, falling back to a PID-3 repetition tagged `SS`. */
function projectSsnLast4(pid: Segment, identifiers: readonly AdtIdentifier[]): string | undefined {
  const fromField = extractSsnLast4(pid.field(19));
  if (fromField) return fromField;
  const ssnIdentifier = identifiers.find((id) => id.typeCode === "SS");
  return extractSsnLast4(ssnIdentifier?.value);
}

function projectAddress(pid: Segment): AdtAddress | undefined {
  const line1 = pid.component(11, 1);
  const city = pid.component(11, 3);
  const state = pid.component(11, 4);
  const postalCode = pid.component(11, 5);
  if (!line1 && !city && !state && !postalCode) return undefined;
  const line2 = pid.component(11, 2);
  return {
    line1,
    ...(line2 ? { line2 } : {}),
    city,
    state,
    postalCode,
  };
}

/**
 * Project a raw ADT frame into {@link ProjectedAdt}. Returns `null` when the frame has no PID segment — an
 * ADT with no PID is a parse-validation failure (the caller marks `parse_status='parse_error'` and stops,
 * per T-29.05 §5). The MSH envelope is (re)parsed here so the projection is self-contained and testable.
 */
export function projectAdt(payload: string): ProjectedAdt | null {
  const segments = splitSegments(payload);
  const mshLine = findSegment(segments, "MSH");
  if (!mshLine) return null;
  const sep = readSeparators(mshLine);
  let envelope: MshEnvelope;
  try {
    envelope = parseMshEnvelope(payload);
  } catch {
    return null;
  }

  const pidLine = findSegment(segments, "PID");
  if (!pidLine) return null;
  const pid = new Segment(pidLine, sep);

  const identifiers = projectIdentifiers(pid, sep);
  const patientCandidate: AdtPatientCandidate = {
    identifiers,
    lastName: pid.component(5, 1),
    firstName: pid.component(5, 2),
    ...(pid.component(5, 3) ? { middleName: pid.component(5, 3) } : {}),
    dateOfBirth: hl7DateToIso(pid.field(7)),
    administrativeSex: pid.field(8).trim().toUpperCase(),
    ...(projectSsnLast4(pid, identifiers) ? { ssnLast4: projectSsnLast4(pid, identifiers) } : {}),
    ...(projectAddress(pid) ? { address: projectAddress(pid) } : {}),
    ...(pid.component(13, 1) ? { phoneHome: pid.component(13, 1) } : {}),
  };

  const messageType = envelope.triggerEvent
    ? `${envelope.messageCode}^${envelope.triggerEvent}`
    : envelope.messageCode;

  let visit: AdtVisitContext | undefined;
  const pv1Line = findSegment(segments, "PV1");
  if (pv1Line) {
    const pv1 = new Segment(pv1Line, sep);
    const patientClass = pv1.field(2).trim();
    const admitDatetimeRaw = pv1.field(44).trim();
    if (patientClass || admitDatetimeRaw) {
      visit = {
        ...(patientClass ? { patientClass } : {}),
        ...(admitDatetimeRaw ? { admitDatetimeRaw } : {}),
      };
    }
  }

  let eventRecordedAtRaw: string | undefined;
  const evnLine = findSegment(segments, "EVN");
  if (evnLine) {
    const evn = new Segment(evnLine, sep);
    eventRecordedAtRaw = evn.field(2).trim() || undefined;
  }

  return {
    messageType,
    triggerEvent: envelope.triggerEvent,
    patientCandidate,
    ...(visit ? { visit } : {}),
    ...(eventRecordedAtRaw ? { eventRecordedAtRaw } : {}),
  };
}
