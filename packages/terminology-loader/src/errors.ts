// @wardenx/terminology-loader — error taxonomy. The orchestrator marks a version `failed` for a
// {@link LoaderDataError} (a deterministic fault in the source or the request: retrying cannot help) and
// RETHROWS everything else so BullMQ retries it (a Valkey/Postgres/object-store blip must not fail a version).

/** A deterministic, non-retryable fault. `code` is a stable machine token; `message` never carries row content. */
export class LoaderDataError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "LoaderDataError";
  }
}

/** The registered `sourceFileRef` does not exist in the platform bucket. */
export class SourceNotFoundError extends LoaderDataError {
  constructor(ref: string) {
    super("SOURCE_NOT_FOUND", `no object at source reference '${ref}'`);
  }
}

/** A licensed source was requested without a configured credential (fail-closed seam). */
export class LicensedSourceCredentialMissingError extends Error {
  constructor(readonly system: string) {
    super(`LICENSED_SOURCE_CREDENTIAL_MISSING: no credential configured for '${system}'`);
    this.name = "LicensedSourceCredentialMissingError";
  }
}

/** Egress for public sources is disabled (the flag is off). */
export class EgressDisabledError extends Error {
  constructor() {
    super(
      "EGRESS_DISABLED: TERMINOLOGY_LOADER_EGRESS is not 'on'; upload the release file instead",
    );
    this.name = "EgressDisabledError";
  }
}

/** True for a deterministic fault that should fail the version rather than retry the job. */
export function isDataError(err: unknown): err is LoaderDataError {
  return err instanceof LoaderDataError;
}

/** A short, content-free reason string safe for the ledger (never more than `max` chars). */
export function reasonOf(err: unknown, max = 500): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
