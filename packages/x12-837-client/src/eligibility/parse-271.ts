// @wardenx/x12-837-client — the pure HETS 271 (005010X279A1) response parser.
//
// Sources (CMS HETS 270/271 5010 Companion Guide, cited by section):
//   §7.5.1 / Table 23 — Part A entitlement: 2110C `EB*1**…*MA` + `DTP*291` (D8 start, or RD8 start-end);
//                       `EB*6…*MA` = Part A not (yet / any longer) active for the requested dates.
//   §7.16 / Table 38  — hospice: 2110C `EB*X**45*MA**26`, `DTP*292*D8` = a Notice of Election (NOE),
//                       `DTP*292*RD8` = a billed hospice benefit period, `DTP*435*RD8` = DOEBA–DOLBA
//                       (earliest/latest billing activity, last 4 years only), `HSD*DY*n` = days used,
//                       `MSG*Revocation Code – n` (0 open spell, 1 NOTR, 2 NOTR + occ. 42, 3 claim occ. 23),
//                       2120C `LS*2120 / NM1*1P*2******XX*<npi> / LE*2120` = the rendering hospice NPI.
//   §8.3 / Table 11   — AAA reject reasons per loop (2100A system, 2100B provider, 2100C beneficiary).
//
// MBI CONFINEMENT (D13 / §3.6 / §8.7): HETS echoes the submitted MBI in 2100C `NM1*IL…*MI*<mbi>` (CG
// Table 26). This parser never reads NM1*IL, N3/N4, DMG or REF — the output is built only from the
// segments listed above, and {@link assertNoMbi} lets the caller prove the result carries no MBI.
import { MBI_PATTERN } from "./build-270";
import { parseDtpValue, tokenizeInterchange } from "./x12-envelope";

/** The `eligibility_check.outcome` domain values (M23 §3, the `eligibility_outcome` enum). */
export type Hets271Outcome =
  | "active_part_a"
  | "inactive_part_a"
  | "mbi_invalid"
  | "unknown_response"
  | "hets_error";

/** HETS revocation codes (CG §7.16). `null` when the period carried no MSG revocation segment. */
export type HospiceRevocationCode = "0" | "1" | "2" | "3";

/** One hospice record exactly as the 271 reports it (before numbering / derivation). */
export interface HospiceRecord {
  /** `election` = a NOE (`DTP*292*D8`); `benefit_period` = a billed period (`DTP*292*RD8`). */
  readonly kind: "election" | "benefit_period";
  readonly startDate: string;
  readonly endDate: string | null;
  readonly daysUsed: number | null;
  /** DOEBA / DOLBA (`DTP*435`), returned only for billed periods in the last four years. */
  readonly billingActivityStart: string | null;
  readonly billingActivityEnd: string | null;
  readonly revocationCode: HospiceRevocationCode | null;
  readonly hospiceNpi: string | null;
}

/** One AAA rejection. `loop` is where it sat (2100A system, 2100B provider, 2100C beneficiary). */
export interface Hets271Rejection {
  readonly loop: "2100A" | "2100B" | "2100C" | "2110C";
  readonly code: string;
  readonly followUp: string | null;
}

/** One Part A entitlement period (`EB*1…MA` + `DTP*291`). */
export interface PartAEntitlement {
  readonly start: string | null;
  readonly end: string | null;
}

export interface Parsed271 {
  /** What the interchange actually was: a 271, or a 999 / TA1 rejection of our 270. */
  readonly transaction: "271" | "999" | "TA1" | "unknown";
  readonly outcome: Hets271Outcome;
  /** TRN*2 trace echoed from our 270 (PHI-free correlation id), or null. */
  readonly traceNumber: string | null;
  readonly rejections: readonly Hets271Rejection[];
  readonly partA: {
    /** True when an entitlement period covers `asOfServiceDate`. */
    readonly active: boolean;
    readonly entitlements: readonly PartAEntitlement[];
    /** An `EB*6…MA` was returned (Part A inactive for the requested dates). */
    readonly inactiveReported: boolean;
  };
  readonly hospiceRecords: readonly HospiceRecord[];
}

