// @wardenx/x12-837-client — the 837I party loops shared by every generator (notice, claim): submitter and
// receiver (1000A/B), billing provider (2000A/2010AA), subscriber = patient (2000B/2010BA) and payer (2010BB).
// Errors name the FIELD only (PHI); callers wrap them in their own error type.
import { MBI_PATTERN } from "../eligibility/build-270";
import {
  NAME_LIMIT,
  ORG_NAME_LIMIT,
  type X12Address,
  X12BuildError,
  type X12PersonName,
  addressSegments,
  d8,
  matches,
  npi,
  optionalText,
  text,
} from "./writer";

export interface Parties837i {
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
  /** The beneficiary — the subscriber IS the patient on hospice 837Is. */
  readonly subscriber: X12PersonName & {
    readonly mbi: string;
    readonly address: X12Address;
    readonly birthDate: string;
    readonly sex: "M" | "F";
  };
  readonly payer: { readonly name: string; readonly payerId: string };
}

const submitterOrReceiver = (
  role: "41" | "40",
  party: { name: string; id: string },
  field: string,
): string[] => [
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

/**
 * Segments from the submitter NM1 to the payer NM1 (everything between BHT and CLM). `onOrAfterBirth` is the
 * earliest clinical date (CCYYMMDD); a birth date after it is refused.
 */
export function partySegments(p: Parties837i, onOrAfterBirth: string): string[][] {
  const s = p.subscriber;
  if (typeof s.mbi !== "string") throw new X12BuildError("subscriber.mbi");
  const mbi = s.mbi.trim().toUpperCase();
  if (!MBI_PATTERN.test(mbi)) throw new X12BuildError("subscriber.mbi");
  if (s.sex !== "M" && s.sex !== "F") throw new X12BuildError("subscriber.sex");
  const dob = d8(s.birthDate, "subscriber.birthDate");
  if (dob > onOrAfterBirth) throw new X12BuildError("subscriber.birthDate");
  if (!matches(/^\d{9}$/, p.billingProvider.taxId))
    throw new X12BuildError("billingProvider.taxId");
  if (!matches(/^\d{10}$/, p.submitter.contactPhone))
    throw new X12BuildError("submitter.contactPhone");
  return [
    submitterOrReceiver("41", p.submitter, "submitter"),
    [
      "PER",
      "IC",
      text(p.submitter.contactName, "submitter.contactName", NAME_LIMIT),
      "TE",
      p.submitter.contactPhone,
    ],
    submitterOrReceiver("40", p.receiver, "receiver"),
    ["HL", "1", "", "20", "1"],
    [
      "NM1",
      "85",
      "2",
      text(p.billingProvider.organizationName, "billingProvider.organizationName", ORG_NAME_LIMIT),
      "",
      "",
      "",
      "",
      "XX",
      npi(p.billingProvider.npi, "billingProvider.npi"),
    ],
    ...addressSegments(p.billingProvider.address, "billingProvider.address"),
    ["REF", "EI", p.billingProvider.taxId],
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
      text(p.payer.name, "payer.name", ORG_NAME_LIMIT),
      "",
      "",
      "",
      "",
      "PI",
      text(p.payer.payerId, "payer.payerId", 80),
    ],
  ];
}
