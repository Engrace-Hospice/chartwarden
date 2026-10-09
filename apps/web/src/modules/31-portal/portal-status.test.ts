import { describe, expect, it } from "vitest";
import { accountTone, isVisitLive, roomFrameUrl, visitTone } from "./portal-status";

const ticket = {
  vendor: "daily_co",
  vendorJoinUrl: "https://acme.daily.co/tlh_abc",
  vendorParticipantToken: "tok-1",
};

describe("roomFrameUrl", () => {
  it("frames a Daily room with the participant token", () => {
    expect(roomFrameUrl(ticket)).toBe("https://acme.daily.co/tlh_abc?t=tok-1");
  });

  it("refuses off-vendor, non-https, malformed and token-less tickets", () => {
    expect(roomFrameUrl({ ...ticket, vendorJoinUrl: "https://evil.example/x" })).toBeNull();
    expect(roomFrameUrl({ ...ticket, vendorJoinUrl: "http://acme.daily.co/x" })).toBeNull();
    expect(roomFrameUrl({ ...ticket, vendorJoinUrl: "nope" })).toBeNull();
    expect(roomFrameUrl({ ...ticket, vendorParticipantToken: "" })).toBeNull();
    expect(roomFrameUrl({ ...ticket, vendor: "twilio_video" })).toBeNull();
  });
});

describe("status helpers", () => {
  it("only live visits can be joined", () => {
    expect(isVisitLive("in_progress")).toBe(true);
    expect(isVisitLive("ended")).toBe(false);
    expect(isVisitLive("cancelled")).toBe(false);
  });

  it("maps statuses to tones with a neutral default", () => {
    expect(accountTone("suspended")).toBe("warning");
    expect(accountTone("mystery")).toBe("neutral");
    expect(visitTone("in_progress")).toBe("success");
  });
});
