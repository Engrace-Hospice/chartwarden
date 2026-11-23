import { type Claim837iInput, tokenizeInterchange } from "@chartwarden/x12-837-client";
import { describe, expect, it, vi } from "vitest";
import {
  type M24QualifiedClaimFacts,
  mapQualifiedM24ClaimToInstitutionalDocument,
  mintQualifiedFactsForTestOnly,
} from "../src/m24-institutional-837i";
import {
  InMemorySyntheticSubmissionLedger,
  M24_SYNTHETIC_FIXTURE_MARKER,
  type SyntheticAcknowledgment,
  type SyntheticM24ClaimFixture,
  type SyntheticRouteCandidate,
  type SyntheticRouteScope,
  type SyntheticSubmissionIdentity,
  buildSyntheticM24InstitutionalDocument,
  classifySyntheticRetry,
  correlateSyntheticAcknowledgment,
  createSyntheticSubmissionIdentity,
  inspectSynthetic277ca,
  inspectSynthetic999,
  inspectSyntheticClaimFixture,
  mapSyntheticVendorRequest,
  resolveSyntheticRoute,
  simulateSyntheticClearinghouseDelivery,
} from "../src/testing";

const claimInput: Claim837iInput = {
  claimFilingIndicator: "MC",
  envelope: {
    senderId: "SYNTHSENDER01",
    receiverId: "SYNTHRECEIVER",
    applicationReceiverCode: "SYNTHRECEIVER",
    interchangeControlNumber: 701,
    usage: "T",
    createdAt: new Date("2026-01-01T12:00:00.000Z"),
  },
  submitter: {
    name: "Synthetic Hospice",
    id: "SYNTHSENDER01",
    contactName: "Billing Test",
    contactPhone: "5035550101",
  },
  receiver: { name: "Synthetic Test Receiver", id: "SYNTHRECEIVER" },
  billingProvider: {
    organizationName: "Synthetic Hospice",
    npi: "1234567893",
    taxId: "931234567",
    address: { line1: "123 Test St", city: "Testville", state: "OR", postalCode: "00000" },
  },
  subscriber: {
    lastName: "Testpatient",
    firstName: "Jane",
    memberId: "SYNTH-OHP-MEMBER-0001",
    address: { line1: "123 Test St", city: "Testville", state: "OR", postalCode: "00000" },
    birthDate: "1940-03-15",
    sex: "F",
  },
  payer: { name: "Synthetic Medicaid Plan", payerId: "SYNTHETIC-EOCCO-TEST" },
  attendingPhysician: { lastName: "Provider", firstName: "Test", npi: "1234567893" },
  claim: {
    controlNumber: "000000701",
    frequency: "1",
    statementFromDate: "2026-01-01",
    statementThroughDate: "2026-01-03",
    admissionDate: "2026-01-01",
    admissionTypeCode: "1",
    admissionSource: "1",
    patientStatus: "40",
    principalDiagnosis: "C34.90",
    otherDiagnoses: [],
    conditionCodes: [],
    occurrenceCodes: [],
    valueCodes: [],
    lines: [
      {
        revenueCode: "0651",
        hcpcs: "Q5001",
        chargeCents: 20_000,
        units: 2,
        unitBasis: "DA",
        serviceDate: "2026-01-01",
        serviceThroughDate: "2026-01-02",
      },
      {
        revenueCode: "0652",
        hcpcs: "Q5001",
        chargeCents: 15_000,
        units: 2,
        unitBasis: "UN",
        serviceDate: "2026-01-03",
        serviceThroughDate: "2026-01-03",
      },
    ],
  },
};

const fixture = (overrides: Partial<SyntheticM24ClaimFixture> = {}): SyntheticM24ClaimFixture => ({
  marker: M24_SYNTHETIC_FIXTURE_MARKER,
  fixtureId: "m24-claim-001",
  organizationId: "synthetic:org-1",
  providerEntityId: "synthetic:provider-1",
  patientReference: "synthetic:patient-1",
  admissionReference: "synthetic:admission-1",
  canonicalPayerId: "synthetic:canonical-payer-1",
  programId: "synthetic:or-eocco-test",
  sourceClaimId: "synthetic:claim-1",
  claimTotalCents: 35_000,
  lineEvidence: [
    {
      sourceLineReference: "synthetic:line-1",
      sourceLocRecordReferences: ["synthetic:loc-1"],
      quantityEvidenceReference: "synthetic:daily-service-1",
      quantitySource: "synthetic_daily_units",
    },
    {
      sourceLineReference: "synthetic:line-2",
      sourceLocRecordReferences: ["synthetic:loc-2"],
      quantityEvidenceReference: "synthetic:other-units-1",
      quantitySource: "synthetic_other_units",
    },
  ],
  claimInput,
  secondaryRoomAndBoardIncluded: false,
  ...overrides,
});

const scope: SyntheticRouteScope = {
  organizationId: "synthetic:org-1",
  providerEntityId: "synthetic:provider-1",
  canonicalPayerId: "synthetic:canonical-payer-1",
  programId: "synthetic:or-eocco-test",
  transaction: "837I",
  claimType: "primary-medicaid-hospice",
  serviceFrom: "2026-01-01",
  serviceThrough: "2026-01-03",
};

