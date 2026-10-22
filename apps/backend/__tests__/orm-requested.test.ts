/**
 * F-181 (#248) — the PURE core of M11's `m11.order.hl7_orm_requested` producer: every fact resolved or the whole
 * request refused. No database; the live proof is `m11-orm-requested.live.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type OrmOrderFacts,
  type OrmPatientFacts,
  type OrmPhysicianFacts,
  type OrmRequestedPorts,
  planOrmRequested,
  resolveOrmRequested,
  toHl7Priority,
  toHl7Sex,
} from "../src/modules/11-orders/orm-request/orm-requested";

const ORG = "11111111-1111-1111-1111-111111111111";
const ORDER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const FACILITY = "77777777-7777-7777-7777-777777777777";

const order = (over: Partial<OrmOrderFacts> = {}): OrmOrderFacts => ({
  orderId: ORDER,
  organizationId: ORG,
  patientId: PATIENT,
  orderingPhysicianMdmId: "66666666-6666-6666-6666-666666666666",
  priority: "stat",
  signedAt: new Date("2026-03-01T12:00:00.000Z"),
  data: {
    testCodes: [{ system: "http://loinc.org", code: "2345-7", display: "Glucose" }],
    fastingRequired: true,
    collectionInstructions: "Draw before 8am",
    clinicalJustification: "SECRET diagnosis text that must never reach the lab",
    notes: "SECRET free text",
  },
  ...over,
});
const patient = (over: Partial<OrmPatientFacts> = {}): OrmPatientFacts => ({
  patientId: PATIENT,
  mrn: "MRN-100",
  mrnAssigningAuthority: `CHARTWARDEN-${ORG}`,
  familyName: "Doe",
  givenName: "Jane",
  dateOfBirth: "1950-04-05",
  sexCode: "F",
  status: "active",
  address: { line1: "1 Main St", city: "Springfield", state: "OR", postalCode: "97477" },
  sudRestricted: false,
  ...over,
});
const physician = (over: Partial<OrmPhysicianFacts> = {}): OrmPhysicianFacts => ({
  status: "active",
  npi: "1234567893",
  firstName: "Sam",
  lastName: "Smith",
  ...over,
});
const dest = { ok: true, facilityId: FACILITY } as const;

describe("planOrmRequested — the happy path builds the exact catalogued payload", () => {
  it("assembles PID/ORC/OBR facts and nothing beyond minimum-necessary", () => {
    const out = planOrmRequested({
      order: order(),
      patient: patient(),
      physician: physician(),
      destination: dest,
    });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.payload).toMatchObject({
      orderId: ORDER,
      organizationId: ORG,
      labDestinationFacilityId: FACILITY,
      priority: "S",
      requestedAt: "2026-03-01T12:00:00.000Z",
      labOrderPayload: {
        orderId: ORDER,
        patientId: PATIENT,
        placerOrderNumber: ORDER.replace(/-/g, ""),
        observationIdentifier: { code: "2345-7", text: "Glucose", codingSystem: "LN" },
        orderingProviderNpi: "1234567893",
        orderingProviderName: { family: "Smith", given: "Sam" },
        priority: "S",
        clinicalNotes: ["FASTING REQUIRED", "Draw before 8am"],
        patientDemographics: {
          mrn: "MRN-100",
          internalMrnAuthority: `CHARTWARDEN-${ORG}`,
          familyName: "Doe",
          givenName: "Jane",
          dateOfBirth: "1950-04-05",
          administrativeSex: "F",
          addressLine1: "1 Main St",
          addressCity: "Springfield",
          addressState: "OR",
          addressPostal: "97477",
        },
      },
    });
    // Minimum necessary: free-text clinical fields never cross to the lab.
    expect(JSON.stringify(out.payload)).not.toContain("SECRET");
  });

  it("omits the address rather than inventing one, and the notes when there are none", () => {
    const out = planOrmRequested({
      order: order({
        data: {
          testCodes: [{ system: "http://loinc.org", code: "2345-7", display: "Glucose" }],
          fastingRequired: false,
        },
      }),
      patient: patient({ address: null }),
      physician: physician(),
      destination: dest,
    });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    const demo = out.payload.labOrderPayload.patientDemographics;
    expect(demo.addressLine1).toBeUndefined();
    expect(out.payload.labOrderPayload.clinicalNotes).toBeUndefined();
  });
});

describe("planOrmRequested — every unresolvable fact REFUSES (never a partial payload)", () => {
  const refused = (input: Parameters<typeof planOrmRequested>[0]) => {
    const out = planOrmRequested(input);
    return out.kind === "refused" ? out.reason : `NOT REFUSED (${out.kind})`;
  };
  const base = { order: order(), patient: patient(), physician: physician(), destination: dest };

  it.each([
    ["patient_not_found", { ...base, patient: null }],
    ["sud_restricted", { ...base, patient: patient({ sudRestricted: true }) }],
    ["patient_merged", { ...base, patient: patient({ status: "merged" }) }],
    ["patient_mrn_missing", { ...base, patient: patient({ mrn: " " }) }],
    ["patient_name_missing", { ...base, patient: patient({ familyName: "" }) }],
    ["patient_name_missing", { ...base, patient: patient({ givenName: "" }) }],
    ["patient_dob_missing", { ...base, patient: patient({ dateOfBirth: "" }) }],
    ["patient_sex_unrecorded", { ...base, patient: patient({ sexCode: "UNK" }) }],
    ["patient_sex_unrecorded", { ...base, patient: patient({ sexCode: "" }) }],
    ["patient_sex_unmappable", { ...base, patient: patient({ sexCode: "banana" }) }],
    ["physician_unresolved", { ...base, physician: null }],
    ["physician_not_active", { ...base, physician: physician({ status: "deactivated" }) }],
    ["physician_npi_unconfirmed", { ...base, physician: physician({ status: "provisional" }) }],
    ["physician_npi_unconfirmed", { ...base, physician: physician({ npi: null }) }],
    ["physician_name_missing", { ...base, physician: physician({ lastName: "" }) }],
    ["no_routing_lab", { ...base, destination: { ok: false, reason: "no_routing_lab" } as const }],
    [
      "lab_facility_unresolved",
      { ...base, destination: { ok: false, reason: "lab_facility_unresolved" } as const },
    ],
    ["no_active_feed", { ...base, destination: { ok: false, reason: "no_active_feed" } as const }],
    ["ambiguous_feed", { ...base, destination: { ok: false, reason: "ambiguous_feed" } as const }],
    ["lab_test_codes_missing", { ...base, order: order({ data: { testCodes: [] } }) }],
    [
      "multiple_test_codes_unsupported",
      {
        ...base,
        order: order({
          data: {
            testCodes: [
              { system: "http://loinc.org", code: "2345-7", display: "Glucose" },
              { system: "http://loinc.org", code: "718-7", display: "Hemoglobin" },
            ],
          },
        }),
      },
    ],
    ["payload_invalid", { ...base, order: order({ organizationId: "" }) }],
  ] as const)("%s", (reason, input) => {
    expect(refused(input as Parameters<typeof planOrmRequested>[0])).toBe(reason);
  });

  it("the Part 2 gate wins over every other fact — a restricted patient is refused before assembly", () => {
    expect(
      refused({
        ...base,
        patient: patient({ sudRestricted: true, sexCode: "banana", mrn: "" }),
        physician: null,
      }),
    ).toBe("sud_restricted");
  });

  it("an explicit HL7 'U' (asked, unknown) passes; only the unrecorded default UNK refuses", () => {
    expect(planOrmRequested({ ...base, patient: patient({ sexCode: "U" }) }).kind).toBe("ok");
  });
});

describe("mappings", () => {
  it("priority: stat→S, asap→A, everything else (incl. null) is HL7's default routine", () => {
    expect([
      toHl7Priority("stat"),
      toHl7Priority("asap"),
      toHl7Priority("routine"),
      toHl7Priority(null),
    ]).toEqual(["S", "A", "R", "R"]);
  });
  it("sex: HL7, spelled-out and SNOMED forms map; UNK/blank are unrecorded; the rest is unmappable", () => {
    expect(["M", "male", "248153007", "F", "FEMALE", "248152002", "O", "u"].map(toHl7Sex)).toEqual([
      "M",
      "M",
      "M",
      "F",
      "F",
      "F",
      "O",
      "U",
    ]);
    expect([toHl7Sex("UNK"), toHl7Sex(""), toHl7Sex(null)]).toEqual([
      "unrecorded",
      "unrecorded",
      "unrecorded",
    ]);
    expect(toHl7Sex("x")).toBeNull();
  });
});

describe("resolveOrmRequested — the IO shell", () => {
  const tx = {} as never;
  const okPorts = (over: Partial<OrmRequestedPorts> = {}): OrmRequestedPorts => ({
    patient: async () => patient(),
    physician: async () => physician(),
    destination: async () => dest,
    ...over,
  });

  it("does not even resolve the physician or destination for a SUD-restricted patient", async () => {
    const physicianSpy = vi.fn(async () => physician());
    const destinationSpy = vi.fn(async () => dest);
    const out = await resolveOrmRequested(
      okPorts({
        patient: async () => patient({ sudRestricted: true }),
        physician: physicianSpy,
        destination: destinationSpy,
      }),
      tx,
      order(),
    );
    expect(out).toEqual({ kind: "refused", reason: "sud_restricted" });
    expect(physicianSpy).not.toHaveBeenCalled();
    expect(destinationSpy).not.toHaveBeenCalled();
  });

  it("passes the order's own routingLabId to the destination port (null when absent)", async () => {
    const seen: Array<string | null> = [];
    const destination: OrmRequestedPorts["destination"] = async (_tx, _org, args) => {
      seen.push(args.routingLabId);
      return dest;
    };
    await resolveOrmRequested(
      okPorts({ destination }),
      tx,
      order({ data: { ...(order().data as object), routingLabId: FACILITY } }),
    );
    await resolveOrmRequested(okPorts({ destination }), tx, order());
    expect(seen).toEqual([FACILITY, null]);
  });

  it("a throwing dependency refuses (dependency_unavailable) instead of failing the caller's sign", async () => {
    const out = await resolveOrmRequested(
      okPorts({
        physician: async () => {
          throw new Error("M40 unavailable");
        },
      }),
      tx,
      order(),
    );
    expect(out).toEqual({ kind: "refused", reason: "dependency_unavailable" });
  });
});
