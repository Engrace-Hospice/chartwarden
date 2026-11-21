export type M23TargetModuleDiagnostic = {
  targetModuleEvaluated: true;
  isolatedMarkerState: "missing" | "true" | "false" | "malformed";
  isolatedMarkerPresent: boolean;
  isolatedMarkerEqualsTrue: boolean;
  privateDatabaseUrlPresent: boolean;
  clusterIdentityMarkersPresent: boolean;
  clusterIdentityMarkersWellFormed: boolean;
  moduleGuardDecision:
    | "guard_allows_suite_registration"
    | "guard_skips_suite"
    | "refuses_missing_database_url";
};

/** Returns only safe, allowlisted facts about the exact M23 test module environment. */
export function inspectM23TargetModuleEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): M23TargetModuleDiagnostic {
  const marker = environment.CHARTWARDEN_M23_RLS_ISOLATED_RUN;
  const markerState =
    marker === undefined
      ? "missing"
      : marker === "true"
        ? "true"
        : marker === "false"
          ? "false"
          : "malformed";
  const isolatedMarkerEqualsTrue = marker === "true";
  const privateDatabaseUrlPresent = Boolean(environment.CHARTWARDEN_TEST_DATABASE_URL);
  const clusterId = environment.CHARTWARDEN_TEST_CLUSTER_ID;
  const systemIdentifier = environment.CHARTWARDEN_TEST_CLUSTER_SYSTEM_IDENTIFIER;
  const clusterIdentityMarkersPresent = Boolean(clusterId && systemIdentifier);

  return {
    targetModuleEvaluated: true,
    isolatedMarkerState: markerState,
    isolatedMarkerPresent: marker !== undefined,
    isolatedMarkerEqualsTrue,
    privateDatabaseUrlPresent,
    clusterIdentityMarkersPresent,
    clusterIdentityMarkersWellFormed:
      /^chartwarden-m23-[a-f0-9]{32}$/.test(clusterId ?? "") &&
      /^\d+$/.test(systemIdentifier ?? ""),
    moduleGuardDecision: !isolatedMarkerEqualsTrue
      ? "guard_skips_suite"
      : privateDatabaseUrlPresent
        ? "guard_allows_suite_registration"
        : "refuses_missing_database_url",
  };
}

export type M23CollectedTest = {
  name?: unknown;
  file?: unknown;
  projectName?: unknown;
};

/** Rejects static/incorrect collection, wrong projects, and unexpected suite drift. */
export function validateM23DynamicCollection(input: {
  tests: readonly M23CollectedTest[];
  expectedFile: string;
  expectedProject: string;
  expectedNames: readonly string[];
}): void {
  const expectedFile = input.expectedFile;
  if (input.tests.length !== input.expectedNames.length) {
    throw new Error("M23 dynamic collection did not find the expected registered assertion count");
  }
  if (
    input.tests.some(
      (test) =>
        typeof test.name !== "string" ||
        test.name.length === 0 ||
        test.file !== expectedFile ||
        test.projectName !== input.expectedProject,
    )
  ) {
    throw new Error("M23 dynamic collection resolved an unexpected file or Vitest project");
  }
  const names = input.tests.map((test) => test.name as string);
  if (new Set(names).size !== names.length) {
    throw new Error("M23 dynamic collection contains duplicate assertion names");
  }
  const expectedNames = [...input.expectedNames].sort();
  if ([...names].sort().some((name, index) => name !== expectedNames[index])) {
    throw new Error("M23 dynamic collection did not match the expected registered assertions");
  }
}

export const M23_TARGET_DIAGNOSTIC_PREFIX = "CHARTWARDEN_M23_TARGET_MODULE_DIAGNOSTIC ";

export function parseM23TargetModuleDiagnostic(output: string): M23TargetModuleDiagnostic {
  const diagnosticLines = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith(M23_TARGET_DIAGNOSTIC_PREFIX));
  if (diagnosticLines.length !== 1) {
    throw new Error("M23 target-module diagnostic was missing or ambiguous");
  }
  return parseM23TargetModuleDiagnosticJson(
    diagnosticLines[0]!.slice(M23_TARGET_DIAGNOSTIC_PREFIX.length),
  );
}

export function parseM23TargetModuleDiagnosticJson(contents: string): M23TargetModuleDiagnostic {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("M23 target-module diagnostic was not valid JSON");
  }
  if (!value || typeof value !== "object") {
    throw new Error("M23 target-module diagnostic had an invalid shape");
  }
  const diagnostic = value as Partial<M23TargetModuleDiagnostic>;
  if (
    diagnostic.targetModuleEvaluated !== true ||
    !["missing", "true", "false", "malformed"].includes(diagnostic.isolatedMarkerState as string) ||
    typeof diagnostic.isolatedMarkerPresent !== "boolean" ||
    typeof diagnostic.isolatedMarkerEqualsTrue !== "boolean" ||
    typeof diagnostic.privateDatabaseUrlPresent !== "boolean" ||
    typeof diagnostic.clusterIdentityMarkersPresent !== "boolean" ||
    typeof diagnostic.clusterIdentityMarkersWellFormed !== "boolean" ||
    ![
      "guard_allows_suite_registration",
      "guard_skips_suite",
      "refuses_missing_database_url",
    ].includes(diagnostic.moduleGuardDecision as string)
  ) {
    throw new Error("M23 target-module diagnostic had an invalid shape");
  }
  return {
    targetModuleEvaluated: true,
    isolatedMarkerState:
      diagnostic.isolatedMarkerState as M23TargetModuleDiagnostic["isolatedMarkerState"],
    isolatedMarkerPresent: diagnostic.isolatedMarkerPresent,
    isolatedMarkerEqualsTrue: diagnostic.isolatedMarkerEqualsTrue,
    privateDatabaseUrlPresent: diagnostic.privateDatabaseUrlPresent,
    clusterIdentityMarkersPresent: diagnostic.clusterIdentityMarkersPresent,
    clusterIdentityMarkersWellFormed: diagnostic.clusterIdentityMarkersWellFormed,
    moduleGuardDecision:
      diagnostic.moduleGuardDecision as M23TargetModuleDiagnostic["moduleGuardDecision"],
  };
}

/** Validates the module's explicit guard and identity inputs, not Vitest's collected task mode. */
export function isM23TargetModuleEnvironmentSafe(diagnostic: M23TargetModuleDiagnostic): boolean {
  return (
    diagnostic.targetModuleEvaluated &&
    diagnostic.isolatedMarkerState === "true" &&
    diagnostic.isolatedMarkerPresent &&
    diagnostic.isolatedMarkerEqualsTrue &&
    diagnostic.privateDatabaseUrlPresent &&
    diagnostic.clusterIdentityMarkersPresent &&
    diagnostic.clusterIdentityMarkersWellFormed &&
    diagnostic.moduleGuardDecision === "guard_allows_suite_registration"
  );
}
