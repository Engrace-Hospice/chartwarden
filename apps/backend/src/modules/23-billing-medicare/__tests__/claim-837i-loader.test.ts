// M23 — the claim-to-837I loader: a persisted claim (+ lines, snapshot columns, M6 admission date, M5 identity via the
// seams, parties) -> Claim837iInput -> the raw 837I and Stedi JSON. The golden claim reproduces the payload the Stedi
// sandbox accepted on 2026-10-09 (packages/x12-837-client `stedi-claim.x12`), so a drift in the mapping shows here.
import { inspect } from "node:util";
import type { repositories } from "@wardenx/billing";
import type { ClearinghouseContext } from "@wardenx/x12-837-client";
import { describe, expect, it, vi } from "vitest";
import {
  type Claim837iLoaderDeps,
  type Claim837iPartiesPort,
  loadAndRender837i,
  loadClaim837iInput,
} from "../services/claim-837i-loader";

const GOLDEN_837I_SEGMENTS: readonly string[] = [
  "ISA*00*          *00*          *ZZ*WARDENX01      *ZZ*STEDI          *261009*1500*^*00501*000000101*1*T*:",
  "GS*HC*WARDENX01*STEDI*20261009*1500*101*X*005010X223A2",
  "ST*837*0101*005010X223A2",
  "BHT*0019*00*WXHOSP0001*20261009*1500*CH",
  "NM1*41*2*EXAMPLE HOSPICE OF OREGON*****46*WARDENX01",
  "PER*IC*BILLING OFFICE*TE*5035550100",
  "NM1*40*2*STEDI TEST PAYER*****46*STEDI",
  "HL*1**20*1",
  "NM1*85*2*EXAMPLE HOSPICE OF OREGON*****XX*1234567893",
  "N3*100 MAIN ST",
  "N4*PORTLAND*OR*972011234",
  "REF*EI*931234567",
  "HL*2*1*22*0",
  "SBR*P*18*******MA",
  "NM1*IL*1*DOE*JANE****MI*1EG4TE5MK73",
  "N3*200 OAK AVE",
  "N4*SALEM*OR*97301",
  "DMG*D8*19400315*F",
  "NM1*PR*2*STEDI TEST PAYER*****PI*STEDI",
  "CLM*WXHOSP0001*1500.00***81:A:3**A*Y*Y",
  "DTP*434*RD8*20260101-20260131",
  "DTP*435*D8*20260101",
  "CL1*1*1*30",
  "HI*ABK:C3490",
  "HI*BH:27:D8:20260101",
  "HI*BE:61:::38900*BE:G8:::38900",
  "NM1*71*1*SMITH*ALAN****XX*1245319599",
  "LX*1",
  "SV2*0651*HC:Q5001*200.00*UN*1",
  "DTP*472*D8*20260101",
  "LX*2",
  "SV2*0652*HC:Q5001*800.00*UN*32",
  "DTP*472*D8*20260102",
  "LX*3",
  "SV2*0655*HC:Q5006*500.00*UN*1",
  "DTP*472*D8*20260110",
  "SE*35*0101",
  "GE*1*101",
  "IEA*1*000000101",
];
const GOLDEN_X12 = `${GOLDEN_837I_SEGMENTS.join("~")}~`;

const ORG = "00000000-0000-4000-8000-000000000001";
const PE = "00000000-0000-4000-8000-000000000002";
const PATIENT = "00000000-0000-4000-8000-000000000003";
const CLAIM_ID = "00000000-0000-4000-8000-000000000010";
const PRIOR_CLAIM_ID = "00000000-0000-4000-8000-000000000011";
const MBI = "1EG4TE5MK73";
const PATIENT_PAYER_ID = "00000000-0000-4000-8000-000000000004";
const PRIOR_PATIENT = "00000000-0000-4000-8000-000000000099";

