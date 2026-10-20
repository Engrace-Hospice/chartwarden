// M36 WP 5.5 (ADR-0083) - a COARSE device label from the stored user agent: browser family and operating system, nothing else (no version,
// no model, no raw string). A person recognises "Chrome · macOS"; the exact agent is a fingerprint and is never returned by the API.
export const UNKNOWN_DEVICE_LABEL = "Unknown device";

// A real user agent is under 300 characters; a longer one is not parsed at all (bounded work on stored, client-supplied text).
const MAX_PARSED_LENGTH = 512;

// Order matters: Edge, Opera and the iOS wrappers also say "Chrome"/"Safari"; Chrome also says "Safari".
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];

// iPhone/iPad before macOS ("like Mac OS X"), Android before Linux.
const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\biPhone\b|\biPad\b|\biPod\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b|\bX11\b/, "Linux"],
];

const firstMatch = (table: ReadonlyArray<readonly [RegExp, string]>, ua: string): string | null =>
  table.find(([pattern]) => pattern.test(ua))?.[1] ?? null;

export function deviceLabel(userAgent: string | null | undefined): string {
  if (!userAgent || userAgent.length > MAX_PARSED_LENGTH) return UNKNOWN_DEVICE_LABEL;
  const browser = firstMatch(BROWSERS, userAgent);
  const system = firstMatch(SYSTEMS, userAgent);
  if (browser && system) return `${browser} · ${system}`;
  return browser ?? system ?? UNKNOWN_DEVICE_LABEL;
}
