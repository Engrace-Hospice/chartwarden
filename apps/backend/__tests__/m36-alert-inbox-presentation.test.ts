import { describe, expect, it } from "vitest";
import {
  normalizeAlertDeepLink,
  projectAlertInboxPresentation,
} from "../src/modules/36-messaging/alert-inbox-presentation";

describe("M36 alert inbox presentation", () => {
  const fallback = "Field-safety alert";

  it("uses a valid payload message and internal deep link", () => {
    expect(
      projectAlertInboxPresentation(
        {
          message: "A field clinician's overdue safety check-in has escalated.",
          deepLink: "/safety",
        },
        "field_safety",
      ),
    ).toEqual({
      summary: "A field clinician's overdue safety check-in has escalated.",
      deepLink: "/safety",
    });
  });

  it.each([
    [null, fallback],
    [undefined, fallback],
    ["not-an-object", fallback],
    [{}, fallback],
    [{ message: "" }, fallback],
    [{ message: "   " }, fallback],
    [{ message: 123 }, fallback],
  ])("falls back to the category label for payload %#", (payload, expected) => {
    expect(projectAlertInboxPresentation(payload, "field_safety").summary).toBe(expected);
  });

  it("uses the safe generic fallback for an unknown runtime category", () => {
    expect(projectAlertInboxPresentation({}, "unknown").summary).toBe("Notification");
  });

  it("returns null when no deep link is present", () => {
    expect(
      projectAlertInboxPresentation({ message: "Something requires attention." }, "operational")
        .deepLink,
    ).toBeNull();
  });

  it.each([
    "https://evil.example.com",
    "http://evil.example.com",
    "//evil.example.com/path",
    "javascript:alert(1)",
    "data:text/html,evil",
    "mailto:evil@example.com",
    "tel:+15555550123",
    "/\\evil.example.com/path",
    "/",
  ])("rejects unsafe deep link %s", (deepLink) => {
    expect(normalizeAlertDeepLink(deepLink)).toBeNull();
  });

  it.each(["/safety", "/patients/patient-123/emar"])("accepts internal path %s", (deepLink) => {
    expect(normalizeAlertDeepLink(deepLink)).toBe(deepLink);
  });

  it("returns only the explicit presentation projection", () => {
    const result = projectAlertInboxPresentation(
      {
        message: "Something requires attention.",
        deepLink: "/safety",
        patientId: "patient-secret",
        escalationData: { tier: 3 },
      },
      "field_safety",
    );

    expect(result).toEqual({
      summary: "Something requires attention.",
      deepLink: "/safety",
    });
    expect(result).not.toHaveProperty("payload");
    expect(result).not.toHaveProperty("patientId");
    expect(result).not.toHaveProperty("escalationData");
  });
});