const claim = (over: Partial<repositories.ClaimRecord> = {}): repositories.ClaimRecord =>
  ({
    id: CLAIM_ID,
    organizationId: ORG,
    providerEntityId: PE,
    patientId: PATIENT,
    patientPayerId: PATIENT_PAYER_ID,
    tob: "813",
    serviceFrom: "2026-01-01",
    serviceTo: "2026-01-31",
    claimControlNumber: "WXHOSP0001",
    payerClaimControlNumber: null,
    replacesClaimId: null,
    totalChargeCents: 150_000,
    patientStatusCode: "30",
    conditionCodes: [],
    occurrenceCodes: [{ code: "27", date: "2026-01-01" }],
    occurrenceSpans: [],
    valueCodes: [
      { code: "61", cbsaCode: "38900" },
      { code: "G8", cbsaCode: "38900" },
    ],
    admissionTypeCode: "1",
    admissionSourceCode: "1",
    attendingPhysicianNpi: "1245319599",
    certifyingPhysicianNpi: null,
    attendingPhysicianFirstName: "Alan",
    attendingPhysicianLastName: "Smith",
    certifyingPhysicianFirstName: null,
    certifyingPhysicianLastName: null,
    diagnosisSnapshot: [{ icd10Code: "C34.90", sequence: 1, qualifier: "ABK" }],
    ...over,
  }) as unknown as repositories.ClaimRecord;

const claimLine = (
  lineNumber: number,
  over: Record<string, unknown>,
): repositories.ClaimLineRecord =>
  ({
    lineNumber,
    qCode: "Q5001",
    hcpcsCode: null,
    modifiers: [],
    ...over,
  }) as unknown as repositories.ClaimLineRecord;

const LINES = [
  claimLine(1, {
    revenueCode: "0651",
    unitCount: 1,
    unitRateCents: 20_000,
    lineChargeCents: 20_000,
    serviceDateFrom: "2026-01-01",
    serviceDateTo: "2026-01-01",
  }),
  claimLine(2, {
    revenueCode: "0652",
    unitCount: 32,
    unitRateCents: 2_500,
    lineChargeCents: 80_000,
    serviceDateFrom: "2026-01-02",
    serviceDateTo: "2026-01-02",
  }),
  claimLine(3, {
    revenueCode: "0655",
    qCode: "Q5006",
    unitCount: 1,
    unitRateCents: 50_000,
    lineChargeCents: 50_000,
    serviceDateFrom: "2026-01-10",
    serviceDateTo: "2026-01-10",
  }),
];

const PARTIES = {
  submitter: {
    name: "Example Hospice of Oregon",
    id: "WARDENX01",
    contactName: "Billing Office",
    contactPhone: "5035550100",
  },
  receiver: { name: "Stedi Test Payer", id: "STEDI", applicationCode: "STEDI" },
  billingProvider: {
    organizationName: "Example Hospice of Oregon",
    npi: "1234567893",
    taxId: "931234567",
    address: { line1: "100 Main St", city: "Portland", state: "OR", postalCode: "97201-1234" },
  },
  payer: { name: "Stedi Test Payer", payerId: "STEDI" },
};

const CONTEXT: ClearinghouseContext = {
  organizationId: ORG,
  providerEntityId: PE,
  payerId: "STEDI",
  correlationId: "corr-1",
  usage: "test",
  billingNpi: "1234567893",
};

interface Overrides {
  claims?: readonly repositories.ClaimRecord[];
  lines?: readonly repositories.ClaimLineRecord[];
  admissionDate?: string | null;
  parties?: Awaited<ReturnType<Claim837iPartiesPort["partiesFor"]>>;
  identity?: { mbi: string; lastName: string; firstName: string; dateOfBirth: string } | null;
  sex?: string;
  dateOfBirth?: string;
  payerId?: string;
  address?: { state: string | null } | null;
}

