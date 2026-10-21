// apps/backend/src/modules/18-evv/jobs/ports.ts — the injected ports the §4.8 aggregator workers depend on
// (GAP-056). Everything that lives in another module, or outside the platform, is a port here: M18 never reads
// another module's tables and never names a vendor (the §25.14 adapter mandate).
import type {
  AggregatorCredentialStore,
  AggregatorCredentials,
  EvvAggregatorAdapter,
  StateAggregatorConfig,
  StateAggregatorRegistry,
} from "@chartwarden/evv-aggregators";

/** Org-explicit facts about a visit's submission that live outside M18. Every method opens its own tenant scope
 * (a worker is not a request). `null` means "not available" — never a guessed value. */
export interface EvvSubmissionFactsPort {
  /** The state postal code the provider entity operates in (M1 `providerEntitySubmissionProfile.stateCode`). */
  stateCodeForProviderEntity(
    organizationId: string,
    providerEntityId: string,
  ): Promise<string | null>;
  /** The patient's state-Medicaid ID (M5 `state_id`, envelope-encrypted there — needs an M5 decrypt seam). */
  patientStateIdentifier(organizationId: string, patientId: string): Promise<string | null>;
  /** The clinician's individual NPI (the Sandata body allows null). */
  clinicianNpi(organizationId: string, membershipId: string): Promise<string | null>;
}

/** The registry surface the workers use (a structural subset of {@link StateAggregatorRegistry}). */
export type EvvAggregatorRegistryPort = Pick<
  StateAggregatorRegistry,
  "adapterForState" | "isOpenModelNoAggregator"
>;

export interface EvvAggregatorDeps {
  readonly registry: EvvAggregatorRegistryPort;
  readonly credentials: AggregatorCredentialStore;
  readonly facts: EvvSubmissionFactsPort;
}

/** Thrown by an unbound port: a worker row-failure the tick collects and rethrows (DLQ-visible), never a no-op. */
export class EvvAggregatorPortUnboundError extends Error {
  constructor(port: string) {
    super(
      `M18 aggregator port '${port}' is not bound — no live aggregator integration is configured.`,
    );
    this.name = "EvvAggregatorPortUnboundError";
  }
}

/** Fail-closed credential store: M18 has no KMS-backed per-(provider, state) secret store yet. */
export function createUnboundAggregatorCredentialStore(): AggregatorCredentialStore {
  return {
    async resolve() {
      throw new EvvAggregatorPortUnboundError("AggregatorCredentialStore");
    },
  };
}

/** A resolved adapter for a state, or null when the state needs no submission (open-model-no-aggregator / unknown). */
export function adapterFor(
  registry: EvvAggregatorRegistryPort,
  stateCode: string,
): EvvAggregatorAdapter | null {
  if (registry.isOpenModelNoAggregator(stateCode)) return null;
  return registry.adapterForState(stateCode);
}

const OPERATING_MODELS = ["closed_single_vendor", "open_alt_evv", "open_no_aggregator"] as const;

/** Name of the env var carrying the per-state aggregator configuration (M40 holds no such master data yet). */
export const EVV_AGGREGATOR_STATES_ENV = "EVV_AGGREGATOR_STATES";

/**
 * Parse `EVV_AGGREGATOR_STATES` — a JSON array of `{stateCode, aggregatorVendor, operatingModel}`. Absent/blank
 * means "no state requires an aggregator" (every prep no-ops). A malformed value throws at boot: silently
 * dropping a mandated state would silently drop its submissions.
 */
