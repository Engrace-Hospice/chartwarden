// apps/backend/src/modules/12-dosespot/tenant-config/liveness.ts — the ONE answer to "is this registration LIVE?", shared by the
// config source (the adapter), the sign-time transmission gate and the wizard's settled reader, so they can never disagree (a gate that
// said yes while the resolver said no stalled signed orders in `queued`).
//
// LIVE = `active` AND the platform allows the row's environment to be live: production needs its flag and host; a sandbox row needs
// `DOSESPOT_SANDBOX_ENABLED` (a sandbox registration may be verified anywhere, but must never transmit real prescriptions to DoseSpot's
// test environment because a deployment forgot to say so).
import { type DoseSpotEnvironment, environmentAllowsLive } from "@chartwarden/dosespot";

export interface RegistrationRef {
  readonly status: string;
  readonly environment: string;
}

export function registrationIsLive(
  row: RegistrationRef,
  platformEnv: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    row.status === "active" &&
    environmentAllowsLive(row.environment as DoseSpotEnvironment, platformEnv)
  );
}
