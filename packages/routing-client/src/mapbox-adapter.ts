// @chartwarden/routing-client — the Mapbox `RoutingProvider` swap-path (M17-T07, spec §4.10). DISABLED by
// default; it ships so the engine can be swapped without touching any M17 consumer. Mapbox requires a
// platform API key + a tenant-level BAA-or-equivalent assessment (Integrations), so it is constructed only
// when both are present. The cache-key strategy is identical (coord-hash, not address) so the swap is opaque
// to the consumer and the D9 / §7.10 PHI boundary holds regardless of engine.
import { RoutingDegradedError } from "./errors";
import type {
  RoutingCoord,
  RoutingDirectionsResult,
  RoutingMatrixResult,
  RoutingProvider,
} from "./interface";

/** The not-enabled Mapbox provider: every call raises the degraded envelope until the engine is wired. */
export class MapboxRoutingProvider implements RoutingProvider {
  constructor(private readonly correlationId: string = "mapbox") {}

  async matrix(_coords: ReadonlyArray<RoutingCoord>): Promise<RoutingMatrixResult> {
    throw this.notEnabled("matrix");
  }

  async directions(_from: RoutingCoord, _to: RoutingCoord): Promise<RoutingDirectionsResult> {
    throw this.notEnabled("directions");
  }

  async healthy(): Promise<boolean> {
    return false; // disabled engine is never healthy — the worker takes the §7.9 degraded path
  }

  private notEnabled(operation: "matrix" | "directions"): RoutingDegradedError {
    return new RoutingDegradedError(
      "mapbox",
      operation,
      false,
      "Mapbox routing engine is not enabled for this platform.",
      this.correlationId,
    );
  }
}
