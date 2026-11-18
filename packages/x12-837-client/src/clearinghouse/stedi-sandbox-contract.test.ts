// Vendor-facing qualification contract for issue #727. Ordinary Vitest and CI skip all network calls.
// See docs/audits/clearinghouse-integration/STEDI_SANDBOX_RUNBOOK_20261025.md.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { build837iClaim } from "../claims/build-837i-claim";
import { CLAIM_INPUT } from "../claims/claim-fixture-input";
import { tokenizeInterchange } from "../eligibility/x12-envelope";
import { InMemoryAttemptStore } from "./attempt-store";
import { compareStediClaimJsonToX12 } from "./stedi-claim-agreement";
import { buildStediClaimJson } from "./stedi-claim-json";
import {
  classifyVendorSubmission,
  contractRunGates,
  localScenario,
  summarizeQualification,
} from "./stedi-contract-qualification";
import type { ContractScenarioResult } from "./stedi-contract-qualification";
import { StediTransport } from "./stedi-transport";
import { CH } from "./types";
import type { ClearinghouseContext, ClearinghouseSubmission } from "./types";

const gates = contractRunGates(process.env);
const RUN = gates.ready;
const KEY = RUN ? process.env.STEDI_TEST_API_KEY?.trim() : undefined;
const RESULTS_FILE = RUN ? process.env.STEDI_CONTRACT_RESULTS_FILE?.trim() : undefined;
const REQUIRED_VENDOR_SCENARIOS = ["raw_x12_claim", "json_837i_claim", "noe_81a"] as const;
const STEDI_ORIGIN = "https://healthcare.us.stedi.com";
const STEDI_PATH = "/2024-04-01/change/medicalnetwork/institutionalclaims/v1";

const fixture = (name: string): string =>
  readFileSync(join(__dirname, "__fixtures__", `stedi-${name}.x12`), "utf8");
const RUN_ID = String(Date.now() % 1_000_000_000).padStart(9, "0");
const withIsa13 = (x12: string, controlNumber: string): string =>
  x12.replace(/^(ISA(?:\*[^*]*){12}\*)[^*]*/, `$1${controlNumber}`);

const CTX: ClearinghouseContext = {
  organizationId: "contract-org-synthetic",
  providerEntityId: "contract-provider-synthetic",
  payerId: "STEDI",
  correlationId: `contract-${RUN_ID}`,
  usage: "test",
  billingNpi: "1234567893",
};

const vendorScenarios: ContractScenarioResult[] = [];
const localScenarios: ContractScenarioResult[] = [];
const sentByScenario = new Map<string, number>();
let currentScenario = "unassigned";

function submission(
  kind: ClearinghouseSubmission["kind"],
  x12Name: string,
  suffix: string,
): ClearinghouseSubmission {
  const controlNumber = `${RUN_ID.slice(0, 8)}${suffix}`;
  return {
    kind,
    controlNumber,
    idempotencyKey: `contract-${kind}-${RUN_ID}-${suffix}`,
    payload: { format: "x12", x12: withIsa13(fixture(x12Name), controlNumber) },
  };
}

/** The same mapper and agreement check used by M23's Stedi JSON dispatch path. */
function productionJsonSubmission(): ClearinghouseSubmission & {
  readonly jsonDocument: ReturnType<typeof buildStediClaimJson>;
} {
  const patientControlNumber = `WX${RUN_ID}`;
  const input = {
    ...CLAIM_INPUT,
    envelope: { ...CLAIM_INPUT.envelope, usage: "T" as const },
    claim: { ...CLAIM_INPUT.claim, controlNumber: patientControlNumber },
  };
  const x12 = build837iClaim(input);
  const document = buildStediClaimJson(input);
  const differences = compareStediClaimJsonToX12(document, x12);
  if (differences.length > 0) throw new Error("synthetic JSON/X12 mapper agreement failed");
  return {
    kind: "claim",
    controlNumber: patientControlNumber,
    idempotencyKey: `contract-json-${RUN_ID}`,
    payload: { format: "json", document },
    jsonDocument: document,
  };
}

