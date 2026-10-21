// @chartwarden/messaging — M36-T06 PHI sanitization golden test (spec §4.7 / §7.2).
//
// §7.2 "No PHI leaves the perimeter in out-of-band payloads" — done means the sanitizer's output
// contains no patient name, no body, no diagnosis, and no category-specific content beyond the
// generic `short`, for EVERY alert category × EVERY out-of-band channel. The red-team fixture
// below seeds an alert (and a message) with PHI in every field; we assert none of those tokens
// traverses `sanitizeForOutOfBand` regardless of category/channel. Because the sanitizer builds
// its output from an ALLOWLIST (id + generic short + deep link), this holds by construction.
import { describe, expect, it } from "vitest";
import {
  type Alert,
  type AlertCategory,
  type Message,
  type OutOfBandChannel,
  sanitizeForOutOfBand,
} from "../src/index";

const CATEGORIES: readonly AlertCategory[] = [
  "clinical_urgent",
  "clinical_routine",
  "operational",
  "field_safety",
  "administrative",
  "system",
];

const CHANNELS: readonly OutOfBandChannel[] = ["sms", "email", "push", "voice"];

/** Synthetic PHI tokens seeded into every field of the red-team fixtures (§7.2). */
const PHI_TOKENS = [
  "Jane Patient",
  "MRN-00042",
  "metabolic encephalopathy",
  "123 Care Lane",
  "DEADBEEF-BODY-CIPHER",
  "patient died at 0300",
  "ssn-555-12-3456",
];

/** An alert with PHI smuggled into every payload field a careless dispatcher might copy. */
function redTeamAlert(category: AlertCategory): Alert {
  return {
    kind: "alert",
    alertId: "alert-1",
    notificationDeliveryId: "nd-abc-123",
    category,
    payload: {
      patientName: "Jane Patient",
      mrn: "MRN-00042",
      diagnosis: "metabolic encephalopathy",
      address: "123 Care Lane",
      note: "patient died at 0300",
      ssn: "ssn-555-12-3456",
      // a deliberately `phi: true`-tagged structured field (§4.7) — must not survive either:
      vitals: { phi: true, value: "BP 80/40, deteriorating" },
    },
  };
}

function redTeamMessage(): Message {
  return {
    kind: "message",
    messageId: "msg-1",
    notificationDeliveryId: "nd-msg-9",
    channelId: "chan-care-team-Jane Patient",
    body: "DEADBEEF-BODY-CIPHER metabolic encephalopathy — Jane Patient",
  };
}

/** Every token + value reachable in the sanitizer output, as one lowercase haystack. */
function haystack(o: object): string {
  return JSON.stringify(o).toLowerCase();
}

describe("M36-T06 §7.2 — sanitizeForOutOfBand carries no PHI for any category × channel", () => {
  it("alert: PHI-free output for every category × channel", () => {
    for (const category of CATEGORIES) {
      for (const channel of CHANNELS) {
        const out = sanitizeForOutOfBand({
          alertOrMessage: redTeamAlert(category),
          channel,
          recipientUserId: "user-7",
          baseUrl: "https://app.wardenx.example",
        });
        const hay = haystack(out);
        for (const token of PHI_TOKENS) {
          expect(hay, `${category}/${channel} leaked '${token}'`).not.toContain(
            token.toLowerCase(),
          );
        }
        // structurally: only the three allowlisted fields, all content-free.
        expect(Object.keys(out).sort()).toEqual(["deepLink", "notificationDeliveryId", "short"]);
        expect(out.notificationDeliveryId).toBe("nd-abc-123");
        expect(out.deepLink).toBe("https://app.wardenx.example/n/nd-abc-123");
        expect(out.short.length).toBeGreaterThan(0);
      }
    }
  });

  it("message: PHI-free output for every channel (body never traverses)", () => {
    for (const channel of CHANNELS) {
      const out = sanitizeForOutOfBand({
        alertOrMessage: redTeamMessage(),
        channel,
        recipientUserId: "user-7",
        baseUrl: "https://app.wardenx.example/",
      });
      const hay = haystack(out);
      for (const token of PHI_TOKENS) {
        expect(hay, `message/${channel} leaked '${token}'`).not.toContain(token.toLowerCase());
      }
      expect(out.short).toBe(
        channel === "voice"
          ? "ChartWarden field safety alert. Please open the app."
          : "You have a new message in ChartWarden. Sign in to view.",
      );
      // trailing-slash baseUrl is normalized (no double slash).
      expect(out.deepLink).toBe("https://app.wardenx.example/n/nd-msg-9");
    }
  });

  it("voice always speaks the fixed SOS script — never a name, location, or category specific", () => {
    for (const category of CATEGORIES) {
      const out = sanitizeForOutOfBand({
        alertOrMessage: redTeamAlert(category),
        channel: "voice",
        recipientUserId: "user-7",
        baseUrl: "https://app.wardenx.example",
      });
      expect(out.short).toBe("ChartWarden field safety alert. Please open the app.");
    }
  });

  it("SMS truncates the generic short to one 160-char segment", () => {
    const out = sanitizeForOutOfBand({
      alertOrMessage: redTeamAlert("clinical_urgent"),
      channel: "sms",
      recipientUserId: "user-7",
      baseUrl: "https://app.wardenx.example",
    });
    expect(out.short.length).toBeLessThanOrEqual(160);
  });
});
