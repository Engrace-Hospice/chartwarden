// apps/backend/src/modules/20-field-safety/terminus/psap.ts - GAP-032: the `resolve_psap` executor step.
//
// Which tenant-curated PSAP covers this alert? M40 answers (`EmergencyServiceJurisdictionReader`); M20's job
// is to hand it the best point it has. The coordinate is application-layer ciphertext under the tenant DEK
// (a key fetch that may be remote), which is exactly why this runs in the executor and not in the watchdog
// tx. The decrypted point crosses the seam in memory only: never persisted, never logged.
//
// What is surfaced to a human is NOT decided here: the terminus UI always shows the static "call 911 / your
// local emergency number" line; the PSAP administrative line is supplementary (and labelled with who verified
// it, when). The platform never dials a PSAP.
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import type { OrgId } from "@wardenx/types";
import { and, desc, eq } from "drizzle-orm";
import { coordinatesCaptured, decodeCoordinates } from "../routes/coordinates";
import type { SafetyDecipherPort } from "../routes/read-service-drizzle";
import type { TerminusDeps } from "./deps";
import type { RetryOrFail, TerminusSettlement } from "./ledger";

const ALERT = schema.safetySosAlert;
const STREAM = schema.safetySosLocationStream;

/** A fix worse than this is not a position a boundary can be matched against. */
export const PSAP_MAX_ACCURACY_M = 5_000;

export interface SosPositionSource {
  readonly cipher: Uint8Array;
  readonly accuracyM: number;
}

/** The newest usable position cipher: the latest location-stream sample, else the press itself. */
export async function loadPositionSource(
  tx: DbClient,
  organizationId: string,
  sosAlertId: string,
): Promise<SosPositionSource | null> {
  const [sample] = await tx
    .select({ cipher: STREAM.coordinatesCipher, accuracyM: STREAM.accuracyM })
    .from(STREAM)
    .where(and(eq(STREAM.sosAlertId, sosAlertId), eq(STREAM.organizationId, organizationId)))
    .orderBy(desc(STREAM.sampledAt))
    .limit(1);
  if (sample && coordinatesCaptured(sample.cipher)) return sample;
  const [alert] = await tx
    .select({ cipher: ALERT.postedCoordinatesCipher, accuracyM: ALERT.postedCoordinatesAccuracyM })
    .from(ALERT)
    .where(and(eq(ALERT.id, sosAlertId), eq(ALERT.organizationId, organizationId)))
    .limit(1);
  return alert && coordinatesCaptured(alert.cipher) ? alert : null;
}

/** Decrypt a position source to a plain point, or null (declined consent, unreadable, or too coarse). */
export async function openPosition(
  source: SosPositionSource | null,
  organizationId: string,
  decipher: SafetyDecipherPort | undefined,
): Promise<{ readonly latitude: number; readonly longitude: number } | null> {
  if (source === null || decipher === undefined || source.accuracyM > PSAP_MAX_ACCURACY_M)
    return null;
  try {
    const decoded = decodeCoordinates(
      await decipher.decrypt({ organizationId, cipher: source.cipher }),
    );
    return decoded === null ? null : { latitude: decoded.lat, longitude: decoded.lng };
  } catch {
    return null;
  }
}

/** Resolve the jurisdiction for one alert into a ledger settlement. */
export async function resolvePsapSettlement(
  deps: TerminusDeps,
  input: {
    readonly organizationId: string;
    readonly locationId: string | null;
    readonly point: { readonly latitude: number; readonly longitude: number } | null;
  },
  retryOrFail: RetryOrFail,
): Promise<TerminusSettlement> {
  if (deps.jurisdictions === undefined) {
    return { status: "skipped", outcomeCode: "jurisdiction_unavailable" };
  }
  try {
    const resolution = await deps.jurisdictions().forSosAlert({
      orgId: input.organizationId as OrgId,
      point: input.point,
      locationId: input.locationId as never,
    });
    if (resolution.kind === "resolved") {
      return { status: "succeeded", outcomeCode: "ok", jurisdictionId: resolution.jurisdictionId };
    }
    if (resolution.kind === "none") return { status: "skipped", outcomeCode: "jurisdiction_none" };
    return retryOrFail("jurisdiction_unavailable");
  } catch {
    // An unbound seam throws: that is "unavailable", never "none".
    return retryOrFail("jurisdiction_unavailable");
  }
}
