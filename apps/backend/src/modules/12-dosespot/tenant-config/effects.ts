// apps/backend/src/modules/12-dosespot/tenant-config/effects.ts — what a registration change does BESIDE the row, shared by the
// tenant's own route service and the platform operator's onboarding port so the two lanes can never drift:
//   in the change's own transaction   the outbox event (`activated` / `deactivated`, ids and environment only) and the
//                                     `afterWrite` hook (the composition root binds it to M34's go-live void: a registration
//                                     change makes a pending go-live attestation stale, so it is revoked in the SAME transaction);
//   after the commit, best effort     the M36 alert to the tenant's administrators when the registration stopped being live,
//                                     and the onboarding settle (the wizard step reads the registration).
// A failure after the commit is the caller's to log and never fails the change.
import type { DbClient } from "@chartwarden/db";
import type { DoseSpotEnvironment } from "@chartwarden/dosespot";
import type { DoseSpotWriteOutboxPort } from "../dosespot-route-service-db";
import type { ConfigStore } from "./config-store";
import type { PutResult, TransitionResult } from "./service";

export const DEACTIVATED_ALERT = "m12.dosespot_config.deactivated";

export interface ClinicAlertPort {
  dispatch(input: {
    readonly alertCode: string;
    readonly severity: "warn" | "critical";
    readonly organizationId: string;
    readonly payload: Record<string, unknown>;
  }): Promise<void>;
}

export interface ClinicEffectDeps {
  readonly outbox: DoseSpotWriteOutboxPort;
  /** In the change's transaction: void a pending go-live attestation (the data it attested just changed). */
  readonly afterWrite?: (
    tx: DbClient,
    scope: { organizationId: string; userId: string; membershipId: string | null },
  ) => Promise<void>;
}

/** A change that took the registration out of service, or put it in. */
export type ClinicServiceChange =
  | { readonly kind: "activated" }
  | { readonly kind: "deactivated"; readonly cause: "deactivated" | "credential_changed" };

/** The service-level change a call made, if any (a no-op, a draft save and a test emit nothing). */
export function changeOfPut(result: PutResult): ClinicServiceChange | null {
  return result.leftActive ? { kind: "deactivated", cause: "credential_changed" } : null;
}
export function changeOfTransition(
  result: TransitionResult,
  kind: "activated" | "deactivated",
): ClinicServiceChange | null {
  if (!result.changed) return null;
  return kind === "activated" ? { kind } : { kind, cause: "deactivated" };
}

/** The registration an effect names: its id, environment and the version the change produced (the per-change discriminator). */
export interface RegistrationRef {
  readonly id: string;
  readonly environment: DoseSpotEnvironment;
  readonly version: number;
}

export async function registrationOf(
  store: ConfigStore,
  organizationId: string,
): Promise<RegistrationRef> {
  const row = await store.find(organizationId);
  if (!row) throw new Error("the DoseSpot registration vanished after its write");
  return { id: row.id, environment: row.environment as DoseSpotEnvironment, version: row.version };
}

/** In the change's transaction: the outbox event, then the go-live void. */
export async function applyInTransaction(
  tx: DbClient,
  deps: ClinicEffectDeps,
  input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly membershipId: string | null;
    readonly registration: RegistrationRef;
    readonly change: ClinicServiceChange | null;
  },
): Promise<void> {
  const { change, registration, organizationId } = input;
  if (change) {
    await deps.outbox.publish(tx, {
      eventName: `m12.dosespot_config.${change.kind}`,
      organizationId,
      aggregateKind: "dosespot_clinic_registration",
      aggregateId: registration.id,
      payload: {
        registrationId: registration.id,
        environment: registration.environment,
        ...(change.kind === "deactivated" ? { cause: change.cause } : {}),
      },
    });
  }
  await deps.afterWrite?.(tx, {
    organizationId,
    userId: input.userId,
    membershipId: input.membershipId,
  });
}

/** After the commit: the alert when the registration stopped being live. Best effort; the caller logs a failure. */
export async function alertAfterCommit(
  alerts: ClinicAlertPort | undefined,
  organizationId: string,
  registration: RegistrationRef,
  change: ClinicServiceChange | null,
): Promise<void> {
  if (!alerts || change?.kind !== "deactivated") return;
  await alerts.dispatch({
    alertCode: DEACTIVATED_ALERT,
    severity: "warn",
    organizationId,
    // `changeId` ends in `Id`, so the M36 correlation id differs per change: AlertEmitter collapses a repeat of (org, correlationId), and
    // without it a second deactivation or rotation of the same registration on the same UTC day would never alert.
    payload: {
      registrationId: registration.id,
      changeId: `${registration.id}:${registration.version}`,
      environment: registration.environment,
      cause: change.cause,
    },
  });
}
