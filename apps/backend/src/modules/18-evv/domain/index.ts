// apps/backend/src/modules/18-evv/domain/index.ts — M18-T03 barrel.
//
// The pure EVV event-lifecycle domain (§2.2.1, §2.2.2, §2.3, §2.4, §7.5–§7.7): the append-only event
// recorder, the correction-of-record, the geofence haversine + accuracy math, the three-layer geofence
// policy resolver, the §2.3 error catalog, and the §2.4 side-effect descriptors. All IO-free; the
// service/route layer (M18-T06) wires the M17/M5/M2 reader seams + executes the effects in one tx.
export * from "./errors";
export * from "./geofence";
export * from "./geofence-policy";
export * from "./effects";
export * from "./event-lifecycle";
