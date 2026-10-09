// GAP-032 - opening the sealed emergency contact for the terminus dial (no database).
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createSafetyCiphers } from "../src/modules/20-field-safety/safety-crypto";
import {
  openEmergencyContact,
  resolveDialNumber,
} from "../src/modules/20-field-safety/terminus/contact";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

const key = randomBytes(32);
const ciphers = createSafetyCiphers({
  dekForOrg: async () => ({ version: "1", key }),
  dekForOrgVersion: async () => ({ version: "1", key }),
});

async function sealedDetail(contact: unknown, org = ORG_A) {
  const sealed = await ciphers.cipher.encrypt({
    organizationId: org,
    plaintext: JSON.stringify(contact),
  });
  return { contact: Buffer.from(sealed).toString("base64"), enc: "dek" };
}

describe("openEmergencyContact", () => {
  it("opens a sealed contact for its own tenant", async () => {
    const detail = await sealedDetail({
      name: "Pat Example",
      phone: "+14155552671",
      relationship: "spouse",
    });
    const opened = await openEmergencyContact(detail, {
      organizationId: ORG_A,
      decipher: ciphers.decipher,
    });
    expect(opened).toEqual({ kind: "ok", phone: "+14155552671" });
  });

  it("fails closed for another tenant (the AAD binds the blob to its org)", async () => {
    const detail = await sealedDetail({ phone: "+14155552671" });
    const opened = await openEmergencyContact(detail, {
      organizationId: ORG_B,
      decipher: ciphers.decipher,
    });
    expect(opened).toEqual({ kind: "unreadable" });
  });

  it("is unreadable for a missing key, a plaintext detail, or malformed JSON", async () => {
    const deps = { organizationId: ORG_A, decipher: ciphers.decipher };
    expect(await openEmergencyContact({}, deps)).toEqual({ kind: "unreadable" });
    expect(await openEmergencyContact(null, deps)).toEqual({ kind: "unreadable" });
    expect(await openEmergencyContact({ contact: "not-base64-cipher" }, deps)).toEqual({
      kind: "unreadable",
    });
    const garbage = await ciphers.cipher.encrypt({ organizationId: ORG_A, plaintext: "{nope" });
    expect(
      await openEmergencyContact({ contact: Buffer.from(garbage).toString("base64") }, deps),
    ).toEqual({ kind: "unreadable" });
  });

  it("never lets the number reach a log line or an error when the open fails", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const detail = await sealedDetail({ phone: "+14155552671" });
    const result = await openEmergencyContact(detail, {
      organizationId: ORG_B,
      decipher: ciphers.decipher,
    });
    expect(JSON.stringify(result)).not.toContain("4155552671");
    expect(JSON.stringify([...spy.mock.calls, ...err.mock.calls])).not.toContain("4155552671");
    spy.mockRestore();
    err.mockRestore();
  });
});

describe("resolveDialNumber", () => {
  it("accepts an already-normalised number and normalises a legacy national format", () => {
    expect(resolveDialNumber("+14155552671")).toEqual({ kind: "ok", e164: "+14155552671" });
    expect(resolveDialNumber("(415) 555-2671")).toEqual({ kind: "ok", e164: "+14155552671" });
  });

  it("refuses emergency numbers and junk with number_invalid", () => {
    expect(resolveDialNumber("911")).toEqual({ kind: "invalid" });
    expect(resolveDialNumber("(555) 123")).toEqual({ kind: "invalid" });
    expect(resolveDialNumber(undefined)).toEqual({ kind: "invalid" });
  });
});
