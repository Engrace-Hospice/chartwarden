import { describe, expect, it } from "vitest";
import {
  type Claim837iPartiesDeps,
  type EdiProfileFacts,
  type ProviderBillingFacts,
  billingAddressFrom,
  buildClaim837iPartiesPortFactory,
  buildClaim837iProviderReader,
} from "../services/claim-837i-parties";

const TX = {} as never;
const ARGS = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  providerEntityId: "22222222-2222-4222-8222-222222222222",
  patientPayerId: "33333333-3333-4333-8333-333333333333",
  payerId: "MAC01",
};

const PROFILE: EdiProfileFacts = {
  submitter: {
    name: "Test Hospice",
    id: "SUB1",
    contactName: "Billing",
    contactPhone: "5035550100",
  },
  receiver: { name: "Test CH", id: "RCV1", applicationCode: "TESTRCV" },
};

const PROVIDER: ProviderBillingFacts = {
  legalName: " Test Hospice LLC ",
  npi: "1234567893",
  taxId: "123456789",
  address: [{ line1: "1 Main St", city: "Portland", state: "or", postalCode: "97201" }],
};

const deps = (over: Partial<Claim837iPartiesDeps> = {}): Claim837iPartiesDeps => ({
  routeKey: "claim_md",
  profile: async () => PROFILE,
  provider: async () => PROVIDER,
  payerName: async () => "Medicare MAC",
  ...over,
});

describe("buildClaim837iPartiesPort", () => {
  it("assembles all four parties from their sources", async () => {
    const res = await buildClaim837iPartiesPortFactory(deps())(TX).partiesFor(ARGS);

    expect(res).toEqual({
      submitter: PROFILE.submitter,
      receiver: PROFILE.receiver,
      billingProvider: {
        organizationName: "Test Hospice LLC",
        npi: "1234567893",
        taxId: "123456789",
        address: { line1: "1 Main St", city: "Portland", state: "OR", postalCode: "97201" },
      },
      payer: { name: "Medicare MAC", payerId: "MAC01" },
    });
  });

  it("passes the bound route to the profile read", async () => {
    const seen: string[] = [];

    await buildClaim837iPartiesPortFactory(
      deps({
        profile: async (_tx, _o, _p, route) => {
          seen.push(route);
          return PROFILE;
        },
      }),
    )(TX).partiesFor(ARGS);

    expect(seen).toEqual(["claim_md"]);
  });

  it("returns null submitter and receiver, without reading, when no route is bound", async () => {
    let read = false;

    const res = await buildClaim837iPartiesPortFactory(
      deps({
        routeKey: null,
        profile: async () => {
          read = true;
          return PROFILE;
        },
      }),
    )(TX).partiesFor(ARGS);

    expect(read).toBe(false);
    expect(res.submitter).toBeNull();
    expect(res.receiver).toBeNull();
  });

  it("returns null for each section its source cannot supply", async () => {
    const res = await buildClaim837iPartiesPortFactory(
      deps({ profile: async () => null, provider: async () => null, payerName: async () => null }),
    )(TX).partiesFor(ARGS);

    expect(res).toEqual({ submitter: null, receiver: null, billingProvider: null, payer: null });
  });

  it.each([
    ["an EIN that is not 9 digits", { taxId: "12345" }],
    ["a blank NPI", { npi: " " }],
    ["no usable address", { address: [] }],
  ])("returns a null billing provider for %s", async (_name, patch) => {
    const res = await buildClaim837iPartiesPortFactory(
      deps({ provider: async () => ({ ...PROVIDER, ...patch }) }),
    )(TX).partiesFor(ARGS);

    expect(res.billingProvider).toBeNull();
  });
});

describe("billingAddressFrom", () => {
  it("reads the first entry and never substitutes a later one for an incomplete first", () => {
    const later = {
      line1: "2 Oak Ave",
      line2: "Ste 4",
      city: "Salem",
      state: "OR",
      postalCode: "97301-1234",
    };

    expect(billingAddressFrom([later, { line1: "x" }])).toEqual(later);
    expect(billingAddressFrom([{ line1: "PO Box", city: "Salem" }, later])).toBeNull();
  });

  it.each([
    [null],
    [{}],
    ["x"],
    [[{ line1: "a", city: "b", state: "Oregon", postalCode: "97201" }]],
  ])("returns null for %j", (input) => {
    expect(billingAddressFrom(input)).toBeNull();
  });
});

describe("buildClaim837iProviderReader", () => {
  const sealed = {
    legalName: "Test Hospice LLC",
    npi: "1234567893",
    taxIdSealed: "v2.1.n.t.c",
    addresses: [],
  };

  it("opens the sealed EIN with the org and provider entity it was sealed for", async () => {
    const seen: unknown[] = [];

    const res = await buildClaim837iProviderReader({
      sealedFacts: async () => sealed,
      decryptTaxId: async (input) => {
        seen.push(input);
        return "123456789";
      },
    })(TX, ARGS.organizationId, ARGS.providerEntityId);

    expect(res).toMatchObject({ taxId: "123456789", npi: "1234567893" });
    expect(seen).toEqual([
      {
        organizationId: ARGS.organizationId,
        providerEntityId: ARGS.providerEntityId,
        sealed: "v2.1.n.t.c",
      },
    ]);
  });

  it("returns null, without decrypting, when the provider entity is unknown", async () => {
    let decrypted = false;

    const res = await buildClaim837iProviderReader({
      sealedFacts: async () => null,
      decryptTaxId: async () => {
        decrypted = true;
        return "";
      },
    })(TX, ARGS.organizationId, ARGS.providerEntityId);

    expect(res).toBeNull();
    expect(decrypted).toBe(false);
  });
});
