// CW-AC-46 — the signer-licence verdict and the seam read, without a database. The live proof (the real roster as the app role,
// the audit rows, tenant isolation, the amendment and SFV paths, the CW-MON-01 rule) is `m10-hope-signer-licence.live.test.ts`.
import { ChartWardenError } from "@chartwarden/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import {
  HopeSignerLicenceRefusal,
  LICENCE_KIND_OF_DISCIPLINE,
  type SignerLicence,
  auditLicenceRefusals,
  readSignerLicence,
  signerLicenceRefusal,
} from "../src/modules/10-hope/hope-signer-licence";

const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const licence = (...heldKinds: string[]): SignerLicence => ({
  membershipId: MEMBERSHIP,
  asOf: "2026-11-27",
  heldKinds,
});
const verdict = (
  held: SignerLicence,
  authorDiscipline: string | null,
  rfaKind = "01_admission",
): HopeSignerLicenceRefusal | null =>
  signerLicenceRefusal(held, { authorDiscipline, rfaKind }, "timepoint_sign");

describe("which licence signs which discipline", () => {
  it("maps exactly the five HOPE author disciplines (LVN is the state title of LPN)", () => {
    expect(LICENCE_KIND_OF_DISCIPLINE).toEqual({
      RN: "rn",
      NP: "np",
      MD: "md",
      LPN: "lpn",
      LVN: "lpn",
    });
  });

  it.each(["RN", "NP", "MD", "LPN", "LVN"])(
    "a %s record signs on the licence kind that covers it, and only on that one",
    (discipline) => {
      const kind = (LICENCE_KIND_OF_DISCIPLINE as Record<string, string>)[discipline] as string;
      expect(verdict(licence(kind), discipline)).toBeNull();
      expect(
        verdict(licence("chha", "msw", "chaplain", "volunteer", "pa"), discipline),
      ).toMatchObject({ code: "M10_SIGNER_LICENCE_WRONG_DISCIPLINE" });
    },
  );
});