function deps(o: Overrides = {}) {
  const claims = o.claims ?? [claim()];
  const unlock = vi.fn(async () =>
    o.identity === null
      ? null
      : {
          patientPayerId: o.payerId ?? PATIENT_PAYER_ID,
          ...(o.identity ?? {
            mbi: MBI,
            lastName: "Doe",
            firstName: "Jane",
            dateOfBirth: "1940-03-15",
          }),
        },
  );
  const findPatient = vi.fn(async () => ({
    administrativeSex: o.sex ?? "F",
    dateOfBirth: o.dateOfBirth ?? "1940-03-15",
  }));
  const primaryAddress = vi.fn(async () =>
    o.address === null
      ? null
      : {
          kind: "home",
          facilityId: null,
          line1: "200 Oak Ave",
          line2: null,
          city: "Salem",
          state: o.address ? o.address.state : "OR",
          postalCode: "97301",
          country: "US",
          county: null,
        },
  );
  const value = {
    persistence: {
      claimById: async (id: string) => claims.find((c) => c.id === id) ?? null,
      linesForClaim: async () => o.lines ?? LINES,
    },
    admission: {
      resolveForRange: async () =>
        o.admissionDate === null
          ? null
          : ({ hospiceAdmissionDate: o.admissionDate ?? "2026-01-01" } as never),
    },
    mbiUnlock: () => ({ unlockForEligibility: unlock }),
    patients: { findById: findPatient } as never,
    addresses: { primaryAddress } as never,
    parties: { partiesFor: async () => o.parties ?? PARTIES },
  } satisfies Claim837iLoaderDeps;
  return { value: value as Claim837iLoaderDeps, unlock, findPatient, primaryAddress };
}

const args = {
  claimId: CLAIM_ID,
  context: CONTEXT,
  interchangeControlNumber: 101,
  createdAt: new Date("2026-10-09T15:00:00.000Z"),
};

const gapsOf = (r: {
  readonly ok: boolean;
  readonly kind?: string;
  readonly gaps?: readonly { readonly field: string; readonly reason: string }[];
}): string[] =>
  r.ok
    ? []
    : r.kind === "gaps"
      ? (r.gaps ?? []).map((g) => `${g.field}:${g.reason}`)
      : [r.kind ?? "unknown"];

describe("loadClaim837iInput golden claim", () => {
  it("produces the sandbox-accepted raw 837I", async () => {
    const r = await loadAndRender837i(deps().value, args);
    if (!r.ok) throw new Error(`load failed: ${gapsOf(r).join(",")}`);
    expect(r.rendered.reveal().x12).toBe(GOLDEN_X12);
  });

  it("produces the matching Stedi JSON, with charges summing to the lines", async () => {
    const r = await loadAndRender837i(deps().value, args);
    if (!r.ok) throw new Error(`load failed: ${gapsOf(r).join(",")}`);
    const json = r.rendered.reveal().stediJson;
    expect(json.claimInformation.claimChargeAmount).toBe("1500.00");
    const lines = json.claimInformation.serviceLines.map((l) => l.institutionalService);
    expect(lines.map((l) => l.lineItemChargeAmount)).toEqual(["200.00", "800.00", "500.00"]);
    expect(lines.map((l) => l.procedureCode)).toEqual(["Q5001", "Q5001", "Q5006"]);
    expect(json.subscriber.memberId).toBe(MBI);
    expect(json.attending).toMatchObject({ npi: "1245319599", lastName: "SMITH" });
  });

  it("keeps the MBI out of the stored document", async () => {
    const r = await loadClaim837iInput(deps().value, args);
    if (!r.ok) throw new Error(`load failed: ${gapsOf(r).join(",")}`);
    expect(JSON.stringify(r.document)).not.toContain(MBI);
    expect(JSON.stringify(r.document)).not.toContain("Doe");
    expect(r.input.reveal().subscriber.mbi).toBe(MBI);
  });

  it("states the total as the sum of the line cents", async () => {
    const r = await loadClaim837iInput(deps().value, args);
    if (!r.ok) throw new Error(`load failed: ${gapsOf(r).join(",")}`);
    const lineSum = r.input.reveal().claim.lines.reduce((s, l) => s + l.chargeCents, 0);
    expect(lineSum).toBe(150_000);
    expect(r.document.totalChargeCents).toBe(lineSum);
  });

  it("uses a production interchange only for a production context", async () => {
    const r = await loadClaim837iInput(deps().value, {
      ...args,
      context: { ...CONTEXT, usage: "production" },
    });
    if (!r.ok) throw new Error(`load failed: ${gapsOf(r).join(",")}`);
    expect(r.input.reveal().envelope.usage).toBe("P");
  });
});

