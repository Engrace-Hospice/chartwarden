// @wardenx/x12-837-client — SYNTHETIC HETS 271 responses (no real beneficiary data), shaped after the
// CMS HETS 270/271 5010 Companion Guide Appendix B + §7.16 examples. Used by the sandbox transport (dev /
// test only) and by the codec unit tests. Like real HETS, every 271 echoes the submitted MBI in 2100C
// NM1*IL — so the parser's MBI-confinement is exercised on every scenario.

/** The canned scenarios the sandbox can answer with. */
export type Hets271Scenario =
  | "active_with_history"
  | "open_election"
  | "no_hospice_history"
  | "inactive_part_a"
  | "mbi_not_found"
  | "system_unavailable"
  | "rejected_999";

export const HETS_271_SCENARIOS: readonly Hets271Scenario[] = [
  "active_with_history",
  "open_election",
  "no_hospice_history",
  "inactive_part_a",
  "mbi_not_found",
  "system_unavailable",
  "rejected_999",
];

/** The request echo a synthetic 271 needs (taken from the 270 being answered). */
export interface Synthetic271Context {
  readonly traceNumber: string;
  readonly submitterId: string;
  readonly providerNpi: string;
  readonly mbi: string;
  readonly lastName: string;
  readonly firstName: string;
}

/** Synthetic NPIs of OTHER hospices (Luhn-valid test NPIs used in CMS examples). */
export const SYNTHETIC_OTHER_HOSPICE_NPI = "1649726464";
export const SYNTHETIC_SECOND_HOSPICE_NPI = "1234567893";

const PART_A = "EB*1**30^10^42^45^48^49^69^76^83^A5^A7^AG^BT^BU^BV^RN*MA";
const PART_B =
  "EB*1**30^2^3^23^24^25^26^27^28^33^36^37^38^39^40^42^50^51^52^53^64^67^69^73^76^83^86^98*MB";

function hospicePeriodSegments(p: {
  readonly kind: "noe" | "billed";
  readonly start: string;
  readonly end?: string;
  readonly days?: number;
  readonly revocation: string;
  readonly npi: string;
}): string[] {
  return [
    "EB*X**45*MA**26",
    ...(p.kind === "billed" && p.days !== undefined ? [`HSD*DY*${p.days}`] : []),
    p.kind === "noe" ? `DTP*292*D8*${p.start}` : `DTP*292*RD8*${p.start}-${p.end}`,
    ...(p.kind === "billed" ? [`DTP*435*RD8*${p.start}-${p.end}`] : []),
    // HETS writes an en dash: "Revocation Code – 1" (CG §7.16).
    `MSG*Revocation Code – ${p.revocation}`,
    "LS*2120",
    `NM1*1P*2******XX*${p.npi}`,
    "LE*2120",
  ];
}

/** Three revoked billed periods at other hospices (90 / 90 / 60 days) — the next election is period 4. */
const CLOSED_HISTORY = [
  { kind: "noe", start: "20230110", revocation: "1", npi: SYNTHETIC_OTHER_HOSPICE_NPI },
  {
    kind: "billed",
    start: "20230110",
    end: "20230409",
    days: 90,
    revocation: "1",
    npi: SYNTHETIC_OTHER_HOSPICE_NPI,
  },
  {
    kind: "billed",
    start: "20230410",
    end: "20230708",
    days: 90,
    revocation: "1",
    npi: SYNTHETIC_OTHER_HOSPICE_NPI,
  },
  {
    kind: "billed",
    start: "20230709",
    end: "20230820",
    days: 43,
    revocation: "2",
    npi: SYNTHETIC_SECOND_HOSPICE_NPI,
  },
] as const;

/** An open election at another hospice: an NOE (revocation code 0) whose first period is not billed yet. */
const OPEN_ELECTION = [
  { kind: "noe", start: "20260915", revocation: "0", npi: SYNTHETIC_OTHER_HOSPICE_NPI },
] as const;

