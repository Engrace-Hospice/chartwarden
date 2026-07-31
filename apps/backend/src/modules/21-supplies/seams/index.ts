// apps/backend/src/modules/21-supplies/seams — M21's seam surface.
//
// M21-T04 lands only the CONSUMED half (`./consumed`): M11's `OrderProvider` for the §2.8 logical-FK check
// behind `supply_request.source_order_id`, and M6's `AdmissionStatusReader` + `DeathDischargeReader` for the
// tenancy anchor and §7.1's two pre-dispatch cancellation edges.
//
// The §4.8 PUBLISHED seams (`SupplyFulfillmentProvider`, `ComfortKitInventoryReader`, …) and their
// `registerSeam` wiring land in M21-T05.
export { getAdmissionStatusReader, getDeathDischargeReader, getOrderProvider } from "./consumed";