const route = (overrides: Partial<SyntheticRouteCandidate> = {}): SyntheticRouteCandidate => ({
  ...scope,
  vendor: "stedi",
  vendorPayerId: "SYNTHETIC-EOCCO-TEST",
  effectiveFrom: "2026-01-01",
  effectiveThrough: "2026-12-31",
  enrollment: "verified",
  providerParticipation: "verified",
  payerMapping: "verified",
  formatQualification: "verified",
  destinationQualification: "verified",
  ...overrides,
});

describe("synthetic M24 institutional claim rendering", () => {
  it("renders a deterministic primary Medicaid 837I through the shared serializer", () => {
    const built = buildSyntheticM24InstitutionalDocument(fixture());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const again = buildSyntheticM24InstitutionalDocument(fixture());
    expect(again.ok && again.value.x12).toBe(built.value.x12);
    const { segments } = tokenizeInterchange(built.value.x12);
    const ids = segments.map((segment) => segment[0]);
    expect(ids[0]).toBe("ISA");
    expect(ids.at(-1)).toBe("IEA");
    expect(ids).toEqual(
      expect.arrayContaining([
        "GS",
        "ST",
        "BHT",
        "HL",
        "SBR",
        "CLM",
        "CL1",
        "HI",
        "LX",
        "SV2",
        "SE",
        "GE",
      ]),
    );
    expect(segments.find((segment) => segment[0] === "ST")?.[3]).toBe("005010X223A2");
    expect(segments.find((segment) => segment[0] === "IEA")?.[2]).toBe(
      segments.find((segment) => segment[0] === "ISA")?.[13],
    );
    expect(segments.find((segment) => segment[0] === "GE")?.[2]).toBe(
      segments.find((segment) => segment[0] === "GS")?.[6],
    );
    expect(segments.find((segment) => segment[0] === "SE")?.[2]).toBe(
      segments.find((segment) => segment[0] === "ST")?.[2],
    );
    const stIndex = ids.indexOf("ST");
    const seIndex = ids.indexOf("SE");
    expect(Number(segments[seIndex]?.[1])).toBe(seIndex - stIndex + 1);
    expect(segments.find((segment) => segment[0] === "SBR")?.[9]).toBe("MC");
    expect(segments.find((segment) => segment[0] === "NM1" && segment[1] === "IL")?.[8]).toBe("MI");
    expect(segments.find((segment) => segment[0] === "NM1" && segment[1] === "IL")?.[9]).toBe(
      "SYNTH-OHP-MEMBER-0001",
    );
    expect(built.value.lines).toEqual([
      expect.objectContaining({
        serviceFrom: "2026-01-01",
        serviceThrough: "2026-01-02",
        quantity: 2,
        unitBasis: "DA",
      }),
      expect.objectContaining({
        serviceFrom: "2026-01-03",
        serviceThrough: "2026-01-03",
        quantity: 2,
        unitBasis: "UN",
      }),
    ]);
    expect(built.value.totalChargeCents).toBe(35_000);
    // SV204 is DA or UN only (005010X223A2): the raw X12 carries exactly the line bases.
    expect(segments.filter((segment) => segment[0] === "SV2").map((segment) => segment[4])).toEqual(
      ["DA", "UN"],
    );
  });

  it("preserves the Stedi JSON service-date and unit contract while keeping request formats distinct", () => {
    const built = buildSyntheticM24InstitutionalDocument(fixture());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const stediRoute = route();
    const stediJson = mapSyntheticVendorRequest(stediRoute, fixture(), built.value, "json");
    expect(stediJson).toMatchObject({
      ok: true,
      value: {
        vendor: "stedi",
        transport: "offline-contract-only",
        request: {
          contentType: "application/json",
          headers: { "Idempotency-Key": expect.stringContaining("synthetic:stedi:") },
          body: {
            claimInformation: {
              claimFilingCode: "MC",
              serviceLines: [
                {
                  serviceDate: "20260101",
                  serviceDateEnd: "20260102",
                  institutionalService: { measurementUnit: "DA", serviceUnitCount: "2" },
                },
                {
                  serviceDate: "20260103",
                  institutionalService: { measurementUnit: "UN", serviceUnitCount: "2" },
                },
              ],
            },
          },
        },
      },
    });
    const stediRaw = mapSyntheticVendorRequest(stediRoute, fixture(), built.value, "raw-x12");
    expect(stediRaw).toMatchObject({
      ok: true,
      value: { request: { contentType: "application/json", body: { x12: built.value.x12 } } },
    });
    expect(
      mapSyntheticVendorRequest(route({ serviceFrom: "2026-01-02" }), fixture(), built.value),
    ).toMatchObject({ ok: false, gaps: [{ code: "M24_ROUTE_NOT_QUALIFIED" }] });
    const claimMd = mapSyntheticVendorRequest(route({ vendor: "claimmd" }), fixture(), built.value);
    expect(claimMd).toMatchObject({
      ok: true,
      value: {
        vendor: "claimmd",
        request: {
          contentType: "multipart/form-data",
          fields: ["AccountKey", "Filename", "File"],
          filename: "cw-m24-claim-001.837",
          file: built.value.x12,
        },
      },
    });
    if (claimMd.ok) expect(claimMd.value.request).not.toHaveProperty("AccountKey");
  });

  const boundaryClaim = (lines: Claim837iInput["claim"]["lines"]): Claim837iInput => ({
    ...claimInput,
    claim: {
      ...claimInput.claim,
      statementFromDate: "2026-09-30",
      statementThroughDate: "2026-10-01",
      admissionDate: "2026-09-30",
      lines,
    },
  });

  it("does not segment at the fiscal boundary: a line spanning September 30 / October 1 passes through as one line", () => {
    const spanning = boundaryClaim([
      {
        ...claimInput.claim.lines[0]!,
        serviceDate: "2026-09-30",
        serviceThroughDate: "2026-10-01",
        units: 2,
        chargeCents: 25_000,
      },
    ]);
    const built = buildSyntheticM24InstitutionalDocument(
      fixture({
        claimInput: spanning,
        claimTotalCents: 25_000,
        lineEvidence: [fixture().lineEvidence[0]!],
      }),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(
      built.value.lines.map(({ serviceFrom, serviceThrough, quantity }) => [
        serviceFrom,
        serviceThrough,
        quantity,
      ]),
    ).toEqual([["2026-09-30", "2026-10-01", 2]]);
  });

  it("keeps caller-segmented single-day lines across the fiscal boundary separate", () => {
    const boundaryInput: Claim837iInput = {
      ...claimInput,
      claim: {
        ...claimInput.claim,
        statementFromDate: "2026-09-30",
        statementThroughDate: "2026-10-01",
        admissionDate: "2026-09-30",
        lines: [
          {
            ...claimInput.claim.lines[0]!,
            serviceDate: "2026-09-30",
            serviceThroughDate: "2026-09-30",
            units: 1,
            chargeCents: 12_000,
          },
          {
            ...claimInput.claim.lines[1]!,
            serviceDate: "2026-10-01",
            serviceThroughDate: "2026-10-01",
            units: 1,
            unitBasis: "DA",
            chargeCents: 13_000,
          },
        ],
      },
    };
    const boundaryFixture = fixture({
      claimInput: boundaryInput,
      claimTotalCents: 25_000,
      lineEvidence: [
        { ...fixture().lineEvidence[0]!, sourceLineReference: "synthetic:fy-line-1" },
        { ...fixture().lineEvidence[0]!, sourceLineReference: "synthetic:fy-line-2" },
      ],
    });
    const built = buildSyntheticM24InstitutionalDocument(boundaryFixture);
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(
        built.value.lines.map(({ serviceFrom, serviceThrough }) => [serviceFrom, serviceThrough]),
      ).toEqual([
        ["2026-09-30", "2026-09-30"],
        ["2026-10-01", "2026-10-01"],
      ]);
      expect(built.value.totalChargeCents).toBe(25_000);
    }
  });

  it("fails closed on absent source facts, dates, quantities, totals and unsupported secondary routes", () => {
    expect(
      buildSyntheticM24InstitutionalDocument(fixture({ marker: "wrong" as never })),
    ).toMatchObject({
      ok: false,
      gaps: [{ code: "M24_SOURCE_NOT_AUTHORITATIVE" }],
    });
    expect(
      inspectSyntheticClaimFixture(
        fixture({
          claimInput: {
            ...claimInput,
            claim: {
              ...claimInput.claim,
              lines: [{ ...claimInput.claim.lines[0]!, serviceThroughDate: undefined }],
            },
          },
        }),
      ),
    ).toMatchObject({ ok: false, gaps: [{ code: "M24_SERVICE_DATES_UNRESOLVED" }] });
    expect(
      inspectSyntheticClaimFixture(
        fixture({
          claimInput: {
            ...claimInput,
            claim: {
              ...claimInput.claim,
              lines: [{ ...claimInput.claim.lines[0]!, unitBasis: undefined }],
            },
          },
        }),
      ),
    ).toMatchObject({ ok: false, gaps: [{ code: "M24_QUANTITY_UNRESOLVED" }] });
    expect(buildSyntheticM24InstitutionalDocument(fixture({ claimTotalCents: 0 }))).toMatchObject({
      ok: false,
      gaps: [{ code: "M24_DOCUMENT_INVALID", field: "claimTotalCents" }],
    });
    expect(
      buildSyntheticM24InstitutionalDocument(
        fixture({ secondaryRoomAndBoardIncluded: true as never }),
      ),
    ).toMatchObject({
      ok: false,
      gaps: [{ code: "M24_SECONDARY_ROOM_AND_BOARD_UNSUPPORTED" }],
    });
    const noDiagnosis = { ...claimInput, claim: { ...claimInput.claim, principalDiagnosis: "" } };
    const invalid = buildSyntheticM24InstitutionalDocument(fixture({ claimInput: noDiagnosis }));
    expect(invalid).toMatchObject({
      ok: false,
      gaps: [{ code: "M24_DOCUMENT_INVALID", field: "claim.principalDiagnosis" }],
    });
    expect(JSON.stringify(invalid)).not.toContain("SYNTH-OHP-MEMBER-0001");
    const delimiterFailure = buildSyntheticM24InstitutionalDocument(
      fixture({
        claimInput: {
          ...claimInput,
          subscriber: { ...claimInput.subscriber, lastName: "Testpatient~BAD" },
        },
      }),
    );
    expect(delimiterFailure).toMatchObject({
      ok: false,
      gaps: [{ code: "M24_DOCUMENT_INVALID", field: "subscriber.lastName" }],
    });
    expect(JSON.stringify(delimiterFailure)).not.toContain("Testpatient~BAD");
  });

  it("refuses a lines basis that is not an 837I SV204 unit (hours and minutes), before any quantity check", () => {
    for (const unitBasis of ["HR", "MJ"] as const) {
      const lines = [
        claimInput.claim.lines[0]!,
        { ...claimInput.claim.lines[1]!, unitBasis } as never,
      ];
      expect(
        buildSyntheticM24InstitutionalDocument(
          fixture({ claimInput: { ...claimInput, claim: { ...claimInput.claim, lines } } }),
        ),
      ).toEqual({
        ok: false,
        gaps: [{ code: "M24_QUANTITY_UNRESOLVED", field: "claim.lines[1].unitBasis" }],
      });
    }
  });

  it("refuses a UN line whose quantity evidence is not unit evidence", () => {
    expect(
      buildSyntheticM24InstitutionalDocument(
        fixture({
          lineEvidence: [
            fixture().lineEvidence[0]!,
            { ...fixture().lineEvidence[1]!, quantitySource: "synthetic_daily_units" },
          ],
        }),
      ),
    ).toMatchObject({
      ok: false,
      gaps: [{ code: "M24_QUANTITY_UNRESOLVED", field: "claim.lines[1].units" }],
    });
  });

  it("refuses two lines that bill the same revenue and procedure code for overlapping days", () => {
    const first = claimInput.claim.lines[0]!;
    const overlapping = {
      ...first,
      serviceDate: "2026-01-02",
      serviceThroughDate: "2026-01-03",
      chargeCents: 15_000,
    };
    expect(
      buildSyntheticM24InstitutionalDocument(
        fixture({
          claimInput: {
            ...claimInput,
            claim: { ...claimInput.claim, lines: [first, overlapping] },
          },
          claimTotalCents: 35_000,
          lineEvidence: [fixture().lineEvidence[0]!, fixture().lineEvidence[0]!],
        }),
      ),
    ).toEqual({
      ok: false,
      gaps: [{ code: "M24_DOCUMENT_INVALID", field: "claim.lines[1].serviceDate" }],
    });
  });
});

