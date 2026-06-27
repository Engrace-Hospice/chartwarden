// @wardenx/cahps-vendors — SHP adapter (M30 §4.5, the PLATFORM DEFAULT vendor).
//
// Strategic Healthcare Programs (SHP) is the default CAHPS-Hospice vendor. This adapter implements the
// published `CahpsVendorAdapter` contract by composing the SHP CSV renderer (./export), the aggregate
// parser (./result), and the signed intake client (./client). The vendor transport is an INJECTED port
// (constructor arg); with none wired (P2a) `pushExport` fails closed as degraded rather than touching the
// network. Per CMS protocol the minimum cell size is 30.
import { WardenXError } from "@wardenx/types";
import type {
  CahpsDecedentSampleRow,
  CahpsResultSummaryInput,
  CahpsVendorAdapter,
} from "@wardenx/quality";
import { type ShpHttpPort, ShpClient } from "./client";
import { renderShpDecedentCsv, shpExportFilename } from "./export";
import { parseShpAggregate } from "./result";

function configString(config: Record<string, unknown>, key: string): string | null {
  const v = config[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The SHP CAHPS adapter. Stateless except for the org-bound config + the injected transport port. */
export class ShpCahpsAdapter implements CahpsVendorAdapter {
  readonly vendor = "SHP" as const;

  constructor(
    private readonly config: Record<string, unknown> = {},
    private readonly httpPort?: ShpHttpPort,
  ) {}

  validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; errors: { field: string; reason: string }[] }> {
    const errors: { field: string; reason: string }[] = [];
    if (configString(config, "apiKey") === null) {
      errors.push({ field: "apiKey", reason: "a non-empty SHP API key is required" });
    }
    if (configString(config, "apiSecret") === null) {
      errors.push({ field: "apiSecret", reason: "a non-empty SHP shared secret is required" });
    }
    return Promise.resolve(errors.length === 0 ? { ok: true } : { ok: false, errors });
  }

  renderExport(
    _orgId: string,
    samplePeriod: { start: string; end: string },
    decedents: CahpsDecedentSampleRow[],
  ): Promise<{ filename: string; mimeType: string; bytes: Buffer }> {
    return Promise.resolve({
      filename: shpExportFilename(samplePeriod),
      mimeType: "text/csv",
      bytes: renderShpDecedentCsv(decedents),
    });
  }

  async pushExport(
    _orgId: string,
    file: { filename: string; mimeType: string; bytes: Buffer },
    config: Record<string, unknown>,
  ): Promise<{ status: "pushed"; vendorJobId: string } | { status: "no_push"; reason: string }> {
    // Per-call config wins; the org-bound constructor config is the fallback (§4.5 instantiation).
    const merged = { ...this.config, ...config };
    const apiKey = configString(merged, "apiKey");
    const apiSecret = configString(merged, "apiSecret");
    if (apiKey === null || apiSecret === null) {
      throw new WardenXError(
        "VALIDATION_FAILED",
        "SHP push requires apiKey and apiSecret in the binding config",
        422,
      );
    }
    const baseUrl = configString(merged, "baseUrl") ?? undefined;
    const client = new ShpClient({ apiKey, apiSecret, baseUrl }, this.httpPort);
    const { vendorJobId } = await client.postIntake(file, new Date().toISOString());
    return { status: "pushed", vendorJobId };
  }

  parseResultIngest(payload: Buffer): Promise<CahpsResultSummaryInput[]> {
    return Promise.resolve(parseShpAggregate(payload));
  }

  minimumCellSize(): number {
    return 30;
  }
}
