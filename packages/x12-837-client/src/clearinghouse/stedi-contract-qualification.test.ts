import { describe, expect, it } from "vitest";
import { degraded } from "../types";
import { InMemoryAttemptStore } from "./attempt-store";
import {
  classifyVendorSubmission,
  contractRunGates,
  localScenario,
  summarizeQualification,
} from "./stedi-contract-qualification";
import { StediTransport } from "./stedi-transport";
import { CH } from "./types";
import type { ClearinghouseContext, ClearinghouseSubmission } from "./types";

const CTX: ClearinghouseContext = {
  organizationId: "synthetic-contract-org",
  providerEntityId: "synthetic-contract-provider",
  payerId: "STEDI",
  correlationId: "synthetic-contract-correlation",
  usage: "test",
  billingNpi: "1234567893",
};

const jsonSubmission = (
  overrides: Partial<ClearinghouseSubmission> = {},
): ClearinghouseSubmission => ({
  kind: "claim",
  controlNumber: "SYNTHETIC01",
  idempotencyKey: "synthetic-contract-key",
  payload: {
    format: "json",
    document: {
      usageIndicator: "T",
      billing: { npi: "1234567893" },
      claimInformation: { patientControlNumber: "SYNTHETIC01" },
    },
  },
  ...overrides,
});

describe("Stedi contract qualification classification", () => {
  it.each([
    [CH.NOT_PROVISIONED, "BLOCKED", "account_not_provisioned"],
    [CH.UNAVAILABLE, "BLOCKED", "vendor_unavailable"],
    [CH.INVALID_REQUEST, "FAIL", "vendor_or_adapter_refused_request"],
    [CH.NOT_WIRED, "FAIL", "operation_not_wired"],
  ] as const)("does not count %s as qualification PASS", (code, expected, reasonCode) => {
    const result = classifyVendorSubmission(
      "json_claim",
      degraded(code, "sanitized test reason"),
      true,
    );
    expect(result).toMatchObject({ state: expected, evidence: "vendor", reasonCode });
    expect(summarizeQualification([result], ["json_claim"], true).overall).toBe(
      expected === "BLOCKED" ? "BLOCKED" : "FAIL",
    );
  });

  it("classifies a successful response without a real vendor receipt id as FAIL", () => {
    const result = classifyVendorSubmission(
      "json_claim",
      {
        ok: true,
        data: {
          clearinghouseSubmissionId: "stedi:synthetic-contract-key",
          idempotencyKey: "synthetic-contract-key",
          controlNumber: "SYNTHETIC01",
          receivedAt: "2026-11-01T00:00:00.000Z",
          replayed: false,
        },
      },
      true,
    );
    expect(result.state).toBe("FAIL");
    expect(result.reasonCode).toBe("successful_response_missing_vendor_receipt_id");
  });

  it("does not classify a successful result as PASS unless the vendor request was sent", () => {
    const result = classifyVendorSubmission(
      "json_claim",
      {
        ok: true,
        data: {
          clearinghouseSubmissionId: "vendor-reference",
          idempotencyKey: "synthetic-contract-key",
          controlNumber: "SYNTHETIC01",
          receivedAt: "2026-11-01T00:00:00.000Z",
          replayed: false,
        },
      },
      false,
    );
    expect(result).toMatchObject({
      state: "FAIL",
      reasonCode: "successful_result_without_vendor_request",
      requestSent: false,
    });
  });

  it("classifies ambiguous transport outcomes as BLOCKED, never vendor PASS", () => {
    const result = classifyVendorSubmission(
      "json_claim",
      degraded(CH.UNAVAILABLE, "ambiguous test result", true),
      true,
    );
    expect(result).toMatchObject({ state: "BLOCKED", reasonCode: "ambiguous_vendor_outcome" });
    expect(summarizeQualification([result], ["json_claim"], true).overall).toBe("BLOCKED");
  });

  it("requires every mandatory vendor scenario to pass before overall PASS", () => {
    const pass = classifyVendorSubmission(
      "json_claim",
      {
        ok: true,
        data: {
          clearinghouseSubmissionId: "vendor-reference",
          idempotencyKey: "synthetic-contract-key",
          controlNumber: "SYNTHETIC01",
          receivedAt: "2026-11-01T00:00:00.000Z",
          replayed: false,
        },
      },
      true,
    );
    expect(summarizeQualification([pass], ["json_claim", "raw_claim", "noe"], true).overall).toBe(
      "NOT_RUN",
    );
    expect(summarizeQualification([pass], ["json_claim"], false).overall).toBe("NOT_RUN");
    expect(summarizeQualification([pass], ["json_claim"], true).overall).toBe("PASS");
    expect(
      summarizeQualification(
        [pass, localScenario("required_local_check", "NOT_RUN")],
        ["json_claim"],
        true,
      ).overall,
    ).toBe("NOT_RUN");
  });

  it("preserves executed vendor FAIL/BLOCKED outcomes when dependent local checks are NOT_RUN", () => {
    const dependentLocal = localScenario("dependent_local_replay", "NOT_RUN");
    const blocked = classifyVendorSubmission(
      "json_claim",
      degraded(CH.NOT_PROVISIONED, "not provisioned"),
      true,
    );
    const failed = classifyVendorSubmission(
      "json_claim",
      degraded(CH.INVALID_REQUEST, "refused"),
      true,
    );
    expect(summarizeQualification([blocked, dependentLocal], ["json_claim"], true).overall).toBe(
      "BLOCKED",
    );
    expect(summarizeQualification([failed, dependentLocal], ["json_claim"], true).overall).toBe(
      "FAIL",
    );
  });

  it("labels local refusal as local evidence, not a vendor observation", async () => {
    let requests = 0;
    const transport = new StediTransport({
      apiKey: "synthetic-only-test-key",
      attempts: new InMemoryAttemptStore(),
      fetch: (async () => {
        requests += 1;
        throw new Error("network access was not expected");
      }) as typeof fetch,
    });
    const bad = jsonSubmission({
      payload: {
        format: "json",
        document: {
          usageIndicator: "P",
          billing: { npi: "1234567893" },
          claimInformation: { patientControlNumber: "SYNTHETIC01" },
        },
      },
    });
    const result = await transport.submitClaim(CTX, bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.degraded.code).toBe(CH.INVALID_REQUEST);
    expect(requests).toBe(0);
    expect(
      localScenario("production_usage_refusal", "PASS", "locally_refused", false),
    ).toMatchObject({
      evidence: "local",
      state: "PASS",
      requestSent: false,
    });
    expect(
      summarizeQualification(
        [localScenario("production_usage_refusal", "PASS")],
        ["json_claim"],
        true,
      ).overall,
    ).toBe("NOT_RUN");
  });
});