describe("overlapping service days of the same code", () => {
  const withSecondLine = (
    patch: Record<string, unknown>,
    firstPatch: Record<string, unknown> = {},
  ) => {
    const first = { ...claimInput.claim.lines[0]!, ...firstPatch };
    const second = {
      ...first,
      serviceDate: "2026-01-02",
      serviceThroughDate: "2026-01-03",
      chargeCents: 15_000,
      ...patch,
    };
    return buildSyntheticM24InstitutionalDocument(
      fixture({
        claimInput: { ...claimInput, claim: { ...claimInput.claim, lines: [first, second] } },
        claimTotalCents: 35_000,
        lineEvidence: [fixture().lineEvidence[0]!, fixture().lineEvidence[0]!],
      }),
    );
  };
  const refused = {
    ok: false,
    gaps: [{ code: "M24_DOCUMENT_INVALID", field: "claim.lines[1].serviceDate" }],
  };

  it.each([
    ["one line carries a modifier the other lacks", { modifiers: ["PM"] }, {}],
    ["the lines carry different modifiers", { modifiers: ["GT"] }, { modifiers: ["PM"] }],
  ])("allows the same code on overlapping days when %s", (_name, patch, firstPatch) => {
    expect(withSecondLine(patch, firstPatch).ok).toBe(true);
  });

  it.each([
    ["no modifiers at all", {}, {}],
    ["the same modifier", { modifiers: ["PM"] }, { modifiers: ["PM"] }],
    [
      "the same modifiers in another order",
      { modifiers: ["GT", "PM"] },
      { modifiers: ["PM", "GT"] },
    ],
    ["a repeated modifier on one line", { modifiers: ["PM", "PM"] }, { modifiers: ["PM"] }],
    ["a repeated modifier on the earlier line", { modifiers: ["PM"] }, { modifiers: ["PM", "PM"] }],
  ])(
    "still refuses the same code and modifiers on overlapping days (%s)",
    (_name, patch, firstPatch) => {
      expect(withSecondLine(patch, firstPatch)).toEqual(refused);
    },
  );
});