function envelope(ctx: Synthetic271Context, st: string[]): string {
  const isa = [
    "ISA",
    "00",
    "          ",
    "00",
    "          ",
    "ZZ",
    "CMS".padEnd(15, " "),
    "ZZ",
    ctx.submitterId.padEnd(15, " ").slice(0, 15),
    "261006",
    "0734",
    "^",
    "00501",
    "111111111",
    "0",
    "T",
    "|",
  ].join("*");
  const segments = [
    isa,
    `GS*${st[0] === "ST*999*0001*005010X231A1" ? "FA" : "HB"}*CMS*${ctx.submitterId}*20261006*0734*1*X*${st[0] === "ST*999*0001*005010X231A1" ? "005010X231A1" : "005010X279A1"}`,
    ...st,
    `SE*${st.length + 1}*0001`,
    "GE*1*1",
    "IEA*1*111111111",
  ];
  return `${segments.join("~\n")}~\n`;
}

function header(ctx: Synthetic271Context): string[] {
  return [
    "ST*271*0001*005010X279A1",
    "BHT*0022*11*SANDBOX*20261006*0734",
    "HL*1**20*1",
    "NM1*PR*2*CMS*****PI*CMS",
    "HL*2*1*21*1",
    `NM1*1P*2*SANDBOX HOSPICE*****XX*${ctx.providerNpi}`,
    "HL*3*2*22*0",
    `TRN*2*${ctx.traceNumber}*9SANDBOX00`,
    `NM1*IL*1*${ctx.lastName}*${ctx.firstName}****MI*${ctx.mbi}`,
    "N3*1 SYNTHETIC WAY",
    "N4*PORTLAND*OR*97201",
    "DMG*D8*19400401*F",
  ];
}

/** Build a synthetic 271 (or 999) interchange for a scenario. */
export function synthetic271(scenario: Hets271Scenario, ctx: Synthetic271Context): string {
  const partA = [PART_A, "DTP*291*D8*20050401", "MSG*0 – Beneficiary insured due to age OASI"];
  const partB = [PART_B, "DTP*291*D8*20050401"];
  switch (scenario) {
    case "active_with_history":
      return envelope(ctx, [
        ...header(ctx),
        ...partA,
        ...partB,
        ...CLOSED_HISTORY.flatMap(hospicePeriodSegments),
      ]);
    case "open_election":
      return envelope(ctx, [
        ...header(ctx),
        ...partA,
        ...partB,
        ...CLOSED_HISTORY.flatMap(hospicePeriodSegments),
        ...OPEN_ELECTION.flatMap(hospicePeriodSegments),
      ]);
    case "no_hospice_history":
      return envelope(ctx, [...header(ctx), ...partA, ...partB]);
    case "inactive_part_a":
      return envelope(ctx, [
        ...header(ctx),
        "EB*6**30^10^42^45^48^49^69^76^83^A5^A7^AG^BT^BU^BV^RN*MA",
        ...partB,
      ]);
    case "mbi_not_found":
      return envelope(ctx, [
        ...header(ctx).slice(0, 8),
        `NM1*IL*1*${ctx.lastName}*${ctx.firstName}****MI*${ctx.mbi}`,
        "AAA*N**72*C",
      ]);
    case "system_unavailable":
      return envelope(ctx, [
        "ST*271*0001*005010X279A1",
        "BHT*0022*11*SANDBOX*20261006*0734",
        "HL*1**20*1",
        "NM1*PR*2*CMS*****PI*CMS",
        "AAA*Y**42*R",
      ]);
    case "rejected_999":
      return envelope(ctx, [
        "ST*999*0001*005010X231A1",
        "AK1*HS*1*005010X279A1",
        "AK2*270*0001*005010X279A1",
        "IK5*R*5",
        "AK9*R*1*1*0",
      ]);
  }
}
