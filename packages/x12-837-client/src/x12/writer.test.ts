import { describe, expect, it } from "vitest";
import { tokenizeInterchange } from "../eligibility/x12-envelope";
import {
  X12BuildError,
  addressSegments,
  isValidNpi,
  npi,
  optionalText,
  prepareEnvelope,
  text,
  wrapTransaction,
} from "./writer";

const ENVELOPE = {
  senderId: "WARDENX01",
  receiverId: "STEDI",
  applicationReceiverCode: "STEDI",
  interchangeControlNumber: 106,
  usage: "T" as const,
  createdAt: new Date("2026-10-09T15:00:00Z"),
};

describe("prepareEnvelope + wrapTransaction", () => {
  it("wraps a body in ISA/GS/ST … SE/GE/IEA with matching control numbers and counts", () => {
    const env = prepareEnvelope(ENVELOPE);
    const raw = wrapTransaction(env, {
      transactionSet: "837",
      body: [
        ["BHT", "0019"],
        ["LX", "1"],
      ],
    });
    const { segments } = tokenizeInterchange(raw);
    expect(segments.map((s) => s[0])).toEqual(["ISA", "GS", "ST", "BHT", "LX", "SE", "GE", "IEA"]);
    expect(segments[0]?.[13]).toBe("000000106");
    expect(segments[0]?.[15]).toBe("T");
    expect(segments[1]).toEqual([
      "GS",
      "HC",
      "WARDENX01",
      "STEDI",
      "20261009",
      "1500",
      "106",
      "X",
      "005010X223A2",
    ]);
    expect(segments[2]).toEqual(["ST", "837", "0106", "005010X223A2"]);
    expect(segments[5]).toEqual(["SE", "4", "0106"]);
    expect(segments[6]).toEqual(["GE", "1", "106"]);
    expect(segments[7]).toEqual(["IEA", "1", "000000106"]);
  });

  it("pads ISA06/ISA08 to 15 and ISA is 105 characters before its terminator (106 with it)", () => {
    const raw = wrapTransaction(prepareEnvelope(ENVELOPE), { transactionSet: "837", body: [] });
    expect(raw.split("~")[0]?.length).toBe(105);
  });

  it("exposes the date and time stamp for BHT", () => {
    expect(prepareEnvelope(ENVELOPE).stamp).toEqual({ ccyymmdd: "20261009", hhmm: "1500" });
  });

  it.each([
    ["senderId", { senderId: "" }],
    ["receiverId", { receiverId: "A*B" }],
    ["applicationReceiverCode", { applicationReceiverCode: "X".repeat(16) }],
    ["interchangeControlNumber", { interchangeControlNumber: 0 }],
    ["interchangeControlNumber", { interchangeControlNumber: 1_000_000_000 }],
  ])("names %s when it is invalid", (field, patch) => {
    expect(() => prepareEnvelope({ ...ENVELOPE, ...patch })).toThrow(`envelope.${field}`);
  });
});

describe("field helpers", () => {
  it("upper-cases and trims text", () => {
    expect(text(" jane ", "f", 10)).toBe("JANE");
  });

  it.each(["", "   ", "A*B", "A~B", "A:B", "A^B", "A|B", "X".repeat(11)])(
    "refuses text %j and names only the field",
    (value) => {
      try {
        text(value, "subscriber.lastName", 10);
        throw new Error("did not throw");
      } catch (e) {
        expect(e).toBeInstanceOf(X12BuildError);
        expect((e as X12BuildError).field).toBe("subscriber.lastName");
        if (value.trim() !== "") expect((e as Error).message).not.toContain(value.trim());
      }
    },
  );

  it("treats a blank optional as empty but still validates a present one", () => {
    expect(optionalText(null, "f", 5)).toBe("");
    expect(optionalText("  ", "f", 5)).toBe("");
    expect(() => optionalText("A*", "f", 5)).toThrow("f");
  });

  it("validates the NPI check digit", () => {
    expect(isValidNpi("1234567893")).toBe(true);
    expect(isValidNpi("1234567890")).toBe(false);
    expect(isValidNpi("123")).toBe(false);
    expect(() => npi("1234567890", "billingProvider.npi")).toThrow("billingProvider.npi");
  });

  it("builds N3/N4 and rejects a bad zip or state by field", () => {
    expect(
      addressSegments(
        { line1: "100 Main St", city: "Portland", state: "or", postalCode: "97201-1234" },
        "a",
      ),
    ).toEqual([
      ["N3", "100 MAIN ST"],
      ["N4", "PORTLAND", "OR", "972011234"],
    ]);
    expect(() =>
      addressSegments({ line1: "x", city: "y", state: "OR", postalCode: "9" }, "a"),
    ).toThrow("a.postalCode");
    expect(() =>
      addressSegments({ line1: "x", city: "y", state: "ORE", postalCode: "97201" }, "a"),
    ).toThrow("a.state");
  });
});

describe("prepareEnvelope — untyped envelope fields", () => {
  const base = {
    senderId: "A",
    receiverId: "B",
    applicationReceiverCode: "B",
    interchangeControlNumber: 1,
    usage: "T" as const,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
  it.each([
    [{ usage: "Q" }, "envelope.usage"],
    [{ createdAt: new Date("x") }, "envelope.createdAt"],
  ])("rejects %j naming the field", (patch, field) => {
    expect(() => prepareEnvelope({ ...base, ...patch } as never)).toThrow(
      expect.objectContaining({ field }),
    );
  });
});
