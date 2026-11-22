import { type Claim837iInput, tokenizeInterchange } from "@chartwarden/x12-837-client";
import { describe, expect, it, vi } from "vitest";
import { mapQualifiedM24ClaimToInstitutionalDocument } from "../src/m24-institutional-837i";
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
        units: 90,
        unitBasis: "MJ",
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
      quantityEvidenceReference: "synthetic:clinical-minutes-1",
      quantitySource: "synthetic_clinical_minutes",
      clinicalMinutes: 90,
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
        quantity: 90,
        unitBasis: "MJ",
      }),
    ]);
    expect(built.value.totalChargeCents).toBe(35_000);
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
                  institutionalService: { measurementUnit: "MJ", serviceUnitCount: "90" },
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

  it("preserves separate synthetic lines across the September 30 / October 1 fiscal boundary", () => {
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
    expect(
      buildSyntheticM24InstitutionalDocument(
        fixture({
          lineEvidence: [
            fixture().lineEvidence[0]!,
            { ...fixture().lineEvidence[1]!, clinicalMinutes: undefined },
          ],
        }),
      ),
    ).toMatchObject({
      ok: false,
      gaps: [{ code: "M24_QUANTITY_UNRESOLVED", field: "claim.lines[1].clinicalMinutes" }],
    });
  });

  it("keeps production mapping unresolved until every authoritative qualification dimension is verified", () => {
    const unavailable = mapQualifiedM24ClaimToInstitutionalDocument({
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
      evidenceReferences: {
        payerResponsibility: ["synthetic:payer-responsibility"],
        providerOwnership: ["synthetic:provider-ownership"],
        ratePolicy: ["synthetic:rate-policy"],
        authorization: ["synthetic:authorization"],
        formatQualification: ["synthetic:format"],
        routeQualification: ["synthetic:route"],
      },
      qualification: {
        payerResponsibility: "verified",
        programIdentity: "verified",
        providerOwnership: "verified",
        serviceDates: "verified",
        quantity: "verified",
        coding: "verified",
        rate: "unresolved",
        authorization: "unresolved",
        format: "unresolved",
        route: "unresolved",
      },
      x12Input: claimInput,
      secondaryRoomAndBoardIncluded: false,
    } as never);
    expect(unavailable).toMatchObject({
      ok: false,
      gaps: [{ code: "M24_SOURCE_NOT_AUTHORITATIVE", field: "source.authority" }],
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

    const isa =
      "ISA*00*          *00*          *ZZ*SYNTHSENDER01  *ZZ*SYNTHRECEIVER   *260101*1200*^*00501*000000701*0*T*:~";
    const ack999 = [
      isa,
      "GS*FA*SYNTHRECEIVER*SYNTHSENDER01*20260101*1200*701*X*005010X231A1~",
      "ST*999*0001*005010X231A1~",
      "AK1*HC*701*005010X223A2~",
      "AK2*837*000000701*005010X223A2~",
      "IK5*A~",
      "AK9*A*1*1*1~",
      "SE*6*0001~",
      "GE*1*701~",
      "IEA*1*000000701~",
    ].join("\n");
    expect(inspectSynthetic999(identity, ack999, "synthetic-999", 2)).toMatchObject({
      ok: true,
      acknowledgment: { kind: "999", disposition: "accepted" },
    });
    const wrongTransactionAck = ack999.replace("AK2*837*000000701*", "AK2*837*000000702*");
    expect(
      inspectSynthetic999(identity, wrongTransactionAck, "synthetic-999-wrong-control", 2),
    ).toEqual({
      ok: false,
      reason: "identity-mismatch",
    });
    const ack277 = [
      isa,
      "GS*HN*SYNTHRECEIVER*SYNTHSENDER01*20260101*1200*702*X*005010X214~",
      "ST*277*0002*005010X214~",
      "BHT*0085*08*SYNTH277*20260101*1200*TH~",
      "HL*1**20*1~",
      "HL*2*1*21*1~",
      "HL*3*2*19*1~",
      "HL*4*3*PT~",
      "TRN*2*000000701~",
      "STC*A1:19:PR*20260101~",
      "SE*6*0002~",
      "GE*1*702~",
      "IEA*1*000000701~",
    ].join("\n");
    expect(inspectSynthetic277ca(identity, ack277, "accepted")).toMatchObject({
      ok: true,
      claimControlNumber: identity.controlNumber,
      stage: "payer",
      disposition: "accepted",
    });
  });
});