describe("loadClaim837iInput hospice fields", () => {
  it("emits non-covered charges, the occurrence span and ABF diagnoses", async () => {
    const lines = [
      claimLine(1, {
        revenueCode: "0651",
        unitCount: 4,
        unitRateCents: 25_000,
        lineChargeCents: 100_000,
        serviceDateFrom: "2026-01-01",
        serviceDateTo: "2026-01-04",
      }),
    ];
    const r = await loadAndRender837i(
      deps({
        lines,
        claims: [
          claim({
            totalChargeCents: 100_000,
            occurrenceSpans: [{ code: "77", from: "2026-01-01", through: "2026-01-02" }],
            diagnosisSnapshot: [
              { icd10Code: "I50.9", sequence: 2, qualifier: "ABF" },
              { icd10Code: "C34.90", sequence: 1, qualifier: "ABK" },
            ],
          } as never),
        ],
      }).value,
      args,
    );
    if (!r.ok) throw new Error(`load failed: ${gapsOf(r).join(",")}`);
    const segs = r.rendered.reveal().x12.split("~");
    expect(segs).toContain("HI*BI:77:RD8:20260101-20260102");
    expect(segs).toContain("HI*ABK:C3490");
    expect(segs).toContain("HI*ABF:I509");
    expect(segs).toContain("SV2*0651*HC:Q5001*1000.00*UN*4**500.00");
    expect(segs).toContain("DTP*472*RD8*20260101-20260104");
  });

  it("carries the predecessor's payer control number on a replacement", async () => {
    const prior = claim({ id: PRIOR_CLAIM_ID, payerClaimControlNumber: "12345678901234" });
    const r = await loadAndRender837i(
      deps({
        claims: [claim({ tob: "817", replacesClaimId: PRIOR_CLAIM_ID }), prior],
      }).value,
      args,
    );
    if (!r.ok) throw new Error(`load failed: ${gapsOf(r).join(",")}`);
    const segs = r.rendered.reveal().x12.split("~");
    expect(segs).toContain("CLM*WXHOSP0001*1500.00***81:A:7**A*Y*Y");
    expect(segs).toContain("REF*F8*12345678901234");
  });
});

describe("loadClaim837iInput predecessor claim", () => {
  const prior = (over: Partial<repositories.ClaimRecord> = {}) =>
    claim({ id: PRIOR_CLAIM_ID, payerClaimControlNumber: "12345678901234", ...over });
  const replacement = (tob: "817" | "818" = "817") =>
    claim({ tob, replacesClaimId: PRIOR_CLAIM_ID });

  it.each([
    ["another organization", { organizationId: "other-org" }],
    ["another provider entity", { providerEntityId: "other-pe" }],
    ["another patient", { patientId: PRIOR_PATIENT }],
    ["no payer control number yet", { payerClaimControlNumber: null }],
  ] as const)(
    "is a missing payerClaimControlNumber gap for a predecessor of %s",
    async (_n, over) => {
      const d = deps({ claims: [replacement(), prior(over as never)] });
      expect(gapsOf(await loadClaim837iInput(d.value, args))).toEqual([
        "payerClaimControlNumber:missing",
      ]);
      expect(d.unlock).not.toHaveBeenCalled();
    },
  );

  it("is a missing payerClaimControlNumber gap when the predecessor does not exist", async () => {
    const d = deps({ claims: [replacement()] });
    expect(gapsOf(await loadClaim837iInput(d.value, args))).toEqual([
      "payerClaimControlNumber:missing",
    ]);
  });

  it("renders a void (TOB 818) with frequency 8 and the predecessor's control number", async () => {
    const r = await loadAndRender837i(deps({ claims: [replacement("818"), prior()] }).value, args);
    if (!r.ok) throw new Error(`load failed: ${gapsOf(r).join(",")}`);
    const segs = r.rendered.reveal().x12.split("~");
    expect(segs).toContain("CLM*WXHOSP0001*1500.00***81:A:8**A*Y*Y");
    expect(segs).toContain("REF*F8*12345678901234");
  });
});

