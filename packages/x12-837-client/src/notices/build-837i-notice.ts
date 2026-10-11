// @wardenx/x12-837-client — the ASC X12N 837I (005010X223A2) Notice of Election (TOB 81A) and Notice of
// Termination/Revocation (TOB 81B). PURE string building (ADR-0037, ADR-0053 D9); no network, no clock (the caller
// passes `createdAt`). Shape follows the CMS 837I NOE Companion Guide v1.2 and the payloads the Stedi sandbox
// accepted on 2026-10-09 (golden fixtures `stedi-NOE_81A.x12` / `stedi-NOTR_81B.x12`).
//
// Sandbox-observed rules this builder honours: BHT06 `RP` (`CH` with a $0 charge is rejected; whether a MAC wants
// CH is an open question for the Stedi call), CLM02 `0`, CL102 `1`, one `SV2*0650*HC:Q5009` line whose
// description is the notice kind. Passing the edits is not payer acceptance.
import { MBI_PATTERN } from "../eligibility/build-270";
import {
  NAME_LIMIT,
  ORG_NAME_LIMIT,
  type X12Address,
  X12BuildError,
  type X12Envelope,
  type X12PersonName,
  type X12Physician,
  addressSegments,
  d8,
  hi,
  npi,
  optionalText,
  physicianName,
  prepareEnvelope,
  text,
  wrapTransaction,
} from "../x12/writer";

/** Thrown for an input the notice cannot carry. Names the FIELD only, never its value (PHI). */
export class Notice837iBuildError extends X12BuildError {
  public override readonly name = "Notice837iBuildError";
  constructor(field: string) {
    super(field, `invalid 837I notice input: ${field}`);
  }
}

/** Per kind: type-of-bill frequency, CL103 patient status (as validated in the sandbox) and SV2 description. */
const KINDS = {
  NOE: { frequency: "A", patientStatus: "30", description: "NOE" },
  NOTR: { frequency: "B", patientStatus: "40", description: "NOTR" },
} as const;

export type NoticeKind = keyof typeof KINDS;

export type NoticeDocument =
  | {
      readonly kind: "NOE";
      readonly controlNumber: string;
      /** Hospice election / admission date. */
      readonly admissionDate: string;
    }
  | {
      readonly kind: "NOTR";
      readonly controlNumber: string;
      readonly admissionDate: string;
      /** The last day of hospice care (discharge, revocation or death). */
      readonly terminationDate: string;
    };

export interface Notice837iInput {
  readonly envelope: X12Envelope;
  readonly submitter: {
    readonly name: string;
    readonly id: string;
    readonly contactName: string;
    readonly contactPhone: string;
  };
  readonly receiver: { readonly name: string; readonly id: string };
  readonly billingProvider: {
    readonly organizationName: string;
    readonly npi: string;
    /** EIN, 9 digits. */
    readonly taxId: string;
    readonly address: X12Address;
  };
  /** The beneficiary — the subscriber IS the patient on a notice. */
  readonly subscriber: X12PersonName & {
    readonly mbi: string;
    readonly address: X12Address;
    readonly birthDate: string;
    readonly sex: "M" | "F";
  };
  readonly payer: { readonly name: string; readonly payerId: string };
  readonly notice: NoticeDocument;
  /** ICD-10-CM, with or without the dot. */
  readonly principalDiagnosis: string;
  readonly attendingPhysician: X12Physician;
}

/** Build the 837I interchange for one NOE or NOTR (ISA … IEA, one ST-SE). */
export function build837iNotice(input: Notice837iInput): string {
  try {
    return buildNotice(input);
  } catch (e) {
    // The shared writer's helpers throw the base error; callers of this builder catch its own type.
    if (e instanceof X12BuildError && !(e instanceof Notice837iBuildError)) {
      throw new Notice837iBuildError(e.field);
    }
    throw e;
  }
}

