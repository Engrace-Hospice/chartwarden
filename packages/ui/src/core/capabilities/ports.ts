// @wardenx/ui core — native-capability ports (ADR-0035). Screens and hooks depend on these
// interfaces, NEVER on `@capacitor/*` directly. Two adapter sets fulfill them: the web adapters
// in this folder (browser APIs / graceful fallback) and the Capacitor adapters wired at the
// native entrypoint (added with the Capacitor build PR). This is what keeps `apps/web` a pure
// web build that also ships, unchanged, as a native iOS/Android app.

export interface Coordinates {
  latitude: number;
  longitude: number;
  /** Accuracy in metres, when the platform reports it. */
  accuracy: number;
}

/** Device location — M18 EVV visit check-in/out, M20 field-safety. */
export interface GeolocationPort {
  /** Whether location is usable on this platform/permission state. */
  isAvailable(): Promise<boolean>;
  /** One-shot current position. Rejects if unavailable or permission denied. */
  getCurrentPosition(): Promise<Coordinates>;
}

export interface CapturedPhoto {
  /** Base64 (no `data:` prefix) or an object URL, per adapter. */
  data: string;
  format: "jpeg" | "png";
}

/** Camera capture — DocLens wound photos / document capture. */
export interface CameraPort {
  isAvailable(): Promise<boolean>;
  capturePhoto(): Promise<CapturedPhoto>;
}

/** Biometric / device unlock — §12 re-auth on app foreground after idle. */
export interface BiometricPort {
  isAvailable(): Promise<boolean>;
  /** Prompt for biometric verification; resolves true on success. */
  verify(reason: string): Promise<boolean>;
}

/**
 * Secure at-rest storage — §12 tokens in iOS Keychain / Android Keystore.
 * The web adapter falls back to browser storage and is for the browser build ONLY; on a
 * device the Capacitor SecureStore adapter MUST be used (never plain web storage for PHI/tokens).
 */
export interface SecureStorePort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Push registration — APNs/FCM device token (payloads stay PHI-free, M36 §4.7). */
export interface PushPort {
  isAvailable(): Promise<boolean>;
  /** Register and return the device token, or null when unavailable/denied. */
  register(): Promise<string | null>;
}

/** Local file cache — offline note/draft storage (DR/BCP §11.1). */
export interface FilesystemPort {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, data: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
}

/** Online/offline state — drives degraded-mode + offline draft sync (DR/BCP §11.1). */
export interface NetworkStatusPort {
  isOnline(): boolean;
  /** Subscribe to connectivity changes; returns an unsubscribe fn. */
  subscribe(listener: (online: boolean) => void): () => void;
}

/**
 * The full set of capability ports an app provides. The web build injects the web adapters
 * (this folder); the native build injects the Capacitor adapters at its entrypoint.
 */
export interface CapabilityPorts {
  geolocation: GeolocationPort;
  camera: CameraPort;
  biometric: BiometricPort;
  secureStore: SecureStorePort;
  push: PushPort;
  filesystem: FilesystemPort;
  network: NetworkStatusPort;
}
