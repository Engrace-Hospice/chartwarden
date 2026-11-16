// apps/web/src/modules/10-hope — the workspace's remembered UI preferences (guided vs show-all navigation).
// Shared by the assessment workspace and the SFV completion dialog, which follow the same preference.
export type NavMode = "guided" | "all";
export const NAV_MODE_KEY = "wx.hope.navMode";

// GAP-191: the nav-mode preference is a harmless UI setting (localStorage). Anything keyed by a
// record id (the visited groups per assessment) lives in sessionStorage so it dies with the tab
// instead of outliving sign-out on a shared workstation.
type StorageKind = "local" | "session";

function storageFor(kind: StorageKind): Storage {
  return kind === "session" ? window.sessionStorage : window.localStorage;
}

export function readStorage(key: string, kind: StorageKind = "local"): string | null {
  try {
    return storageFor(kind).getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string, kind: StorageKind = "local"): void {
  try {
    storageFor(kind).setItem(key, value);
  } catch {
    // Storage unavailable (private mode): the preference just doesn't persist.
  }
}

export function readNavMode(): NavMode {
  return readStorage(NAV_MODE_KEY) === "all" ? "all" : "guided";
}
