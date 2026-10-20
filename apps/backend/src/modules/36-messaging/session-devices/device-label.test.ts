// M36 WP 5.5 (ADR-0083) - the coarse device label: browser + OS only, no version, no raw user-agent, a fixed fallback.
import { describe, expect, it } from "vitest";
import { UNKNOWN_DEVICE_LABEL, deviceLabel } from "./device-label";

const UA = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
};

describe("deviceLabel", () => {
  it("names browser and operating system only", () => {
    expect(deviceLabel(UA.chromeMac)).toBe("Chrome · macOS");
    expect(deviceLabel(UA.safariIphone)).toBe("Safari · iOS");
    expect(deviceLabel(UA.chromeAndroid)).toBe("Chrome · Android");
    expect(deviceLabel(UA.edgeWindows)).toBe("Edge · Windows");
    expect(deviceLabel(UA.firefoxLinux)).toBe("Firefox · Linux");
  });

  it("never echoes version numbers, model names or the raw string", () => {
    for (const ua of Object.values(UA)) {
      const label = deviceLabel(ua);
      expect(label).not.toMatch(/\d/);
      expect(label).not.toContain("Pixel");
      expect(label).not.toContain("Mozilla");
    }
  });

  it("falls back to a fixed label for missing, empty, oversized or unrecognised input", () => {
    expect(deviceLabel(null)).toBe(UNKNOWN_DEVICE_LABEL);
    expect(deviceLabel("")).toBe(UNKNOWN_DEVICE_LABEL);
    expect(deviceLabel("curl/8.4.0")).toBe(UNKNOWN_DEVICE_LABEL);
    expect(deviceLabel(`Chrome/1 ${"x".repeat(100_000)}`)).toBe(UNKNOWN_DEVICE_LABEL);
  });
});
