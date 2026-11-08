import type { createClaimMdEraResolver } from "./claimmd-era-resolution";
import type { createClaimMdEraStore } from "./claimmd-era-store";
import { registerPlatformJob } from "@chartwarden/tenancy";
import { CLAIMMD_ERA_RECOVERY_JOB_ID } from "./claimmd-era-store";

type Store = ReturnType<typeof createClaimMdEraStore>;
type Resolver = ReturnType<typeof createClaimMdEraResolver>;

/** Boot-time authorization for the store's audited recovery transactions. */
export function registerClaimMdEraRecoveryPlatformJob(): void {
  registerPlatformJob(CLAIMMD_ERA_RECOVERY_JOB_ID);
}

export interface ClaimMdEraRecoveryActor {
  readonly id: string;
  readonly kind: "platform_operator" | "platform_service";
  readonly authorization: string;
}

export interface ClaimMdEraRecoveryRequest {
  readonly actionId: string;
  readonly inboxId: string;
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly stage: "capture" | "ownership_resolution" | "m25_delivery";
  readonly reasonCode: string;
  readonly expectedState: string;
  /** Capture uses retry_count; ownership uses resolution_version; delivery uses attempt_count. */
  readonly expectedVersion: number;
}

/** Internal operations boundary. No route or tenant actor can construct authorization implicitly. */
export function createClaimMdEraRecoveryService(input: {
  readonly store: Store;
  readonly resolver: Resolver;
  readonly authorize: (actor: ClaimMdEraRecoveryActor) => Promise<boolean>;
}) {
  return {
    async requeue(request: ClaimMdEraRecoveryRequest, actor: ClaimMdEraRecoveryActor) {
      if (!(await input.authorize(actor))) throw new Error("CLAIMMD_ERA_RECOVERY_FORBIDDEN");
      if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(request.reasonCode)) throw new Error("CLAIMMD_ERA_RECOVERY_REASON_REQUIRED");
      const result = await input.store.recover({
        ...request,
        actorId: actor.id,
      });
      // Existing resolver performs full cryptographic/source verification and appends a versioned
      // resolution decision. Conflicts are never converted to verified by this recovery service.
      if (request.stage === "ownership_resolution" && result.outcome === "requeued") {
        const resolution = await input.resolver.resolve(request.inboxId);
        return { ...result, resolutionStatus: resolution.status, resolutionVersion: resolution.version };
      }
      return result;
    },
  };
}