export function parseEvvAggregatorStateConfigs(raw: string | undefined): StateAggregatorConfig[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${EVV_AGGREGATOR_STATES_ENV} must be valid JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${EVV_AGGREGATOR_STATES_ENV} must be a JSON array`);
  return parsed.map((entry, i) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const { stateCode, aggregatorVendor, operatingModel } = e;
    if (typeof stateCode !== "string" || !/^[A-Z]{2}$/.test(stateCode)) {
      throw new Error(`${EVV_AGGREGATOR_STATES_ENV}[${i}].stateCode must be a 2-letter code`);
    }
    if (typeof aggregatorVendor !== "string" || aggregatorVendor.length === 0) {
      throw new Error(`${EVV_AGGREGATOR_STATES_ENV}[${i}].aggregatorVendor is required`);
    }
    if (!OPERATING_MODELS.includes(operatingModel as (typeof OPERATING_MODELS)[number])) {
      throw new Error(`${EVV_AGGREGATOR_STATES_ENV}[${i}].operatingModel is invalid`);
    }
    return {
      stateCode,
      aggregatorVendor,
      operatingModel: operatingModel as StateAggregatorConfig["operatingModel"],
    };
  });
}

/** Name of the env var carrying per-(provider entity, vendor, state) aggregator credentials. */
export const EVV_AGGREGATOR_CREDENTIALS_ENV = "EVV_AGGREGATOR_CREDENTIALS";

interface CredentialEntry {
  readonly providerEntityId: string;
  readonly vendor: string;
  readonly stateCode: string;
  readonly secrets: Readonly<Record<string, string>>;
}

/**
 * Parse `EVV_AGGREGATOR_CREDENTIALS` — a JSON array of `{providerEntityId, vendor, stateCode, secrets}` where
 * `secrets` is a flat string map the vendor adapter interprets. Absent/blank => no credentials (the store stays
 * fail-closed). A malformed value throws at boot rather than silently dropping a tenant's credentials.
 */
export function parseEvvAggregatorCredentials(raw: string | undefined): CredentialEntry[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${EVV_AGGREGATOR_CREDENTIALS_ENV} must be valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${EVV_AGGREGATOR_CREDENTIALS_ENV} must be a JSON array`);
  }
  return parsed.map((entry, i) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const { providerEntityId, vendor, stateCode, secrets } = e;
    if (typeof providerEntityId !== "string" || providerEntityId === "") {
      throw new Error(`${EVV_AGGREGATOR_CREDENTIALS_ENV}[${i}].providerEntityId is required`);
    }
    if (typeof vendor !== "string" || vendor === "") {
      throw new Error(`${EVV_AGGREGATOR_CREDENTIALS_ENV}[${i}].vendor is required`);
    }
    if (typeof stateCode !== "string" || !/^[A-Z]{2}$/.test(stateCode)) {
      throw new Error(`${EVV_AGGREGATOR_CREDENTIALS_ENV}[${i}].stateCode must be a 2-letter code`);
    }
    const map = (secrets ?? {}) as Record<string, unknown>;
    const values = Object.values(map);
    if (values.length === 0 || !values.every((v) => typeof v === "string" && v !== "")) {
      throw new Error(`${EVV_AGGREGATOR_CREDENTIALS_ENV}[${i}].secrets must be non-empty strings`);
    }
    return { providerEntityId, vendor, stateCode, secrets: map as Record<string, string> };
  });
}

/**
 * Config-driven credential store: an exact `(providerEntityId, vendor, stateCode)` match or the same fail-closed
 * `EvvAggregatorPortUnboundError` the unbound store throws. Never falls back to another tenant's entry.
 */
export function createConfiguredAggregatorCredentialStore(
  entries: readonly CredentialEntry[],
): AggregatorCredentialStore {
  if (entries.length === 0) return createUnboundAggregatorCredentialStore();
  return {
    async resolve({ providerEntityId, vendor, stateCode }): Promise<AggregatorCredentials> {
      const hit = entries.find(
        (c) =>
          c.providerEntityId === providerEntityId &&
          c.vendor === vendor &&
          c.stateCode === stateCode,
      );
      if (!hit) throw new EvvAggregatorPortUnboundError("AggregatorCredentialStore");
      return { providerEntityId, secrets: { ...hit.secrets } };
    },
  };
}
