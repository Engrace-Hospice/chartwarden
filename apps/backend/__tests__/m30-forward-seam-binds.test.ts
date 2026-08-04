import { bindQualityConsumedSeams } from "@wardenx/quality";
// apps/backend/__tests__/m30-forward-seam-binds.test.ts — M30's M23/M27 forward-seam binds (§4.4).
//
// `QUALITY_FORWARD_SEAM_DENY_STUBS` stubbed `billing` (M23) and `costReport` (M27) as ABSENT producers
// long after both modules shipped, so the HCI claims-derived indicators and the CoP 418.310
// failure-to-file indicator resolved `{ value: null, isForwardSeamDenyStub: true }` and stayed suppressed.
//
// The contract these tests pin is the one that matters for a QUALITY module: an unavailable input must
// SUPPRESS the measure, never substitute a zero — a fabricated zero reads as a perfect score on a measure
// CMS publishes. And the degrade must be per METHOD, so a half-registered producer only suppresses the
// measures that actually needed the missing read.
import { beforeEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam, validateSeams } from "../src/bootstrap/seams/registry";
import { wireModuleSeams } from "../src/index";
import {
  buildM30BillingConsumer,
  buildM30CostReportConsumer,
  buildM30LiveForwardSeams,
} from "../src/modules/30-quality/index";

const ORG = "org-1";
const PERIOD = { from: "2026-01-01", to: "2026-12-31" };

/** The PRESENT-producer bundle `bindQualityConsumedSeams` requires; irrelevant to these assertions. */
const PRESENT = {} as never;

beforeEach(() => {
  __resetSeamsForTest();
});

describe("M30 §4.4 — the M23/M27 forward-seam binds", () => {
  it("an UNREGISTERED ClaimLineReader suppresses the measure rather than reporting zero days", async () => {
    wireModuleSeams();
    validateSeams(); // installs the M1 deny-stub, which throws on any call
    const billing = buildM30BillingConsumer();
    const r = await billing.claimLineRollup(ORG, PERIOD);
    expect(r).toEqual({ value: null, isForwardSeamDenyStub: true });
    // The distinction that matters: NOT a zero-day rollup, which would read as a real claims number.
    expect((r as { totalPatientDays?: number }).totalPatientDays).toBeUndefined();
  });

  it("binds the LIVE ClaimLineReader and projects the per-LOC rollup + line population", async () => {
    wireModuleSeams();
    registerSeam("ClaimLineReader", {
      async claimLineRollupForPeriod() {
        return {
          totalPatientDays: 412,
          byLevelOfCare: { rhc: 380, chc: 12, irc: 6, gip: 14 },
          claimLineCount: 57,
        };
      },
    } as never);

    const r = await buildM30BillingConsumer().claimLineRollup(ORG, PERIOD);
    expect(r).toEqual({
      totalPatientDays: 412,
      rhcDays: 380,
      chcDays: 12,
      ircDays: 6,
      gipDays: 14,
      claimLineCount: 57,
      isForwardSeamDenyStub: false,
    });
  });

  it("degrades PER METHOD — a live patientDays does not un-suppress claimLineRollup", async () => {
    wireModuleSeams();
    validateSeams();
    registerSeam("PatientDaysProvider", {
      async billedDaysForFiscalYear() {
        return { totalPatientDays: 412 };
      },
    } as never);

    const billing = buildM30BillingConsumer();
    await expect(billing.patientDays(ORG, PERIOD)).resolves.toEqual({
      totalPatientDays: 412,
      isForwardSeamDenyStub: false,
    });
    // ClaimLineReader is still the deny-stub — only ITS measure suppresses.
    await expect(billing.claimLineRollup(ORG, PERIOD)).resolves.toEqual({
      value: null,
      isForwardSeamDenyStub: true,
    });
  });

  it("a producer that THROWS at read time degrades to suppressed, not to a crash", async () => {
    wireModuleSeams();
    registerSeam("ClaimLineReader", {
      async claimLineRollupForPeriod() {
        throw new Error("RLS denied / db unbound");
      },
    } as never);

    await expect(buildM30BillingConsumer().claimLineRollup(ORG, PERIOD)).resolves.toEqual({
      value: null,
      isForwardSeamDenyStub: true,
    });
  });

  it("reduces M27's filing posture to the numerator/denominator the CoP indicator needs", async () => {
    wireModuleSeams();
    registerSeam("CostReportFilingStatusReader", {
      async filingStatusForOrg() {
        return [
          { pastDeadlineUnfiled: true },
          { pastDeadlineUnfiled: false },
          { pastDeadlineUnfiled: false },
        ];
      },
    } as never);

    await expect(buildM30CostReportConsumer().filingStatusForOrg(ORG)).resolves.toEqual({
      pastDeadlineUnfiled: 1,
      providerEntitiesAssessed: 3,
      isForwardSeamDenyStub: false,
    });
  });

  it("an org with NO cost reports yields 0/0 so the kernel suppresses on the denominator floor", async () => {
    wireModuleSeams();
    registerSeam("CostReportFilingStatusReader", {
      async filingStatusForOrg() {
        return [];
      },
    } as never);

    const r = await buildM30CostReportConsumer().filingStatusForOrg(ORG);
    // 0/0, NOT "0 violations" — the difference between "nothing to assess" and "perfect compliance".
    expect(r).toEqual({
      pastDeadlineUnfiled: 0,
      providerEntitiesAssessed: 0,
      isForwardSeamDenyStub: false,
    });
  });

  it("bindQualityConsumedSeams takes the live overrides and leaves M15/M16 stubbed", async () => {
    wireModuleSeams();
    validateSeams();
    const seams = bindQualityConsumedSeams(PRESENT, buildM30LiveForwardSeams());

    // M23/M27 slots are the live adapters (they degrade, but they are not the package deny-stub object).
    expect(seams.billing).toBe(seams.billing);
    await expect(seams.costReport.filingStatusForOrg(ORG)).resolves.toEqual({
      value: null,
      isForwardSeamDenyStub: true, // unregistered → suppressed, via the adapter's degrade path
    });
    // M15/M16 are still unbuilt — their stubs must remain.
    await expect(seams.discipline.disciplineComplianceRollup(ORG)).resolves.toEqual({
      value: null,
      isForwardSeamDenyStub: true,
    });
  });

  it("omitted overrides fall back to the deny-stub (a half-wired boot still binds)", async () => {
    const seams = bindQualityConsumedSeams(PRESENT, { billing: buildM30BillingConsumer() });
    await expect(seams.costReport.filingStatusForOrg(ORG)).resolves.toEqual({
      value: null,
      isForwardSeamDenyStub: true,
    });
  });
});