describe("loadClaim837iInput gaps", () => {
  it("is claim_not_found for another org or provider entity", async () => {
    const d = deps();
    expect(
      gapsOf(
        await loadClaim837iInput(d.value, {
          ...args,
          context: { ...CONTEXT, organizationId: "x" },
        }),
      ),
    ).toEqual(["claim_not_found"]);
    expect(
      gapsOf(
        await loadClaim837iInput(d.value, {
          ...args,
          context: { ...CONTEXT, providerEntityId: "x" },
        }),
      ),
    ).toEqual(["claim_not_found"]);
    expect(gapsOf(await loadClaim837iInput(d.value, { ...args, claimId: "nope" }))).toEqual([
      "claim_not_found",
    ]);
  });

  it("lists the claim gaps and does not read the beneficiary", async () => {
    const d = deps({ admissionDate: null, claims: [claim({ attendingPhysicianNpi: null })] });
    expect(gapsOf(await loadClaim837iInput(d.value, args))).toEqual([
      "admissionDate:missing",
      "attendingPhysician.npi:missing",
    ]);
    expect(d.unlock).not.toHaveBeenCalled();
  });

  it.each(["submitter", "receiver", "billingProvider", "payer"] as const)(
    "reports a missing %s party",
    async (name) => {
      const d = deps({ parties: { ...PARTIES, [name]: null } });
      const gaps = gapsOf(await loadClaim837iInput(d.value, args));
      expect(gaps).toContain(`${name}:missing`);
      expect(d.unlock).not.toHaveBeenCalled();
    },
  );

  it("requires billingNpi in production and a match to the billing provider otherwise", async () => {
    const { billingNpi: _omit, ...noNpi } = CONTEXT;
    expect(
      gapsOf(
        await loadClaim837iInput(deps().value, {
          ...args,
          context: { ...noNpi, usage: "production" },
        }),
      ),
    ).toEqual(["context.billingNpi:missing"]);
    expect(
      gapsOf(
        await loadClaim837iInput(deps().value, {
          ...args,
          context: { ...CONTEXT, billingNpi: "1982736455" },
        }),
      ),
    ).toEqual(["billingProvider.npi:inconsistent"]);
    expect((await loadClaim837iInput(deps().value, { ...args, context: noNpi })).ok).toBe(true);
  });

  it("reports an MBI that is not on file", async () => {
    expect(gapsOf(await loadClaim837iInput(deps({ identity: null }).value, args))).toEqual([
      "subscriber.mbi:missing",
    ]);
  });

  it("reports a missing sex, address, address state and date of birth WITHOUT unlocking the MBI", async () => {
    const cases: readonly [Overrides, string][] = [
      [{ sex: "U" }, "subscriber.sex:missing"],
      [{ address: null }, "subscriber.address:missing"],
      [{ address: { state: null } }, "subscriber.address.state:missing"],
      [{ dateOfBirth: "" }, "subscriber.dateOfBirth:missing"],
    ];
    for (const [over, expected] of cases) {
      const d = deps(over);
      expect(gapsOf(await loadClaim837iInput(d.value, args))).toEqual([expected]);
      expect(d.unlock).not.toHaveBeenCalled();
    }
  });

  it("unlocks the MBI exactly once, last, with the claim_837i_submission disclosure", async () => {
    const d = deps();
    const r = await loadClaim837iInput(d.value, args);
    expect(r.ok).toBe(true);
    expect(d.unlock).toHaveBeenCalledTimes(1);
    expect(d.unlock).toHaveBeenCalledWith({
      organizationId: ORG,
      patientId: PATIENT,
      onDate: "2026-01-01",
      expectedPatientPayerId: PATIENT_PAYER_ID,
      disclosure: { purpose: "claim_837i_submission", subjectId: CLAIM_ID },
    });
    const unlockOrder = d.unlock.mock.invocationCallOrder[0] as number;
    expect(d.findPatient.mock.invocationCallOrder[0] as number).toBeLessThan(unlockOrder);
    expect(d.primaryAddress.mock.invocationCallOrder[0] as number).toBeLessThan(unlockOrder);
  });

  it("passes the acting user to the disclosure when the caller supplies one", async () => {
    const d = deps();
    const actorUserId = "00000000-0000-4000-8000-0000000000bb";
    const r = await loadClaim837iInput(d.value, { ...args, actorUserId });
    expect(r.ok).toBe(true);
    expect(d.unlock).toHaveBeenCalledWith(
      expect.objectContaining({
        disclosure: { purpose: "claim_837i_submission", subjectId: CLAIM_ID, actorUserId },
      }),
    );
  });

  it("reports an MBI that belongs to a different coverage than the one the claim bills", async () => {
    const r = await loadClaim837iInput(
      deps({ payerId: "00000000-0000-4000-8000-0000000000aa" }).value,
      args,
    );
    expect(gapsOf(r)).toEqual(["subscriber.mbi:inconsistent"]);
    expect(JSON.stringify(r)).not.toContain(MBI);
  });

  it("combines claim gaps and party gaps in one call without touching the beneficiary", async () => {
    const d = deps({
      admissionDate: null,
      parties: { ...PARTIES, payer: null as never },
    });
    expect(gapsOf(await loadClaim837iInput(d.value, args))).toEqual([
      "admissionDate:missing",
      "payer:missing",
    ]);
    expect(d.findPatient).not.toHaveBeenCalled();
    expect(d.unlock).not.toHaveBeenCalled();
  });

  it("refuses a name outside the X12 basic character set by field, never by value", async () => {
    for (const lastName of ["Jos\u00e9", "Do\ne", "Do\u0000e"]) {
      const r = await loadClaim837iInput(
        deps({
          identity: { mbi: MBI, lastName, firstName: "Jane", dateOfBirth: "1940-03-15" },
        }).value,
        args,
      );
      expect(gapsOf(r)).toEqual(["subscriber.lastName:invalid"]);
      expect(JSON.stringify(r)).not.toContain("Jos");
    }
  });

  it("returns the MBI-bearing results opaquely: no serialisation path reveals it", async () => {
    const input = await loadClaim837iInput(deps().value, args);
    const rendered = await loadAndRender837i(deps().value, args);
    if (!input.ok || !rendered.ok) throw new Error("load failed");
    for (const out of [
      JSON.stringify(input),
      JSON.stringify(rendered),
      inspect(input, { depth: 10 }),
      inspect(rendered, { depth: 10 }),
      String(input.input),
      `${rendered.rendered}`,
    ]) {
      expect(out).not.toContain(MBI);
      expect(out).not.toContain("DOE");
    }
    expect(input.input.reveal().subscriber.mbi).toBe(MBI);
  });

  it("names the builder's field, never a value, when a builder refuses the input", async () => {
    const r = await loadClaim837iInput(
      deps({
        identity: {
          mbi: "not-an-mbi",
          lastName: "Doe",
          firstName: "Jane",
          dateOfBirth: "1940-03-15",
        },
      }).value,
      args,
    );
    expect(gapsOf(r)).toEqual(["subscriber.mbi:invalid"]);
    expect(JSON.stringify(r)).not.toContain("not-an-mbi");
  });

  it("reports a claim whose total disagrees with its lines", async () => {
    const r = await loadClaim837iInput(
      deps({ claims: [claim({ totalChargeCents: 1 })] }).value,
      args,
    );
    expect(gapsOf(r)).toEqual(["totalChargeCents:inconsistent"]);
  });
});
