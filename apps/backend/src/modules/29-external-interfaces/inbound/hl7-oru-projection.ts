// apps/backend/src/modules/29-external-interfaces/inbound — ORU^R01 segment projection (M29-T05, §4.6/§2.2).
// PURE. Turns a raw HL7 v2 ORU frame (the bytes BETWEEN the MLLP `<VT>…<FS><CR>` envelope, framed by T03)
// into the typed lab result the T05 attach pipeline reads: the OBR order/service header, the N OBX result
// lines, and the PID as a {@link CascadePid} for the fallback patient match. Mirrors `projectAdt` (T04): the
// separators are read off MSH-1/MSH-2, escape-sequence un-expansion and the exhaustive HAPI tree stay in the
// sidecar, and only the segments the auto-attach flow needs are projected.
//
// SCOPE (Phase-1 minimal, D7/D8): the FIRST OBR group + EVERY OBX in the message (a single-order ORU is the
// common case; a multi-OBR panel projects all OBX under the header). The typed value coercion, the LOINC
// terminology gate, the SUD-ingress gate, and the abnormal-flag rollup are the callers' pure cores
// (`lab-terminology`/`lab-sud-redaction`/`lab-abnormal`); this file is only the wire→struct projection.
import type { CascadePid } from "./match-cascade";
import {
  HL7_DEFAULT_SEPARATORS,
  type Hl7Separators,
  extractSsnLast4,
  hl7DateToIso,
  readSeparators,
  splitSegments,
} from "./hl7-adt-projection";
import { parseMshEnvelope, type MshEnvelope } from "../listener/mllp-framing";

/** OBR — the observation request header (order/service identity, §4.6). */
export interface ProjectedObr {
  /** OBR-2.1 placer order number = the M11 `order_record.id` (D8); empty when unsolicited. */
  readonly placerOrderNumber: string;
  /** OBR-3.1 filler order number (the lab's own accession); empty when absent. */
  readonly fillerOrderNumber: string;
  /** OBR-4.1 universal service identifier code (the panel LOINC). */
  readonly universalServiceCode: string;
  /** OBR-4.2 universal service identifier text. */
  readonly universalServiceText: string;
  /** OBR-7 observation datetime as ISO `yyyy-mm-dd`; empty when unusable. */
  readonly observationDate: string;
  /** OBR-7 raw HL7 TS (kept so a caller can build a full timestamp). */
  readonly observationDateRaw: string;
  /** OBR-14 specimen received datetime, raw HL7 TS; empty when absent. */
  readonly collectionDateRaw: string;
  /** OBR-15.1 specimen source descriptor; empty when absent. */
  readonly specimenDescriptor: string;
  /** OBR-25 result status (F/P/C/X…); empty when absent (falls back to the OBX-11 rollup). */
  readonly resultStatusRaw: string;
}

/** OBX — one observation result line (§4.6). Raw wire fields; typed coercion happens in the attach planner. */
export interface ProjectedObx {
  /** OBX-1 set id (1-indexed within the message). */
  readonly setId: number;
  /** OBX-2 value type (NM/ST/CE/SN/TX/DT/ED…), uppercased. `ED` marks an embedded PDF (§9, D7). */
  readonly valueType: string;
  /** OBX-3.1 observation identifier code (LOINC). */
  readonly loincCode: string;
  /** OBX-3.2 observation identifier text. */
  readonly loincText: string;
  /** OBX-5 observation value, raw (for `ED` this is the `^PDF^Base64^…` payload). */
  readonly value: string;
  /** OBX-6.1 units; empty when absent. */
  readonly units: string;
  /** OBX-7 reference range; empty when absent. */
  readonly referenceRange: string;
  /** OBX-8 abnormal flags, `~`-split and uppercased; empty when none. */
  readonly abnormalFlagsRaw: readonly string[];
  /** OBX-11 observation result status (F/P/C/X…), uppercased; empty when absent. */
  readonly resultStatusRaw: string;
  /** OBX-14 observation datetime, raw HL7 TS; empty when absent. */
  readonly observationDateRaw: string;
}

/** The full ORU projection the T05 attach pipeline consumes. */
export interface ProjectedOru {
  /** MSH-9 recombined, e.g. `ORU^R01`. */
  readonly messageType: string;
  readonly obr: ProjectedObr;
  readonly obxList: readonly ProjectedObx[];
  /** The PID projected for the OBR-2-fallback patient-match cascade (§4.6). */
  readonly patientCandidate: CascadePid;
}

/** A non-MSH segment's fields, `field(0)` being the segment name; component/repetition helpers 1-indexed. */
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
  component(n: number, c: number): string {
    const comps = this.field(n).split(this.sep.component);
    return (comps[c - 1] ?? "").trim();
  }
  repetitions(n: number): string[] {
    const raw = this.field(n);
    if (raw === "") return [];
    return raw.split(this.sep.repetition);
  }
}

function findSegment(segments: string[], name: string): string | undefined {
  return segments.find((s) => s.startsWith(name));
}