function recordVendor(
  scenario: string,
  result: Awaited<ReturnType<StediTransport["submitClaim"]>>,
): void {
  const outcome = classifyVendorSubmission(
    scenario,
    result,
    (sentByScenario.get(scenario) ?? 0) > 0,
  );
  vendorScenarios.push(outcome);
}

function safeLiveFetch(): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const allowedPath =
      `${STEDI_PATH}/raw-x12-submission` === url.pathname ||
      `${STEDI_PATH}/submission` === url.pathname;
    if (
      url.origin !== STEDI_ORIGIN ||
      !allowedPath ||
      method !== "POST" ||
      init?.redirect !== "error" ||
      !body
    ) {
      throw new Error("Stedi contract network boundary refused an unexpected request");
    }
    if (url.pathname.endsWith("/raw-x12-submission")) {
      const x12 = body.x12;
      if (
        typeof x12 !== "string" ||
        tokenizeInterchange(x12).segments.find((s) => s[0] === "ISA")?.[15] !== "T"
      ) {
        throw new Error("Stedi contract network boundary refused non-Test X12");
      }
    } else if (body.usageIndicator !== "T") {
      throw new Error("Stedi contract network boundary refused non-Test JSON");
    }
    sentByScenario.set(currentScenario, (sentByScenario.get(currentScenario) ?? 0) + 1);
    return fetch(input, init);
  };
}

function localTransport() {
  let requests = 0;
  const transport = new StediTransport({
    apiKey: "local-only-never-sent",
    attempts: new InMemoryAttemptStore(),
    fetch: (async () => {
      requests += 1;
      throw new Error("local contract assertion attempted network access");
    }) as typeof fetch,
  });
  return { transport, requests: () => requests };
}

