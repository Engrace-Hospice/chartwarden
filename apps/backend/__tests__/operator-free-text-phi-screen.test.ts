/**
 * Operator free text that lands on a tenant-readable row is screened for patient identifiers, like M34's wizard text:
 * the platform NPI-verification `evidence` (M23) and the claims-billing add-on grant `reason` (M35). Both reject with the
 * typed 422 EVIDENCE_LOOKS_LIKE_PHI BEFORE any platform transaction opens, and never echo the value. The screen lives in
 * @chartwarden/shared (the manifest has no M23->M34 or M35->M34 edge), so all three callers share one rule.
 * Values are synthetic: the SSN uses area 900 (never issued); the MBI is on the synthetic registry.
 */
import { assertNoPatientIdentifier } from "@chartwarden/shared";
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import { buildDrizzleNpiVerificationService } from "../src/modules/23-billing-medicare/routes/npi-verification-service";
import { buildDrizzleAddonService } from "../src/modules/35-subscription/addon/addon-service";

const SSN_TEXT = "owner confirmed over the phone, id 900-12-3456";
const MBI_TEXT = "called about beneficiary 1EG4-TE5-MK73";
const CLEAN = "NPPES record matches the legal name; CCN contact called back";
const ZERO_WIDTH_SSN = "ref 900\u200b-12\u200b-3456";

const refusal = async (run: () => Promise<unknown>): Promise<ChartWardenError> => {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(ChartWardenError);
    return err as ChartWardenError;
  }
  throw new Error("expected a refusal");
};

describe("assertNoPatientIdentifier (the shared screen)", () => {
  it.each([SSN_TEXT, MBI_TEXT, ZERO_WIDTH_SSN])(
    "refuses %s with a typed 422 that never echoes it",
    (text) => {
      try {
        assertNoPatientIdentifier("evidence", text);
        expect.unreachable("should have refused");
      } catch (err) {
        const e = err as ChartWardenError;
        expect(e).toBeInstanceOf(ChartWardenError);
        expect(e.code).toBe("EVIDENCE_LOOKS_LIKE_PHI");
        expect(e.statusCode).toBe(422);
        expect(e.message).not.toContain("900");
        expect(JSON.stringify(e.details)).not.toContain("3456");
        expect(JSON.stringify(e.details)).toContain("evidence");
      }
    },
  );

  it("lets ordinary operator text through", () => {
    expect(() => assertNoPatientIdentifier("reason", CLEAN)).not.toThrow();
  });
});

describe("M23 NPI verification evidence", () => {
  const actor = { userId: "u", membershipId: "m" } as never;
  const build = () => {
    const runner = vi.fn(async () => {
      throw new Error("platform transaction opened");
    });
    const service = buildDrizzleNpiVerificationService({
      runner: runner as never,
      onVerificationChanged: async () => undefined,
    });
    return { runner, service };
  };

  it.each([SSN_TEXT, MBI_TEXT, ZERO_WIDTH_SSN])(
    "refuses %s before any platform transaction",
    async (evidence) => {
      const { runner, service } = build();
      const err = await refusal(() =>
        service.verify(actor, "11111111-1111-4111-8111-111111111111", {
          npi: "1234567893",
          evidence,
        }),
      );
      expect(err).toMatchObject({ code: "EVIDENCE_LOOKS_LIKE_PHI", statusCode: 422 });
      expect(runner).not.toHaveBeenCalled();
    },
  );

  it("lets clean evidence reach the platform transaction", async () => {
    const { runner, service } = build();
    await expect(
      service.verify(actor, "11111111-1111-4111-8111-111111111111", {
        npi: "1234567893",
        evidence: CLEAN,
      }),
    ).rejects.toThrow("platform transaction opened");
    expect(runner).toHaveBeenCalledTimes(1);
  });
});

describe("M35 claims-billing add-on grant reason", () => {
  const actor = { userId: "u", membershipId: "m" } as never;
  const build = () => {
    const platformRunner = vi.fn(async () => {
      throw new Error("platform transaction opened");
    });
    const service = buildDrizzleAddonService({} as never, {
      platformRunner: platformRunner as never,
    });
    return { platformRunner, service };
  };
  const grant = (reason: string) => ({
    addonSlug: "claims_billing",
    mode: "active" as const,
    reason,
  });

  it.each([SSN_TEXT, MBI_TEXT, ZERO_WIDTH_SSN])(
    "refuses %s before any platform transaction",
    async (reason) => {
      const { platformRunner, service } = build();
      const err = await refusal(() => service.grantAddon(actor, "sub-1", grant(reason) as never));
      expect(err).toMatchObject({ code: "EVIDENCE_LOOKS_LIKE_PHI", statusCode: 422 });
      expect(platformRunner).not.toHaveBeenCalled();
    },
  );

  it("lets a clean reason reach the platform transaction", async () => {
    const { platformRunner, service } = build();
    await expect(service.grantAddon(actor, "sub-1", grant(CLEAN) as never)).rejects.toThrow(
      "platform transaction opened",
    );
    expect(platformRunner).toHaveBeenCalledTimes(1);
  });
});
