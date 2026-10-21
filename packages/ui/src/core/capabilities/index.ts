// @chartwarden/ui core — native-capability seam (ADR-0035). Port interfaces + the web adapter
// bundle. Consumers depend on the ports; the active bundle is injected at the app entrypoint
// (web adapters here for the browser/PWA build; Capacitor adapters at the native entrypoint).
export type {
  BiometricPort,
  CameraPort,
  CapabilityPorts,
  CapturedPhoto,
  Coordinates,
  FilesystemPort,
  GeolocationPort,
  NetworkStatusPort,
  PushPort,
  SecureStorePort,
} from "./ports";
export { webCapabilityPorts } from "./web-adapters";