describe("production mapping from server-minted facts", () => {
  const verifiedQualification = {
    payerResponsibility: "verified",
    programIdentity: "verified",
    providerOwnership: "verified",
    serviceDates: "verified",
    quantity: "verified",
    coding: "verified",
    rate: "verified",
    authorization: "verified",
    format: "verified",
    route: "verified",
  } as const;
  const evidence = {
    payerResponsibility: ["synthetic:payer-responsibility"],
    providerOwnership: ["synthetic:provider-ownership"],
    ratePolicy: ["synthetic:rate-policy"],
    authorization: ["synthetic:authorization"],
    formatQualification: ["synthetic:format"],
    routeQualification: ["synthetic:route"],
  };
  const facts = (overrides: Partial<M24QualifiedClaimFacts> = {}): M24QualifiedClaimFacts =>
    mintQualifiedFactsForTestOnly({
      authority: "server_reader",
      organizationId: "synthetic:org-1",
      providerEntityId: "synthetic:provider-1",
      patientReference: "synthetic:patient-1",
      admissionReference: "synthetic:admission-1",
      canonicalPayerId: "synthetic:canonical-payer-1",
      programId: "synthetic:or-eocco-test",
      claimKind: "primary_medicaid_hospice",
      sourceClaimId: "synthetic:claim-1",
      claimTotalCents: 35_000,
      lineEvidence: fixture().lineEvidence,
      evidenceReferences: evidence,
      qualification: verifiedQualification,
      x12Input: claimInput,
      secondaryRoomAndBoardIncluded: false,
      ...overrides,
    });

  it("builds a document when every dimension is verified (the control the refusals below are measured against)", () => {
    expect(mapQualifiedM24ClaimToInstitutionalDocument(facts())).toMatchObject({
      ok: true,
      value: { controlNumber: "000000701", totalChargeCents: 35_000 },
    });
  });

  it("refuses an object without the server capability marker, whatever its qualification values", () => {
    // Object.entries skips symbol keys, so this is every string-keyed fact of a valid object minus the marker.
    const forged = Object.fromEntries(Object.entries(facts()));
    expect(forged.qualification).toEqual(verifiedQualification);
    expect(mapQualifiedM24ClaimToInstitutionalDocument(forged as never)).toEqual({
      ok: false,
      gaps: [{ code: "M24_SOURCE_NOT_AUTHORITATIVE", field: "source.authority" }],
    });
  });

  it("refuses minted facts whose authority is not the server reader", () => {
    expect(
      mapQualifiedM24ClaimToInstitutionalDocument(
        facts({ authority: "synthetic_fixture" as never }),
      ),
    ).toEqual({
      ok: false,
      gaps: [{ code: "M24_SOURCE_NOT_AUTHORITATIVE", field: "source.authority" }],
    });
  });

  it.each([
    ["payerResponsibility", "M24_PAYER_RESPONSIBILITY_UNRESOLVED"],
    ["programIdentity", "M24_PROGRAM_IDENTITY_UNRESOLVED"],
    ["providerOwnership", "M24_PROVIDER_OWNERSHIP_UNVERIFIED"],
    ["serviceDates", "M24_SERVICE_DATES_UNRESOLVED"],
    ["quantity", "M24_QUANTITY_UNRESOLVED"],
    ["coding", "M24_CODING_UNQUALIFIED"],
    ["rate", "MEDICAID_RATE_POLICY_UNRESOLVED"],
    ["authorization", "M24_AUTHORIZATION_UNRESOLVED"],
    ["format", "M24_FORMAT_NOT_QUALIFIED"],
    ["route", "M24_ROUTE_NOT_QUALIFIED"],
  ] as const)("reports %s as %s when only that dimension is unresolved", (dimension, code) => {
    expect(
      mapQualifiedM24ClaimToInstitutionalDocument(
        facts({ qualification: { ...verifiedQualification, [dimension]: "unresolved" } }),
      ),
    ).toEqual({ ok: false, gaps: [{ code, field: `qualification.${dimension}` }] });
  });

  it("reports every unresolved dimension together", () => {
    const result = mapQualifiedM24ClaimToInstitutionalDocument(
      facts({
        qualification: {
          ...verifiedQualification,
          rate: "unresolved",
          authorization: "unresolved",
          format: "unresolved",
          route: "unresolved",
        },
      }),
    );
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.gaps.map((gap) => gap.field)).toEqual([
      "qualification.rate",
      "qualification.authorization",
      "qualification.format",
      "qualification.route",
    ]);
  });

  it.each(Object.keys(evidence))("refuses empty %s evidence references", (dimension) => {
    expect(
      mapQualifiedM24ClaimToInstitutionalDocument(
        facts({ evidenceReferences: { ...evidence, [dimension]: [] } }),
      ),
    ).toEqual({
      ok: false,
      gaps: [{ code: "M24_DOCUMENT_INVALID", field: `evidenceReferences.${dimension}` }],
    });
  });

  it("refuses a claim kind other than primary Medicaid hospice", () => {
    expect(mapQualifiedM24ClaimToInstitutionalDocument(facts({ claimKind: "other" }))).toEqual({
      ok: false,
      gaps: [{ code: "M24_PAYER_RESPONSIBILITY_UNRESOLVED", field: "claimKind" }],
    });
  });

  it("refuses secondary room and board, other payers and a non-Medicaid filing indicator", () => {
    expect(
      mapQualifiedM24ClaimToInstitutionalDocument(facts({ secondaryRoomAndBoardIncluded: true })),
    ).toMatchObject({ gaps: [{ code: "M24_SECONDARY_ROOM_AND_BOARD_UNSUPPORTED" }] });
    const otherPayer = {
      responsibility: "S",
      claimFilingIndicator: "MA",
      memberId: "1EG4TE5MK73",
      payerName: "Synthetic Medicare",
      payerId: "SYNTHETIC-MEDICARE",
    } as const;
    expect(
      mapQualifiedM24ClaimToInstitutionalDocument(
        facts({
          x12Input: { ...claimInput, claim: { ...claimInput.claim, otherPayers: [otherPayer] } },
        }),
      ),
    ).toMatchObject({ gaps: [{ code: "M24_SECONDARY_PAYER_UNSUPPORTED" }] });
    expect(
      mapQualifiedM24ClaimToInstitutionalDocument(
        facts({ x12Input: { ...claimInput, claimFilingIndicator: "MA" } }),
      ),
    ).toEqual({
      ok: false,
      gaps: [{ code: "M24_DOCUMENT_INVALID", field: "claimFilingIndicator" }],
    });
  });
});

