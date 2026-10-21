// @chartwarden/evv-aggregators — the per-state credential-store contract (M18-T06).
//
// The M18 backend resolves `(provider, state)` credentials through this port and hands the opaque result to
// `submit`/`poll`. The `secrets` map keys are vendor-specific and interpreted ONLY by the adapter (the §25.14
// adapter-mandate boundary) — the M18 backend never inspects them.
import type { AggregatorCredentials } from "./interface";

/** Resolve the `(providerEntityId, vendor, stateCode)` credentials an adapter needs to submit/poll. Production
 * backs this with the M2 KMS-fronted secret store; tests/boot-without-secrets inject a fixture resolver. */
export interface AggregatorCredentialStore {
  resolve(args: {
    readonly providerEntityId: string;
    readonly vendor: string;
    readonly stateCode: string;
  }): Promise<AggregatorCredentials>;
}

/** A boot/test fixture: hands back an empty `secrets` map bound to the provider. The Sandata/open-model
 * Phase-1 adapters never dereference real secrets (the sandbox transport is deterministic), so this keeps the
 * §7.8/§7.9 flows exercisable without a live KMS. */
export function createFixtureCredentialStore(): AggregatorCredentialStore {
  return {
    async resolve({ providerEntityId }) {
      return { providerEntityId, secrets: {} };
    },
  };
}
