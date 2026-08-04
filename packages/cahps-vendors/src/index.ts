// @wardenx/cahps-vendors — M30 §4.5 CAHPS vendor adapter registry (the concrete classes + factory map).
//
// One class per approved CAHPS-Hospice vendor implements the `CahpsVendorAdapter` contract published by
// `@wardenx/quality`. The platform default is SHP; `manual` is the no-contract path; Press Ganey / Deyta /
// HEALTHCAREfirst are real Phase-2 placeholders. `CAHPS_ADAPTER_FACTORIES` is the `vendor_adapter_id →
// factory` resolution map the M30 composition root injects into a `CahpsAdapterRegistry` at org boot — it
// is the single point that couples concrete vendor classes to the persisted `vendorAdapterId`.
import type {
  CahpsAdapterResolutionMap,
  CahpsVendorAdapter,
  CahpsVendorAdapterId,
} from "@wardenx/quality";
import { DeytaCahpsAdapter } from "./deyta/adapter";
import { HealthcarefirstCahpsAdapter } from "./healthcarefirst/adapter";
import { ManualCahpsAdapter } from "./manual/adapter";
import { PressGaneyCahpsAdapter } from "./press_ganey/adapter";
import { ShpCahpsAdapter } from "./shp/adapter";

// Concrete adapter classes (also exported for direct construction / testing).
export { ShpCahpsAdapter } from "./shp/adapter";
export { ManualCahpsAdapter } from "./manual/adapter";
export { PressGaneyCahpsAdapter } from "./press_ganey/adapter";
export { DeytaCahpsAdapter } from "./deyta/adapter";
export { HealthcarefirstCahpsAdapter } from "./healthcarefirst/adapter";

// SHP building blocks (CSV render, aggregate parse, signed intake client) — exported for reuse/tests.
export { renderShpDecedentCsv, shpExportFilename, SHP_DECEDENT_COLUMNS } from "./shp/export";
export { parseShpAggregate } from "./shp/result";
export { ShpClient, signShpRequest, SHP_INTAKE_URL } from "./shp/client";
export type { ShpClientConfig, ShpHttpPort, ShpSignedRequest, ShpHttpResponse } from "./shp/client";

// Manual CSV column schemas + helpers.
export {
  MANUAL_DECEDENT_COLUMNS,
  MANUAL_RESULT_COLUMNS,
  parseCsv,
  renderCsv,
  csvField,
} from "./manual/csv_format";

/**
 * The `vendor_adapter_id → factory` resolution map (§4.5). Total over {@link CahpsVendorAdapterId} so every
 * persistable `cahps_vendor_binding.vendor_adapter_id` resolves to a live adapter. The M30 boot path passes
 * this into a `CahpsAdapterRegistry`; the per-call decrypted config is forwarded to each factory.
 */
export const CAHPS_ADAPTER_FACTORIES: CahpsAdapterResolutionMap = {
  shp: (config): CahpsVendorAdapter => new ShpCahpsAdapter(config),
  manual: (): CahpsVendorAdapter => new ManualCahpsAdapter(),
  press_ganey: (): CahpsVendorAdapter => new PressGaneyCahpsAdapter(),
  deyta: (): CahpsVendorAdapter => new DeytaCahpsAdapter(),
  healthcarefirst: (): CahpsVendorAdapter => new HealthcarefirstCahpsAdapter(),
};

/** All adapter ids the platform ships a class for (the keys of {@link CAHPS_ADAPTER_FACTORIES}). */
export const SUPPORTED_CAHPS_VENDOR_IDS = Object.keys(
  CAHPS_ADAPTER_FACTORIES,
) as CahpsVendorAdapterId[];