/** AAA03 beneficiary-match failures (CG Table 11, 2100C): DOB/name/MBI not matched or missing. */
const BENEFICIARY_NOT_MATCHED = new Set(["58", "71", "72", "73"]);

const REVOCATION = /revocation\s*code\s*[–—-]?\s*([0-3])\b/i;

interface HospiceDraft {
  kind: HospiceRecord["kind"] | null;
  startDate: string | null;
  endDate: string | null;
  daysUsed: number | null;
  billingActivityStart: string | null;
  billingActivityEnd: string | null;
  revocationCode: HospiceRevocationCode | null;
  hospiceNpi: string | null;
}

type EbContext =
  | { readonly kind: "part_a_active"; entitlement: { start: string | null; end: string | null } }
  | { readonly kind: "hospice"; draft: HospiceDraft }
  | { readonly kind: "other" };

const covers = (e: PartAEntitlement, date: string): boolean =>
  (e.start === null || e.start <= date) && (e.end === null || e.end >= date);

/**
 * Parse a HETS response interchange. Never throws on business content — a malformed or non-271 payload
 * yields `outcome: "hets_error"` / `"unknown_response"`; only a payload that is not X12 at all throws
 * (an `X12FormatError` with a content-free message).
 */
export function parse271(raw: string, opts: { readonly asOfServiceDate: string }): Parsed271 {
  const { delimiters, segments } = tokenizeInterchange(raw);
  const repetition = delimiters.repetition;

  const stId = segments.find((s) => s[0] === "ST")?.[1];
  const hasTa1 = segments.some((s) => s[0] === "TA1");
  const transaction: Parsed271["transaction"] =
    stId === "271" ? "271" : stId === "999" ? "999" : hasTa1 && !stId ? "TA1" : "unknown";

  const rejections: Hets271Rejection[] = [];
  const entitlements: PartAEntitlement[] = [];
  const hospiceRecords: HospiceRecord[] = [];
  let inactiveReported = false;
  let traceNumber: string | null = null;
  let hlLevel: string | null = null;
  let inEligibilityLoop = false;
  let inLs2120 = false;
  let eb: EbContext | null = null;

  const closeEb = (): void => {
    if (eb?.kind === "part_a_active") entitlements.push({ ...eb.entitlement });
    if (eb?.kind === "hospice") {
      const d = eb.draft;
      if (d.kind && d.startDate) {
        hospiceRecords.push({
          kind: d.kind,
          startDate: d.startDate,
          endDate: d.kind === "election" ? null : d.endDate,
          daysUsed: d.daysUsed,
          billingActivityStart: d.billingActivityStart,
          billingActivityEnd: d.billingActivityEnd,
          revocationCode: d.revocationCode,
          hospiceNpi: d.hospiceNpi,
        });
      }
    }
    eb = null;
  };

  if (transaction === "271") {
    for (const seg of segments) {
      const id = seg[0];
      if (id === "HL") {
        closeEb();
        hlLevel = seg[3] ?? null;
        inEligibilityLoop = false;
        continue;
      }
      if (id === "SE") {
        closeEb();
        continue;
      }
      if (id === "TRN" && seg[1] === "2" && hlLevel === "22") {
        traceNumber = seg[2] ?? null;
        continue;
      }
      if (id === "AAA") {
        const loop: Hets271Rejection["loop"] = inEligibilityLoop
          ? "2110C"
          : hlLevel === "20"
            ? "2100A"
            : hlLevel === "21"
              ? "2100B"
              : "2100C";
        rejections.push({ loop, code: seg[3] ?? "", followUp: seg[4] || null });
        continue;
      }
      if (id === "EB") {
        closeEb();
        inEligibilityLoop = true;
        const info = seg[1];
        const serviceTypes = (seg[3] ?? "").split(repetition);
        const insuranceType = seg[4];
        if (info === "1" && insuranceType === "MA" && !serviceTypes.includes("80")) {
          eb = { kind: "part_a_active", entitlement: { start: null, end: null } };
        } else if (info === "6" && insuranceType === "MA") {
          inactiveReported = true;
          eb = { kind: "other" };
        } else if (info === "X" && serviceTypes.includes("45")) {
          eb = {
            kind: "hospice",
            draft: {
              kind: null,
              startDate: null,
              endDate: null,
              daysUsed: null,
              billingActivityStart: null,
              billingActivityEnd: null,
              revocationCode: null,
              hospiceNpi: null,
            },
          };
        } else {
          eb = { kind: "other" };
        }
        continue;
      }
      if (!eb) continue;
      const ctx: EbContext = eb;
      if (id === "LS") {
        inLs2120 = true;
        continue;
      }
      if (id === "LE") {
        inLs2120 = false;
        continue;
      }
      if (ctx.kind === "part_a_active" && id === "DTP" && seg[1] === "291") {
        const range = parseDtpValue(seg[2], seg[3]);
        if (range) ctx.entitlement = { start: range.start, end: range.end };
        continue;
      }
      if (ctx.kind !== "hospice") continue;
      const d = ctx.draft;
      if (id === "DTP" && seg[1] === "292") {
        const range = parseDtpValue(seg[2], seg[3]);
        if (range) {
          d.kind = seg[2] === "D8" ? "election" : "benefit_period";
          d.startDate = range.start;
          d.endDate = range.end;
        }
      } else if (id === "DTP" && seg[1] === "435") {
        const range = parseDtpValue(seg[2], seg[3]);
        if (range) {
          d.billingActivityStart = range.start;
          d.billingActivityEnd = range.end;
        }
      } else if (id === "HSD" && seg[1] === "DY") {
        const days = Number(seg[2]);
        d.daysUsed = Number.isInteger(days) && days >= 0 ? days : null;
      } else if (id === "MSG") {
        const match = REVOCATION.exec(seg[1] ?? "");
        if (match) d.revocationCode = match[1] as HospiceRevocationCode;
      } else if (id === "NM1" && inLs2120 && seg[1] === "1P" && seg[8] === "XX") {
        const npi = seg[9] ?? "";
        d.hospiceNpi = /^\d{10}$/.test(npi) ? npi : null;
      }
    }
    closeEb();
  }

  const active = entitlements.some((e) => covers(e, opts.asOfServiceDate));
  return {
    transaction,
    outcome: decideOutcome({ transaction, rejections, active, entitlements, inactiveReported }),
    traceNumber,
    rejections,
    partA: { active, entitlements, inactiveReported },
    hospiceRecords,
  };
}

