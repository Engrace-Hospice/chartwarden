import { describe, expect, it } from "vitest";
import { telehealthEmbedUrl } from "../src/screens/telehealth-embed";

const ticket = {
  vendor: "daily_co",
  vendorJoinUrl: "https://acme.daily.co/tlh_abc",
  vendorParticipantToken: "tok-1",
};

describe("telehealthEmbedUrl", () => {
  it("appends the participant token to a Daily room url", () => {
    expect(telehealthEmbedUrl(ticket)).toBe("https://acme.daily.co/tlh_abc?t=tok-1");
  });

  it("refuses a non-https, off-vendor, malformed or token-less ticket", () => {
    expect(telehealthEmbedUrl({ ...ticket, vendorJoinUrl: "http://acme.daily.co/x" })).toBeNull();
    expect(telehealthEmbedUrl({ ...ticket, vendorJoinUrl: "https://evil.example/x" })).toBeNull();
    expect(
      telehealthEmbedUrl({ ...ticket, vendorJoinUrl: "https://daily.co.evil.example/x" }),
    ).toBeNull();
    expect(telehealthEmbedUrl({ ...ticket, vendorJoinUrl: "not a url" })).toBeNull();
    expect(telehealthEmbedUrl({ ...ticket, vendorParticipantToken: "" })).toBeNull();
    expect(telehealthEmbedUrl({ ...ticket, vendor: "twilio_video" })).toBeNull();
  });
});
