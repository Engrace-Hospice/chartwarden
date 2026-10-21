// @chartwarden/terminology-loader — deterministic in-memory ports (the unit tests' and route tests' stand-ins). The
// store mirrors the database state machine closely enough to assert the loader's guarantees without infra:
// staging is separate from the concept table, `fail` deletes staging, activation supersedes the prior version.
import { SourceNotFoundError } from "./errors";
import type { LicenseAttestation } from "./license";
import type {
  ActivationSummary,
  FollowUpPort,
  LoaderStorePort,
  LoaderVersion,
  PlatformObjectPort,
  PriorConcept,
  StageSummary,
  StagedRow,
} from "./ports";
import type { LoadableSystemId } from "./types";

export interface InMemoryLoaderStore {
  readonly port: LoaderStorePort;
  /** Staged rows by version id. */
  readonly staging: Map<string, { concept: StagedRow[]; deprecation: StagedRow[] }>;
  /** Activated concept rows by version id. */
  readonly concepts: Map<string, StagedRow[]>;
  readonly versions: Map<string, LoaderVersion>;
  readonly failures: { versionId: string; reason: string }[];
  readonly deprecations: { versionId: string; code: string }[];
  addAttestation(a: LicenseAttestation): void;
}

let seq = 0;

/** Build an in-memory {@link LoaderStorePort}. */
export function createInMemoryLoaderStore(
  seed: {
    readonly licenseSources?: Partial<Record<LoadableSystemId, string>>;
  } = {},
): InMemoryLoaderStore {
  const versions = new Map<string, LoaderVersion>();
  const staging = new Map<string, { concept: StagedRow[]; deprecation: StagedRow[] }>();
  const concepts = new Map<string, StagedRow[]>();
  const failures: { versionId: string; reason: string }[] = [];
  const deprecations: { versionId: string; code: string }[] = [];
  const attestations: LicenseAttestation[] = [];
  const set = (v: LoaderVersion, status: LoaderVersion["status"]): void => {
    versions.set(v.id, { ...v, status });
  };
  const activeOf = (system: LoadableSystemId, except: string): LoaderVersion | undefined =>
    [...versions.values()].find(
      (v) => v.system === system && v.status === "active" && v.id !== except,
    );

  const port: LoaderStorePort = {
    async getVersion(id) {
      return versions.get(id) ?? null;
    },
    async stageRows(id, kind, rows, reset) {
      const s = staging.get(id) ?? { concept: [], deprecation: [] };
      if (reset) {
        s.concept = [];
        s.deprecation = [];
      }
      s[kind].push(...rows);
      staging.set(id, s);
      return rows.length;
    },
    async markStaged(id, expected) {
      const v = versions.get(id) as LoaderVersion;
      const s = staging.get(id) ?? { concept: [], deprecation: [] };
      if (s.concept.length !== expected) throw new Error("staging count mismatch");
      const prior = activeOf(v.system, id);
      const priorRows = prior ? (concepts.get(prior.id) ?? []) : [];
      const priorCodes = new Map(priorRows.map((r) => [r.code, r.display]));
      const nextCodes = new Map(s.concept.map((r) => [r.code, r.display]));
      set(v, "staged");
      return {
        concepts: s.concept.length,
        newCodes: [...nextCodes.keys()].filter((c) => !priorCodes.has(c)).length,
        retiredCodes: [...priorCodes.keys()].filter((c) => !nextCodes.has(c)).length,
        changedDisplays: [...nextCodes].filter(
          ([c, d]) => priorCodes.has(c) && priorCodes.get(c) !== d,
        ).length,
      } satisfies StageSummary;
    },
    async activate(id) {
      const v = versions.get(id) as LoaderVersion;
      const s = staging.get(id) ?? { concept: [], deprecation: [] };
      const prior = activeOf(v.system, id);
      const priorRows = prior ? (concepts.get(prior.id) ?? []) : [];
      const nextCodes = new Set(s.concept.map((r) => r.code));
      const retired = new Set([
        ...priorRows.filter((r) => !nextCodes.has(r.code)).map((r) => r.code),
        ...s.deprecation.map((r) => r.code),
      ]);
      for (const code of retired) deprecations.push({ versionId: id, code });
      concepts.set(id, s.concept);
      if (prior) set(prior, "superseded");
      set(v, "active");
      staging.delete(id);
      const priorCodes = new Set(priorRows.map((r) => r.code));
      return {
        concepts: s.concept.length,
        newCodes: s.concept.filter((r) => !priorCodes.has(r.code)).length,
        retiredCodes: retired.size,
        deprecations: retired.size,
        supersededVersionId: prior?.id ?? null,
      } satisfies ActivationSummary;
    },
    async fail(id, reason) {
      staging.delete(id);
      const v = versions.get(id);
      if (v) set(v, "failed");
      failures.push({ versionId: id, reason });
    },
    async listActiveConcepts(system, exclude): Promise<readonly PriorConcept[]> {
      const prior = activeOf(system, exclude);
      return (prior ? (concepts.get(prior.id) ?? []) : []).map((r) => ({
        code: r.code,
        display: r.display,
        isBillableLeaf: r.properties.isBillableLeaf === true,
      }));
    },
    async latestVersion(system) {
      return (
        [...versions.values()]
          .filter((v) => v.system === system)
          .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] ?? null
      );
    },
    async latestStagedVersion(system) {
      return (
        [...versions.values()].find((v) => v.system === system && v.status === "staged") ?? null
      );
    },
    async licenseAttestations(system) {
      return attestations.filter((a) => a.system === system);
    },
    async licenseSource(system) {
      return seed.licenseSources?.[system] ?? "public";
    },
    async registerVersion(input) {
      const existing = [...versions.values()].find(
        (v) => v.system === input.system && v.version === input.version,
      );
      if (existing) {
        if (existing.status === "failed") {
          versions.set(existing.id, {
            ...existing,
            status: "loading",
            sourceFileRef: input.sourceFileRef,
            checksum: input.checksum,
          });
          return { versionId: existing.id, created: true, status: "loading" };
        }
        return { versionId: existing.id, created: false, status: existing.status };
      }
      seq += 1;
      const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
      versions.set(id, {
        id,
        system: input.system,
        version: input.version,
        status: "loading",
        sourceFileRef: input.sourceFileRef,
        checksum: input.checksum,
        effectiveFrom: input.effectiveFrom,
        releasedOn: input.releasedOn,
      });
      return { versionId: id, created: true, status: "loading" };
    },
  };
  return {
    port,
    staging,
    concepts,
    versions,
    failures,
    deprecations,
    addAttestation: (a) => void attestations.push(a),
  };
}

/** An in-memory platform bucket. */
export function createInMemoryObjects(
  initial: Record<string, Uint8Array> = {},
): PlatformObjectPort & {
  readonly objects: Map<string, Uint8Array>;
  reads: string[];
} {
  const objects = new Map(Object.entries(initial));
  const reads: string[] = [];
  return {
    objects,
    reads,
    async read(key) {
      reads.push(key);
      const bytes = objects.get(key);
      if (!bytes) throw new SourceNotFoundError(key);
      return bytes;
    },
    async write(key, bytes) {
      objects.set(key, bytes);
    },
  };
}

/** A recording {@link FollowUpPort}. */
export function createRecordingFollowUps(): FollowUpPort & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async enqueueRefreshExpansions(system, versionId) {
      calls.push(`expansions:${system}:${versionId}`);
    },
    async enqueueRefreshEmbeddings(system, versionId) {
      calls.push(`embeddings:${system}:${versionId}`);
    },
    async enqueueTenantDeprecationScan(system, versionId) {
      calls.push(`scan:${system}:${versionId}`);
    },
    async enqueueLoadVersion(versionId, activate) {
      calls.push(`load:${versionId}:${activate}`);
    },
  };
}
