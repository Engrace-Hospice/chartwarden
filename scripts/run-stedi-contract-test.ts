#!/usr/bin/env bun
/** Runs the explicitly gated vendor contract and finalizes its artifact with Vitest's actual exit status. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contractRunGates } from "../packages/x12-837-client/src/clearinghouse/stedi-contract-qualification";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputPath = resolve(
  process.env.STEDI_CONTRACT_RESULTS_FILE?.trim() || `/tmp/stedi-contract-results-${stamp}.json`,
);
const partialPath = `${outputPath}.${process.pid}.partial`;
const gates = contractRunGates({
  ...process.env,
  STEDI_CONTRACT_RUNNER: "dedicated-command",
  STEDI_CONTRACT_RESULTS_FILE: process.env.STEDI_CONTRACT_RESULTS_FILE?.trim()
    ? outputPath
    : undefined,
});

function writeArtifact(value: Record<string, unknown>): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const key = process.env.STEDI_TEST_API_KEY?.trim();
  if (key && serialized.includes(key)) throw new Error("contract artifact contains a credential");
  writeFileSync(outputPath, serialized, { mode: 0o600 });
}

if (!gates.ready) {
  const artifact = {
    schemaVersion: 1,
    runId: `not-run-${stamp}`,
    executedAt: new Date().toISOString(),
    authorizationRef: gates.authorizationRef,
    vendorConfirmationRef: gates.vendorConfirmationRef,
    overallQualification: "NOT_RUN",
    gateReasonCodes: gates.reasonCodes,
    process: { runner: "vitest", exitCode: null, wrapperExitCode: 2 },
    localAssertions: [],
    vendorObservations: [],
    requiredVendorScenarios: ["raw_x12_claim", "json_837i_claim", "noe_81a"],
    responseRetrieval: { initial277ca: "NOT_RUN", payer277ca: "NOT_RUN", era835: "NOT_RUN" },
    liveSendingEnabled: false,
  };
  writeArtifact(artifact);
  process.stderr.write(`Stedi contract NOT_RUN; see sanitized artifact: ${outputPath}\n`);
  process.exitCode = 2;
} else {
  const env = {
    ...process.env,
    STEDI_CONTRACT_RUNNER: "dedicated-command",
    STEDI_CONTRACT_RESULTS_FILE: partialPath,
  };
  const command = spawnSync(
    process.execPath,
    [
      "run",
      "vitest",
      "run",
      "packages/x12-837-client/src/clearinghouse/stedi-sandbox-contract.test.ts",
    ],
    { cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."), env, stdio: "inherit" },
  );
  const vitestExitCode = command.status;
  let partial: Record<string, unknown> | null = null;
  try {
    if (existsSync(partialPath))
      partial = JSON.parse(readFileSync(partialPath, "utf8")) as Record<string, unknown>;
  } catch {
    partial = null;
  } finally {
    if (existsSync(partialPath)) rmSync(partialPath, { force: true });
  }

  const testOutcome =
    typeof partial?.overallQualification === "string"
      ? partial.overallQualification
      : vitestExitCode === 0
        ? "NOT_RUN"
        : "FAIL";
  const overall =
    vitestExitCode === 0 && testOutcome === "PASS"
      ? "PASS"
      : testOutcome === "PASS"
        ? "FAIL"
        : testOutcome;
  const artifact = {
    ...(partial ?? {
      schemaVersion: 1,
      runId: `failed-${stamp}`,
      executedAt: new Date().toISOString(),
      authorizationRef: gates.authorizationRef,
      vendorConfirmationRef: gates.vendorConfirmationRef,
      localAssertions: [],
      vendorObservations: [],
      requiredVendorScenarios: ["raw_x12_claim", "json_837i_claim", "noe_81a"],
      responseRetrieval: { initial277ca: "NOT_RUN", payer277ca: "NOT_RUN", era835: "NOT_RUN" },
      liveSendingEnabled: false,
    }),
    overallQualification: overall,
    process: {
      runner: "vitest",
      exitCode: vitestExitCode,
      signal: command.signal,
      wrapperExitCode:
        overall === "PASS" ? 0 : vitestExitCode && vitestExitCode > 0 ? vitestExitCode : 2,
    },
  };
  writeArtifact(artifact);
  process.stderr.write(
    `Stedi contract ${overall}; Vitest exit=${vitestExitCode}; sanitized artifact: ${outputPath}\n`,
  );
  process.exitCode = artifact.process.wrapperExitCode as number;
}