describe("Stedi contract execution gates", () => {
  const readyEnv = {
    STEDI_TEST_API_KEY: "never-display-this",
    STEDI_CONTRACT_RUNNER: "dedicated-command",
    STEDI_CONTRACT_CONFIRM: "synthetic-only",
    STEDI_CONTRACT_KEY_IS_TEST: "yes",
    STEDI_CONTRACT_OPERATOR_AUTHORIZED: "yes",
    STEDI_CONTRACT_AUTHORIZATION_REF: "OPS-727",
    STEDI_CONTRACT_VENDOR_CONFIRMATION_REF: "VENDOR-727",
    STEDI_CONTRACT_RESULTS_FILE: "/tmp/stedi-contract-results.json",
  };

  it("requires human authorization, a vendor confirmation reference and a results artifact", () => {
    expect(contractRunGates(readyEnv).ready).toBe(true);
    expect(
      contractRunGates({
        ...readyEnv,
        STEDI_CONTRACT_OPERATOR_AUTHORIZED: undefined,
        STEDI_CONTRACT_VENDOR_CONFIRMATION_REF: undefined,
        STEDI_CONTRACT_RESULTS_FILE: undefined,
      }).reasonCodes,
    ).toEqual(
      expect.arrayContaining([
        "operator_authorization_missing",
        "vendor_confirmation_reference_missing_or_invalid",
        "results_file_missing",
      ]),
    );
  });

  it("refuses an inherited live binding, platform Stedi key or production runtime", () => {
    expect(contractRunGates({ ...readyEnv, CLEARINGHOUSE_VENDOR: "stedi" }).ready).toBe(false);
    expect(contractRunGates({ ...readyEnv, STEDI_API_KEY: "do-not-print" }).ready).toBe(false);
    expect(contractRunGates({ ...readyEnv, NODE_ENV: "production" }).ready).toBe(false);
  });

  it("never returns the API key in the gate report", () => {
    const report = contractRunGates(readyEnv);
    expect(JSON.stringify(report)).not.toContain(readyEnv.STEDI_TEST_API_KEY);
  });
});
