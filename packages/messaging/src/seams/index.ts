// @chartwarden/messaging — published seam implementations (M36-T06, spec §4.6).
//
// The boot-validated `AlertEmitter` impl composed over the M36-T04 engine + injected ports, with
// an in-memory slice default. The published seam INTERFACES live in ../interfaces; this barrel
// exports the IMPLEMENTATION the M1 registry registers (apps/backend/src/modules/36-messaging).

export {
  createAlertEmitter,
  createInMemoryAlertEmitter,
  type AlertEmitterPorts,
  type EmitAlertRule,
  type PersistedAlert,
  type RecordedAlert,
  type InMemoryAlertEmitterOptions,
} from "./alert-emitter-impl";