function decideOutcome(input: {
  transaction: Parsed271["transaction"];
  rejections: readonly Hets271Rejection[];
  active: boolean;
  entitlements: readonly PartAEntitlement[];
  inactiveReported: boolean;
}): Hets271Outcome {
  if (input.transaction !== "271") return "hets_error";
  const beneficiaryRejection = input.rejections.some(
    (r) => r.loop === "2100C" && BENEFICIARY_NOT_MATCHED.has(r.code),
  );
  if (beneficiaryRejection) return "mbi_invalid";
  if (input.rejections.length > 0) return "hets_error";
  if (input.active) return "active_part_a";
  if (input.entitlements.length > 0 || input.inactiveReported) return "inactive_part_a";
  return "unknown_response";
}

/** Thrown by {@link assertNoMbi}. Content-free message — never echoes the value it found. */
export class MbiLeakError extends Error {
  public override readonly name = "MbiLeakError";
  constructor() {
    super("MBI_LEAK: a value shaped like an MBI was found in a payload bound for persistence");
  }
}

const MBI_ANYWHERE = new RegExp(MBI_PATTERN.source.slice(1, -1));

/**
 * Throw {@link MbiLeakError} when `value` (serialized) contains the given MBI or ANY MBI-shaped token.
 * The persistence-boundary guard of §8.7: "the parser is configured to reject any 271 response that would
 * persist the MBI back into the response payload".
 */
export function assertNoMbi(value: unknown, mbi?: string): void {
  const text = JSON.stringify(value) ?? "";
  if ((mbi && mbi.length > 0 && text.includes(mbi)) || MBI_ANYWHERE.test(text)) {
    throw new MbiLeakError();
  }
}