describe.skipIf(!RUN)("Stedi Test-mode vendor qualification (#727)", () => {
  it("records raw X12, production JSON 837I and NOE vendor outcomes without false PASS", async () => {
    const attempts = new InMemoryAttemptStore();
    const transport = new StediTransport({ apiKey: KEY ?? "", attempts, fetch: safeLiveFetch() });
    const rawClaim = submission("claim", "claim", "1");
    const jsonClaim = productionJsonSubmission();
    const noe = submission("noe", "NOE_81A", "2");

    for (const [name, x12Submission] of [
      ["raw_x12_claim", rawClaim],
      ["noe_81a", noe],
    ] as const) {
      currentScenario = name;
      const isa =
        x12Submission.payload.format === "x12"
          ? tokenizeInterchange(x12Submission.payload.x12).segments.find((s) => s[0] === "ISA")
          : undefined;
      const segments =
        x12Submission.payload.format === "x12"
          ? tokenizeInterchange(x12Submission.payload.x12).segments
          : [];
      const transaction = segments.find((s) => s[0] === "ST");
      const bht = segments.find((s) => s[0] === "BHT");
      const expectedBht06 = name === "raw_x12_claim" ? "CH" : "RP";
      const localEnvelopeValid =
        isa?.[13]?.trim() === x12Submission.controlNumber &&
        isa?.[15] === "T" &&
        transaction?.[1] === "837" &&
        bht?.[6] === expectedBht06;
      localScenarios.push(
        localScenario(
          `${name}_local_envelope`,
          localEnvelopeValid ? "PASS" : "FAIL",
          "isa13_isa15_st_837_and_bht06",
        ),
      );
      expect(localEnvelopeValid, `${name} local X12 safety validation`).toBe(true);
      const result =
        x12Submission.kind === "claim"
          ? await transport.submitClaim(CTX, x12Submission)
          : await transport.submitNotice(CTX, x12Submission);
      recordVendor(name, result);
    }

    currentScenario = "json_837i_claim";
    const document = jsonClaim.jsonDocument;
    const claimInformation = document.claimInformation;
    const billing = document.billing;
    localScenarios.push(
      localScenario(
        "json_837i_mapping_and_identity",
        document.usageIndicator === "T" &&
          billing?.npi === CTX.billingNpi &&
          claimInformation?.patientControlNumber === jsonClaim.controlNumber &&
          compareStediClaimJsonToX12(
            document,
            build837iClaim({
              ...CLAIM_INPUT,
              envelope: { ...CLAIM_INPUT.envelope, usage: "T" },
              claim: { ...CLAIM_INPUT.claim, controlNumber: jsonClaim.controlNumber },
            }),
          ).length === 0
          ? "PASS"
          : "FAIL",
        "production_mapper_json_x12_agreement_and_test_identity",
      ),
    );
    const jsonResult = await transport.submitClaim(CTX, jsonClaim);
    recordVendor("json_837i_claim", jsonResult);

    // Identical replay and changed-body conflict are local attempt-store behavior. They never prove vendor replay semantics.
    if (jsonResult.ok) {
      const sendsBeforeReplay = sentByScenario.get("json_837i_claim") ?? 0;
      const replay = await transport.submitClaim(CTX, jsonClaim);
      localScenarios.push(
        localScenario(
          "json_local_replay",
          replay.ok &&
            replay.data.replayed &&
            (sentByScenario.get("json_837i_claim") ?? 0) === sendsBeforeReplay
            ? "PASS"
            : "FAIL",
          "same_local_attempt_no_second_request",
        ),
      );
      const changed = {
        ...jsonClaim,
        payload: {
          format: "json" as const,
          document: {
            ...(jsonClaim.payload.format === "json"
              ? (jsonClaim.payload.document as Record<string, unknown>)
              : {}),
            changedSyntheticField: true,
          },
        },
      };
      const changedBody = await transport.submitClaim(CTX, changed);
      localScenarios.push(
        localScenario(
          "json_changed_body_same_key",
          !changedBody.ok && changedBody.degraded.code === CH.IDEMPOTENCY_CONFLICT
            ? "PASS"
            : "FAIL",
          "local_identity_conflict_without_vendor_replay_claim",
        ),
      );
      const reusedControlNumber = await transport.submitClaim(CTX, {
        ...jsonClaim,
        idempotencyKey: `contract-json-reused-${RUN_ID}`,
      });
      localScenarios.push(
        localScenario(
          "control_number_reuse_conflict",
          !reusedControlNumber.ok && reusedControlNumber.degraded.code === CH.IDEMPOTENCY_CONFLICT
            ? "PASS"
            : "FAIL",
          "control_number_reserved_locally",
        ),
      );
    } else {
      localScenarios.push(
        localScenario("json_local_replay", "NOT_RUN", "vendor_submission_did_not_succeed"),
        localScenario("json_changed_body_same_key", "NOT_RUN", "vendor_submission_did_not_succeed"),
        localScenario(
          "control_number_reuse_conflict",
          "NOT_RUN",
          "vendor_submission_did_not_succeed",
        ),
      );
    }

    const local = localTransport();
    const productionJson = {
      ...jsonClaim,
      idempotencyKey: `contract-json-production-${RUN_ID}`,
      payload: {
        format: "json" as const,
        document: {
          ...document,
          usageIndicator: "P",
          claimInformation: { ...claimInformation, patientControlNumber: `WP${RUN_ID}` },
        },
      },
    };
    const prodResult = await local.transport.submitClaim(CTX, productionJson);
    localScenarios.push(
      localScenario(
        "production_json_refused_before_request",
        !prodResult.ok && prodResult.degraded.code === CH.INVALID_REQUEST && local.requests() === 0
          ? "PASS"
          : "FAIL",
        "usage_mismatch_no_network",
        local.requests() > 0,
      ),
    );
    const wrongNpi = await local.transport.submitClaim(
      { ...CTX, billingNpi: "1000000004" },
      { ...jsonClaim, idempotencyKey: `contract-json-npi-${RUN_ID}` },
    );
    localScenarios.push(
      localScenario(
        "provider_identity_mismatch_refused_before_request",
        !wrongNpi.ok && wrongNpi.degraded.code === CH.INVALID_REQUEST && local.requests() === 0
          ? "PASS"
          : "FAIL",
        "billing_npi_mismatch_no_network",
        local.requests() > 0,
      ),
    );
    const malformed = await local.transport.submitClaim(CTX, {
      ...rawClaim,
      idempotencyKey: `contract-malformed-${RUN_ID}`,
      payload: { format: "x12", x12: "ISA*not-a-valid-interchange" },
    });
    localScenarios.push(
      localScenario(
        "malformed_x12_refused_before_request",
        !malformed.ok && malformed.degraded.code === CH.INVALID_REQUEST && local.requests() === 0
          ? "PASS"
          : "FAIL",
        "invalid_x12_no_network",
        local.requests() > 0,
      ),
    );
    const adjustment = await local.transport.submitClaim(CTX, {
      ...jsonClaim,
      idempotencyKey: `contract-adjustment-${RUN_ID}`,
      adjustment: { kind: "replacement", originalControlNumber: jsonClaim.controlNumber },
    });
    const voidAdjustment = await local.transport.submitClaim(CTX, {
      ...jsonClaim,
      idempotencyKey: `contract-void-${RUN_ID}`,
      adjustment: { kind: "void", originalControlNumber: jsonClaim.controlNumber },
    });
    localScenarios.push(
      localScenario(
        "frequency_7_replacement_refused_before_request",
        !adjustment.ok && adjustment.degraded.code === CH.INVALID_REQUEST && local.requests() === 0
          ? "PASS"
          : "FAIL",
        "adjustment_remains_fail_closed_pending_q17_q28",
        local.requests() > 0,
      ),
      localScenario(
        "frequency_8_void_refused_before_request",
        !voidAdjustment.ok &&
          voidAdjustment.degraded.code === CH.INVALID_REQUEST &&
          local.requests() === 0
          ? "PASS"
          : "FAIL",
        "adjustment_remains_fail_closed_pending_q17_q28",
        local.requests() > 0,
      ),
    );
    const notrControlNumber = `${RUN_ID.slice(0, 8)}3`;
    const notrTransport = new StediTransport({
      apiKey: "local-only-never-sent",
      attempts: new InMemoryAttemptStore(),
      fetch: (async () =>
        Response.json({ claimReference: { correlationId: "local-notr-receipt" } })) as typeof fetch,
    });
    const notr = await notrTransport.submitNotice(CTX, {
      kind: "notr",
      controlNumber: notrControlNumber,
      idempotencyKey: `contract-local-notr-${RUN_ID}`,
      payload: {
        format: "x12",
        x12: withIsa13(fixture("NOTR_81B"), notrControlNumber),
      },
    });
    const notrBht06 = tokenizeInterchange(
      withIsa13(fixture("NOTR_81B"), notrControlNumber),
    ).segments.find((s) => s[0] === "BHT")?.[6];
    localScenarios.push(
      localScenario(
        "notr_81b_local_transport_shape",
        notr.ok && notrBht06 === "RP" ? "PASS" : "FAIL",
        "fake_http_bht06_rp_vendor_behavior_not_verified",
      ),
    );

    const all = [...localScenarios, ...vendorScenarios];
    const summary = summarizeQualification(all, REQUIRED_VENDOR_SCENARIOS, true);
    const artifact = {
      schemaVersion: 1,
      runId: RUN_ID,
      executedAt: new Date().toISOString(),
      authorizationRef: gates.authorizationRef,
      vendorConfirmationRef: gates.vendorConfirmationRef,
      overallQualification: summary.overall,
      process: {
        runner: "vitest",
        exitCode: null,
        note: "final exit code is written by the wrapper after Vitest exits",
      },
      localAssertions: localScenarios,
      vendorObservations: vendorScenarios,
      requiredVendorScenarios: REQUIRED_VENDOR_SCENARIOS,
      responseRetrieval: { initial277ca: "NOT_RUN", payer277ca: "NOT_RUN", era835: "NOT_RUN" },
      liveSendingEnabled: false,
    };
    if (!RESULTS_FILE) throw new Error("result artifact path missing despite execution gates");
    writeFileSync(RESULTS_FILE, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
    expect(summary.overall, `vendor qualification outcome: ${summary.overall}`).toBe("PASS");
  });
});

describe("Stedi contract safety gating", () => {
  it("does not run the vendor suite unless every human and environment prerequisite is present", () => {
    expect(RUN).toBe(gates.ready);
    if (!RUN) expect(gates.reasonCodes.length).toBeGreaterThan(0);
  });
});