function buildNotice(input: Notice837iInput): string {
  const { notice } = input;
  const kind = KINDS[notice.kind];
  if (!/^[A-Za-z0-9-]{1,38}$/.test(notice.controlNumber)) {
    throw new Notice837iBuildError("notice.controlNumber");
  }
  const admission = d8(notice.admissionDate, "notice.admissionDate");
  const hasTermination = "terminationDate" in notice && notice.terminationDate !== undefined;
  if (hasTermination !== (notice.kind === "NOTR")) {
    throw new Notice837iBuildError("notice.terminationDate");
  }
  const through =
    notice.kind === "NOTR" ? d8(notice.terminationDate, "notice.terminationDate") : admission;
  if (through < admission) throw new Notice837iBuildError("notice.terminationDate");

  const s = input.subscriber;
  const mbi = s.mbi.trim().toUpperCase();
  if (!MBI_PATTERN.test(mbi)) throw new Notice837iBuildError("subscriber.mbi");
  const dob = d8(s.birthDate, "subscriber.birthDate");
  if (dob > admission) throw new Notice837iBuildError("subscriber.birthDate");
  const dx = input.principalDiagnosis.replace(".", "").trim().toUpperCase();
  if (!/^[A-Z][0-9][0-9A-Z]{1,5}$/.test(dx)) throw new Notice837iBuildError("principalDiagnosis");
  if (!/^\d{9}$/.test(input.billingProvider.taxId)) {
    throw new Notice837iBuildError("billingProvider.taxId");
  }
  const env = prepareEnvelope(input.envelope);
  if (!/^\d{10}$/.test(input.submitter.contactPhone)) {
    throw new Notice837iBuildError("submitter.contactPhone");
  }
  const { ccyymmdd, hhmm } = env.stamp;
  const edi = (role: "41" | "40", party: { name: string; id: string }, field: string): string[] => [
    "NM1",
    role,
    "2",
    text(party.name, `${field}.name`, ORG_NAME_LIMIT),
    "",
    "",
    "",
    "",
    "46",
    text(party.id, `${field}.id`, 80),
  ];

  const body: string[][] = [
    ["BHT", "0019", "00", notice.controlNumber, ccyymmdd, hhmm, "RP"],
    edi("41", input.submitter, "submitter"),
    [
      "PER",
      "IC",
      text(input.submitter.contactName, "submitter.contactName", NAME_LIMIT),
      "TE",
      input.submitter.contactPhone,
    ],
    edi("40", input.receiver, "receiver"),
    ["HL", "1", "", "20", "1"],
    [
      "NM1",
      "85",
      "2",
      text(
        input.billingProvider.organizationName,
        "billingProvider.organizationName",
        ORG_NAME_LIMIT,
      ),
      "",
      "",
      "",
      "",
      "XX",
      npi(input.billingProvider.npi, "billingProvider.npi"),
    ],
    ...addressSegments(input.billingProvider.address, "billingProvider.address"),
    ["REF", "EI", input.billingProvider.taxId],
    ["HL", "2", "1", "22", "0"],
    ["SBR", "P", "18", "", "", "", "", "", "", "MA"],
    [
      "NM1",
      "IL",
      "1",
      text(s.lastName, "subscriber.lastName", NAME_LIMIT),
      text(s.firstName, "subscriber.firstName", 35),
      optionalText(s.middleInitial, "subscriber.middleInitial", 1),
      "",
      "",
      "MI",
      mbi,
    ],
    ...addressSegments(s.address, "subscriber.address"),
    ["DMG", "D8", dob, s.sex],
    [
      "NM1",
      "PR",
      "2",
      text(input.payer.name, "payer.name", ORG_NAME_LIMIT),
      "",
      "",
      "",
      "",
      "PI",
      text(input.payer.payerId, "payer.payerId", 80),
    ],
    ["CLM", notice.controlNumber, "0", "", "", `81:A:${kind.frequency}`, "", "A", "Y", "Y"],
    ["DTP", "434", "RD8", `${admission}-${through}`],
    ["DTP", "435", "D8", admission],
    ["CL1", "1", "1", kind.patientStatus],
    ["HI", `ABK:${dx}`],
    ...hi("BH", [`27:D8:${admission}`]),
    physicianName(input.attendingPhysician, "71", "attendingPhysician"),
    ["LX", "1"],
    ["SV2", "0650", `HC:Q5009:::::${kind.description}`, "0", "UN", "1"],
    ["DTP", "472", "D8", through],
  ];
  return wrapTransaction(env, { transactionSet: "837", body });
}
