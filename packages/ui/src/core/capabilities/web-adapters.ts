// @chartwarden/ui core — web adapters for the capability ports (ADR-0035). Browser-API backed
// where one exists, else a graceful "unavailable" fallback (mirroring the degraded-mode
// pattern). The plain-web / PWA build uses these; the native build swaps in Capacitor adapters
// at its entrypoint. No `@capacitor/*` and no `react-dom` here — this is the web side of the seam.
import type {
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

const hasNavigator = typeof navigator !== "undefined";
const hasWindow = typeof window !== "undefined";
const hasLocalStorage = typeof localStorage !== "undefined";

const webGeolocation: GeolocationPort = {
  async isAvailable() {
    return hasNavigator && "geolocation" in navigator;
  },
  getCurrentPosition() {
    return new Promise<Coordinates>((resolve, reject) => {
      if (!hasNavigator || !("geolocation" in navigator)) {
        reject(new Error("geolocation unavailable in this environment"));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          }),
        (err) => reject(new Error(err.message)),
        { enableHighAccuracy: true },
      );
    });
  },
};

// The browser has no general "open camera and return a photo" primitive without a DOM <input
// capture> element, which belongs in the web rendering layer. The web adapter reports
// unavailable so callers fall back; the Capacitor adapter provides real capture on device.
const webCamera: CameraPort = {
  async isAvailable() {
    return false;
  },
  async capturePhoto(): Promise<CapturedPhoto> {
    throw new Error("camera capture is native-only; use the Capacitor adapter on device");
  },
};

const webBiometric: BiometricPort = {
  async isAvailable() {
    return false;
  },
  async verify() {
    // Browser has no biometric primitive here; native build supplies it. Treat as not verified.
    return false;
  },
};

// Browser fallback uses localStorage — for the BROWSER build only. On a device the Capacitor
// SecureStore adapter (Keychain/Keystore) MUST replace this; never persist tokens/PHI here on
// a device (ADR-0035 / SECURITY_HARDENING §12).
const webSecureStore: SecureStorePort = {
  async get(key) {
    return hasLocalStorage ? localStorage.getItem(key) : null;
  },
  async set(key, value) {
    if (hasLocalStorage) localStorage.setItem(key, value);
  },
  async remove(key) {
    if (hasLocalStorage) localStorage.removeItem(key);
  },
};

const webPush: PushPort = {
  async isAvailable() {
    return false;
  },
  async register() {
    // PWA web-push (VAPID) is a later web-only path; native uses APNs/FCM via Capacitor.
    return null;
  },
};

const webFilesystem: FilesystemPort = {
  async readFile() {
    return null;
  },
  async writeFile() {
    /* no-op in the browser; native offline cache uses the Capacitor Filesystem adapter */
  },
  async deleteFile() {
    /* no-op */
  },
};

const webNetwork: NetworkStatusPort = {
  isOnline() {
    return hasNavigator ? navigator.onLine : true;
  },
  subscribe(listener) {
    if (!hasWindow) return () => {};
    const onOnline = () => listener(true);
    const onOffline = () => listener(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  },
};

/** The browser/PWA capability bundle. The native build replaces this with Capacitor adapters. */
export const webCapabilityPorts: CapabilityPorts = {
  geolocation: webGeolocation,
  camera: webCamera,
  biometric: webBiometric,
  secureStore: webSecureStore,
  push: webPush,
  filesystem: webFilesystem,
  network: webNetwork,
};
