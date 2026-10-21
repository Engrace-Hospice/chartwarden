// @chartwarden/medicaid-adapters — the Phase-1 deny-stub state adapters (WA/ID/CA/NV, D14). Each is built from
// the shared `createDenyStubAdapter` factory so the registry's existence proof is testable; every I/O method
// throws ADAPTER_DENY_STUB and the vendor carries the '-deny-stub' suffix. A state graduates from a stub to
// a real adapter (its own subpackage) when a paying customer in that state lands.
import { createDenyStubAdapter } from "./deny-stub";
import type { MedicaidAdapter } from "./interface";

export const washingtonMedicaidAdapter: MedicaidAdapter = createDenyStubAdapter(
  "WA",
  "washington-mmis",
);
export const idahoMedicaidAdapter: MedicaidAdapter = createDenyStubAdapter("ID", "idaho-mmis");
export const californiaMedicaidAdapter: MedicaidAdapter = createDenyStubAdapter(
  "CA",
  "california-medi-cal",
);
export const nevadaMedicaidAdapter: MedicaidAdapter = createDenyStubAdapter("NV", "nevada-mmis");
