import type { LicenseAttestation } from "./license";
// @chartwarden/terminology-loader — the ports the orchestrators run over. The loader package imports no database
// driver, queue or object-store client: the backend binds these to the `terminology_loader` SECURITY DEFINER
// functions (migration 0364), the platform MinIO bucket and BullMQ, and the unit tests bind them to in-memory
// fakes. Keeping the orchestration pure is what lets "failed load leaves no residue" be asserted without infra.
import type { LoadableSystemId, ParsedConcept } from "./types";

/** A `code_system_version` row as the loader sees it. */
export interface LoaderVersion {
  readonly id: string;
  readonly system: LoadableSystemId;
  readonly version: string;
  readonly status: "loading" | "staged" | "active" | "superseded" | "failed";
  readonly sourceFileRef: string;
  readonly checksum: string;
  readonly effectiveFrom: string;
  readonly releasedOn: string;
}

/** Counts the staging step reports (diff vs. the prior active version). */
export interface StageSummary {
  readonly concepts: number;
  readonly newCodes: number;
  readonly retiredCodes: number;
  readonly changedDisplays: number;
}

/** What activation reports. */
export interface ActivationSummary {
  readonly concepts: number;
  readonly newCodes: number;
  readonly retiredCodes: number;
  readonly deprecations: number;
  readonly supersededVersionId: string | null;
}

/** One staged row. `kind` 'deprecation' rows carry successor detail for a code the new version retires. */
export interface StagedRow {
  readonly code: string;
  readonly display: string;
  readonly status: ParsedConcept["status"];
  readonly effectiveDate: string | null;
  readonly endDate: string | null;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** A current concept of the active version, for the deprecation diff (ICD-10-CM billable → header). */
export interface PriorConcept {
  readonly code: string;
  readonly display: string;
  readonly isBillableLeaf: boolean;
}

/** The data port over the `terminology_loader` write door + chartwarden_app reads. */
export interface LoaderStorePort {
  getVersion(versionId: string): Promise<LoaderVersion | null>;
  /** Insert a chunk into staging; `reset` clears this version's staging first (a restart from `loading`). */
  stageRows(
    versionId: string,
    kind: "concept" | "deprecation",
    rows: readonly StagedRow[],
    reset: boolean,
  ): Promise<number>;
  /** Verify the staged count, compute the diff vs the prior active version, move `loading → staged`. */
  markStaged(versionId: string, expectedConcepts: number): Promise<StageSummary>;
  /** Atomically copy staging into the concept table, supersede the prior version, map deprecations, go `active`. */
  activate(versionId: string, activatedBy: string | null): Promise<ActivationSummary>;
  /** Delete staging, mark `failed`, ledger the (content-free) reason. Never touches an activated version. */
  fail(versionId: string, reason: string): Promise<void>;
  /** The active version's concepts (ICD-10-CM only, for header-transition successors). */
  listActiveConcepts(
    system: LoadableSystemId,
    excludeVersionId: string,
  ): Promise<readonly PriorConcept[]>;
  /** The newest version of `system` in any state (scheduled loads use its checksum to skip unchanged sources). */
  latestVersion(system: LoadableSystemId): Promise<LoaderVersion | null>;
  /** The newest `staged` version of `system` (the Oct 1 ICD-10-CM activation resumes it). */
  latestStagedVersion(system: LoadableSystemId): Promise<LoaderVersion | null>;
  /** License attestations for a system (all, including expired/revoked — the pure gate decides). */
  licenseAttestations(system: LoadableSystemId): Promise<readonly LicenseAttestation[]>;
  /** The `code_system.license_source` for a system. */
  licenseSource(system: LoadableSystemId): Promise<string>;
  registerVersion(input: {
    readonly system: LoadableSystemId;
    readonly version: string;
    readonly sourceFileRef: string;
    readonly checksum: string;
    readonly releasedOn: string;
    readonly effectiveFrom: string;
    readonly loadedBy: string | null;
  }): Promise<{ readonly versionId: string; readonly created: boolean; readonly status: string }>;
}

/** Reads/writes the PLATFORM bucket (never a tenant bucket). `read` throws {@link SourceNotFoundError} on 404. */
export interface PlatformObjectPort {
  read(objectKey: string): Promise<Uint8Array>;
  write(objectKey: string, bytes: Uint8Array): Promise<void>;
}

/** Enqueues the follow-up jobs a successful activation owes. Deduplicated by job id. */
export interface FollowUpPort {
  enqueueRefreshExpansions(system: LoadableSystemId, versionId: string): Promise<void>;
  enqueueRefreshEmbeddings(system: LoadableSystemId, versionId: string): Promise<void>;
  enqueueTenantDeprecationScan(
    system: LoadableSystemId,
    versionId: string,
    effectiveFrom: string,
  ): Promise<void>;
  enqueueLoadVersion(versionId: string, activate: boolean): Promise<void>;
}

/** Minimal structured logger (pino-compatible). Never receives source content. */
export interface LoaderLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** A logger that discards everything (tests). */
export const SILENT_LOGGER: LoaderLogger = { info() {}, warn() {}, error() {} };
