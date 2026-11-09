// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/fingerprint-key-check.ts — what the boot credential check
// (`checkHeldCredentials`) found, said to ops, and the gate that refuses credential saves while it is not known to be complete.
//
// The gate is fail-closed: until a check has run and found every held key id configured, a save that carries a credential gets a
// typed 503. A reservation under an unconfigured key no longer collides with anything, so a save could seal a credential another
// organization holds under that key. A check that failed or has not finished counts as incomplete.
import { ChartWardenError } from "@chartwarden/types";
import { safeErrorMessage } from "../../../bootstrap/redact-database-error";
import { RETIRED_FINGERPRINT_KEYS_ENV } from "./secret-cipher";

/** What the boot check counts (ids and counts only, never a fingerprint or an organization). */
export interface CredentialCheckResult {
  /** Unreleased reservations of one of the platform's own vendor keys. */
  readonly held: number;
  /** The distinct non-NULL key ids unreleased reservations were computed under. */
  readonly keyIds: readonly string[];
  /** Unreleased reservations with a NULL key id (recorded before migration 1436, or re-reserved unopenable): unverifiable. */
  readonly unverifiable: number;
}

export interface CheckLog {
  error(obj: object, msg: string): void;
}

/** The held key ids that are neither the current fingerprint key nor a configured retired one (ids only, never keys). */
export const unknownFingerprintKeyIds = (
  held: readonly string[],
  configured: readonly string[],
): string[] => held.filter((id) => !configured.includes(id));

/**
 * Log what the check found, each at error. True when every held key id is configured (NULL key ids cannot be checked, so they are
 * logged and do not block: a pre-1436 row is under the KEK current then, and the runbook lists them).
 */
export function reportCredentialCheck(
  result: CredentialCheckResult,
  configuredKeyIds: readonly string[],
  log: CheckLog,
): boolean {
  if (result.held > 0)
    log.error(
      { code: "M23_PLATFORM_CREDENTIAL_HELD_BY_TENANT", held: result.held },
      "m23.clearinghouse: a platform vendor key (CLAIMMD_ACCOUNT_KEY / STEDI_API_KEY) is also sealed by a tenant; give the platform its own account key",
    );
  if (result.unverifiable > 0)
    log.error(
      { code: "M23_FINGERPRINT_KEY_UNVERIFIABLE", count: result.unverifiable },
      "m23.clearinghouse: credentials are reserved with no fingerprint key id (recorded before migration 1436), so the check cannot tell whether their key is still configured (ops runbook §8.3)",
    );
  const unknown = unknownFingerprintKeyIds(result.keyIds, configuredKeyIds);
  if (unknown.length > 0)
    log.error(
      { code: "M23_FINGERPRINT_KEY_UNCONFIGURED", keyIds: unknown },
      `m23.clearinghouse: credentials are reserved under a fingerprint key that is neither current nor retired, so they no longer block reuse, and credential saves are refused until it is configured; list the old KEK's derived subkey in ${RETIRED_FINGERPRINT_KEYS_ENV} (ops runbook §8.3)`,
    );
  return unknown.length === 0;
}

/** How long a refused save waits before the check runs again (each run is an audited cross-tenant platform read). */
export const FINGERPRINT_RECHECK_MS = 60_000;

export const fingerprintKeysIncomplete = (): ChartWardenError =>
  new ChartWardenError(
    "CLEARINGHOUSE_FINGERPRINT_KEYS_INCOMPLETE",
    "clearinghouse credentials cannot be saved right now: the deployment's credential fingerprint keys are not confirmed complete; ask platform support",
    503,
  );

export interface FingerprintKeyGate {
  /** Run the check now (boot). Never throws: a failed run is logged and leaves the gate closed. */
  evaluate(): Promise<void>;
  /** Throws the typed 503 unless a check found every held key id configured; re-runs a stale incomplete result first. */
  assertComplete(): Promise<void>;
}

/**
 * ponytail: a complete result is sticky for the process (the configured keys change only with a restart); a deployment whose
 * instances run different key sets would need a per-request check.
 */
export function createFingerprintKeyGate(opts: {
  readonly run: () => Promise<CredentialCheckResult>;
  readonly configuredKeyIds: readonly string[];
  readonly log: CheckLog;
  readonly now?: () => number;
}): FingerprintKeyGate {
  const now = opts.now ?? Date.now;
  let complete = false;
  let lastRunAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;

  const evaluate = (): Promise<void> => {
    inflight ??= opts
      .run()
      .then((result) => {
        complete = reportCredentialCheck(result, opts.configuredKeyIds, opts.log);
      })
      .catch((err: unknown) => {
        complete = false;
        // error, not warn: a check that silently stops running (missing column grant, failed bypass audit) is a lost control.
        // The raw error is NOT logged: this query's bound parameters are credential fingerprints, and a failing query's error
        // carries them in its message, its `params` and its stack. The name and the redacted message keep what diagnoses it
        // (the SQLSTATE, the table, the constraint) and drop every value.
        opts.log.error(
          {
            errName: err instanceof Error ? err.name : typeof err,
            error: safeErrorMessage(err),
            code: "M23_PLATFORM_CREDENTIAL_CHECK_FAILED",
          },
          "m23.clearinghouse: the platform credential check failed; credential saves are refused until it succeeds",
        );
      })
      .finally(() => {
        lastRunAt = now();
        inflight = null;
      });
    return inflight;
  };

  return {
    evaluate,
    async assertComplete() {
      if (complete) return;
      if (inflight) await inflight;
      else if (now() - lastRunAt >= FINGERPRINT_RECHECK_MS) await evaluate();
      if (!complete) throw fingerprintKeysIncomplete();
    },
  };
}