describe("M24 offline route and acknowledgment contracts", () => {
  it("scopes routes by tenant, provider, payer, program and vendor, and refuses unqualified routes", () => {
    expect(resolveSyntheticRoute(scope, null, [route()])).toMatchObject({
      ok: false,
      reason: "no-selected-clearinghouse",
    });
    expect(resolveSyntheticRoute(scope, "claimmd", [route()])).toMatchObject({
      ok: false,
      reason: "no-selected-clearinghouse",
    });
    expect(
      resolveSyntheticRoute(scope, "stedi", [route({ organizationId: "synthetic:org-other" })]),
    ).toMatchObject({ ok: false, reason: "wrong-organization" });
    expect(
      resolveSyntheticRoute(scope, "stedi", [
        route({ providerEntityId: "synthetic:provider-other" }),
      ]),
    ).toMatchObject({ ok: false, reason: "wrong-provider-entity" });
    expect(resolveSyntheticRoute(scope, "stedi", [route(), route()])).toMatchObject({
      ok: false,
      reason: "ambiguous-clearinghouse",
    });
    expect(resolveSyntheticRoute(scope, "stedi", [route({ vendorPayerId: null })])).toMatchObject({
      ok: false,
      reason: "payer-mapping-missing",
    });
    expect(
      resolveSyntheticRoute(scope, "stedi", [route({ payerMapping: "conflicting" })]),
    ).toMatchObject({ ok: false, reason: "payer-mapping-conflict" });
    expect(resolveSyntheticRoute(scope, "stedi", [route({ enrollment: "expired" })])).toMatchObject(
      { ok: false, reason: "expired-enrollment" },
    );
    expect(
      resolveSyntheticRoute(scope, "stedi", [route({ providerParticipation: "unverified" })]),
    ).toMatchObject({ ok: false, reason: "provider-participation-unverified" });
    expect(
      resolveSyntheticRoute(scope, "stedi", [route({ formatQualification: "unverified" })]),
    ).toMatchObject({ ok: false, reason: "format-not-qualified" });
    expect(
      resolveSyntheticRoute(scope, "stedi", [route({ destinationQualification: "unverified" })]),
    ).toMatchObject({ ok: false, reason: "payer-destination-unqualified" });
    expect(
      resolveSyntheticRoute(scope, "stedi", [route({ effectiveFrom: "2026-02-01" })]),
    ).toMatchObject({ ok: false, reason: "service-period-not-covered" });
    expect(
      resolveSyntheticRoute({ ...scope, claimType: "other" }, "stedi", [route()]),
    ).toMatchObject({ ok: false, reason: "unsupported-claim-type" });
    expect(resolveSyntheticRoute(scope, "stedi", [route()])).toMatchObject({
      ok: true,
      offlineOnly: true,
    });
    expect(
      resolveSyntheticRoute(scope, "stedi", [
        route({ organizationId: "synthetic:org-2" }),
        route(),
      ]),
    ).toMatchObject({ ok: true, candidate: { organizationId: "synthetic:org-1" } });
    expect(
      resolveSyntheticRoute(scope, "stedi", [
        route({ effectiveFrom: "2025-12-01", effectiveThrough: "2026-01-03" }),
        route({ effectiveFrom: "2026-01-04", effectiveThrough: null }),
      ]),
    ).toMatchObject({ ok: true, candidate: { effectiveThrough: "2026-01-03" } });
  });

  it("models an offline receipt outcome without callbacks, network access or persistence", () => {
    const built = buildSyntheticM24InstitutionalDocument(fixture());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const request = mapSyntheticVendorRequest(route(), fixture(), built.value);
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const outcome = simulateSyntheticClearinghouseDelivery(request.value, "unknown");
    expect(outcome).toEqual({
      transport: "offline-fake",
      outcome: "unknown",
      retry: "hold-indeterminate",
      durableSubmissionCreated: false,
      claimStateAdvanced: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(classifySyntheticRetry("not-sent")).toBe("retry-safe-before-send");
    expect(classifySyntheticRetry("received")).toBe("do-not-resend-received");
  });

  it("uses scoped stable identities and detects duplicate payloads, changed payloads and control collisions", () => {
    const ledger = new InMemorySyntheticSubmissionLedger();
    const first = fixture();
    const identity = createSyntheticSubmissionIdentity(first, "stedi");
    expect(identity.idempotencyKey).toBe(
      "synthetic:stedi:synthetic:org-1:synthetic:provider-1:m24-claim-001:000000701",
    );
    expect(JSON.stringify(identity)).not.toContain("SYNTH-OHP-MEMBER-0001");
    expect(ledger.reserve(identity, "synthetic-x12-a")).toBe("reserved");
    expect(ledger.reserve(identity, "synthetic-x12-a")).toBe("replayed-identical");
    expect(ledger.reserve(identity, "synthetic-x12-b")).toBe("idempotency-conflict");
    const differentKey = { ...identity, idempotencyKey: "synthetic:stedi:other:M24SYNTH0001" };
    expect(ledger.reserve(differentKey, "synthetic-x12-a")).toBe("control-number-conflict");
    const otherTenant = { ...identity, organizationId: "synthetic:org-2" };
    expect(ledger.reserve(otherTenant, "synthetic-x12-a")).toBe("reserved");
    ledger.clear();
    expect(ledger.reserve(identity, "synthetic-x12-a")).toBe("reserved");
  });

  it("correlates synthetic 999 and 277CA events, refusing scope, control and order mismatches", () => {
    const identity: SyntheticSubmissionIdentity = {
      vendor: "stedi",
      usage: "test",
      organizationId: "synthetic:org-1",
      providerEntityId: "synthetic:provider-1",
      canonicalPayerId: "synthetic:canonical-payer-1",
      programId: "synthetic:or-eocco-test",
      controlNumber: "000000701",
      transactionSetControlNumber: "0701",
      functionalGroupControlNumber: "701",
      idempotencyKey: "synthetic-stedi-m24-claim-001",
    };
    const event = (patch: Partial<SyntheticAcknowledgment> = {}): SyntheticAcknowledgment => ({
      eventId: "synthetic-ack-1",
      identity,
      kind: "transport_receipt",
      disposition: "accepted",
      sequence: 1,
      ...patch,
    });
    expect(correlateSyntheticAcknowledgment(identity, event())).toBe("transport-received");
    expect(correlateSyntheticAcknowledgment(identity, event({ disposition: "rejected" }))).toBe(
      "transport-rejected",
    );
    expect(correlateSyntheticAcknowledgment(identity, event({ kind: "999" }))).toBe(
      "clearinghouse-accepted",
    );
    expect(
      correlateSyntheticAcknowledgment(identity, event({ kind: "999", disposition: "rejected" })),
    ).toBe("clearinghouse-rejected");
    expect(correlateSyntheticAcknowledgment(identity, event({ kind: "277CA", sequence: 2 }))).toBe(
      "payer-acknowledged",
    );
    expect(
      correlateSyntheticAcknowledgment(
        identity,
        event({ eventId: "synthetic-ack-2", kind: "277CA", sequence: 2 }),
        [event()],
      ),
    ).toBe("payer-acknowledged");
    expect(
      correlateSyntheticAcknowledgment(
        identity,
        event({ eventId: "synthetic-ack-3", kind: "277CA", disposition: "rejected", sequence: 2 }),
      ),
    ).toBe("payer-rejected");
    expect(
      correlateSyntheticAcknowledgment(
        identity,
        event({ identity: { ...identity, controlNumber: "UNKNOWN" } }),
      ),
    ).toBe("unknown-control-number");
    expect(
      correlateSyntheticAcknowledgment(
        identity,
        event({ identity: { ...identity, providerEntityId: "synthetic:provider-other" } }),
      ),
    ).toBe("identity-mismatch");
    expect(
      correlateSyntheticAcknowledgment(
        identity,
        event({ identity: { ...identity, canonicalPayerId: "synthetic:payer-other" } }),
      ),
    ).toBe("identity-mismatch");
    expect(correlateSyntheticAcknowledgment(identity, event(), [event()])).toBe("duplicate");
    expect(
      correlateSyntheticAcknowledgment(identity, event({ eventId: "late", sequence: 1 }), [
        event({ sequence: 2 }),
      ]),
    ).toBe("out-of-order");
    expect(
      correlateSyntheticAcknowledgment(identity, event({ eventId: "conflict", kind: "999" }), [
        event(),
      ]),
    ).toBe("conflict");
  });

  it("derives the expected ST02 from the built document, as a real 999 echoes it", () => {
    const built = buildSyntheticM24InstitutionalDocument(fixture());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const st = tokenizeInterchange(built.value.x12).segments.find((segment) => segment[0] === "ST");
    const identity = createSyntheticSubmissionIdentity(fixture(), "stedi");
    // CLM01 (`000000701`) and ST02 (`0701`) are different identifiers; a 999 carries only ST02.
    expect(identity.controlNumber).toBe("000000701");
    expect(identity.transactionSetControlNumber).toBe(st?.[2]);
    expect(identity.transactionSetControlNumber).toBe("0701");
  });

  describe("999 and 277CA inspection of content built from the document", () => {
    const built = buildSyntheticM24InstitutionalDocument(fixture());
    const identity = createSyntheticSubmissionIdentity(fixture(), "stedi");
    const segments = built.ok ? tokenizeInterchange(built.value.x12).segments : [];
    const isa = segments.find((segment) => segment[0] === "ISA")!;
    const st02 = segments.find((segment) => segment[0] === "ST")?.[2] ?? "";
    const clm01 = segments.find((segment) => segment[0] === "CLM")?.[1] ?? "";
    const isaLine = `${isa.join("*")}~`;
    const ack999For = (acknowledgedSt02: string, verdict = "A") =>
      [
        isaLine,
        "GS*FA*SYNTHRECEIVER*SYNTHSENDER01*20260101*1200*701*X*005010X231A1~",
        "ST*999*0001*005010X231A1~",
        "AK1*HC*701*005010X223A2~",
        `AK2*837*${acknowledgedSt02}*005010X223A2~`,
        `IK5*${verdict}~`,
        `AK9*${verdict}*1*1*${verdict === "A" ? 1 : 0}~`,
        "SE*6*0001~",
        "GE*1*701~",
        "IEA*1*000000701~",
      ].join("\n");
    const ack277For = (claimControlNumber: string, stc01: string) =>
      [
        isaLine,
        "GS*HN*SYNTHRECEIVER*SYNTHSENDER01*20260101*1200*702*X*005010X214~",
        "ST*277*0002*005010X214~",
        "BHT*0085*08*SYNTH277*20260101*1200*TH~",
        "HL*1**20*1~",
        "HL*2*1*21*1~",
        "HL*3*2*19*1~",
        "HL*4*3*PT~",
        `TRN*2*${claimControlNumber}~`,
        `STC*${stc01}*20260101~`,
        "SE*9*0002~",
        "GE*1*702~",
        "IEA*1*000000701~",
      ].join("\n");

    it("accepts a 999 that acknowledges the built ST02", () => {
      expect(built.ok).toBe(true);
      expect(inspectSynthetic999(identity, ack999For(st02), "synthetic-999", 2)).toMatchObject({
        ok: true,
        acknowledgment: { kind: "999", disposition: "accepted" },
      });
      expect(
        inspectSynthetic999(identity, ack999For(st02, "R"), "synthetic-999-r", 2),
      ).toMatchObject({ ok: true, acknowledgment: { kind: "999", disposition: "rejected" } });
    });

    it("refuses a 999 that echoes the claim control number (CLM01) instead of the ST02", () => {
      expect(inspectSynthetic999(identity, ack999For(clm01), "synthetic-999-clm01", 2)).toEqual({
        ok: false,
        reason: "identity-mismatch",
      });
    });

    it("refuses a 999 for another transaction set", () => {
      expect(inspectSynthetic999(identity, ack999For("0702"), "synthetic-999-other", 2)).toEqual({
        ok: false,
        reason: "identity-mismatch",
      });
    });

    it.each([
      ["A2:20:PR", "accepted"],
      ["A3:21:85", "rejected"],
      ["A6:562:85", "rejected"],
      ["A7:562:85", "rejected"],
      ["A8:562:85", "rejected"],
    ] as const)("derives the 277CA disposition from STC01 %s as %s", (stc01, disposition) => {
      expect(inspectSynthetic277ca(identity, ack277For(clm01, stc01))).toMatchObject({
        ok: true,
        claimControlNumber: identity.controlNumber,
        statusEffectiveDate: "2026-01-01",
        stage: "payer",
        disposition,
      });
    });

    // X12 code list 507: A1 "acknowledgement/receipt - the claim/encounter has been received. This does not mean that the
    // claim has been accepted for adjudication." A2 is the acceptance; that split is from the standard, not from the repo
    // (stedi-claim-status.ts maps A1 and A2 alike to "received"), which agrees with this test only that A1 is a receipt.
    it("derives a receipt, not an acceptance, from STC01 A1", () => {
      const inspected = inspectSynthetic277ca(identity, ack277For(clm01, "A1:19:PR"));
      expect(inspected).toMatchObject({ ok: true, stage: "payer", disposition: "received" });
      const acknowledgment: SyntheticAcknowledgment = {
        eventId: "synthetic-277ca-a1",
        identity,
        kind: "277CA",
        disposition: "received",
        sequence: 2,
      };
      expect(correlateSyntheticAcknowledgment(identity, acknowledgment)).toBe("payer-received");
    });

    it.each(["transport_receipt", "999"] as const)(
      "refuses a receipt disposition on a %s event, which only a 277CA can carry",
      (kind) => {
        expect(
          correlateSyntheticAcknowledgment(identity, {
            eventId: "synthetic-receipt-misuse",
            identity,
            kind,
            disposition: "received",
            sequence: 1,
          }),
        ).toBe("conflict");
      },
    );

    it.each(["A0:19:PR", "A4:21:85", "A5:20:PR", "E0:19:PR", "", "ZZ:1:PR"])(
      "refuses a 277CA whose STC01 %j does not determine accept or reject",
      (stc01) => {
        expect(inspectSynthetic277ca(identity, ack277For(clm01, stc01))).toEqual({
          ok: false,
          reason: "invalid-ack",
        });
      },
    );

    it("refuses a 277CA for another claim control number", () => {
      expect(inspectSynthetic277ca(identity, ack277For("000000702", "A1:19:PR"))).toEqual({
        ok: false,
        reason: "identity-mismatch",
      });
    });
  });
});
