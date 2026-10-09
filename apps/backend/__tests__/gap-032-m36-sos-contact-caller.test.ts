// GAP-032 - M36's SosContactCaller over the voice transport (no database, no network).
import {
  TransportError,
  createDenyTransport,
  createTwilioVoiceTransport,
} from "@wardenx/messaging";
import { describe, expect, it } from "vitest";

import { createSosContactCaller } from "../src/modules/36-messaging/delivery/sos-contact-caller";

const INPUT = {
  organizationId: "org-1",
  idempotencyKey: "m20:sos:s1:dial_contact:0:0",
  toE164: "+14155552671",
  agencyName: "Smith & Sons Hospice",
  subjectDisplayName: "Dana Reyes",
};

describe("createSosContactCaller", () => {
  it("places the call through the voice transport with the sanitized script and returns the vendor id", async () => {
    const sent: Array<{ destination: string; short: string }> = [];
    const caller = createSosContactCaller({
      async send({ notification, destination }) {
        sent.push({ destination, short: notification.short });
        return { vendorMessageId: "CA123", settlesOnAcceptance: false };
      },
    });
    expect(await caller.place(INPUT)).toEqual({ kind: "accepted", vendorCallId: "CA123" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.destination).toBe("+14155552671");
    expect(sent[0]?.short).toContain("Dana Reyes");
  });

  it("fails closed on the deny transport: refused / transport_not_configured / not retryable", async () => {
    const caller = createSosContactCaller(createDenyTransport());
    expect(await caller.place(INPUT)).toEqual({
      kind: "refused",
      reason: "transport_not_configured",
      retryable: false,
    });
  });

  it("maps a retryable vendor error and an unexpected throw to retryable refusals", async () => {
    const vendor = createSosContactCaller({
      send: () => Promise.reject(new TransportError("twilio_503", true)),
    });
    expect(await vendor.place(INPUT)).toEqual({
      kind: "refused",
      reason: "vendor_refused",
      retryable: true,
    });
    const network = createSosContactCaller({
      send: () => Promise.reject(new Error("socket hang up")),
    });
    expect(await network.place(INPUT)).toEqual({
      kind: "refused",
      reason: "timeout",
      retryable: true,
    });
  });

  it("never echoes the destination number in a refusal", async () => {
    const caller = createSosContactCaller({
      send: ({ destination }) => Promise.reject(new TransportError(`bad ${destination}`, false)),
    });
    const refusal = await caller.place(INPUT);
    expect(JSON.stringify(refusal)).not.toContain("4155552671");
  });

  it("XML-escapes the spoken agency name through the real Twilio voice transport", async () => {
    let twiml = "";
    const voice = createTwilioVoiceTransport({
      accountSid: "AC1",
      authToken: "tok",
      from: "+15005550006",
      fetch: async (_url, init) => {
        twiml = new URLSearchParams(String(init.body)).get("Twiml") ?? "";
        return { status: 201, json: async () => ({ sid: "CA9" }), text: async () => "" } as never;
      },
    });
    const result = await createSosContactCaller(voice).place(INPUT);
    expect(result).toEqual({ kind: "accepted", vendorCallId: "CA9" });
    expect(twiml).toContain("Smith &amp; Sons Hospice");
    expect(twiml).not.toContain("Smith & Sons");
  });
});
