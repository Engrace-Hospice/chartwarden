import { describe, expect, it } from "vitest";
import { MedicaidAdapterError } from "../src/errors";
import { isValidOhpMemberId } from "../src/oregon";
import { MedicaidAdapterRegistry } from "../src/registry";

describe("MedicaidAdapterRegistry", () => {
  it("registers Oregon (real) + WA/ID/CA/NV deny-stubs", () => {
    const reg = new MedicaidAdapterRegistry();
    expect(reg.adapterForState("OR")?.vendor).toBe("oregon-oha-direct");
    expect(reg.isPhaseOneDenyStub("OR")).toBe(false);
    for (const st of ["WA", "ID", "CA", "NV"]) {
      expect(reg.adapterForState(st)).not.toBeNull();
      expect(reg.isPhaseOneDenyStub(st)).toBe(true);
    }
    expect(reg.adapterForState("TX")).toBeNull();
    expect(reg.isPhaseOneDenyStub("TX")).toBe(true);
  });

  it("requireAdapterForState throws UNSUPPORTED_STATE for an unregistered state", () => {
    const reg = new MedicaidAdapterRegistry();
    expect(() => reg.requireAdapterForState("TX")).toThrowError(MedicaidAdapterError);
    try {
      reg.requireAdapterForState("TX");
    } catch (e) {
      expect((e as MedicaidAdapterError).code).toBe("UNSUPPORTED_STATE");
    }
  });

  it("fails closed at boot when an active M40 entry references an unknown vendor", () => {
    expect(
      () =>
        new MedicaidAdapterRegistry([
          { stateCode: "TX", active: true, adapterVendor: "texas-mmis", operatingModel: "ffs_only" },
        ]),
    ).toThrow(/no such adapter is registered/);
  });

  it("accepts an active M40 entry that references a registered vendor", () => {
    expect(
      () =>
        new MedicaidAdapterRegistry([
          { stateCode: "OR", active: true, adapterVendor: "oregon-oha-direct", operatingModel: "hybrid" },
        ]),
    ).not.toThrow();
  });

  it("Oregon deny-stubs the not-yet-wired wire I/O but keeps real metadata + TOB", async () => {
    const or = new MedicaidAdapterRegistry().requireAdapterForState("OR");
    expect(or.metadata.acceptsDocumentedMissingEvv).toBe(false);
    expect(or.metadata.combinesHospiceAndRb).toBe(true);
    expect(or.replacementTob("811")).toBe("817");
    expect(or.voidTob("811")).toBe("818");
    await expect(
      or.eligibilityCheck({
        orgId: "o",
        patientId: "p",
        asOfServiceDate: "2026-01-01",
        recipientIdPlain: "x",
        credentials: {} as never,
      }),
    ).rejects.toMatchObject({ code: "ADAPTER_NOT_WIRED" });
  });

  it("a deny-stub state throws ADAPTER_DENY_STUB on every I/O method", async () => {
    const wa = new MedicaidAdapterRegistry().requireAdapterForState("WA");
    await expect(
      wa.submit({ body: new Uint8Array(), idempotencyKey: "k", channel: "direct_mmis", credentials: {} as never }),
    ).rejects.toMatchObject({ code: "ADAPTER_DENY_STUB" });
  });
});

describe("isValidOhpMemberId (Oregon mod-10)", () => {
  it("rejects wrong length / non-numeric", () => {
    expect(isValidOhpMemberId("1234567")).toBe(false);
    expect(isValidOhpMemberId("123456789")).toBe(false);
    expect(isValidOhpMemberId("1234567a")).toBe(false);
  });
  it("accepts a valid mod-10 id and rejects a bad check digit", () => {
    // construct a valid id: pick 7 digits, compute the check digit the same way the validator does.
    const seven = "1234567";
    let sum = 0;
    let dbl = true;
    for (let i = seven.length - 1; i >= 0; i -= 1) {
      let d = seven.charCodeAt(i) - 48;
      if (dbl) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      dbl = !dbl;
    }
    const check = (10 - (sum % 10)) % 10;
    expect(isValidOhpMemberId(seven + String(check))).toBe(true);
    expect(isValidOhpMemberId(seven + String((check + 1) % 10))).toBe(false);
  });
});