describe("requireSignerLicence", () => {
  it("refuses a signer with no active licence as NOT_ACTIVE (403) and names what was required", () => {
    const refusal = verdict(licence(), "RN");
    expect(refusal).toBeInstanceOf(HopeSignerLicenceRefusal);
    expect(refusal).toBeInstanceOf(ChartWardenError);
    expect(refusal).toMatchObject({
      code: "M10_SIGNER_LICENCE_NOT_ACTIVE",
      statusCode: 403,
      detail: {
        operation: "timepoint_sign",
        reason: "no_active_licence",
        rfaKind: "01_admission",
        requiredDiscipline: "RN",
        heldKinds: [],
        asOf: "2026-11-27",
      },
    });
    expect(refusal?.message).toContain("active RN licence on 2026-11-27");
    expect(refusal?.message).toContain("NEW Idempotency-Key");
  });

  it("refuses a licence held in another discipline only as WRONG_DISCIPLINE (403), listing the kinds held", () => {
    expect(verdict(licence("np", "rn"), "MD")).toMatchObject({
      code: "M10_SIGNER_LICENCE_WRONG_DISCIPLINE",
      statusCode: 403,
      detail: { reason: "wrong_discipline", requiredDiscipline: "MD", heldKinds: ["np", "rn"] },
    });
  });

  it("an RN licence does not cover an LPN record and an lpn licence does not cover an RN record", () => {
    expect(verdict(licence("rn"), "LPN", "04_sfv")?.code).toBe(
      "M10_SIGNER_LICENCE_WRONG_DISCIPLINE",
    );
    expect(verdict(licence("lpn"), "RN")?.code).toBe("M10_SIGNER_LICENCE_WRONG_DISCIPLINE");
  });

  it("a record with no frozen discipline matches no licence: refused, never waved through", () => {
    expect(verdict(licence("rn", "np", "md", "lpn"), null)).toMatchObject({
      code: "M10_SIGNER_LICENCE_WRONG_DISCIPLINE",
      detail: { requiredDiscipline: null },
    });
    expect(verdict(licence(), null)).toMatchObject({ code: "M10_SIGNER_LICENCE_NOT_ACTIVE" });
  });

  it("a discipline outside the HOPE set matches no licence", () => {
    expect(verdict(licence("rn"), "PA")?.code).toBe("M10_SIGNER_LICENCE_WRONG_DISCIPLINE");
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "a discipline named like an Object.prototype member (%s) matches no licence",
    (discipline) => {
      expect(verdict(licence("rn", "np", "md", "lpn"), discipline)?.code).toBe(
        "M10_SIGNER_LICENCE_WRONG_DISCIPLINE",
      );
    },
  );
});

describe("auditLicenceRefusals", () => {
  const caller = { organizationId: ORG, membershipId: MEMBERSHIP };
  const resource = { kind: "hope_assessment" as const, id: ORG };
  const error = vi.spyOn(console, "error");
  afterEach(() => error.mockReset());

  it("passes a successful signature through untouched and audits nothing", async () => {
    error.mockImplementation(() => undefined);
    await expect(
      auditLicenceRefusals({} as never, caller, resource, Promise.resolve("signed")),
    ).resolves.toBe("signed");
    expect(error).not.toHaveBeenCalled();
  });

  it("rethrows any other failure unchanged and audits nothing", async () => {
    error.mockImplementation(() => undefined);
    const stale = new ChartWardenError("CONFLICT", "stale", 409);
    await expect(
      auditLicenceRefusals({} as never, caller, resource, Promise.reject(stale)),
    ).rejects.toBe(stale);
    expect(error).not.toHaveBeenCalled();
  });

  it("a refusal stays the same 403 when its audit cannot be written, and the log says the trail missed it (ids and class only)", async () => {
    error.mockImplementation(() => undefined);
    const refusal = verdict(licence(), "RN") as HopeSignerLicenceRefusal;
    // A db with no `transaction`: the audit transaction cannot even start.
    const outcome = await auditLicenceRefusals(
      {} as never,
      caller,
      resource,
      Promise.reject(refusal),
    ).catch((e: unknown) => e);

    expect(outcome).toBe(refusal);
    const logged = error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("audit NOT written");
    expect(logged).toContain(MEMBERSHIP);
    expect(logged).not.toContain("licence on 2026"); // the message text is not copied into the log
  });
});

describe("readSignerLicence", () => {
  const warn = vi.spyOn(console, "warn");
  beforeEach(() => {
    warn.mockImplementation(() => undefined);
    __resetSeamsForTest();
  });
  afterEach(() => {
    warn.mockReset();
    __resetSeamsForTest();
  });

  it("asks the seam for the signer in the record's org on the signing day (UTC), and returns the kinds sorted and de-duplicated", async () => {
    const activeCredentialsAsOf = vi.fn(async () => [
      { kind: "np", status: "active" as const },
      { kind: "rn", status: "active" as const },
      { kind: "rn", status: "active" as const },
    ]);
    registerSeam("CredentialReader", { activeCredentialsAsOf });

    const held = await readSignerLicence(ORG, MEMBERSHIP, new Date("2026-11-27T23:59:59.000Z"));

    expect(activeCredentialsAsOf).toHaveBeenCalledWith({
      organizationId: ORG,
      membershipId: MEMBERSHIP,
      asOf: "2026-11-27",
    });
    expect(held).toEqual({ membershipId: MEMBERSHIP, asOf: "2026-11-27", heldKinds: ["np", "rn"] });
  });

  it("does not trust a seam that lets a non-active row through (fail closed on the one field the control rests on)", async () => {
    registerSeam("CredentialReader", {
      activeCredentialsAsOf: async () =>
        [
          { kind: "rn", status: "suspended" },
          { kind: "np", status: "revoked" },
        ] as never,
    });

    const held = await readSignerLicence(ORG, MEMBERSHIP, new Date("2026-11-27T00:00:00.000Z"));

    expect(held.heldKinds).toEqual([]);
  });

  it("a seam that throws is a retryable 503 M10_SIGNER_LICENCE_UNVERIFIABLE; the log names ids and the error class, never the message", async () => {
    registerSeam("CredentialReader", {
      activeCredentialsAsOf: async () => {
        throw Object.assign(new Error("connection string with a secret"), {
          name: "M17DownError",
        });
      },
    });

    const failure = await readSignerLicence(ORG, MEMBERSHIP, new Date()).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ChartWardenError);
    expect(failure).toMatchObject({ code: "M10_SIGNER_LICENCE_UNVERIFIABLE", statusCode: 503 });
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("M17DownError");
    expect(logged).toContain(MEMBERSHIP);
    expect(logged).not.toContain("secret");
  });

  it("a seam nobody registered fails closed the same way", async () => {
    const failure = await readSignerLicence(ORG, MEMBERSHIP, new Date()).catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: "M10_SIGNER_LICENCE_UNVERIFIABLE", statusCode: 503 });
  });
});