/** Project the PID identifiers (CX repetitions: value + assigning authority) the cascade matches on. */
function projectPidIdentifiers(pid: Segment, sep: Hl7Separators): CascadePid["identifiers"] {
  const out: { value: string; assigningAuthority: string }[] = [];
  for (const rep of pid.repetitions(3)) {
    const comps = rep.split(sep.component);
    const value = (comps[0] ?? "").trim();
    if (value === "") continue;
    out.push({ value, assigningAuthority: (comps[3] ?? "").trim() });
  }
  return out;
}

/** Pull an SSN last-four from PID-19, falling back to a PID-3 repetition tagged `SS` (CX-5). */
function projectPidSsnLast4(pid: Segment, sep: Hl7Separators): string | undefined {
  const fromField = extractSsnLast4(pid.field(19));
  if (fromField) return fromField;
  for (const rep of pid.repetitions(3)) {
    const comps = rep.split(sep.component);
    if ((comps[4] ?? "").trim() === "SS") return extractSsnLast4((comps[0] ?? "").trim());
  }
  return undefined;
}

function projectPid(pidLine: string, sep: Hl7Separators): CascadePid {
  const pid = new Segment(pidLine, sep);
  const ssnLast4 = projectPidSsnLast4(pid, sep);
  return {
    identifiers: projectPidIdentifiers(pid, sep),
    lastName: pid.component(5, 1),
    firstName: pid.component(5, 2),
    dateOfBirth: hl7DateToIso(pid.field(7)),
    administrativeSex: pid.field(8).trim().toUpperCase(),
    ...(ssnLast4 ? { ssnLast4 } : {}),
  };
}

function projectObr(obrLine: string | undefined, sep: Hl7Separators): ProjectedObr {
  if (!obrLine) {
    return {
      placerOrderNumber: "",
      fillerOrderNumber: "",
      universalServiceCode: "",
      universalServiceText: "",
      observationDate: "",
      observationDateRaw: "",
      collectionDateRaw: "",
      specimenDescriptor: "",
      resultStatusRaw: "",
    };
  }
  const obr = new Segment(obrLine, sep);
  const observationDateRaw = obr.field(7).trim();
  return {
    placerOrderNumber: obr.component(2, 1),
    fillerOrderNumber: obr.component(3, 1),
    universalServiceCode: obr.component(4, 1),
    universalServiceText: obr.component(4, 2),
    observationDate: hl7DateToIso(observationDateRaw),
    observationDateRaw,
    collectionDateRaw: obr.field(14).trim(),
    specimenDescriptor: obr.component(15, 1),
    resultStatusRaw: obr.field(25).trim().toUpperCase(),
  };
}

function projectObx(obxLine: string, sep: Hl7Separators): ProjectedObx {
  const obx = new Segment(obxLine, sep);
  const setId = Number.parseInt(obx.field(1).trim(), 10);
  const abnormalFlagsRaw = obx
    .repetitions(8)
    .map((f) => f.trim().toUpperCase())
    .filter((f) => f.length > 0);
  return {
    setId: Number.isFinite(setId) ? setId : 0,
    valueType: obx.field(2).trim().toUpperCase(),
    loincCode: obx.component(3, 1),
    loincText: obx.component(3, 2),
    value: obx.field(5),
    units: obx.component(6, 1),
    referenceRange: obx.field(7).trim(),
    abnormalFlagsRaw,
    resultStatusRaw: obx.field(11).trim().toUpperCase(),
    observationDateRaw: obx.field(14).trim(),
  };
}

/**
 * Project a raw ORU^R01 frame into {@link ProjectedOru}. Returns `null` when the frame has no PID or no OBX
 * segment — an ORU with no result line (or no patient identity to fall back on) is a parse-validation
 * failure (the caller marks `parse_status='parse_error'` and stops, mirroring `projectAdt`). The MSH
 * envelope is (re)parsed here so the projection is self-contained and testable.
 */
export function projectOru(payload: string): ProjectedOru | null {
  const segments = splitSegments(payload);
  const mshLine = findSegment(segments, "MSH");
  if (!mshLine) return null;
  const sep: Hl7Separators = mshLine ? readSeparators(mshLine) : HL7_DEFAULT_SEPARATORS;
  let envelope: MshEnvelope;
  try {
    envelope = parseMshEnvelope(payload);
  } catch {
    return null;
  }

  const pidLine = findSegment(segments, "PID");
  if (!pidLine) return null;

  const obxLines = segments.filter((s) => s.startsWith("OBX"));
  if (obxLines.length === 0) return null;

  const messageType = envelope.triggerEvent
    ? `${envelope.messageCode}^${envelope.triggerEvent}`
    : envelope.messageCode;

  return {
    messageType,
    obr: projectObr(findSegment(segments, "OBR"), sep),
    obxList: obxLines.map((line) => projectObx(line, sep)),
    patientCandidate: projectPid(pidLine, sep),
  };
}
