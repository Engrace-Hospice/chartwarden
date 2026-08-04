import type {
  CahpsDecedentSampleRow,
  CahpsResultSummaryInput,
  CahpsVendorAdapter,
} from "@wardenx/quality";
// @wardenx/cahps-vendors — HEALTHCAREfirst adapter (M30 §4.5). Phase-2 PLACEHOLDER.
//
// A real, registrable adapter whose behavior is deliberately not-yet-implemented: `validateConfig`
// reports the vendor is unavailable (so org boot refuses to bind it), and every operating method fails
// closed with `vendor_adapter_not_implemented`. The HEALTHCAREfirst CSV/result layouts land in Phase 2.
import { WardenXError } from "@wardenx/types";

const NOT_IMPLEMENTED = "the HEALTHCAREfirst CAHPS adapter is not yet implemented (phase 2)";

export class HealthcarefirstCahpsAdapter implements CahpsVendorAdapter {
  readonly vendor = "HEALTHCAREfirst" as const;

  validateConfig(
    _config: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; errors: { field: string; reason: string }[] }> {
    return Promise.resolve({
      ok: false,
      errors: [{ field: "vendorAdapterId", reason: NOT_IMPLEMENTED }],
    });
  }

  renderExport(
    _orgId: string,
    _samplePeriod: { start: string; end: string },
    _decedents: CahpsDecedentSampleRow[],
  ): Promise<{ filename: string; mimeType: string; bytes: Buffer }> {
    throw new WardenXError("vendor_adapter_not_implemented", NOT_IMPLEMENTED, 503);
  }

  pushExport(
    _orgId: string,
    _file: { filename: string; mimeType: string; bytes: Buffer },
    _config: Record<string, unknown>,
  ): Promise<{ status: "pushed"; vendorJobId: string } | { status: "no_push"; reason: string }> {
    throw new WardenXError("vendor_adapter_not_implemented", NOT_IMPLEMENTED, 503);
  }

  parseResultIngest(_payload: Buffer): Promise<CahpsResultSummaryInput[]> {
    throw new WardenXError("vendor_adapter_not_implemented", NOT_IMPLEMENTED, 503);
  }

  minimumCellSize(): number {
    return 30;
  }
}
