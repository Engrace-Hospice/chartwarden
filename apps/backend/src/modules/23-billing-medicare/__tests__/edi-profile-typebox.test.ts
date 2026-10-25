import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { UpsertEdiProfileBodySchema } from "../routes/edi-profile-typebox";

const OK = {
  submitterName: "Test Hospice LLC",
  submitterId: "SUB123",
  submitterContactName: "Billing Office",
  submitterContactPhone: "5035550100",
  receiverName: "Test Clearinghouse",
  receiverId: "RECV456",
  receiverApplicationCode: "TESTRECV",
};

describe("UpsertEdiProfileBodySchema", () => {
  it("accepts a well-formed profile", () => {
    expect(Value.Check(UpsertEdiProfileBodySchema, OK)).toBe(true);
  });

  it.each(["*", "~", ":", "^", "|", "\\"])("refuses the X12 delimiter %s in a name", (ch) => {
    expect(
      Value.Check(UpsertEdiProfileBodySchema, { ...OK, submitterName: `ACME${ch}BILLING` }),
    ).toBe(false);
  });

  it("refuses a blank id", () => {
    expect(Value.Check(UpsertEdiProfileBodySchema, { ...OK, receiverId: "   " })).toBe(false);
  });
});
