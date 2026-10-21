// @chartwarden/terminology-loader — the five `terminology.scheduled_*` jobs' shared logic (M38 §4.3).
//
//   fetch (adapter) → sha256 → store in the PLATFORM bucket → register version → enqueue `load_version`
//
// Every refusal is a returned `skipped` outcome with a reason, never a thrown error and never a silent success:
//   egress_disabled              tier-1 adapter, TERMINOLOGY_LOADER_EGRESS is not 'on'
//   no_adapter                   no fetch adapter exists for the system (HCPCS, ICD-10-PCS, CARC, RARC): upload only
//   license_<REASON>             tier-2 system without an active attestation
//   credentials_not_configured   tier-2 system, attestation present, but the credential seam is the deny-stub
//   no_new_release | unchanged   nothing to load
// Idempotent: a re-run with an unchanged source is `unchanged`; a re-registered (system, version) re-drives a stuck load.
import { sha256Hex } from "./bytes";
import { LicensedSourceCredentialMissingError } from "./errors";
import { evaluateLicenseGate } from "./license";
import type { FollowUpPort, LoaderLogger, LoaderStorePort, PlatformObjectPort } from "./ports";
import type { FetchContext, FetchedSource, PublicSourceAdapter } from "./sources/adapter";
import {
  type LicensedSourceFetcher,
  type LicensedSystemId,
  credentialRequirement,
} from "./sources/licensed";
import type { LoadableSystemId } from "./types";

export interface ScheduledSourceDeps {
  readonly store: LoaderStorePort;
  readonly objects: PlatformObjectPort;
  readonly followUps: FollowUpPort;
  readonly log: LoaderLogger;
  readonly now: () => Date;
  readonly fetchImpl: typeof fetch;
  /** `TERMINOLOGY_LOADER_EGRESS === "on"`. */
  readonly egressEnabled: boolean;
  readonly publicAdapters: Readonly<Partial<Record<LoadableSystemId, PublicSourceAdapter>>>;
  readonly licensed: LicensedSourceFetcher;
}

export interface ScheduledRunOptions {
  readonly mode: FetchContext["mode"];
  /** false = stage only (the Sep 15 ICD-10-CM dry run). */
  readonly activate: boolean;
}

export type ScheduledOutcome =
  | { readonly outcome: "enqueued"; readonly versionId: string; readonly version: string }
  | { readonly outcome: "skipped"; readonly reason: string };

const skipped = (reason: string): ScheduledOutcome => ({ outcome: "skipped", reason });
const LICENSED = new Set<string>(["snomed", "rxnorm", "loinc"]);

async function fetchRelease(
  deps: ScheduledSourceDeps,
  system: LoadableSystemId,
  ctx: FetchContext,
): Promise<FetchedSource | ScheduledOutcome | null> {
  if (LICENSED.has(system)) {
    const [source, attestations] = await Promise.all([
      deps.store.licenseSource(system),
      deps.store.licenseAttestations(system),
    ]);
    const verdict = evaluateLicenseGate(
      system,
      source,
      attestations,
      ctx.now.toISOString().slice(0, 10),
    );
    if (!verdict.allowed) return skipped(`license_${verdict.reason}`);
    try {
      return await deps.licensed.fetchLatest(system as LicensedSystemId, ctx);
    } catch (err) {
      if (!(err instanceof LicensedSourceCredentialMissingError)) throw err;
      deps.log.warn(
        { system, requirement: credentialRequirement(system as LicensedSystemId) },
        "licensed source credential not configured",
      );
      return skipped("credentials_not_configured");
    }
  }
  const adapter = deps.publicAdapters[system];
  if (!adapter) return skipped("no_adapter");
  if (adapter.egress && !deps.egressEnabled) return skipped("egress_disabled");
  return adapter.fetchLatest(ctx);
}

const isOutcome = (v: FetchedSource | ScheduledOutcome | null): v is ScheduledOutcome =>
  v !== null && "outcome" in v;

/** Run one scheduled source fetch for `system`. */
export async function runScheduledSource(
  deps: ScheduledSourceDeps,
  system: LoadableSystemId,
  opts: ScheduledRunOptions,
): Promise<ScheduledOutcome> {
  const ctx: FetchContext = { now: deps.now(), fetchImpl: deps.fetchImpl, mode: opts.mode };
  const fetched = await fetchRelease(deps, system, ctx);
  if (isOutcome(fetched)) return fetched;
  if (fetched === null) return skipped("no_new_release");

  const checksum = sha256Hex(fetched.bytes);
  const latest = await deps.store.latestVersion(system);
  if (latest && latest.checksum === checksum && latest.status !== "failed")
    return skipped("unchanged");

  const objectKey = `terminology/${system}/${fetched.version}/${checksum}`;
  await deps.objects.write(objectKey, fetched.bytes);
  const reg = await deps.store.registerVersion({
    system,
    version: fetched.version,
    sourceFileRef: objectKey,
    checksum,
    releasedOn: fetched.releasedOn,
    effectiveFrom: fetched.effectiveFrom,
    loadedBy: null,
  });
  if (!reg.created) {
    if (reg.status === "loading" || reg.status === "staged") {
      await deps.followUps.enqueueLoadVersion(reg.versionId, opts.activate);
      return { outcome: "enqueued", versionId: reg.versionId, version: fetched.version };
    }
    return skipped("already_registered");
  }
  await deps.followUps.enqueueLoadVersion(reg.versionId, opts.activate);
  deps.log.info(
    { system, versionId: reg.versionId, version: fetched.version, origin: fetched.origin },
    "scheduled terminology source registered",
  );
  return { outcome: "enqueued", versionId: reg.versionId, version: fetched.version };
}

/** The Oct 1 ICD-10-CM activation: resume the version the Sep 15 dry run left `staged`. */
export async function runScheduledActivation(
  deps: Pick<ScheduledSourceDeps, "store" | "followUps" | "log">,
  system: LoadableSystemId,
): Promise<ScheduledOutcome> {
  const staged = await deps.store.latestStagedVersion(system);
  if (!staged) return skipped("nothing_staged");
  await deps.followUps.enqueueLoadVersion(staged.id, true);
  deps.log.info(
    { system, versionId: staged.id },
    "staged terminology version queued for activation",
  );
  return { outcome: "enqueued", versionId: staged.id, version: staged.version };
}
